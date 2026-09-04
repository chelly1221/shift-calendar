import type { ShiftTeamAssignments } from './calendar'

type ShiftTeamKey = 'A' | 'B' | 'C' | 'D'

export interface SubstitutionBlock {
  substitute: string
  type: '대리근무' | '대체근무'
  original: string
}

// --- Shift abbreviation helpers ---

const SHIFT_ABBREV_RE = /(?<=^|[/／\s])([A-D])\(([^)]+)\)/g

export function buildUniqueCharMap(allNames: string[], customOverrides?: Record<string, string>): Map<string, string> {
  if (allNames.length === 0) return new Map()

  const result = new Map<string, string>()
  const usedChars = new Set<string>()

  // Apply custom overrides first
  if (customOverrides) {
    for (const [name, char] of Object.entries(customOverrides)) {
      if (char && allNames.includes(name)) {
        result.set(name, char)
        usedChars.add(char)
      }
    }
  }

  const charOwners = new Map<string, Set<string>>()
  for (const name of allNames) {
    for (const char of name) {
      const owners = charOwners.get(char)
      if (owners) {
        owners.add(name)
      } else {
        charOwners.set(char, new Set([name]))
      }
    }
  }

  // Assign remaining names their best candidate (unique > fewest owners)
  // Sort candidates by uniqueness — names with a truly unique char go first
  const namesByPriority = [...allNames].sort((a, b) => {
    const aHasUnique = [...a].some((c) => (charOwners.get(c)?.size ?? Infinity) === 1)
    const bHasUnique = [...b].some((c) => (charOwners.get(c)?.size ?? Infinity) === 1)
    if (aHasUnique && !bHasUnique) return -1
    if (!aHasUnique && bHasUnique) return 1
    return 0
  })

  for (const name of namesByPriority) {
    if (result.has(name)) continue
    let bestChar: string | null = null
    let bestCount = Infinity
    for (const char of name) {
      if (usedChars.has(char)) continue
      const count = charOwners.get(char)?.size ?? Infinity
      if (count === 1) {
        bestChar = char
        break
      }
      if (count < bestCount) {
        bestCount = count
        bestChar = char
      }
    }
    // Fallback: if all chars are taken, pick the least-shared char regardless
    if (!bestChar) {
      bestCount = Infinity
      for (const char of name) {
        const count = charOwners.get(char)?.size ?? Infinity
        if (count < bestCount) {
          bestCount = count
          bestChar = char
        }
      }
    }
    if (bestChar) {
      result.set(name, bestChar)
      usedChars.add(bestChar)
    }
  }
  return result
}

export function parseShiftAbbreviations(summary: string): Map<ShiftTeamKey, string[]> {
  const result = new Map<ShiftTeamKey, string[]>()
  let match: RegExpExecArray | null
  const re = new RegExp(SHIFT_ABBREV_RE.source, SHIFT_ABBREV_RE.flags)
  while ((match = re.exec(summary)) !== null) {
    const team = match[1] as ShiftTeamKey
    const chars = match[2].split(',').map((c) => c.trim()).filter(Boolean)
    if (chars.length > 0) {
      result.set(team, chars)
    }
  }
  return result
}

export function stripShiftAbbreviations(summary: string): string {
  return summary.replace(/(?<=^|[/／\s])([A-D])\([^)]+\)/g, '$1').trim()
}

export function resolveAbbreviationToName(char: string, allNames: string[], customOverrides?: Record<string, string>): string | null {
  // Check custom overrides first — exact char match takes priority
  if (customOverrides) {
    const overrideMatch = Object.entries(customOverrides).find(
      ([name, c]) => c === char && allNames.includes(name),
    )
    if (overrideMatch) return overrideMatch[0]
  }
  const matches = allNames.filter((name) => name.includes(char))
  return matches.length >= 1 ? matches[0] : null
}

export function parseSubstitutionBlocks(description: string): SubstitutionBlock[] {
  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const substitutions: SubstitutionBlock[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const substituteMatch = lines[index].match(/^대체근무자\s*:\s*(.+)$/)
    if (!substituteMatch) continue

    const typeMatch = lines[index + 1]?.match(/^근무종류\s*:\s*(대리근무|대체근무)$/)
    const originalMatch = lines[index + 2]?.match(/^원근무자\s*:\s*(.+)$/)
    if (!typeMatch || !originalMatch) continue

    const substitute = substituteMatch[1].trim()
    const original = originalMatch[1].trim()
    if (!substitute || !original) continue

    substitutions.push({
      substitute,
      type: typeMatch[1] as '대리근무' | '대체근무',
      original,
    })
    index += 2
  }

  return substitutions
}

