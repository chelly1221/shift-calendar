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
