import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import koLocale from '@fullcalendar/core/locales/ko'
import { DateTime } from 'luxon'
import { type WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DateSelectArg, DatesSetArg, EventClickArg } from '@fullcalendar/core'
import type { CalendarEvent, ShiftTeamAssignments, ShiftTeamMode } from '../../shared/calendar'
import { EventModal, type EditableEvent } from '../components/EventModal'
import { SettingsModal } from '../components/SettingsModal'
import { useCalendarStore } from '../state/useCalendarStore'

function createDraft(startAtUtc?: string, endAtUtc?: string): EditableEvent {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const start = startAtUtc ?? DateTime.local().toUTC().toISO() ?? new Date().toISOString()
  const end =
    endAtUtc ??
    DateTime.fromISO(start).plus({ hours: 1 }).toUTC().toISO() ??
    new Date(Date.now() + 60 * 60 * 1000).toISOString()

  return {
    eventType: '일반',
    summary: '',
    description: '',
    location: '',
    startAtUtc: start,
    endAtUtc: end,
    timeZone: zone,
    attendees: [],
    recurrenceRule: null,
    sendUpdates: 'none',
    recurrenceScope: 'ALL',
  }
}

function toEditableEvent(event: CalendarEvent): EditableEvent {
  return {
    localId: event.localId,
    googleEventId: event.googleEventId,
    eventType: event.eventType,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startAtUtc: event.startAtUtc,
    endAtUtc: event.endAtUtc,
    timeZone: event.timeZone,
    attendees: event.attendees,
    recurrenceRule: event.recurrenceRule,
    recurringEventId: event.recurringEventId,
    originalStartTimeUtc: event.originalStartTimeUtc,
    sendUpdates: 'none',
    recurrenceScope: event.recurringEventId ? 'THIS' : 'ALL',
  }
}

const shiftTeamKeys = ['A', 'B', 'C', 'D'] as const
type ShiftTeamKey = (typeof shiftTeamKeys)[number]

function parseShiftTeamsFromSummary(summary: string): { dayTeam: ShiftTeamKey; nightTeam: ShiftTeamKey } | null {
  const normalized = summary.toUpperCase()
  const separators = [...normalized.matchAll(/[/／]/g)]
  const maxDistance = 12

  for (const separator of separators) {
    if (separator.index == null) {
      continue
    }

    let dayTeam: ShiftTeamKey | null = null
    for (let cursor = separator.index - 1; cursor >= 0 && separator.index - cursor <= maxDistance; cursor -= 1) {
      const letter = normalized[cursor]
      if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') {
        dayTeam = letter
        break
      }
    }

    if (!dayTeam) {
      continue
    }

    let nightTeam: ShiftTeamKey | null = null
    for (
      let cursor = separator.index + 1;
      cursor < normalized.length && cursor - separator.index <= maxDistance;
      cursor += 1
    ) {
      const letter = normalized[cursor]
      if (letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D') {
        nightTeam = letter
        break
      }
    }

    if (!nightTeam) {
      continue
    }

    return { dayTeam, nightTeam }
  }

  return null
}

function collectShiftMembers(teamKeys: ShiftTeamKey[], teams: ShiftTeamAssignments): string[] {
  const members: string[] = []
  for (const teamKey of teamKeys) {
    for (const rawName of teams[teamKey]) {
      const name = rawName.trim()
      if (!name || members.includes(name)) {
        continue
      }
      members.push(name)
    }
  }
  return members
}

function cloneShiftTeams(teams: ShiftTeamAssignments): ShiftTeamAssignments {
  return {
    A: [...teams.A],
    B: [...teams.B],
    C: [...teams.C],
    D: [...teams.D],
  }
}

function normalizeTeamMembers(values: string[], limit: number): string[] {
  const members: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || members.includes(trimmed)) {
      continue
    }
    members.push(trimmed)
    if (members.length >= limit) {
      break
    }
  }
  return members
}