export function buildShiftGoogleSummary(
  summary: string,
  description: string,
  teams: ShiftTeamAssignments,
  allNames: string[],
  customOverrides?: Record<string, string>,
): string {
  const clean = stripShiftAbbreviations(summary)
  if (allNames.length === 0) return clean

  const substitutions = parseSubstitutionBlocks(description)
  if (substitutions.length === 0) return clean

  const charMap = buildUniqueCharMap(allNames, customOverrides)

  // Build a map: teamKey → list of abbreviation chars for substitutes in that team
  const teamAbbrevs = new Map<ShiftTeamKey, string[]>()
  for (const sub of substitutions) {
    // Find which team the original belongs to
    let targetTeam: ShiftTeamKey | null = null
    for (const key of ['A', 'B', 'C', 'D'] as const) {
      if (teams[key].some((m) => m.trim() === sub.original)) {
        targetTeam = key
        break
      }
    }
    if (!targetTeam) continue

    const char = charMap.get(sub.substitute)
    if (!char) continue

    const existing = teamAbbrevs.get(targetTeam) ?? []
    if (!existing.includes(char)) {
      existing.push(char)
    }
    teamAbbrevs.set(targetTeam, existing)
  }

  if (teamAbbrevs.size === 0) return clean

  // Structural approach: split on '/' separators, find team letters by position, insert abbreviations
  const parts = clean.split(/([/／])/)
  for (let i = 0; i < parts.length; i += 1) {
    const trimmed = parts[i].trim()
    if (trimmed.length === 0) continue
    // Check if this part starts with a team letter that has abbreviations
    const leadChar = trimmed[0]
    if (leadChar === 'A' || leadChar === 'B' || leadChar === 'C' || leadChar === 'D') {
      const abbrevChars = teamAbbrevs.get(leadChar)
      if (abbrevChars) {
        parts[i] = parts[i].replace(leadChar, `${leadChar}(${abbrevChars.join(',')})`)
        teamAbbrevs.delete(leadChar)
      }
    }
  }

  return parts.join('')
}

const VACATION_TARGET_PREFIX = '휴가대상: '
const VACATION_TYPE_PREFIX = '휴가종류: '
const EDUCATION_TARGET_PREFIX = '교육대상: '

/**
 * 일반 일정 제목에서 휴가로 자동 전환할 키워드 (공백 제거 후 부분 일치).
 * '공가'는 이사공가·예비군공가 등을, '휴가'는 장기휴가·여름휴가 등을 함께 잡는다.
 */
export const VACATION_KEYWORDS: readonly string[] = [
  '연차',
  '반차',
  '대휴',
  '병가',
  '공가',
  '건강검진',
  '시간차',
  '휴가',
  '경조',
]

/** 팀원 명단에 없을 때 쓰는 선행 토큰 이름 휴리스틱에서 이름으로 오인하기 쉬운 수식어 */
const VACATION_NAME_STOPWORDS = new Set([
  '오전', '오후', '종일', '전일', '반일', '하루', '이틀', '전체', '전원', '시간', '휴무', '출근', '퇴근',
])

/** "이름(, 이름)* 나머지" — 이름 토큰은 한글 2~4자 또는 영문 2~20자 */
const LEADING_NAMES_RE =
  /^((?:[\p{Script=Hangul}]{2,4}|[A-Za-z]{2,20})(?:\s*,\s*(?:[\p{Script=Hangul}]{2,4}|[A-Za-z]{2,20}))*)\s+(.+)$/u

/** 시간차(09:00~13:00) — 시간 정보는 기호 제거 대상에서 제외하고 그대로 보존 */
const TIMED_VACATION_TYPE_RE = /^시간차\([^)]+\)$/u

