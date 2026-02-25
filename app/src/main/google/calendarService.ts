import { DateTime } from 'luxon'
import { google, type calendar_v3 } from 'googleapis'
import type { CalendarEvent, GoogleCalendarItem, OutboxOperation, SendUpdates } from '../../shared/calendar'
import { inferEventMetadata, toGoogleSummary } from '../../shared/eventTitleMapper'
import { splitRRuleForFuture } from '../../shared/rrule'
import type { RemoteEventSnapshot } from '../db/eventRepository'
import { getSelectedCalendar } from '../db/settingRepository'
import { getAuthorizedGoogleClient } from './oauthClient'

interface SyncQuery {
  syncToken?: string
  timeMin?: string
  timeMax?: string
  pageToken?: string
}

interface GoogleApiErrorShape {
  code?: number
  status?: number
  message?: string
  response?: {
    status?: number
    data?: {
      error?: {
        message?: string
      }
    }
  }
}

const EVENT_TYPE_PRIVATE_KEY = 'shiftCalendarEventType'

export interface SyncPage {
  events: RemoteEventSnapshot[]
  nextPageToken: string | null
  nextSyncToken: string | null
}

export interface PushResult {
  googleEventId: string | null
  googleUpdatedAtUtc: string | null
}

async function getCalendarId(): Promise<string> {
  const selected = await getSelectedCalendar()
  return selected.selectedCalendarId?.trim() || process.env.GOOGLE_CALENDAR_ID?.trim() || 'primary'
}

function isGoogleResourceMissingError(error: unknown): boolean {
  const candidate = error as GoogleApiErrorShape
  const status = candidate.code ?? candidate.status ?? candidate.response?.status
  if (status === 404) {
    return true
  }
  const message = candidate.message ?? candidate.response?.data?.error?.message
  if (typeof message !== 'string') {
    return false
  }
  const normalized = message.toLowerCase()
  return normalized.includes('resource has been deleted') || normalized.includes('not found')
}

function normalizeRRule(recurrenceRule: string): string {
  if (recurrenceRule.startsWith('RRULE:')) {
    return recurrenceRule
  }
  return `RRULE:${recurrenceRule}`
}

function fromGoogleEventDateTime(
  dateInput: calendar_v3.Schema$EventDateTime | undefined,
): { utcIso: string; timeZone: string } | null {
  if (!dateInput) {
    return null
  }

  if (dateInput.dateTime) {
    const parsed = DateTime.fromISO(dateInput.dateTime, { setZone: true })
    if (!parsed.isValid) {
      return null
    }

    return {
      utcIso: parsed.toUTC().toISO() ?? new Date().toISOString(),
      timeZone: dateInput.timeZone || parsed.zoneName || 'UTC',
    }
  }

  if (dateInput.date) {
    const zone = dateInput.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul'
    const parsed = DateTime.fromISO(dateInput.date, { zone })
    if (!parsed.isValid) {
      return null
    }
    return {
      utcIso: parsed.startOf('day').toUTC().toISO() ?? new Date().toISOString(),
      timeZone: zone,
    }
  }

  return null
}

function extractRecurrenceRule(recurrence: string[] | null | undefined): string | null {
  if (!recurrence || recurrence.length === 0) {
    return null
  }
  const rrule = recurrence.find((value) => value.startsWith('RRULE:'))
  if (!rrule) {
    return null
  }
  return rrule.replace(/^RRULE:/, '')
}

function isWholeDayEvent(event: CalendarEvent): boolean {
  const zone = event.timeZone?.trim() || 'UTC'
  const start = DateTime.fromISO(event.startAtUtc, { zone: 'utc' }).setZone(zone)
  const end = DateTime.fromISO(event.endAtUtc, { zone: 'utc' }).setZone(zone)

  if (!start.isValid || !end.isValid || end <= start) {
    return false
  }

  const isMidnight = (dt: DateTime) =>
    dt.hour === 0 && dt.minute === 0 && dt.second === 0 && dt.millisecond === 0

  if (!isMidnight(start) || !isMidnight(end)) {
    return false
  }

  // Duration must be exactly N whole days (at least 1)
  const diffDays = end.diff(start, 'days').days
  return diffDays >= 1 && Number.isInteger(diffDays)
}

