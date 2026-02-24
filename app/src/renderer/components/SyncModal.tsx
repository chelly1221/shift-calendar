import { DateTime } from 'luxon'
import { useEffect, useState } from 'react'
import type { GoogleCalendarItem, OutboxJobItem, OutboxOperation, OutboxStatus, SyncResult } from '../../shared/calendar'

const OUTBOX_OPERATION_LABELS: Record<OutboxOperation, string> = {
  CREATE: '생성',
  PATCH: '수정',
  DELETE: '삭제',
  RECUR_THIS: '반복/이번만',
  RECUR_ALL: '반복/전체',
  RECUR_FUTURE: '반복/이후',
}

const OUTBOX_STATUS_LABELS: Record<OutboxStatus, string> = {
  QUEUED: '대기',
  RUNNING: '실행중',
  DONE: '완료',
  FAILED: '실패',
  CANCELLED: '취소',
}

const OUTBOX_STATUS_CLASSES: Record<OutboxStatus, string> = {
  QUEUED: 'is-queued',
  RUNNING: 'is-running',
  DONE: 'is-done',
  FAILED: 'is-failed',
  CANCELLED: 'is-cancelled',
}

function formatSyncDateTime(iso: string): string {
  const value = DateTime.fromISO(iso).toLocal()
  if (!value.isValid) {
    return '-'
  }
  return value.setLocale('ko').toFormat('M/d HH:mm:ss')
}

interface SyncModalProps {
  open: boolean
  loading: boolean
  syncing: boolean
  selectingCalendar: boolean
  googleConnected: boolean
  accountEmail: string | null
  calendars: GoogleCalendarItem[]
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
  lastSyncResult: SyncResult | null
  outboxCount: number
  outboxJobs: OutboxJobItem[]
  loadingOutboxJobs: boolean
  onClose: () => void
  onRefreshOutboxJobs: () => Promise<void>
  onCancelOutboxJob: (jobId: string) => Promise<boolean>
  onConnectGoogle: () => Promise<void>
  onDisconnectGoogle: () => Promise<void>
  onSetSyncCalendar: (calendarId: string) => Promise<void>
  onSyncNow: () => Promise<void>
}

