import { OutboxStatus, OutboxOperationType, SyncState, type Prisma } from '@prisma/client'
import { DateTime } from 'luxon'
import type { OutboxOperation, SendUpdates } from '../../shared/calendar'
import { getCalendarEventByLocalId, updateEventSyncState, upsertRemoteEvent } from '../db/eventRepository'
import { prisma } from '../db/prisma'
import { getSelectedCalendar, getShiftSettings } from '../db/settingRepository'
import { createGoogleCalendarService, type ShiftContext } from '../google/calendarService'

interface OutboxPayload {
  sendUpdates?: SendUpdates
  googleEventId?: string | null
  recurringEventId?: string | null
  originalStartTimeUtc?: string | null
  splitStartUtc?: string
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const MAX_ATTEMPTS = 8
let timer: NodeJS.Timeout | null = null
let isProcessing = false
let pendingFlush = false

export function requestOutboxFlush(): void {
  void processOutboxNow().catch((error) => {
    console.error('[OutboxWorker] flush failed:', error)
  })
}

function toOutboxOperationType(operation: OutboxOperation): OutboxOperationType {
  return operation as OutboxOperationType
}

function asObjectPayload(payload: Prisma.JsonValue): OutboxPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }
  return payload as OutboxPayload
}

function mergePayload(current: Prisma.JsonValue, next: OutboxPayload): Prisma.JsonObject {
  const currentPayload = asObjectPayload(current)
  return {
    ...currentPayload,
    ...next,
  } as Prisma.JsonObject
}

function nextRetryAt(attempts: number): Date {
  const baseDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]
  const jitter = Math.floor(Math.random() * baseDelay * 0.2) // 0-20% jitter
  return new Date(Date.now() + baseDelay + jitter)
}

function classifyGoogleError(error: unknown): 'TRANSIENT' | 'PERMANENT' | 'RATE_LIMITED' {
  const candidate = error as { code?: number; status?: number; response?: { status?: number } }
  const code = candidate.code ?? candidate.status ?? candidate.response?.status
  if (code === 429) return 'RATE_LIMITED'
  if (code === 401 || code === 403 || code === 404) return 'PERMANENT'
  if (code === 410 || code === 408 || code === 503 || code === 500) return 'TRANSIENT'
  return 'TRANSIENT'
}

async function findNextDueJob() {
  return prisma.outboxJob.findFirst({
    where: {
      status: {
        in: [OutboxStatus.QUEUED, OutboxStatus.FAILED],
      },
      nextRetryAtUtc: {
        lte: new Date(),
      },
      OR: [
        { dependsOnOutboxId: null },
        {
          dependsOn: {
            status: {
              in: [OutboxStatus.DONE],
            },
          },
        },
      ],
    },
    orderBy: [{ nextRetryAtUtc: 'asc' }, { createdAt: 'asc' }],
  })
}

async function cancelJob(jobId: string, reason: string, visited: Set<string> = new Set()): Promise<void> {
  if (visited.has(jobId)) return
  visited.add(jobId)

  const currentJob = await prisma.outboxJob.findUnique({
    where: { id: jobId },
    select: { eventLocalId: true },
  })
  const affectedEventLocalIds = new Set<string>()
  if (currentJob?.eventLocalId) {
    affectedEventLocalIds.add(currentJob.eventLocalId)
  }

  await prisma.outboxJob.update({
    where: { id: jobId },
    data: {
      status: OutboxStatus.CANCELLED,
      lastError: reason,
    },
  })

  const dependentJobs = await prisma.outboxJob.findMany({
    where: {
      dependsOnOutboxId: jobId,
      status: {
        in: [OutboxStatus.QUEUED, OutboxStatus.FAILED, OutboxStatus.RUNNING],
      },
    },
    select: {
      id: true,
      eventLocalId: true,
      operation: true,
    },
  })

  for (const dependent of dependentJobs) {
    if (dependent.eventLocalId) {
      affectedEventLocalIds.add(dependent.eventLocalId)
    }
    if (dependent.operation === OutboxOperationType.CREATE && dependent.eventLocalId) {
      await prisma.event.updateMany({
        where: { localId: dependent.eventLocalId },
        data: {
          isDeleted: true,
          syncState: SyncState.CLEAN,
        },
      })
    } else if (dependent.eventLocalId) {
      await prisma.event.updateMany({
        where: { localId: dependent.eventLocalId },
        data: {
          syncState: SyncState.ERROR,
        },
      })
    }
    await cancelJob(dependent.id, `Cancelled: dependency ${jobId} was cancelled.`, visited)
  }

  for (const eventLocalId of affectedEventLocalIds) {
    const activeJobs = await prisma.outboxJob.count({
      where: {
        eventLocalId,
        status: {
          in: [OutboxStatus.QUEUED, OutboxStatus.RUNNING, OutboxStatus.FAILED],
        },
      },
    })
    if (activeJobs === 0) {
      await prisma.event.updateMany({
        where: { localId: eventLocalId },
        data: { syncState: SyncState.CLEAN },
      })
    }
  }
}

