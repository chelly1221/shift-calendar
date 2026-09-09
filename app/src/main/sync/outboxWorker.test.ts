import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../shared/calendar'

const mocks = vi.hoisted(() => ({
  job: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  getEvent: vi.fn(), updateState: vi.fn(), upsertRemote: vi.fn(), connected: vi.fn(), fetch: vi.fn(), push: vi.fn(),
}))
vi.mock('../db/prisma', () => ({ prisma: { outboxJob: mocks.job } }))
vi.mock('../db/eventRepository', () => ({ getCalendarEventByLocalId: mocks.getEvent, updateEventSyncState: mocks.updateState, upsertRemoteEvent: mocks.upsertRemote }))
vi.mock('../db/settingRepository', () => ({ getSelectedCalendar: async () => ({ selectedCalendarId: 'calendar-1' }), getShiftSettings: vi.fn(), isCalendarSwitching: () => false }))
vi.mock('../google/oauthClient', () => ({ isGoogleConnected: mocks.connected }))
vi.mock('../google/calendarService', () => ({ createGoogleCalendarService: () => ({ fetchRemoteEvent: mocks.fetch, pushLocalChange: mocks.push }) }))

import { enqueueOutboxOperation, processOutboxNow } from './outboxWorker'

const localEvent: CalendarEvent = {
  localId: 'local-1', googleEventId: 'remote-1', eventType: '일반', summary: 'Local', description: '', location: '',
  startAtUtc: '2026-03-01T00:00:00.000Z', endAtUtc: '2026-03-01T01:00:00.000Z', timeZone: 'Asia/Seoul',
  recurrenceRule: null, skipWeekendsAndHolidays: false, recurringEventId: null, originalStartTimeUtc: null,
  attendees: [], organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: '2026-03-01T10:00:01.000Z',
  localEditedAtUtc: '2026-03-01T10:00:00.000Z', syncState: 'PENDING',
}
const job = { id: 'job-1', eventLocalId: 'local-1', operation: 'PATCH', payloadJson: {}, attempts: 0, createdAt: new Date(), dependsOnOutboxId: null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connected.mockResolvedValue(true)
  mocks.job.findFirst.mockResolvedValue(null)
  mocks.job.findUnique.mockResolvedValue(job)
  mocks.job.count.mockResolvedValue(0)
  mocks.getEvent.mockResolvedValue(localEvent)
  mocks.fetch.mockResolvedValue(null)
  mocks.push.mockResolvedValue({ googleEventId: 'remote-1', googleUpdatedAtUtc: '2026-03-01T10:00:02.000Z' })
})

describe('outbox processing', () => {
  it('waits for an active flush instead of reporting completion early', async () => {
    let release!: (connected: boolean) => void
    mocks.connected.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve }))
    const first = processOutboxNow()
    let secondFinished = false
    const second = processOutboxNow().then(() => { secondFinished = true })
    await vi.waitFor(() => expect(mocks.connected).toHaveBeenCalled())
    const finishedBeforeRelease = secondFinished
    release(true)
    await Promise.all([first, second])
    expect(finishedBeforeRelease).toBe(false)
  })

  it('does not treat the previous push acknowledgement as a newer external edit', async () => {
    mocks.job.findFirst.mockResolvedValueOnce(job)
    mocks.fetch.mockResolvedValueOnce({ ...localEvent, googleUpdatedAtUtc: localEvent.googleUpdatedAtUtc })
    await processOutboxNow()
    expect(mocks.push).toHaveBeenCalledOnce()
    expect(mocks.upsertRemote).not.toHaveBeenCalled()
  })

  it('keeps the event pending when another edit is queued', async () => {
    mocks.job.findFirst.mockResolvedValueOnce(job)
    mocks.job.count.mockResolvedValueOnce(1)
    await processOutboxNow()
    expect(mocks.updateState).toHaveBeenCalledWith('local-1', expect.objectContaining({ syncState: 'PENDING', expectedLocalEditedAtUtc: localEvent.localEditedAtUtc }))
  })

  it('preserves an explicit dependency when coalescing PATCH jobs', async () => {
    mocks.connected.mockResolvedValue(false)
    mocks.job.findFirst.mockResolvedValueOnce(job)
    mocks.job.create.mockResolvedValueOnce({ id: 'job-2' })
    const id = await enqueueOutboxOperation({ eventLocalId: 'local-1', operation: 'PATCH', payload: {}, dependsOnOutboxId: 'parent-job' })
    await processOutboxNow()
    expect(id).toBe('job-2')
    expect(mocks.job.create.mock.calls[0][0].data.dependsOnOutboxId).toBe('parent-job')
  })

  it('retries a transient push failure and marks the event as an error', async () => {
    mocks.job.findFirst.mockResolvedValueOnce(job)
    mocks.push.mockRejectedValueOnce(new Error('Network unavailable'))
    await processOutboxNow()
    expect(mocks.job.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', attempts: 1, nextRetryAtUtc: expect.any(Date) }) }))
    expect(mocks.updateState).toHaveBeenCalledWith('local-1', { syncState: 'ERROR' })
  })
})
