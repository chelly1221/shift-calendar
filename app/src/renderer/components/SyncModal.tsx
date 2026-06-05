import { DateTime } from 'luxon'
import { useCallback, useEffect, useState } from 'react'
import type { ForcePushResult, GoogleCalendarItem, GoogleOAuthConfig, OutboxJobItem, OutboxOperation, OutboxStatus, SyncResult } from '../../shared/calendar'

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

const DEV_SETTINGS_PASSWORD = 'Scott122001&&'

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
  forcePushing: boolean
  selectingCalendar: boolean
  googleConnected: boolean
  needsReauth: boolean
  accountEmail: string | null
  calendars: GoogleCalendarItem[]
  calendarsLoadError: boolean
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
  lastSyncResult: SyncResult | null
  lastForcePushResult: ForcePushResult | null
  outboxCount: number
  outboxJobs: OutboxJobItem[]
  loadingOutboxJobs: boolean
  onClose: () => void
  onRefreshOutboxJobs: () => Promise<void>
  onCancelOutboxJob: (jobId: string) => Promise<boolean>
  onConnectGoogle: () => Promise<void>
  onDisconnectGoogle: () => Promise<void>
  onReloadCalendars: () => Promise<void>
  onSetSyncCalendar: (calendarId: string) => Promise<void>
  onSyncNow: () => Promise<void>
  onForcePushAll: () => Promise<void>
}

