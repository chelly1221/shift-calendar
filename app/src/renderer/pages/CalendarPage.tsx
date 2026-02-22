import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import koLocale from '@fullcalendar/core/locales/ko'
import { DateTime } from 'luxon'
import { type WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DatesSetArg, EventClickArg } from '@fullcalendar/core'
import type { CalendarEvent, ShiftTeamAssignments, ShiftTeamMode } from '../../shared/calendar'
import { isVirtualInstance, extractMasterLocalId } from '../../shared/expandRecurrence'
import { isPublicHolidayName, FIXED_PUBLIC_HOLIDAY_MMDD } from '../../shared/koreanHolidays'
import { EventModal, type EditableEvent } from '../components/EventModal'
import { parseEducationTargets } from '../utils/parseEducationTargets'
import { parseVacationInfo } from '../utils/parseVacationInfo'
import { SettingsModal } from '../components/SettingsModal'
import { useCalendarStore } from '../state/useCalendarStore'

const ROUTINE_COMPLETIONS_KEY = 'routineCompletions'

function loadCompletions(): Set<string> {
  try {
    const raw = localStorage.getItem(ROUTINE_COMPLETIONS_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function saveCompletions(set: Set<string>): void {
  localStorage.setItem(ROUTINE_COMPLETIONS_KEY, JSON.stringify([...set]))
}

function makeCompletionKey(localId: string, startAtUtc: string): string {
  const masterLocalId = extractMasterLocalId(localId)
  const dateKey = DateTime.fromISO(startAtUtc).toLocal().toISODate()
  return `${masterLocalId}::${dateKey}`
}

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
  if (isVirtualInstance(event.localId)) {
    const masterLocalId = extractMasterLocalId(event.localId)
    return {
      localId: masterLocalId,
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
      originalStartTimeUtc: event.startAtUtc,
      sendUpdates: 'none',
      recurrenceScope: 'THIS',
    }
  }

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

  const [routineCompletions, setRoutineCompletions] = useState<Set<string>>(loadCompletions)
  const [editingEvent, setEditingEvent] = useState<EditableEvent | null>(null)
  const [editingTitleEventId, setEditingTitleEventId] = useState<string | null>(null)
  const [editingTitleDraft, setEditingTitleDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [titlebarMonthLabel, setTitlebarMonthLabel] = useState(() =>
    DateTime.local().setLocale('ko').toFormat('yyyy년 M월'),
  )
  const [visibleMonth, setVisibleMonth] = useState(() => DateTime.local().startOf('month'))
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
  const editingTitleDraftRef = useRef('')
  editingTitleDraftRef.current = editingTitleDraft

  const toggleRoutineCompletion = useCallback((completionKey: string) => {
    setRoutineCompletions((prev) => {
      const next = new Set(prev)
      if (next.has(completionKey)) {
        next.delete(completionKey)
      } else {
        next.add(completionKey)
      }
      saveCompletions(next)
      return next
    })
  }, [])

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

  useEffect(() => {
    if (!editingTitleEventId) return
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.fc-event-title-inline-input')) return
      const input = document.querySelector('.fc-event-title-inline-input') as HTMLInputElement | null
      input?.blur()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [editingTitleEventId])

  const todayEvents = useMemo(() => {
    const today = DateTime.local().toISODate()
    return events
      .filter((event) => event.eventType !== '근무' && event.eventType !== '휴가' && DateTime.fromISO(event.startAtUtc).toLocal().toISODate() === today)
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
  }, [events])
  const todayCount = todayEvents.length

  const publicHolidayMap = useMemo(() => {
    const map = new Map<string, string>()

    // Google 동기화 데이터 기반: 공휴일 이벤트 중 법정공휴일만 수집
    for (const event of events) {
      if (event.eventType !== '공휴일') continue
      if (!isPublicHolidayName(event.summary)) continue
      const isoDate = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
      if (isoDate && !map.has(isoDate)) map.set(isoDate, event.summary)
    }

    // 오프라인 fallback: 현재 연도 기준 고정 날짜 공휴일
    const year = DateTime.local().year
    for (const mmdd of FIXED_PUBLIC_HOLIDAY_MMDD) {
      const key = `${year}-${mmdd}`
      if (!map.has(key)) map.set(key, '')
    }

    return map
  }, [events])

  const todayShiftSummary = useMemo(() => {
    const today = DateTime.local().toISODate()
    const todayShiftEvents = events.filter(
      (event) => event.eventType === '근무' && DateTime.fromISO(event.startAtUtc).toLocal().toISODate() === today,
    )
    const dayTeams: ShiftTeamKey[] = []
    const nightTeams: ShiftTeamKey[] = []

    for (const event of todayShiftEvents) {
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

    // 오늘 휴가자 이름 수집
    const todayVacationNames = new Set<string>()
    for (const event of events) {
      if (event.eventType !== '휴가') continue
      const start = DateTime.fromISO(event.startAtUtc).toLocal()
      const end = DateTime.fromISO(event.endAtUtc).toLocal()
      const todayDtObj = DateTime.fromISO(today!)
      if (start.startOf('day') <= todayDtObj && end > todayDtObj) {
        const { targets } = parseVacationInfo(event.description ?? '')
        for (const name of targets) todayVacationNames.add(name.trim())
      }
    }

    const todayDt = DateTime.local()
    const isWeekend = todayDt.weekday === 6 || todayDt.weekday === 7
    const isHoliday = publicHolidayMap.has(today!)
    const hideDayWorkers = isWeekend || isHoliday

    const dayWorkerNames = dayWorkerDrafts.filter((name) => name.trim().length > 0 && !todayVacationNames.has(name.trim()))
    const hasShiftTeams = dayTeams.length > 0 || nightTeams.length > 0

    if (!hasShiftTeams && (hideDayWorkers || dayWorkerNames.length === 0)) {
      return null
    }

    const dayMembers = collectShiftMembers(dayTeams, shiftTeamDrafts).filter((name) => !todayVacationNames.has(name.trim()))
    const nightMembers = collectShiftMembers(nightTeams, shiftTeamDrafts).filter((name) => !todayVacationNames.has(name.trim()))
    const dayText = hasShiftTeams
      ? (dayMembers.length > 0 ? dayMembers.join(' · ') : `${dayTeams.join('·')}조 미지정`)
      : null
    const nightText = hasShiftTeams
      ? (nightMembers.length > 0 ? nightMembers.join(' · ') : `${nightTeams.join('·')}조 미지정`)
      : null
    const dayWorkerText = !hideDayWorkers && dayWorkerNames.length > 0 ? dayWorkerNames.join(' · ') : null

    return { dayText, nightText, dayWorkerText }
  }, [events, shiftTeamDrafts, dayWorkerDrafts, publicHolidayMap])

  const upcomingEventsByDate = useMemo(() => {
    const now = DateTime.now()
    const filtered = events
      .filter((event) => event.eventType !== '근무' && event.eventType !== '휴가' && event.eventType !== '반복업무' && event.eventType !== '공휴일' && event.eventType !== '기념일' && event.eventType !== '교육' && event.eventType !== '운용중지작업' && DateTime.fromISO(event.endAtUtc).toMillis() >= now.toMillis())
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
      .slice(0, 12)
    const grouped: { dateKey: string; dateLabel: string; events: typeof filtered }[] = []
    const seen = new Map<string, typeof filtered>()
    for (const event of filtered) {
      const dateKey = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()!
      if (!seen.has(dateKey)) {
        const list: typeof filtered = []
        seen.set(dateKey, list)
        grouped.push({
          dateKey,
          dateLabel: DateTime.fromISO(event.startAtUtc).toLocal().setLocale('ko').toFormat('M월 d일 (EEE)'),
          events: list,
        })
      }
      seen.get(dateKey)!.push(event)
    }
    return grouped
  }, [events])

  const monthVacationEvents = useMemo(() => {
    const monthEnd = visibleMonth.endOf('month')
    return events
      .filter((event) => {
        if (event.eventType !== '휴가') return false
        const start = DateTime.fromISO(event.startAtUtc).toLocal()
        const end = DateTime.fromISO(event.endAtUtc).toLocal()
        return start <= monthEnd && end >= visibleMonth
      })
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
  }, [events, visibleMonth])

  const monthEducationEvents = useMemo(() => {
    const monthEnd = visibleMonth.endOf('month')
    return events
      .filter((event) => {
        if (event.eventType !== '교육') return false
        const start = DateTime.fromISO(event.startAtUtc).toLocal()
        const end = DateTime.fromISO(event.endAtUtc).toLocal()
        return start <= monthEnd && end >= visibleMonth
      })
      .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
  }, [events, visibleMonth])

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
        .filter((event) => event.eventType !== '근무' && event.eventType !== '공휴일')
        .map((event) => {
          const isEducation = event.eventType === '교육'
          const isVacation = event.eventType === '휴가'
          let educationTargets: string[] = []
          let endDateDisplay: string | null = null
          let vacationTypeLabel: string | null = null

          if (isVacation) {
            const parsed = parseVacationInfo(event.description ?? '')
            vacationTypeLabel = parsed.vacationType

            if (vacationTypeLabel === '장기휴가') {
              const startDt = DateTime.fromISO(event.startAtUtc).toLocal()
              const endDt = DateTime.fromISO(event.endAtUtc).toLocal()
              const inclusiveEnd = endDt.hour === 0 && endDt.minute === 0 && endDt.second === 0
                ? endDt.minus({ days: 1 })
                : endDt
              if (inclusiveEnd.toISODate() !== startDt.toISODate()) {
                endDateDisplay = `~${String(inclusiveEnd.month).padStart(2, '0')}/${String(inclusiveEnd.day).padStart(2, '0')}`
              }
            }
          }

          if (isEducation) {
            const parsed = parseEducationTargets(event.description ?? '')
            educationTargets = parsed.targets

            const startDt = DateTime.fromISO(event.startAtUtc).toLocal()
            const endDt = DateTime.fromISO(event.endAtUtc).toLocal()
            const inclusiveEnd = endDt.hour === 0 && endDt.minute === 0 && endDt.second === 0
              ? endDt.minus({ days: 1 })
              : endDt
            if (inclusiveEnd.toISODate() !== startDt.toISODate()) {
              endDateDisplay = `~${String(inclusiveEnd.month).padStart(2, '0')}/${String(inclusiveEnd.day).padStart(2, '0')}`
            }
          }

          return {
            id: event.localId,
            title: event.summary,
            start: event.startAtUtc,
            end: event.endAtUtc,
            classNames: [
              ...(event.recurrenceRule || event.recurringEventId ? ['is-recurring'] : []),
              ...(event.eventType === '반복업무' ? ['is-routine'] : []),
              ...(event.eventType === '운용중지작업' ? ['is-maintenance'] : []),
              ...(event.eventType === '중요' ? ['is-important'] : []),
              ...(isEducation ? ['is-education'] : []),
              ...(isVacation ? ['is-vacation'] : []),
            ],
            extendedProps: {
              sortOrder: event.eventType === '운용중지작업' ? -1 : event.eventType === '중요' ? -1 : isEducation ? 2 : isVacation ? 3 : event.eventType === '반복업무' ? 1 : 0,
              isRoutine: event.eventType === '반복업무',
              isEducation,
              isVacation,
              educationTargets,
              endDateDisplay,
              vacationTypeLabel,
              completionKey: event.eventType === '반복업무'
                ? makeCompletionKey(event.localId, event.startAtUtc)
                : null,
            },
          }
        }),
    [events],
  )

  const allMemberNames = useMemo(() => {
    const names: string[] = []
    for (const worker of dayWorkerDrafts) {
      const trimmed = worker.trim()
      if (trimmed && !names.includes(trimmed)) names.push(trimmed)
    }
    for (const teamKey of shiftTeamKeys) {
      for (const member of shiftTeamDrafts[teamKey]) {
        const trimmed = member.trim()
        if (trimmed && !names.includes(trimmed)) names.push(trimmed)
      }
    }
    return names
  }, [shiftTeamDrafts, dayWorkerDrafts])

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
    const current = DateTime.fromJSDate(payload.view.currentStart)
    const monthLabel = current.setLocale('ko').toFormat('yyyy년 M월')
    setTitlebarMonthLabel(monthLabel)
    const nextMonth = current.startOf('month')
    setVisibleMonth((prev) => prev.toMillis() === nextMonth.toMillis() ? prev : nextMonth as DateTime<true>)
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

    const nextSummary = editingTitleDraftRef.current.trim()
    if (!nextSummary || nextSummary === targetEvent.summary) {
      cancelInlineTitleEdit()
      return
    }

    cancelInlineTitleEdit()

    // Optimistic update: immediately reflect the new title
    const masterLocalId = isVirtualInstance(localId) ? extractMasterLocalId(localId) : localId
    const calendarApi = calendarRef.current?.getApi()
    if (calendarApi) {
      for (const fcEvent of calendarApi.getEvents()) {
        const fcMaster = isVirtualInstance(fcEvent.id) ? extractMasterLocalId(fcEvent.id) : fcEvent.id
        if (fcMaster === masterLocalId) {
          fcEvent.setProp('title', nextSummary)
        }
      }
    }

    const editable = toEditableEvent(targetEvent)
    if (isVirtualInstance(localId)) {
      editable.recurrenceScope = 'ALL'
    }

    await saveEvent({
      ...editable,
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
          <div className="left-panel-cards">
          {todayShiftSummary ? (
            <section className="today-shift-card">
              <p className="today-shift-card-label">오늘의 근무자</p>
              {todayShiftSummary.dayWorkerText ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">일근</span>
                  <span className="today-shift-members">{todayShiftSummary.dayWorkerText}</span>
                </p>
              ) : null}
              {todayShiftSummary.dayText ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">주간</span>
                  <span className="today-shift-members">{todayShiftSummary.dayText}</span>
                </p>
              ) : null}
              {todayShiftSummary.nightText ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">야간</span>
                  <span className="today-shift-members">{todayShiftSummary.nightText}</span>
                </p>
              ) : null}
            </section>
          ) : null}
          <section className="stat-card">
            <div className="stat-value-row">
              <div>
                <p className="stat-label">오늘</p>
                <p className="stat-value">
                  <span>{todayCount}</span>
                  <small className="stat-value-unit">개 일정</small>
                </p>
              </div>
            </div>
            <ul className="today-list">
              {todayEvents.length === 0 ? (
                <li className="today-empty">당일 일정이 없습니다</li>
              ) : (
                todayEvents.map((event) => (
                  <li key={event.localId} className="today-item">
                    <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                      <span>{event.summary}</span>
                      {(() => {
                        const local = DateTime.fromISO(event.startAtUtc).toLocal()
                        return local.hour === 0 && local.minute === 0 ? null : (
                          <small>{local.setLocale('ko').toFormat('HH:mm')}</small>
                        )
                      })()}
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
            <div className="upcoming-list">
              {upcomingEventsByDate.length === 0 ? (
                <p className="empty-item">다가오는 일정이 없습니다</p>
              ) : (
                upcomingEventsByDate.map((group) => (
                  <div key={group.dateKey} className="upcoming-date-group">
                    <p className="upcoming-date-label">{group.dateLabel}</p>
                    <ul className="upcoming-date-events">
                      {group.events.map((event) => (
                        <li key={event.localId} className="upcoming-item">
                          <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                            <span>{event.summary}</span>
                            {(() => {
                              const local = DateTime.fromISO(event.startAtUtc).toLocal()
                              return local.hour === 0 && local.minute === 0 ? null : (
                                <small>{local.setLocale('ko').toFormat('HH:mm')}</small>
                              )
                            })()}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="vacation-card">
            <div className="card-row">
              <h2>휴가</h2>
              <span className="vacation-month-label">{visibleMonth.setLocale('ko').toFormat('M월')}</span>
            </div>
            <ul className="vacation-list">
              {monthVacationEvents.length === 0 ? (
                <li className="empty-item">이번 달 휴가가 없습니다</li>
              ) : (
                monthVacationEvents.map((event) => {
                  const startDt = DateTime.fromISO(event.startAtUtc).toLocal()
                  const endDt = DateTime.fromISO(event.endAtUtc).toLocal()
                  const inclusiveEnd = endDt.hour === 0 && endDt.minute === 0 && endDt.second === 0
                    ? endDt.minus({ days: 1 })
                    : endDt
                  const sameDay = startDt.toISODate() === inclusiveEnd.toISODate()
                  const dateLabel = sameDay
                    ? startDt.setLocale('ko').toFormat('M/d')
                    : `${startDt.setLocale('ko').toFormat('M/d')}~${inclusiveEnd.setLocale('ko').toFormat('M/d')}`
                  return (
                    <li key={event.localId} className="vacation-item">
                      <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                        <span>{event.summary}</span>
                        <small>{dateLabel}</small>
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </section>

          {monthEducationEvents.length > 0 ? (
            <section className="education-card">
              <div className="card-row">
                <h2>교육</h2>
                <span className="vacation-month-label">{visibleMonth.setLocale('ko').toFormat('M월')}</span>
              </div>
              <ul className="education-list">
                {monthEducationEvents.map((event) => {
                  const startDt = DateTime.fromISO(event.startAtUtc).toLocal()
                  const endDt = DateTime.fromISO(event.endAtUtc).toLocal()
                  const inclusiveEnd = endDt.hour === 0 && endDt.minute === 0 && endDt.second === 0
                    ? endDt.minus({ days: 1 })
                    : endDt
                  const sameDay = startDt.toISODate() === inclusiveEnd.toISODate()
                  const dateLabel = sameDay
                    ? startDt.setLocale('ko').toFormat('M/d')
                    : `${startDt.setLocale('ko').toFormat('M/d')}~${inclusiveEnd.setLocale('ko').toFormat('M/d')}`
                  const { targets } = parseEducationTargets(event.description ?? '')
                  return (
                    <li key={event.localId} className="education-item">
                      <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                        <span className="education-item-content">
                          {targets.length > 0 ? (
                            <span className="education-item-names">{targets.join(', ')}</span>
                          ) : null}
                          <span>{event.summary}</span>
                        </span>
                        <small>{dateLabel}</small>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
          </div>

          <div className="left-panel-bottom">
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
          </div>
        </aside>

        <main className="calendar-panel" onWheel={handleCalendarWheel} onContextMenu={(e) => {
          const target = e.target as HTMLElement
          const dayCell = target.closest<HTMLElement>('[data-date]')
          if (!dayCell) return
          e.preventDefault()
          if (editingTitleEventId) return
          const dateStr = dayCell.getAttribute('data-date')
          if (!dateStr) return
          const startAtUtc = DateTime.fromISO(dateStr).toUTC().toISO() ?? new Date().toISOString()
          const endAtUtc = DateTime.fromISO(dateStr).plus({ days: 1 }).toUTC().toISO() ?? new Date(Date.now() + 86400000).toISOString()
          setEditingEvent(createDraft(startAtUtc, endAtUtc))
        }}>
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, interactionPlugin]}
            locales={[koLocale]}
            locale="ko"
            initialView="dayGridMonth"
            selectable={false}
            editable={false}
            eventStartEditable={false}
            eventDurationEditable={false}
            height="100%"
            expandRows
            fixedWeekCount={false}
            showNonCurrentDates
          dayMaxEvents
          eventOrder="sortOrder"
          events={calendarEvents}
          eventContent={(arg) => {
            const isEditing = editingTitleEventId === arg.event.id
            if (!isEditing) {
              const isRoutine = arg.event.extendedProps?.isRoutine === true
              const isEducation = arg.event.extendedProps?.isEducation === true
              const completionKey = arg.event.extendedProps?.completionKey as string | null
              const isDone = completionKey ? routineCompletions.has(completionKey) : false

              if (isEducation) {
                const targets = (arg.event.extendedProps?.educationTargets as string[]) ?? []
                const endLabel = arg.event.extendedProps?.endDateDisplay as string | null
                return (
                  <div className="fc-education-content">
                    {targets.length > 0 && (
                      <span className="fc-education-targets">
                        {targets.map((t) => <span key={t} className="fc-education-target-pill">{t}</span>)}
                      </span>
                    )}
                    <span className="fc-education-title">{arg.event.title}</span>
                    {endLabel && <span className="fc-education-until">{endLabel}</span>}
                  </div>
                )
              }

              const isVacationEvent = arg.event.extendedProps?.isVacation === true
              if (isVacationEvent) {
                const typeLabel = arg.event.extendedProps?.vacationTypeLabel as string | null
                const vacEndLabel = arg.event.extendedProps?.endDateDisplay as string | null
                const displayTitle = typeLabel
                  ? arg.event.title.replace(typeLabel, '').replace(/\s+/g, ' ').trim()
                  : arg.event.title
                const timeMatch = typeLabel?.match(/^(시간차)\((.+)\)$/)
                return (
                  <div className="fc-vacation-content">
                    {typeLabel && (
                      timeMatch ? (
                        <span className="fc-vacation-type-pill">{timeMatch[1]}<span className="fc-vacation-time">{timeMatch[2]}</span></span>
                      ) : (
                        <span className="fc-vacation-type-pill">{typeLabel}</span>
                      )
                    )}
                    <span className="fc-vacation-title">
                      {displayTitle || arg.event.title}
                      {vacEndLabel && <span className="fc-vacation-until">{vacEndLabel}</span>}
                    </span>
                  </div>
                )
              }

              return (
                <div className="fc-event-title-inline-wrap">
                  {isRoutine ? (
                    <span
                      className={isDone ? 'fc-routine-check is-done' : 'fc-routine-check'}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        if (completionKey) toggleRoutineCompletion(completionKey)
                      }}
                    >
                      {isDone ? (
                        <svg width="19" height="19" viewBox="0 0 16 16" fill="none">
                          <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.15" />
                          <path d="M4.5 8.5L7 11L11.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="19" height="19" viewBox="0 0 16 16" fill="none">
                          <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      )}
                    </span>
                  ) : null}
                  <span className={isDone ? 'fc-event-title-inline-text is-routine-done' : 'fc-event-title-inline-text'}>
                    {arg.event.title}
                  </span>
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

            // Auto-fit font size: max 18px, scale down if text overflows
            const textEl = arg.el.querySelector('.fc-event-title-inline-text, .fc-education-title, .fc-vacation-title') as HTMLElement | null
            if (textEl) {
              requestAnimationFrame(() => {
                if (textEl.scrollWidth > textEl.clientWidth) {
                  const ratio = textEl.clientWidth / textEl.scrollWidth
                  const fitted = Math.max(11, Math.floor(18 * ratio))
                  textEl.style.fontSize = `${fitted}px`
                }
              })
            }

            let tip: HTMLDivElement | null = null
            const showTip = (e: MouseEvent) => {
              if (!tip) {
                tip = document.createElement('div')
                tip.textContent = '우클릭으로 상세편집'
                Object.assign(tip.style, {
                  position: 'fixed',
                  padding: '4px 8px',
                  background: 'rgba(0,0,0,0.78)',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: '500',
                  whiteSpace: 'nowrap',
                  borderRadius: '4px',
                  pointerEvents: 'none',
                  zIndex: '99999',
                })
                document.body.appendChild(tip)
              }
              tip.style.left = `${e.clientX + 10}px`
              tip.style.top = `${e.clientY + 10}px`
            }
            const hideTip = () => { tip?.remove(); tip = null }
            const onEnter = (e: Event) => showTip(e as MouseEvent)
            const onMove = (e: Event) => showTip(e as MouseEvent)
            arg.el.addEventListener('pointerenter', onEnter)
            arg.el.addEventListener('pointermove', onMove)
            arg.el.addEventListener('pointerleave', hideTip)
            arg.el.oncontextmenu = (event) => {
              event.preventDefault()
              event.stopPropagation()
              hideTip()
              const selected = eventsRef.current.find((item) => item.localId === arg.event.id)
              if (!selected) {
                return
              }
              cancelInlineTitleEdit()
              setEditingEvent(toEditableEvent(selected))
            }
            ;(arg.el as any)._tipCleanup = () => {
              hideTip()
              arg.el.removeEventListener('pointerenter', onEnter)
              arg.el.removeEventListener('pointermove', onMove)
              arg.el.removeEventListener('pointerleave', hideTip)
            }
          }}
          eventWillUnmount={(arg) => {
            ;(arg.el as any)._tipCleanup?.()
            arg.el.oncontextmenu = null
          }}
          dayCellContent={(arg) => {
            const dateKey = DateTime.fromJSDate(arg.date).toISODate()
            const shiftLabel = dateKey ? shiftLabelByDate.get(dateKey) : null
            const holidayName = dateKey ? publicHolidayMap.get(dateKey) : undefined
            const isHoliday = holidayName !== undefined
            return (
              <>
                <span className={isHoliday ? 'fc-day-number-text is-public-holiday' : 'fc-day-number-text'}>{arg.dayNumberText.replace('일', '')}</span>
                {shiftLabel ? <span className="fc-day-shift-inline">{shiftLabel}</span> : null}
                {holidayName ? <span className="fc-day-holiday-pill">{holidayName}</span> : null}
              </>
            )
          }}
          headerToolbar={false}
          datesSet={handleDatesSet}
            eventClick={(info: EventClickArg) => {
              info.jsEvent.preventDefault()
              info.jsEvent.stopPropagation()
              // Ignore clicks on routine checkbox
              const target = info.jsEvent.target as HTMLElement
              if (target.closest('.fc-routine-check')) {
                return
              }
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
        memberNames={allMemberNames}
        onClose={() => setEditingEvent(null)}
        onSave={async (event) => {
          await saveEvent(event)
          setEditingEvent(null)
        }}
        onDelete={async (localId, sendUpdates, recurrenceScope) => {
          await deleteEvent(localId, sendUpdates, recurrenceScope)
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