export function SyncModal({
  open,
  loading,
  syncing,
  selectingCalendar,
  googleConnected,
  accountEmail,
  calendars,
  selectedCalendarId,
  selectedCalendarSummary,
  lastSyncResult,
  outboxCount,
  outboxJobs,
  loadingOutboxJobs,
  onClose,
  onRefreshOutboxJobs,
  onCancelOutboxJob,
  onConnectGoogle,
  onDisconnectGoogle,
  onSetSyncCalendar,
  onSyncNow,
}: SyncModalProps) {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator === 'undefined') {
      return true
    }
    return navigator.onLine
  })
  const [removingJobIds, setRemovingJobIds] = useState<Set<string>>(() => new Set())

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

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    void onRefreshOutboxJobs()
    const timer = window.setInterval(() => {
      void onRefreshOutboxJobs()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [open, onRefreshOutboxJobs])

  if (!open) {
    return null
  }

  const syncCalendarValue = selectedCalendarId && calendars.some((calendar) => calendar.id === selectedCalendarId)
    ? selectedCalendarId
    : ''
  const isCalendarSelected = Boolean(selectedCalendarId)
  const canSyncNow = isOnline && googleConnected && isCalendarSelected && !syncing
  const readinessText = !isOnline
    ? '오프라인 상태'
    : !googleConnected
      ? 'Google 계정 연결 필요'
      : !isCalendarSelected
        ? '동기화 달력 선택 필요'
        : syncing
          ? '동기화 진행 중'
          : '즉시 동기화 가능'

  const removeOutboxJob = async (jobId: string) => {
    setRemovingJobIds((prev) => {
      const next = new Set(prev)
      next.add(jobId)
      return next
    })
    try {
      await onCancelOutboxJob(jobId)
      await onRefreshOutboxJobs()
    } finally {
      setRemovingJobIds((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="settings-modal sync-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="sync-modal-title">동기화</h2>
          <button type="button" className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </header>
        <div className="settings-content">
          <div className="sync-layout">
            <div className="sync-layout-column sync-layout-column-jobs">
              <section className="settings-section sync-jobs-section">
                <div className="settings-row">
                  <p className="settings-label">동기화 준비 상태</p>
                  <p className="settings-value">{readinessText}</p>
                </div>
                <div className="sync-detail-grid">
                  <div className="sync-detail-item">
                    <span className="sync-detail-label">네트워크</span>
                    <span className={isOnline ? 'sync-detail-value' : 'sync-detail-value is-pending'}>
                      {isOnline ? '온라인' : '오프라인'}
                    </span>
                  </div>
                  <div className="sync-detail-item">
                    <span className="sync-detail-label">계정</span>
                    <span className={googleConnected ? 'sync-detail-value' : 'sync-detail-value is-pending'}>
                      {googleConnected ? '연결됨' : '미연결'}
                    </span>
                  </div>
                  <div className="sync-detail-item">
                    <span className="sync-detail-label">달력</span>
                    <span className={isCalendarSelected ? 'sync-detail-value' : 'sync-detail-value is-pending'}>
                      {isCalendarSelected ? '선택됨' : '미선택'}
                    </span>
                  </div>
                </div>
                <p className="settings-hint">자동 동기화: 앱 시작 시, 온라인 복귀 시 실행됩니다.</p>
                <p className="settings-hint">
                  {outboxCount > 0
                    ? `로컬 대기 작업 ${outboxCount}건이 있습니다. 온라인 상태에서 순차 반영됩니다.`
                    : '로컬 대기 작업이 없습니다.'}
                </p>
              </section>

              <section className="settings-section">
                <div className="settings-row">
                  <p className="settings-label">동기화 상태</p>
                  <p className="settings-value">
                    {syncing
                      ? '동기화 중...'
                      : lastSyncResult
                        ? `최근 동기화: ${lastSyncResult.mode === 'FULL' ? '전체' : lastSyncResult.mode === 'DELTA' ? '증분' : '건너뜀'}`
                        : '동기화 기록 없음'}
                  </p>
                </div>
                {lastSyncResult && !syncing ? (
                  <div className="sync-detail-grid">
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">수신</span>
                      <span className="sync-detail-value">{lastSyncResult.pulledEvents}건</span>
                    </div>
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">송신</span>
                      <span className="sync-detail-value">{lastSyncResult.pushedOutboxJobs}건</span>
                    </div>
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">대기</span>
                      <span className={outboxCount > 0 ? 'sync-detail-value is-pending' : 'sync-detail-value'}>{outboxCount}건</span>
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void onSyncNow()}
                  disabled={!canSyncNow}
                >
                  {syncing ? '동기화 중...' : '지금 동기화'}
                </button>
              </section>

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
                <label className="calendar-target-control settings-calendar-control" htmlFor="sync-calendar-select">
                  <span>동기화 달력</span>
                  <select
                    id="sync-calendar-select"
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
            </div>

            <div className="sync-layout-column sync-layout-column-jobs">
              <section className="settings-section sync-jobs-section">
                <div className="sync-jobs-header">
                  <div className="settings-row">
                    <p className="settings-label">작업별 상태</p>
                    <p className="settings-value">
                      {outboxJobs.length > 0 ? `${outboxJobs.length}건 표시` : '표시할 작업 없음'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ghost-button sync-jobs-refresh-button"
                    onClick={() => void onRefreshOutboxJobs()}
                    disabled={loadingOutboxJobs}
                  >
                    {loadingOutboxJobs ? '불러오는 중...' : '새로고침'}
                  </button>
                </div>

                {outboxJobs.length === 0 ? (
                  <p className="settings-hint">대기/실패 작업이 없습니다.</p>
                ) : (
                  <div className="sync-job-list" role="list">
                    {outboxJobs.map((job) => {
                      const summary = job.eventSummary?.trim() || '(연결된 일정 없음)'
                      const retryText = job.status === 'FAILED' || job.status === 'QUEUED'
                        ? formatSyncDateTime(job.nextRetryAtUtc)
                        : null
                      const eventTypeText = job.eventType?.trim() || null
                      const canDelete = job.status === 'FAILED' || job.status === 'QUEUED'
                      const deleting = removingJobIds.has(job.id)

                      return (
                        <article key={job.id} className="sync-job-item" role="listitem">
                          <div className="sync-job-top">
                            <span className={`sync-job-status ${OUTBOX_STATUS_CLASSES[job.status]}`}>
                              {OUTBOX_STATUS_LABELS[job.status]}
                            </span>
                            <span className="sync-job-operation">{OUTBOX_OPERATION_LABELS[job.operation]}</span>
                            <span className="sync-job-title">{summary}</span>
                            <button
                              type="button"
                              className="ghost-button sync-job-delete-button"
                              onClick={() => { void removeOutboxJob(job.id) }}
                              disabled={!canDelete || deleting}
                            >
                              {deleting ? '삭제중...' : '삭제'}
                            </button>
                          </div>
                          <p className="sync-job-meta">
                            {eventTypeText ? `${eventTypeText} · ` : ''}
                            시도 {job.attempts}회
                            {retryText ? ` · 다음 시도 ${retryText}` : ''}
                          </p>
                          {job.lastError ? <p className="sync-job-error">{job.lastError}</p> : null}
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
