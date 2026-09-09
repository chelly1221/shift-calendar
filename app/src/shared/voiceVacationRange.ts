import { DateTime } from 'luxon'
import type { CalendarEvent } from './calendar'
import { parseRRuleSegments, parseUntilToUtcIso } from './rrule'

// Match the existing recurrence expander's candidate limits. Range calculation
// must not truncate a finite series before the expander can produce its tail.
const MAX_RECURRENCE_CANDIDATES = 10_000
const MAX_BUSINESS_DAY_SHIFT = 14
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

/** Find the period containing COUNT candidates, including skipped calendar dates. */
function countedPeriodEnd(
  masterStart: DateTime,
  unit: 'months' | 'years',
  interval: number,
  count: number,
  candidatesInPeriod: (period: DateTime, first: boolean) => number,
): DateTime {
  const calendarUnit = unit === 'months' ? 'month' : 'year'
  const firstPeriod = masterStart.startOf(calendarUnit)
  let remaining = count - candidatesInPeriod(firstPeriod, true)
  if (remaining <= 0) return firstPeriod.endOf(calendarUnit)

  // Gregorian dates repeat every 400 years. Starting after the first period
  // avoids repeating its special exclusion of candidates before DTSTART.
  const calendarCycle = unit === 'months' ? 4_800 : 400
  const cycleLength = calendarCycle / greatestCommonDivisor(interval, calendarCycle)
  const counts: number[] = []
  let perCycle = 0
  for (let index = 1; index <= cycleLength; index++) {
    const period = firstPeriod.plus({ [unit]: index * interval })
    const available = candidatesInPeriod(period, false)
    if (remaining <= available) return period.endOf(calendarUnit)
    remaining -= available
    perCycle += available
    counts.push(available)
  }
  // E.g. every February on the 31st has no occurrences to include.
  if (perCycle === 0) return firstPeriod.endOf(calendarUnit)

  const skippedCycles = Math.floor((remaining - 1) / perCycle)
  remaining -= skippedCycles * perCycle
  for (let index = 0; index < counts.length; index++) {
    if (remaining <= counts[index]) {
      const periods = cycleLength * (skippedCycles + 1) + index + 1
      return firstPeriod.plus({ [unit]: periods * interval }).endOf(calendarUnit)
    }
    remaining -= counts[index]
  }
  return firstPeriod.endOf(calendarUnit)
}

function monthlyDays(segments: Map<string, string>, masterStart: DateTime): (period: DateTime, first: boolean) => number {
  const byday = segments.get('BYDAY')
  const weekdays = byday?.split(',')
    .map((day) => WEEKDAYS.indexOf(day.trim().replace(/^[+-]?\d+/, '').toUpperCase()) + 1)
    .filter((day) => day > 0) ?? []
  const ordinal = byday?.match(/^([+-]?\d+)(?:MO|TU|WE|TH|FR|SA|SU)$/i)?.[1]
  const positionText = segments.get('BYSETPOS') ?? ordinal
  const position = positionText ? Number.parseInt(positionText, 10) : null
  const monthDays = segments.get('BYMONTHDAY')?.split(',')
    .map((day) => Number.parseInt(day.trim(), 10)).filter((day) => !Number.isNaN(day)) ?? []

  return (period, first) => {
    const daysInMonth = period.daysInMonth ?? 31
    if (position !== null && weekdays.length > 0) {
      const matching: number[] = []
      for (let day = 1; day <= daysInMonth; day++) {
        const weekday = ((period.weekday + day - 2) % 7) + 1
        if (weekdays.includes(weekday)) matching.push(day)
      }
      const day = position > 0 ? matching[position - 1] : matching[matching.length + position]
      return day !== undefined && (!first || day >= masterStart.day) ? 1 : 0
    }
    const days = monthDays.length > 0 ? monthDays : [masterStart.day]
    return days.filter((day) => {
      const resolved = day < 0 ? daysInMonth + day + 1 : day
      return resolved >= 1 && resolved <= daysInMonth && (!first || resolved >= masterStart.day)
    }).length
  }
}

function finiteCountEnd(masterStart: DateTime, segments: Map<string, string>, count: number): DateTime {
  const interval = Math.max(1, Number.parseInt(segments.get('INTERVAL') ?? '1', 10) || 1)
  switch (segments.get('FREQ')) {
    case 'DAILY':
      return masterStart.plus({ days: count * interval })
    case 'WEEKLY':
      // One candidate per eligible week is the slowest supported weekly rule.
      return masterStart.plus({ weeks: count * interval })
    case 'MONTHLY':
      return countedPeriodEnd(masterStart, 'months', interval, count, monthlyDays(segments, masterStart))
    case 'YEARLY':
      return countedPeriodEnd(masterStart, 'years', interval, count, (period) =>
        DateTime.fromObject({ year: period.year, month: masterStart.month, day: masterStart.day }, { zone: masterStart.zone }).isValid ? 1 : 0)
    default:
      return masterStart
  }
}

/** Query all stored future vacations; only endless series need a finite horizon. */
export function vacationQueryRange(events: CalendarEvent[], start: DateTime): { end: DateTime; hasUnboundedRecurrence: boolean } {
  let end = start.startOf('day').plus({ days: 1 })
  let hasUnboundedRecurrence = false
  const includeThrough = (candidate: DateTime) => {
    if (!candidate.isValid) return
    const local = candidate.setZone(start.zone)
    // A midnight end is already exclusive; otherwise include the rest of its day.
    const boundary = local.equals(local.startOf('day')) ? local : local.startOf('day').plus({ days: 1 })
    if (boundary > end) end = boundary
  }

  for (const event of events) {
    if (event.isDeleted || event.eventType !== '휴가') continue
    const masterStart = DateTime.fromISO(event.startAtUtc, { zone: event.timeZone || 'UTC' })
    const masterEnd = DateTime.fromISO(event.endAtUtc, { zone: event.timeZone || 'UTC' })
    includeThrough(masterEnd)
    if (!event.recurrenceRule || event.recurringEventId || !masterStart.isValid || !masterEnd.isValid) continue

    const segments = parseRRuleSegments(event.recurrenceRule)
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(segments.get('FREQ') ?? '')) continue
    const durationMs = Math.max(0, masterEnd.toMillis() - masterStart.toMillis())
    const shiftDays = event.skipWeekendsAndHolidays ? MAX_BUSINESS_DAY_SHIFT : 0
    const untilIso = parseUntilToUtcIso(segments.get('UNTIL'))
    if (untilIso) {
      includeThrough(DateTime.fromISO(untilIso, { zone: 'utc' }).plus({ milliseconds: durationMs, days: shiftDays }))
      continue
    }

    const count = Number.parseInt(segments.get('COUNT') ?? '', 10)
    if (Number.isFinite(count) && count >= 0) {
      if (count === 0) continue
      const candidates = Math.min(MAX_RECURRENCE_CANDIDATES, count * (event.skipWeekendsAndHolidays ? 3 : 1))
      includeThrough(finiteCountEnd(masterStart, segments, candidates).plus({ milliseconds: durationMs, days: shiftDays }))
      continue
    }

    hasUnboundedRecurrence = true
    const anchor = masterStart > start ? masterStart : start
    includeThrough(anchor.plus({ years: 1, milliseconds: durationMs, days: shiftDays }))
  }
  return { end, hasUnboundedRecurrence }
}
