export type RRuleFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type WeekdayCode = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

const RRULE_PREFIX = 'RRULE:'
const RRULE_KEY_ORDER = [
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYSETPOS',
  'UNTIL',
  'COUNT',
  'WKST',
] as const

function normalizeRule(rule: string): string {
  const trimmed = rule.trim()
  return trimmed.startsWith(RRULE_PREFIX) ? trimmed.slice(RRULE_PREFIX.length) : trimmed
}

export function parseRRuleSegments(rule: string): Map<string, string> {
  const normalized = normalizeRule(rule)
  const segments = new Map<string, string>()
  if (!normalized) {
    return segments
  }

  for (const token of normalized.split(';')) {
    const [keyPart, ...valueParts] = token.split('=')
    const key = keyPart?.trim().toUpperCase()
    const value = valueParts.join('=').trim()
    if (!key || !value) {
      continue
    }
    segments.set(key, value)
  }

  return segments
}

export function serializeRRuleSegments(segments: Map<string, string>): string {
  const ordered: string[] = []
  const consumed = new Set<string>()

  for (const key of RRULE_KEY_ORDER) {
    const value = segments.get(key)
    if (!value) {
      continue
    }
    ordered.push(`${key}=${value}`)
    consumed.add(key)
  }

  const remaining = Array.from(segments.entries())
    .filter(([key]) => !consumed.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)

  return [...ordered, ...remaining].join(';')
}

export function formatUntilUtc(dateUtcIso: string): string {
  const date = new Date(dateUtcIso)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC date for UNTIL: ${dateUtcIso}`)
  }

  const yyyy = date.getUTCFullYear().toString().padStart(4, '0')
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = date.getUTCDate().toString().padStart(2, '0')
  const hh = date.getUTCHours().toString().padStart(2, '0')
  const mi = date.getUTCMinutes().toString().padStart(2, '0')
  const ss = date.getUTCSeconds().toString().padStart(2, '0')
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`
}

export function parseUntilToUtcIso(untilValue: string | null | undefined): string | null {
  if (!untilValue) {
    return null
  }

  if (/^\d{8}$/.test(untilValue)) {
    const year = Number.parseInt(untilValue.slice(0, 4), 10)
    const month = Number.parseInt(untilValue.slice(4, 6), 10) - 1
    const day = Number.parseInt(untilValue.slice(6, 8), 10)
    return new Date(Date.UTC(year, month, day, 0, 0, 0)).toISOString()
  }

  if (/^\d{8}T\d{6}Z$/i.test(untilValue)) {
    const value = untilValue.toUpperCase()
    const year = Number.parseInt(value.slice(0, 4), 10)
    const month = Number.parseInt(value.slice(4, 6), 10) - 1
    const day = Number.parseInt(value.slice(6, 8), 10)
    const hour = Number.parseInt(value.slice(9, 11), 10)
    const minute = Number.parseInt(value.slice(11, 13), 10)
    const second = Number.parseInt(value.slice(13, 15), 10)
    return new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString()
  }

  return null
}

export function withRRuleUntil(rule: string, untilUtcIso: string): string {
  const segments = parseRRuleSegments(rule)
  if (!segments.get('FREQ')) {
    throw new Error(`RRULE missing FREQ: ${rule}`)
  }
  segments.delete('COUNT')
  segments.set('UNTIL', formatUntilUtc(untilUtcIso))
  return serializeRRuleSegments(segments)
}

export function withRRuleCount(rule: string, count: number): string {
  const segments = parseRRuleSegments(rule)
  if (!segments.get('FREQ')) {
    throw new Error(`RRULE missing FREQ: ${rule}`)
  }
  segments.delete('UNTIL')
  segments.set('COUNT', `${Math.max(1, Math.floor(count))}`)
  return serializeRRuleSegments(segments)
}

export function withoutRRuleEnd(rule: string): string {
  const segments = parseRRuleSegments(rule)
  segments.delete('UNTIL')
  segments.delete('COUNT')
  return serializeRRuleSegments(segments)
}

export function splitRRuleForFuture(rule: string, splitStartUtcIso: string): string {
  const splitStartMs = Date.parse(splitStartUtcIso)
  if (Number.isNaN(splitStartMs)) {
    throw new Error(`Invalid split start UTC: ${splitStartUtcIso}`)
  }
  const untilMs = splitStartMs - 1000
  return withRRuleUntil(rule, new Date(untilMs).toISOString())
}
