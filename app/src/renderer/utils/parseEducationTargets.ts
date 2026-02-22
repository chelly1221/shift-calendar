const EDUCATION_TARGET_PREFIX = '교육대상: '

export function parseEducationTargets(description: string): { targets: string[]; cleanDescription: string } {
  const lines = description.split('\n')
  if (lines.length > 0 && lines[0].startsWith(EDUCATION_TARGET_PREFIX)) {
    const targets = lines[0]
      .slice(EDUCATION_TARGET_PREFIX.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const cleanDescription = lines.slice(1).join('\n').trimStart()
    return { targets, cleanDescription }
  }
  return { targets: [], cleanDescription: description }
}
