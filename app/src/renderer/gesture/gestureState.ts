import { gestureToMode, type ViewMode } from './handPoseMode'

export type GestureStatus = 'starting' | 'ready' | 'error'

/** 설정 모달의 테스트용 미리보기에 전달되는 인식기 상태 */
export interface HandGestureState {
  status: GestureStatus
  errorMessage: string | null
  /** 미리보기용 웹캠 스트림 (설정 모달 <video>에 srcObject로 붙임) */
  stream: MediaStream | null
  /** 실제로 잡힌 캡처 모드 (ideal 요청과 다를 수 있음 — 설정 모달에 표시) */
  capture: { width: number; height: number; frameRate: number | null } | null
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
  capture: null,
  handVisible: false,
  gesture: null,
  pendingMode: null,
}

export function describeGestureState(state: HandGestureState): string {
  if (state.status === 'starting') return '카메라 준비 중…'
  if (state.status === 'error') return state.errorMessage ?? '오류'
  if (state.pendingMode) {
    return state.pendingMode === 'roster' ? '🖐 손바닥 인식 중 → 근무표' : '✊ 주먹 인식 중 → 캘린더'
  }
  const detectedMode = gestureToMode(state.gesture)
  if (detectedMode) return detectedMode === 'roster' ? '🖐 손바닥 → 근무표' : '✊ 주먹 → 캘린더'
  if (state.handVisible) return '손 감지됨 — ✊ 주먹 = 캘린더 · 🖐 손바닥 = 근무표'
  return '손을 카메라에 보여주세요'
}

/** 설정 모달 미리보기 하단에 표시할 캡처 모드 문자열 (예: "1280×720 · 30fps") */
export function describeCaptureMode(state: HandGestureState): string | null {
  if (!state.capture) return null
  const { width, height, frameRate } = state.capture
  const fps = frameRate ? ` · ${Math.round(frameRate)}fps` : ''
  return `${width}×${height}${fps}`
}
