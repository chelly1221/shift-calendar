import { DateTime, type WeekdayNumbers } from 'luxon'
import type { CalendarEvent } from './calendar'
import { FIXED_PUBLIC_HOLIDAY_MMDD } from './koreanHolidays'
import { parseRRuleSegments, parseUntilToUtcIso } from './rrule'
import type { WeekdayCode } from './rrule'

export const VIRTUAL_INSTANCE_PREFIX = 'v::'
/** @deprecated kept for backwards compatibility with persisted IDs */
const LEGACY_VIRTUAL_PREFIX = 'virtual::'

export function isVirtualInstance(localId: string): boolean {
  return localId.startsWith(VIRTUAL_INSTANCE_PREFIX) || localId.startsWith(LEGACY_VIRTUAL_PREFIX)
}

export function extractMasterLocalId(virtualLocalId: string): string {
  if (!isVirtualInstance(virtualLocalId)) {
    return virtualLocalId
  }
  const prefixLen = virtualLocalId.startsWith(LEGACY_VIRTUAL_PREFIX)
    ? LEGACY_VIRTUAL_PREFIX.length
    : VIRTUAL_INSTANCE_PREFIX.length
  const withoutPrefix = virtualLocalId.slice(prefixLen)
  const separatorIndex = withoutPrefix.indexOf('::')
  return separatorIndex >= 0 ? withoutPrefix.slice(0, separatorIndex) : withoutPrefix
}

