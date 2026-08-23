/**
 * 손 자세(주먹 / 손바닥) → 화면 모드 결정 로직.
 *
 * MediaPipe GestureRecognizer의 내장 분류(Closed_Fist, Open_Palm 등)를 입력으로 받아
 * "같은 자세가 일정 시간 유지될 때만" 모드를 바꿉니다. 순수 로직만 담아 Vitest로 바로 검증합니다.
 */

export type ViewMode = 'calendar' | 'roster'

/** MediaPipe canned gesture 이름 중 이 앱이 쓰는 두 가지 */
export const FIST_GESTURE = 'Closed_Fist'
export const OPEN_PALM_GESTURE = 'Open_Palm'

export interface GestureSample {
  /** 밀리초 타임스탬프 */
  t: number
  /** MediaPipe categoryName (손이 없으면 null) */
  gesture: string | null
  /** 분류 신뢰도 0~1 */
  score: number
}

export interface PoseModeResolverOptions {
  /** 이 신뢰도 미만은 무시 (기본 0.6) */
  minScore: number
  /** 같은 자세가 이 시간(ms) 이상 유지되어야 전환 (기본 400) */
  holdMs: number
}

export const DEFAULT_POSE_MODE_OPTIONS: PoseModeResolverOptions = {
  minScore: 0.6,
  holdMs: 400,
}

export interface PoseModeResolver {
  /**
   * 새 샘플을 넣습니다. 모드가 바뀌어야 하면 새 모드를, 아니면 null을 반환합니다.
   * 손이 없거나 인식 불가 자세는 "현재 모드 유지"이며 누적만 초기화합니다.
   */
  push(sample: GestureSample): ViewMode | null
  /** 현재 확정된 모드 */
  current(): ViewMode
  /** 외부(버튼 등)에서 모드를 바꿨을 때 동기화 */
  setCurrent(mode: ViewMode): void
  /** 현재 누적 중인 후보 자세 (UI 표시용) */
  pending(): { mode: ViewMode; heldMs: number } | null
}

export function gestureToMode(gesture: string | null): ViewMode | null {
  if (gesture === FIST_GESTURE) return 'calendar'
  if (gesture === OPEN_PALM_GESTURE) return 'roster'
  return null
}

export function createPoseModeResolver(
  initial: ViewMode = 'calendar',
  overrides: Partial<PoseModeResolverOptions> = {},
): PoseModeResolver {
  const options: PoseModeResolverOptions = { ...DEFAULT_POSE_MODE_OPTIONS, ...overrides }
  let currentMode: ViewMode = initial
  let candidate: ViewMode | null = null
  let candidateSince = 0
  let lastSampleAt = 0

  return {
    push(sample) {
      lastSampleAt = sample.t
      const mode = sample.score >= options.minScore ? gestureToMode(sample.gesture) : null
      if (mode === null || mode === currentMode) {
        candidate = null
        return null
      }
      if (candidate !== mode) {
        candidate = mode
        candidateSince = sample.t
        return null
      }
      if (sample.t - candidateSince >= options.holdMs) {
        currentMode = mode
        candidate = null
        return mode
      }
      return null
    },
    current() {
      return currentMode
    },
    setCurrent(mode) {
      currentMode = mode
      candidate = null
    },
    pending() {
      if (candidate === null) return null
      return { mode: candidate, heldMs: Math.max(0, lastSampleAt - candidateSince) }
    },
  }
}
