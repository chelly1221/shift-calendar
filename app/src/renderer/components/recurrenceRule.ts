import { formatUntilUtc, parseRRuleSegments, parseUntilToUtcIso, serializeRRuleSegments } from '../../shared/rrule'

export type WeekdayCode = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export type RecurrencePreset = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type MonthlyPattern = 'BY_MONTH_DAY' | 'BY_NTH_WEEKDAY'
export type RecurrenceEndMode = 'NEVER' | 'UNTIL' | 'COUNT'
export type MonthlyByDay = WeekdayCode | 'WEEKDAY'

export interface RecurrenceValue {
  preset: RecurrencePreset
  interval: number
  weeklyDays: WeekdayCode[]
  monthlyPattern: MonthlyPattern
  monthDay: number
  bySetPos: number
  monthlyByDay: MonthlyByDay
  endMode: RecurrenceEndMode
  untilDate: string
  count: number
}

export const WEEKDAY_OPTIONS: { code: WeekdayCode; label: string }[] = [
  { code: 'MO', label: '월' },
  { code: 'TU', label: '화' },
  { code: 'WE', label: '수' },
  { code: 'TH', label: '목' },
  { code: 'FR', label: '금' },
  { code: 'SA', label: '토' },
  { code: 'SU', label: '일' },
]

const WEEKDAY_ORDER: WeekdayCode[] = WEEKDAY_OPTIONS.map((option) => option.code)

function sortWeekdays(days: WeekdayCode[]): WeekdayCode[] {
  return [...new Set(days)].sort((left, right) => WEEKDAY_ORDER.indexOf(left) - WEEKDAY_ORDER.indexOf(right))
}

function clampInterval(interval: number): number {
  if (!Number.isFinite(interval)) {
    return 1
  }
  return Math.max(1, Math.floor(interval))
}

function clampDayOfMonth(day: number): number {
  if (!Number.isFinite(day)) {
    return 1
  }
  return Math.min(31, Math.max(1, Math.floor(day)))
}

function clampCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 1
  }
  return Math.max(1, Math.floor(count))
}

function clampSetPos(setPos: number): number {
  if (![1, 2, 3, 4, -1].includes(setPos)) {
    return 1
  }
  return setPos
}

function defaultUntilDate(): string {
  const now = new Date()
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function defaultRecurrenceValue(): RecurrenceValue {
  return {
    preset: 'NONE',
    interval: 1,
    weeklyDays: ['MO'],
    monthlyPattern: 'BY_MONTH_DAY',
    monthDay: 1,
    bySetPos: 1,
    monthlyByDay: 'MO',
    endMode: 'NEVER',
    untilDate: defaultUntilDate(),
    count: 10,
  }
}

function parseWeekdays(byDayValue: string | undefined): WeekdayCode[] {
  if (!byDayValue) {
    return []
  }
  return byDayValue
    .split(',')
    .map((day) => day.trim().toUpperCase())
    .filter((day): day is WeekdayCode => WEEKDAY_ORDER.includes(day as WeekdayCode))
}

function parseMonthDay(byMonthDay: string | undefined): number {
  if (!byMonthDay) {
    return 1
  }
  const first = byMonthDay.split(',')[0]
  return clampDayOfMonth(Number.parseInt(first, 10))
}

function parseUntilDateString(untilValue: string | undefined): string {
  const iso = parseUntilToUtcIso(untilValue ?? null)
  if (!iso) {
    return defaultUntilDate()
  }
  return iso.slice(0, 10)
}

export function parseRRule(rule: string | null | undefined): RecurrenceValue {
  const defaults = defaultRecurrenceValue()
  if (!rule) {
    return defaults
  }

  const segments = parseRRuleSegments(rule)
  const freq = segments.get('FREQ')?.toUpperCase() as RecurrencePreset | undefined
  if (!freq || freq === 'NONE') {
    return defaults
  }

  const value: RecurrenceValue = {
    ...defaults,
    preset: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) ? freq : 'NONE',
    interval: clampInterval(Number.parseInt(segments.get('INTERVAL') ?? '1', 10)),
  }

  const weeklyDays = sortWeekdays(parseWeekdays(segments.get('BYDAY')))
  if (value.preset === 'WEEKLY') {
    value.weeklyDays = weeklyDays.length > 0 ? weeklyDays : ['MO']
  }

  if (value.preset === 'MONTHLY') {
    const byMonthDay = segments.get('BYMONTHDAY')
    const bySetPos = Number.parseInt(segments.get('BYSETPOS') ?? '1', 10)
    if (byMonthDay) {
      value.monthlyPattern = 'BY_MONTH_DAY'
      value.monthDay = parseMonthDay(byMonthDay)
    } else if (weeklyDays.length > 0 && segments.get('BYSETPOS')) {
      value.monthlyPattern = 'BY_NTH_WEEKDAY'
      value.bySetPos = clampSetPos(bySetPos)
      const isWeekdaySet =
        weeklyDays.length === 5
        && weeklyDays.every((day) => ['MO', 'TU', 'WE', 'TH', 'FR'].includes(day))
      value.monthlyByDay = isWeekdaySet ? 'WEEKDAY' : weeklyDays[0]
    }
  }

  const count = Number.parseInt(segments.get('COUNT') ?? '0', 10)
  if (Number.isFinite(count) && count > 0) {
    value.endMode = 'COUNT'
    value.count = clampCount(count)
  } else if (segments.get('UNTIL')) {
    value.endMode = 'UNTIL'
    value.untilDate = parseUntilDateString(segments.get('UNTIL'))
  }

  return value
}

export function recurrenceToRRule(value: RecurrenceValue): string | null {
  if (value.preset === 'NONE') {
    return null
  }

  const segments = new Map<string, string>()
  segments.set('FREQ', value.preset)
  segments.set('INTERVAL', `${clampInterval(value.interval)}`)

  if (value.preset === 'WEEKLY') {
    const byDay = sortWeekdays(value.weeklyDays).join(',')
    segments.set('BYDAY', byDay || 'MO')
  }

  if (value.preset === 'MONTHLY') {
    if (value.monthlyPattern === 'BY_MONTH_DAY') {
      segments.set('BYMONTHDAY', `${clampDayOfMonth(value.monthDay)}`)
    } else {
      const byDay = value.monthlyByDay === 'WEEKDAY' ? 'MO,TU,WE,TH,FR' : value.monthlyByDay
      segments.set('BYDAY', byDay)
      segments.set('BYSETPOS', `${clampSetPos(value.bySetPos)}`)
    }
  }

  if (value.endMode === 'COUNT') {
    segments.set('COUNT', `${clampCount(value.count)}`)
  } else if (value.endMode === 'UNTIL' && value.untilDate) {
    const untilIso = new Date(`${value.untilDate}T23:59:59.000Z`).toISOString()
    segments.set('UNTIL', formatUntilUtc(untilIso))
  }

  return serializeRRuleSegments(segments)
}
