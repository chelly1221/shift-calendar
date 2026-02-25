import { z } from 'zod'

export const syncStateSchema = z.enum(['CLEAN', 'PENDING', 'ERROR'])
export type SyncState = z.infer<typeof syncStateSchema>

export const outboxOperationSchema = z.enum([
  'CREATE',
  'PATCH',
  'DELETE',
  'RECUR_THIS',
  'RECUR_ALL',
  'RECUR_FUTURE',
])
export type OutboxOperation = z.infer<typeof outboxOperationSchema>

export const outboxStatusSchema = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'])
export type OutboxStatus = z.infer<typeof outboxStatusSchema>

export const outboxJobItemSchema = z.object({
  id: z.string().min(1),
  operation: outboxOperationSchema,
  status: outboxStatusSchema,
  attempts: z.number().int().min(0),
  nextRetryAtUtc: z.string().datetime(),
  lastError: z.string().nullable(),
  eventLocalId: z.string().nullable(),
  eventSummary: z.string().nullable(),
  eventType: z.string().nullable(),
  createdAtUtc: z.string().datetime(),
  updatedAtUtc: z.string().datetime(),
})
export type OutboxJobItem = z.infer<typeof outboxJobItemSchema>

export const listOutboxJobsInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(80),
  includeCompleted: z.boolean().default(false),
})
export type ListOutboxJobsInput = z.infer<typeof listOutboxJobsInputSchema>

export const cancelOutboxJobInputSchema = z.object({
  jobId: z.string().min(1),
})
export type CancelOutboxJobInput = z.infer<typeof cancelOutboxJobInputSchema>

export const sendUpdatesSchema = z.enum(['all', 'none'])
export type SendUpdates = z.infer<typeof sendUpdatesSchema>

export const recurrenceEditScopeSchema = z.enum(['THIS', 'ALL', 'FUTURE'])
export type RecurrenceEditScope = z.infer<typeof recurrenceEditScopeSchema>
export const eventTypeSchema = z.string().trim().min(1).max(40)
export type EventType = z.infer<typeof eventTypeSchema>

export const calendarEventSchema = z.object({
  localId: z.string().min(1),
  googleEventId: z.string().min(1).nullable(),
  eventType: eventTypeSchema.default('일반'),
  summary: z.string().trim().min(1),
  description: z.string().default(''),
  location: z.string().default(''),
  startAtUtc: z.string().datetime(),
  endAtUtc: z.string().datetime(),
  timeZone: z.string().min(1),
  attendees: z.array(z.string().email()),
  recurrenceRule: z.string().nullable(),
  recurringEventId: z.string().min(1).nullable(),
  originalStartTimeUtc: z.string().datetime().nullable(),
  organizerEmail: z.string().nullable(),
  hangoutLink: z.string().url().nullable(),
  googleUpdatedAtUtc: z.string().datetime().nullable(),
  localEditedAtUtc: z.string().datetime(),
  syncState: syncStateSchema,
})
export type CalendarEvent = z.infer<typeof calendarEventSchema>

export const upsertCalendarEventSchema = z.object({
  localId: z.string().min(1).optional(),
  googleEventId: z.string().min(1).nullable().optional(),
  eventType: eventTypeSchema.default('일반'),
  summary: z.string().trim().min(1),
  description: z.string().default(''),
  location: z.string().default(''),
  startAtUtc: z.string().datetime(),
  endAtUtc: z.string().datetime(),
  timeZone: z.string().min(1),
  attendees: z.array(z.string().email()).default([]),
  recurrenceRule: z.string().nullable().optional(),
  recurringEventId: z.string().min(1).nullable().optional(),
  originalStartTimeUtc: z.string().datetime().nullable().optional(),
  sendUpdates: sendUpdatesSchema.default('none'),
  recurrenceScope: recurrenceEditScopeSchema.default('ALL'),
})
export type UpsertCalendarEventInput = z.infer<typeof upsertCalendarEventSchema>

export const listEventsInputSchema = z.object({
  rangeStartUtc: z.string().datetime().optional(),
  rangeEndUtc: z.string().datetime().optional(),
})
export type ListEventsInput = z.infer<typeof listEventsInputSchema>

export const deleteCalendarEventSchema = z.object({
  localId: z.string().min(1),
  sendUpdates: sendUpdatesSchema.default('none'),
  recurrenceScope: recurrenceEditScopeSchema.default('ALL'),
})
export type DeleteCalendarEventInput = z.infer<typeof deleteCalendarEventSchema>

