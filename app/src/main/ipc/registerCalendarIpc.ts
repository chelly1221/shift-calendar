import { app, dialog, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { copyFileSync, statSync, unlinkSync } from 'node:fs'
import { loadRefreshToken, saveRefreshToken } from '../security/tokenStore'
import { parseRRuleSegments, splitRRuleForFuture, withoutRRuleEnd } from '../../shared/rrule'
import {
  cancelOutboxJobInputSchema,
  calendarEventSchema,
  deleteCalendarEventSchema,
  forcePushResultSchema,
  googleCalendarItemSchema,
  googleConnectionStatusSchema,
  googleOAuthConfigSchema,
  listOutboxJobsInputSchema,
  listEventsInputSchema,
  outboxJobItemSchema,
  selectedCalendarSchema,
  setGoogleOAuthConfigInputSchema,
  setShiftSettingsInputSchema,
  setSelectedCalendarInputSchema,
  shiftSettingsSchema,
  syncResultSchema,
  upsertCalendarEventSchema,
} from '../../shared/calendar'
import {
  applyEventTypeToRecurringSeries,
  applyFutureSplitEdit,
  applyFutureSplitForDelete,
  getCalendarEventByLocalId,
  listCalendarEvents,
  removeCalendarEvent,
  upsertCalendarEvent,
} from '../db/eventRepository'
import { dbFilePath, dbImportStagingPath, prisma } from '../db/prisma'
import {
  ensureSetting,
  getAccountEmail,
  getGoogleOAuthConfig,
  getShiftSettings,
  getSelectedCalendar,
  setAccountEmail,
  setGoogleOAuthConfig,
  setShiftSettings,
  setSelectedCalendar,
} from '../db/settingRepository'
import { createGoogleCalendarService } from '../google/calendarService'
import {
  connectGoogleInteractive,
  disconnectGoogleAccount,
  isGoogleConnected,
  isGoogleOAuthConfigured,
} from '../google/oauthClient'
import { cancelOutboxJob, enqueueOutboxOperation, getOutboxCount } from '../sync/outboxWorker'
import { forcePushAllToGoogle, reEnqueueShiftAbbreviationSync, runSyncNow } from '../sync/syncEngine'
import { IPC_CHANNELS } from './channels'

function wrapIpcError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(error.message)
  }
  return new Error(String(error))
}

