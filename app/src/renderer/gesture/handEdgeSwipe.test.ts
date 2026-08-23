import { describe, expect, it } from 'vitest'
import {
  computeHandPoseFeatures,
  computePalmCenterX,
  createSwipeDetector,
  isEdgeOnHand,
  type Point3,
} from './handEdgeSwipe'

/**
 * 단순화한 손 모델을 만듭니다.
 * - 손목은 원점, 중지 MCP는 손목에서 "up" 방향으로 0.08m, 중지 끝은 0.17m
 * - 검지 MCP / 새끼 MCP는 중지 MCP 기준 "side" 방향으로 ±0.035m
 */
function buildHand(up: Point3, side: Point3, extension = 1): Point3[] {
  const scale = (v: Point3, s: number): Point3 => ({ x: v.x * s, y: v.y * s, z: v.z * s })
  const add = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
  const wrist: Point3 = { x: 0, y: 0, z: 0 }
  const middleMcp = scale(up, 0.08)
  const middleTip = scale(up, 0.08 + 0.09 * extension)
  const indexMcp = add(middleMcp, scale(side, 0.035))
  const pinkyMcp = add(middleMcp, scale(side, -0.035))
  const ringMcp = add(middleMcp, scale(side, -0.012))

  const points: Point3[] = Array.from({ length: 21 }, () => ({ ...wrist }))
  points[0] = wrist
  points[5] = indexMcp
  points[9] = middleMcp
  points[12] = middleTip
  points[13] = ringMcp
  points[17] = pinkyMcp
  return points
}

const UP: Point3 = { x: 0, y: -1, z: 0 }

describe('computeHandPoseFeatures / isEdgeOnHand', () => {
  it('손바닥이 카메라를 향하면 손날로 판정하지 않는다', () => {
    // 손가락 위, 검지→새끼 방향이 x축 → 법선은 z축
    const hand = buildHand(UP, { x: 1, y: 0, z: 0 })
    const features = computeHandPoseFeatures(hand)
    expect(features).not.toBeNull()
    expect(features!.palmNormalZ).toBeGreaterThan(0.9)
    expect(isEdgeOnHand(features)).toBe(false)
  })

  it('손날(검지→새끼 방향이 카메라 축)이면 손날로 판정한다', () => {
    const hand = buildHand(UP, { x: 0, y: 0, z: 1 })
    const features = computeHandPoseFeatures(hand)
    expect(features).not.toBeNull()
    expect(features!.palmNormalZ).toBeLessThan(0.1)
    expect(features!.fingerExtension).toBeGreaterThan(1.45)
    expect(isEdgeOnHand(features)).toBe(true)
  })

  it('손날이어도 주먹(손가락 접힘)이면 손날로 판정하지 않는다', () => {
    const hand = buildHand(UP, { x: 0, y: 0, z: 1 }, 0.2)
    const features = computeHandPoseFeatures(hand)
    expect(features!.fingerExtension).toBeLessThan(1.45)
    expect(isEdgeOnHand(features)).toBe(false)
  })

  it('비스듬한 손(45도)은 기본 임계값에서 손날로 보지 않는다', () => {
    const s = Math.SQRT1_2
    const hand = buildHand(UP, { x: s, y: 0, z: s })
    const features = computeHandPoseFeatures(hand)
    expect(features!.palmNormalZ).toBeCloseTo(s, 3)
    expect(isEdgeOnHand(features)).toBe(false)
  })

  it('랜드마크가 부족하면 null', () => {
    expect(computeHandPoseFeatures([])).toBeNull()
    expect(isEdgeOnHand(null)).toBe(false)
    expect(computePalmCenterX([])).toBeNull()
  })

  it('computePalmCenterX는 손바닥 랜드마크 x 평균을 돌려준다', () => {
    // 손바닥 랜드마크(0,5,9,13,17)의 x 평균: (0 + 0.035 + 0 - 0.012 - 0.035) / 5 = -0.0024
    const hand = buildHand(UP, { x: 1, y: 0, z: 0 })
    const shifted = hand.map((p) => ({ ...p, x: p.x + 0.5 }))
    expect(computePalmCenterX(shifted)).toBeCloseTo(0.5 - 0.0024, 5)
  })
})

describe('createSwipeDetector', () => {
  it('손날 상태로 영상 기준 왼쪽으로 빠르게 이동하면 (미러 기준) 오른쪽 스와이프', () => {
    const detector = createSwipeDetector()
    const xs = [0.8, 0.72, 0.64, 0.56, 0.5]
    const results = xs.map((x, i) => detector.push({ t: i * 60, x, edgeOn: true }))
    // 0.8 → 0.56 (t=180)에서 처음으로 0.22 이상 이동 → 그 시점에 즉시 판정, 이후 쿨다운으로 null
    expect(results).toEqual([null, null, null, 'right', null])
  })

  it('영상 기준 오른쪽 이동은 왼쪽 스와이프, mirrored=false면 반대', () => {
    const mirrored = createSwipeDetector()
    const raw = createSwipeDetector({ mirrored: false })
    const xs = [0.2, 0.3, 0.4, 0.5]
    let m: string | null = null
    let r: string | null = null
    xs.forEach((x, i) => {
      m = mirrored.push({ t: i * 60, x, edgeOn: true }) ?? m
      r = raw.push({ t: i * 60, x, edgeOn: true }) ?? r
    })
    expect(m).toBe('left')
    expect(r).toBe('right')
  })

  it('손날이 아닌 샘플이 섞이면 누적이 초기화되어 스와이프가 아니다', () => {
    const detector = createSwipeDetector()
    expect(detector.push({ t: 0, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 60, x: 0.7, edgeOn: false })).toBeNull()
    expect(detector.push({ t: 120, x: 0.6, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 180, x: 0.5, edgeOn: true })).toBeNull()
  })

  it('너무 느린 이동(maxDurationMs 초과)은 스와이프가 아니다', () => {
    const detector = createSwipeDetector({ maxDurationMs: 300 })
    expect(detector.push({ t: 0, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 200, x: 0.7, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 400, x: 0.6, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 600, x: 0.5, edgeOn: true })).toBeNull()
  })

  it('너무 짧은 시간의 큰 점프(minDurationMs 미만)는 지터로 무시한다', () => {
    const detector = createSwipeDetector({ minDurationMs: 100 })
    expect(detector.push({ t: 0, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 30, x: 0.4, edgeOn: true })).toBeNull()
  })

  it('스와이프 직후 쿨다운 동안은 재인식하지 않고, 쿨다운 후에는 다시 인식한다', () => {
    const detector = createSwipeDetector({ cooldownMs: 500 })
    expect(detector.push({ t: 0, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 120, x: 0.5, edgeOn: true })).toBe('right')
    // 쿨다운 내 반대 방향 이동
    expect(detector.push({ t: 200, x: 0.5, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 320, x: 0.8, edgeOn: true })).toBeNull()
    // 쿨다운 종료 후
    expect(detector.push({ t: 700, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 820, x: 0.5, edgeOn: true })).toBe('right')
  })

  it('reset()은 누적 샘플만 버리고 쿨다운은 유지한다', () => {
    const detector = createSwipeDetector({ cooldownMs: 500 })
    detector.push({ t: 0, x: 0.8, edgeOn: true })
    expect(detector.push({ t: 120, x: 0.5, edgeOn: true })).toBe('right')
    detector.reset()
    expect(detector.push({ t: 200, x: 0.8, edgeOn: true })).toBeNull()
    expect(detector.push({ t: 320, x: 0.5, edgeOn: true })).toBeNull()
  })
})
