import { describe, expect, it } from 'vitest'
import {
  createPoseModeResolver,
  gestureToMode,
  FIST_GESTURE,
  OPEN_PALM_GESTURE,
  type GestureSample,
  type ViewMode,
} from './handPoseMode'

/** 15fps(66ms 간격) 샘플 시퀀스를 넣고 전환 이벤트를 모읍니다. */
function feed(
  resolver: ReturnType<typeof createPoseModeResolver>,
  gestures: (string | null)[],
  startT = 0,
  score = 0.9,
): (ViewMode | null)[] {
  return gestures.map((gesture, i) => resolver.push({ t: startT + i * 66, gesture, score: gesture ? score : 0 }))
}

const OPTS = { windowMs: 600, minSamples: 5, minRatio: 0.7, dwellMs: 1500, minScore: 0.5 }

describe('gestureToMode', () => {
  it('주먹 → calendar, 손바닥 → roster, 그 외 → null', () => {
    expect(gestureToMode(FIST_GESTURE)).toBe('calendar')
    expect(gestureToMode(OPEN_PALM_GESTURE)).toBe('roster')
    expect(gestureToMode('Thumb_Up')).toBeNull()
    expect(gestureToMode('None')).toBeNull()
    expect(gestureToMode(null)).toBeNull()
  })
})

describe('createPoseModeResolver (다수결 창)', () => {
  it('손바닥을 안정적으로 보이면 minSamples 도달 시점에 roster로 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const results = feed(resolver, Array(6).fill(OPEN_PALM_GESTURE))
    expect(results).toEqual([null, null, null, null, 'roster', null])
    expect(resolver.current()).toBe('roster')
  })

  it('프레임 일부가 빠져도(손 미인식/None 섞임) 비율이 70% 이상이면 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    // 10개 중 3개 누락 → 70%
    const seq = [OPEN_PALM_GESTURE, null, OPEN_PALM_GESTURE, OPEN_PALM_GESTURE, 'None', OPEN_PALM_GESTURE, OPEN_PALM_GESTURE, null, OPEN_PALM_GESTURE, OPEN_PALM_GESTURE]
    const results = feed(resolver, seq)
    expect(results.filter(Boolean)).toEqual(['roster'])
  })

  it('누락이 너무 많으면(비율 미달) 전환되지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const seq = [OPEN_PALM_GESTURE, null, null, OPEN_PALM_GESTURE, null, null, OPEN_PALM_GESTURE, null, null]
    const results = feed(resolver, seq)
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('calendar')
  })

  it('주먹/손바닥이 번갈아 나오는 오분류 상황에서는 전환하지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const seq = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? OPEN_PALM_GESTURE : FIST_GESTURE))
    const results = feed(resolver, seq)
    expect(results.every((r) => r === null)).toBe(true)
  })

  it('전환 직후 dwellMs 동안은 반대 자세가 와도 재전환하지 않고, 이후에는 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const first = feed(resolver, Array(5).fill(OPEN_PALM_GESTURE), 0)
    expect(first[4]).toBe('roster')
    const switchedAt = 4 * 66
    // dwell 안 (1.5초 미만): 주먹을 확실히 보여도 무시
    const during = feed(resolver, Array(10).fill(FIST_GESTURE), switchedAt + 100)
    expect(during.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('roster')
    // dwell 이후: 창이 새로 채워지면 전환
    const after = feed(resolver, Array(8).fill(FIST_GESTURE), switchedAt + 1600)
    expect(after.filter(Boolean)).toEqual(['calendar'])
  })

  it('같은 자세를 계속 유지해도 한 번만 전환 이벤트를 낸다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const results = feed(resolver, Array(60).fill(OPEN_PALM_GESTURE))
    expect(results.filter(Boolean)).toEqual(['roster'])
  })

  it('신뢰도가 낮은 샘플은 무효표로 처리된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const samples: GestureSample[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 66, gesture: OPEN_PALM_GESTURE, score: 0.4 }))
    const results = samples.map((s) => resolver.push(s))
    expect(results.every((r) => r === null)).toBe(true)
  })

  it('인식 대상이 아닌 자세(Thumb_Up 등)는 현재 모드를 유지한다', () => {
    const resolver = createPoseModeResolver('roster', OPTS)
    const results = feed(resolver, Array(10).fill('Thumb_Up'))
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('roster')
  })

  it('pending()은 현재 모드와 다른 우세 후보와 비율을 돌려준다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    feed(resolver, [OPEN_PALM_GESTURE, OPEN_PALM_GESTURE, null])
    expect(resolver.pending()).toEqual({ mode: 'roster', ratio: 2 / 3 })
    const same = createPoseModeResolver('roster', OPTS)
    feed(same, [OPEN_PALM_GESTURE, OPEN_PALM_GESTURE])
    expect(same.pending()).toBeNull()
  })

  it('setCurrent로 외부 변경을 동기화하면 창이 비워지고 같은 자세로는 전환되지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    feed(resolver, Array(3).fill(OPEN_PALM_GESTURE))
    resolver.setCurrent('roster')
    const results = feed(resolver, Array(10).fill(OPEN_PALM_GESTURE), 3 * 66)
    expect(results.every((r) => r === null)).toBe(true)
    const back = feed(resolver, Array(6).fill(FIST_GESTURE), 2000)
    expect(back.filter(Boolean)).toEqual(['calendar'])
  })
})
