import { useEffect } from 'react'
import type { DayWorkerCount, GoogleCalendarItem, ShiftTeamMode, ShiftType } from '../../shared/calendar'

interface SettingsModalProps {
  open: boolean
  loading: boolean
  syncing: boolean
  selectingCalendar: boolean
  googleConnected: boolean
  accountEmail: string | null
  calendars: GoogleCalendarItem[]
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
  shiftType: ShiftType
  shiftTeamMode: ShiftTeamMode
  dayWorkerCount: DayWorkerCount
  savingShiftSettings: boolean
  onClose: () => void
  onConnectGoogle: () => Promise<void>
  onDisconnectGoogle: () => Promise<void>
  onSetSyncCalendar: (calendarId: string) => Promise<void>
  onSyncNow: () => Promise<void>
  onSetShiftType: (shiftType: ShiftType) => Promise<void>
  onSetShiftTeamMode: (shiftTeamMode: ShiftTeamMode) => Promise<void>
  onSetDayWorkerCount: (dayWorkerCount: DayWorkerCount) => Promise<void>
}

export function SettingsModal({
  open,
  loading,
  syncing,
  selectingCalendar,
  googleConnected,
  accountEmail,
  calendars,
  selectedCalendarId,
  selectedCalendarSummary,
  shiftType,
  shiftTeamMode,
  dayWorkerCount,
  savingShiftSettings,
  onClose,
  onConnectGoogle,
  onDisconnectGoogle,
  onSetSyncCalendar,
  onSyncNow,
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

  const syncCalendarValue = selectedCalendarId && calendars.some((calendar) => calendar.id === selectedCalendarId)
    ? selectedCalendarId
    : ''

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
          <h2 id="settings-modal-title">동기화 설정</h2>
          <button type="button" className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </header>
        <div className="settings-content">
          <section className="settings-section">
            <div className="settings-row">
              <p className="settings-label">Google 계정</p>
              <p className="settings-value">{googleConnected ? accountEmail ?? '연결됨' : '연결 안 됨'}</p>
            </div>
            {googleConnected ? (
              <button type="button" className="ghost-button" onClick={() => void onDisconnectGoogle()}>
                연결 해제
              </button>
            ) : (
              <button type="button" className="ghost-button" onClick={() => void onConnectGoogle()}>
                Google 연결
              </button>
            )}
          </section>

          <section className="settings-section">
            <label className="calendar-target-control settings-calendar-control" htmlFor="settings-sync-calendar-select">
              <span>동기화 달력</span>
              <select
                id="settings-sync-calendar-select"
                value={syncCalendarValue}
                onChange={(event) => {
                  const nextId = event.target.value
                  if (!nextId) {
                    return
                  }
                  void onSetSyncCalendar(nextId)
                }}
                disabled={!googleConnected || selectingCalendar || syncing || calendars.length === 0}
              >
                <option value="" disabled>
                  {!googleConnected
                    ? 'Google 계정을 먼저 연결해 주세요'
                    : calendars.length === 0
                      ? loading
                        ? '달력 목록을 불러오는 중...'
                        : '선택 가능한 달력이 없습니다'
                      : '달력을 선택하세요'}
                </option>
                {calendars.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.primary ? `기본 달력 (${calendar.summary})` : calendar.summary}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-hint">
              {selectedCalendarSummary
                ? `현재 선택: ${selectedCalendarSummary}`
                : '동기화할 달력을 선택해 주세요.'}
            </p>
          </section>

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

          <section className="settings-section">
            <div className="settings-row">
              <p className="settings-label">수동 동기화</p>
              <p className="settings-value">{syncing ? '동기화 중...' : '필요할 때 즉시 실행'}</p>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => void onSyncNow()}
              disabled={!googleConnected || syncing || !selectedCalendarId}
            >
              {syncing ? '동기화 중...' : '지금 동기화'}
            </button>
          </section>
        </div>
      </section>
    </div>
  )
}
