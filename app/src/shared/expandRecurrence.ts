import { DateTime, type WeekdayNumbers } from 'luxon'
import type { CalendarEvent } from './calendar'
import { parseRRuleSegments, parseUntilToUtcIso } from './rrule'
import type { WeekdayCode } from './rrule'

export const VIRTUAL_INSTANCE_PREFIX = 'virtual::'

export function isVirtualInstance(localId: string): boolean {
  return localId.startsWith(VIRTUAL_INSTANCE_PREFIX)
}

export function extractMasterLocalId(virtualLocalId: string): string {
  if (!isVirtualInstance(virtualLocalId)) {
    return virtualLocalId
  }
  const withoutPrefix = virtualLocalId.slice(VIRTUAL_INSTANCE_PREFIX.length)
  const separatorIndex = withoutPrefix.indexOf('::')
  return separatorIndex >= 0 ? withoutPrefix.slice(0, separatorIndex) : withoutPrefix
}

function makeVirtualLocalId(masterLocalId: string, occurrenceStartUtcIso: string): string {
  return `${VIRTUAL_INSTANCE_PREFIX}${masterLocalId}::${occurrenceStartUtcIso}`
}

const WEEKDAY_TO_LUXON: Record<WeekdayCode, WeekdayNumbers> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
}

const MAX_INSTANCES_PER_MASTER = 400

interface OccurrenceGeneratorOptions {
  freq: string
  interval: number
  masterStartLocal: DateTime
  rangeEndLocal: DateTime
  count: number | null
  untilLocal: DateTime | null
  byday: WeekdayCode[]
  bymonthday: number[]
  bysetpos: number | null
}

function* generateOccurrences(options: OccurrenceGeneratorOptions): Generator<DateTime> {
  const { freq, interval, masterStartLocal, rangeEndLocal, count, untilLocal, byday, bymonthday, bysetpos } = options

  let yielded = 0
  const effectiveEnd = untilLocal && untilLocal < rangeEndLocal ? untilLocal : rangeEndLocal

  if (freq === 'DAILY') {
    let cursor = masterStartLocal
    while (cursor <= effectiveEnd) {
      if (count !== null && yielded >= count) break
      if (yielded >= MAX_INSTANCES_PER_MASTER) break
      yield cursor
      yielded++
      cursor = cursor.plus({ days: interval })
    }
    return
  }

  if (freq === 'WEEKLY') {
    const targetDays: WeekdayNumbers[] = byday.length > 0
      ? byday.map((d) => WEEKDAY_TO_LUXON[d])
      : [masterStartLocal.weekday as WeekdayNumbers]
    let weekStart = masterStartLocal.startOf('week')
    while (weekStart <= effectiveEnd) {
      for (const dayNum of targetDays) {
        const candidate = weekStart.set({ weekday: dayNum }).set({
          hour: masterStartLocal.hour,
          minute: masterStartLocal.minute,
          second: masterStartLocal.second,
          millisecond: masterStartLocal.millisecond,
        })
        if (candidate < masterStartLocal) continue
        if (candidate > effectiveEnd) continue
        if (count !== null && yielded >= count) return
        if (yielded >= MAX_INSTANCES_PER_MASTER) return
        yield candidate
        yielded++
      }
      weekStart = weekStart.plus({ weeks: interval })
    }
    return
  }

  if (freq === 'MONTHLY') {
    if (bysetpos !== null && byday.length > 0) {
      // Nth weekday of month (e.g., 2nd Tuesday)
      let cursor = masterStartLocal.startOf('month')
      while (cursor <= effectiveEnd) {
        for (const dayCode of byday) {
          const nthResult = nthWeekdayOfMonth(cursor.year, cursor.month, WEEKDAY_TO_LUXON[dayCode], bysetpos, masterStartLocal)
          if (!nthResult) continue
          if (nthResult < masterStartLocal) { /* skip before master start */ }
          else if (nthResult > effectiveEnd) { /* skip after range end */ }
          else {
            if (count !== null && yielded >= count) return
            if (yielded >= MAX_INSTANCES_PER_MASTER) return
            yield nthResult
            yielded++
          }
        }
        cursor = cursor.plus({ months: interval })
      }
      return
    }

    // BYMONTHDAY or default to master's day
    const days = bymonthday.length > 0 ? bymonthday : [masterStartLocal.day]
    let cursor = masterStartLocal.startOf('month')
    while (cursor <= effectiveEnd) {
      for (const day of days) {
        const daysInMonth = cursor.daysInMonth ?? 31
        if (day > daysInMonth) continue
        const candidate = cursor.set({ day }).set({
          hour: masterStartLocal.hour,
          minute: masterStartLocal.minute,
          second: masterStartLocal.second,
          millisecond: masterStartLocal.millisecond,
        })
        if (candidate < masterStartLocal) continue
        if (candidate > effectiveEnd) continue
        if (count !== null && yielded >= count) return
        if (yielded >= MAX_INSTANCES_PER_MASTER) return
        yield candidate
        yielded++
      }
      cursor = cursor.plus({ months: interval })
    }
    return
  }

  if (freq === 'YEARLY') {
    let cursor = masterStartLocal
    while (cursor <= effectiveEnd) {
      if (count !== null && yielded >= count) break
      if (yielded >= MAX_INSTANCES_PER_MASTER) break
      yield cursor
      yielded++
      cursor = cursor.plus({ years: interval })
    }
    return
  }
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  setpos: number,
  masterStartLocal: DateTime,
): DateTime | null {
  const firstOfMonth = DateTime.local(year, month, 1, {
    zone: masterStartLocal.zone,
  })
  const daysInMonth = firstOfMonth.daysInMonth ?? 31

  if (setpos > 0) {
    // Positive: 1st, 2nd, 3rd... occurrence
    let found = 0
    for (let day = 1; day <= daysInMonth; day++) {
      const dt = firstOfMonth.set({ day })
      if (dt.weekday === weekday) {
        found++
        if (found === setpos) {
          return dt.set({
            hour: masterStartLocal.hour,
            minute: masterStartLocal.minute,
            second: masterStartLocal.second,
            millisecond: masterStartLocal.millisecond,
          })
        }
      }
    }
    return null
  }

  // Negative: -1 = last, -2 = second-to-last...
  const absPos = Math.abs(setpos)
  let found = 0
  for (let day = daysInMonth; day >= 1; day--) {
    const dt = firstOfMonth.set({ day })
    if (dt.weekday === weekday) {
      found++
      if (found === absPos) {
        return dt.set({
          hour: masterStartLocal.hour,
          minute: masterStartLocal.minute,
          second: masterStartLocal.second,
          millisecond: masterStartLocal.millisecond,
        })
      }
    }
  }
  return null
}

