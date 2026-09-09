const FULL_KOREAN_NAME = /^[가-힣]{3}$/u
const ROLE_ALIAS = /^(?:소장|대리|과장|차장|부장|주임|계장|팀장|실장|국장|본부장|센터장|사원)(?:님)?$/u

function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '')
}

function syllableParts(syllable: string): [number, number, number] {
  const offset = syllable.charCodeAt(0) - 0xac00
  return [Math.floor(offset / 588), Math.floor(offset / 28) % 21, offset % 28]
}

function isSimilarFullName(heard: string, registered: string): boolean {
  if (!FULL_KOREAN_NAME.test(registered) || ROLE_ALIAS.test(registered) || heard[0] !== registered[0]) return false
  const differences = [1, 2].filter((index) => heard[index] !== registered[index])
  if (differences.length !== 1) return false
  const index = differences[0]
  const heardParts = syllableParts(heard[index])
  const registeredParts = syllableParts(registered[index])
  return heardParts.filter((part, position) => part !== registeredParts[position]).length <= 2
}

/** Registered names must be real personnel names, not arbitrary three-syllable aliases. */
export function fuzzyFullNameCandidates(heard: string, registeredNames: string[]): string[] {
  const normalizedHeard = normalizeName(heard)
  if (!normalizedHeard) return []
  const names = Array.from(new Set(registeredNames)).map((original) => ({ original, normalized: normalizeName(original) }))
  const exact = names.filter(({ normalized }) => normalized === normalizedHeard)
  if (exact.length > 0) return exact.map(({ original }) => original)
  if (!FULL_KOREAN_NAME.test(normalizedHeard) || ROLE_ALIAS.test(normalizedHeard)) return []
  return names.filter(({ normalized }) => isSimilarFullName(normalizedHeard, normalized)).map(({ original }) => original)
}
