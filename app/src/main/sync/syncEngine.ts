import { DateTime } from 'luxon'
import { SyncState } from '@prisma/client'
import type { ForcePushResult, SyncResult } from '../../shared/calendar'
import { ensureSetting, markSyncWindowUnbounded, setSyncToken } from '../db/settingRepository'
import { upsertRemoteEvents } from '../db/eventRepository'
import { prisma } from '../db/prisma'
import { createGoogleCalendarService } from '../google/calendarService'
import { isGoogleConnected, isGoogleOAuthConfigured } from '../google/oauthClient'
import { enqueueOutboxOperation, getOutboxCount, processOutboxNow } from './outboxWorker'

interface SyncErrorShape {
  code?: number
  status?: number
  response?: {
    status?: number
  }
}

function isSyncTokenExpiredError(error: unknown): boolean {
  const candidate = error as SyncErrorShape
  return candidate.code === 410 || candidate.status === 410 || candidate.response?.status === 410
}

const UNBOUNDED_SYNC_WINDOW_START = DateTime.utc(1900, 1, 1).startOf('day')
const UNBOUNDED_SYNC_WINDOW_END = DateTime.utc(9999, 12, 31).endOf('day')

function requiresFullBackfill(setting: {
  syncWindowStartUtc: Date
  syncWindowEndUtc: Date
}): boolean {
  const start = DateTime.fromJSDate(setting.syncWindowStartUtc).toUTC()
  const end = DateTime.fromJSDate(setting.syncWindowEndUtc).toUTC()
  return start > UNBOUNDED_SYNC_WINDOW_START || end < UNBOUNDED_SYNC_WINDOW_END
}

async function pullRemote(mode: 'FULL' | 'DELTA'): Promise<number> {
  const setting = await ensureSetting()
  const google = createGoogleCalendarService()
  let pulledEvents = 0
  let nextPageToken: string | undefined
  let nextSyncToken: string | null = null

  do {
    const page =
      mode === 'DELTA'
        ? await google.pullRemoteEvents({
            syncToken: setting.syncToken ?? undefined,
            pageToken: nextPageToken,
          })
        : await google.pullRemoteEvents({
            pageToken: nextPageToken,
          })

    await upsertRemoteEvents(page.events)
    pulledEvents += page.events.length
    nextPageToken = page.nextPageToken ?? undefined
    if (page.nextSyncToken) {
      nextSyncToken = page.nextSyncToken
      await setSyncToken(nextSyncToken)
    }
  } while (nextPageToken)

  return pulledEvents
}

async function pullHolidays(): Promise<number> {
  const google = createGoogleCalendarService()
  const timeMin = DateTime.local().minus({ months: 3 }).startOf('month').toUTC().toISO()
  const timeMax = DateTime.local().plus({ months: 12 }).endOf('month').toUTC().toISO()
  if (!timeMin || !timeMax) {
    return 0
  }

  try {
    const holidays = await google.pullHolidays(timeMin, timeMax)
    await upsertRemoteEvents(holidays)
    return holidays.length
  } catch (error) {
    console.error('Failed to pull Korean holidays:', error)
    return 0
  }
}

