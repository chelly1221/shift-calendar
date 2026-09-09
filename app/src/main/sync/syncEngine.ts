import { DateTime } from 'luxon'
import { OutboxStatus, SyncState } from '@prisma/client'
import type { ForcePushResult, SyncResult } from '../../shared/calendar'
import { ensureSetting, getShiftSettings, isCalendarSwitching, markSyncWindowUnbounded, setSyncToken } from '../db/settingRepository'
import { upsertRemoteEvents } from '../db/eventRepository'
import { prisma } from '../db/prisma'
import { createGoogleCalendarService } from '../google/calendarService'
import { isGoogleConnected, isGoogleOAuthConfigured } from '../google/oauthClient'
import { enqueueOutboxOperation, getOutboxCount, processOutboxNow } from './outboxWorker'
import { buildShiftNameContext, inferVacationEvent } from '../../shared/eventTitleMapper'

interface SyncErrorShape {
  code?: number
  status?: number
  response?: {
    status?: number
  }
}

function isSyncTokenExpiredError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const candidate = error as SyncErrorShape
  return candidate.code === 410 || candidate.status === 410 || candidate.response?.status === 410
}

let isSyncRunning = false
let isForcePushRunning = false
let isReEnqueueRunning = false
let isVacationConversionRunning = false

export function isCalendarSyncBusy(): boolean {
  return isSyncRunning || isForcePushRunning || isReEnqueueRunning || isVacationConversionRunning
}

function hasRecurrenceRuleJson(recurrenceJson: unknown): boolean {
  return Boolean(
    recurrenceJson
    && typeof recurrenceJson === 'object'
    && !Array.isArray(recurrenceJson)
    && 'rrule' in recurrenceJson,
  )
}

/**
 * 이미 로컬에 있는 '일반' 일정 중 제목에 휴가 키워드가 있는 것을 휴가로 변환하고 Google에 PATCH를 큐잉한다.
 * 델타 동기화는 Google에서 바뀐 일정만 가져오므로, 기능 추가 이전에 받아둔 일정과 팀원/약어 설정 변경으로
 * 새로 인식 가능해진 일정은 이 패스가 아니면 변환되지 않는다. runSyncNow 시작 시(오프라인 포함)와
 * 팀원/약어 설정 변경 시 실행. 반복 일정(마스터/인스턴스)은 시리즈 처리 복잡성 때문에 건너뛴다.
 */
export async function convertBasicVacationEvents(): Promise<number> {
  if (isVacationConversionRunning || isCalendarSwitching()) {
    return 0
  }
  isVacationConversionRunning = true
  try {
    const nameContext = buildShiftNameContext(await getShiftSettings())
    const candidates = await prisma.event.findMany({
      where: { eventType: '일반', isDeleted: false, recurringEventId: null },
      select: { localId: true, googleEventId: true, summary: true, description: true, recurrenceJson: true },
      orderBy: { localId: 'asc' },
    })

    const now = new Date()
    let converted = 0
    for (const event of candidates) {
      if (hasRecurrenceRuleJson(event.recurrenceJson)) continue
      const inferred = inferVacationEvent(event.summary, event.description ?? '', nameContext)
      if (!inferred) continue

      await prisma.event.update({
        where: { localId: event.localId },
        data: {
          eventType: inferred.eventType,
          summary: inferred.summary,
          description: inferred.description || null,
          localEditedAtUtc: now,
          syncState: SyncState.PENDING,
        },
      })
      // googleEventId 가 없으면 이미 큐잉된 CREATE(또는 reconcile)가 변환된 데이터를 그대로 올린다.
      if (event.googleEventId) {
        await enqueueOutboxOperation({
          eventLocalId: event.localId,
          operation: 'PATCH',
          payload: { googleEventId: event.googleEventId, sendUpdates: 'none' },
        })
      }
      console.debug(`[SyncEngine] 일반 → 휴가 자동 전환: "${event.summary}" → "${inferred.summary}"`)
      converted += 1
    }

    if (converted > 0) {
      console.log(`[SyncEngine] convertBasicVacationEvents converted ${converted} events`)
    }
    return converted
  } finally {
    isVacationConversionRunning = false
  }
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
    console.error('Failed to pull Korean holidays (timeMin=%s, timeMax=%s):', timeMin, timeMax, error)
    return 0
  }
}

