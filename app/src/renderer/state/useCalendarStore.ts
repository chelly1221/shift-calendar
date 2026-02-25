import { DateTime } from 'luxon'
import { create } from 'zustand'
import type {
  CalendarApi,
  CalendarEvent,
  DayWorkerCount,
  ForcePushResult,
  GoogleCalendarItem,
  GoogleConnectionStatus,
  OutboxJobItem,
  RecurrenceEditScope,
  SelectedCalendar,
  ShiftSettings,
  ShiftTeamAssignments,
  ShiftTeamMode,
  ShiftType,
  SyncResult,
  UpsertCalendarEventInput,
} from '../../shared/calendar'
import { defaultShiftSettings as defaultShiftSettingsValue } from '../../shared/calendar'
import { expandRecurringEvents } from '../../shared/expandRecurrence'

interface CalendarState {
  allEvents: CalendarEvent[]
  events: CalendarEvent[]
  renderRangeStartUtc: string
  renderRangeEndUtc: string
  outboxCount: number
  outboxJobs: OutboxJobItem[]
  loadingOutboxJobs: boolean
  loading: boolean
  syncing: boolean
  forcePushing: boolean
  lastForcePushResult: ForcePushResult | null
  googleConnected: boolean
  accountEmail: string | null
  calendars: GoogleCalendarItem[]
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
  selectingCalendar: boolean
  lastSyncResult: SyncResult | null
  shiftSettings: ShiftSettings
  savingShiftSettings: boolean
  setEventRenderRange: (rangeStartUtc: string, rangeEndUtc: string) => void
  hydrate: () => Promise<void>
  refreshOutboxJobs: () => Promise<void>
  cancelOutboxJob: (jobId: string) => Promise<boolean>
  saveEvent: (payload: UpsertCalendarEventInput) => Promise<CalendarEvent>
  deleteEvent: (localId: string, sendUpdates?: 'all' | 'none', recurrenceScope?: RecurrenceEditScope) => Promise<void>
  syncNow: () => Promise<void>
  forcePushAll: () => Promise<void>
  connectGoogle: () => Promise<void>
  disconnectGoogle: () => Promise<void>
  setSyncCalendar: (calendarId: string) => Promise<void>
  setShiftType: (shiftType: ShiftType) => Promise<void>
  setShiftTeamMode: (shiftTeamMode: ShiftTeamMode) => Promise<void>
  setDayWorkerCount: (dayWorkerCount: DayWorkerCount) => Promise<void>
  setShiftTeams: (teams: ShiftTeamAssignments) => Promise<void>
  setDayWorkers: (dayWorkers: string[]) => Promise<void>
  setShiftAssignments: (teams: ShiftTeamAssignments, dayWorkers: string[]) => Promise<void>
}

const fallbackGoogleStatus: GoogleConnectionStatus = {
  connected: false,
  accountEmail: null,
}

const fallbackSelectedCalendar: SelectedCalendar = {
  calendarId: null,
  calendarSummary: null,
}

function cloneShiftSettings(settings: ShiftSettings): ShiftSettings {
  return {
    shiftType: settings.shiftType,
    teams: {
      A: [...settings.teams.A],
      B: [...settings.teams.B],
      C: [...settings.teams.C],
      D: [...settings.teams.D],
    },
    dayWorkers: [...settings.dayWorkers],
    shiftTeamMode: settings.shiftTeamMode,
    dayWorkerCount: settings.dayWorkerCount,
  }
}