export function containsVacationKeyword(text: string): boolean {
  const normalized = text.replace(/\s+/g, '')
  return VACATION_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

/** ShiftSettings(teams + dayWorkers)에서 중복 없는 팀원 이름 목록을 만든다. */
export function collectShiftMemberNames(settings: { teams: ShiftTeamAssignments; dayWorkers: string[] }): string[] {
  const names: string[] = []
  for (const key of ['A', 'B', 'C', 'D'] as const) {
    for (const member of settings.teams[key]) {
      const trimmed = member.trim()
      if (trimmed && !names.includes(trimmed)) names.push(trimmed)
    }
  }
  for (const worker of settings.dayWorkers) {
    const trimmed = worker.trim()
    if (trimmed && !names.includes(trimmed)) names.push(trimmed)
  }
  return names
}

export interface InferredVacation {
  /** 제목에서 인식된 휴가 대상자 이름 */
  targets: string[]
  /** 이름을 뺀 나머지 텍스트(기호 제거) — 휴가종류 뱃지 */
  vacationType: string
  /** 정규화된 제목: "이름, 이름 휴가종류" (이름 없으면 휴가종류만) */
  summary: string
}

/**
 * 제목에 휴가 키워드가 있으면 대상자 이름과 휴가 종류를 추출한다. 없으면 null.
 *
 * 1. 팀원 명단(memberNames) 이름은 제목 어디에 있어도 인식 (긴 이름부터 → 부분 겹침 방지)
 * 2. 명단에서 못 찾으면 "이름(, 이름)* 나머지" 형태의 선행 토큰을 이름으로 본다
 *    (키워드를 포함하거나 오전/오후 같은 수식어인 토큰은 제외)
 * 3. 이름을 뺀 나머지가 휴가 종류. 시간차(HH:MM~HH:MM)는 보존, 그 외는 기호를 공백으로 치환
 */
export function inferVacationFromSummary(
  summary: string,
  memberNames: readonly string[] = [],
): InferredVacation | null {
  const trimmed = summary.trim()
  if (!trimmed || !containsVacationKeyword(trimmed)) return null

  const targets: string[] = []
  let rest = trimmed

  const knownNames = [...new Set(memberNames.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  for (const name of knownNames) {
    if (!rest.includes(name)) continue
    targets.push(name)
    rest = rest.split(name).join(' ')
  }

  if (targets.length === 0) {
    const match = rest.match(LEADING_NAMES_RE)
    if (match) {
      const candidates = parseNames(match[1])
      const looksLikeNames = candidates.every(
        (candidate) => !containsVacationKeyword(candidate) && !VACATION_NAME_STOPWORDS.has(candidate),
      )
      if (looksLikeNames && containsVacationKeyword(match[2])) {
        targets.push(...candidates)
        rest = match[2]
      }
    }
  }

  const remainder = rest.replace(/\s+/g, ' ').trim()
  if (!containsVacationKeyword(remainder)) return null
  const vacationType = TIMED_VACATION_TYPE_RE.test(remainder)
    ? remainder
    : remainder.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!vacationType) return null

  return {
    targets,
    vacationType,
    summary: [targets.join(', '), vacationType].filter(Boolean).join(' '),
  }
}

const EDUCATION_TITLE_RE =
  /^([\p{Script=Hangul}]{2,4}(?:\s*,\s*[\p{Script=Hangul}]{2,4})*)\s+(.+(?:교육|훈련).*)$/u

interface InferredMetadata {
  eventType: string
  summary: string
  description: string
}

function parseNames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function hasMetadataLine(description: string, prefix: string): boolean {
  return description.split(/\r?\n/).some((line) => line.startsWith(prefix))
}

function prependMetadataLine(description: string, line: string): string {
  return description ? `${line}\n${description}` : line
}

/** description에 휴가대상/휴가종류 메타데이터 줄이 없으면 앞에 넣는다 (있으면 그대로). */
function injectVacationMetadata(description: string, targets: string[], vacationType: string): string {
  let desc = description
  if (targets.length > 0 && !hasMetadataLine(desc, VACATION_TARGET_PREFIX)) {
    desc = prependMetadataLine(desc, `${VACATION_TARGET_PREFIX}${targets.join(', ')}`)
  }
  if (!hasMetadataLine(desc, VACATION_TYPE_PREFIX)) {
    // Insert after target line
    const lines = desc.split(/\r?\n/)
    const targetIdx = lines.findIndex((l) => l.startsWith(VACATION_TARGET_PREFIX))
    if (targetIdx >= 0) {
      lines.splice(targetIdx + 1, 0, `${VACATION_TYPE_PREFIX}${vacationType}`)
      desc = lines.join('\n')
    } else {
      desc = prependMetadataLine(desc, `${VACATION_TYPE_PREFIX}${vacationType}`)
    }
  }
  return desc
}

/**
 * 일반 일정(summary/description)에 휴가 키워드가 있으면 휴가 이벤트로 변환한 결과를 돌려준다.
 * 제목은 "이름, 이름 휴가종류"로 정규화되고 description에 휴가대상/휴가종류 줄이 주입된다.
 * 키워드가 없으면 null. Google pull(inferEventMetadata)과 로컬 저장(IPC upsert)이 공용.
 */
export function inferVacationEvent(
  summary: string,
  description: string,
  memberNames: readonly string[] = [],
): InferredMetadata | null {
  const vacation = inferVacationFromSummary(summary, memberNames)
  if (!vacation) return null
  return {
    eventType: '휴가',
    summary: vacation.summary,
    description: injectVacationMetadata(description, vacation.targets, vacation.vacationType),
  }
}

export interface InferEventMetadataOptions {
  /** 팀원 이름 목록 — 제목 속 휴가 대상자 인식에 사용 */
  memberNames?: readonly string[]
}

/**
 * Inbound: infer eventType and enrich description from Google Calendar summary.
 *
 * - When eventType is '일반' (no extendedProperties), detect vacation/education patterns.
 * - When eventType is '교육' (round-trip), strip target names from summary.
 * - When eventType is '휴가', supplement description metadata if missing.
 */
export function inferEventMetadata(
  summary: string,
  description: string,
  currentEventType: string,
  options?: InferEventMetadataOptions,
): InferredMetadata {
  if (currentEventType === '일반') {
    // Try vacation keywords (연차/병가/공가/건강검진 …) — 이름은 팀원 명단 우선, 없으면 선행 토큰 휴리스틱
    const vacation = inferVacationEvent(summary, description, options?.memberNames)
    if (vacation) {
      return vacation
    }

    // Try education pattern
    const eduMatch = summary.match(EDUCATION_TITLE_RE)
    if (eduMatch) {
      const names = parseNames(eduMatch[1])
      const educationTitle = eduMatch[2].trim()
      let desc = description

      if (!hasMetadataLine(desc, EDUCATION_TARGET_PREFIX)) {
        desc = prependMetadataLine(desc, `${EDUCATION_TARGET_PREFIX}${names.join(', ')}`)
      }

      return { eventType: '교육', summary: educationTitle, description: desc }
    }

    return { eventType: currentEventType, summary, description }
  }

  if (currentEventType === '교육') {
    // Round-trip cleanup: strip target names from summary prefix
    const targetLine = description
      .split(/\r?\n/)
      .find((l) => l.startsWith(EDUCATION_TARGET_PREFIX))
    if (targetLine) {
      const targets = parseNames(targetLine.slice(EDUCATION_TARGET_PREFIX.length))
      if (targets.length > 0) {
        // Build regex to strip "이름, 이름 " prefix from summary
        const escapedNames = targets.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        const namesPattern = new RegExp(
          `^${escapedNames.join('\\s*,\\s*')}\\s+`,
          'u',
        )
        const cleanSummary = summary.replace(namesPattern, '')
        if (cleanSummary !== summary) {
          return { eventType: currentEventType, summary: cleanSummary, description }
        }
      }
    }
    return { eventType: currentEventType, summary, description }
  }

  if (currentEventType === '휴가') {
    // Supplement description metadata from summary if missing (summary는 건드리지 않음)
    const hasTargets = hasMetadataLine(description, VACATION_TARGET_PREFIX)
    const hasType = hasMetadataLine(description, VACATION_TYPE_PREFIX)
    if (hasTargets && hasType) {
      return { eventType: currentEventType, summary, description }
    }
    const vacation = inferVacationFromSummary(summary, options?.memberNames)
    if (vacation) {
      return {
        eventType: currentEventType,
        summary,
        description: injectVacationMetadata(description, vacation.targets, vacation.vacationType),
      }
    }
    return { eventType: currentEventType, summary, description }
  }

  return { eventType: currentEventType, summary, description }
}

/**
 * Outbound: build Google Calendar summary from local event data.
 *
 * - For '교육' events, prepend target names from description to summary.
 * - For all others, return summary as-is.
 */
export function toGoogleSummary(
  summary: string,
  description: string,
  eventType: string,
): string {
  if (eventType === '교육') {
    const targetLine = description
      .split(/\r?\n/)
      .find((l) => l.startsWith(EDUCATION_TARGET_PREFIX))
    if (targetLine) {
      const targets = parseNames(targetLine.slice(EDUCATION_TARGET_PREFIX.length))
      if (targets.length > 0) {
        return `${targets.join(', ')} ${summary}`
      }
    }
  }
  return summary
}
