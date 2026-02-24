import { OutboxStatus, OutboxOperationType, SyncState, type Prisma } from '@prisma/client'
import type { OutboxOperation, SendUpdates } from '../../shared/calendar'
import { getCalendarEventByLocalId, updateEventSyncState, upsertRemoteEvent } from '../db/eventRepository'
import { prisma } from '../db/prisma'
import { getSelectedCalendar } from '../db/settingRepository'
import { createGoogleCalendarService } from '../google/calendarService'

interface OutboxPayload {
  sendUpdates?: SendUpdates
  googleEventId?: string | null
  recurringEventId?: string | null
  originalStartTimeUtc?: string | null
  splitStartUtc?: string
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
let timer: NodeJS.Timeout | null = null
let isRunning = false
let pendingFlushRequested = false

function requestOutboxFlush(): void {
  if (isRunning) {
    pendingFlushRequested = true
    return
  }
  void processOutboxNow()
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
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]
  return new Date(Date.now() + delay)
}

function isGoogleApi410(error: unknown): boolean {
  const candidate = error as {
    code?: number
    status?: number
    response?: {
      status?: number
    }
  }
  return candidate.code === 410 || candidate.status === 410 || candidate.response?.status === 410
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

async function cancelJob(jobId: string, reason: string): Promise<void> {
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

  await prisma.outboxJob.updateMany({
    where: {
      dependsOnOutboxId: jobId,
      status: {
        in: [OutboxStatus.QUEUED, OutboxStatus.FAILED, OutboxStatus.RUNNING],
      },
    },
    data: {
      status: OutboxStatus.CANCELLED,
      lastError: `Cancelled: dependency ${jobId} was cancelled.`,
    },
  })

  for (const dependent of dependentJobs) {
    if (!dependent.eventLocalId) {
      continue
    }
    affectedEventLocalIds.add(dependent.eventLocalId)
    if (dependent.operation === OutboxOperationType.CREATE) {
      await prisma.event.updateMany({
        where: { localId: dependent.eventLocalId },
        data: {
          isDeleted: true,
          syncState: SyncState.CLEAN,
        },
      })
      continue
    }
    await prisma.event.updateMany({
      where: { localId: dependent.eventLocalId },
      data: {
        syncState: SyncState.ERROR,
      },
    })
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
      const remoteMs = Date.parse(remoteSnapshot.googleUpdatedAtUtc)
      const localMs = Date.parse(localEvent.localEditedAtUtc)
      if (Number.isFinite(remoteMs) && Number.isFinite(localMs) && remoteMs >= localMs) {
        await upsertRemoteEvent(remoteSnapshot)
        await cancelJob(job.id, 'Cancelled: remote version is newer or equal.')
        return true
      }
    }
  }

  const pushResult = await google.pushLocalChange(operation, localEvent, payload)

  if (job.eventLocalId) {
    await updateEventSyncState(job.eventLocalId, {
      syncState: SyncState.CLEAN,
      googleEventId: pushResult.googleEventId ?? undefined,
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
          in: [OutboxStatus.QUEUED, OutboxStatus.FAILED],
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
  const selectedCalendar = await getSelectedCalendar()
  if (!selectedCalendar.selectedCalendarId) {
    return 0
  }

  if (isRunning) {
    pendingFlushRequested = true
    return 0
  }
  isRunning = true

  let processedCount = 0
  try {
    // Process all jobs due now. When a job fails, stop this cycle and wait for backoff window.
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
        const retryAt = nextRetryAt(attempts)
        await prisma.outboxJob.update({
          where: { id: next.id },
          data: {
            status: OutboxStatus.FAILED,
            attempts,
            nextRetryAtUtc: retryAt,
            lastError:
              error instanceof Error ? error.message : 'Outbox processing failed with unknown error.',
          },
        })

        if (refreshed?.eventLocalId) {
          await updateEventSyncState(refreshed.eventLocalId, {
            syncState: SyncState.ERROR,
          })
        }

        if (isGoogleApi410(error)) {
          // 410 is sync-token related; keep retries but stop immediate burst.
          break
        }

        break
      }
    }
  } finally {
    isRunning = false
  }

  if (pendingFlushRequested) {
    pendingFlushRequested = false
    void processOutboxNow()
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