/** Compact UTC timestamp: 20260226T143000Z (17 chars vs 24 for full ISO) */
function compactUtc(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function makeVirtualLocalId(masterLocalId: string, occurrenceStartUtcIso: string): string {
  return `${VIRTUAL_INSTANCE_PREFIX}${masterLocalId}::${compactUtc(occurrenceStartUtcIso)}`
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

// Keep a practical hard cap to avoid runaway expansion, but high enough for long-running daily series.
const MAX_INSTANCES_PER_MASTER = 10_000

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
    const targetDays: WeekdayNumbers[] = (byday.length > 0
      ? byday.map((d) => WEEKDAY_TO_LUXON[d])
      : [masterStartLocal.weekday as WeekdayNumbers]
    ).sort((a, b) => a - b)
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
    const masterMonth = masterStartLocal.month
    const masterDay = masterStartLocal.day
    let cursorYear = masterStartLocal.year
    while (true) {
      if (count !== null && yielded >= count) break
      if (yielded >= MAX_INSTANCES_PER_MASTER) break
      // For Feb 29 events, skip non-leap years
      if (masterMonth === 2 && masterDay === 29 && !DateTime.local(cursorYear, 2, 29).isValid) {
        cursorYear += interval
        continue
      }
      const candidate = DateTime.local(
        cursorYear, masterMonth, masterDay,
        masterStartLocal.hour, masterStartLocal.minute, masterStartLocal.second,
        { zone: masterStartLocal.zone },
      )
      if (!candidate.isValid || candidate > effectiveEnd) break
      if (candidate >= masterStartLocal) {
        yield candidate
        yielded++
      }
      cursorYear += interval
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

/**
 * 주말(토/일) 또는 공휴일이면 다음 평일로 이동한 DateTime을 반환합니다.
 * holidayDates는 'YYYY-MM-DD' 형태의 Set입니다.
 */
function shiftToNextBusinessDay(dt: DateTime, holidayDates: Set<string>): DateTime {
  let shifted = dt
  const MAX_SHIFT = 14 // 연휴 최대 안전 한도
  for (let i = 0; i < MAX_SHIFT; i++) {
    const wd = shifted.weekday // 6=Sat, 7=Sun
    const isoDate = shifted.toISODate()
    const mmdd = isoDate ? isoDate.slice(5) : '' // "MM-DD"
    if (wd !== 6 && wd !== 7 && !holidayDates.has(isoDate!) && !FIXED_PUBLIC_HOLIDAY_MMDD.has(mmdd)) {
      break
    }
    shifted = shifted.plus({ days: 1 })
  }
  return shifted
}

export function expandRecurringEvents(
  events: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
  holidayDates?: Set<string>,
): CalendarEvent[] {
  // Collect googleEventIds that already have child instances
  const masterIdsWithInstances = new Set<string>()
  // Track cancelled/override instance timestamps per master googleEventId
  const cancelledTimestamps = new Map<string, Set<string>>()
  for (const event of events) {
    if (event.recurringEventId) {
      masterIdsWithInstances.add(event.recurringEventId)
      if (event.originalStartTimeUtc) {
        let timestamps = cancelledTimestamps.get(event.recurringEventId)
        if (!timestamps) {
          timestamps = new Set<string>()
          cancelledTimestamps.set(event.recurringEventId, timestamps)
        }
        timestamps.add(DateTime.fromISO(event.originalStartTimeUtc, { zone: 'utc' }).toMillis().toString())
      }
    }
  }

  // Identify masters that need virtual expansion despite having Google instances
  // (skipWeekendsAndHolidays requires virtual expansion to apply the shift)
  const mastersNeedingVirtualExpansion = new Set<string>()
  for (const event of events) {
    if (
      event.recurrenceRule
      && !event.recurringEventId
      && event.skipWeekendsAndHolidays
      && holidayDates
      && event.googleEventId
      && masterIdsWithInstances.has(event.googleEventId)
    ) {
      mastersNeedingVirtualExpansion.add(event.googleEventId)
    }
  }

  const result: CalendarEvent[] = []

  for (const event of events) {
    // Not a master event → keep as-is (but skip Google instances for masters being re-expanded)
    if (!event.recurrenceRule || event.recurringEventId) {
      if (event.recurringEventId && mastersNeedingVirtualExpansion.has(event.recurringEventId)) {
        // Skip Google instances — virtual expansion with shift will replace them
        continue
      }
      result.push(event)
      continue
    }

    // Master has real instances from Google and does NOT need shift → keep master as-is
    if (event.googleEventId && masterIdsWithInstances.has(event.googleEventId)
      && !mastersNeedingVirtualExpansion.has(event.googleEventId)) {
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

    // Build set of cancelled/override timestamps for this master.
    // When re-expanding a Google-synced master for shift, skip cancelled timestamp filtering
    // because ALL Google instances (not just cancelled ones) contribute to cancelledTimestamps.
    const isVirtualReExpansion = event.googleEventId && mastersNeedingVirtualExpansion.has(event.googleEventId)
    const masterCancelledTs = !isVirtualReExpansion && event.googleEventId
      ? cancelledTimestamps.get(event.googleEventId)
      : undefined

    const shouldShift = event.skipWeekendsAndHolidays && holidayDates

    // When skipWeekendsAndHolidays is enabled with COUNT, the generator must produce
    // more candidates than COUNT because deduplication may discard some.
    // Pass count=null to the generator and count non-duplicate results externally.
    const generatorCount = shouldShift ? null : count

    interface Candidate {
      occurrenceLocal: DateTime
      effectiveLocal: DateTime
      wasShifted: boolean
    }

    // Collect candidates (with shift applied), then deduplicate in a second pass
    // so that natural (non-shifted) instances are preferred over shifted ones.
    const candidates: Candidate[] = []
    const rangeStartMs = DateTime.fromISO(rangeStartUtc).toMillis()

    for (const occurrenceLocal of generateOccurrences({
      freq,
      interval,
      masterStartLocal,
      rangeEndLocal,
      count: generatorCount,
      untilLocal,
      byday,
      bymonthday,
      bysetpos,
    })) {
      const effectiveLocal = shouldShift
        ? shiftToNextBusinessDay(occurrenceLocal, holidayDates!)
        : occurrenceLocal

      const wasShifted = effectiveLocal.toMillis() !== occurrenceLocal.toMillis()

      // Skip occurrences that match a cancelled/override instance
      const originalUtcMs = occurrenceLocal.toUTC().toMillis().toString()
      if (masterCancelledTs?.has(originalUtcMs)) continue

      // Skip occurrences before range
      const occEndMs = effectiveLocal.toMillis() + durationMs
      if (occEndMs < rangeStartMs) continue

      candidates.push({ occurrenceLocal, effectiveLocal, wasShifted })

      // For non-shift mode, respect count naturally
      if (!shouldShift && count !== null && candidates.length >= count) break
      // For shift mode, generate enough candidates (overshoot to handle dedup losses)
      if (shouldShift && count !== null && candidates.length >= count * 3) break
    }

    // Dedup pass: prefer natural instances; drop shifted instances that collide
    let emitted: Candidate[]
    if (shouldShift) {
      // First, collect all dates that have natural (non-shifted) instances
      const naturalDates = new Set<string>()
      for (const c of candidates) {
        if (!c.wasShifted) naturalDates.add(c.effectiveLocal.toISODate()!)
      }
      // Then filter: natural instances always pass; shifted only if no collision
      const shiftedSeen = new Set<string>()
      emitted = []
      for (const c of candidates) {
        const dateKey = c.effectiveLocal.toISODate()!
        if (c.wasShifted) {
          if (naturalDates.has(dateKey) || shiftedSeen.has(dateKey)) continue
          shiftedSeen.add(dateKey)
        }
        emitted.push(c)
        if (count !== null && emitted.length >= count) break
      }
    } else {
      emitted = candidates
    }

    for (const { occurrenceLocal, effectiveLocal, wasShifted } of emitted) {
      const occStartUtc = effectiveLocal.toUTC()
      const occEndUtc = DateTime.fromMillis(effectiveLocal.toMillis() + durationMs, { zone: 'utc' })
      const occStartUtcIso = occStartUtc.toISO()!
      const occEndUtcIso = occEndUtc.toISO()!

      // Use original (unshifted) time for virtualLocalId to keep stable IDs
      const originalStartUtcIso = occurrenceLocal.toUTC().toISO()!
      const isFirstOccurrence = occurrenceLocal.toMillis() === masterStartLocal.toMillis()

      result.push({
        ...event,
        localId: isFirstOccurrence ? event.localId : makeVirtualLocalId(event.localId, originalStartUtcIso),
        startAtUtc: occStartUtcIso,
        endAtUtc: occEndUtcIso,
        // For shifted first occurrences, use the unshifted time as originalStartTimeUtc
        // so that THIS-scope overrides and FUTURE splits use the correct RRULE boundary.
        originalStartTimeUtc: isFirstOccurrence
          ? (wasShifted ? originalStartUtcIso : event.originalStartTimeUtc)
          : originalStartUtcIso,
      })
    }
  }

  return result
}