function normalizeShiftTeams(teams: ShiftTeamAssignments, teamMode: ShiftTeamMode): ShiftTeamAssignments {
  const limit = teamMode === 'SINGLE' ? 1 : 2
  return {
    A: normalizeTeamMembers(teams.A, limit),
    B: normalizeTeamMembers(teams.B, limit),
    C: normalizeTeamMembers(teams.C, limit),
    D: normalizeTeamMembers(teams.D, limit),
  }
}

function normalizeDayWorkers(values: string[], dayWorkerCount: number): string[] {
  return normalizeTeamMembers(values, dayWorkerCount)
}

function getInlineNameWidth(value: string): string {
  const length = value.trim().length
  const clamped = Math.max(5, Math.min(13, length + 1))
  return `${clamped}ch`
}

export function CalendarPage() {
  const {
    events,
    loading,
    syncing,
    selectingCalendar,
    googleConnected,
    accountEmail,
    calendars,
    selectedCalendarId,
    selectedCalendarSummary,
    shiftSettings,
    savingShiftSettings,
    hydrate,
    saveEvent,
    deleteEvent,
    syncNow,
    setSyncCalendar,
    setShiftType,
    setShiftTeamMode,
    setDayWorkerCount,
    setShiftAssignments,
    connectGoogle,
    disconnectGoogle,
  } = useCalendarStore()

  const [editingEvent, setEditingEvent] = useState<EditableEvent | null>(null)
  const [editingTitleEventId, setEditingTitleEventId] = useState<string | null>(null)
  const [editingTitleDraft, setEditingTitleDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [titlebarMonthLabel, setTitlebarMonthLabel] = useState(() =>
    DateTime.local().setLocale('ko').toFormat('yyyy년 M월'),
  )
  const [shiftTeamDrafts, setShiftTeamDrafts] = useState<ShiftTeamAssignments>(() =>
    cloneShiftTeams(shiftSettings.teams),
  )
  const [dayWorkerDrafts, setDayWorkerDrafts] = useState<string[]>(() => [...shiftSettings.dayWorkers])
  const calendarRef = useRef<FullCalendar | null>(null)
  const eventsRef = useRef<CalendarEvent[]>(events)
  const shiftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShiftSaveRef = useRef<{
    teams: ShiftTeamAssignments
    dayWorkers: string[]
  } | null>(null)
  const monthWheelLockRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    return window.windowApi.onMaximizeChanged(setIsMaximized)
  }, [])

  useEffect(() => {
    const handleOnline = () => {
      void syncNow()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [syncNow])

  useEffect(() => {
    setShiftTeamDrafts(cloneShiftTeams(shiftSettings.teams))
    setDayWorkerDrafts([...shiftSettings.dayWorkers])
  }, [shiftSettings])

  useEffect(() => {
    eventsRef.current = events
  }, [events])

  const todayEvents = useMemo(() => {
    const today = DateTime.local().toISODate()
    return events
      .filter((event) => DateTime.fromISO(event.startAtUtc).toLocal().toISODate() === today)
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
  }, [events])
  const todayCount = todayEvents.length

  const todayShiftSummary = useMemo(() => {
    const dayTeams: ShiftTeamKey[] = []
    const nightTeams: ShiftTeamKey[] = []

    for (const event of todayEvents) {
      if (event.eventType !== '근무') {
        continue
      }
      const parsed = parseShiftTeamsFromSummary(event.summary)
      if (!parsed) {
        continue
      }
      if (!dayTeams.includes(parsed.dayTeam)) {
        dayTeams.push(parsed.dayTeam)
      }
      if (!nightTeams.includes(parsed.nightTeam)) {
        nightTeams.push(parsed.nightTeam)
      }
    }

    if (dayTeams.length === 0 && nightTeams.length === 0) {
      return null
    }

    const dayMembers = collectShiftMembers(dayTeams, shiftTeamDrafts)
    const nightMembers = collectShiftMembers(nightTeams, shiftTeamDrafts)
    const dayText = dayMembers.length > 0 ? dayMembers.join(' · ') : `${dayTeams.join('·')}조 미지정`
    const nightText = nightMembers.length > 0 ? nightMembers.join(' · ') : `${nightTeams.join('·')}조 미지정`

    return { dayText, nightText }
  }, [shiftTeamDrafts, todayEvents])

  const upcomingEvents = useMemo(() => {
    const now = DateTime.now()
    return events
      .filter((event) => DateTime.fromISO(event.endAtUtc).toMillis() >= now.toMillis())
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
      .slice(0, 6)
  }, [events])

  const shiftLabelByDate = useMemo(() => {
    const grouped = new Map<string, string[]>()
    for (const event of events) {
      if (event.eventType !== '근무') {
        continue
      }
      const dateKey = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
      if (!dateKey) {
        continue
      }
      const summary = event.summary.trim()
      if (!summary) {
        continue
      }
      const current = grouped.get(dateKey) ?? []
      if (!current.includes(summary)) {
        current.push(summary)
      }
      grouped.set(dateKey, current)
    }

    const labels = new Map<string, string>()
    for (const [dateKey, summaries] of grouped) {
      if (summaries.length === 1) {
        labels.set(dateKey, summaries[0])
        continue
      }
      labels.set(dateKey, `${summaries[0]} +${summaries.length - 1}`)
    }
    return labels
  }, [events])

  const calendarEvents = useMemo(
    () =>
      events
        .filter((event) => event.eventType !== '근무')
        .map((event) => ({
        id: event.localId,
        title: event.summary,
        start: event.startAtUtc,
        end: event.endAtUtc,
        classNames: event.recurrenceRule ? ['is-recurring'] : [],
      })),
    [events],
  )

  const useCustomTitlebar = window.windowApi.platform === 'win32' || window.windowApi.platform === 'linux'
  const visibleMemberCount = shiftSettings.shiftTeamMode === 'SINGLE' ? 1 : 2
  const visibleDayWorkerCount = shiftSettings.dayWorkerCount

  const moveMonth = (direction: 'prev' | 'next' | 'today') => {
    const calendarApi = calendarRef.current?.getApi()
    if (!calendarApi) {
      return
    }
    if (direction === 'prev') {
      calendarApi.prev()
      return
    }
    if (direction === 'next') {
      calendarApi.next()
      return
    }
    calendarApi.today()
  }

  const handleDatesSet = (payload: DatesSetArg) => {
    const monthLabel = DateTime.fromJSDate(payload.view.currentStart)
      .setLocale('ko')
      .toFormat('yyyy년 M월')
    setTitlebarMonthLabel(monthLabel)
  }

  const startInlineTitleEdit = (event: CalendarEvent) => {
    setEditingTitleEventId(event.localId)
    setEditingTitleDraft(event.summary)
  }

  const cancelInlineTitleEdit = () => {
    setEditingTitleEventId(null)
    setEditingTitleDraft('')
  }

  const commitInlineTitleEdit = async (localId: string) => {
    const targetEvent = eventsRef.current.find((event) => event.localId === localId)
    if (!targetEvent) {
      cancelInlineTitleEdit()
      return
    }

    const nextSummary = editingTitleDraft.trim()
    if (!nextSummary || nextSummary === targetEvent.summary) {
      cancelInlineTitleEdit()
      return
    }

    // Reset edit UI first so quick consecutive edits do not race each other.
    cancelInlineTitleEdit()

    await saveEvent({
      ...toEditableEvent(targetEvent),
      summary: nextSummary,
      sendUpdates: 'none',
    })
  }

  const flushShiftAssignmentsSave = useCallback(() => {
    const pending = pendingShiftSaveRef.current
    if (!pending) {
      return
    }
    pendingShiftSaveRef.current = null
    const normalizedTeams = normalizeShiftTeams(pending.teams, shiftSettings.shiftTeamMode)
    const normalizedDayWorkers = normalizeDayWorkers(pending.dayWorkers, shiftSettings.dayWorkerCount)
    void setShiftAssignments(normalizedTeams, normalizedDayWorkers)
  }, [setShiftAssignments, shiftSettings.dayWorkerCount, shiftSettings.shiftTeamMode])

  useEffect(() => {
    const flushPendingShiftSave = () => {
      if (shiftSaveTimerRef.current) {
        clearTimeout(shiftSaveTimerRef.current)
        shiftSaveTimerRef.current = null
      }
      flushShiftAssignmentsSave()
    }

    window.addEventListener('beforeunload', flushPendingShiftSave)
    window.addEventListener('pagehide', flushPendingShiftSave)

    return () => {
      window.removeEventListener('beforeunload', flushPendingShiftSave)
      window.removeEventListener('pagehide', flushPendingShiftSave)
      flushPendingShiftSave()
      if (monthWheelLockRef.current) {
        clearTimeout(monthWheelLockRef.current)
        monthWheelLockRef.current = null
      }
    }
  }, [flushShiftAssignmentsSave])

  const scheduleShiftAssignmentsSave = useCallback((nextTeams: ShiftTeamAssignments, nextDayWorkers: string[]) => {
    pendingShiftSaveRef.current = {
      teams: cloneShiftTeams(nextTeams),
      dayWorkers: [...nextDayWorkers],
    }
    if (shiftSaveTimerRef.current) {
      clearTimeout(shiftSaveTimerRef.current)
    }
    shiftSaveTimerRef.current = setTimeout(() => {
      shiftSaveTimerRef.current = null
      flushShiftAssignmentsSave()
    }, 120)
  }, [flushShiftAssignmentsSave])

  const handleCalendarWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 6) {
      return
    }

    event.preventDefault()
    if (monthWheelLockRef.current) {
      return
    }

    moveMonth(event.deltaY > 0 ? 'next' : 'prev')
    monthWheelLockRef.current = setTimeout(() => {
      monthWheelLockRef.current = null
    }, 220)
  }

  return (
    <div className="window-frame">
      {useCustomTitlebar ? (
        <div className="titlebar">
          <div className="titlebar-leading">
            <button
              type="button"
              className="titlebar-settings-btn"
              onClick={() => setSettingsOpen(true)}
            >
              설정
            </button>
          </div>
          <div className="titlebar-monthbar">
            <button
              type="button"
              className="titlebar-month-btn"
              onClick={() => moveMonth('prev')}
              aria-label="이전 달"
            >
              ‹
            </button>
            <span className="titlebar-month-label">{titlebarMonthLabel}</span>
            <button
              type="button"
              className="titlebar-month-btn"
              onClick={() => moveMonth('next')}
              aria-label="다음 달"
            >
              ›
            </button>
          </div>
          <div className="titlebar-controls">
            <button
              type="button"
              className="titlebar-btn"
              onClick={() => window.windowApi.minimize()}
              aria-label="최소화"
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar-btn"
              onClick={() => window.windowApi.maximize()}
              aria-label={isMaximized ? '복원' : '최대화'}
            >
              {isMaximized ? (
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <rect x="3.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
                  <rect x="1.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="var(--surface, #f5f5f7)" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="titlebar-btn titlebar-btn-close"
              onClick={() => window.windowApi.close()}
              aria-label="닫기"
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}
      <div className={useCustomTitlebar ? 'app-shell app-shell-with-titlebar' : 'app-shell'}>
      {googleConnected && !selectedCalendarId ? (
        <div className="warning-banner">동기화할 달력을 먼저 선택해 주세요.</div>
      ) : null}

      <div className="content-grid">
        <aside className="left-panel">
          <section className="stat-card">
            <div className="stat-value-row">
              <div>
                <p className="stat-label">오늘</p>
                <p className="stat-value">
                  <span>{todayCount}</span>
                  <small className="stat-value-unit">개 일정</small>
                </p>
              </div>
              {todayShiftSummary ? (
                <div className="today-shift-summary">
                  <p className="today-shift-row">
                    <span className="today-shift-icon" aria-hidden="true">☀</span>
                    <span className="today-shift-members">{todayShiftSummary.dayText}</span>
                  </p>
                  <p className="today-shift-row">
                    <span className="today-shift-icon" aria-hidden="true">☾</span>
                    <span className="today-shift-members">{todayShiftSummary.nightText}</span>
                  </p>
                </div>
              ) : null}
            </div>
            <ul className="today-list">
              {todayEvents.length === 0 ? (
                <li className="today-empty">당일 일정이 없습니다</li>
              ) : (
                todayEvents.map((event) => (
                  <li key={event.localId} className="today-item">
                    <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                      <span>{event.summary}</span>
                      <small>{DateTime.fromISO(event.startAtUtc).toLocal().setLocale('ko').toFormat('HH:mm')}</small>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="upcoming-card">
            <div className="card-row">
              <h2>다가오는 일정</h2>
              {loading ? <span className="status-chip">불러오는 중</span> : null}
            </div>
            <ul className="upcoming-list">
              {upcomingEvents.length === 0 ? (
                <li className="empty-item">다가오는 일정이 없습니다</li>
              ) : (
                upcomingEvents.map((event) => (
                  <li key={event.localId} className="upcoming-item">
                    <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                      <span>{event.summary}</span>
                      <small>
                        {DateTime.fromISO(event.startAtUtc).toLocal().setLocale('ko').toFormat('M월 d일 HH:mm')}
                      </small>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="shift-card">
            {savingShiftSettings ? (
              <div className="card-row shift-card-row">
                <span className="status-chip">저장 중</span>
              </div>
            ) : null}
            <div className="shift-team-list">
              <div className="shift-team-item">
                <div className="shift-display-row">
                  <span className="shift-display-label">일근</span>
                  <div className="shift-inline-editor">
                    {Array.from({ length: visibleDayWorkerCount }, (_, workerIndex) => (
                      <label key={`day-${workerIndex}`} className="shift-inline-field">
                        {workerIndex === 0 ? <span className="shift-inline-role-text">소장</span> : null}
                        <input
                          type="text"
                          className="shift-inline-input"
                          value={dayWorkerDrafts[workerIndex] ?? ''}
                          placeholder="이름"
                          style={{ width: getInlineNameWidth(dayWorkerDrafts[workerIndex] ?? '') }}
                          onChange={(event) => {
                            const nextWorkers = [...dayWorkerDrafts]
                            nextWorkers[workerIndex] = event.target.value
                            setDayWorkerDrafts(nextWorkers)
                            scheduleShiftAssignmentsSave(shiftTeamDrafts, nextWorkers)
                          }}
                          maxLength={40}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className={shiftSettings.shiftTeamMode === 'SINGLE' ? 'shift-team-grid is-two-col' : 'shift-team-grid'}>
                {shiftTeamKeys.map((teamKey) => (
                  <div key={teamKey} className="shift-team-item">
                    <div className="shift-display-row">
                      <span className="shift-display-label">{teamKey}조</span>
                      <div className="shift-inline-editor">
                        {Array.from({ length: visibleMemberCount }, (_, memberIndex) => (
                          <label key={`${teamKey}-${memberIndex}`} className="shift-inline-field">
                            {memberIndex === 0 ? <span className="shift-inline-role-text">조장</span> : null}
                            <input
                              type="text"
                              className="shift-inline-input"
                              value={shiftTeamDrafts[teamKey][memberIndex] ?? ''}
                              placeholder="이름"
                              style={{ width: getInlineNameWidth(shiftTeamDrafts[teamKey][memberIndex] ?? '') }}
                              onChange={(event) => {
                                const nextTeams = cloneShiftTeams(shiftTeamDrafts)
                                const nextMembers = [...nextTeams[teamKey]]
                                nextMembers[memberIndex] = event.target.value
                                nextTeams[teamKey] = nextMembers
                                setShiftTeamDrafts(nextTeams)
                                scheduleShiftAssignmentsSave(nextTeams, dayWorkerDrafts)
                              }}
                              maxLength={40}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </aside>

        <main className="calendar-panel" onWheel={handleCalendarWheel}>
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, interactionPlugin]}
            locales={[koLocale]}
            locale="ko"
            initialView="dayGridMonth"
            selectable
            editable={false}
            eventStartEditable={false}
            eventDurationEditable={false}
            height="100%"
            expandRows
            fixedWeekCount={false}
            showNonCurrentDates
          dayMaxEvents
          events={calendarEvents}
          eventContent={(arg) => {
            const isEditing = editingTitleEventId === arg.event.id
            if (!isEditing) {
              return (
                <div className="fc-event-title-inline-wrap">
                  <span className="fc-event-title-inline-text">{arg.event.title}</span>
                </div>
              )
            }

            return (
              <input
                type="text"
                className="fc-event-title-inline-input"
                value={editingTitleDraft}
                autoFocus
                onChange={(event) => setEditingTitleDraft(event.target.value)}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => {
                  void commitInlineTitleEdit(arg.event.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelInlineTitleEdit()
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    ;(event.currentTarget as HTMLInputElement).blur()
                  }
                }}
              />
            )
          }}
          eventDidMount={(arg) => {
            arg.el.title = '우클릭으로 상세편집'
            arg.el.oncontextmenu = (event) => {
              event.preventDefault()
              event.stopPropagation()
              const selected = eventsRef.current.find((item) => item.localId === arg.event.id)
              if (!selected) {
                return
              }
              cancelInlineTitleEdit()
              setEditingEvent(toEditableEvent(selected))
            }
          }}
          eventWillUnmount={(arg) => {
            arg.el.oncontextmenu = null
          }}
          dayCellContent={(arg) => {
            const dateKey = DateTime.fromJSDate(arg.date).toISODate()
            const shiftLabel = dateKey ? shiftLabelByDate.get(dateKey) : null
            return (
              <>
                <span className="fc-day-number-text">{arg.dayNumberText.replace('일', '')}</span>
                {shiftLabel ? <span className="fc-day-shift-inline">{shiftLabel}</span> : null}
              </>
            )
          }}
          headerToolbar={false}
          datesSet={handleDatesSet}
            select={(selection: DateSelectArg) => {
              const startAtUtc =
                DateTime.fromJSDate(selection.start).toUTC().toISO() ?? new Date().toISOString()
              const endAtUtc =
                DateTime.fromJSDate(selection.end).toUTC().toISO() ??
                DateTime.fromJSDate(selection.start).plus({ hours: 1 }).toUTC().toISO() ??
                new Date(Date.now() + 60 * 60 * 1000).toISOString()
              setEditingEvent(createDraft(startAtUtc, endAtUtc))
            }}
            eventClick={(info: EventClickArg) => {
              info.jsEvent.preventDefault()
              info.jsEvent.stopPropagation()
              const selected = eventsRef.current.find((event) => event.localId === info.event.id)
              if (!selected) {
                return
              }
              startInlineTitleEdit(selected)
            }}
          />
        </main>
      </div>

      <EventModal
        open={Boolean(editingEvent)}
        value={editingEvent}
        onClose={() => setEditingEvent(null)}
        onSave={async (event) => {
          await saveEvent(event)
          setEditingEvent(null)
        }}
        onDelete={async (localId, sendUpdates) => {
          await deleteEvent(localId, sendUpdates)
          setEditingEvent(null)
        }}
      />
      <SettingsModal
        open={settingsOpen}
        loading={loading}
        syncing={syncing}
        selectingCalendar={selectingCalendar}
        googleConnected={googleConnected}
        accountEmail={accountEmail}
        calendars={calendars}
        selectedCalendarId={selectedCalendarId}
        selectedCalendarSummary={selectedCalendarSummary}
        shiftType={shiftSettings.shiftType}
        shiftTeamMode={shiftSettings.shiftTeamMode}
        dayWorkerCount={shiftSettings.dayWorkerCount}
        savingShiftSettings={savingShiftSettings}
        onClose={() => setSettingsOpen(false)}
        onConnectGoogle={connectGoogle}
        onDisconnectGoogle={disconnectGoogle}
        onSetSyncCalendar={setSyncCalendar}
        onSyncNow={syncNow}
        onSetShiftType={setShiftType}
        onSetShiftTeamMode={setShiftTeamMode}
        onSetDayWorkerCount={setDayWorkerCount}
      />
      </div>
    </div>
  )
}
