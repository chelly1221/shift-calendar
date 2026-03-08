const EDUCATION_TARGET_PREFIX = '교육대상: '

export function parseEducationTargets(description: string): { targets: string[]; cleanDescription: string } {
  const lines = description.split(/\r?\n/)
  let targets: string[] = []
  const remainingLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(EDUCATION_TARGET_PREFIX)) {
      targets = line
        .slice(EDUCATION_TARGET_PREFIX.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      remainingLines.push(line)
    }
  }

  return {
    targets,
    cleanDescription: remainingLines.join('\n').trimStart(),
  }
}