const fallbackApi: CalendarApi = {
  async listEvents() {
    return []
  },
  async upsertEvent(payload) {
    const nowIso = new Date().toISOString()
    return {
      localId: payload.localId ?? crypto.randomUUID(),
      googleEventId: payload.googleEventId ?? null,
      eventType: payload.eventType ?? '일반',
      summary: payload.summary,
      description: payload.description ?? '',
      location: payload.location ?? '',
      startAtUtc: payload.startAtUtc,
      endAtUtc: payload.endAtUtc,
      timeZone: payload.timeZone,
      attendees: payload.attendees ?? [],
      recurrenceRule: payload.recurrenceRule ?? null,
      recurringEventId: payload.recurringEventId ?? null,
      originalStartTimeUtc: payload.originalStartTimeUtc ?? null,
      organizerEmail: null,
      hangoutLink: null,
      googleUpdatedAtUtc: null,
      localEditedAtUtc: nowIso,
      syncState: 'PENDING',
    }
  },
  async deleteEvent() {
    return true
  },
  async getOutboxCount() {
    return 0
  },
  async listOutboxJobs() {
    return []
  },
  async cancelOutboxJob() {
    return false
  },
  async syncNow() {
    return {
      mode: 'SKIPPED',
      pulledEvents: 0,
      pushedOutboxJobs: 0,
      outboxRemaining: 0,
    }
  },
  async forcePushAll() {
    return { enqueuedJobs: 0, processedJobs: 0, skippedEvents: 0 }
  },
  async connectGoogle() {
    return fallbackGoogleStatus
  },
  async disconnectGoogle() {
    return fallbackGoogleStatus
  },
  async getGoogleConnectionStatus() {
    return fallbackGoogleStatus
  },
  async listGoogleCalendars() {
    return []
  },
  async getSelectedCalendar() {
    return fallbackSelectedCalendar
  },
  async setSelectedCalendar(payload) {
    return {
      calendarId: payload.calendarId,
      calendarSummary: payload.calendarSummary ?? null,
    }
  },
  async getShiftSettings() {
    return cloneShiftSettings(defaultShiftSettingsValue)
  },
  async setShiftSettings(payload) {
    return cloneShiftSettings(payload)
  },
}

function getCalendarApi(): CalendarApi {
  if (typeof window !== 'undefined' && window.calendarApi) {
    return window.calendarApi
  }
  return fallbackApi
}

function sortByStart(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
}

function upsertEventInMemory(events: CalendarEvent[], saved: CalendarEvent): CalendarEvent[] {
  const next = events.filter((event) => event.localId !== saved.localId)
  next.push(saved)
  return sortByStart(next)
}

