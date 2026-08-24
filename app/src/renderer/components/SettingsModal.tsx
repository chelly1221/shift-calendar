import { useCallback, useEffect, useRef } from 'react'
import type { DayWorkerCount, ShiftTeamMode, ShiftType } from '../../shared/calendar'
import type { WeatherOverlayMode } from './WeatherOverlay'
import { describeCaptureMode, describeGestureState, type HandGestureState } from '../gesture/gestureState'
import { gestureToMode } from '../gesture/handPoseMode'

interface SettingsModalProps {
  open: boolean
  shiftType: ShiftType
  shiftTeamMode: ShiftTeamMode
  dayWorkerCount: DayWorkerCount
  weatherPreviewMode: WeatherOverlayMode | null
  savingShiftSettings: boolean
  onClose: () => void
  onSetShiftType: (shiftType: ShiftType) => Promise<void>
  onSetShiftTeamMode: (shiftTeamMode: ShiftTeamMode) => Promise<void>
  onSetDayWorkerCount: (dayWorkerCount: DayWorkerCount) => Promise<void>
  onSetWeatherPreviewMode: (mode: WeatherOverlayMode | null) => void
  handGestureEnabled: boolean
  onSetHandGestureEnabled: (enabled: boolean) => void
  handGestureState: HandGestureState
}

