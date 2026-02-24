import { useEffect } from 'react'
import type { DayWorkerCount, ShiftTeamMode, ShiftType } from '../../shared/calendar'

interface SettingsModalProps {
  open: boolean
  shiftType: ShiftType
  shiftTeamMode: ShiftTeamMode
  dayWorkerCount: DayWorkerCount
  savingShiftSettings: boolean
  onClose: () => void
  onSetShiftType: (shiftType: ShiftType) => Promise<void>
  onSetShiftTeamMode: (shiftTeamMode: ShiftTeamMode) => Promise<void>
  onSetDayWorkerCount: (dayWorkerCount: DayWorkerCount) => Promise<void>
}

export function SettingsModal({
  open,
  shiftType,
  shiftTeamMode,
  dayWorkerCount,
  savingShiftSettings,
  onClose,
  onSetShiftType,
  onSetShiftTeamMode,
  onSetDayWorkerCount,
}: SettingsModalProps) {
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
        <div className="settings-content">
          <section className="settings-section">
            <label className="calendar-target-control settings-calendar-control" htmlFor="settings-shift-type-select">
              <span>교대근무 타입</span>
              <select
                id="settings-shift-type-select"
                value={shiftType}
                onChange={(event) => {
                  const nextType = event.target.value as ShiftType
                  void onSetShiftType(nextType)
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
                  void onSetShiftTeamMode(nextMode)
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
                  void onSetDayWorkerCount(nextCount)
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
        </div>
      </section>
    </div>
  )
}
