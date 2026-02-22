import { ipcMain } from 'electron'
import { splitRRuleForFuture, withoutRRuleEnd } from '../../shared/rrule'
import { appendFileSync } from 'node:fs'

function debugLog(message: string): void {
  try {
    appendFileSync('/tmp/future-split-debug.log', `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // ignore
  }
}
import {
  calendarEventSchema,
  deleteCalendarEventSchema,
  googleCalendarItemSchema,
  googleConnectionStatusSchema,
  listEventsInputSchema,
  selectedCalendarSchema,
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
import { prisma } from '../db/prisma'
import {
  ensureSetting,
  getAccountEmail,
  getShiftSettings,
  getSelectedCalendar,
  setAccountEmail,
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
import { enqueueOutboxOperation, getOutboxCount } from '../sync/outboxWorker'
import { runSyncNow } from '../sync/syncEngine'
import { IPC_CHANNELS } from './channels'

export function registerCalendarIpc(): void {
  const googleCalendarService = createGoogleCalendarService()

  ipcMain.removeHandler(IPC_CHANNELS.listEvents)
  ipcMain.removeHandler(IPC_CHANNELS.upsertEvent)
  ipcMain.removeHandler(IPC_CHANNELS.deleteEvent)
  ipcMain.removeHandler(IPC_CHANNELS.getOutboxCount)
  ipcMain.removeHandler(IPC_CHANNELS.syncNow)
  ipcMain.removeHandler(IPC_CHANNELS.connectGoogle)
  ipcMain.removeHandler(IPC_CHANNELS.disconnectGoogle)
  ipcMain.removeHandler(IPC_CHANNELS.getGoogleConnectionStatus)
  ipcMain.removeHandler(IPC_CHANNELS.listGoogleCalendars)
  ipcMain.removeHandler(IPC_CHANNELS.getSelectedCalendar)
  ipcMain.removeHandler(IPC_CHANNELS.setSelectedCalendar)
  ipcMain.removeHandler(IPC_CHANNELS.getShiftSettings)
  ipcMain.removeHandler(IPC_CHANNELS.setShiftSettings)

  ipcMain.handle(IPC_CHANNELS.listEvents, async (_event, payload?: unknown) => {
    const input =
      payload === undefined
        ? undefined
        : listEventsInputSchema.parse(payload)
    const events = await listCalendarEvents(input)
    return events.map((calendarEvent) => calendarEventSchema.parse(calendarEvent))
  })

  ipcMain.handle(IPC_CHANNELS.upsertEvent, async (_event, payload: unknown) => {
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
    const recurrenceScope = isRecurringTypeChange ? 'ALL' : input.recurrenceScope

    if (!hasRecurringContext || recurrenceScope === 'ALL') {
      const saved = calendarEventSchema.parse(await upsertCalendarEvent(input))
      const targetGoogleEventId =
        hasRecurringContext && recurrenceScope === 'ALL' && saved.recurringEventId
          ? saved.recurringEventId
          : saved.googleEventId ?? input.googleEventId ?? null
      await enqueueOutboxOperation({
        eventLocalId: saved.localId,
        operation: hasRecurringContext ? 'RECUR_ALL' : 'PATCH',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: targetGoogleEventId,
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
      debugLog(`FUTURE branch 1: localId=${input.localId}, googleEventId=${existing.googleEventId}, recurrenceRule=${existing.recurrenceRule}`)
      try {
        const splitResult = await applyFutureSplitEdit(input)
        debugLog(`FUTURE branch 1: split done. master=${splitResult.splitSourceEvent.localId}, future=${splitResult.futureEvent.localId}, futureRule=${splitResult.futureEvent.recurrenceRule}`)
        const masterGoogleId = splitResult.splitSourceEvent.googleEventId ?? existing.googleEventId
        const splitOutboxId = await enqueueOutboxOperation({
          eventLocalId: splitResult.splitSourceEvent.localId,
          operation: 'RECUR_FUTURE',
          payload: {
            sendUpdates: input.sendUpdates,
            googleEventId: masterGoogleId,
            splitStartUtc: input.startAtUtc,
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
        debugLog(`FUTURE branch 1 ERROR: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }

    if (recurrenceScope === 'FUTURE' && existing.recurringEventId) {
      // Instance of a Google-synced recurring series
      const masterGoogleEventId = existing.recurringEventId
      debugLog(`FUTURE branch 2: instanceLocalId=${input.localId}, masterGoogleEventId=${masterGoogleEventId}`)

      // Look up the master's RRULE so the future series inherits it
      const masterRow = await prisma.event.findFirst({
        where: { googleEventId: masterGoogleEventId, isDeleted: false },
        select: { localId: true, recurrenceJson: true },
      })
      let masterRRule: string | null = null
      const masterJson = masterRow?.recurrenceJson
      if (masterJson && typeof masterJson === 'object' && !Array.isArray(masterJson) && 'rrule' in masterJson && typeof masterJson.rrule === 'string') {
        masterRRule = masterJson.rrule
      }
      debugLog(`FUTURE branch 2: masterRow=${masterRow?.localId ?? 'NOT_FOUND'}, masterRRule=${masterRRule}, inputRule=${input.recurrenceRule}, existingRule=${existing.recurrenceRule}`)

      // Use input recurrenceRule, then fall back to master's RRULE, then existing (synced copy)
      const rawFutureRule = input.recurrenceRule || masterRRule || existing.recurrenceRule

      if (!rawFutureRule) {
        debugLog('FUTURE branch 2: no RRULE found — falling through to fallback')
        // No RRULE found anywhere — fall through to fallback
      } else {
        try {
          const futureRecurrenceRule = withoutRRuleEnd(rawFutureRule)
          const splitStartUtc = input.startAtUtc
          const now = new Date()

          // Truncate master's RRULE locally (add UNTIL before splitStartUtc)
          if (masterRow) {
            const splitRule = splitRRuleForFuture(rawFutureRule, splitStartUtc)
            await prisma.event.update({
              where: { localId: masterRow.localId },
              data: {
                recurrenceJson: { rrule: splitRule },
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

          // Create the new future recurring event
          const futureEvent = calendarEventSchema.parse(
            await upsertCalendarEvent({
              ...input,
              localId: undefined,
              googleEventId: null,
              recurringEventId: null,
              originalStartTimeUtc: null,
              recurrenceRule: futureRecurrenceRule,
            }),
          )
          debugLog(`FUTURE branch 2: futureEvent created localId=${futureEvent.localId}, rule=${futureEvent.recurrenceRule}`)

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
          debugLog(`FUTURE branch 2 ERROR: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        }
      }
    }

    const fallback = calendarEventSchema.parse(await upsertCalendarEvent(input))
    await enqueueOutboxOperation({
      eventLocalId: fallback.localId,
      operation: 'RECUR_ALL',
      payload: {
        sendUpdates: input.sendUpdates,
      },
    })
    return fallback
  })

  ipcMain.handle(IPC_CHANNELS.deleteEvent, async (_event, payload: unknown) => {
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
      const masterGoogleEventId =
        recurrenceScope === 'ALL' && existing.recurringEventId
          ? existing.recurringEventId
          : existing.googleEventId
      const removed = await removeCalendarEvent(input.localId)
      if (removed) {
        // ALL scope: also mark child instances as deleted locally
        const seriesGoogleEventId = existing.recurringEventId ?? existing.googleEventId
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
          eventLocalId: input.localId,
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
  })

  ipcMain.handle(IPC_CHANNELS.getOutboxCount, () => getOutboxCount())

  ipcMain.handle(IPC_CHANNELS.syncNow, async () => {
    const result = await runSyncNow()
    return syncResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.connectGoogle, async () => {
    await ensureSetting()
    if (!isGoogleOAuthConfigured()) {
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
    const connected = isGoogleOAuthConfigured() && (await isGoogleConnected())
    const accountEmail = connected ? await getAccountEmail() : null
    return googleConnectionStatusSchema.parse({
      connected,
      accountEmail,
    })
  })

  ipcMain.handle(IPC_CHANNELS.listGoogleCalendars, async () => {
    await ensureSetting()
    const connected = isGoogleOAuthConfigured() && (await isGoogleConnected())
    if (!connected) {
      return []
    }

    const calendars = await googleCalendarService.listCalendars()
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
    const settings = await setShiftSettings(input)
    return shiftSettingsSchema.parse(settings)
  })
}
