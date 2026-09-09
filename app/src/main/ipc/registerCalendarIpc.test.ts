import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, UpsertCalendarEventInput } from '../../shared/calendar'
import { registerCalendarIpc } from './registerCalendarIpc'
import { IPC_CHANNELS } from './channels'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  get: vi.fn(), save: vi.fn(), remove: vi.fn(), enqueue: vi.fn(), futureDelete: vi.fn(), futureEdit: vi.fn(),
  event: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('electron', () => ({
  app: {}, dialog: {}, ipcMain: { removeHandler: () => {}, handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => mocks.handlers.set(name, handler) },
}))
vi.mock('better-sqlite3', () => ({ default: class {} }))
vi.mock('../db/prisma', () => ({ prisma: { event: mocks.event }, dbFilePath: '', dbImportStagingPath: '' }))
vi.mock('../db/eventRepository', () => ({
  getCalendarEventByLocalId: mocks.get, upsertCalendarEvent: mocks.save, removeCalendarEvent: mocks.remove,
  applyFutureSplitForDelete: mocks.futureDelete, applyFutureSplitEdit: mocks.futureEdit,
  applyEventTypeToRecurringSeries: vi.fn(), listCalendarEvents: vi.fn(),
}))
vi.mock('../db/settingRepository', () => ({ getShiftSettings: vi.fn() }))
vi.mock('../google/calendarService', () => ({ createGoogleCalendarService: () => ({ resetClient: vi.fn() }) }))
vi.mock('../google/oauthClient', () => ({ onReauthRequired: vi.fn() }))
vi.mock('../security/tokenStore', () => ({ loadRefreshToken: vi.fn(), saveRefreshToken: vi.fn() }))
vi.mock('../sync/outboxWorker', () => ({ enqueueOutboxOperation: mocks.enqueue }))
vi.mock('../sync/syncEngine', () => ({}))

const master: CalendarEvent = {
  localId: 'master-local', googleEventId: 'master-remote', eventType: '반복업무', summary: 'Routine', description: '', location: '',
  startAtUtc: '2026-03-20T15:00:00.000Z', endAtUtc: '2026-03-21T15:00:00.000Z', timeZone: 'Asia/Seoul',
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=SA', skipWeekendsAndHolidays: true, recurringEventId: null, originalStartTimeUtc: null,
  attendees: [], organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null, localEditedAtUtc: '2026-03-01T00:00:00.000Z', syncState: 'PENDING',
}
const saveInput: UpsertCalendarEventInput = { ...master, sendUpdates: 'none', recurrenceScope: 'THIS' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  registerCalendarIpc()
  mocks.get.mockResolvedValue(master)
  mocks.save.mockImplementation(async (input: UpsertCalendarEventInput) => ({ ...master, ...input, localId: input.localId ?? 'override-local' }))
  mocks.remove.mockResolvedValue(true)
  mocks.enqueue.mockResolvedValue('job-1')
  mocks.futureDelete.mockResolvedValue({ splitSourceEvent: master })
  mocks.futureEdit.mockResolvedValue({ splitSourceEvent: master, futureEvent: { ...master, localId: 'future' } })
})

const invoke = (channel: string, payload: unknown) => mocks.handlers.get(channel)!(null, payload)

describe('recurrence IPC routes', () => {
  it('ALL editing an instance updates the master without moving the series origin', async () => {
    const instance = { ...master, localId: 'instance', googleEventId: 'instance-remote', recurringEventId: master.googleEventId, startAtUtc: '2026-03-27T15:00:00.000Z', endAtUtc: '2026-03-28T15:00:00.000Z' }
    mocks.get.mockResolvedValueOnce(instance)
    mocks.event.findFirst.mockResolvedValueOnce({ localId: master.localId, googleEventId: master.googleEventId, startAtUtc: new Date(master.startAtUtc), endAtUtc: new Date(master.endAtUtc) })
    await invoke(IPC_CHANNELS.upsertEvent, { ...instance, summary: 'Changed', sendUpdates: 'none', recurrenceScope: 'ALL' })
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ localId: master.localId, googleEventId: master.googleEventId, recurringEventId: null, summary: 'Changed', startAtUtc: master.startAtUtc, endAtUtc: master.endAtUtc })
  })

  it('ALL editing a Korean all-day master preserves the original Saturday, not its UTC weekday', async () => {
    await invoke(IPC_CHANNELS.upsertEvent, { ...saveInput, recurrenceScope: 'ALL' })
    expect(mocks.save.mock.calls[0][0].startAtUtc).toBe(master.startAtUtc)
  })
  it.each([null, 'master-remote'])('THIS deletion preserves the master (Google id: %s)', async (googleEventId) => {
    mocks.get.mockResolvedValueOnce({ ...master, googleEventId })
    const occurrence = '2026-03-27T15:00:00.000Z'
    await invoke(IPC_CHANNELS.deleteEvent, { localId: master.localId, recurrenceScope: 'THIS', originalStartTimeUtc: occurrence })
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ localId: undefined, googleEventId: null, recurrenceRule: null, originalStartTimeUtc: occurrence, recurringEventId: googleEventId ?? 'local::master-local' })
    expect(mocks.remove).toHaveBeenCalledWith('override-local')
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ operation: 'DELETE', payload: { googleEventId: null, originalStartTimeUtc: occurrence } })
  })

  it('uses the selected occurrence for FUTURE deletion', async () => {
    const occurrence = '2026-03-27T15:00:00.000Z'
    await invoke(IPC_CHANNELS.deleteEvent, { localId: master.localId, recurrenceScope: 'FUTURE', originalStartTimeUtc: occurrence })
    expect(mocks.futureDelete).toHaveBeenCalledWith(master.localId, occurrence)
  })

  it('creates a separate offline override for THIS editing', async () => {
    mocks.get.mockResolvedValueOnce({ ...master, googleEventId: null })
    await invoke(IPC_CHANNELS.upsertEvent, { ...saveInput, googleEventId: null, originalStartTimeUtc: '2026-03-27T15:00:00.000Z' })
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ localId: undefined, recurringEventId: 'local::master-local', recurrenceRule: null })
  })

  it('preserves the duration when FUTURE splits an occurrence shifted to a business day', async () => {
    await invoke(IPC_CHANNELS.upsertEvent, {
      ...saveInput, recurrenceScope: 'FUTURE', originalStartTimeUtc: '2026-03-27T15:00:00.000Z',
      startAtUtc: '2026-03-29T15:00:00.000Z', endAtUtc: '2026-03-30T15:00:00.000Z',
    })
    expect(mocks.futureEdit.mock.calls[0][0]).toMatchObject({ startAtUtc: '2026-03-27T15:00:00.000Z', endAtUtc: '2026-03-28T15:00:00.000Z' })
  })
})
