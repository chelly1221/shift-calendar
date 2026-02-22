const VACATION_TARGET_PREFIX = '휴가대상: '
const VACATION_TYPE_PREFIX = '휴가종류: '

export const VACATION_TYPES = ['장기휴가', '연차', '대휴', '시간차'] as const
export type VacationType = (typeof VACATION_TYPES)[number]

export function isPresetVacationType(value: string): value is VacationType {
  return (VACATION_TYPES as readonly string[]).includes(value)
}

export function parseVacationInfo(description: string): {
  targets: string[]
  vacationType: string | null
  cleanDescription: string
} {
  let targets: string[] = []
  let vacationType: string | null = null
  const remainingLines: string[] = []

  for (const line of description.split('\n')) {
    if (line.startsWith(VACATION_TARGET_PREFIX)) {
      targets = line
        .slice(VACATION_TARGET_PREFIX.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (line.startsWith(VACATION_TYPE_PREFIX)) {
      const parsed = line.slice(VACATION_TYPE_PREFIX.length).trim()
      if (parsed) {
        vacationType = parsed
      }
    } else {
      remainingLines.push(line)
    }
  }

  return { targets, vacationType, cleanDescription: remainingLines.join('\n').trimStart() }
}

export function serializeVacationInfo(
  targets: string[],
  vacationType: string | null,
  description: string,
): string {
  const lines: string[] = []
  if (targets.length > 0) {
    lines.push(`${VACATION_TARGET_PREFIX}${targets.join(', ')}`)
  }
  if (vacationType) {
    lines.push(`${VACATION_TYPE_PREFIX}${vacationType}`)
  }
  if (description) {
    lines.push(description)
  }
  return lines.join('\n')
}
