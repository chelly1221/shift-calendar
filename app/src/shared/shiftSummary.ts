import { DateTime } from 'luxon'
import type { CalendarEvent, ShiftTeamAssignments } from './calendar'
import { parseVacationInfo } from './parseVacationInfo'
import { parseEducationTargets } from './parseEducationTargets'

type ShiftTeamKey = 'A' | 'B' | 'C' | 'D'
type SubstitutionWorkType = '대리근무' | '대체근무'

interface ShiftSubstitutionMeta {
  substitute: string
  type: SubstitutionWorkType
  original: string
}

interface ShiftDescriptionState {
  baseLines: string[]
  substitutions: ShiftSubstitutionMeta[]
}

export function parseShiftTeamsFromSummary(summary: string): { dayTeam: ShiftTeamKey; nightTeam: ShiftTeamKey } | null {
  const normalized = summary.toUpperCase()
  const separators = [...normalized.matchAll(/[/／]/g)]
  const maxDistance = 12

  for (const separator of separators) {
    if (separator.index == null) {
      continue
    }

    let dayTeam: ShiftTeamKey | null = null
    for (let cursor = separator.index - 1; cursor >= 0 && separator.index - cursor <= maxDistance; cursor -= 1) {
      const letter = normalized[cursor]
      if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') {
        dayTeam = letter
        break
      }
    }

    if (!dayTeam) {
      continue
    }

    let nightTeam: ShiftTeamKey | null = null
    for (
      let cursor = separator.index + 1;
      cursor < normalized.length && cursor - separator.index <= maxDistance;
      cursor += 1
    ) {
      const letter = normalized[cursor]
      if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') {
        nightTeam = letter
        break
      }
    }

    if (!nightTeam) {
      continue
    }

    return { dayTeam, nightTeam }
  }

  return null
}

export function parseShiftDescriptionState(description: string): ShiftDescriptionState {
  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const baseLines: string[] = []
  const substitutions: ShiftSubstitutionMeta[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const substituteMatch = lines[index].match(/^대체근무자\s*:\s*(.+)$/)
    if (!substituteMatch) {
      baseLines.push(lines[index])
      continue
    }

    const typeMatch = lines[index + 1]?.match(/^근무종류\s*:\s*(대리근무|대체근무)$/)
    const originalMatch = lines[index + 2]?.match(/^원근무자\s*:\s*(.+)$/)
    if (!typeMatch || !originalMatch) {
      baseLines.push(lines[index])
      continue
    }

    const substitute = substituteMatch[1].trim()
    const original = originalMatch[1].trim()
    if (!substitute || !original) {
      baseLines.push(lines[index])
      continue
    }

    substitutions.push({
      substitute,
      type: typeMatch[1] as SubstitutionWorkType,
      original,
    })
    index += 2
  }

  return {
    baseLines,
    substitutions,
  }
}

export function serializeShiftDescriptionState(state: ShiftDescriptionState): string {
  const base = state.baseLines.map((line) => line.trim()).filter((line) => line.length > 0)
  const substitutionLines = state.substitutions.flatMap((entry) => [
    `대체근무자: ${entry.substitute}`,
    `근무종류: ${entry.type}`,
    `원근무자: ${entry.original}`,
  ])
  return [...base, ...substitutionLines].join('\n')
}

function collectShiftMembersWithSubstitutions(
  teamKeys: ShiftTeamKey[],
  teams: ShiftTeamAssignments,
  substitutionsByTeamOriginal: Map<string, string>,
): string[] {
  const members: string[] = []
  for (const teamKey of teamKeys) {
    for (const rawName of teams[teamKey]) {
      const originalName = rawName.trim()
      if (!originalName) {
        continue
      }

      const replacedName = substitutionsByTeamOriginal.get(`${teamKey}:${originalName}`)?.trim() || originalName
      if (!replacedName || members.includes(replacedName)) {
        continue
      }
      members.push(replacedName)
    }
  }
  return members
}

/** 근무표 표시용 — 휴가/교육으로 빠지는 사람도 삭선+뱃지로 남겨둡니다. */
export interface RosterMember {
  name: string
  /** 휴가/교육 사유. null이면 정상 근무 */
  absence: { kind: '휴가' | '교육'; label: string; /** 시간차 등 부분 휴가는 근무에서 빠지지 않음 */ partial: boolean } | null
}

export function getWorkingRosterMembers(roster: readonly RosterMember[]): RosterMember[] {
  return roster.filter((member) => !member.absence || member.absence.partial)
}

/** A configured team with nobody attending is different from missing member settings. */
export function formatShiftWorkers(teams: readonly string[], roster: readonly RosterMember[]): string | null {
  if (!teams.length) return null
  const working = getWorkingRosterMembers(roster)
  return working.length ? working.map((member) => member.name).join(' · ')
    : `${teams.join('·')}조 ${roster.length ? '근무자 없음' : '미지정'}`
}

export interface ShiftDaySummary {
  dateIso: string
  dayTeams: ShiftTeamKey[]
  nightTeams: ShiftTeamKey[]
  /** 대체근무 반영 + 휴가/교육자 제외된 주간 근무자 (오늘 근무 카드용) */
  dayMembers: string[]
  /** 대체근무 반영 + 휴가/교육자 제외된 야간 근무자 (오늘 근무 카드용) */
  nightMembers: string[]
  /** 휴가/교육자 제외된 일근자 (주말·공휴일이면 빈 배열) */
  dayWorkerNames: string[]
  /** 근무표용 전체 명단 (휴가/교육자 포함, absence 표시) */
  dayRoster: RosterMember[]
  nightRoster: RosterMember[]
  dayWorkerRoster: RosterMember[]
  hideDayWorkers: boolean
  hasShiftTeams: boolean
}

