import { describe, expect, it } from 'vitest'
import { createPoseModeResolver, gestureToMode, FIST_GESTURE, OPEN_PALM_GESTURE } from './handPoseMode'

describe('gestureToMode', () => {
  it('주먹 → calendar, 손바닥 → roster, 그 외 → null', () => {
    expect(gestureToMode(FIST_GESTURE)).toBe('calendar')
    expect(gestureToMode(OPEN_PALM_GESTURE)).toBe('roster')
    expect(gestureToMode('Thumb_Up')).toBeNull()
    expect(gestureToMode('None')).toBeNull()
    expect(gestureToMode(null)).toBeNull()
  })
})

describe('createPoseModeResolver', () => {
  it('손바닥을 holdMs 이상 유지하면 roster로 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', { holdMs: 400 })
    expect(resolver.push({ t: 0, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 200, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.pending()).toEqual({ mode: 'roster', heldMs: 200 })
    expect(resolver.push({ t: 400, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBe('roster')
    expect(resolver.current()).toBe('roster')
    expect(resolver.pending()).toBeNull()
  })

  it('전환 후 같은 자세를 계속 유지해도 다시 이벤트를 내지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', { holdMs: 100 })
    resolver.push({ t: 0, gesture: OPEN_PALM_GESTURE, score: 0.9 })
    expect(resolver.push({ t: 100, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBe('roster')
    expect(resolver.push({ t: 200, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 1000, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
  })

  it('주먹을 쥐면 calendar로 돌아온다', () => {
    const resolver = createPoseModeResolver('roster', { holdMs: 100 })
    expect(resolver.push({ t: 0, gesture: FIST_GESTURE, score: 0.8 })).toBeNull()
    expect(resolver.push({ t: 100, gesture: FIST_GESTURE, score: 0.8 })).toBe('calendar')
  })

  it('유지 중 다른 자세/손 없음이 끼어들면 누적이 초기화된다', () => {
    const resolver = createPoseModeResolver('calendar', { holdMs: 300 })
    expect(resolver.push({ t: 0, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 150, gesture: null, score: 0 })).toBeNull()
    expect(resolver.pending()).toBeNull()
    expect(resolver.push({ t: 200, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 400, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull() // 200ms만 유지
    expect(resolver.push({ t: 500, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBe('roster')
  })

  it('신뢰도가 낮은 샘플은 무시된다', () => {
    const resolver = createPoseModeResolver('calendar', { holdMs: 100, minScore: 0.6 })
    expect(resolver.push({ t: 0, gesture: OPEN_PALM_GESTURE, score: 0.5 })).toBeNull()
    expect(resolver.push({ t: 100, gesture: OPEN_PALM_GESTURE, score: 0.5 })).toBeNull()
    expect(resolver.push({ t: 200, gesture: OPEN_PALM_GESTURE, score: 0.5 })).toBeNull()
    expect(resolver.current()).toBe('calendar')
  })

  it('인식 대상이 아닌 자세(Thumb_Up 등)는 현재 모드를 유지한다', () => {
    const resolver = createPoseModeResolver('roster', { holdMs: 100 })
    expect(resolver.push({ t: 0, gesture: 'Thumb_Up', score: 0.95 })).toBeNull()
    expect(resolver.push({ t: 500, gesture: 'Thumb_Up', score: 0.95 })).toBeNull()
    expect(resolver.current()).toBe('roster')
  })

  it('setCurrent로 외부 변경을 동기화하면 같은 자세로는 전환 이벤트가 나지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', { holdMs: 100 })
    resolver.setCurrent('roster')
    expect(resolver.push({ t: 0, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 200, gesture: OPEN_PALM_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 300, gesture: FIST_GESTURE, score: 0.9 })).toBeNull()
    expect(resolver.push({ t: 400, gesture: FIST_GESTURE, score: 0.9 })).toBe('calendar')
  })
})