export function extractEventType(event: calendar_v3.Schema$Event): string {
  const value = event.extendedProperties?.private?.[EVENT_TYPE_PRIVATE_KEY]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || '일반'
}

export function toRemoteSnapshot(event: calendar_v3.Schema$Event): RemoteEventSnapshot | null {
  const googleEventId = event.id
  if (!googleEventId) {
    return null
  }

  const isDeleted = event.status === 'cancelled'
  const updatedAtUtc = event.updated
    ? DateTime.fromISO(event.updated, { setZone: true }).toUTC().toISO() ?? new Date().toISOString()
    : new Date().toISOString()

  if (isDeleted) {
    return {
      googleEventId,
      eventType: '일반',
      summary: '',
      description: '',
      location: '',
      startAtUtc: updatedAtUtc,
      endAtUtc: updatedAtUtc,
      timeZone: 'UTC',
      recurrenceRule: null,
      recurringEventId: null,
      originalStartTimeUtc: null,
      attendees: [],
      organizerEmail: null,
      hangoutLink: null,
      googleUpdatedAtUtc: updatedAtUtc,
      isDeleted: true,
    }
  }

  const start = fromGoogleEventDateTime(event.start)
  const end = fromGoogleEventDateTime(event.end)
  if (!start || !end) {
    return null
  }

  const originalStart = fromGoogleEventDateTime(event.originalStartTime)

  const rawEventType = extractEventType(event)
  const rawSummary = event.summary ?? '(No title)'
  const rawDescription = event.description ?? ''
  const inferred = inferEventMetadata(rawSummary, rawDescription, rawEventType)

  return {
    googleEventId,
    eventType: inferred.eventType,
    summary: inferred.summary,
    description: inferred.description,
    location: event.location ?? '',
    startAtUtc: start.utcIso,
    endAtUtc: end.utcIso,
    timeZone: start.timeZone,
    recurrenceRule: extractRecurrenceRule(event.recurrence),
    recurringEventId: event.recurringEventId ?? null,
    originalStartTimeUtc: originalStart?.utcIso ?? null,
    attendees: (event.attendees ?? [])
      .map((attendee) => attendee.email ?? null)
      .filter((email): email is string => Boolean(email)),
    organizerEmail: event.organizer?.email ?? null,
    hangoutLink: event.hangoutLink ?? null,
    googleUpdatedAtUtc: updatedAtUtc,
    isDeleted: false,
  }
}

export function toGoogleEventRequest(event: CalendarEvent): calendar_v3.Schema$Event {
  const wholeDayEvent = isWholeDayEvent(event)
  const zone = event.timeZone?.trim() || 'UTC'
  const startLocal = DateTime.fromISO(event.startAtUtc, { zone: 'utc' }).setZone(zone)
  const endLocal = DateTime.fromISO(event.endAtUtc, { zone: 'utc' }).setZone(zone)

  return {
    summary: toGoogleSummary(event.summary, event.description ?? '', event.eventType),
    description: event.description || undefined,
    location: event.location || undefined,
    start: wholeDayEvent
      ? { date: startLocal.toISODate() ?? undefined }
      : {
          dateTime: startLocal.toISO() ?? event.startAtUtc,
          timeZone: zone,
        },
    end: wholeDayEvent
      ? { date: endLocal.toISODate() ?? undefined }
      : {
          dateTime: endLocal.toISO() ?? event.endAtUtc,
          timeZone: zone,
        },
    attendees: event.attendees.map((email) => ({ email })),
    recurrence: event.recurrenceRule ? [normalizeRRule(event.recurrenceRule)] : undefined,
    extendedProperties: {
      private: {
        [EVENT_TYPE_PRIVATE_KEY]: event.eventType,
      },
    },
  }
}