export const syncResultSchema = z.object({
  mode: z.enum(['FULL', 'DELTA', 'SKIPPED']),
  pulledEvents: z.number().int().min(0),
  pushedOutboxJobs: z.number().int().min(0),
  outboxRemaining: z.number().int().min(0),
})
export type SyncResult = z.infer<typeof syncResultSchema>

export const forcePushResultSchema = z.object({
  enqueuedJobs: z.number().int().min(0),
  processedJobs: z.number().int().min(0),
  skippedEvents: z.number().int().min(0),
})
export type ForcePushResult = z.infer<typeof forcePushResultSchema>

export const googleConnectionStatusSchema = z.object({
  connected: z.boolean(),
  accountEmail: z.string().email().nullable(),
})
export type GoogleConnectionStatus = z.infer<typeof googleConnectionStatusSchema>

export const googleCalendarItemSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  primary: z.boolean(),
  accessRole: z.string().nullable(),
})
export type GoogleCalendarItem = z.infer<typeof googleCalendarItemSchema>

export const selectedCalendarSchema = z.object({
  calendarId: z.string().min(1).nullable(),
  calendarSummary: z.string().nullable(),
})
export type SelectedCalendar = z.infer<typeof selectedCalendarSchema>

export const setSelectedCalendarInputSchema = z.object({
  calendarId: z.string().min(1),
  calendarSummary: z.string().min(1).nullable().optional(),
})
export type SetSelectedCalendarInput = z.infer<typeof setSelectedCalendarInputSchema>

export const shiftTypeSchema = z.enum(['DAY_NIGHT_OFF_OFF'])
export type ShiftType = z.infer<typeof shiftTypeSchema>
export const shiftTeamModeSchema = z.enum(['SINGLE', 'PAIR'])
export type ShiftTeamMode = z.infer<typeof shiftTeamModeSchema>
export const dayWorkerCountSchema = z.number().int().min(1).max(5)
export type DayWorkerCount = z.infer<typeof dayWorkerCountSchema>

export const shiftTeamMembersSchema = z.array(z.string().trim().min(1).max(40)).max(2)
export const dayWorkerMembersSchema = z.array(z.string().trim().min(1).max(40)).max(5)
export const shiftTeamAssignmentsSchema = z.object({
  A: shiftTeamMembersSchema,
  B: shiftTeamMembersSchema,
  C: shiftTeamMembersSchema,
  D: shiftTeamMembersSchema,
})
export type ShiftTeamAssignments = z.infer<typeof shiftTeamAssignmentsSchema>

export const shiftSettingsSchema = z.object({
  shiftType: shiftTypeSchema,
  shiftTeamMode: shiftTeamModeSchema,
  dayWorkerCount: dayWorkerCountSchema,
  teams: shiftTeamAssignmentsSchema,
  dayWorkers: dayWorkerMembersSchema,
})
export type ShiftSettings = z.infer<typeof shiftSettingsSchema>

export const setShiftSettingsInputSchema = shiftSettingsSchema
export type SetShiftSettingsInput = z.infer<typeof setShiftSettingsInputSchema>

export const defaultShiftSettings: ShiftSettings = {
  shiftType: 'DAY_NIGHT_OFF_OFF',
  shiftTeamMode: 'PAIR',
  dayWorkerCount: 2,
  teams: {
    A: [],
    B: [],
    C: [],
    D: [],
  },
  dayWorkers: [],
}

export interface CalendarApi {
  listEvents: (input?: ListEventsInput) => Promise<CalendarEvent[]>
  upsertEvent: (payload: UpsertCalendarEventInput) => Promise<CalendarEvent>
  deleteEvent: (payload: DeleteCalendarEventInput) => Promise<boolean>
  getOutboxCount: () => Promise<number>
  listOutboxJobs: (input?: ListOutboxJobsInput) => Promise<OutboxJobItem[]>
  cancelOutboxJob: (input: CancelOutboxJobInput) => Promise<boolean>
  syncNow: () => Promise<SyncResult>
  forcePushAll: () => Promise<ForcePushResult>
  connectGoogle: () => Promise<GoogleConnectionStatus>
  disconnectGoogle: () => Promise<GoogleConnectionStatus>
  getGoogleConnectionStatus: () => Promise<GoogleConnectionStatus>
  listGoogleCalendars: () => Promise<GoogleCalendarItem[]>
  getSelectedCalendar: () => Promise<SelectedCalendar>
  setSelectedCalendar: (payload: SetSelectedCalendarInput) => Promise<SelectedCalendar>
  getShiftSettings: () => Promise<ShiftSettings>
  setShiftSettings: (payload: SetShiftSettingsInput) => Promise<ShiftSettings>
}
