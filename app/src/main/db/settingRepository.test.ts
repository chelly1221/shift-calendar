import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isCalendarSwitching, setSelectedCalendar } from './settingRepository'

const db = vi.hoisted(() => ({
  setting: { upsert: vi.fn(), update: vi.fn() },
  event: { count: vi.fn(), deleteMany: vi.fn() },
  outboxJob: { count: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('./prisma', () => ({ prisma: db }))

beforeEach(() => {
  vi.resetAllMocks()
  db.setting.upsert.mockResolvedValue({ selectedCalendarId: 'old-calendar' })
  db.event.count.mockResolvedValue(0)
  db.outboxJob.count.mockResolvedValue(0)
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<void>) => run(db))
})

describe('calendar selection', () => {
  it('keeps offline events and their outbox jobs on the first connection', async () => {
    db.setting.upsert.mockResolvedValueOnce({ selectedCalendarId: null })
    await setSelectedCalendar({ calendarId: 'new-calendar' })
    expect(db.event.deleteMany).not.toHaveBeenCalled()
    expect(db.outboxJob.deleteMany).not.toHaveBeenCalled()
    expect(db.setting.update.mock.calls[0][0].data.selectedCalendarId).toBe('new-calendar')
  })

  it.each(['jobs', 'events'])('preserves unsynced %s when switching calendars', async (kind) => {
    if (kind === 'jobs') db.outboxJob.count.mockResolvedValueOnce(1)
    else db.event.count.mockResolvedValueOnce(1)
    await expect(setSelectedCalendar({ calendarId: 'new-calendar' })).rejects.toThrow('동기화되지 않은')
    expect(db.event.deleteMany).not.toHaveBeenCalled()
    expect(db.setting.update).not.toHaveBeenCalled()
    expect(isCalendarSwitching()).toBe(false)
  })

  it('clears the old cache and sync token when all changes have synced', async () => {
    await setSelectedCalendar({ calendarId: 'new-calendar' })
    expect(db.event.deleteMany).toHaveBeenCalledOnce()
    expect(db.setting.update.mock.calls[0][0].data.syncToken).toBeNull()
  })
})