export async function forcePushAllToGoogle(): Promise<ForcePushResult> {
  await ensureSetting()

  if (!(await isGoogleOAuthConfigured()) || !(await isGoogleConnected())) {
    return { enqueuedJobs: 0, processedJobs: 0, skippedEvents: 0 }
  }

  const setting = await ensureSetting()
  if (!setting.selectedCalendarId) {
    return { enqueuedJobs: 0, processedJobs: 0, skippedEvents: 0 }
  }

  const BATCH_SIZE = 500
  const now = new Date()
  let enqueuedJobs = 0
  let skippedEvents = 0
  let skip = 0

  // Process in batches to avoid loading entire table into memory
  for (;;) {
    const localEvents = await prisma.event.findMany({
      where: {
        OR: [
          { isDeleted: false },
          { isDeleted: true, googleEventId: { not: null } },
        ],
        eventType: { not: '공휴일' },
      },
      orderBy: { localId: 'asc' },
      take: BATCH_SIZE,
      skip,
    })
    if (localEvents.length === 0) break
    skip += localEvents.length

  for (const event of localEvents) {
    // Touch localEditedAtUtc so conflict resolution always favors local
    await prisma.event.update({
      where: { localId: event.localId },
      data: { localEditedAtUtc: now, syncState: SyncState.PENDING },
    })

    // Deleted events with a Google ID need a remote DELETE
    if (event.isDeleted) {
      if (event.googleEventId) {
        await enqueueOutboxOperation({
          eventLocalId: event.localId,
          operation: 'DELETE',
          payload: {
            googleEventId: event.googleEventId,
            sendUpdates: 'none',
          },
        })
        enqueuedJobs += 1
      } else {
        skippedEvents += 1
      }
      continue
    }

    const hasRecurrenceRule = Boolean(event.recurrenceJson
      && typeof event.recurrenceJson === 'object'
      && !Array.isArray(event.recurrenceJson)
      && 'rrule' in event.recurrenceJson)
    const hasRecurringEventId = Boolean(event.recurringEventId)

    if (hasRecurrenceRule && !hasRecurringEventId) {
      // Master recurring event → push entire series
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'RECUR_ALL',
        payload: {
          googleEventId: event.googleEventId,
          sendUpdates: 'none',
        },
      })
      enqueuedJobs += 1
    } else if (hasRecurringEventId && event.googleEventId) {
      // Override instance of a recurring series
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'RECUR_THIS',
        payload: {
          googleEventId: event.googleEventId,
          recurringEventId: event.recurringEventId,
          originalStartTimeUtc: event.originalStartTimeUtc?.toISOString() ?? null,
          sendUpdates: 'none',
        },
      })
      enqueuedJobs += 1
    } else if (hasRecurringEventId && !event.googleEventId) {
      // Virtual/unsynced recurring instance without its own Google ID — skip
      skippedEvents += 1
    } else if (event.googleEventId) {
      // Regular event with Google ID → patch
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'PATCH',
        payload: {
          googleEventId: event.googleEventId,
          sendUpdates: 'none',
        },
      })
      enqueuedJobs += 1
    } else {
      // New local event without Google ID → create
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'CREATE',
        payload: {
          sendUpdates: 'none',
        },
      })
      enqueuedJobs += 1
    }
  }
  } // end batch loop

  // Process all enqueued jobs
  const processedJobs = await processOutboxNow()

  return { enqueuedJobs, processedJobs, skippedEvents }
}

export async function runSyncNow(): Promise<SyncResult> {
  await ensureSetting()

  if (!(await isGoogleOAuthConfigured()) || !(await isGoogleConnected())) {
    return {
      mode: 'SKIPPED',
      pulledEvents: 0,
      pushedOutboxJobs: 0,
      outboxRemaining: await getOutboxCount(),
    }
  }

  const setting = await ensureSetting()
  if (!setting.selectedCalendarId) {
    return {
      mode: 'SKIPPED',
      pulledEvents: 0,
      pushedOutboxJobs: 0,
      outboxRemaining: await getOutboxCount(),
    }
  }

  const shouldRunFullBackfill = requiresFullBackfill(setting)
  if (shouldRunFullBackfill) {
    await markSyncWindowUnbounded()
    await setSyncToken(null)
  }

  const pushedOutboxJobs = await processOutboxNow()
  if (shouldRunFullBackfill || !setting.syncToken) {
    const pulledEvents = await pullRemote('FULL')
    await pullHolidays()
    return {
      mode: 'FULL',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  }

  try {
    const pulledEvents = await pullRemote('DELTA')
    await pullHolidays()
    return {
      mode: 'DELTA',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  } catch (error) {
    if (!isSyncTokenExpiredError(error)) {
      throw error
    }

    await setSyncToken(null)
    const pulledEvents = await pullRemote('FULL')
    await pullHolidays()
    return {
      mode: 'FULL',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  }
}
