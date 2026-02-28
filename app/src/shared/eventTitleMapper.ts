import type { ShiftTeamAssignments } from './calendar'

type ShiftTeamKey = 'A' | 'B' | 'C' | 'D'

export interface SubstitutionBlock {
  substitute: string
  type: '대리근무' | '대체근무'
  original: string
}

// --- Shift abbreviation helpers ---

const SHIFT_ABBREV_RE = /([A-D])\(([^)]+)\)/g

export function buildUniqueCharMap(allNames: string[]): Map<string, string> {
  if (allNames.length === 0) return new Map()

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

  // First pass: assign each name its best candidate (unique > fewest owners)
  const result = new Map<string, string>()
  const usedChars = new Set<string>()
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
  return summary.replace(/([A-D])\([^)]+\)/g, '$1').trim()
}

export function resolveAbbreviationToName(char: string, allNames: string[]): string | null {
  const matches = allNames.filter((name) => name.includes(char))
  return matches.length === 1 ? matches[0] : null
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
): string {
  const clean = stripShiftAbbreviations(summary)
  if (allNames.length === 0) return clean

  const substitutions = parseSubstitutionBlocks(description)
  if (substitutions.length === 0) return clean

  const charMap = buildUniqueCharMap(allNames)

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

const VACATION_TITLE_RE =
  /^([\p{Script=Hangul}]{2,4}(?:\s*,\s*[\p{Script=Hangul}]{2,4})*)\s+(대휴|연차|시간차(?:\([^)]+\))?|장기휴가)$/u

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
  return description.split('\n').some((line) => line.startsWith(prefix))
}

function prependMetadataLine(description: string, line: string): string {
  return description ? `${line}\n${description}` : line
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
): InferredMetadata {
  if (currentEventType === '일반') {
    // Try vacation pattern
    const vacMatch = summary.match(VACATION_TITLE_RE)
    if (vacMatch) {
      const names = parseNames(vacMatch[1])
      const vacationType = vacMatch[2]
      let desc = description

      if (!hasMetadataLine(desc, VACATION_TARGET_PREFIX)) {
        desc = prependMetadataLine(desc, `${VACATION_TARGET_PREFIX}${names.join(', ')}`)
      }
      if (!hasMetadataLine(desc, VACATION_TYPE_PREFIX)) {
        // Insert after target line
        const lines = desc.split('\n')
        const targetIdx = lines.findIndex((l) => l.startsWith(VACATION_TARGET_PREFIX))
        if (targetIdx >= 0) {
          lines.splice(targetIdx + 1, 0, `${VACATION_TYPE_PREFIX}${vacationType}`)
          desc = lines.join('\n')
        } else {
          desc = prependMetadataLine(desc, `${VACATION_TYPE_PREFIX}${vacationType}`)
        }
      }

      return { eventType: '휴가', summary, description: desc }
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
      .split('\n')
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
    // Supplement description metadata from summary if missing
    const vacMatch = summary.match(VACATION_TITLE_RE)
    if (vacMatch) {
      const names = parseNames(vacMatch[1])
      const vacationType = vacMatch[2]
      let desc = description

      if (!hasMetadataLine(desc, VACATION_TARGET_PREFIX)) {
        desc = prependMetadataLine(desc, `${VACATION_TARGET_PREFIX}${names.join(', ')}`)
      }
      if (!hasMetadataLine(desc, VACATION_TYPE_PREFIX)) {
        const lines = desc.split('\n')
        const targetIdx = lines.findIndex((l) => l.startsWith(VACATION_TARGET_PREFIX))
        if (targetIdx >= 0) {
          lines.splice(targetIdx + 1, 0, `${VACATION_TYPE_PREFIX}${vacationType}`)
          desc = lines.join('\n')
        } else {
          desc = prependMetadataLine(desc, `${VACATION_TYPE_PREFIX}${vacationType}`)
        }
      }

      return { eventType: currentEventType, summary, description: desc }
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
      .split('\n')
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