function eventCoversLocalDate(event: CalendarEvent, date: DateTime): boolean {
  const start = DateTime.fromISO(event.startAtUtc).setZone(date.zoneName ?? 'Asia/Seoul')
  const end = DateTime.fromISO(event.endAtUtc).setZone(date.zoneName ?? 'Asia/Seoul')
  return start.startOf('day') <= date && end > date
}

/**
 * 특정 날짜의 근무자 구성을 계산합니다 (오늘 근무 카드·2주 근무표 공용).
 * contextEvents는 이미 반복 일정이 확장된 목록이어야 합니다.
 */
export function buildShiftDaySummary(
  dateIso: string,
  contextEvents: CalendarEvent[],
  teams: ShiftTeamAssignments,
  dayWorkers: string[],
  publicHolidayMap: Map<string, string>,
  timeZone: string = DateTime.local().zoneName,
): ShiftDaySummary {
  const date = DateTime.fromISO(dateIso, { zone: timeZone }).startOf('day')
  const dayTeams: ShiftTeamKey[] = []
  const nightTeams: ShiftTeamKey[] = []
  const substitutionsByTeamOriginal = new Map<string, string>()

  for (const event of contextEvents) {
    if (event.eventType !== '근무') continue
    if (DateTime.fromISO(event.startAtUtc).setZone(date.zoneName ?? 'Asia/Seoul').toISODate() !== dateIso) continue
    const parsed = parseShiftTeamsFromSummary(event.summary)
    if (!parsed) {
      continue
    }
    if (!dayTeams.includes(parsed.dayTeam)) {
      dayTeams.push(parsed.dayTeam)
    }
    if (!nightTeams.includes(parsed.nightTeam)) {
      nightTeams.push(parsed.nightTeam)
    }

    const dayMembers = teams[parsed.dayTeam].map((name) => name.trim()).filter(Boolean)
    const nightMembers = teams[parsed.nightTeam].map((name) => name.trim()).filter(Boolean)
    const parsedDescription = parseShiftDescriptionState(event.description ?? '')
    for (const substitution of parsedDescription.substitutions) {
      const original = substitution.original.trim()
      const substitute = substitution.substitute.trim()
      if (!original || !substitute) {
        continue
      }
      const isDayMember = dayMembers.includes(original)
      const isNightMember = nightMembers.includes(original)
      const targetTeam = isDayMember ? parsed.dayTeam : isNightMember ? parsed.nightTeam : null
      if (!targetTeam) {
        continue
      }
      substitutionsByTeamOriginal.set(`${targetTeam}:${original}`, substitute)
    }
  }

  // 근무 제외 대상(휴가/교육) 수집 — 시간차 휴가는 근무에서 빼지 않음(뱃지만 표시)
  const absenceByName = new Map<string, RosterMember['absence']>()
  for (const event of contextEvents) {
    if (event.eventType !== '휴가') continue
    if (!eventCoversLocalDate(event, date)) continue
    const { targets, vacationType } = parseVacationInfo(event.description ?? '')
    // 시간차·반차는 하루 일부만 쉬므로 근무에서 빼지 않고 뱃지만 표시 ("오후 시간차"처럼 앞에 수식어가 와도 인식)
    const partial = Boolean(vacationType && (vacationType.includes('시간차') || vacationType.includes('반차')))
    for (const name of targets) {
      const trimmed = name.trim()
      if (!trimmed) continue
      const existing = absenceByName.get(trimmed)
      // 전일 휴가가 시간차보다 우선
      if (existing && !existing.partial) continue
      absenceByName.set(trimmed, { kind: '휴가', label: vacationType ?? '휴가', partial })
    }
  }

  for (const event of contextEvents) {
    if (event.eventType !== '교육') continue
    if (!eventCoversLocalDate(event, date)) continue
    const { targets } = parseEducationTargets(event.description ?? '')
    for (const name of targets) {
      const trimmed = name.trim()
      if (!trimmed) continue
      const existing = absenceByName.get(trimmed)
      if (existing && !existing.partial) continue
      absenceByName.set(trimmed, { kind: '교육', label: '교육', partial: false })
    }
  }
  const unavailableNames = new Set<string>()
  for (const [name, absence] of absenceByName) {
    if (absence && !absence.partial) unavailableNames.add(name)
  }
  const toRoster = (names: string[]): RosterMember[] =>
    names.map((name) => ({ name, absence: absenceByName.get(name.trim()) ?? null }))

  const isWeekend = date.weekday === 6 || date.weekday === 7
  const isHoliday = publicHolidayMap.has(dateIso)
  const hideDayWorkers = isWeekend || isHoliday

  const allDayWorkers = hideDayWorkers ? [] : dayWorkers.filter((name) => name.trim().length > 0)
  const dayWorkerNames = allDayWorkers.filter((name) => !unavailableNames.has(name.trim()))
  const hasShiftTeams = dayTeams.length > 0 || nightTeams.length > 0

  const allDayMembers = collectShiftMembersWithSubstitutions(dayTeams, teams, substitutionsByTeamOriginal)
  const allNightMembers = collectShiftMembersWithSubstitutions(nightTeams, teams, substitutionsByTeamOriginal)
  const dayMembers = allDayMembers.filter((name) => !unavailableNames.has(name.trim()))
  const nightMembers = allNightMembers.filter((name) => !unavailableNames.has(name.trim()))

  return {
    dateIso,
    dayTeams,
    nightTeams,
    dayMembers,
    nightMembers,
    dayWorkerNames,
    dayRoster: toRoster(allDayMembers),
    nightRoster: toRoster(allNightMembers),
    dayWorkerRoster: toRoster(allDayWorkers),
    hideDayWorkers,
    hasShiftTeams,
  }
}
