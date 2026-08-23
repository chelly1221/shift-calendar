/**
 * 손 자세(주먹 / 손바닥) → 화면 모드 결정 로직.
 *
 * MediaPipe GestureRecognizer의 내장 분류(Closed_Fist, Open_Palm 등)를 입력으로 받아
 * 최근 일정 시간 창(window) 안 샘플의 다수결로 모드를 정합니다.
 * - 손이 작거나 멀어서 프레임마다 인식이 빠지거나 분류가 흔들려도 창 안의 비율로 판단하므로 버팁니다.
 * - 전환 직후에는 dwellMs 동안 재전환을 막아 주먹↔손바닥 오분류로 화면이 깜빡이는 것을 차단합니다.
 * 순수 로직만 담아 Vitest로 바로 검증합니다.
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
  /** 이 신뢰도 미만은 "자세 없음"으로 취급 (기본 0.5) */
  minScore: number
  /** 다수결을 계산할 최근 샘플 창 길이 ms (기본 600) */
  windowMs: number
  /** 창 안에 최소 이만큼 샘플이 있어야 판정 (기본 5) */
  minSamples: number
  /** 창 안 샘플 중 후보 자세 비율이 이 값 이상이면 전환 (기본 0.7) */
  minRatio: number
  /** 전환 후 이 시간(ms) 동안은 재전환 금지 (기본 1500) */
  dwellMs: number
}

export const DEFAULT_POSE_MODE_OPTIONS: PoseModeResolverOptions = {
  minScore: 0.5,
  windowMs: 600,
  minSamples: 5,
  minRatio: 0.7,
  dwellMs: 1500,
}

export interface PoseModeResolver {
  /**
   * 새 샘플을 넣습니다. 모드가 바뀌어야 하면 새 모드를, 아니면 null을 반환합니다.
   * 손이 없거나 인식 불가 자세는 창 안에서 "무효표"로만 작용합니다 (현재 모드 유지).
   */
  push(sample: GestureSample): ViewMode | null
  /** 현재 확정된 모드 */
  current(): ViewMode
  /** 외부(Esc 등)에서 모드를 바꿨을 때 동기화 */
  setCurrent(mode: ViewMode): void
  /** 현재 창 안에서 우세한 후보 자세와 비율 (UI 표시용). 현재 모드와 같거나 표가 없으면 null */
  pending(): { mode: ViewMode; ratio: number } | null
}

export function gestureToMode(gesture: string | null): ViewMode | null {
  if (gesture === FIST_GESTURE) return 'calendar'
  if (gesture === OPEN_PALM_GESTURE) return 'roster'
  return null
}

interface WindowEntry {
  t: number
  mode: ViewMode | null
}

export function createPoseModeResolver(
  initial: ViewMode = 'calendar',
  overrides: Partial<PoseModeResolverOptions> = {},
): PoseModeResolver {
  const options: PoseModeResolverOptions = { ...DEFAULT_POSE_MODE_OPTIONS, ...overrides }
  let currentMode: ViewMode = initial
  let window: WindowEntry[] = []
  let lastSwitchAt = -Infinity

  const tally = () => {
    let calendar = 0
    let roster = 0
    for (const entry of window) {
      if (entry.mode === 'calendar') calendar += 1
      else if (entry.mode === 'roster') roster += 1
    }
    return { calendar, roster, total: window.length }
  }

  const leading = (): { mode: ViewMode; ratio: number } | null => {
    const { calendar, roster, total } = tally()
    if (total === 0) return null
    const mode: ViewMode | null = calendar > roster ? 'calendar' : roster > calendar ? 'roster' : null
    if (mode === null || mode === currentMode) return null
    const votes = mode === 'calendar' ? calendar : roster
    return { mode, ratio: votes / total }
  }

  return {
    push(sample) {
      const mode = sample.score >= options.minScore ? gestureToMode(sample.gesture) : null
      window.push({ t: sample.t, mode })
      const windowStart = sample.t - options.windowMs
      window = window.filter((entry) => entry.t >= windowStart)

      if (sample.t - lastSwitchAt < options.dwellMs) {
        return null
      }
      if (window.length < options.minSamples) {
        return null
      }
      const candidate = leading()
      if (!candidate || candidate.ratio < options.minRatio) {
        return null
      }
      currentMode = candidate.mode
      lastSwitchAt = sample.t
      window = []
      return candidate.mode
    },
    current() {
      return currentMode
    },
    setCurrent(mode) {
      if (mode !== currentMode) {
        currentMode = mode
        window = []
      }
    },
    pending() {
      return leading()
    },
  }
}
