/**
 * 손 자세(주먹 / 손바닥) → 화면 모드 결정 로직.
 *
 * MediaPipe GestureRecognizer의 내장 분류(Closed_Fist, Open_Palm 등)를 입력으로 받아
 * 최근 **유효표**(주먹/손바닥으로 분류된 샘플) 몇 개의 다수결로 모드를 정합니다.
 * - 손이 없거나 None/기타 자세인 프레임은 표에 넣지 않습니다. 멀리 있는 손은 프레임 절반이 검출에서
 *   빠지기도 하는데, 그런 무효 프레임이 비율을 희석해 전환을 막지 않도록 합니다.
 * - 창은 시간이 아니라 표 개수 기준이라 카메라 fps(7.5~30)에 관계없이 같은 수의 표로 판정합니다.
 *   다만 maxAgeMs보다 오래된 표는 버려서 손을 내렸다가 다시 들었을 때 옛 표가 섞이지 않게 합니다.
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
  /** 다수결에 쓰는 최근 유효표 개수 (기본 6) */
  voteCount: number
  /** 후보 자세의 표가 최소 이만큼(절대 개수) 있어야 전환 (기본 3) — 표 2~3개로 성급히 넘어가지 않도록 */
  minVotes: number
  /** 창 안 유효표 중 후보 자세 비율이 이 값 이상이면 전환 (기본 0.65 ≈ 6표 중 4표) */
  minRatio: number
  /** 이보다 오래된 표는 버림 ms (기본 1000) — 손을 내린 뒤 옛 표가 남지 않도록 */
  maxAgeMs: number
  /** 전환 후 이 시간(ms) 동안은 재전환 금지 (기본 500) */
  dwellMs: number
}

export const DEFAULT_POSE_MODE_OPTIONS: PoseModeResolverOptions = {
  minScore: 0.5,
  voteCount: 6,
  minVotes: 3,
  minRatio: 0.65,
  maxAgeMs: 1000,
  dwellMs: 500,
}

export interface PoseModeResolver {
  /**
   * 새 샘플을 넣습니다. 모드가 바뀌어야 하면 새 모드를, 아니면 null을 반환합니다.
   * 손이 없거나 인식 불가 자세는 표로 세지 않습니다 (현재 모드 유지).
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
  if (gesture === FIST_GESTURE) return 'roster'
  if (gesture === OPEN_PALM_GESTURE) return 'calendar'
  return null
}

interface Vote {
  t: number
  mode: ViewMode
}

export function createPoseModeResolver(
  initial: ViewMode = 'calendar',
  overrides: Partial<PoseModeResolverOptions> = {},
): PoseModeResolver {
  const options: PoseModeResolverOptions = { ...DEFAULT_POSE_MODE_OPTIONS, ...overrides }
  let currentMode: ViewMode = initial
  let votes: Vote[] = []
  let lastSwitchAt = -Infinity

  const tally = () => {
    let calendar = 0
    let roster = 0
    for (const vote of votes) {
      if (vote.mode === 'calendar') calendar += 1
      else roster += 1
    }
    return { calendar, roster, total: votes.length }
  }

  const leading = (): { mode: ViewMode; ratio: number; count: number } | null => {
    const { calendar, roster, total } = tally()
    if (total === 0) return null
    const mode: ViewMode | null = calendar > roster ? 'calendar' : roster > calendar ? 'roster' : null
    if (mode === null || mode === currentMode) return null
    const count = mode === 'calendar' ? calendar : roster
    return { mode, ratio: count / total, count }
  }

  const expire = (now: number) => {
    const oldest = now - options.maxAgeMs
    if (votes.length > 0 && votes[0].t < oldest) {
      votes = votes.filter((vote) => vote.t >= oldest)
    }
  }

  return {
    push(sample) {
      expire(sample.t)
      const mode = sample.score >= options.minScore ? gestureToMode(sample.gesture) : null
      if (mode !== null) {
        votes.push({ t: sample.t, mode })
        if (votes.length > options.voteCount) {
          votes = votes.slice(votes.length - options.voteCount)
        }
      }

      if (sample.t - lastSwitchAt < options.dwellMs) {
        return null
      }
      const candidate = leading()
      if (!candidate || candidate.count < options.minVotes || candidate.ratio < options.minRatio) {
        return null
      }
      currentMode = candidate.mode
      lastSwitchAt = sample.t
      votes = []
      return candidate.mode
    },
    current() {
      return currentMode
    },
    setCurrent(mode) {
      if (mode !== currentMode) {
        currentMode = mode
        votes = []
      }
    },
    pending() {
      const candidate = leading()
      return candidate ? { mode: candidate.mode, ratio: candidate.ratio } : null
    },
  }
}
