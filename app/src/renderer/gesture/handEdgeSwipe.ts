/**
 * 손날(hand edge) 스와이프 감지 — MediaPipe HandLandmarker 결과를 받아
 * "손바닥이 카메라와 수직(손날)으로 선 상태에서 좌/우로 빠르게 이동"을 판별합니다.
 *
 * 순수 로직만 담아 Vitest에서 바로 테스트할 수 있도록 DOM/MediaPipe 의존성을 두지 않습니다.
 */

export interface Point3 {
  x: number
  y: number
  z: number
}

export type SwipeDirection = 'left' | 'right'

export interface HandPoseFeatures {
  /** 손바닥 법선의 카메라 축(z) 성분 절대값. 1에 가까우면 손바닥이 카메라를 향함, 0에 가까우면 손날. */
  palmNormalZ: number
  /** 손가락 펴짐 비율 (중지 끝~손목 / 중지 MCP~손목). 1.5 이상이면 펴진 손. */
  fingerExtension: number
}

// MediaPipe Hand landmark indices
const WRIST = 0
const INDEX_MCP = 5
const MIDDLE_MCP = 9
const MIDDLE_TIP = 12
const PINKY_MCP = 17

function sub(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function length(v: Point3): number {
  return Math.hypot(v.x, v.y, v.z)
}

/**
 * 월드 좌표(미터 단위, 카메라 정렬) 랜드마크 21개에서 손 자세 특징을 계산합니다.
 */
export function computeHandPoseFeatures(worldLandmarks: readonly Point3[]): HandPoseFeatures | null {
  if (worldLandmarks.length < 21) {
    return null
  }
  const wrist = worldLandmarks[WRIST]
  const indexMcp = worldLandmarks[INDEX_MCP]
  const middleMcp = worldLandmarks[MIDDLE_MCP]
  const middleTip = worldLandmarks[MIDDLE_TIP]
  const pinkyMcp = worldLandmarks[PINKY_MCP]

  const normal = cross(sub(indexMcp, wrist), sub(pinkyMcp, wrist))
  const normalLength = length(normal)
  const palmLength = length(sub(middleMcp, wrist))
  if (normalLength < 1e-9 || palmLength < 1e-9) {
    return null
  }

  return {
    palmNormalZ: Math.abs(normal.z) / normalLength,
    fingerExtension: length(sub(middleTip, wrist)) / palmLength,
  }
}

export interface EdgeOnThresholds {
  /** 이 값보다 작아야 손날로 판정 (기본 0.45) */
  maxPalmNormalZ: number
  /** 이 값보다 커야 펴진 손으로 판정 (기본 1.45) */
  minFingerExtension: number
}

export const DEFAULT_EDGE_ON_THRESHOLDS: EdgeOnThresholds = {
  maxPalmNormalZ: 0.45,
  minFingerExtension: 1.45,
}

export function isEdgeOnHand(
  features: HandPoseFeatures | null,
  thresholds: EdgeOnThresholds = DEFAULT_EDGE_ON_THRESHOLDS,
): boolean {
  if (!features) {
    return false
  }
  return features.palmNormalZ <= thresholds.maxPalmNormalZ && features.fingerExtension >= thresholds.minFingerExtension
}

export interface HandSample {
  /** 밀리초 타임스탬프 */
  t: number
  /** 손 중심의 정규화 x (0=영상 왼쪽, 1=영상 오른쪽) */
  x: number
  /** 손날 자세 여부 */
  edgeOn: boolean
}

export interface SwipeDetectorOptions {
  /** 스와이프로 인정할 최소 이동 거리(정규화 폭 기준, 기본 0.22) */
  minDistance: number
  /** 최소 소요 시간 ms (너무 빠른 지터 제외, 기본 80) */
  minDurationMs: number
  /** 최대 소요 시간 ms (이보다 느리면 스와이프 아님, 기본 650) */
  maxDurationMs: number
  /** 스와이프 후 재인식 대기 ms (기본 1000) */
  cooldownMs: number
  /**
   * 영상 좌표를 사용자 시점으로 뒤집을지 여부.
   * 일반 웹캠은 거울 반전 없이 들어오므로 사용자의 오른쪽 = 영상의 왼쪽(x 감소)입니다. 기본 true.
   */
  mirrored: boolean
}

export const DEFAULT_SWIPE_DETECTOR_OPTIONS: SwipeDetectorOptions = {
  minDistance: 0.22,
  minDurationMs: 80,
  maxDurationMs: 650,
  cooldownMs: 1000,
  mirrored: true,
}

export interface SwipeDetector {
  /** 새 샘플을 넣고, 스와이프가 완성되면 방향을 반환합니다. */
  push(sample: HandSample): SwipeDirection | null
  /** 손이 사라졌을 때 호출 — 누적 샘플을 버립니다 (쿨다운은 유지). */
  reset(): void
}

/**
 * 손 중심 x 좌표 샘플을 누적해 손날 스와이프를 감지합니다.
 *
 * 규칙:
 * - 손날이 아닌 샘플이 들어오면 누적을 초기화합니다 (손바닥을 보이며 움직이는 동작은 무시).
 * - 최근 maxDurationMs 안의 샘플 중 현재 샘플과의 |dx| 가 minDistance 이상이고
 *   경과 시간이 minDurationMs 이상이면 스와이프로 판정합니다.
 * - 판정 후 cooldownMs 동안은 새 스와이프를 받지 않습니다.
 */
export function createSwipeDetector(overrides: Partial<SwipeDetectorOptions> = {}): SwipeDetector {
  const options: SwipeDetectorOptions = { ...DEFAULT_SWIPE_DETECTOR_OPTIONS, ...overrides }
  let samples: HandSample[] = []
  let cooldownUntil = -Infinity

  const toUserDirection = (dx: number): SwipeDirection => {
    const movingRightInImage = dx > 0
    if (options.mirrored) {
      return movingRightInImage ? 'left' : 'right'
    }
    return movingRightInImage ? 'right' : 'left'
  }

  return {
    push(sample) {
      if (!sample.edgeOn) {
        samples = []
        return null
      }
      if (sample.t < cooldownUntil) {
        samples = []
        return null
      }

      samples.push(sample)
      const windowStart = sample.t - options.maxDurationMs
      samples = samples.filter((item) => item.t >= windowStart)

      for (const earlier of samples) {
        const elapsed = sample.t - earlier.t
        if (elapsed < options.minDurationMs) {
          break
        }
        const dx = sample.x - earlier.x
        if (Math.abs(dx) >= options.minDistance) {
          samples = []
          cooldownUntil = sample.t + options.cooldownMs
          return toUserDirection(dx)
        }
      }
      return null
    },
    reset() {
      samples = []
    },
  }
}

/** 손바닥 영역 랜드마크(손목·MCP 4개)의 정규화 x 평균 — 손가락 흔들림에 덜 민감한 중심점입니다. */
export function computePalmCenterX(landmarks: readonly Point3[]): number | null {
  if (landmarks.length < 21) {
    return null
  }
  const indices = [WRIST, INDEX_MCP, MIDDLE_MCP, 13, PINKY_MCP]
  let sum = 0
  for (const index of indices) {
    sum += landmarks[index].x
  }
  return sum / indices.length
}
