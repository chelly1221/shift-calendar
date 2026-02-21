import { ipcMain } from 'electron'
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
  getCalendarEventByLocalId,
  listCalendarEvents,
  removeCalendarEvent,
  upsertCalendarEvent,
} from '../db/eventRepository'
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
      if (isRecurringTypeChange) {
        const seriesGoogleEventId = existing.recurringEventId ?? existing.googleEventId
        if (seriesGoogleEventId) {
          await applyEventTypeToRecurringSeries(seriesGoogleEventId, saved.eventType)
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

    if (recurrenceScope === 'FUTURE' && existing.recurrenceRule) {
      const splitResult = await applyFutureSplitEdit(input)
      const splitOutboxId = await enqueueOutboxOperation({
        eventLocalId: splitResult.splitSourceEvent.localId,
        operation: 'RECUR_FUTURE',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: splitResult.splitSourceEvent.googleEventId ?? existing.googleEventId,
          splitStartUtc: input.startAtUtc,
        },
      })

      await enqueueOutboxOperation({
        eventLocalId: splitResult.futureEvent.localId,
        operation: 'CREATE',
        payload: {
          sendUpdates: input.sendUpdates,
        },
        dependsOnOutboxId: splitOutboxId,
      })
      return splitResult.futureEvent
    }

    if (recurrenceScope === 'FUTURE' && existing.recurringEventId) {
      const sourceForSplit = calendarEventSchema.parse(
        await upsertCalendarEvent({
          localId: existing.localId,
          googleEventId: existing.googleEventId,
          eventType: existing.eventType,
          summary: existing.summary,
          description: existing.description,
          location: existing.location,
          startAtUtc: existing.startAtUtc,
          endAtUtc: existing.endAtUtc,
          timeZone: existing.timeZone,
          attendees: existing.attendees,
          recurrenceRule: existing.recurrenceRule,
          recurringEventId: existing.recurringEventId,
          originalStartTimeUtc: existing.originalStartTimeUtc,
          sendUpdates: input.sendUpdates,
          recurrenceScope: 'ALL',
        }),
      )

      const futureEvent = calendarEventSchema.parse(
        await upsertCalendarEvent({
          ...input,
          localId: undefined,
          googleEventId: null,
          recurringEventId: null,
          originalStartTimeUtc: null,
        }),
      )

      const splitOutboxId = await enqueueOutboxOperation({
        eventLocalId: sourceForSplit.localId,
        operation: 'RECUR_FUTURE',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: sourceForSplit.recurringEventId,
          splitStartUtc: input.startAtUtc,
        },
      })

      await enqueueOutboxOperation({
        eventLocalId: futureEvent.localId,
        operation: 'CREATE',
        payload: {
          sendUpdates: input.sendUpdates,
        },
        dependsOnOutboxId: splitOutboxId,
      })

      return futureEvent
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
    const removed = await removeCalendarEvent(input.localId)

    if (removed) {
      await enqueueOutboxOperation({
        eventLocalId: input.localId,
        operation: 'DELETE',
        payload: {
          sendUpdates: input.sendUpdates,
          googleEventId: existing?.googleEventId ?? null,
        },
      })
    }

    return removed
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
