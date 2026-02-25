import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import koLocale from '@fullcalendar/core/locales/ko'
import { DateTime } from 'luxon'
import { type WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DatesSetArg, EventClickArg } from '@fullcalendar/core'
import type { CalendarEvent, RecurrenceEditScope, ShiftTeamAssignments, ShiftTeamMode, UpsertCalendarEventInput } from '../../shared/calendar'
import { expandRecurringEvents, isVirtualInstance, extractMasterLocalId } from '../../shared/expandRecurrence'
import { isPublicHolidayName, FIXED_PUBLIC_HOLIDAY_MMDD } from '../../shared/koreanHolidays'
import { EventModal, type EditableEvent } from '../components/EventModal'
import { RadialMenu } from '../components/RadialMenu'
import { SubstitutionFlow } from '../components/SubstitutionFlow'
import { WeatherOverlay, type WeatherOverlayMode } from '../components/WeatherOverlay'
import { parseEducationTargets } from '../utils/parseEducationTargets'
import { parseRoutineCompletions, serializeRoutineCompletions } from '../utils/parseRoutineCompletions'
import { parseVacationInfo } from '../utils/parseVacationInfo'
import { SettingsModal } from '../components/SettingsModal'
import { SyncModal } from '../components/SyncModal'
import { useCalendarStore } from '../state/useCalendarStore'

const LEGACY_ROUTINE_COMPLETIONS_KEY = 'routineCompletions'
const LEGACY_ROUTINE_COMPLETION_KEY_PATTERN = /^(.+)::(\d{4}-\d{2}-\d{2})$/
const GIMPO_AIRPORT_WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=37.5583&longitude=126.7906&current=weather_code,precipitation,rain,snowfall&timezone=Asia%2FSeoul&forecast_days=1'

const RAIN_WEATHER_CODES = new Set<number>([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82])
const SNOW_WEATHER_CODES = new Set<number>([71, 73, 75, 77, 85, 86])

interface GimpoCurrentWeatherResponse {
  current?: {
    weather_code?: number
    precipitation?: number
    rain?: number
    snowfall?: number
  }
}

function toWeatherOverlayMode(payload: GimpoCurrentWeatherResponse): WeatherOverlayMode {
  const current = payload.current
  if (!current) {
    return 'none'
  }

  const weatherCode = typeof current.weather_code === 'number' ? current.weather_code : -1
  const snowfall = typeof current.snowfall === 'number' ? current.snowfall : 0
  const rainfall = typeof current.rain === 'number' ? current.rain : 0
  const precipitation = typeof current.precipitation === 'number' ? current.precipitation : 0

  if (SNOW_WEATHER_CODES.has(weatherCode) || snowfall > 0.01) {
    return 'snow'
  }

  if (RAIN_WEATHER_CODES.has(weatherCode) || rainfall > 0.01 || precipitation > 0.01) {
    return 'rain'
  }

  return 'none'
}

function loadLegacyRoutineCompletionKeys(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_ROUTINE_COMPLETIONS_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((value): value is string => typeof value === 'string' && value.includes('::'))
  } catch {
    return []
  }
}

function saveLegacyRoutineCompletionKeys(keys: string[]): void {
  if (keys.length === 0) {
    localStorage.removeItem(LEGACY_ROUTINE_COMPLETIONS_KEY)
    return
  }
  localStorage.setItem(LEGACY_ROUTINE_COMPLETIONS_KEY, JSON.stringify(keys))
}

function parseLegacyRoutineCompletionKey(rawKey: string): { localId: string; completionDate: string } | null {
  const match = rawKey.match(LEGACY_ROUTINE_COMPLETION_KEY_PATTERN)
  if (!match) {
    return null
  }
  return {
    localId: match[1],
    completionDate: match[2],
  }
}