export function expandRecurringEvents(
  events: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
): CalendarEvent[] {
  // Collect googleEventIds that already have child instances
  const masterIdsWithInstances = new Set<string>()
  for (const event of events) {
    if (event.recurringEventId) {
      masterIdsWithInstances.add(event.recurringEventId)
    }
  }

  const result: CalendarEvent[] = []

  for (const event of events) {
    // Not a master event → keep as-is
    if (!event.recurrenceRule || event.recurringEventId) {
      result.push(event)
      continue
    }

    // Master has real instances from Google → keep master as-is (instances are separate rows)
    if (event.googleEventId && masterIdsWithInstances.has(event.googleEventId)) {
      result.push(event)
      continue
    }

    // Expand this master into virtual instances
    const segments = parseRRuleSegments(event.recurrenceRule)
    const freq = segments.get('FREQ')
    if (!freq) {
      result.push(event)
      continue
    }

    const interval = Number.parseInt(segments.get('INTERVAL') ?? '1', 10) || 1
    const countStr = segments.get('COUNT')
    const count = countStr ? Number.parseInt(countStr, 10) : null
    const untilStr = parseUntilToUtcIso(segments.get('UNTIL'))

    const bydayStr = segments.get('BYDAY')
    const byday: WeekdayCode[] = bydayStr
      ? (bydayStr.split(',').map((s) => s.trim().replace(/^[+-]?\d+/, '').toUpperCase()).filter(Boolean) as WeekdayCode[])
      : []

    const bymonthdayStr = segments.get('BYMONTHDAY')
    const bymonthday: number[] = bymonthdayStr
      ? bymonthdayStr.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
      : []

    const bysetposStr = segments.get('BYSETPOS')
    const bysetpos = bysetposStr ? Number.parseInt(bysetposStr, 10) : null

    const zone = event.timeZone || 'UTC'
    const masterStartLocal = DateTime.fromISO(event.startAtUtc, { zone: 'utc' }).setZone(zone)
    const masterEndLocal = DateTime.fromISO(event.endAtUtc, { zone: 'utc' }).setZone(zone)
    const durationMs = masterEndLocal.toMillis() - masterStartLocal.toMillis()

    const rangeEndLocal = DateTime.fromISO(rangeEndUtc, { zone: 'utc' }).setZone(zone)
    const untilLocal = untilStr ? DateTime.fromISO(untilStr, { zone: 'utc' }).setZone(zone) : null

    for (const occurrenceLocal of generateOccurrences({
      freq,
      interval,
      masterStartLocal,
      rangeEndLocal,
      count,
      untilLocal,
      byday,
      bymonthday,
      bysetpos,
    })) {
      const occStartUtc = occurrenceLocal.toUTC()
      const occEndUtc = DateTime.fromMillis(occurrenceLocal.toMillis() + durationMs, { zone: 'utc' })

      // Skip occurrences before range
      if (occEndUtc.toISO()! < rangeStartUtc) continue

      const occStartUtcIso = occStartUtc.toISO()!
      const occEndUtcIso = occEndUtc.toISO()!

      const isFirstOccurrence = occurrenceLocal.toMillis() === masterStartLocal.toMillis()

      result.push({
        ...event,
        localId: isFirstOccurrence ? event.localId : makeVirtualLocalId(event.localId, occStartUtcIso),
        startAtUtc: occStartUtcIso,
        endAtUtc: occEndUtcIso,
        originalStartTimeUtc: isFirstOccurrence ? event.originalStartTimeUtc : occStartUtcIso,
      })
    }
  }

  return result
}
