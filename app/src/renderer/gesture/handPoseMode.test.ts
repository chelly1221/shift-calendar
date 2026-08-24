import { describe, expect, it } from 'vitest'
import {
  createPoseModeResolver,
  gestureToMode,
  DEFAULT_POSE_MODE_OPTIONS,
  OPEN_PALM_GESTURE,
  FIST_GESTURE,
  type GestureSample,
  type ViewMode,
} from './handPoseMode'

/** 지정 간격(기본 15fps=66ms) 샘플 시퀀스를 넣고 전환 이벤트를 모읍니다. */
function feed(
  resolver: ReturnType<typeof createPoseModeResolver>,
  gestures: (string | null)[],
  startT = 0,
  score = 0.9,
  intervalMs = 66,
): (ViewMode | null)[] {
  return gestures.map((gesture, i) => resolver.push({ t: startT + i * intervalMs, gesture, score: gesture ? score : 0 }))
}

const OPTS = { voteCount: 6, minVotes: 3, minRatio: 0.65, maxAgeMs: 1000, dwellMs: 500, minScore: 0.5 }

describe('gestureToMode', () => {
  it('손바닥 → calendar, 주먹 → roster, 그 외 → null', () => {
    expect(gestureToMode(OPEN_PALM_GESTURE)).toBe('calendar')
    expect(gestureToMode(FIST_GESTURE)).toBe('roster')
    expect(gestureToMode('Thumb_Up')).toBeNull()
    expect(gestureToMode('None')).toBeNull()
    expect(gestureToMode(null)).toBeNull()
  })
})

describe('createPoseModeResolver (기본 옵션: 반응성)', () => {
  it('기본 옵션은 20fps 기준 약 0.15초 안에 전환되고 0.5초 dwell을 가진다', () => {
    expect(DEFAULT_POSE_MODE_OPTIONS.dwellMs).toBe(500)
    const resolver = createPoseModeResolver('calendar')
    const results = Array.from({ length: 8 }, (_, i) =>
      resolver.push({ t: i * 50, gesture: FIST_GESTURE, score: 0.9 }),
    )
    const switchedIndex = results.findIndex((r) => r === 'roster')
    expect(switchedIndex).toBeGreaterThanOrEqual(0)
    expect(switchedIndex * 50).toBeLessThanOrEqual(200)
    // dwell 안에서는 손바닥이 와도 무시, 0.5초 뒤에는 전환
    const t0 = switchedIndex * 50
    const during = Array.from({ length: 8 }, (_, i) =>
      resolver.push({ t: t0 + 50 + i * 50, gesture: OPEN_PALM_GESTURE, score: 0.9 }),
    )
    expect(during.every((r) => r === null)).toBe(true)
    const after = Array.from({ length: 8 }, (_, i) =>
      resolver.push({ t: t0 + 600 + i * 50, gesture: OPEN_PALM_GESTURE, score: 0.9 }),
    )
    expect(after.filter(Boolean)).toEqual(['calendar'])
  })

  it('카메라가 7.5fps로 느려도(133ms 간격) 같은 표 수로 전환된다 — 창이 시간이 아닌 표 개수 기준', () => {
    const fast = createPoseModeResolver('calendar')
    const slow = createPoseModeResolver('calendar')
    const fastResults = feed(fast, Array(10).fill(FIST_GESTURE), 0, 0.9, 50)
    const slowResults = feed(slow, Array(10).fill(FIST_GESTURE), 0, 0.9, 133)
    expect(fastResults.findIndex((r) => r === 'roster')).toBe(slowResults.findIndex((r) => r === 'roster'))
    expect(slow.current()).toBe('roster')
  })

  it('자세를 바꾸면 직전 자세의 표가 창에 가득 차 있어도 6표 중 4표(0.2초)면 전환된다', () => {
    const resolver = createPoseModeResolver('roster')
    // 주먹을 한참 유지(창이 roster 표로 가득) → 손바닥으로 전환
    feed(resolver, Array(20).fill(FIST_GESTURE), 0, 0.9, 50)
    const results = feed(resolver, Array(8).fill(OPEN_PALM_GESTURE), 1000, 0.9, 50)
    const switchedIndex = results.findIndex((r) => r === 'calendar')
    expect(switchedIndex).toBe(3)
  })
})