export function SyncModal({
  open,
  loading,
  syncing,
  forcePushing,
  selectingCalendar,
  googleConnected,
  needsReauth,
  accountEmail,
  calendars,
  calendarsLoadError,
  selectedCalendarId,
  selectedCalendarSummary,
  lastSyncResult,
  lastForcePushResult,
  outboxCount,
  outboxJobs,
  loadingOutboxJobs,
  onClose,
  onRefreshOutboxJobs,
  onCancelOutboxJob,
  onConnectGoogle,
  onDisconnectGoogle,
  onReloadCalendars,
  onSetSyncCalendar,
  onSyncNow,
  onForcePushAll,
}: SyncModalProps) {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator === 'undefined') {
      return true
    }
    return navigator.onLine
  })
  const [removingJobIds, setRemovingJobIds] = useState<Set<string>>(() => new Set())
  const [oauthConfig, setOauthConfig] = useState<GoogleOAuthConfig | null>(null)
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthSaving, setOauthSaving] = useState(false)
  const [devUnlocked, setDevUnlocked] = useState(false)
  const [devPromptOpen, setDevPromptOpen] = useState(false)
  const [devPasswordInput, setDevPasswordInput] = useState('')
  const [devPasswordError, setDevPasswordError] = useState(false)
  const [reloadingCalendars, setReloadingCalendars] = useState(false)

  const loadOAuthConfig = useCallback(async () => {
    try {
      const config = await window.calendarApi.getGoogleOAuthConfig()
      setOauthConfig(config)
      if (config.configured && config.clientId) {
        setOauthClientId(config.clientId)
        setOauthClientSecret('')
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setRemovingJobIds(new Set())
      setDevUnlocked(false)
      setDevPromptOpen(false)
      setDevPasswordInput('')
      setDevPasswordError(false)
      return
    }
    void loadOAuthConfig()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, loadOAuthConfig])

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
  const isCalendarSelected = Boolean(syncCalendarValue)
  const canSyncNow = isOnline && googleConnected && isCalendarSelected && !syncing && !forcePushing
  const canForcePush = isOnline && googleConnected && isCalendarSelected && !syncing && !forcePushing
  const readinessText = !isOnline
    ? '오프라인 상태'
    : !googleConnected
      ? 'Google 계정 연결 필요'
      : !isCalendarSelected
        ? '동기화 달력 선택 필요'
        : forcePushing
          ? '전체 동기화 진행 중'
          : syncing
            ? '동기화 진행 중'
            : '즉시 동기화 가능'

  const saveOAuthConfig = async () => {
    const trimmedId = oauthClientId.trim()
    const trimmedSecret = oauthClientSecret.trim()
    if (!trimmedId || !trimmedSecret) {
      return
    }
    setOauthSaving(true)
    try {
      const result = await window.calendarApi.setGoogleOAuthConfig({
        clientId: trimmedId,
        clientSecret: trimmedSecret,
      })
      setOauthConfig(result)
      setOauthClientSecret('')
    } catch {
      // ignore
    } finally {
      setOauthSaving(false)
    }
  }

  const removeOutboxJob = async (jobId: string) => {
    setRemovingJobIds((prev) => {
      const next = new Set(prev)
      next.add(jobId)
      return next
    })
    try {
      await onCancelOutboxJob(jobId)
    } finally {
      setRemovingJobIds((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  const submitDevPassword = () => {
    if (devPasswordInput === DEV_SETTINGS_PASSWORD) {
      setDevUnlocked(true)
      setDevPromptOpen(false)
      setDevPasswordInput('')
      setDevPasswordError(false)
    } else {
      setDevPasswordError(true)
    }
  }

  const closeDevPrompt = () => {
    setDevPromptOpen(false)
    setDevPasswordInput('')
    setDevPasswordError(false)
  }

  const lockDeveloperSettings = () => {
    setDevUnlocked(false)
    closeDevPrompt()
  }

  const handleReloadCalendars = async () => {
    setReloadingCalendars(true)
    try {
      await onReloadCalendars()
    } finally {
      setReloadingCalendars(false)
    }
  }

  const accountSection = (
    <section className="settings-section">
      <div className="settings-row">
        <p className="settings-label">Google 계정</p>
        <p className="settings-value">{googleConnected ? accountEmail ?? '연결됨' : '연결 안 됨'}</p>
      </div>
      {needsReauth ? (
        <div className="sync-reauth-banner" role="alert">
          <p className="sync-reauth-title">Google 재인증이 필요합니다</p>
          <p className="sync-reauth-detail">
            저장된 인증 토큰이 만료되었거나 취소되어 동기화가 중단되었습니다. 아래 버튼으로 Google 계정을 다시 연결하세요.
          </p>
          <p className="sync-reauth-detail">
            재인증 후에도 며칠 만에 반복된다면, Google Cloud Console의 OAuth 동의화면이 &lsquo;테스트(Testing)&rsquo; 상태일 수 있습니다. 이 경우 토큰이 7일마다 만료되므로 동의화면을 &lsquo;프로덕션(Production)&rsquo;으로 게시하세요.
          </p>
        </div>
      ) : null}
      {googleConnected ? (
        <button type="button" className="ghost-button" onClick={() => void onDisconnectGoogle().catch((err) => { console.error(err); window.alert('연결 해제 실패') })}>
          연결 해제
        </button>
      ) : (
        <button
          type="button"
          className={needsReauth ? 'primary-button' : 'ghost-button'}
          onClick={() => void onConnectGoogle()}
        >
          {needsReauth ? 'Google 다시 연결' : 'Google 연결'}
        </button>
      )}
    </section>
  )

  const calendarSection = (
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
              : calendarsLoadError
                ? '달력 목록을 불러오지 못했습니다'
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
      {googleConnected && calendarsLoadError ? (
        <div className="sync-calendar-error">
          <p className="settings-hint" style={{ color: 'var(--danger)' }}>
            달력 목록을 불러오지 못했습니다. 네트워크 연결과 Google Calendar API 사용 설정을 확인한 뒤 다시 시도해 주세요.
          </p>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void handleReloadCalendars()}
            disabled={reloadingCalendars}
          >
            {reloadingCalendars ? '불러오는 중...' : '다시 시도'}
          </button>
        </div>
      ) : (
        <p className="settings-hint">
          {selectedCalendarSummary
            ? `현재 선택: ${selectedCalendarSummary}`
            : '동기화할 달력을 선택해 주세요.'}
        </p>
      )}
    </section>
  )

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`settings-modal sync-modal${devUnlocked ? '' : ' sync-modal-locked'}`}
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
          {devUnlocked ? (
          <div className="sync-layout">
            <div className="sync-layout-column sync-layout-column-jobs">
              {accountSection}
              {calendarSection}
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
                <div className="sync-action-buttons">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void onSyncNow().catch((err) => { console.error(err); window.alert('동기화 실패') })}
                    disabled={!canSyncNow}
                  >
                    {syncing ? '동기화 중...' : '지금 동기화'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button sync-force-push-button"
                    onClick={() => {
                      if (window.confirm('로컬 캘린더 기준으로 구글 캘린더를 강제 업데이트합니다.\n이 작업은 되돌릴 수 없습니다. 계속하시겠습니까?')) {
                        void onForcePushAll().catch((err) => { console.error(err); window.alert('강제 푸시 실패') })
                      }
                    }}
                    disabled={!canForcePush}
                  >
                    {forcePushing ? '강제 푸시 중...' : '로컬 기준 강제 푸시'}
                  </button>
                </div>
                {lastForcePushResult ? (
                  <div className="sync-detail-grid">
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">등록</span>
                      <span className="sync-detail-value">{lastForcePushResult.enqueuedJobs}건</span>
                    </div>
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">처리</span>
                      <span className="sync-detail-value">{lastForcePushResult.processedJobs}건</span>
                    </div>
                    <div className="sync-detail-item">
                      <span className="sync-detail-label">건너뜀</span>
                      <span className="sync-detail-value">{lastForcePushResult.skippedEvents}건</span>
                    </div>
                  </div>
                ) : null}
                <p className="settings-hint">강제 푸시: 로컬 이벤트를 기준으로 구글 캘린더를 덮어씁니다.</p>
              </section>

              <section className="settings-section">
                <div className="settings-row">
                  <p className="settings-label">Google OAuth 설정</p>
                  <p className="settings-value">
                    {oauthConfig?.configured ? '설정됨' : '미설정'}
                  </p>
                </div>
                <label className="calendar-target-control settings-calendar-control" htmlFor="oauth-client-id">
                  <span>Client ID</span>
                  <input
                    id="oauth-client-id"
                    type="text"
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    placeholder="Google OAuth Client ID"
                    disabled={oauthSaving}
                  />
                </label>
                <label className="calendar-target-control settings-calendar-control" htmlFor="oauth-client-secret">
                  <span>Client Secret</span>
                  <input
                    id="oauth-client-secret"
                    type="password"
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                    placeholder={oauthConfig?.configured ? '********' : 'Google OAuth Client Secret'}
                    disabled={oauthSaving}
                  />
                </label>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveOAuthConfig()}
                  disabled={oauthSaving || !oauthClientId.trim() || !oauthClientSecret.trim()}
                >
                  {oauthSaving ? '저장 중...' : '저장'}
                </button>
                <p className="settings-hint">
                  {oauthConfig?.configured
                    ? 'Google OAuth 자격증명이 저장되어 있습니다. 변경하려면 새 값을 입력하세요.'
                    : 'Google Cloud Console에서 OAuth Client ID와 Secret을 발급받아 입력하세요.'}
                </p>
              </section>

              <section className="settings-section">
                <button type="button" className="ghost-button" onClick={lockDeveloperSettings}>
                  개발자 설정 잠금
                </button>
                <p className="settings-hint">잠그면 고급 설정이 다시 숨겨집니다.</p>
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
          ) : (
            <div className="sync-locked-body">
              {accountSection}
              {calendarSection}
              <div className="sync-dev-gate">
                {devPromptOpen ? (
                  <div className="sync-dev-gate-form">
                    <label className="calendar-target-control settings-calendar-control" htmlFor="dev-settings-password">
                      <span>개발자 설정 비밀번호</span>
                      <input
                        id="dev-settings-password"
                        type="password"
                        value={devPasswordInput}
                        autoFocus
                        onChange={(e) => {
                          setDevPasswordInput(e.target.value)
                          setDevPasswordError(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            submitDevPassword()
                          }
                        }}
                        placeholder="비밀번호를 입력하세요"
                        aria-invalid={devPasswordError || undefined}
                        aria-describedby={devPasswordError ? 'dev-settings-password-error' : undefined}
                      />
                    </label>
                    {devPasswordError ? (
                      <p id="dev-settings-password-error" role="alert" className="settings-hint" style={{ color: 'var(--danger)' }}>비밀번호가 올바르지 않습니다.</p>
                    ) : null}
                    <div className="settings-inline-actions">
                      <button type="button" className="primary-button" onClick={submitDevPassword} disabled={!devPasswordInput}>
                        확인
                      </button>
                      <button type="button" className="ghost-button" onClick={closeDevPrompt}>
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="sync-dev-gate-link" onClick={() => setDevPromptOpen(true)}>
                    <span className="sync-dev-gate-link-label">
                      <span className="sync-dev-gate-link-icon" aria-hidden="true">🔒</span>
                      개발자 설정
                    </span>
                    <span className="sync-dev-gate-link-chevron" aria-hidden="true">›</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
