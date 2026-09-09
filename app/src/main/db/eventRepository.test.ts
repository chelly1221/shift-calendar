import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncState } from '@prisma/client'
import { upsertRemoteEvent, upsertRemoteEvents, type RemoteEventSnapshot } from './eventRepository'

const db = vi.hoisted(() => ({
  event: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('./prisma', () => ({ prisma: db }))

const snapshot: RemoteEventSnapshot = {
  googleEventId: 'remote-1', eventType: '일반', summary: 'Remote', description: '', location: '',
  startAtUtc: '2026-03-01T00:00:00.000Z', endAtUtc: '2026-03-01T01:00:00.000Z', timeZone: 'Asia/Seoul',
  recurrenceRule: null, skipWeekendsAndHolidays: false, recurringEventId: null, originalStartTimeUtc: null,
  attendees: [], organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: '2026-03-01T10:00:00.000Z',
  isDeleted: false, localIdHint: null,
}

describe.each(['single', 'batch'] as const)('remote conflict handling (%s)', (mode) => {
  const pull = (remote: RemoteEventSnapshot) => mode === 'single' ? upsertRemoteEvent(remote) : upsertRemoteEvents([remote])

  beforeEach(() => {
    vi.clearAllMocks()
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<void>) => run(db))
    db.event.findUnique.mockResolvedValue({
      localId: 'local-1', eventType: '교육', syncState: SyncState.ERROR, isDeleted: false,
      localEditedAtUtc: new Date('2026-03-01T11:00:00.000Z'), googleUpdatedAtUtc: new Date('2026-03-01T09:00:00.000Z'),
    })
  })

  it('preserves newer local edits after a failed push', async () => {
    await pull(snapshot)
    expect(db.event.upsert).not.toHaveBeenCalled()
  })

  it('preserves newer local edits against an older remote deletion', async () => {
    await pull({ ...snapshot, isDeleted: true })
    expect(db.event.updateMany).not.toHaveBeenCalled()
  })

  it('accepts remote changes that are newer than the local edit', async () => {
    await pull({ ...snapshot, googleUpdatedAtUtc: '2026-03-01T12:00:00.000Z' })
    expect(db.event.upsert).toHaveBeenCalled()
  })

  it('honors an explicit remote change to the default event type', async () => {
    await pull({ ...snapshot, googleUpdatedAtUtc: '2026-03-01T12:00:00.000Z', eventTypeIsExplicit: true })
    expect(db.event.upsert.mock.calls[0][0].update.eventType).toBe('일반')
  })

  it('rejects stale snapshots even after a successful push marked the event clean', async () => {
    db.event.findUnique.mockResolvedValueOnce({
      eventType: '교육', syncState: SyncState.CLEAN, localEditedAtUtc: new Date('2026-03-01T09:00:00.000Z'),
      googleUpdatedAtUtc: new Date('2026-03-01T12:00:00.000Z'),
    })
    await pull(snapshot)
    expect(db.event.upsert).not.toHaveBeenCalled()
  })

  it('persists a cancellation received before the occurrence was cached', async () => {
    db.event.findUnique.mockResolvedValueOnce(null)
    await pull({ ...snapshot, isDeleted: true, recurringEventId: 'master', originalStartTimeUtc: snapshot.startAtUtc })
    expect(db.event.upsert.mock.calls[0][0].create).toMatchObject({ isDeleted: true, recurringEventId: 'master', originalStartTimeUtc: new Date(snapshot.startAtUtc) })
  })
})
