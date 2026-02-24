const ROUTINE_COMPLETED_PREFIX = '반복완료: '

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function normalizeDates(values: string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!ISO_DATE_PATTERN.test(trimmed)) {
      continue
    }
    unique.add(trimmed)
  }
  return [...unique].sort()
}

export function parseRoutineCompletions(description: string): {
  completedDates: string[]
  cleanDescription: string
} {
  let completedDates: string[] = []
  const remainingLines: string[] = []

  for (const line of description.split('\n')) {
    if (line.startsWith(ROUTINE_COMPLETED_PREFIX)) {
      completedDates = normalizeDates(
        line
          .slice(ROUTINE_COMPLETED_PREFIX.length)
          .split(',')
          .map((value) => value.trim()),
      )
      continue
    }
    remainingLines.push(line)
  }

  return {
    completedDates,
    cleanDescription: remainingLines.join('\n').trimStart(),
  }
}

export function serializeRoutineCompletions(completedDates: string[], description: string): string {
  const normalized = normalizeDates(completedDates)
  const lines: string[] = []
  if (description) {
    lines.push(description)
  }
  if (normalized.length > 0) {
    lines.push(`${ROUTINE_COMPLETED_PREFIX}${normalized.join(', ')}`)
  }
  return lines.join('\n')
}