function defaultRenderRange() {
  const now = DateTime.utc()
  return {
    rangeStartUtc: now.minus({ months: 3 }).toISO() ?? undefined,
    rangeEndUtc: now.plus({ months: 3 }).toISO() ?? undefined,
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

function expandForRenderRange(events: CalendarEvent[], rangeStartUtc: string, rangeEndUtc: string): CalendarEvent[] {
  const candidates = events.filter((event) => {
    if (event.recurrenceRule && !event.recurringEventId) {
      return true
    }
    return eventOverlapsRange(event, rangeStartUtc, rangeEndUtc)
  })

  const expanded = expandRecurringEvents(candidates, rangeStartUtc, rangeEndUtc)
  return sortByStart(expanded.filter((event) => eventOverlapsRange(event, rangeStartUtc, rangeEndUtc)))
}

const initialRenderRange = defaultRenderRange()
const initialRangeStartUtc = initialRenderRange.rangeStartUtc ?? DateTime.utc().minus({ months: 3 }).toISO()!
const initialRangeEndUtc = initialRenderRange.rangeEndUtc ?? DateTime.utc().plus({ months: 3 }).toISO()!

export const useCalendarStore = create<CalendarState>((set, get) => ({
  allEvents: [],
  events: [],
  renderRangeStartUtc: initialRangeStartUtc,
  renderRangeEndUtc: initialRangeEndUtc,
  outboxCount: 0,
  outboxJobs: [],
  loadingOutboxJobs: false,
  loading: false,
  syncing: false,
  forcePushing: false,
  lastForcePushResult: null,
  googleConnected: false,
  accountEmail: null,
  calendars: [],
  selectedCalendarId: null,
  selectedCalendarSummary: null,
  selectingCalendar: false,
  lastSyncResult: null,
  shiftSettings: cloneShiftSettings(defaultShiftSettingsValue),
  savingShiftSettings: false,
  setEventRenderRange: (rangeStartUtc, rangeEndUtc) => {
    const state = get()
    if (
      state.renderRangeStartUtc === rangeStartUtc
      && state.renderRangeEndUtc === rangeEndUtc
    ) {
      return
    }
    const expanded = expandForRenderRange(state.allEvents, rangeStartUtc, rangeEndUtc)
    set({
      renderRangeStartUtc: rangeStartUtc,
      renderRangeEndUtc: rangeEndUtc,
      events: expanded,
    })
  },

  hydrate: async () => {
    const api = getCalendarApi()
    set({ loading: true })
    try {
      const [allEvents, outboxCount, outboxJobs, googleStatus, selectedCalendar, shiftSettings] = await Promise.all([
        api.listEvents(),
        api.getOutboxCount(),
        api.listOutboxJobs({ limit: 80, includeCompleted: false }).catch(() => []),
        api.getGoogleConnectionStatus(),
        api.getSelectedCalendar(),
        api.getShiftSettings(),
      ])

      let calendars: GoogleCalendarItem[] = []
      if (googleStatus.connected) {
        calendars = await api.listGoogleCalendars().catch(() => [])
      }

      const state = get()
      const expanded = expandForRenderRange(allEvents, state.renderRangeStartUtc, state.renderRangeEndUtc)

      set({
        allEvents: sortByStart(allEvents),
        events: expanded,
        outboxCount,
        outboxJobs,
        googleConnected: googleStatus.connected,
        accountEmail: googleStatus.accountEmail,
        calendars,
        selectedCalendarId: selectedCalendar.calendarId,
        selectedCalendarSummary: selectedCalendar.calendarSummary,
        shiftSettings: cloneShiftSettings(shiftSettings),
      })
    } finally {
      set({ loading: false })
    }
  },

  refreshOutboxJobs: async () => {
    const api = getCalendarApi()
    set({ loadingOutboxJobs: true })
    try {
      const [outboxCount, outboxJobs] = await Promise.all([
        api.getOutboxCount().catch(() => get().outboxCount),
        api.listOutboxJobs({ limit: 80, includeCompleted: false }).catch(() => get().outboxJobs),
      ])
      set({ outboxCount, outboxJobs })
    } finally {
      set({ loadingOutboxJobs: false })
    }
  },

  cancelOutboxJob: async (jobId) => {
    const api = getCalendarApi()
    const cancelled = await api.cancelOutboxJob({ jobId })
    await get().refreshOutboxJobs()
    return cancelled
  },

  saveEvent: async (payload) => {
    const api = getCalendarApi()
    const saved = await api.upsertEvent(payload)
    set((state) => {
      const nextAllEvents = upsertEventInMemory(state.allEvents, saved)
      return {
        allEvents: nextAllEvents,
        events: expandForRenderRange(nextAllEvents, state.renderRangeStartUtc, state.renderRangeEndUtc),
      }
    })

    void Promise.all([
      api.getOutboxCount(),
      api.listOutboxJobs({ limit: 80, includeCompleted: false }).catch(() => []),
    ])
      .then(([outboxCount, outboxJobs]) => set({ outboxCount, outboxJobs }))
      .catch((error) => {
        console.error('[CalendarStore] Failed to refresh outbox status:', error)
      })

    const shouldRefreshInBackground =
      payload.recurrenceScope === 'FUTURE'
      || Boolean(payload.recurrenceRule)
      || Boolean(payload.recurringEventId)

    if (shouldRefreshInBackground) {
      void get().hydrate().catch((error) => {
        console.error('[CalendarStore] Background hydrate failed:', error)
      })
    }

    return saved
  },

  deleteEvent: async (localId, sendUpdates = 'none', recurrenceScope) => {
    const api = getCalendarApi()
    const deleted = await api.deleteEvent({
      localId,
      sendUpdates,
      recurrenceScope: recurrenceScope ?? 'ALL',
    })
    if (!deleted) {
      return
    }
    // For FUTURE/ALL scopes, multiple events may be affected — re-fetch the full list
    if (recurrenceScope === 'FUTURE' || recurrenceScope === 'ALL') {
      await get().hydrate()
    } else {
      const state = get()
      const allEvents = state.allEvents.filter((event) => event.localId !== localId)
      const events = expandForRenderRange(allEvents, state.renderRangeStartUtc, state.renderRangeEndUtc)
      const [outboxCount, outboxJobs] = await Promise.all([
        api.getOutboxCount(),
        api.listOutboxJobs({ limit: 80, includeCompleted: false }).catch(() => []),
      ])
      set({ allEvents, events, outboxCount, outboxJobs })
    }
  },

  syncNow: async () => {
    if (get().googleConnected && !get().selectedCalendarId) {
      return
    }

    const api = getCalendarApi()
    set({ syncing: true })
    try {
      const result = await api.syncNow()
      set({ lastSyncResult: result, outboxCount: result.outboxRemaining })
      await get().hydrate()
    } finally {
      set({ syncing: false })
    }
  },

  forcePushAll: async () => {
    if (!get().googleConnected || !get().selectedCalendarId) {
      return
    }

    const api = getCalendarApi()
    set({ forcePushing: true })
    try {
      const result = await api.forcePushAll()
      set({ lastForcePushResult: result })
      await get().hydrate()
    } finally {
      set({ forcePushing: false })
    }
  },

  connectGoogle: async () => {
    const api = getCalendarApi()
    try {
      const status = await api.connectGoogle()
      if (!status.connected && typeof window !== 'undefined') {
        window.alert('Google OAuth is not configured or authorization was not completed.')
        return
      }

      await get().hydrate()
      const { calendars, selectedCalendarId } = get()
      if (!selectedCalendarId && calendars.length > 0 && typeof window !== 'undefined') {
        window.alert('동기화할 Google 달력을 선택해 주세요.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect Google account.'
      if (typeof window !== 'undefined') {
        window.alert(message)
      }
    }
  },

  disconnectGoogle: async () => {
    const api = getCalendarApi()
    const status = await api.disconnectGoogle()
    set({
      googleConnected: status.connected,
      accountEmail: status.accountEmail,
      calendars: [],
      selectedCalendarId: null,
      selectedCalendarSummary: null,
      selectingCalendar: false,
    })
  },

  setSyncCalendar: async (calendarId) => {
    const api = getCalendarApi()
    const selectedCalendar = get().calendars.find((calendar) => calendar.id === calendarId)
    set({ selectingCalendar: true })
    try {
      await api.setSelectedCalendar({
        calendarId,
        calendarSummary: selectedCalendar?.summary ?? null,
      })
      set({
        selectedCalendarId: calendarId,
        selectedCalendarSummary: selectedCalendar?.summary ?? null,
      })
      await get().syncNow()
    } finally {
      set({ selectingCalendar: false })
    }
  },

  setShiftType: async (shiftType) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType,
        shiftTeamMode: current.shiftTeamMode,
        dayWorkerCount: current.dayWorkerCount,
        teams: current.teams,
        dayWorkers: current.dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },

  setShiftTeamMode: async (shiftTeamMode) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType: current.shiftType,
        shiftTeamMode,
        dayWorkerCount: current.dayWorkerCount,
        teams: current.teams,
        dayWorkers: current.dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },

  setShiftTeams: async (teams) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType: current.shiftType,
        shiftTeamMode: current.shiftTeamMode,
        dayWorkerCount: current.dayWorkerCount,
        teams,
        dayWorkers: current.dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },

  setDayWorkers: async (dayWorkers) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType: current.shiftType,
        shiftTeamMode: current.shiftTeamMode,
        dayWorkerCount: current.dayWorkerCount,
        teams: current.teams,
        dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },

  setShiftAssignments: async (teams, dayWorkers) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType: current.shiftType,
        shiftTeamMode: current.shiftTeamMode,
        dayWorkerCount: current.dayWorkerCount,
        teams,
        dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },

  setDayWorkerCount: async (dayWorkerCount) => {
    const api = getCalendarApi()
    const current = get().shiftSettings
    set({ savingShiftSettings: true })
    try {
      const next = await api.setShiftSettings({
        shiftType: current.shiftType,
        shiftTeamMode: current.shiftTeamMode,
        dayWorkerCount,
        teams: current.teams,
        dayWorkers: current.dayWorkers,
      })
      set({ shiftSettings: cloneShiftSettings(next) })
    } finally {
      set({ savingShiftSettings: false })
    }
  },
}))