async function processJob(jobId: string): Promise<boolean> {
  const job = await prisma.outboxJob.findUnique({ where: { id: jobId } })
  if (!job) {
    return false
  }

  const operation = job.operation as OutboxOperation
  const payload = asObjectPayload(job.payloadJson)
  const localEvent = job.eventLocalId ? await getCalendarEventByLocalId(job.eventLocalId) : null

  if (operation !== 'DELETE' && !localEvent) {
    await cancelJob(job.id, 'Cancelled: local event not found.')
    return true
  }

  const google = createGoogleCalendarService()
  const remoteEventId = payload.googleEventId ?? localEvent?.googleEventId

  if (remoteEventId && operation !== 'CREATE') {
    const remoteSnapshot = await google.fetchRemoteEvent(remoteEventId)
    if (remoteSnapshot?.googleUpdatedAtUtc && localEvent) {
      const remoteDt = DateTime.fromISO(remoteSnapshot.googleUpdatedAtUtc, { zone: 'utc' })
      const localDt = DateTime.fromISO(localEvent.localEditedAtUtc, { zone: 'utc' })
      if (remoteDt.isValid && localDt.isValid && remoteDt.toMillis() >= localDt.toMillis()) {
        await upsertRemoteEvent(remoteSnapshot)
        await cancelJob(job.id, 'Cancelled: remote version is newer or equal.')
        return true
      }
    }
  }

  let shiftContext: ShiftContext | undefined
  if (localEvent?.eventType === '근무') {
    const settings = await getShiftSettings()
    const allNames: string[] = []
    for (const key of ['A', 'B', 'C', 'D'] as const) {
      for (const member of settings.teams[key]) {
        const trimmed = member.trim()
        if (trimmed && !allNames.includes(trimmed)) allNames.push(trimmed)
      }
    }
    for (const worker of settings.dayWorkers) {
      const trimmed = worker.trim()
      if (trimmed && !allNames.includes(trimmed)) allNames.push(trimmed)
    }
    shiftContext = { teams: settings.teams, allNames }
  }

  const pushResult = await google.pushLocalChange(operation, localEvent, payload, shiftContext)

  if (job.eventLocalId) {
    const shouldAdoptGoogleEventId =
      Boolean(pushResult.googleEventId)
      && !localEvent?.googleEventId
    await updateEventSyncState(job.eventLocalId, {
      syncState: SyncState.CLEAN,
      googleEventId: shouldAdoptGoogleEventId ? (pushResult.googleEventId ?? undefined) : undefined,
      googleUpdatedAtUtc: pushResult.googleUpdatedAtUtc ?? undefined,
    })
  }

  await prisma.outboxJob.update({
    where: { id: job.id },
    data: {
      status: OutboxStatus.DONE,
      lastError: null,
    },
  })
  return true
}