export function registerCalendarIpc(): void {
  const googleCalendarService = createGoogleCalendarService()

  ipcMain.removeHandler(IPC_CHANNELS.listEvents)
  ipcMain.removeHandler(IPC_CHANNELS.upsertEvent)
  ipcMain.removeHandler(IPC_CHANNELS.deleteEvent)
  ipcMain.removeHandler(IPC_CHANNELS.getOutboxCount)
  ipcMain.removeHandler(IPC_CHANNELS.listOutboxJobs)
  ipcMain.removeHandler(IPC_CHANNELS.cancelOutboxJob)
  ipcMain.removeHandler(IPC_CHANNELS.syncNow)
  ipcMain.removeHandler(IPC_CHANNELS.forcePushAll)
  ipcMain.removeHandler(IPC_CHANNELS.connectGoogle)
  ipcMain.removeHandler(IPC_CHANNELS.disconnectGoogle)
  ipcMain.removeHandler(IPC_CHANNELS.getGoogleConnectionStatus)
  ipcMain.removeHandler(IPC_CHANNELS.listGoogleCalendars)
  ipcMain.removeHandler(IPC_CHANNELS.getSelectedCalendar)
  ipcMain.removeHandler(IPC_CHANNELS.setSelectedCalendar)
  ipcMain.removeHandler(IPC_CHANNELS.getShiftSettings)
  ipcMain.removeHandler(IPC_CHANNELS.setShiftSettings)
  ipcMain.removeHandler(IPC_CHANNELS.getGoogleOAuthConfig)
  ipcMain.removeHandler(IPC_CHANNELS.setGoogleOAuthConfig)
  ipcMain.removeHandler(IPC_CHANNELS.exportDatabase)
  ipcMain.removeHandler(IPC_CHANNELS.importDatabase)

  ipcMain.handle(IPC_CHANNELS.listEvents, async (_event, payload?: unknown) => {
    const input =
      payload === undefined
        ? undefined
        : listEventsInputSchema.parse(payload)
    const events = await listCalendarEvents(input)
    return events.map((calendarEvent) => calendarEventSchema.parse(calendarEvent))
  })

  ipcMain.handle(IPC_CHANNELS.upsertEvent, async (_event, payload: unknown) => {
    try {
    const input = upsertCalendarEventSchema.parse(payload)
    if (!input.localId) {
      const created = calendarEventSchema.parse(await upsertCalendarEvent(input))
      await enqueueOutboxOperation({
        eventLocalId: created.localId,
        operation: 'CREATE',
        payload: {
          sendUpdates: input.sendUpdates,
        },
      })
      return created
    }

    const existing = await getCalendarEventByLocalId(input.localId)
    if (!existing) {
      const created = calendarEventSchema.parse(await upsertCalendarEvent(input))
      await enqueueOutboxOperation({
        eventLocalId: created.localId,
        operation: 'CREATE',
        payload: {
          sendUpdates: input.sendUpdates,
        },
      })
      return created
    }

    const hasRecurringContext =
      Boolean(existing.recurrenceRule)
      || Boolean(existing.recurringEventId)
      || Boolean(input.recurrenceRule)
    const nextEventType = input.eventType.trim()
    const currentEventType = existing.eventType.trim()
    const isRecurringTypeChange = hasRecurringContext && nextEventType !== currentEventType
    // skipWeekendsAndHolidays is a series-level setting — force ALL scope
    // to prevent THIS-scope from corrupting the master's startAtUtc with a shifted date.
    const skipChanged = Boolean(input.skipWeekendsAndHolidays) !== Boolean(existing.skipWeekendsAndHolidays)
    const recurrenceScope = isRecurringTypeChange ? 'ALL'
      : (skipChanged && hasRecurringContext) ? 'ALL'
      : input.recurrenceScope

    // When skip changes, propagate to the master's recurrenceJson as a side-effect.
    // Don't return early — let the normal ALL/THIS/FUTURE flow proceed.
    if (skipChanged && hasRecurringContext) {
      let masterLocalId = existing.localId
      let masterRule = existing.recurrenceRule
      if (existing.recurringEventId && !existing.recurrenceRule) {
        const masterRow = await prisma.event.findFirst({
          where: { googleEventId: existing.recurringEventId, isDeleted: false },
          select: { localId: true, recurrenceJson: true },
        })
        if (masterRow) {
          masterLocalId = masterRow.localId
          const json = masterRow.recurrenceJson
          if (json && typeof json === 'object' && !Array.isArray(json) && 'rrule' in json && typeof json.rrule === 'string') {
            masterRule = json.rrule
          }
        }
      }
      if (masterRule) {
        const recurrenceJson = input.skipWeekendsAndHolidays
          ? { rrule: masterRule, skipWeekendsAndHolidays: true }
          : { rrule: masterRule }
        await prisma.event.update({
          where: { localId: masterLocalId },
          data: { recurrenceJson, localEditedAtUtc: new Date(), syncState: 'PENDING' },
        })
      }
    }

    if (!hasRecurringContext || recurrenceScope === 'ALL') {
      // For ALL scope on a recurring master, preserve its original startAtUtc/endAtUtc.
      // The input may carry a shifted date from a virtual instance (skipWeekendsAndHolidays),
      // which would corrupt the master's recurrence origin.
      const isMaster = Boolean(existing.recurrenceRule) && !existing.recurringEventId
      let preservedStartAtUtc = existing.startAtUtc
      let preservedEndAtUtc = existing.endAtUtc

      // When skipChanged forced ALL scope on a Google instance (not the master),
      // the master's recurrenceJson was already updated (lines above). We need to:
      // 1. Preserve the master's startAtUtc/endAtUtc (not the instance's)
      // 2. Return the master event so the store can update it in memory
      let resolvedMasterLocalId: string | null = null
      if (skipChanged && !isMaster && existing.recurringEventId) {
        const masterRow = await prisma.event.findFirst({
          where: { googleEventId: existing.recurringEventId, isDeleted: false },
          select: { localId: true, startAtUtc: true, endAtUtc: true },
        })
        if (masterRow) {
          resolvedMasterLocalId = masterRow.localId
          preservedStartAtUtc = masterRow.startAtUtc.toISOString()
          preservedEndAtUtc = masterRow.endAtUtc.toISOString()
        }
      }

      // Self-healing: if master's startAtUtc weekday doesn't match WEEKLY BYDAY,
      // recalculate to the first valid occurrence (fixes previously corrupted data).
      if (isMaster && existing.recurrenceRule && existing.skipWeekendsAndHolidays) {
        const segments = parseRRuleSegments(existing.recurrenceRule)
        const freq = segments.get('FREQ')
        const byday = segments.get('BYDAY')
        if (freq === 'WEEKLY' && byday) {
          const WEEKDAY_ISO: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }
          const targetDays = byday.split(',').map((d) => WEEKDAY_ISO[d.trim().toUpperCase()]).filter(Boolean)
          const startDt = new Date(preservedStartAtUtc)
          const currentDay = startDt.getUTCDay() === 0 ? 7 : startDt.getUTCDay() // ISO weekday
          if (targetDays.length > 0 && !targetDays.includes(currentDay)) {
            // Find the nearest matching weekday (forward)
            for (let offset = 1; offset <= 7; offset++) {
              const candidateDay = ((currentDay - 1 + offset) % 7) + 1
              if (targetDays.includes(candidateDay)) {
                const durationMs = new Date(preservedEndAtUtc).getTime() - startDt.getTime()
                startDt.setUTCDate(startDt.getUTCDate() + offset)
                preservedStartAtUtc = startDt.toISOString()
                preservedEndAtUtc = new Date(startDt.getTime() + durationMs).toISOString()
                console.debug(`[IPC] Self-healed master startAtUtc: weekday ${currentDay} → ${candidateDay}`)
                break
              }
            }
          }
        }
      }

      const shouldPreserveStart = (isMaster && recurrenceScope === 'ALL') || resolvedMasterLocalId
      const effectiveInput = shouldPreserveStart
        ? { ...input, startAtUtc: preservedStartAtUtc, endAtUtc: preservedEndAtUtc }
        : input
      const saved = calendarEventSchema.parse(await upsertCalendarEvent(effectiveInput))
      const targetGoogleEventId =
        hasRecurringContext && recurrenceScope === 'ALL' && saved.recurringEventId
          ? saved.recurringEventId
          : saved.googleEventId ?? input.googleEventId ?? null
      await enqueueOutboxOperation({
        eventLocalId: resolvedMasterLocalId ?? saved.localId,
        operation: hasRecurringContext ? 'RECUR_ALL' : 'PATCH',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: resolvedMasterLocalId ? existing.recurringEventId : (targetGoogleEventId ?? null),
          recurringEventId: saved.recurringEventId ?? input.recurringEventId ?? null,
          originalStartTimeUtc: saved.originalStartTimeUtc ?? input.originalStartTimeUtc ?? null,
        },
      })

      // ALL scope: also update child instances so local display reflects changes immediately
      const seriesGoogleEventId = existing.recurringEventId ?? existing.googleEventId
      if (hasRecurringContext && seriesGoogleEventId) {
        await prisma.event.updateMany({
          where: {
            recurringEventId: seriesGoogleEventId,
            isDeleted: false,
          },
          data: {
            eventType: input.eventType.trim() || '일반',
            summary: input.summary,
            description: input.description || null,
            location: input.location || null,
            timeZone: input.timeZone,
            localEditedAtUtc: new Date(),
          },
        })
      }

      if (isRecurringTypeChange && seriesGoogleEventId) {
        await applyEventTypeToRecurringSeries(seriesGoogleEventId, saved.eventType)
      }

      // When skipChanged on a Google instance, return the master event so the
      // store's upsertEventInMemory updates the master (not just the instance),
      // enabling immediate UI re-expansion with the correct skip flag.
      if (resolvedMasterLocalId) {
        const masterEvent = await getCalendarEventByLocalId(resolvedMasterLocalId)
        if (masterEvent) {
          return calendarEventSchema.parse(masterEvent)
        }
      }
      return saved
    }

    if (recurrenceScope === 'THIS') {
      const needsSyntheticOverride =
        Boolean(existing.recurrenceRule)
        && Boolean(existing.googleEventId)
        && !existing.recurringEventId
        && !existing.originalStartTimeUtc
      const saveInput = needsSyntheticOverride
        ? {
            ...input,
            localId: undefined,
            googleEventId: null,
            recurrenceRule: null,
            recurringEventId: existing.googleEventId,
            originalStartTimeUtc: input.originalStartTimeUtc ?? input.startAtUtc,
            recurrenceScope: 'THIS' as const,
          }
        : input

      const saved = calendarEventSchema.parse(await upsertCalendarEvent(saveInput))
      await enqueueOutboxOperation({
        eventLocalId: saved.localId,
        operation: 'RECUR_THIS',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: saved.googleEventId ?? saveInput.googleEventId ?? null,
          recurringEventId: saved.recurringEventId ?? saveInput.recurringEventId ?? null,
          originalStartTimeUtc: saved.originalStartTimeUtc ?? saveInput.originalStartTimeUtc ?? null,
        },
      })
      return saved
    }

    if (recurrenceScope === 'FUTURE' && existing.recurrenceRule && !existing.recurringEventId) {
      // Real master event (has RRULE, no recurringEventId)
      // For shifted virtual instances, use the unshifted originalStartTimeUtc as the split boundary
      // to avoid splitting at a shifted date that doesn't align with the actual recurrence.
      const futureSplitStartUtc = (existing.skipWeekendsAndHolidays && input.originalStartTimeUtc)
        ? input.originalStartTimeUtc
        : input.startAtUtc
      const futureInput = (futureSplitStartUtc !== input.startAtUtc)
        ? { ...input, startAtUtc: futureSplitStartUtc, endAtUtc: futureSplitStartUtc }
        : input
      console.debug(`FUTURE branch 1: localId=${input.localId}, googleEventId=${existing.googleEventId}, recurrenceRule=${existing.recurrenceRule}, splitAt=${futureSplitStartUtc}`)
      try {
        const splitResult = await applyFutureSplitEdit(futureInput)
        console.debug(`FUTURE branch 1: split done. master=${splitResult.splitSourceEvent.localId}, future=${splitResult.futureEvent.localId}, futureRule=${splitResult.futureEvent.recurrenceRule}`)
        const masterGoogleId = splitResult.splitSourceEvent.googleEventId ?? existing.googleEventId
        const splitOutboxId = await enqueueOutboxOperation({
          eventLocalId: splitResult.splitSourceEvent.localId,
          operation: 'RECUR_FUTURE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: masterGoogleId,
            splitStartUtc: futureSplitStartUtc,
          },
        })

        await enqueueOutboxOperation({
          eventLocalId: splitResult.futureEvent.localId,
          operation: 'CREATE',
          payload: {
            sendUpdates: input.sendUpdates,
          },
          dependsOnOutboxId: masterGoogleId ? splitOutboxId : undefined,
        })
        return splitResult.futureEvent
      } catch (error) {
        console.debug(`FUTURE branch 1 ERROR: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }

    if (recurrenceScope === 'FUTURE' && existing.recurringEventId) {
      // Instance of a Google-synced recurring series
      const masterGoogleEventId = existing.recurringEventId
      console.debug(`FUTURE branch 2: instanceLocalId=${input.localId}, masterGoogleEventId=${masterGoogleEventId}`)

      // Look up the master's RRULE so the future series inherits it
      const masterRow = await prisma.event.findFirst({
        where: { googleEventId: masterGoogleEventId, isDeleted: false },
        select: { localId: true, recurrenceJson: true },
        orderBy: { localId: 'asc' },
      })
      let masterRRule: string | null = null
      let masterSkipWeekendsAndHolidays = false
      const masterJson = masterRow?.recurrenceJson
      if (masterJson && typeof masterJson === 'object' && !Array.isArray(masterJson) && 'rrule' in masterJson && typeof masterJson.rrule === 'string') {
        masterRRule = masterJson.rrule
        masterSkipWeekendsAndHolidays = 'skipWeekendsAndHolidays' in masterJson && masterJson.skipWeekendsAndHolidays === true
      }
      console.debug(`FUTURE branch 2: masterRow=${masterRow?.localId ?? 'NOT_FOUND'}, masterRRule=${masterRRule}, inputRule=${input.recurrenceRule}, existingRule=${existing.recurrenceRule}`)

      // Use input recurrenceRule, then fall back to master's RRULE, then existing (synced copy)
      const rawFutureRule = input.recurrenceRule || masterRRule || existing.recurrenceRule

      if (!rawFutureRule) {
        console.debug('FUTURE branch 2: no RRULE found — falling through to fallback')
        // No RRULE found anywhere — fall through to fallback
      } else {
        try {
          const futureRecurrenceRule = withoutRRuleEnd(rawFutureRule)
          // Use unshifted date for split boundary when skipWeekendsAndHolidays is active
          const splitStartUtc = (masterSkipWeekendsAndHolidays && input.originalStartTimeUtc)
            ? input.originalStartTimeUtc
            : input.startAtUtc
          const now = new Date()

          // Truncate master's RRULE locally (add UNTIL before splitStartUtc)
          if (masterRow) {
            const splitRule = splitRRuleForFuture(rawFutureRule, splitStartUtc)
            const splitRecurrenceJson = masterSkipWeekendsAndHolidays
              ? { rrule: splitRule, skipWeekendsAndHolidays: true }
              : { rrule: splitRule }
            await prisma.event.update({
              where: { localId: masterRow.localId },
              data: {
                recurrenceJson: splitRecurrenceJson,
                localEditedAtUtc: now,
                syncState: 'PENDING',
              },
            })
          }

          // Mark future Google instances as deleted locally
          const splitDate = new Date(splitStartUtc)
          await prisma.event.updateMany({
            where: {
              recurringEventId: masterGoogleEventId,
              startAtUtc: { gte: splitDate },
              isDeleted: false,
            },
            data: {
              isDeleted: true,
              localEditedAtUtc: now,
            },
          })

          // Create the new future recurring event (inherit master's skip flag if input doesn't override)
          // Use the unshifted split start as the new series origin so expansion generates correct occurrences
          const futureEvent = calendarEventSchema.parse(
            await upsertCalendarEvent({
              ...input,
              startAtUtc: splitStartUtc,
              skipWeekendsAndHolidays: input.skipWeekendsAndHolidays || masterSkipWeekendsAndHolidays,
              localId: undefined,
              googleEventId: null,
              recurringEventId: null,
              originalStartTimeUtc: null,
              recurrenceRule: futureRecurrenceRule,
            }),
          )
          console.debug(`FUTURE branch 2: futureEvent created localId=${futureEvent.localId}, rule=${futureEvent.recurrenceRule}`)

          // Queue outbox: truncate master on Google
          const splitOutboxId = await enqueueOutboxOperation({
            eventLocalId: masterRow?.localId ?? existing.localId,
            operation: 'RECUR_FUTURE',
            payload: {
              sendUpdates: input.sendUpdates,
              googleEventId: masterGoogleEventId,
              splitStartUtc,
            },
          })

          // Queue outbox: create new future series on Google
          await enqueueOutboxOperation({
            eventLocalId: futureEvent.localId,
            operation: 'CREATE',
            payload: {
              sendUpdates: input.sendUpdates,
            },
            dependsOnOutboxId: splitOutboxId,
          })

          return futureEvent
        } catch (error) {
          console.debug(`FUTURE branch 2 ERROR: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        }
      }
    }

    console.warn('[IPC] FUTURE edit fallback: treating as RECUR_ALL for event', input.localId)
    const fallback = calendarEventSchema.parse(await upsertCalendarEvent(input))
    await enqueueOutboxOperation({
      eventLocalId: fallback.localId,
      operation: 'RECUR_ALL',
      payload: {
        sendUpdates: input.sendUpdates,
      },
    })
    return fallback
    } catch (error) {
      throw wrapIpcError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.deleteEvent, async (_event, payload: unknown) => {
    try {
    const input = deleteCalendarEventSchema.parse(payload)
    const existing = await getCalendarEventByLocalId(input.localId)
    if (!existing) {
      return false
    }

    const hasRecurringContext =
      Boolean(existing.recurrenceRule) || Boolean(existing.recurringEventId)
    const recurrenceScope = hasRecurringContext ? input.recurrenceScope : 'ALL'

    // Non-recurring or ALL: delete the whole series (or single event)
    if (!hasRecurringContext || recurrenceScope === 'ALL') {
      const seriesGoogleEventId = existing.recurringEventId ?? existing.googleEventId
      const masterEvent =
        recurrenceScope === 'ALL' && existing.recurringEventId
          ? await prisma.event.findUnique({
              where: { googleEventId: existing.recurringEventId },
              select: { localId: true },
            })
          : null
      const targetLocalId = masterEvent?.localId ?? input.localId
      const masterGoogleEventId =
        recurrenceScope === 'ALL' && existing.recurringEventId
          ? existing.recurringEventId
          : existing.googleEventId
      const removed = await removeCalendarEvent(targetLocalId)
      if (removed) {
        // ALL scope: also mark child instances as deleted locally
        if (hasRecurringContext && seriesGoogleEventId) {
          await prisma.event.updateMany({
            where: {
              recurringEventId: seriesGoogleEventId,
              isDeleted: false,
            },
            data: {
              isDeleted: true,
              localEditedAtUtc: new Date(),
            },
          })
        }

        await enqueueOutboxOperation({
          eventLocalId: targetLocalId,
          operation: 'DELETE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: masterGoogleEventId ?? null,
          },
        })
      }
      return removed
    }

    // THIS: delete only this single instance
    if (recurrenceScope === 'THIS') {
      const isMaster =
        Boolean(existing.recurrenceRule)
        && Boolean(existing.googleEventId)
        && !existing.recurringEventId
      const removed = await removeCalendarEvent(input.localId)
      if (removed) {
        await enqueueOutboxOperation({
          eventLocalId: input.localId,
          operation: 'DELETE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: existing.googleEventId ?? null,
            recurringEventId: isMaster ? existing.googleEventId : (existing.recurringEventId ?? null),
            originalStartTimeUtc: existing.originalStartTimeUtc ?? existing.startAtUtc,
          },
        })
      }
      return removed
    }

    // FUTURE: truncate RRULE up to splitStartUtc, no new series created
    if (recurrenceScope === 'FUTURE') {
      const isMaster =
        Boolean(existing.recurrenceRule)
        && !existing.recurringEventId

      if (isMaster) {
        const splitResult = await applyFutureSplitForDelete(
          existing.localId,
          existing.startAtUtc,
        )
        await enqueueOutboxOperation({
          eventLocalId: splitResult.splitSourceEvent.localId,
          operation: 'RECUR_FUTURE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: splitResult.splitSourceEvent.googleEventId ?? existing.googleEventId,
            splitStartUtc: existing.startAtUtc,
          },
        })
        return true
      }

      // Instance event: find master via recurringEventId and truncate
      const masterGoogleEventId = existing.recurringEventId
      if (masterGoogleEventId) {
        const masterEvent = await prisma.event.findUnique({
          where: { googleEventId: masterGoogleEventId },
        })
        if (masterEvent) {
          const splitResult = await applyFutureSplitForDelete(
            masterEvent.localId,
            existing.startAtUtc,
          )
          await enqueueOutboxOperation({
            eventLocalId: splitResult.splitSourceEvent.localId,
            operation: 'RECUR_FUTURE',
            payload: {
              sendUpdates: input.sendUpdates,
              googleEventId: masterGoogleEventId,
              splitStartUtc: existing.startAtUtc,
            },
          })
          return true
        }
      }

      // Fallback: just delete the single event
      const removed = await removeCalendarEvent(input.localId)
      if (removed) {
        await enqueueOutboxOperation({
          eventLocalId: input.localId,
          operation: 'DELETE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: existing.googleEventId ?? null,
          },
        })
      }
      return removed
    }

    return false
    } catch (error) {
      throw wrapIpcError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.getOutboxCount, () => getOutboxCount())

  ipcMain.handle(IPC_CHANNELS.listOutboxJobs, async (_event, payload?: unknown) => {
    const input =
      payload === undefined
        ? listOutboxJobsInputSchema.parse({})
        : listOutboxJobsInputSchema.parse(payload)

    const jobs = await prisma.outboxJob.findMany({
      where: input.includeCompleted
        ? undefined
        : {
            status: {
              in: ['QUEUED', 'RUNNING', 'FAILED'],
            },
          },
      include: {
        event: {
          select: {
            summary: true,
            eventType: true,
          },
        },
      },
      orderBy: input.includeCompleted
        ? [
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
          ]
        : [
            { nextRetryAtUtc: 'asc' },
            { createdAt: 'asc' },
          ],
      take: input.limit,
    })

    return jobs.map((job) =>
      outboxJobItemSchema.parse({
        id: job.id,
        operation: job.operation,
        status: job.status,
        attempts: job.attempts,
        nextRetryAtUtc: job.nextRetryAtUtc.toISOString(),
        lastError: job.lastError,
        eventLocalId: job.eventLocalId,
        eventSummary: job.event?.summary ?? null,
        eventType: job.event?.eventType ?? null,
        createdAtUtc: job.createdAt.toISOString(),
        updatedAtUtc: job.updatedAt.toISOString(),
      }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.cancelOutboxJob, async (_event, payload: unknown) => {
    const input = cancelOutboxJobInputSchema.parse(payload)
    return cancelOutboxJob(input.jobId)
  })

  ipcMain.handle(IPC_CHANNELS.syncNow, async () => {
    const result = await runSyncNow()
    return syncResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.forcePushAll, async () => {
    const result = await forcePushAllToGoogle()
    return forcePushResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.connectGoogle, async () => {
    try {
    await ensureSetting()
    if (!(await isGoogleOAuthConfigured())) {
      return googleConnectionStatusSchema.parse({
        connected: false,
        accountEmail: null,
      })
    }
    const result = await connectGoogleInteractive()
    await setAccountEmail(result.accountEmail)
    return googleConnectionStatusSchema.parse({
      connected: true,
      accountEmail: result.accountEmail,
    })
    } catch (error) {
      throw wrapIpcError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.disconnectGoogle, async () => {
    await ensureSetting()
    await disconnectGoogleAccount()
    await setAccountEmail(null)
    return googleConnectionStatusSchema.parse({
      connected: false,
      accountEmail: null,
    })
  })

  ipcMain.handle(IPC_CHANNELS.getGoogleConnectionStatus, async () => {
    await ensureSetting()
    const connected = (await isGoogleOAuthConfigured()) && (await isGoogleConnected())
    const accountEmail = connected ? await getAccountEmail() : null
    return googleConnectionStatusSchema.parse({
      connected,
      accountEmail,
    })
  })

  ipcMain.handle(IPC_CHANNELS.listGoogleCalendars, async () => {
    await ensureSetting()
    const oauthConfigured = await isGoogleOAuthConfigured()
    const googleConnected = await isGoogleConnected()
    console.debug('[IPC] listGoogleCalendars: oauthConfigured=%s, googleConnected=%s', oauthConfigured, googleConnected)
    if (!oauthConfigured || !googleConnected) {
      return []
    }

    const calendars = await googleCalendarService.listCalendars()
    console.debug('[IPC] listGoogleCalendars: found %d calendars', calendars.length)
    return calendars.map((calendar) => googleCalendarItemSchema.parse(calendar))
  })

  ipcMain.handle(IPC_CHANNELS.getSelectedCalendar, async () => {
    await ensureSetting()
    const selected = await getSelectedCalendar()
    return selectedCalendarSchema.parse({
      calendarId: selected.selectedCalendarId,
      calendarSummary: selected.selectedCalendarSummary,
    })
  })

  ipcMain.handle(IPC_CHANNELS.setSelectedCalendar, async (_event, payload: unknown) => {
    await ensureSetting()
    const input = setSelectedCalendarInputSchema.parse(payload)
    await setSelectedCalendar({
      calendarId: input.calendarId,
      calendarSummary: input.calendarSummary ?? null,
    })
    return selectedCalendarSchema.parse({
      calendarId: input.calendarId,
      calendarSummary: input.calendarSummary ?? null,
    })
  })

  ipcMain.handle(IPC_CHANNELS.getShiftSettings, async () => {
    await ensureSetting()
    const settings = await getShiftSettings()
    return shiftSettingsSchema.parse(settings)
  })

  ipcMain.handle(IPC_CHANNELS.setShiftSettings, async (_event, payload: unknown) => {
    await ensureSetting()
    const input = setShiftSettingsInputSchema.parse(payload)
    const oldSettings = await getShiftSettings()
    const settings = await setShiftSettings(input)

    // Only re-sync if teams, dayWorkers, or abbreviations changed
    const teamsChanged = JSON.stringify(oldSettings.teams) !== JSON.stringify(settings.teams)
    const dayWorkersChanged = JSON.stringify(oldSettings.dayWorkers) !== JSON.stringify(settings.dayWorkers)
    const abbreviationsChanged = JSON.stringify(oldSettings.abbreviations) !== JSON.stringify(settings.abbreviations)
    if (teamsChanged || dayWorkersChanged || abbreviationsChanged) {
      void reEnqueueShiftAbbreviationSync().catch((error) => {
        console.error('[IPC] reEnqueueShiftAbbreviationSync failed:', error)
      })
    }

    return shiftSettingsSchema.parse(settings)
  })

  ipcMain.handle(IPC_CHANNELS.getGoogleOAuthConfig, async () => {
    const config = await getGoogleOAuthConfig()
    const configured = Boolean(config.clientId && config.clientSecret)
    return googleOAuthConfigSchema.parse({
      clientId: config.clientId,
      clientSecret: configured ? '********' : null,
      configured,
    })
  })

  ipcMain.handle(IPC_CHANNELS.setGoogleOAuthConfig, async (_event, payload: unknown) => {
    const input = setGoogleOAuthConfigInputSchema.parse(payload)
    await setGoogleOAuthConfig(input.clientId, input.clientSecret)
    return googleOAuthConfigSchema.parse({
      clientId: input.clientId,
      clientSecret: '********',
      configured: true,
    })
  })

  ipcMain.handle(IPC_CHANNELS.exportDatabase, async () => {
    const result = await dialog.showSaveDialog({
      title: '데이터베이스 내보내기',
      defaultPath: 'calendar-backup.db',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    })
    if (result.canceled || !result.filePath) return false
    // 기존 파일이 있으면 삭제 (VACUUM INTO는 덮어쓰기 불가)
    try { unlinkSync(result.filePath) } catch { /* not found */ }
    const db = new Database(dbFilePath)
    try {
      const escaped = result.filePath.replace(/'/g, "''")
      db.exec(`VACUUM INTO '${escaped}'`)
    } finally {
      db.close()
    }
    // 내보낸 DB에 refresh token + 환경변수 OAuth 설정 포함
    const exportDb = new Database(result.filePath)
    try {
      exportDb.exec('CREATE TABLE IF NOT EXISTS "_export_tokens" ("key" TEXT PRIMARY KEY, "value" TEXT)')
      const refreshToken = await loadRefreshToken()
      if (refreshToken) {
        exportDb.prepare('INSERT OR REPLACE INTO "_export_tokens" ("key", "value") VALUES (?, ?)').run('refreshToken', refreshToken)
      }
      // 환경변수에서 OAuth 설정이 있으면 DB Setting에 기록
      const envClientId = process.env.GOOGLE_CLIENT_ID?.trim()
      const envClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
      if (envClientId && envClientSecret) {
        exportDb.prepare('UPDATE "Setting" SET "googleClientId" = ?, "googleClientSecret" = ? WHERE "id" = 1').run(envClientId, envClientSecret)
      }
      // accountEmail이 NULL이면 현재 연결된 계정 정보 기록
      const setting = exportDb.prepare('SELECT "accountEmail" FROM "Setting" WHERE "id" = 1').get() as { accountEmail: string | null } | undefined
      if (!setting?.accountEmail) {
        const email = await getAccountEmail()
        if (email) {
          exportDb.prepare('UPDATE "Setting" SET "accountEmail" = ? WHERE "id" = 1').run(email)
        }
      }
    } finally {
      exportDb.close()
    }
    return true
  })

  ipcMain.handle(IPC_CHANNELS.importDatabase, async () => {
    const result = await dialog.showOpenDialog({
      title: '데이터베이스 가져오기',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return false
    const srcPath = result.filePaths[0]
    const srcSize = statSync(srcPath).size
    copyFileSync(srcPath, dbImportStagingPath)
    const stagedSize = statSync(dbImportStagingPath).size
    if (stagedSize !== srcSize) {
      throw new Error(`Staging file size mismatch: expected ${srcSize}, got ${stagedSize}`)
    }
    // staging DB에서 refresh token 복원 후 임시 테이블 삭제
    const importDb = new Database(dbImportStagingPath)
    try {
      const row = importDb.prepare('SELECT "value" FROM "_export_tokens" WHERE "key" = ?').get('refreshToken') as { value: string } | undefined
      if (row?.value) {
        await saveRefreshToken(row.value)
      }
      importDb.exec('DROP TABLE IF EXISTS "_export_tokens"')
    } catch {
      // _export_tokens 테이블이 없는 DB도 허용
    } finally {
      importDb.close()
    }
    dialog.showMessageBoxSync({
      type: 'info',
      title: '가져오기 준비 완료',
      message: '앱을 다시 실행하면 가져온 데이터가 적용됩니다.',
    })
    app.exit(0)
    return true
  })
}