function alignRequestTimeShapeWithRemote(
  event: CalendarEvent,
  requestBody: calendar_v3.Schema$Event,
  remoteEvent: calendar_v3.Schema$Event,
): calendar_v3.Schema$Event {
  const zone = event.timeZone?.trim() || 'UTC'
  const start = remoteEvent.start
  const end = remoteEvent.end
  if (!start || !end) {
    return requestBody
  }

  // Keep all-day events aligned with all-day master/instance shape.
  if (start.date || end.date) {
    const startLocal = DateTime.fromISO(event.startAtUtc, { zone: 'utc' }).setZone(zone)
    const endLocal = DateTime.fromISO(event.endAtUtc, { zone: 'utc' }).setZone(zone)
    return {
      ...requestBody,
      start: { date: startLocal.toISODate() ?? undefined },
      end: { date: endLocal.toISODate() ?? undefined },
    }
  }

  // Keep timed events aligned with timed master/instance shape.
  if (start.dateTime || end.dateTime) {
    const startLocal = DateTime.fromISO(event.startAtUtc, { zone: 'utc' }).setZone(zone)
    const endLocal = DateTime.fromISO(event.endAtUtc, { zone: 'utc' }).setZone(zone)
    return {
      ...requestBody,
      start: {
        dateTime: startLocal.toISO() ?? event.startAtUtc,
        timeZone: zone,
      },
      end: {
        dateTime: endLocal.toISO() ?? event.endAtUtc,
        timeZone: zone,
      },
    }
  }

  return requestBody
}

function toPushResult(event: calendar_v3.Schema$Event | undefined): PushResult {
  if (!event) {
    return {
      googleEventId: null,
      googleUpdatedAtUtc: null,
    }
  }

  return {
    googleEventId: event.id ?? null,
    googleUpdatedAtUtc: event.updated
      ? DateTime.fromISO(event.updated, { setZone: true }).toUTC().toISO() ?? null
      : null,
  }
}

const KOREAN_HOLIDAYS_CALENDAR_ID = 'ko.south_korea#holiday@group.v.calendar.google.com'

export interface GoogleCalendarService {
  listCalendars: () => Promise<GoogleCalendarItem[]>
  pullRemoteEvents: (query: SyncQuery) => Promise<SyncPage>
  pullHolidays: (timeMin: string, timeMax: string) => Promise<RemoteEventSnapshot[]>
  fetchRemoteEvent: (googleEventId: string) => Promise<RemoteEventSnapshot | null>
  pushLocalChange: (
    operation: OutboxOperation,
    event: CalendarEvent | null,
    payload: {
      sendUpdates?: SendUpdates
      googleEventId?: string | null
      recurringEventId?: string | null
      originalStartTimeUtc?: string | null
      splitStartUtc?: string
    },
  ) => Promise<PushResult>
}

async function resolveOccurrenceEventId(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  recurringEventId: string,
  originalStartTimeUtc: string,
): Promise<string | null> {
  const pivot = DateTime.fromISO(originalStartTimeUtc, { zone: 'utc' })
  if (!pivot.isValid) {
    return null
  }

  const response = await calendar.events.instances({
    calendarId,
    eventId: recurringEventId,
    showDeleted: false,
    timeMin: pivot.minus({ days: 1 }).toISO() ?? undefined,
    timeMax: pivot.plus({ days: 1 }).toISO() ?? undefined,
    maxResults: 250,
  })

  const pivotMs = pivot.toMillis()
  for (const item of response.data.items ?? []) {
    const itemOriginalStart = fromGoogleEventDateTime(item.originalStartTime)
    if (!itemOriginalStart) {
      continue
    }
    const itemMs = Date.parse(itemOriginalStart.utcIso)
    if (!Number.isFinite(itemMs)) {
      continue
    }
    if (Math.abs(itemMs - pivotMs) <= 1000 && item.id) {
      return item.id
    }
  }

  return null
}

function toGoogleCalendarItem(entry: calendar_v3.Schema$CalendarListEntry): GoogleCalendarItem | null {
  const id = entry.id?.trim()
  const summary = entry.summary?.trim()
  if (!id || !summary) {
    return null
  }
  const accessRole = entry.accessRole ?? null
  if (accessRole !== 'owner' && accessRole !== 'writer') {
    return null
  }
  return {
    id,
    summary,
    primary: Boolean(entry.primary),
    accessRole,
  }
}

