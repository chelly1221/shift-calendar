import { gestureToMode, type ViewMode } from './handPoseMode'

export type GestureStatus = 'starting' | 'ready' | 'error'

/** 설정 모달의 테스트용 미리보기에 전달되는 인식기 상태 */
export interface HandGestureState {
  status: GestureStatus
  errorMessage: string | null
  /** 미리보기용 웹캠 스트림 (설정 모달 <video>에 srcObject로 붙임) */
  stream: MediaStream | null
  handVisible: boolean
  /** MediaPipe categoryName (None/손 없음이면 null) */
  gesture: string | null
  /** 유지 판정 중인 후보 모드 */
  pendingMode: ViewMode | null
}

export const INITIAL_HAND_GESTURE_STATE: HandGestureState = {
  status: 'starting',
  errorMessage: null,
  stream: null,
  handVisible: false,
  gesture: null,
  pendingMode: null,
}

export function describeGestureState(state: HandGestureState): string {
  if (state.status === 'starting') return '카메라 준비 중…'
  if (state.status === 'error') return state.errorMessage ?? '오류'
  if (state.pendingMode) {
    return state.pendingMode === 'roster' ? '🖐 손바닥 유지 중 → 근무표' : '✊ 주먹 유지 중 → 캘린더'
  }
  const detectedMode = gestureToMode(state.gesture)
  if (detectedMode) return detectedMode === 'roster' ? '🖐 손바닥 → 근무표' : '✊ 주먹 → 캘린더'
  if (state.handVisible) return '손 감지됨 — ✊ 주먹 = 캘린더 · 🖐 손바닥 = 근무표'
  return '손을 카메라에 보여주세요'
}