export async function forcePushAllToGoogle(): Promise<ForcePushResult> {
  if (isForcePushRunning || isCalendarSwitching()) {
    return { enqueuedJobs: 0, processedJobs: 0, skippedEvents: 0 }
  }
  isForcePushRunning = true
  try {
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
  } finally {
    isForcePushRunning = false
  }
}

export async function reEnqueueShiftAbbreviationSync(): Promise<number> {
  if (isReEnqueueRunning || isCalendarSwitching()) {
    return 0
  }
  isReEnqueueRunning = true
  try {
    if (!(await isGoogleOAuthConfigured()) || !(await isGoogleConnected())) {
      return 0
    }

    const setting = await ensureSetting()
    if (!setting.selectedCalendarId) {
      return 0
    }

    const now = new Date()
    let enqueuedJobs = 0

    const shiftEvents = await prisma.event.findMany({
      where: {
        eventType: '근무',
        isDeleted: false,
        googleEventId: { not: null },
        description: { contains: '대체근무자' },
      },
      orderBy: { localId: 'asc' },
    })

    for (const event of shiftEvents) {
      await prisma.event.update({
        where: { localId: event.localId },
        data: { localEditedAtUtc: now, syncState: SyncState.PENDING },
      })

      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'PATCH',
        payload: {
          googleEventId: event.googleEventId,
          sendUpdates: 'none',
        },
      })
      enqueuedJobs += 1
    }

    return enqueuedJobs
  } finally {
    isReEnqueueRunning = false
  }
}

async function reconcileLocalToRemote(): Promise<number> {
  const events = await prisma.event.findMany({
    where: {
      isDeleted: false,
      eventType: { not: '공휴일' },
      OR: [
        { googleEventId: null },
        { syncState: { in: [SyncState.PENDING, SyncState.ERROR] } },
      ],
      outboxJobs: {
        none: {
          status: { in: [OutboxStatus.QUEUED, OutboxStatus.RUNNING, OutboxStatus.FAILED] },
        },
      },
    },
  })

  let enqueued = 0
  for (const event of events) {
    const hasRecurrenceRule = Boolean(
      event.recurrenceJson
      && typeof event.recurrenceJson === 'object'
      && !Array.isArray(event.recurrenceJson)
      && 'rrule' in event.recurrenceJson,
    )
    const hasRecurringEventId = Boolean(event.recurringEventId)

    if (hasRecurringEventId && !event.googleEventId) {
      if (!event.originalStartTimeUtc || !event.recurringEventId) continue
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'RECUR_THIS',
        payload: {
          googleEventId: null,
          recurringEventId: event.recurringEventId,
          originalStartTimeUtc: event.originalStartTimeUtc.toISOString(),
          sendUpdates: 'none',
        },
      })
      enqueued += 1
    } else if (hasRecurrenceRule && !hasRecurringEventId && event.googleEventId) {
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'RECUR_ALL',
        payload: { googleEventId: event.googleEventId, sendUpdates: 'none' },
      })
      enqueued += 1
    } else if (event.googleEventId) {
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'PATCH',
        payload: { googleEventId: event.googleEventId, sendUpdates: 'none' },
      })
      enqueued += 1
    } else {
      await enqueueOutboxOperation({
        eventLocalId: event.localId,
        operation: 'CREATE',
        payload: { sendUpdates: 'none' },
      })
      enqueued += 1
    }
  }

  if (enqueued > 0) {
    console.log(`[SyncEngine] reconcileLocalToRemote enqueued ${enqueued} jobs`)
  }
  return enqueued
}

export async function runSyncNow(options?: { reconcile?: boolean }): Promise<SyncResult> {
  if (isSyncRunning || isCalendarSwitching()) {
    return { mode: 'SKIPPED' as const, pulledEvents: 0, pushedOutboxJobs: 0, outboxRemaining: await getOutboxCount() }
  }
  isSyncRunning = true
  try {
    // 연결 여부와 무관하게 로컬 변환은 먼저 (오프라인이어도 화면에 휴가로 보이고, PATCH 는 연결 후 밀려 나감)
    try {
      await convertBasicVacationEvents()
    } catch (error) {
      console.warn('[SyncEngine] convertBasicVacationEvents failed:', error)
    }

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

    if (options?.reconcile) {
      await reconcileLocalToRemote()
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
  } finally {
    isSyncRunning = false
  }
}
