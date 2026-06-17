import { describe, expect, it } from 'vitest'

import { EVENT_TYPE_ORDER, eventTypeSortIndex } from './eventTypeOrder'

describe('eventTypeSortIndex', () => {
  it('휴가·교육이 최상단(가장 작은 인덱스)', () => {
    expect(eventTypeSortIndex('휴가')).toBe(0)
    expect(eventTypeSortIndex('교육')).toBe(1)
  })

  it('출장이 최하단(가장 큰 인덱스)', () => {
    expect(eventTypeSortIndex('출장')).toBe(EVENT_TYPE_ORDER.length - 1)
  })

  it('타입 순서가 위→아래로 단조 증가', () => {
    const indices = EVENT_TYPE_ORDER.map((type) => eventTypeSortIndex(type) ?? -1)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(indices).not.toContain(-1)
  })

  it('매핑되지 않은 타입(근무/공휴일/레거시)은 null', () => {
    expect(eventTypeSortIndex('근무')).toBeNull()
    expect(eventTypeSortIndex('공휴일')).toBeNull()
    expect(eventTypeSortIndex('알수없는타입')).toBeNull()
  })
})
