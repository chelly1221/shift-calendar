import { describe, expect, it } from 'vitest'
import { parseRoutineCompletions, serializeRoutineCompletions } from './parseRoutineCompletions'

describe('parseRoutineCompletions', () => {
  it('extracts completion dates and removes metadata line from description', () => {
    const parsed = parseRoutineCompletions('점검 작업\n반복완료: 2026-02-01, 2026-02-03')
    expect(parsed.completedDates).toEqual(['2026-02-01', '2026-02-03'])
    expect(parsed.cleanDescription).toBe('점검 작업')
  })

  it('normalizes completion dates by filtering invalid values and removing duplicates', () => {
    const parsed = parseRoutineCompletions('반복완료: 2026-02-03, abc, 2026-02-03, 2026-02-01')
    expect(parsed.completedDates).toEqual(['2026-02-01', '2026-02-03'])
    expect(parsed.cleanDescription).toBe('')
  })
})

describe('serializeRoutineCompletions', () => {
  it('writes completion metadata with normalized order', () => {
    const serialized = serializeRoutineCompletions(
      ['2026-02-03', '2026-02-01', '2026-02-03'],
      '점검 작업',
    )
    expect(serialized).toBe('점검 작업\n반복완료: 2026-02-01, 2026-02-03')
  })

  it('returns plain description when no completion dates are present', () => {
    const serialized = serializeRoutineCompletions([], '점검 작업')
    expect(serialized).toBe('점검 작업')
  })
})