export async function enqueueOutboxOperation(input: {
  eventLocalId?: string
  operation: OutboxOperation
  payload: OutboxPayload
  dependsOnOutboxId?: string
}): Promise<string> {
  const operation = toOutboxOperationType(input.operation)

  if (operation === OutboxOperationType.PATCH && input.eventLocalId) {
    const existing = await prisma.outboxJob.findFirst({
      where: {
        eventLocalId: input.eventLocalId,
        operation: OutboxOperationType.PATCH,
        status: {
          in: [OutboxStatus.QUEUED, OutboxStatus.FAILED, OutboxStatus.RUNNING],
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (existing) {
      await prisma.outboxJob.update({
        where: { id: existing.id },
        data: {
          payloadJson: mergePayload(existing.payloadJson, input.payload),
          status: OutboxStatus.QUEUED,
          nextRetryAtUtc: new Date(),
          lastError: null,
        },
      })
      requestOutboxFlush()
      return existing.id
    }
  }

  const created = await prisma.outboxJob.create({
    data: {
      eventLocalId: input.eventLocalId,
      operation,
      payloadJson: input.payload as Prisma.JsonObject,
      dependsOnOutboxId: input.dependsOnOutboxId,
      status: OutboxStatus.QUEUED,
      nextRetryAtUtc: new Date(),
    },
  })

  if (input.eventLocalId) {
    await updateEventSyncState(input.eventLocalId, {
      syncState: SyncState.PENDING,
    })
  }

  requestOutboxFlush()
  return created.id
}

export async function getOutboxCount(): Promise<number> {
  return prisma.outboxJob.count({
    where: {
      status: {
        in: [OutboxStatus.QUEUED, OutboxStatus.RUNNING, OutboxStatus.FAILED],
      },
    },
  })
}

export async function cancelOutboxJob(jobId: string): Promise<boolean> {
  const job = await prisma.outboxJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  })
  if (!job) {
    return false
  }
  if (job.status === OutboxStatus.DONE || job.status === OutboxStatus.CANCELLED || job.status === OutboxStatus.RUNNING) {
    return false
  }
  await cancelJob(jobId, 'Cancelled by user.')
  return true
}

export async function processOutboxNow(): Promise<number> {
  if (isProcessing) {
    pendingFlush = true
    return 0
  }
  isProcessing = true
  try {
    let total = 0
    do {
      pendingFlush = false
      total += await doProcessOutbox()
    } while (pendingFlush)
    return total
  } finally {
    isProcessing = false
  }
}

async function doProcessOutbox(): Promise<number> {
  const selectedCalendar = await getSelectedCalendar()
  if (!selectedCalendar.selectedCalendarId) {
    return 0
  }

  // Recover jobs stuck in RUNNING state for more than 5 minutes
  const RUNNING_TIMEOUT_MS = 5 * 60 * 1000
  await prisma.outboxJob.updateMany({
    where: {
      status: OutboxStatus.RUNNING,
      updatedAt: { lt: new Date(Date.now() - RUNNING_TIMEOUT_MS) },
    },
    data: {
      status: OutboxStatus.FAILED,
      lastError: 'Recovered: job was stuck in RUNNING state.',
      attempts: { increment: 1 },
    },
  })

  let processedCount = 0

  // Process all jobs due now.
  for (;;) {
    const next = await findNextDueJob()
    if (!next) {
      break
    }

    await prisma.outboxJob.update({
      where: { id: next.id },
      data: {
        status: OutboxStatus.RUNNING,
      },
    })

    try {
      const processed = await processJob(next.id)
      if (processed) {
        processedCount += 1
      }
    } catch (error) {
      const refreshed = await prisma.outboxJob.findUnique({
        where: { id: next.id },
        select: { attempts: true, eventLocalId: true },
      })
      const attempts = (refreshed?.attempts ?? next.attempts) + 1
      const errorMsg =
        error instanceof Error ? error.message : 'Outbox processing failed with unknown error.'
      const errorKind = classifyGoogleError(error)

      if (errorKind === 'PERMANENT' || attempts >= MAX_ATTEMPTS) {
        const reason = errorKind === 'PERMANENT'
          ? `Permanently failed (${errorKind}): ${errorMsg}`
          : `Permanently failed after ${MAX_ATTEMPTS} attempts: ${errorMsg}`
        await cancelJob(next.id, reason)
        continue
      }

      const retryAt = nextRetryAt(attempts)
      await prisma.outboxJob.update({
        where: { id: next.id },
        data: {
          status: OutboxStatus.FAILED,
          attempts,
          nextRetryAtUtc: retryAt,
          lastError: errorMsg,
        },
      })

      if (refreshed?.eventLocalId) {
        await updateEventSyncState(refreshed.eventLocalId, {
          syncState: SyncState.ERROR,
        })
      }

      if (errorKind === 'RATE_LIMITED') {
        // Stop processing entirely when rate-limited.
        break
      }

      // TRANSIENT: continue to next job
    }
  }

  return processedCount
}

export function startOutboxWorker(): void {
  if (timer) {
    return
  }

  void processOutboxNow()
  timer = setInterval(() => {
    void processOutboxNow()
  }, 60_000)
}

export function stopOutboxWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
