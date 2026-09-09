import { describe, expect, it } from 'vitest'
import { fuzzyFullNameCandidates } from './voiceNameMatch'

describe('fuzzyFullNameCandidates', () => {
  it('recovers a single misrecognized syllable sharing a Hangul component', () => {
    expect(fuzzyFullNameCandidates('김수원', ['김수헌', '이상승'])).toEqual(['김수헌'])
  })

  it('allows a one-component syllable difference', () => {
    expect(fuzzyFullNameCandidates('김수현', ['김수헌'])).toEqual(['김수헌'])
  })

  it('allows one changed syllable in the first given-name position', () => {
    expect(fuzzyFullNameCandidates('김소헌', ['김수헌'])).toEqual(['김수헌'])
  })

  it('prefers an exact registered name over similar people', () => {
    expect(fuzzyFullNameCandidates('김수원', ['김수헌', '김수원', '김수현'])).toEqual(['김수원'])
  })

  it('retains all candidates in registration order instead of choosing a fuzzy winner', () => {
    expect(fuzzyFullNameCandidates('김수원', ['김수헌', '김수현', '김수완'])).toEqual(['김수헌', '김수현', '김수완'])
  })

  it('does not return duplicate registered entries', () => {
    expect(fuzzyFullNameCandidates('김수원', ['김수헌', '김수헌'])).toEqual(['김수헌'])
  })

  it('normalizes Unicode and whitespace without changing the registered display name', () => {
    expect(fuzzyFullNameCandidates(' 김 수 원 '.normalize('NFD'), ['김 수 헌'])).toEqual(['김 수 헌'])
    expect(fuzzyFullNameCandidates('김수헌'.normalize('NFD'), ['김 수 헌', '김수현'])).toEqual(['김 수 헌'])
  })

  it('rejects a changed syllable with different initial, medial, and final components', () => {
    expect(fuzzyFullNameCandidates('김철수', ['김민수'])).toEqual([])
  })

  it('rejects a different surname even when the given name is exact', () => {
    expect(fuzzyFullNameCandidates('이수헌', ['김수헌'])).toEqual([])
  })

  it('rejects two changed given-name syllables', () => {
    expect(fuzzyFullNameCandidates('김소현', ['김수헌'])).toEqual([])
  })

  it.each(['수원', '수헌님', '김수원과장', '김수원 과장님', 'kim', '김수', '김수원이', '김수!'])('does not fuzzy match an incomplete name or title-bearing phrase: %s', (heard) => {
    expect(fuzzyFullNameCandidates(heard, ['김수헌'])).toEqual([])
  })

  it('does not use incomplete or title-bearing registered entries as candidates', () => {
    expect(fuzzyFullNameCandidates('김수원', ['수헌', '김수헌 과장', 'kim', '김수헌님'])).toEqual([])
  })

  it.each(['소장님', '과장님', '대리님', '본부장', '센터장'])('does not fuzzy match the role alias %s', (role) => {
    expect(fuzzyFullNameCandidates(role, ['소장림', '과장림', '대리림', '본부강', '센터강'])).toEqual([])
  })

  it('does not treat a registered role alias as a real name', () => {
    expect(fuzzyFullNameCandidates('소장림', ['소장님'])).toEqual([])
  })

  it('retains exact matches for names or aliases which do not qualify for fuzzy matching', () => {
    expect(fuzzyFullNameCandidates('수헌', ['수헌', '김수헌'])).toEqual(['수헌'])
    expect(fuzzyFullNameCandidates('소장님', ['소장님', '소장림'])).toEqual(['소장님'])
  })

  it('returns no candidates for empty input or an empty personnel list', () => {
    expect(fuzzyFullNameCandidates('', ['김수헌'])).toEqual([])
    expect(fuzzyFullNameCandidates(' ', [''])).toEqual([])
    expect(fuzzyFullNameCandidates('김수원', [])).toEqual([])
  })
})
