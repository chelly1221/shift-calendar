import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import type { CalendarEvent } from './calendar'
import { expandRecurringEvents } from './expandRecurrence'

const ZONE = 'Asia/Seoul'

function makeEvent(overrides: Partial<CalendarEvent> & { startAtUtc: string; endAtUtc: string }): CalendarEvent {
  return {
    localId: 'test-1',
    googleEventId: null,
    eventType: '반복업무',
    summary: 'Test routine',
    description: '',
    location: '',
    timeZone: ZONE,
    attendees: [],
    recurrenceRule: null,
    skipWeekendsAndHolidays: false,
    recurringEventId: null,
    originalStartTimeUtc: null,
    organizerEmail: null,
    hangoutLink: null,
    googleUpdatedAtUtc: null,
    localEditedAtUtc: '2026-01-01T00:00:00.000Z',
    syncState: 'CLEAN',
    ...overrides,
  }
}

function kstStartUtc(dateStr: string): string {
  return DateTime.fromISO(dateStr, { zone: ZONE }).toUTC().toISO()!
}
function kstEndUtc(dateStr: string): string {
  return DateTime.fromISO(dateStr, { zone: ZONE }).plus({ days: 1 }).toUTC().toISO()!
}

function toDates(events: CalendarEvent[]): string[] {
  return events.map((e) => DateTime.fromISO(e.startAtUtc).setZone(ZONE).toISODate()!)
}