export function SettingsModal({
  open,
  shiftType,
  shiftTeamMode,
  dayWorkerCount,
  weatherPreviewMode,
  savingShiftSettings,
  onClose,
  onSetShiftType,
  onSetShiftTeamMode,
  onSetDayWorkerCount,
  onSetWeatherPreviewMode,
  handGestureEnabled,
  onSetHandGestureEnabled,
  handGestureState,
}: SettingsModalProps) {
  const previewRef = useRef<HTMLVideoElement | null>(null)

  // 인식기의 웹캠 스트림을 테스트용 미리보기에 붙입니다 (스트림은 두 video가 공유 가능).
  useEffect(() => {
    const video = previewRef.current
    if (!video) return
    const stream = open && handGestureEnabled ? handGestureState.stream : null
    if (video.srcObject !== stream) {
      video.srcObject = stream
      if (stream) {
        void video.play().catch(() => undefined)
      }
    }
  }, [open, handGestureEnabled, handGestureState.stream])

  const handleExportDatabase = useCallback(() => {
    void window.calendarApi.exportDatabase().catch((err) => {
      console.error('DB 내보내기 실패:', err)
    })
  }, [])

  const handleImportDatabase = useCallback(() => {
    if (!window.confirm('현재 데이터가 선택한 파일로 대체됩니다. 계속하시겠습니까?')) return
    void window.calendarApi.importDatabase().catch((err) => {
      console.error('DB 가져오기 실패:', err)
    })
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="settings-modal-title">설정</h2>
          <button type="button" className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </header>
        <div className="settings-content settings-content-two-col">
          <div className="settings-column">
          <section className="settings-section">
            <label className="calendar-target-control settings-calendar-control" htmlFor="settings-shift-type-select">
              <span>교대근무 타입</span>
              <select
                id="settings-shift-type-select"
                value={shiftType}
                onChange={(event) => {
                  const nextType = event.target.value as ShiftType
                  void onSetShiftType(nextType).catch((err) => { console.error('설정 저장 실패:', err) })
                }}
                disabled={savingShiftSettings}
              >
                <option value="DAY_NIGHT_OFF_OFF">주야비휴</option>
              </select>
            </label>
            <p className="settings-hint">현재 선택: 주야비휴</p>

            <label className="calendar-target-control settings-calendar-control" htmlFor="settings-shift-team-mode-select">
              <span>조 편성 방식</span>
              <select
                id="settings-shift-team-mode-select"
                value={shiftTeamMode}
                onChange={(event) => {
                  const nextMode = event.target.value as ShiftTeamMode
                  if (nextMode === 'SINGLE' && shiftTeamMode === 'PAIR') {
                    if (!window.confirm('SINGLE 모드로 전환하면 각 팀의 두 번째 팀원이 제거됩니다. 계속하시겠습니까?')) {
                      return
                    }
                  }
                  void onSetShiftTeamMode(nextMode).catch((err) => { console.error('설정 저장 실패:', err) })
                }}
                disabled={savingShiftSettings}
              >
                <option value="SINGLE">1인 1조</option>
                <option value="PAIR">2인 1조</option>
              </select>
            </label>
            <p className="settings-hint">
              {shiftTeamMode === 'SINGLE' ? '각 조는 조장 1명만 지정합니다.' : '각 조는 조장/조원 2명까지 지정합니다.'}
            </p>

            <label className="calendar-target-control settings-calendar-control" htmlFor="settings-day-worker-count-select">
              <span>일근자 명수</span>
              <select
                id="settings-day-worker-count-select"
                value={dayWorkerCount}
                onChange={(event) => {
                  const nextCount = Number(event.target.value) as DayWorkerCount
                  void onSetDayWorkerCount(nextCount).catch((err) => { console.error('설정 저장 실패:', err) })
                }}
                disabled={savingShiftSettings}
              >
                <option value={1}>1명</option>
                <option value={2}>2명</option>
                <option value={3}>3명</option>
                <option value={4}>4명</option>
                <option value={5}>5명</option>
              </select>
            </label>
            <p className="settings-hint">일근자 입력 칸 개수를 지정합니다.</p>
          </section>

          <section className="settings-section">
            <div className="settings-row">
              <p className="settings-label">날씨 이펙트 테스트</p>
              <p className="settings-value">
                {weatherPreviewMode === null
                  ? '실시간(김포공항)'
                  : weatherPreviewMode === 'rain'
                    ? '비 강제'
                    : '눈 강제'}
              </p>
            </div>
            <div className="settings-inline-actions" role="group" aria-label="날씨 효과 선택">
              <button
                type="button"
                className={weatherPreviewMode === null ? 'ghost-button is-active' : 'ghost-button'}
                onClick={() => onSetWeatherPreviewMode(null)}
              >
                실시간
              </button>
              <button
                type="button"
                className={weatherPreviewMode === 'rain' ? 'ghost-button is-active' : 'ghost-button'}
                onClick={() => onSetWeatherPreviewMode('rain')}
              >
                비
              </button>
              <button
                type="button"
                className={weatherPreviewMode === 'snow' ? 'ghost-button is-active' : 'ghost-button'}
                onClick={() => onSetWeatherPreviewMode('snow')}
              >
                눈
              </button>
            </div>
            <p className="settings-hint">실시간 모드는 김포공항 현재 날씨(강수/적설) 기준으로 자동 반영됩니다.</p>
          </section>

          <section className="settings-section">
            <p className="settings-label">데이터 관리</p>
            <div className="settings-inline-actions" role="group" aria-label="데이터 관리">
              <button
                type="button"
                className="ghost-button"
                onClick={handleExportDatabase}
              >
                내보내기
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={handleImportDatabase}
              >
                가져오기
              </button>
            </div>
            <p className="settings-hint">데이터베이스 파일을 내보내거나 가져올 수 있습니다. 가져오기 시 앱이 재시작됩니다.</p>
          </section>
          </div>

          <div className="settings-column">
          <section className="settings-section">
            <div className="settings-row">
              <p className="settings-label">손동작 인식 (웹캠)</p>
              <p className="settings-value">{handGestureEnabled ? '켜짐' : '꺼짐'}</p>
            </div>
            <div className="settings-inline-actions" role="group" aria-label="손동작 인식">
              <button
                type="button"
                className={handGestureEnabled ? 'ghost-button is-active' : 'ghost-button'}
                onClick={() => onSetHandGestureEnabled(true)}
              >
                켜기
              </button>
              <button
                type="button"
                className={!handGestureEnabled ? 'ghost-button is-active' : 'ghost-button'}
                onClick={() => onSetHandGestureEnabled(false)}
              >
                끄기
              </button>
            </div>
            <p className="settings-hint">
              🖐 손바닥을 펴면 2주 근무표, ✊ 주먹을 쥐면 캘린더로 돌아옵니다 (자세를 잠깐 유지하면 전환, 전환 후 0.5초간 재전환 없음).
              영상은 이 PC 안에서만 처리되며 저장·전송되지 않습니다.
            </p>
            {handGestureEnabled ? (
              <div
                className={`gesture-preview is-${handGestureState.status}${handGestureState.pendingMode ? ' is-pending' : ''}${gestureToMode(handGestureState.gesture) ? ' is-gesture' : ''}`}
              >
                <video ref={previewRef} className="gesture-preview-video" muted playsInline />
                <p className="gesture-preview-status">
                  {describeGestureState(handGestureState)}
                  {describeCaptureMode(handGestureState) ? (
                    <span className="gesture-preview-capture">{describeCaptureMode(handGestureState)}</span>
                  ) : null}
                </p>
              </div>
            ) : null}
          </section>
          </div>
        </div>
      </section>
    </div>
  )
}