function resolveRoutineSourceEvent(targetEvent: CalendarEvent, events: CalendarEvent[]): CalendarEvent {
  if (isVirtualInstance(targetEvent.localId)) {
    const master = events.find((event) => event.localId === extractMasterLocalId(targetEvent.localId))
    if (master) {
      return master
    }
  }

  if (targetEvent.recurringEventId) {
    const master = events.find(
      (event) =>
        event.googleEventId != null
        && event.googleEventId === targetEvent.recurringEventId
        && event.recurrenceRule != null
        && event.recurringEventId == null,
    )
    if (master) {
      return master
    }
  }

  return targetEvent
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

const UNDO_STACK_LIMIT = 100

type UndoOperation =
  | {
    type: 'delete'
    localId: string
    recurrenceScope: RecurrenceEditScope
  }
  | {
    type: 'save'
    payload: UpsertCalendarEventInput
  }

function cloneEventsSnapshot(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((event) => ({
    ...event,
    attendees: [...event.attendees],
  }))
}

function isSameEventContent(left: CalendarEvent, right: CalendarEvent): boolean {
  if (left.localId !== right.localId) return false
  if (left.googleEventId !== right.googleEventId) return false
  if (left.eventType !== right.eventType) return false
  if (left.summary !== right.summary) return false
  if ((left.description ?? '') !== (right.description ?? '')) return false
  if ((left.location ?? '') !== (right.location ?? '')) return false
  if (left.startAtUtc !== right.startAtUtc) return false
  if (left.endAtUtc !== right.endAtUtc) return false
  if (left.timeZone !== right.timeZone) return false
  if ((left.recurrenceRule ?? null) !== (right.recurrenceRule ?? null)) return false
  if ((left.recurringEventId ?? null) !== (right.recurringEventId ?? null)) return false
  if ((left.originalStartTimeUtc ?? null) !== (right.originalStartTimeUtc ?? null)) return false
  if (left.attendees.length !== right.attendees.length) return false
  for (let index = 0; index < left.attendees.length; index += 1) {
    if (left.attendees[index] !== right.attendees[index]) return false
  }
  return true
}

function inferDeleteScopeForUndo(event: CalendarEvent): RecurrenceEditScope {
  if (event.recurringEventId) {
    return 'THIS'
  }
  return 'ALL'
}

function toUndoUpsertInput(event: CalendarEvent): UpsertCalendarEventInput {
  const editable = toEditableEvent(event)
  return {
    ...editable,
    attendees: [...editable.attendees],
    sendUpdates: 'none',
    recurrenceScope: editable.recurringEventId ? 'THIS' : 'ALL',
  }
}

function buildUndoOperations(before: CalendarEvent[], after: CalendarEvent[]): UndoOperation[] {
  const beforeById = new Map(before.map((event) => [event.localId, event] as const))
  const afterById = new Map(after.map((event) => [event.localId, event] as const))

  const deleteOps: UndoOperation[] = []
  for (const event of after) {
    if (!beforeById.has(event.localId)) {
      deleteOps.push({
        type: 'delete',
        localId: event.localId,
        recurrenceScope: inferDeleteScopeForUndo(event),
      })
    }
  }

  const restoreEvents: CalendarEvent[] = []
  for (const event of before) {
    const current = afterById.get(event.localId)
    if (!current || !isSameEventContent(event, current)) {
      restoreEvents.push(event)
    }
  }
  restoreEvents.sort((left, right) => Number(Boolean(left.recurringEventId)) - Number(Boolean(right.recurringEventId)))
  const saveOps: UndoOperation[] = restoreEvents.map((event) => ({
    type: 'save',
    payload: toUndoUpsertInput(event),
  }))

  return [...deleteOps, ...saveOps]
}

interface TodayShiftOverride {
  dayWorkerText?: string
  dayText?: string
  nightText?: string
}

function loadTodayShiftOverride(dateKey: string): TodayShiftOverride | null {
  try {
    const raw = localStorage.getItem(`todayShiftOverride::${dateKey}`)
    if (!raw) return null
    return JSON.parse(raw) as TodayShiftOverride
  } catch {
    return null
  }
}

function saveTodayShiftOverride(dateKey: string, overrides: TodayShiftOverride): void {
  localStorage.setItem(`todayShiftOverride::${dateKey}`, JSON.stringify(overrides))
}

function clearTodayShiftOverride(dateKey: string): void {
  localStorage.removeItem(`todayShiftOverride::${dateKey}`)
}

const shiftTeamKeys = ['A', 'B', 'C', 'D'] as const
type ShiftTeamKey = (typeof shiftTeamKeys)[number]
type SubstitutionWorkType = '대리근무' | '대체근무'

interface ShiftSubstitutionMeta {
  substitute: string
  type: SubstitutionWorkType
  original: string
}

interface ShiftDescriptionState {
  baseLines: string[]
  substitutions: ShiftSubstitutionMeta[]
}

interface ShiftBadgeSelection {
  eventLocalId: string
  substitutionIndex: number
  team: ShiftTeamKey
  substitute: string
  type: SubstitutionWorkType
  original: string
}

function parseShiftBadgeSelection(badgeEl: HTMLElement): ShiftBadgeSelection | null {
  const eventLocalId = badgeEl.dataset.shiftBadgeEvent
  const substitutionIndexRaw = badgeEl.dataset.shiftBadgeIndex
  const substitutionIndex = substitutionIndexRaw ? Number.parseInt(substitutionIndexRaw, 10) : Number.NaN
  const teamRaw = badgeEl.dataset.shiftBadgeTeam
  const substitute = badgeEl.dataset.shiftBadgeSubstitute?.trim()
  const original = badgeEl.dataset.shiftBadgeOriginal?.trim()
  const typeRaw = badgeEl.dataset.shiftBadgeType

  const team: ShiftTeamKey | null =
    teamRaw === 'A' || teamRaw === 'B' || teamRaw === 'C' || teamRaw === 'D'
      ? teamRaw
      : null
  const type: SubstitutionWorkType | null =
    typeRaw === '대리근무' || typeRaw === '대체근무'
      ? typeRaw
      : null

  if (
    !eventLocalId
    || !Number.isInteger(substitutionIndex)
    || !team
    || !substitute
    || !original
    || !type
  ) {
    return null
  }

  return {
    eventLocalId,
    substitutionIndex,
    team,
    substitute,
    type,
    original,
  }
}

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

function parseShiftDescriptionState(description: string): ShiftDescriptionState {
  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const baseLines: string[] = []
  const substitutions: ShiftSubstitutionMeta[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const substituteMatch = lines[index].match(/^대체근무자\s*:\s*(.+)$/)
    if (!substituteMatch) {
      baseLines.push(lines[index])
      continue
    }

    const typeMatch = lines[index + 1]?.match(/^근무종류\s*:\s*(대리근무|대체근무)$/)
    const originalMatch = lines[index + 2]?.match(/^원근무자\s*:\s*(.+)$/)
    if (!typeMatch || !originalMatch) {
      baseLines.push(lines[index])
      continue
    }

    const substitute = substituteMatch[1].trim()
    const original = originalMatch[1].trim()
    if (!substitute || !original) {
      baseLines.push(lines[index])
      continue
    }

    substitutions.push({
      substitute,
      type: typeMatch[1] as SubstitutionWorkType,
      original,
    })
    index += 2
  }

  return {
    baseLines,
    substitutions,
  }
}

function serializeShiftDescriptionState(state: ShiftDescriptionState): string {
  const base = state.baseLines.map((line) => line.trim()).filter((line) => line.length > 0)
  const substitutionLines = state.substitutions.flatMap((entry) => [
    `대체근무자: ${entry.substitute}`,
    `근무종류: ${entry.type}`,
    `원근무자: ${entry.original}`,
  ])
  return [...base, ...substitutionLines].join('\n')
}

function collectShiftMembersWithSubstitutions(
  teamKeys: ShiftTeamKey[],
  teams: ShiftTeamAssignments,
  substitutionsByTeamOriginal: Map<string, string>,
): string[] {
  const members: string[] = []
  for (const teamKey of teamKeys) {
    for (const rawName of teams[teamKey]) {
      const originalName = rawName.trim()
      if (!originalName) {
        continue
      }

      const replacedName = substitutionsByTeamOriginal.get(`${teamKey}:${originalName}`)?.trim() || originalName
      if (!replacedName || members.includes(replacedName)) {
        continue
      }
      members.push(replacedName)
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

const CALENDAR_RENDER_PADDING_MONTHS = 1

function buildCalendarRenderRange(visibleMonth: DateTime) {
  return {
    rangeStartUtc:
      visibleMonth.startOf('month').minus({ months: CALENDAR_RENDER_PADDING_MONTHS }).toUTC().toISO()
      ?? DateTime.utc().minus({ months: CALENDAR_RENDER_PADDING_MONTHS + 1 }).toISO()
      ?? new Date().toISOString(),
    rangeEndUtc:
      visibleMonth.endOf('month').plus({ months: CALENDAR_RENDER_PADDING_MONTHS }).toUTC().toISO()
      ?? DateTime.utc().plus({ months: CALENDAR_RENDER_PADDING_MONTHS + 1 }).toISO()
      ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

function buildTodayContextRange() {
  return {
    rangeStartUtc:
      DateTime.local().minus({ months: 3 }).startOf('day').toUTC().toISO()
      ?? DateTime.utc().minus({ months: 3 }).startOf('day').toISO()
      ?? new Date().toISOString(),
    rangeEndUtc:
      DateTime.local().plus({ months: 6 }).endOf('day').toUTC().toISO()
      ?? DateTime.utc().plus({ months: 6 }).endOf('day').toISO()
      ?? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

function eventOverlapsRange(event: CalendarEvent, rangeStartUtc: string, rangeEndUtc: string): boolean {
  const eventStart = Date.parse(event.startAtUtc)
  const eventEnd = Date.parse(event.endAtUtc)
  const rangeStart = Date.parse(rangeStartUtc)
  const rangeEnd = Date.parse(rangeEndUtc)
  if (
    Number.isNaN(eventStart)
    || Number.isNaN(eventEnd)
    || Number.isNaN(rangeStart)
    || Number.isNaN(rangeEnd)
  ) {
    return true
  }
  return eventEnd >= rangeStart && eventStart <= rangeEnd
}

function expandEventsInRange(events: CalendarEvent[], rangeStartUtc: string, rangeEndUtc: string): CalendarEvent[] {
  const candidates = events.filter((event) => {
    if (event.recurrenceRule && !event.recurringEventId) {
      return true
    }
    return eventOverlapsRange(event, rangeStartUtc, rangeEndUtc)
  })

  return expandRecurringEvents(candidates, rangeStartUtc, rangeEndUtc)
    .filter((event) => eventOverlapsRange(event, rangeStartUtc, rangeEndUtc))
    .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
}

export function CalendarPage() {
  const {
    allEvents,
    events,
    loading,
    syncing,
    forcePushing,
    selectingCalendar,
    googleConnected,
    accountEmail,
    calendars,
    selectedCalendarId,
    selectedCalendarSummary,
    shiftSettings,
    savingShiftSettings,
    lastSyncResult,
    lastForcePushResult,
    outboxCount,
    outboxJobs,
    loadingOutboxJobs,
    setEventRenderRange,
    hydrate,
    refreshOutboxJobs,
    cancelOutboxJob,
    saveEvent,
    deleteEvent,
    syncNow,
    forcePushAll,
    setSyncCalendar,
    setShiftType,
    setShiftTeamMode,
    setDayWorkerCount,
    setShiftAssignments,
    connectGoogle,
    disconnectGoogle,
  } = useCalendarStore()

  const [routineDoneOverrides, setRoutineDoneOverrides] = useState<Map<string, boolean>>(new Map())
  const [editingEvent, setEditingEvent] = useState<EditableEvent | null>(null)
  const [radialMenu, setRadialMenu] = useState<{ anchor: { x: number; y: number }; dateStr: string } | null>(null)
  const [substitutionFlow, setSubstitutionFlow] = useState<{
    anchor: { x: number; y: number }
    dateStr: string
    shiftEvent: CalendarEvent
  } | null>(null)
  const [editingShiftBadge, setEditingShiftBadge] = useState<{
    anchor: { x: number; y: number }
    eventLocalId: string
    substitutionIndex: number
    team: ShiftTeamKey
    substitute: string
    type: SubstitutionWorkType
    original: string
  } | null>(null)
  const [editingTitleEventId, setEditingTitleEventId] = useState<string | null>(null)
  const [editingTitleDraft, setEditingTitleDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [weatherOverlayMode, setWeatherOverlayMode] = useState<WeatherOverlayMode>('none')
  const [weatherPreviewMode, setWeatherPreviewMode] = useState<WeatherOverlayMode | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [titlebarMonthLabel, setTitlebarMonthLabel] = useState(() =>
    DateTime.local().setLocale('ko').toFormat('yyyy년 M월'),
  )
  const [visibleMonth, setVisibleMonth] = useState(() => DateTime.local().startOf('month'))
  const [shiftTeamDrafts, setShiftTeamDrafts] = useState<ShiftTeamAssignments>(() =>
    cloneShiftTeams(shiftSettings.teams),
  )
  const [dayWorkerDrafts, setDayWorkerDrafts] = useState<string[]>(() => [...shiftSettings.dayWorkers])
  const [todayShiftOverrides, setTodayShiftOverrides] = useState<TodayShiftOverride | null>(() => {
    const todayKey = DateTime.local().toISODate()
    return todayKey ? loadTodayShiftOverride(todayKey) : null
  })
  const [editingTodayShiftRow, setEditingTodayShiftRow] = useState<'dayWorker' | 'day' | 'night' | null>(null)
  const [editingTodayShiftDraft, setEditingTodayShiftDraft] = useState('')
  const calendarRef = useRef<FullCalendar | null>(null)
  const eventsRef = useRef<CalendarEvent[]>(events)
  const allEventsRef = useRef<CalendarEvent[]>(allEvents)
  const legacyRoutineMigrationRunningRef = useRef(false)
  const shiftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShiftSaveRef = useRef<{
    teams: ShiftTeamAssignments
    dayWorkers: string[]
  } | null>(null)
  const monthWheelLockRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editingTitleDraftRef = useRef('')
  const undoStackRef = useRef<UndoOperation[][]>([])
  const applyingUndoRef = useRef(false)
  editingTitleDraftRef.current = editingTitleDraft
  const effectiveWeatherOverlayMode = weatherPreviewMode ?? weatherOverlayMode

  const captureAllEventsSnapshot = useCallback(() => {
    return cloneEventsSnapshot(useCalendarStore.getState().allEvents)
  }, [])

  const pushUndoOperations = useCallback((operations: UndoOperation[]) => {
    if (operations.length === 0) {
      return
    }
    undoStackRef.current = [...undoStackRef.current, operations].slice(-UNDO_STACK_LIMIT)
  }, [])

  const runWithSnapshotUndoTracking = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    const before = captureAllEventsSnapshot()
    const result = await task()
    const after = captureAllEventsSnapshot()
    pushUndoOperations(buildUndoOperations(before, after))
    return result
  }, [captureAllEventsSnapshot, pushUndoOperations])

  const saveEventWithUndo = useCallback(async (payload: UpsertCalendarEventInput, trackUndo = true) => {
    if (!trackUndo || applyingUndoRef.current) {
      return saveEvent(payload)
    }

    const beforeEvent = payload.localId
      ? useCalendarStore.getState().allEvents.find((event) => event.localId === payload.localId) ?? null
      : null

    if (payload.recurrenceScope === 'FUTURE') {
      return runWithSnapshotUndoTracking(() => saveEvent(payload))
    }

    const saved = await saveEvent(payload)
    if (!beforeEvent) {
      pushUndoOperations([{
        type: 'delete',
        localId: saved.localId,
        recurrenceScope: inferDeleteScopeForUndo(saved),
      }])
      return saved
    }

    if (!isSameEventContent(beforeEvent, saved)) {
      pushUndoOperations([{
        type: 'save',
        payload: toUndoUpsertInput(beforeEvent),
      }])
    }

    return saved
  }, [pushUndoOperations, runWithSnapshotUndoTracking, saveEvent])

  const deleteEventWithUndo = useCallback(async (
    localId: string,
    sendUpdates: 'all' | 'none' = 'none',
    recurrenceScope?: RecurrenceEditScope,
    trackUndo = true,
  ) => {
    if (!trackUndo || applyingUndoRef.current) {
      await deleteEvent(localId, sendUpdates, recurrenceScope)
      return
    }

    const beforeEvent = useCalendarStore.getState().allEvents.find((event) => event.localId === localId) ?? null
    if (!beforeEvent) {
      await deleteEvent(localId, sendUpdates, recurrenceScope)
      return
    }

    const hasRecurringContext = Boolean(beforeEvent.recurrenceRule) || Boolean(beforeEvent.recurringEventId)
    const effectiveScope = hasRecurringContext ? (recurrenceScope ?? 'ALL') : 'ALL'
    const shouldUseSnapshot = hasRecurringContext && (effectiveScope === 'ALL' || effectiveScope === 'FUTURE')
    if (shouldUseSnapshot) {
      await runWithSnapshotUndoTracking(() => deleteEvent(localId, sendUpdates, recurrenceScope))
      return
    }

    await deleteEvent(localId, sendUpdates, recurrenceScope)
    const stillExists = useCalendarStore.getState().allEvents.some((event) => event.localId === localId)
    if (!stillExists) {
      pushUndoOperations([{
        type: 'save',
        payload: toUndoUpsertInput(beforeEvent),
      }])
    }
  }, [deleteEvent, pushUndoOperations, runWithSnapshotUndoTracking])

  const undoLastEventMutation = useCallback(async () => {
    if (applyingUndoRef.current) {
      return
    }
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry) {
      return
    }

    undoStackRef.current = undoStackRef.current.slice(0, -1)
    applyingUndoRef.current = true
    try {
      for (const operation of entry) {
        if (operation.type === 'delete') {
          await deleteEvent(operation.localId, 'none', operation.recurrenceScope)
          continue
        }
        await saveEvent(operation.payload)
      }
    } catch (error) {
      undoStackRef.current = [...undoStackRef.current, entry].slice(-UNDO_STACK_LIMIT)
      console.error('Failed to undo calendar mutation.', error)
    } finally {
      applyingUndoRef.current = false
    }
  }, [deleteEvent, saveEvent])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    const { rangeStartUtc, rangeEndUtc } = buildCalendarRenderRange(visibleMonth)
    setEventRenderRange(rangeStartUtc, rangeEndUtc)
  }, [setEventRenderRange, visibleMonth])

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
    let isDisposed = false

    const refreshWeather = async () => {
      try {
        const response = await fetch(GIMPO_AIRPORT_WEATHER_URL, { cache: 'no-store' })
        if (!response.ok) {
          return
        }
        const payload = (await response.json()) as GimpoCurrentWeatherResponse
        if (isDisposed) {
          return
        }
        setWeatherOverlayMode(toWeatherOverlayMode(payload))
      } catch {
        // Keep the last rendered weather mode if network/API lookup fails.
      }
    }

    void refreshWeather()
    const intervalId = window.setInterval(() => {
      void refreshWeather()
    }, 10 * 60 * 1000)

    return () => {
      isDisposed = true
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    setShiftTeamDrafts(cloneShiftTeams(shiftSettings.teams))
    setDayWorkerDrafts([...shiftSettings.dayWorkers])
  }, [shiftSettings])

  useEffect(() => {
    eventsRef.current = events
  }, [events])

  useEffect(() => {
    allEventsRef.current = allEvents
  }, [allEvents])

  useEffect(() => {
    if (loading || legacyRoutineMigrationRunningRef.current) {
      return
    }

    const legacyKeys = loadLegacyRoutineCompletionKeys()
    if (legacyKeys.length === 0) {
      return
    }

    legacyRoutineMigrationRunningRef.current = true

    void (async () => {
      type LegacyGroup = {
        sourceEvent: CalendarEvent
        completionDates: Set<string>
        rawKeys: Set<string>
      }

      const currentEvents = allEventsRef.current
      const groupedBySourceId = new Map<string, LegacyGroup>()
      const remainingKeys = new Set<string>()

      try {
        for (const rawKey of legacyKeys) {
          const parsedKey = parseLegacyRoutineCompletionKey(rawKey)
          if (!parsedKey) {
            continue
          }

          const keyLocalId = isVirtualInstance(parsedKey.localId)
            ? extractMasterLocalId(parsedKey.localId)
            : parsedKey.localId
          const keyEvent = currentEvents.find((event) => event.localId === keyLocalId)
          if (!keyEvent) {
            remainingKeys.add(rawKey)
            continue
          }

          const sourceEvent = resolveRoutineSourceEvent(keyEvent, currentEvents)
          const group = groupedBySourceId.get(sourceEvent.localId) ?? {
            sourceEvent,
            completionDates: new Set<string>(),
            rawKeys: new Set<string>(),
          }
          group.completionDates.add(parsedKey.completionDate)
          group.rawKeys.add(rawKey)
          groupedBySourceId.set(sourceEvent.localId, group)
        }

        for (const group of groupedBySourceId.values()) {
          if (group.sourceEvent.eventType !== '반복업무') {
            continue
          }

          const parsedDescription = parseRoutineCompletions(group.sourceEvent.description ?? '')
          const mergedDates = new Set(parsedDescription.completedDates)
          for (const date of group.completionDates) {
            mergedDates.add(date)
          }

          const nextDescription = serializeRoutineCompletions([...mergedDates], parsedDescription.cleanDescription)
          if (nextDescription === (group.sourceEvent.description ?? '')) {
            continue
          }

          try {
            await saveEvent({
              ...toEditableEvent(group.sourceEvent),
              description: nextDescription,
              sendUpdates: 'none',
              recurrenceScope: 'ALL',
            })
          } catch {
            for (const rawKey of group.rawKeys) {
              remainingKeys.add(rawKey)
            }
          }
        }
      } finally {
        saveLegacyRoutineCompletionKeys([...remainingKeys])
        legacyRoutineMigrationRunningRef.current = false
      }
    })()
  }, [allEvents, loading, saveEvent])

  useEffect(() => {
    if (routineDoneOverrides.size === 0) {
      return
    }

    setRoutineDoneOverrides((prev) => {
      if (prev.size === 0) {
        return prev
      }

      const next = new Map(prev)
      for (const [localId, overrideDone] of prev.entries()) {
        const event = events.find((item) => item.localId === localId)
        if (!event) {
          next.delete(localId)
          continue
        }
        const parsed = parseRoutineCompletions(event.description ?? '')
        const completionDate = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
        const persistedDone = Boolean(completionDate && parsed.completedDates.includes(completionDate))
        if (persistedDone === overrideDone) {
          next.delete(localId)
        }
      }

      return next.size === prev.size ? prev : next
    })
  }, [events, routineDoneOverrides.size])

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

  useEffect(() => {
    if (!editingShiftBadge) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('.shift-badge-inline-editor') || target.closest('.fc-day-shift-badge')) {
        return
      }
      setEditingShiftBadge(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setEditingShiftBadge(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [editingShiftBadge])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (key !== 'z') {
        return
      }
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) {
        return
      }

      const target = event.target as HTMLElement | null
      if (
        target?.isContentEditable
        || Boolean(target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
      ) {
        return
      }

      event.preventDefault()
      void undoLastEventMutation()
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [undoLastEventMutation])

  const todayContextEvents = useMemo(() => {
    const { rangeStartUtc, rangeEndUtc } = buildTodayContextRange()
    return expandEventsInRange(allEvents, rangeStartUtc, rangeEndUtc)
  }, [allEvents])

  const todayEvents = useMemo(() => {
    const today = DateTime.local().toISODate()
    return todayContextEvents
      .filter((event) => event.eventType !== '근무' && event.eventType !== '휴가' && DateTime.fromISO(event.startAtUtc).toLocal().toISODate() === today)
  }, [todayContextEvents])
  const todayCount = todayEvents.length

  const publicHolidayMap = useMemo(() => {
    const map = new Map<string, string>()

    // Google 동기화 데이터 기반: 공휴일 이벤트 중 법정공휴일만 수집
    for (const sourceEvents of [events, todayContextEvents]) {
      for (const event of sourceEvents) {
        if (event.eventType !== '공휴일') continue
        if (!isPublicHolidayName(event.summary)) continue
        const isoDate = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
        if (isoDate && !map.has(isoDate)) map.set(isoDate, event.summary)
      }
    }

    // 오프라인 fallback: 현재 연도 기준 고정 날짜 공휴일
    const year = DateTime.local().year
    for (const mmdd of FIXED_PUBLIC_HOLIDAY_MMDD) {
      const key = `${year}-${mmdd}`
      if (!map.has(key)) map.set(key, '')
    }

    return map
  }, [events, todayContextEvents])

  const todayShiftSummary = useMemo(() => {
    const today = DateTime.local().toISODate()
    const todayShiftEvents = todayContextEvents.filter(
      (event) => event.eventType === '근무' && DateTime.fromISO(event.startAtUtc).toLocal().toISODate() === today,
    )
    const dayTeams: ShiftTeamKey[] = []
    const nightTeams: ShiftTeamKey[] = []
    const substitutionsByTeamOriginal = new Map<string, string>()

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

      const dayMembers = shiftTeamDrafts[parsed.dayTeam].map((name) => name.trim()).filter(Boolean)
      const nightMembers = shiftTeamDrafts[parsed.nightTeam].map((name) => name.trim()).filter(Boolean)
      const parsedDescription = parseShiftDescriptionState(event.description ?? '')
      for (const substitution of parsedDescription.substitutions) {
        const original = substitution.original.trim()
        const substitute = substitution.substitute.trim()
        if (!original || !substitute) {
          continue
        }
        const isDayMember = dayMembers.includes(original)
        const isNightMember = nightMembers.includes(original)
        const targetTeam = isDayMember ? parsed.dayTeam : isNightMember ? parsed.nightTeam : null
        if (!targetTeam) {
          continue
        }
        substitutionsByTeamOriginal.set(`${targetTeam}:${original}`, substitute)
      }
    }

    // 오늘 근무 제외 대상(휴가/교육) 이름 수집
    const todayUnavailableNames = new Set<string>()
    for (const event of todayContextEvents) {
      if (event.eventType !== '휴가') continue
      const start = DateTime.fromISO(event.startAtUtc).toLocal()
      const end = DateTime.fromISO(event.endAtUtc).toLocal()
      const todayDtObj = DateTime.fromISO(today!)
      if (start.startOf('day') <= todayDtObj && end > todayDtObj) {
        const { targets, vacationType } = parseVacationInfo(event.description ?? '')
        if (vacationType && vacationType.startsWith('시간차')) continue
        for (const name of targets) {
          const trimmed = name.trim()
          if (trimmed) todayUnavailableNames.add(trimmed)
        }
      }
    }

    for (const event of todayContextEvents) {
      if (event.eventType !== '교육') continue
      const start = DateTime.fromISO(event.startAtUtc).toLocal()
      const end = DateTime.fromISO(event.endAtUtc).toLocal()
      const todayDtObj = DateTime.fromISO(today!)
      if (start.startOf('day') <= todayDtObj && end > todayDtObj) {
        const { targets } = parseEducationTargets(event.description ?? '')
        for (const name of targets) {
          const trimmed = name.trim()
          if (trimmed) todayUnavailableNames.add(trimmed)
        }
      }
    }

    const todayDt = DateTime.local()
    const isWeekend = todayDt.weekday === 6 || todayDt.weekday === 7
    const isHoliday = publicHolidayMap.has(today!)
    const hideDayWorkers = isWeekend || isHoliday

    const dayWorkerNames = dayWorkerDrafts.filter(
      (name) => name.trim().length > 0 && !todayUnavailableNames.has(name.trim()),
    )
    const hasShiftTeams = dayTeams.length > 0 || nightTeams.length > 0

    if (!hasShiftTeams && (hideDayWorkers || dayWorkerNames.length === 0)) {
      return null
    }

    const dayMembers = collectShiftMembersWithSubstitutions(dayTeams, shiftTeamDrafts, substitutionsByTeamOriginal).filter(
      (name) => !todayUnavailableNames.has(name.trim()),
    )
    const nightMembers = collectShiftMembersWithSubstitutions(nightTeams, shiftTeamDrafts, substitutionsByTeamOriginal).filter(
      (name) => !todayUnavailableNames.has(name.trim()),
    )
    const dayText = hasShiftTeams
      ? (dayMembers.length > 0 ? dayMembers.join(' · ') : `${dayTeams.join('·')}조 미지정`)
      : null
    const nightText = hasShiftTeams
      ? (nightMembers.length > 0 ? nightMembers.join(' · ') : `${nightTeams.join('·')}조 미지정`)
      : null
    const dayWorkerText = !hideDayWorkers && dayWorkerNames.length > 0 ? dayWorkerNames.join(' · ') : null

    const computedDayWorkerText = todayShiftOverrides?.dayWorkerText !== undefined ? todayShiftOverrides.dayWorkerText : dayWorkerText
    const computedDayText = todayShiftOverrides?.dayText !== undefined ? todayShiftOverrides.dayText : dayText
    const computedNightText = todayShiftOverrides?.nightText !== undefined ? todayShiftOverrides.nightText : nightText

    return {
      dayText: computedDayText,
      nightText: computedNightText,
      dayWorkerText: computedDayWorkerText,
      dayWorkerOverridden: todayShiftOverrides?.dayWorkerText !== undefined,
      dayOverridden: todayShiftOverrides?.dayText !== undefined,
      nightOverridden: todayShiftOverrides?.nightText !== undefined,
    }
  }, [todayContextEvents, shiftTeamDrafts, dayWorkerDrafts, publicHolidayMap, todayShiftOverrides])

  const upcomingEventsByDate = useMemo(() => {
    const now = DateTime.now()
    const filtered = todayContextEvents
      .filter((event) => event.eventType !== '근무' && event.eventType !== '휴가' && event.eventType !== '반복업무' && event.eventType !== '공휴일' && event.eventType !== '기념일' && event.eventType !== '교육' && event.eventType !== '운용중지작업' && DateTime.fromISO(event.endAtUtc).toMillis() >= now.toMillis())
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
  }, [todayContextEvents])

  const monthVacationEvents = useMemo(() => {
    const monthEnd = visibleMonth.endOf('month')
    return events
      .filter((event) => {
        if (event.eventType !== '휴가') return false
        const start = DateTime.fromISO(event.startAtUtc).toLocal()
        const end = DateTime.fromISO(event.endAtUtc).toLocal()
        return start <= monthEnd && end >= visibleMonth
      })
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
  }, [events, visibleMonth])

  const shiftDisplayByDate = useMemo(() => {
    const groupedByDate = new Map<string, CalendarEvent[]>()

    for (const event of events) {
      if (event.eventType !== '근무') {
        continue
      }
      const dateKey = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
      if (!dateKey) {
        continue
      }
      const current = groupedByDate.get(dateKey) ?? []
      current.push(event)
      groupedByDate.set(dateKey, current)
    }

    const displays = new Map<string, {
      label: string
      badges: {
        key: string
        team: ShiftTeamKey
        name: string
        type: SubstitutionWorkType
        original: string
        eventLocalId: string
        substitutionIndex: number
      }[]
    }>()
    const teamOrder = new Map<ShiftTeamKey, number>([
      ['A', 0],
      ['B', 1],
      ['C', 2],
      ['D', 3],
    ])

    for (const [dateKey, dateEvents] of groupedByDate) {
      const summaries: string[] = []
      const latestByOriginal = new Map<string, {
        team: ShiftTeamKey
        name: string
        type: SubstitutionWorkType
        original: string
        eventLocalId: string
        substitutionIndex: number
      }>()

      for (const event of dateEvents) {
        const summary = event.summary.trim()
        if (summary && !summaries.includes(summary)) {
          summaries.push(summary)
        }

        const teams = parseShiftTeamsFromSummary(event.summary)
        if (!teams) {
          continue
        }

        const dayMembers = shiftTeamDrafts[teams.dayTeam].map((name) => name.trim())
        const nightMembers = shiftTeamDrafts[teams.nightTeam].map((name) => name.trim())

        const parsedDescription = parseShiftDescriptionState(event.description ?? '')
        parsedDescription.substitutions.forEach((meta, substitutionIndex) => {
          const inDay = dayMembers.includes(meta.original)
          const inNight = nightMembers.includes(meta.original)
          const targetTeam = inDay ? teams.dayTeam : inNight ? teams.nightTeam : null
          if (!targetTeam) {
            return
          }
          latestByOriginal.set(`${targetTeam}:${meta.original}`, {
            team: targetTeam,
            name: meta.substitute,
            type: meta.type,
            original: meta.original,
            eventLocalId: event.localId,
            substitutionIndex,
          })
        })
      }

      if (summaries.length === 0) {
        continue
      }

      const label = summaries.length === 1 ? summaries[0] : `${summaries[0]} +${summaries.length - 1}`
      const seenBadgeKeys = new Set<string>()
      const badges = [...latestByOriginal.values()]
        .filter((entry) => {
          const dedupeKey = `${entry.team}:${entry.name}:${entry.type}`
          if (seenBadgeKeys.has(dedupeKey)) {
            return false
          }
          seenBadgeKeys.add(dedupeKey)
          return true
        })
        .sort((left, right) => {
          const teamDiff = (teamOrder.get(left.team) ?? 99) - (teamOrder.get(right.team) ?? 99)
          if (teamDiff !== 0) {
            return teamDiff
          }
          return left.name.localeCompare(right.name, 'ko')
        })
        .map((entry) => ({
          key: `${entry.team}:${entry.name}:${entry.type}`,
          team: entry.team,
          name: entry.name,
          type: entry.type,
          original: entry.original,
          eventLocalId: entry.eventLocalId,
          substitutionIndex: entry.substitutionIndex,
        }))

      displays.set(dateKey, { label, badges })
    }

    return displays
  }, [events, shiftTeamDrafts])

  const calendarEvents = useMemo(
    () =>
      events
        .filter((event) => event.eventType !== '근무' && event.eventType !== '공휴일')
        .map((event) => {
          const isEducation = event.eventType === '교육'
          const isVacation = event.eventType === '휴가'
          const isBasic = event.eventType === '일반'
          const isRoutine = event.eventType === '반복업무'
          let educationTargets: string[] = []
          let endDateDisplay: string | null = null
          let vacationTypeLabel: string | null = null
          let isRoutineDone = false

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

          if (isRoutine) {
            const parsed = parseRoutineCompletions(event.description ?? '')
            const completionDate = DateTime.fromISO(event.startAtUtc).toLocal().toISODate()
            isRoutineDone = Boolean(completionDate && parsed.completedDates.includes(completionDate))
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
              ...(isBasic ? ['is-basic'] : []),
            ],
            extendedProps: {
              sortOrder: event.eventType === '운용중지작업' ? -1 : event.eventType === '중요' ? -1 : isEducation ? 2 : isVacation ? 3 : event.eventType === '반복업무' ? 1 : 0,
              isRoutine,
              isRoutineDone,
              isEducation,
              isVacation,
              educationTargets,
              endDateDisplay,
              vacationTypeLabel,
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

  const useCustomTitlebar = true // Windows 11 only — always use custom titlebar
  const visibleMemberCount = shiftSettings.shiftTeamMode === 'SINGLE' ? 1 : 2
  const visibleDayWorkerCount = shiftSettings.dayWorkerCount
  const shiftBadgeEditorPosition = useMemo(() => {
    if (!editingShiftBadge) {
      return null
    }

    const editorWidth = 304
    const editorHeight = 232
    const pad = 12
    const maxLeft = Math.max(pad, window.innerWidth - editorWidth - pad)
    const maxTop = Math.max(pad, window.innerHeight - editorHeight - pad)
    const left = Math.min(Math.max(editingShiftBadge.anchor.x + 8, pad), maxLeft)
    const top = Math.min(Math.max(editingShiftBadge.anchor.y + 8, pad), maxTop)
    return { left, top }
  }, [editingShiftBadge])

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
      editable.recurrenceScope = 'THIS'
    }

    await saveEventWithUndo({
      ...editable,
      summary: nextSummary,
      sendUpdates: 'none',
    })
  }

  const toggleRoutineCompletion = useCallback(async (eventLocalId: string, nextDone: boolean) => {
    const clickedEvent = eventsRef.current.find((event) => event.localId === eventLocalId)
    if (!clickedEvent) {
      return
    }

    const completionDate = DateTime.fromISO(clickedEvent.startAtUtc).toLocal().toISODate()
    if (!completionDate) {
      return
    }

    const sourceEvent = resolveRoutineSourceEvent(clickedEvent, allEventsRef.current)

    const parsed = parseRoutineCompletions(sourceEvent.description ?? '')
    const nextDoneDates = new Set(parsed.completedDates)
    if (nextDone) {
      nextDoneDates.add(completionDate)
    } else {
      nextDoneDates.delete(completionDate)
    }

    const nextDescription = serializeRoutineCompletions([...nextDoneDates], parsed.cleanDescription)

    setRoutineDoneOverrides((prev) => {
      const next = new Map(prev)
      next.set(eventLocalId, nextDone)
      return next
    })

    try {
      await saveEventWithUndo({
        ...toEditableEvent(sourceEvent),
        description: nextDescription,
        sendUpdates: 'none',
        recurrenceScope: 'ALL',
      })
    } catch {
      setRoutineDoneOverrides((prev) => {
        const next = new Map(prev)
        next.delete(eventLocalId)
        return next
      })
      return
    }

  }, [saveEventWithUndo])

  const saveShiftBadgeInlineEdit = useCallback(async () => {
    if (!editingShiftBadge) {
      return
    }
    const targetEvent = allEventsRef.current.find((event) => event.localId === editingShiftBadge.eventLocalId)
    if (!targetEvent) {
      setEditingShiftBadge(null)
      return
    }

    const substitute = editingShiftBadge.substitute.trim()
    const original = editingShiftBadge.original.trim()
    if (!substitute || !original) {
      return
    }

    const parsed = parseShiftDescriptionState(targetEvent.description ?? '')
    if (
      editingShiftBadge.substitutionIndex < 0
      || editingShiftBadge.substitutionIndex >= parsed.substitutions.length
    ) {
      setEditingShiftBadge(null)
      return
    }

    parsed.substitutions[editingShiftBadge.substitutionIndex] = {
      substitute,
      type: editingShiftBadge.type,
      original,
    }

    await saveEventWithUndo({
      ...toEditableEvent(targetEvent),
      description: serializeShiftDescriptionState(parsed),
      sendUpdates: 'none',
    })
    setEditingShiftBadge(null)
  }, [editingShiftBadge, saveEventWithUndo])

  const deleteShiftBadgeInlineEdit = useCallback(async () => {
    if (!editingShiftBadge) {
      return
    }
    const targetEvent = allEventsRef.current.find((event) => event.localId === editingShiftBadge.eventLocalId)
    if (!targetEvent) {
      setEditingShiftBadge(null)
      return
    }

    const parsed = parseShiftDescriptionState(targetEvent.description ?? '')
    if (
      editingShiftBadge.substitutionIndex < 0
      || editingShiftBadge.substitutionIndex >= parsed.substitutions.length
    ) {
      setEditingShiftBadge(null)
      return
    }

    parsed.substitutions.splice(editingShiftBadge.substitutionIndex, 1)
    await saveEventWithUndo({
      ...toEditableEvent(targetEvent),
      description: serializeShiftDescriptionState(parsed),
      sendUpdates: 'none',
    })
    setEditingShiftBadge(null)
  }, [editingShiftBadge, saveEventWithUndo])

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

  const handleTodayShiftEditStart = useCallback((row: 'dayWorker' | 'day' | 'night', currentText: string) => {
    setEditingTodayShiftRow(row)
    setEditingTodayShiftDraft(currentText)
  }, [])

  const handleTodayShiftEditSave = useCallback((row: 'dayWorker' | 'day' | 'night') => {
    const todayKey = DateTime.local().toISODate()
    if (!todayKey) return
    const fieldMap = { dayWorker: 'dayWorkerText', day: 'dayText', night: 'nightText' } as const
    const field = fieldMap[row]
    const newOverrides: TodayShiftOverride = { ...todayShiftOverrides, [field]: editingTodayShiftDraft }
    saveTodayShiftOverride(todayKey, newOverrides)
    setTodayShiftOverrides(newOverrides)
    setEditingTodayShiftRow(null)
  }, [todayShiftOverrides, editingTodayShiftDraft])

  const handleTodayShiftEditCancel = useCallback(() => {
    setEditingTodayShiftRow(null)
  }, [])

  const handleTodayShiftReset = useCallback((row: 'dayWorker' | 'day' | 'night') => {
    const todayKey = DateTime.local().toISODate()
    if (!todayKey) return
    const fieldMap = { dayWorker: 'dayWorkerText', day: 'dayText', night: 'nightText' } as const
    const field = fieldMap[row]
    const current = { ...todayShiftOverrides }
    delete current[field]
    if (Object.keys(current).length === 0) {
      clearTodayShiftOverride(todayKey)
      setTodayShiftOverrides(null)
    } else {
      saveTodayShiftOverride(todayKey, current)
      setTodayShiftOverrides(current)
    }
  }, [todayShiftOverrides])

  return (
    <div className="window-frame">
      <WeatherOverlay mode={effectiveWeatherOverlayMode} />
      {useCustomTitlebar ? (
        <div className="titlebar">
          <div className="titlebar-leading">
            <div className="titlebar-leading-actions">
            <button
              type="button"
              className="titlebar-settings-btn"
              onClick={() => {
                setSyncOpen(false)
                setSettingsOpen(true)
              }}
            >
              설정
            </button>
            <button
              type="button"
              className="titlebar-sync-btn"
              onClick={() => {
                setSettingsOpen(false)
                setSyncOpen(true)
              }}
            >
              동기화
            </button>
            </div>
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
              {todayShiftSummary.dayWorkerText != null ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">일근</span>
                  {editingTodayShiftRow === 'dayWorker' ? (
                    <input
                      className="today-shift-members-input"
                      value={editingTodayShiftDraft}
                      onChange={(e) => setEditingTodayShiftDraft(e.target.value)}
                      onBlur={() => handleTodayShiftEditSave('dayWorker')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTodayShiftEditSave('dayWorker')
                        if (e.key === 'Escape') handleTodayShiftEditCancel()
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span
                        className={`today-shift-members${todayShiftSummary.dayWorkerOverridden ? ' is-overridden' : ''}`}
                        onClick={() => handleTodayShiftEditStart('dayWorker', todayShiftSummary.dayWorkerText!)}
                        title="클릭하여 편집"
                      >
                        {todayShiftSummary.dayWorkerText}
                      </span>
                      {todayShiftSummary.dayWorkerOverridden ? (
                        <button type="button" className="today-shift-override-reset" onClick={() => handleTodayShiftReset('dayWorker')} title="원래 값으로 복원">×</button>
                      ) : null}
                    </>
                  )}
                </p>
              ) : null}
              {todayShiftSummary.dayText != null ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">주간</span>
                  {editingTodayShiftRow === 'day' ? (
                    <input
                      className="today-shift-members-input"
                      value={editingTodayShiftDraft}
                      onChange={(e) => setEditingTodayShiftDraft(e.target.value)}
                      onBlur={() => handleTodayShiftEditSave('day')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTodayShiftEditSave('day')
                        if (e.key === 'Escape') handleTodayShiftEditCancel()
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span
                        className={`today-shift-members${todayShiftSummary.dayOverridden ? ' is-overridden' : ''}`}
                        onClick={() => handleTodayShiftEditStart('day', todayShiftSummary.dayText!)}
                        title="클릭하여 편집"
                      >
                        {todayShiftSummary.dayText}
                      </span>
                      {todayShiftSummary.dayOverridden ? (
                        <button type="button" className="today-shift-override-reset" onClick={() => handleTodayShiftReset('day')} title="원래 값으로 복원">×</button>
                      ) : null}
                    </>
                  )}
                </p>
              ) : null}
              {todayShiftSummary.nightText != null ? (
                <p className="today-shift-row">
                  <span className="today-shift-label">야간</span>
                  {editingTodayShiftRow === 'night' ? (
                    <input
                      className="today-shift-members-input"
                      value={editingTodayShiftDraft}
                      onChange={(e) => setEditingTodayShiftDraft(e.target.value)}
                      onBlur={() => handleTodayShiftEditSave('night')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTodayShiftEditSave('night')
                        if (e.key === 'Escape') handleTodayShiftEditCancel()
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span
                        className={`today-shift-members${todayShiftSummary.nightOverridden ? ' is-overridden' : ''}`}
                        onClick={() => handleTodayShiftEditStart('night', todayShiftSummary.nightText!)}
                        title="클릭하여 편집"
                      >
                        {todayShiftSummary.nightText}
                      </span>
                      {todayShiftSummary.nightOverridden ? (
                        <button type="button" className="today-shift-override-reset" onClick={() => handleTodayShiftReset('night')} title="원래 값으로 복원">×</button>
                      ) : null}
                    </>
                  )}
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
                  const vacInfo = parseVacationInfo(event.description ?? '')
                  const vType = vacInfo.vacationType
                  const summaryTimeMatch = vType === '시간차' ? event.summary.match(/시간차\((.+?)\)/) : null
                  const typeInSummary = summaryTimeMatch ? summaryTimeMatch[0] : vType
                  const nameOnly = typeInSummary
                    ? event.summary.replace(typeInSummary, '').trim()
                    : event.summary
                  return (
                    <li key={event.localId} className="vacation-item">
                      <button type="button" onClick={() => setEditingEvent(toEditableEvent(event))}>
                        <span>
                          {nameOnly}
                          {vType && (
                            <>
                              {' '}<span className="vacation-type-text">{summaryTimeMatch ? `시간차 (${summaryTimeMatch[1]})` : vType}</span>
                            </>
                          )}
                        </span>
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

        <main className="calendar-panel" onWheel={handleCalendarWheel} onClick={(e) => {
          if (e.button !== 0) return
          const target = e.target as HTMLElement
          if (target.closest('.fc-event') || target.closest('.fc-event-title-inline-input')) return
          const badgeEl = target.closest<HTMLElement>('.fc-day-shift-badge')
          if (badgeEl) {
            const badgeSelection = parseShiftBadgeSelection(badgeEl)
            if (badgeSelection) {
              e.preventDefault()
              e.stopPropagation()
              setEditingShiftBadge({
                anchor: { x: e.clientX, y: e.clientY },
                ...badgeSelection,
              })
            }
            return
          }
          // Left-click on shift label → open substitution flow
          if (target.closest('.fc-day-shift-inline')) {
            const dayCell = target.closest<HTMLElement>('[data-date]')
            const dateStr = dayCell?.getAttribute('data-date')
            if (dateStr) {
              const shiftEvent = events.find(
                (ev) => ev.eventType === '근무' && DateTime.fromISO(ev.startAtUtc).toLocal().toISODate() === dateStr,
              )
              if (shiftEvent) {
                e.preventDefault()
                setSubstitutionFlow({ anchor: { x: e.clientX, y: e.clientY }, dateStr, shiftEvent })
              }
            }
            return
          }
          const dayCell = target.closest<HTMLElement>('[data-date]')
          if (!dayCell) return
          if (editingTitleEventId || editingEvent) return
          const dateStr = dayCell.getAttribute('data-date')
          if (!dateStr) return
          e.preventDefault()
          setRadialMenu({ anchor: { x: e.clientX, y: e.clientY }, dateStr })
        }} onContextMenu={(e) => {
          const target = e.target as HTMLElement
          const badgeEl = target.closest<HTMLElement>('.fc-day-shift-badge')
          if (badgeEl) {
            const badgeSelection = parseShiftBadgeSelection(badgeEl)
            if (badgeSelection) {
              e.preventDefault()
              e.stopPropagation()
              setEditingShiftBadge({
                anchor: { x: e.clientX, y: e.clientY },
                ...badgeSelection,
              })
            }
            return
          }
          const dayCell = target.closest<HTMLElement>('[data-date]')
          if (!dayCell) return
          e.preventDefault()
          if (editingTitleEventId) return
          const dateStr = dayCell.getAttribute('data-date')
          if (!dateStr) return

          // Right-click on shift label → open existing 근무 event for editing
          if (target.closest('.fc-day-shift-inline')) {
            const shiftEvent = events.find(
              (ev) => ev.eventType === '근무' && DateTime.fromISO(ev.startAtUtc).toLocal().toISODate() === dateStr,
            )
            if (shiftEvent) {
              setEditingEvent(toEditableEvent(shiftEvent))
              return
            }
          }

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
              const routineDoneFromEvent = arg.event.extendedProps?.isRoutineDone === true
              const routineDoneOverride = routineDoneOverrides.get(arg.event.id)
              const isDone = isRoutine ? (routineDoneOverride ?? routineDoneFromEvent) : false
              const isEducation = arg.event.extendedProps?.isEducation === true

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
                        void toggleRoutineCompletion(arg.event.id, !isDone)
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
            let rafId = 0
            if (textEl) {
              rafId = requestAnimationFrame(() => {
                rafId = 0
                if (textEl.scrollWidth > textEl.clientWidth) {
                  const ratio = textEl.clientWidth / textEl.scrollWidth
                  const fitted = Math.max(11, Math.floor(18 * ratio))
                  textEl.style.fontSize = `${fitted}px`
                }
              })
            }

            const showTip = (e: Event) => {
              const me = e as MouseEvent
              let tip = document.getElementById('fc-singleton-tip') as HTMLDivElement | null
              if (!tip) {
                tip = document.createElement('div')
                tip.id = 'fc-singleton-tip'
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
              tip.style.display = ''
              tip.style.left = `${me.clientX + 10}px`
              tip.style.top = `${me.clientY + 10}px`
            }
            const hideTip = () => {
              const tip = document.getElementById('fc-singleton-tip')
              if (tip) tip.style.display = 'none'
            }
            arg.el.addEventListener('pointerenter', showTip)
            arg.el.addEventListener('pointermove', showTip)
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
              if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
              hideTip()
              arg.el.removeEventListener('pointerenter', showTip)
              arg.el.removeEventListener('pointermove', showTip)
              arg.el.removeEventListener('pointerleave', hideTip)
            }
          }}
          eventWillUnmount={(arg) => {
            ;(arg.el as any)._tipCleanup?.()
            arg.el.oncontextmenu = null
          }}
          dayCellContent={(arg) => {
            const dateKey = DateTime.fromJSDate(arg.date).toISODate()
            const shiftDisplay = dateKey ? shiftDisplayByDate.get(dateKey) : null
            const holidayName = dateKey ? publicHolidayMap.get(dateKey) : undefined
            const isHoliday = holidayName !== undefined
            const hasShiftBadges = Boolean(shiftDisplay && shiftDisplay.badges.length > 0)
            const showHolidayUnderDayNumber = Boolean(holidayName && hasShiftBadges)
            return (
              <>
                <span className="fc-day-meta-row">
                  <span className={isHoliday ? 'fc-day-number-text is-public-holiday' : 'fc-day-number-text'}>{arg.dayNumberText.replace('일', '')}</span>
                  {shiftDisplay ? (
                    <span className="fc-day-shift-inline">
                      <span className="fc-day-shift-label">{shiftDisplay.label}</span>
                      {shiftDisplay.badges.length > 0 ? (
                        <span className="fc-day-shift-badges">
                          {shiftDisplay.badges.map((badge) => (
                            <span
                              key={badge.key}
                              className={badge.type === '대체근무' ? 'fc-day-shift-badge is-replacement' : 'fc-day-shift-badge'}
                              data-shift-badge-event={badge.eventLocalId}
                              data-shift-badge-index={badge.substitutionIndex}
                              data-shift-badge-team={badge.team}
                              data-shift-badge-substitute={badge.name}
                              data-shift-badge-original={badge.original}
                              data-shift-badge-type={badge.type}
                            >
                              {badge.team}조 {badge.name}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {holidayName && !showHolidayUnderDayNumber ? <span className="fc-day-holiday-pill">{holidayName}</span> : null}
                </span>
                {showHolidayUnderDayNumber ? (
                  <span className="fc-day-holiday-pill is-under-day-number">{holidayName}</span>
                ) : null}
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

      {editingShiftBadge && shiftBadgeEditorPosition ? (
        <div
          className="shift-badge-inline-editor"
          style={{ left: shiftBadgeEditorPosition.left, top: shiftBadgeEditorPosition.top }}
          onClick={(event) => {
            event.stopPropagation()
          }}
        >
          <p className="shift-badge-inline-title">대체근무 배지 편집</p>
          <p className="shift-badge-inline-hint">{editingShiftBadge.team}조에 표시됩니다</p>
          <label className="shift-badge-inline-field">
            <span>대체근무자</span>
            <input
              type="text"
              value={editingShiftBadge.substitute}
              onChange={(event) =>
                setEditingShiftBadge((current) => (current
                  ? { ...current, substitute: event.target.value }
                  : current))}
              maxLength={40}
            />
          </label>
          <label className="shift-badge-inline-field">
            <span>근무종류</span>
            <select
              value={editingShiftBadge.type}
              onChange={(event) =>
                setEditingShiftBadge((current) => (current
                  ? { ...current, type: event.target.value as SubstitutionWorkType }
                  : current))}
            >
              <option value="대리근무">대리근무</option>
              <option value="대체근무">대체근무</option>
            </select>
          </label>
          <label className="shift-badge-inline-field">
            <span>원근무자</span>
            <select
              value={editingShiftBadge.original}
              onChange={(event) =>
                setEditingShiftBadge((current) => (current
                  ? { ...current, original: event.target.value }
                  : current))}
            >
              {Array.from(
                new Set([
                  editingShiftBadge.original,
                  ...shiftTeamDrafts[editingShiftBadge.team].map((name) => name.trim()),
                ]),
              )
                .filter((name) => name.trim().length > 0)
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <div className="shift-badge-inline-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                void deleteShiftBadgeInlineEdit()
              }}
            >
              삭제
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setEditingShiftBadge(null)}
            >
              취소
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void saveShiftBadgeInlineEdit()
              }}
            >
              저장
            </button>
          </div>
        </div>
      ) : null}

      {radialMenu && (
        <RadialMenu
          anchor={radialMenu.anchor}
          dateStr={radialMenu.dateStr}
          memberNames={allMemberNames}
          onComplete={async (draft) => { setRadialMenu(null); await saveEventWithUndo(draft) }}
          onDismiss={() => setRadialMenu(null)}
        />
      )}
      {substitutionFlow && (
        <SubstitutionFlow
          anchor={substitutionFlow.anchor}
          shiftEvent={substitutionFlow.shiftEvent}
          memberNames={allMemberNames}
          onComplete={async (substitute, type, original) => {
            const ev = substitutionFlow.shiftEvent
            const editable = toEditableEvent(ev)
            const lines: string[] = []
            if (editable.description) lines.push(editable.description)
            lines.push(`대체근무자: ${substitute}`)
            lines.push(`근무종류: ${type}`)
            lines.push(`원근무자: ${original}`)
            editable.description = lines.join('\n')
            setSubstitutionFlow(null)
            await saveEventWithUndo(editable)
          }}
          onDismiss={() => setSubstitutionFlow(null)}
        />
      )}
      <EventModal
        open={Boolean(editingEvent)}
        value={editingEvent}
        memberNames={allMemberNames}
        onClose={() => setEditingEvent(null)}
        onSave={async (event) => {
          await saveEventWithUndo(event)
          setEditingEvent(null)
        }}
        onDelete={async (localId, sendUpdates, recurrenceScope) => {
          await deleteEventWithUndo(localId, sendUpdates, recurrenceScope)
          setEditingEvent(null)
        }}
      />
      <SettingsModal
        open={settingsOpen}
        shiftType={shiftSettings.shiftType}
        shiftTeamMode={shiftSettings.shiftTeamMode}
        dayWorkerCount={shiftSettings.dayWorkerCount}
        weatherPreviewMode={weatherPreviewMode}
        savingShiftSettings={savingShiftSettings}
        onClose={() => setSettingsOpen(false)}
        onSetShiftType={setShiftType}
        onSetShiftTeamMode={setShiftTeamMode}
        onSetDayWorkerCount={setDayWorkerCount}
        onSetWeatherPreviewMode={setWeatherPreviewMode}
      />
      <SyncModal
        open={syncOpen}
        loading={loading}
        syncing={syncing}
        forcePushing={forcePushing}
        selectingCalendar={selectingCalendar}
        googleConnected={googleConnected}
        accountEmail={accountEmail}
        calendars={calendars}
        selectedCalendarId={selectedCalendarId}
        selectedCalendarSummary={selectedCalendarSummary}
        lastSyncResult={lastSyncResult}
        lastForcePushResult={lastForcePushResult}
        outboxCount={outboxCount}
        outboxJobs={outboxJobs}
        loadingOutboxJobs={loadingOutboxJobs}
        onClose={() => setSyncOpen(false)}
        onRefreshOutboxJobs={refreshOutboxJobs}
        onCancelOutboxJob={cancelOutboxJob}
        onConnectGoogle={connectGoogle}
        onDisconnectGoogle={disconnectGoogle}
        onSetSyncCalendar={setSyncCalendar}
        onSyncNow={syncNow}
        onForcePushAll={forcePushAll}
      />
      </div>
    </div>
  )
}