describe('expandRecurringEvents – skipWeekendsAndHolidays', () => {
  const rangeStartUtc = kstStartUtc('2026-03-16') // Monday
  const rangeEndUtc = kstEndUtc('2026-03-29')

  it('DAILY skip: weekday instances preserved, weekend shifted instances dropped when colliding with natural weekday', () => {
    const master = makeEvent({
      localId: 'daily-1',
      startAtUtc: kstStartUtc('2026-03-16'),
      endAtUtc: kstEndUtc('2026-03-16'),
      recurrenceRule: 'RRULE:FREQ=DAILY;INTERVAL=1',
      skipWeekendsAndHolidays: true,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set()))

    // Each weekday gets exactly one instance; weekend shifted → Mon already natural → dropped
    // Note: Sat 28 → Mon 30 (shifted past range) may appear; caller filters by range.
    const inRange = dates.filter((d) => d <= '2026-03-29')
    expect(inRange).toEqual([
      '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
      '2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27',
    ])
  })

  it('WEEKLY-SA skip: shifted Sat→Mon emitted when no natural Mon exists', () => {
    const master = makeEvent({
      localId: 'weekly-sat',
      startAtUtc: kstStartUtc('2026-03-21'), // Saturday
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
      skipWeekendsAndHolidays: true,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set()))

    expect(dates).toContain('2026-03-23') // Sat 21 → Mon 23
  })

  it('holiday causes shift to next business day', () => {
    const master = makeEvent({
      localId: 'weekly-wed',
      startAtUtc: kstStartUtc('2026-03-18'),
      endAtUtc: kstEndUtc('2026-03-18'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE',
      skipWeekendsAndHolidays: true,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set(['2026-03-18'])))

    expect(dates).toContain('2026-03-19') // Wed 18 holiday → Thu 19
    expect(dates).toContain('2026-03-25') // Wed 25 normal
    expect(dates).not.toContain('2026-03-18')
  })

  it('COUNT respected with skip (dedup does not reduce count)', () => {
    // DAILY COUNT=5, start Thu → Thu, Fri, (Sat→Mon dropped, Sun→Mon dropped), Mon, Tue, Wed
    const master = makeEvent({
      localId: 'count-5',
      startAtUtc: kstStartUtc('2026-03-19'), // Thursday
      endAtUtc: kstEndUtc('2026-03-19'),
      recurrenceRule: 'RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5',
      skipWeekendsAndHolidays: true,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, kstEndUtc('2026-04-30'), new Set()))

    expect(dates).toHaveLength(5)
    expect(dates).toEqual([
      '2026-03-19', // Thu (1)
      '2026-03-20', // Fri (2)
      // Sat→Mon dropped (natural Mon exists), Sun→Mon dropped
      '2026-03-23', // Mon (3)
      '2026-03-24', // Tue (4)
      '2026-03-25', // Wed (5)
    ])
  })

  it('no shift when skipWeekendsAndHolidays is false', () => {
    const master = makeEvent({
      localId: 'no-skip',
      startAtUtc: kstStartUtc('2026-03-21'),
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
      skipWeekendsAndHolidays: false,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set()))

    expect(dates).toContain('2026-03-21')
    expect(dates).toContain('2026-03-28')
  })

  it('consecutive holidays: all shift to first available business day, dedup keeps one', () => {
    // Mon-Wed all holidays, DAILY COUNT=5
    const master = makeEvent({
      localId: 'long-holiday',
      startAtUtc: kstStartUtc('2026-03-16'),
      endAtUtc: kstEndUtc('2026-03-16'),
      recurrenceRule: 'RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5',
      skipWeekendsAndHolidays: true,
    })

    const holidays = new Set(['2026-03-16', '2026-03-17', '2026-03-18'])
    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, kstEndUtc('2026-04-30'), holidays))

    // Mon(16)→Thu(19) shifted, Tue(17)→Thu(19) shifted dup → dropped,
    // Wed(18)→Thu(19) shifted dup → dropped
    // Thu(19) natural, Fri(20) natural, Sat(21)→Mon(23) shifted
    // Sun(22)→Mon(23) shifted dup → dropped, Mon(23) natural
    // Count emitted: Thu-shifted(1), Thu-natural(drops because... wait.
    // naturalDates = {19,20,23,24,...}. So shifted 19 collides with natural 19 → dropped.
    // All three shifted (16→19, 17→19, 18→19) are dropped because natural 19 exists.
    // Then: 19(natural,1), 20(natural,2), Sat→Mon(shifted, Mon has natural → dropped),
    // Sun→Mon(shifted, dropped), 23(natural,3), 24(natural,4), 25(natural,5)
    expect(dates).toHaveLength(5)
    expect(dates).toEqual([
      '2026-03-19', // Thu natural
      '2026-03-20', // Fri natural
      '2026-03-23', // Mon natural
      '2026-03-24', // Tue natural
      '2026-03-25', // Wed natural
    ])
  })

  it('WEEKLY-SA COUNT=3: shifted instances fill count on unoccupied weekdays', () => {
    const master = makeEvent({
      localId: 'weekly-sat-count',
      startAtUtc: kstStartUtc('2026-03-21'), // Sat
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA;COUNT=3',
      skipWeekendsAndHolidays: true,
    })

    const dates = toDates(expandRecurringEvents([master], rangeStartUtc, kstEndUtc('2026-05-31'), new Set()))

    // Sat 21→Mon 23, Sat 28→Mon 30, Sat Apr 4→Mon Apr 6
    expect(dates).toHaveLength(3)
    expect(dates[0]).toBe('2026-03-23')
    expect(dates[1]).toBe('2026-03-30')
    expect(dates[2]).toBe('2026-04-06')
  })

  it('Google-synced master with instances: shift still applied when skipWeekendsAndHolidays is true', () => {
    // Master synced to Google with googleEventId, plus Google-returned instances
    const master = makeEvent({
      localId: 'synced-master',
      googleEventId: 'google-master-123',
      startAtUtc: kstStartUtc('2026-03-21'), // Saturday
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
      skipWeekendsAndHolidays: true,
    })

    // Google instances at original (unshifted) Saturday dates
    const instance1 = makeEvent({
      localId: 'inst-1',
      googleEventId: 'google-master-123_20260321',
      startAtUtc: kstStartUtc('2026-03-21'),
      endAtUtc: kstEndUtc('2026-03-21'),
      recurringEventId: 'google-master-123',
      originalStartTimeUtc: kstStartUtc('2026-03-21'),
    })
    const instance2 = makeEvent({
      localId: 'inst-2',
      googleEventId: 'google-master-123_20260328',
      startAtUtc: kstStartUtc('2026-03-28'),
      endAtUtc: kstEndUtc('2026-03-28'),
      recurringEventId: 'google-master-123',
      originalStartTimeUtc: kstStartUtc('2026-03-28'),
    })

    const events = [master, instance1, instance2]
    const result = expandRecurringEvents(events, rangeStartUtc, rangeEndUtc, new Set())
    const dates = toDates(result)

    // Google instances on Saturdays should be REPLACED by virtual shifted instances on Mondays
    expect(dates).not.toContain('2026-03-21') // Saturday dropped
    expect(dates).not.toContain('2026-03-28') // Saturday dropped
    expect(dates).toContain('2026-03-23')     // Sat 21 → Mon 23
  })

  it('shifted first occurrence has unshifted originalStartTimeUtc', () => {
    // Master starts on Saturday — first occurrence shifts to Monday
    const master = makeEvent({
      localId: 'first-shifted',
      startAtUtc: kstStartUtc('2026-03-21'), // Saturday
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
      skipWeekendsAndHolidays: true,
    })

    const result = expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set())
    const firstOccurrence = result[0]

    // First occurrence should be shifted to Monday
    const displayDate = DateTime.fromISO(firstOccurrence.startAtUtc).setZone(ZONE).toISODate()
    expect(displayDate).toBe('2026-03-23') // Mon (shifted from Sat 21)

    // originalStartTimeUtc should be the UNSHIFTED Saturday time (for FUTURE split / THIS override)
    expect(firstOccurrence.originalStartTimeUtc).toBeTruthy()
    const originalDate = DateTime.fromISO(firstOccurrence.originalStartTimeUtc!).setZone(ZONE).toISODate()
    expect(originalDate).toBe('2026-03-21') // Original Saturday

    // First occurrence keeps the master's localId
    expect(firstOccurrence.localId).toBe('first-shifted')
  })

  it('unshifted first occurrence preserves master originalStartTimeUtc', () => {
    // Master starts on Monday — first occurrence NOT shifted
    const master = makeEvent({
      localId: 'first-no-shift',
      startAtUtc: kstStartUtc('2026-03-16'), // Monday
      endAtUtc: kstEndUtc('2026-03-16'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      skipWeekendsAndHolidays: true,
      originalStartTimeUtc: null,
    })

    const result = expandRecurringEvents([master], rangeStartUtc, rangeEndUtc, new Set())
    const firstOccurrence = result[0]

    // First occurrence should stay on Monday (no shift)
    const displayDate = DateTime.fromISO(firstOccurrence.startAtUtc).setZone(ZONE).toISODate()
    expect(displayDate).toBe('2026-03-16')

    // originalStartTimeUtc should be null (master's value, no shift applied)
    expect(firstOccurrence.originalStartTimeUtc).toBeNull()
  })

  it('Google-synced master WITHOUT skip: Google instances kept as-is', () => {
    const master = makeEvent({
      localId: 'synced-no-skip',
      googleEventId: 'google-noskip-456',
      startAtUtc: kstStartUtc('2026-03-21'),
      endAtUtc: kstEndUtc('2026-03-21'),
      recurrenceRule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA',
      skipWeekendsAndHolidays: false,
    })

    const instance1 = makeEvent({
      localId: 'noskip-inst-1',
      googleEventId: 'google-noskip-456_20260321',
      startAtUtc: kstStartUtc('2026-03-21'),
      endAtUtc: kstEndUtc('2026-03-21'),
      recurringEventId: 'google-noskip-456',
      originalStartTimeUtc: kstStartUtc('2026-03-21'),
    })

    const events = [master, instance1]
    const result = expandRecurringEvents(events, rangeStartUtc, rangeEndUtc, new Set())
    const dates = toDates(result)

    // Without skip, Google instances kept at original Saturday dates
    expect(dates).toContain('2026-03-21')
  })
})
