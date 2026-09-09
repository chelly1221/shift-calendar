import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from './calendar'
import { expandRecurringEvents } from './expandRecurrence'
import { vacationQueryRange } from './voiceVacationRange'

const ZONE = 'Asia/Seoul'
const today = DateTime.fromISO('2026-09-10', { zone: ZONE })

function vacation(date: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = DateTime.fromISO(date, { zone: ZONE })
  return {
    localId: date,
    googleEventId: null,
    eventType: '휴가',
    summary: '이상승 연차',
    description: '휴가대상: 이상승\n휴가종류: 연차',
    location: '',
    startAtUtc: start.toUTC().toISO()!,
    endAtUtc: start.plus({ days: 1 }).toUTC().toISO()!,
    timeZone: ZONE,
    attendees: [],
    recurrenceRule: null,
    skipWeekendsAndHolidays: false,
    recurringEventId: null,
    originalStartTimeUtc: null,
    organizerEmail: null,
    hangoutLink: null,
    googleUpdatedAtUtc: null,
    localEditedAtUtc: today.toUTC().toISO()!,
    syncState: 'CLEAN',
    ...overrides,
  }
}

describe('vacationQueryRange', () => {
  it('keeps a one-day minimum and ignores deleted vacations and other types', () => {
    const result = vacationQueryRange([
      vacation('2030-01-01', { isDeleted: true }),
      vacation('2031-01-01', { eventType: '교육', recurrenceRule: 'FREQ=YEARLY' }),
      vacation('2020-01-01'),
    ], today)
    expect(result.end.toISODate()).toBe('2026-09-11')
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it('includes every stored future date, even beyond the next calendar year', () => {
    const result = vacationQueryRange([vacation('2026-09-16'), vacation('2028-03-07')], today)
    expect(result.end.toISODate()).toBe('2028-03-08')
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it('uses the query time zone and includes timed and multiday vacation endings', () => {
    const result = vacationQueryRange([
      vacation('2027-01-01', { endAtUtc: '2027-01-05T04:30:00.000Z' }),
    ], today)
    expect(result.end.toISO()).toBe('2027-01-06T00:00:00.000+09:00')
  })

  it('includes moved overrides by their new end, without treating them as another master', () => {
    const result = vacationQueryRange([
      vacation('2028-05-20', { recurringEventId: 'master', recurrenceRule: 'FREQ=YEARLY' }),
    ], today)
    expect(result.end.toISODate()).toBe('2028-05-21')
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it('includes the UNTIL boundary, event duration, and possible 14-day business-day shift', () => {
    const event = vacation('2026-09-10', {
      endAtUtc: DateTime.fromISO('2026-09-13', { zone: ZONE }).toUTC().toISO()!,
      recurrenceRule: 'FREQ=WEEKLY;UNTIL=20280101T000000Z',
      skipWeekendsAndHolidays: true,
    })
    const result = vacationQueryRange([event], today)
    expect(result.end.toISODate()).toBe('2028-01-19')
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it.each([
    ['2026-09-10', 'FREQ=DAILY;INTERVAL=70;COUNT=5', 5],
    ['2026-09-10', 'FREQ=WEEKLY;INTERVAL=14;BYDAY=MO,FR;COUNT=7', 7],
    ['2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=8', 8],
    ['2026-01-01', 'FREQ=MONTHLY;BYDAY=5MO;COUNT=5', 5],
    ['2026-01-01', 'FREQ=MONTHLY;INTERVAL=12;BYDAY=MO;BYSETPOS=5;COUNT=5', 5],
    ['2026-01-15', 'FREQ=MONTHLY;BYMONTHDAY=1,15,-1;COUNT=8', 8],
    ['2096-02-29', 'FREQ=YEARLY;COUNT=3', 3],
    ['2096-02-29', 'FREQ=YEARLY;INTERVAL=2;COUNT=3', 3],
  ])('includes every finite candidate for %s, %s', (date, recurrenceRule, expected) => {
    const event = vacation(date, { recurrenceRule })
    const start = DateTime.fromISO(date, { zone: ZONE })
    const result = vacationQueryRange([event], start)
    const expanded = expandRecurringEvents([event], start.toUTC().toISO()!, result.end.toUTC().toISO()!)
    expect(expanded).toHaveLength(expected)
    expect(expanded.every((instance) => DateTime.fromISO(instance.endAtUtc) <= result.end)).toBe(true)
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it('includes every unique COUNT result when weekends are shifted and deduplicated', () => {
    const event = vacation('2026-09-10', { recurrenceRule: 'FREQ=DAILY;COUNT=30', skipWeekendsAndHolidays: true })
    const result = vacationQueryRange([event], today)
    const expanded = expandRecurringEvents([event], today.toUTC().toISO()!, result.end.toUTC().toISO()!, new Set())
    expect(expanded).toHaveLength(30)
    expect(expanded.every((instance) => DateTime.fromISO(instance.endAtUtc) <= result.end)).toBe(true)
  })

  it('bounds a monthly rule whose requested day can never occur', () => {
    const event = vacation('2026-02-01', { recurrenceRule: 'FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31;COUNT=2' })
    const result = vacationQueryRange([event], today)
    expect(result.end.toISODate()).toBe('2026-09-11')
    expect(result.hasUnboundedRecurrence).toBe(false)
  })

  it('accounts for calendar cycles beyond one Gregorian cycle without truncating COUNT', () => {
    const event = vacation('2026-01-01', { recurrenceRule: 'FREQ=MONTHLY;INTERVAL=12;BYDAY=MO;BYSETPOS=5;COUNT=200' })
    const result = vacationQueryRange([event], today)
    const expanded = expandRecurringEvents([event], event.startAtUtc, result.end.toUTC().toISO()!)
    expect(expanded).toHaveLength(200)
    expect(expanded.every((instance) => DateTime.fromISO(instance.endAtUtc) <= result.end)).toBe(true)
  })

  it('marks endless series and uses a year from today or a future master start', () => {
    const pastMaster = vacationQueryRange([vacation('2025-01-01', { recurrenceRule: 'FREQ=MONTHLY' })], today)
    expect(pastMaster.end.toISODate()).toBe('2027-09-11')
    expect(pastMaster.hasUnboundedRecurrence).toBe(true)
    const futureMaster = vacationQueryRange([vacation('2028-03-01', { recurrenceRule: 'FREQ=MONTHLY' })], today)
    expect(futureMaster.end.toISODate()).toBe('2029-03-02')
    expect(futureMaster.hasUnboundedRecurrence).toBe(true)
  })
})