export function createGoogleCalendarService(): GoogleCalendarService {
  let cachedClient: calendar_v3.Calendar | null = null

  async function getClient(): Promise<calendar_v3.Calendar> {
    if (!cachedClient) {
      const auth = await getAuthorizedGoogleClient()
      cachedClient = google.calendar({ version: 'v3', auth })
    }
    return cachedClient
  }

  return {
    async listCalendars() {
      const calendar = await getClient()
      const items: GoogleCalendarItem[] = []
      let pageToken: string | undefined

      do {
        const response = await calendar.calendarList.list({
          maxResults: 250,
          minAccessRole: 'writer',
          showDeleted: false,
          showHidden: false,
          pageToken,
        })

        for (const entry of response.data.items ?? []) {
          const mapped = toGoogleCalendarItem(entry)
          if (mapped) {
            items.push(mapped)
          }
        }

        pageToken = response.data.nextPageToken ?? undefined
      } while (pageToken)

      return items.sort((left, right) => {
        if (left.primary && !right.primary) {
          return -1
        }
        if (!left.primary && right.primary) {
          return 1
        }
        return left.summary.localeCompare(right.summary, 'ko')
      })
    },

    async pullRemoteEvents(query) {
      console.log(`[CalendarService] pullRemoteEvents: mode=${query.syncToken ? 'DELTA' : 'FULL'}`)
      const calendar = await getClient()
      const calendarId = await getCalendarId()

      const listParams: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        singleEvents: true,
        showDeleted: true,
        maxResults: 2500,
        pageToken: query.pageToken ?? undefined,
        fields:
          'nextPageToken,nextSyncToken,items(id,summary,description,location,start,end,updated,status,recurrence,recurringEventId,originalStartTime,extendedProperties,attendees,organizer,htmlLink,hangoutLink)',
      }

      if (query.syncToken) {
        listParams.syncToken = query.syncToken
        // Do NOT include timeMin/timeMax with syncToken (incompatible per Google Calendar API)
      } else {
        if (query.timeMin) listParams.timeMin = query.timeMin
        if (query.timeMax) listParams.timeMax = query.timeMax
      }

      const response = await calendar.events.list(listParams)

      const events = (response.data.items ?? [])
        .map((item) => {
          const snapshot = toRemoteSnapshot(item)
          if (!snapshot) {
            console.warn(`[CalendarService] skipped unmappable event: id=${item.id}, status=${item.status}`)
          }
          return snapshot
        })
        .filter((item): item is RemoteEventSnapshot => Boolean(item))

      // Fetch RRULE from master events for recurring instances
      const masterRuleCache = new Map<string, string | null>()
      for (const event of events) {
        if (!event.recurringEventId || event.recurrenceRule || event.isDeleted) {
          continue
        }
        if (!masterRuleCache.has(event.recurringEventId)) {
          try {
            const master = await calendar.events.get({
              calendarId,
              eventId: event.recurringEventId,
            })
            masterRuleCache.set(
              event.recurringEventId,
              extractRecurrenceRule(master.data.recurrence),
            )
          } catch {
            masterRuleCache.set(event.recurringEventId, null)
          }
        }
        const masterRule = masterRuleCache.get(event.recurringEventId) ?? null
        if (masterRule) {
          event.recurrenceRule = masterRule
        }
      }

      console.log(`[CalendarService] pulled ${events.length} events (page ${query.pageToken ? 'next' : 'first'})`)

      return {
        events,
        nextPageToken: response.data.nextPageToken ?? null,
        nextSyncToken: response.data.nextSyncToken ?? null,
      }
    },

    async pullHolidays(timeMin, timeMax) {
      const calendar = await getClient()
      const holidays: RemoteEventSnapshot[] = []
      let pageToken: string | undefined

      do {
        const response = await calendar.events.list({
          calendarId: KOREAN_HOLIDAYS_CALENDAR_ID,
          timeMin,
          timeMax,
          singleEvents: true,
          showDeleted: false,
          maxResults: 250,
          pageToken,
        })

        for (const item of response.data.items ?? []) {
          const snapshot = toRemoteSnapshot(item)
          if (snapshot && !snapshot.isDeleted) {
            snapshot.eventType = '공휴일'
            holidays.push(snapshot)
          }
        }

        pageToken = response.data.nextPageToken ?? undefined
      } while (pageToken)

      return holidays
    },

    async fetchRemoteEvent(googleEventId) {
      console.log(`[CalendarService] fetchRemoteEvent: ${googleEventId}`)
      const calendar = await getClient()
      const calendarId = await getCalendarId()
      try {
        const response = await calendar.events.get({
          calendarId,
          eventId: googleEventId,
          alwaysIncludeEmail: true,
        })
        return toRemoteSnapshot(response.data)
      } catch (error) {
        const status = (error as { code?: number; status?: number }).code
          ?? (error as { status?: number }).status
        if (status === 404) {
          return null
        }
        throw error
      }
    },

    async pushLocalChange(operation, event, payload) {
      console.log(`[CalendarService] pushLocalChange: operation=${operation}, eventId=${event?.localId ?? 'N/A'}`)
      const calendar = await getClient()
      const calendarId = await getCalendarId()
      const sendUpdates = payload.sendUpdates ?? 'none'
      let googleEventId = payload.googleEventId ?? event?.googleEventId ?? null

      if (
        operation === 'RECUR_THIS'
        && !googleEventId
        && payload.recurringEventId
        && payload.originalStartTimeUtc
      ) {
        googleEventId = await resolveOccurrenceEventId(
          calendar,
          calendarId,
          payload.recurringEventId,
          payload.originalStartTimeUtc,
        )
      }

      if (operation === 'DELETE') {
        if (!googleEventId) {
          return { googleEventId: null, googleUpdatedAtUtc: null }
        }
        try {
          await calendar.events.delete({
            calendarId,
            eventId: googleEventId,
            sendUpdates,
          })
        } catch (error) {
          if (!isGoogleResourceMissingError(error)) {
            throw error
          }
        }
        return { googleEventId, googleUpdatedAtUtc: new Date().toISOString() }
      }

      if (operation === 'RECUR_FUTURE') {
        if (!googleEventId) {
          return { googleEventId: null, googleUpdatedAtUtc: null }
        }
        if (!payload.splitStartUtc) {
          throw new Error('RECUR_FUTURE requires splitStartUtc payload.')
        }

        const remoteResponse = await calendar.events.get({
          calendarId,
          eventId: googleEventId,
          alwaysIncludeEmail: true,
        })
        const remoteRule = extractRecurrenceRule(remoteResponse.data.recurrence)
        if (!remoteRule) {
          throw new Error('RECUR_FUTURE requires recurring remote master event.')
        }

        const splitRule = splitRRuleForFuture(remoteRule, payload.splitStartUtc)
        const response = await calendar.events.patch({
          calendarId,
          eventId: googleEventId,
          sendUpdates,
          requestBody: {
            recurrence: [normalizeRRule(splitRule)],
          },
        })
        return toPushResult(response.data)
      }

      if (!event) {
        throw new Error(`Missing local event payload for outbox operation: ${operation}`)
      }

      const requestBody = toGoogleEventRequest(event)
      if (operation === 'RECUR_ALL' && !event.recurrenceRule && googleEventId) {
        const masterResponse = await calendar.events.get({
          calendarId,
          eventId: googleEventId,
          alwaysIncludeEmail: true,
        })
        const masterRule = extractRecurrenceRule(masterResponse.data.recurrence)
        if (masterRule) {
          requestBody.recurrence = [normalizeRRule(masterRule)]
        }
      }

      if (operation === 'CREATE' || !googleEventId) {
        if (operation === 'RECUR_THIS') {
          throw new Error('Unable to resolve recurring instance id for THIS edit.')
        }
        const response = await calendar.events.insert({
          calendarId,
          sendUpdates,
          requestBody,
        })
        return toPushResult(response.data)
      }

      let patchRequestBody = requestBody
      try {
        const remoteResponse = await calendar.events.get({
          calendarId,
          eventId: googleEventId,
          alwaysIncludeEmail: true,
        })
        patchRequestBody = alignRequestTimeShapeWithRemote(event, requestBody, remoteResponse.data)
      } catch {
        // If remote prefetch fails, continue with local request body.
      }

      const response = await calendar.events.patch({
        calendarId,
        eventId: googleEventId,
        sendUpdates,
        requestBody: patchRequestBody,
      })
      return toPushResult(response.data)
    },
  }
}