describe('createPoseModeResolver (유효표 다수결)', () => {
  it('주먹을 안정적으로 보이면 minVotes 도달 시점에 roster로 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const results = feed(resolver, Array(6).fill(FIST_GESTURE))
    expect(results).toEqual([null, null, 'roster', null, null, null])
    expect(resolver.current()).toBe('roster')
  })

  it('손이 멀어 프레임 절반이 검출에서 빠져도(null/None 섞임) 전환된다 — 무효 프레임은 표를 희석하지 않음', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const seq = [FIST_GESTURE, null, null, FIST_GESTURE, 'None', null, FIST_GESTURE, null, null]
    const results = feed(resolver, seq)
    expect(results.filter(Boolean)).toEqual(['roster'])
    expect(results.indexOf('roster')).toBe(6)
  })

  it('후보 자세의 표가 minVotes 미만이면 전환되지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const seq = [FIST_GESTURE, null, null, FIST_GESTURE, null, null, null, null]
    const results = feed(resolver, seq)
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('calendar')
  })

  it('표가 적을 때 2:1 같은 근소한 우세로는 전환하지 않는다 (절대 개수 조건)', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const results = feed(resolver, [FIST_GESTURE, OPEN_PALM_GESTURE, FIST_GESTURE])
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.pending()).toEqual({ mode: 'roster', ratio: 2 / 3 })
  })

  it('오래된 표(maxAgeMs 초과)는 버려져서 손을 내렸다가 다시 들면 새로 센다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    feed(resolver, [FIST_GESTURE, FIST_GESTURE], 0)
    // 1.5초 동안 손 없음
    const gap = feed(resolver, Array(5).fill(null), 500, 0.9, 100)
    expect(gap.every((r) => r === null)).toBe(true)
    // 다시 들었을 때 첫 표 하나로는 전환되지 않아야 함 (옛 2표가 남아 있었다면 3표가 되어 전환됨)
    const back = resolver.push({ t: 1600, gesture: FIST_GESTURE, score: 0.9 })
    expect(back).toBeNull()
    expect(resolver.pending()).toEqual({ mode: 'roster', ratio: 1 })
  })

  it('손바닥/주먹이 번갈아 나오는 오분류 상황에서는 전환하지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const seq = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? FIST_GESTURE : OPEN_PALM_GESTURE))
    const results = feed(resolver, seq)
    expect(results.every((r) => r === null)).toBe(true)
  })

  it('주먹 유지 중 가끔 손바닥으로 오분류되어도 전환하지 않는다', () => {
    const resolver = createPoseModeResolver('roster', OPTS)
    const seq = Array.from({ length: 30 }, (_, i) => (i % 4 === 3 ? OPEN_PALM_GESTURE : FIST_GESTURE))
    const results = feed(resolver, seq)
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('roster')
  })

  it('전환 직후 dwellMs 동안은 반대 자세가 와도 재전환하지 않고, 이후에는 전환된다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const first = feed(resolver, Array(3).fill(FIST_GESTURE), 0)
    expect(first[2]).toBe('roster')
    const switchedAt = 2 * 66
    // dwell 안 (0.5초 미만): 손바닥을 확실히 보여도 무시
    const during = feed(resolver, Array(5).fill(OPEN_PALM_GESTURE), switchedAt + 50)
    expect(during.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('roster')
    // dwell 이후: 창이 새로 채워지면 전환
    const after = feed(resolver, Array(8).fill(OPEN_PALM_GESTURE), switchedAt + 600)
    expect(after.filter(Boolean)).toEqual(['calendar'])
  })

  it('같은 자세를 계속 유지해도 한 번만 전환 이벤트를 낸다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const results = feed(resolver, Array(60).fill(FIST_GESTURE))
    expect(results.filter(Boolean)).toEqual(['roster'])
  })

  it('신뢰도가 낮은 샘플은 표로 세지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    const samples: GestureSample[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 66, gesture: FIST_GESTURE, score: 0.4 }))
    const results = samples.map((s) => resolver.push(s))
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.pending()).toBeNull()
  })

  it('인식 대상이 아닌 자세(Thumb_Up 등)는 현재 모드를 유지한다', () => {
    const resolver = createPoseModeResolver('roster', OPTS)
    const results = feed(resolver, Array(10).fill('Thumb_Up'))
    expect(results.every((r) => r === null)).toBe(true)
    expect(resolver.current()).toBe('roster')
  })

  it('pending()은 현재 모드와 다른 우세 후보와 유효표 기준 비율을 돌려준다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    feed(resolver, [FIST_GESTURE, null, FIST_GESTURE, OPEN_PALM_GESTURE, null])
    expect(resolver.pending()).toEqual({ mode: 'roster', ratio: 2 / 3 })
    const same = createPoseModeResolver('roster', OPTS)
    feed(same, [FIST_GESTURE, FIST_GESTURE])
    expect(same.pending()).toBeNull()
  })

  it('setCurrent로 외부 변경을 동기화하면 창이 비워지고 같은 자세로는 전환되지 않는다', () => {
    const resolver = createPoseModeResolver('calendar', OPTS)
    feed(resolver, Array(2).fill(FIST_GESTURE))
    resolver.setCurrent('roster')
    const results = feed(resolver, Array(10).fill(FIST_GESTURE), 2 * 66)
    expect(results.every((r) => r === null)).toBe(true)
    const back = feed(resolver, Array(6).fill(OPEN_PALM_GESTURE), 2000)
    expect(back.filter(Boolean)).toEqual(['calendar'])
  })
})
