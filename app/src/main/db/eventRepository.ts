import { OutboxOperationType, OutboxStatus, Prisma, SyncState } from '@prisma/client'
import type { CalendarEvent, ListEventsInput, UpsertCalendarEventInput } from '../../shared/calendar'
import { splitRRuleForFuture, withoutRRuleEnd } from '../../shared/rrule'
import { prisma } from './prisma'

export interface RemoteEventSnapshot {
  googleEventId: string
  eventType: string
  summary: string
  description: string
  location: string
  startAtUtc: string
  endAtUtc: string
  timeZone: string
  recurrenceRule: string | null
  skipWeekendsAndHolidays: boolean
  recurringEventId: string | null
  originalStartTimeUtc: string | null
  attendees: string[]
  organizerEmail: string | null
  hangoutLink: string | null
  googleUpdatedAtUtc: string
  isDeleted: boolean
}

function normalizeDate(dateIso: string): Date {
  const parsed = new Date(dateIso)
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`[EventRepository] Invalid date string normalized to current time: "${dateIso}"`)
    return new Date()
  }
  return parsed
}

function ensureEndAfterStart(startAtUtc: string, endAtUtc: string): string {
  const startMs = Date.parse(startAtUtc)
  const endMs = Date.parse(endAtUtc)
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs > startMs) {
    return endAtUtc
  }
  return new Date(startMs + 60 * 60 * 1000).toISOString()
}

function normalizeEventType(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed.slice(0, 40) : '일반'
}

function toAttendeesJson(attendees: string[]): Prisma.InputJsonValue {
  return attendees.map((email) => ({ email })) as Prisma.InputJsonValue
}

function parseAttendeesJson(attendeesJson: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(attendeesJson)) {
    return []
  }

  return attendeesJson
    .map((item) => {
      if (typeof item === 'string') {
        return item
      }
      if (item && typeof item === 'object' && 'email' in item && typeof item.email === 'string') {
        return item.email
      }
      return null
    })
    .filter((email): email is string => Boolean(email))
}

function toRecurrenceJson(
  recurrenceRule: string | null | undefined,
  skipWeekendsAndHolidays?: boolean,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (!recurrenceRule) {
    return Prisma.JsonNull
  }
  const json: Record<string, unknown> = { rrule: recurrenceRule }
  if (skipWeekendsAndHolidays) {
    json.skipWeekendsAndHolidays = true
  }
  return json as Prisma.InputJsonValue
}

function parseRecurrenceRule(recurrenceJson: Prisma.JsonValue | null): string | null {
  if (!recurrenceJson || typeof recurrenceJson !== 'object' || Array.isArray(recurrenceJson)) {
    return null
  }
  if ('rrule' in recurrenceJson && typeof recurrenceJson.rrule === 'string') {
    return recurrenceJson.rrule
  }
  return null
}

function parseSkipWeekendsAndHolidays(recurrenceJson: Prisma.JsonValue | null): boolean {
  if (!recurrenceJson || typeof recurrenceJson !== 'object' || Array.isArray(recurrenceJson)) {
    return false
  }
  return 'skipWeekendsAndHolidays' in recurrenceJson && recurrenceJson.skipWeekendsAndHolidays === true
}

function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return normalizeDate(value)
}

function toCalendarEvent(event: {
  localId: string
  googleEventId: string | null
  eventType: string
  summary: string
  description: string | null
  location: string | null
  startAtUtc: Date
  endAtUtc: Date
  timeZone: string
  recurrenceJson: Prisma.JsonValue | null
  recurringEventId: string | null
  originalStartTimeUtc: Date | null
  attendeesJson: Prisma.JsonValue | null
  organizerEmail: string | null
  hangoutLink: string | null
  googleUpdatedAtUtc: Date | null
  localEditedAtUtc: Date
  syncState: SyncState
}): CalendarEvent {
  return {
    localId: event.localId,
    googleEventId: event.googleEventId,
    eventType: normalizeEventType(event.eventType),
    summary: event.summary,
    description: event.description ?? '',
    location: event.location ?? '',
    startAtUtc: event.startAtUtc.toISOString(),
    endAtUtc: event.endAtUtc.toISOString(),
    timeZone: event.timeZone,
    recurrenceRule: parseRecurrenceRule(event.recurrenceJson),
    skipWeekendsAndHolidays: parseSkipWeekendsAndHolidays(event.recurrenceJson),
    recurringEventId: event.recurringEventId,
    originalStartTimeUtc: toIsoOrNull(event.originalStartTimeUtc),
    attendees: parseAttendeesJson(event.attendeesJson),
    organizerEmail: event.organizerEmail,
    hangoutLink: event.hangoutLink,
    googleUpdatedAtUtc: toIsoOrNull(event.googleUpdatedAtUtc),
    localEditedAtUtc: event.localEditedAtUtc.toISOString(),
    syncState: event.syncState,
  }
}

function buildRangeFilter(input?: ListEventsInput): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = { isDeleted: false }
  if (!input?.rangeStartUtc && !input?.rangeEndUtc) {
    return where
  }

  const andFilters: Prisma.EventWhereInput[] = []
  if (input.rangeStartUtc) {
    andFilters.push({ endAtUtc: { gte: normalizeDate(input.rangeStartUtc) } })
  }
  if (input.rangeEndUtc) {
    andFilters.push({ startAtUtc: { lte: normalizeDate(input.rangeEndUtc) } })
  }
  if (andFilters.length > 0) {
    where.AND = andFilters
  }
  return where
}

const LIST_EVENTS_MAX = 10_000

export async function listCalendarEvents(input?: ListEventsInput): Promise<CalendarEvent[]> {
  const events = await prisma.event.findMany({
    where: buildRangeFilter(input),
    orderBy: { startAtUtc: 'asc' },
    take: LIST_EVENTS_MAX,
  })
  return events.map(toCalendarEvent)
}

export async function getCalendarEventByLocalId(localId: string): Promise<CalendarEvent | null> {
  const event = await prisma.event.findUnique({
    where: { localId },
  })
  if (!event) {
    return null
  }
  return toCalendarEvent(event)
}

export async function upsertCalendarEvent(input: UpsertCalendarEventInput): Promise<CalendarEvent> {
  const endAtUtc = ensureEndAfterStart(input.startAtUtc, input.endAtUtc)
  const eventType = normalizeEventType(input.eventType)
  const now = new Date()
  const createData: Prisma.EventCreateInput = {
    googleEventId: input.googleEventId ?? null,
    eventType,
    summary: input.summary,
    description: input.description || null,
    location: input.location || null,
    startAtUtc: normalizeDate(input.startAtUtc),
    endAtUtc: normalizeDate(endAtUtc),
    timeZone: input.timeZone,
    recurrenceJson: toRecurrenceJson(input.recurrenceRule, input.skipWeekendsAndHolidays),
    recurringEventId: input.recurringEventId ?? null,
    originalStartTimeUtc: toOptionalDate(input.originalStartTimeUtc) ?? null,
    attendeesJson: toAttendeesJson(input.attendees),
    localEditedAtUtc: now,
    syncState: SyncState.PENDING,
    isDeleted: false,
  }
  const updateData: Prisma.EventUpdateInput = {
    eventType,
    summary: input.summary,
    description: input.description || null,
    location: input.location || null,
    startAtUtc: normalizeDate(input.startAtUtc),
    endAtUtc: normalizeDate(endAtUtc),
    timeZone: input.timeZone,
    recurrenceJson: toRecurrenceJson(input.recurrenceRule, input.skipWeekendsAndHolidays),
    attendeesJson: toAttendeesJson(input.attendees),
    localEditedAtUtc: now,
    syncState: SyncState.PENDING,
    isDeleted: false,
  }

  if (input.googleEventId !== undefined) {
    updateData.googleEventId = input.googleEventId
  }
  if (input.recurringEventId !== undefined) {
    updateData.recurringEventId = input.recurringEventId
  }
  if (input.originalStartTimeUtc !== undefined) {
    updateData.originalStartTimeUtc = toOptionalDate(input.originalStartTimeUtc)
  }

  const event = input.localId
    ? await prisma.event.upsert({
        where: { localId: input.localId },
        create: {
          localId: input.localId,
          ...createData,
        },
        update: updateData,
      })
    : await prisma.event.create({
        data: createData,
      })

  return toCalendarEvent(event)
}

export async function applyFutureSplitEdit(input: UpsertCalendarEventInput): Promise<{
  splitSourceEvent: CalendarEvent
  futureEvent: CalendarEvent
}> {
  if (!input.localId) {
    throw new Error('FUTURE split requires localId.')
  }

  const source = await prisma.event.findUnique({
    where: { localId: input.localId },
  })
  if (!source) {
    throw new Error(`Event not found for FUTURE split: ${input.localId}`)
  }

  const sourceRule = parseRecurrenceRule(source.recurrenceJson)
  if (!sourceRule) {
    throw new Error('FUTURE split requires recurring master event with RRULE.')
  }

  const splitRule = splitRRuleForFuture(sourceRule, input.startAtUtc)
  const rawFutureRule = input.recurrenceRule ?? sourceRule
  const futureRule = withoutRRuleEnd(rawFutureRule)
  const nextEndAtUtc = ensureEndAfterStart(input.startAtUtc, input.endAtUtc)
  const sourceSkip = parseSkipWeekendsAndHolidays(source.recurrenceJson)
  const now = new Date()

  const result = await prisma.$transaction(async (tx) => {
    const splitSourceEvent = await tx.event.update({
      where: { localId: source.localId },
      data: {
        recurrenceJson: toRecurrenceJson(splitRule, sourceSkip),
        localEditedAtUtc: now,
        syncState: SyncState.PENDING,
        isDeleted: false,
      },
    })

    const futureEvent = await tx.event.create({
      data: {
        eventType: normalizeEventType(input.eventType),
        summary: input.summary,
        description: input.description || null,
        location: input.location || null,
        startAtUtc: normalizeDate(input.startAtUtc),
        endAtUtc: normalizeDate(nextEndAtUtc),
        timeZone: input.timeZone,
        recurrenceJson: toRecurrenceJson(futureRule, input.skipWeekendsAndHolidays ?? sourceSkip),
        attendeesJson: toAttendeesJson(input.attendees),
        organizerEmail: source.organizerEmail,
        hangoutLink: source.hangoutLink,
        localEditedAtUtc: now,
        syncState: SyncState.PENDING,
        isDeleted: false,
      },
    })

    return {
      splitSourceEvent: toCalendarEvent(splitSourceEvent),
      futureEvent: toCalendarEvent(futureEvent),
    }
  })

  return result
}

export async function applyFutureSplitForDelete(
  localId: string,
  splitStartUtc: string,
): Promise<{ splitSourceEvent: CalendarEvent }> {
  const source = await prisma.event.findUnique({
    where: { localId },
  })
  if (!source) {
    throw new Error(`Event not found for FUTURE delete split: ${localId}`)
  }

  const sourceRule = parseRecurrenceRule(source.recurrenceJson)
  if (!sourceRule) {
    throw new Error('FUTURE delete split requires recurring master event with RRULE.')
  }

  // Cannot split by recurringEventId when master has no googleEventId
  // Just mark the source as deleted
  if (!source.googleEventId) {
    const updated = await prisma.event.update({
      where: { localId: source.localId },
      data: { isDeleted: true, localEditedAtUtc: new Date(), syncState: SyncState.PENDING },
    })
    return { splitSourceEvent: toCalendarEvent(updated) }
  }

  const splitRule = splitRRuleForFuture(sourceRule, splitStartUtc)
  const sourceSkipFlag = parseSkipWeekendsAndHolidays(source.recurrenceJson)
  const cutoffTime = new Date()
  const splitStart = new Date(splitStartUtc)

  const result = await prisma.$transaction(async (tx) => {
    const splitSourceEvent = await tx.event.update({
      where: { localId: source.localId },
      data: {
        recurrenceJson: toRecurrenceJson(splitRule, sourceSkipFlag),
        localEditedAtUtc: cutoffTime,
        syncState: SyncState.PENDING,
      },
    })

    await tx.event.updateMany({
      where: {
        recurringEventId: source.googleEventId,
        startAtUtc: { gte: splitStart },
        isDeleted: false,
      },
      data: {
        isDeleted: true,
        localEditedAtUtc: cutoffTime,
        syncState: SyncState.PENDING,
      },
    })

    // Create DELETE outbox jobs for each deleted instance that has a Google ID
    const deletedInstances = await tx.event.findMany({
      where: {
        recurringEventId: source.googleEventId,
        startAtUtc: { gte: splitStart },
        isDeleted: true,
        localEditedAtUtc: { gte: cutoffTime },
        googleEventId: { not: null },
      },
      select: { localId: true, googleEventId: true },
    })

    for (const instance of deletedInstances) {
      if (instance.googleEventId) {
        await tx.outboxJob.create({
          data: {
            eventLocalId: instance.localId,
            operation: OutboxOperationType.DELETE,
            payloadJson: { googleEventId: instance.googleEventId },
            status: OutboxStatus.QUEUED,
            nextRetryAtUtc: cutoffTime,
          },
        })
      }
    }

    return { splitSourceEvent: toCalendarEvent(splitSourceEvent) }
  })

  return result
}

export async function removeCalendarEvent(localId: string): Promise<boolean> {
  const updated = await prisma.event.updateMany({
    where: { localId, isDeleted: false },
    data: {
      isDeleted: true,
      localEditedAtUtc: new Date(),
      syncState: SyncState.PENDING,
    },
  })
  return updated.count > 0
}

export async function updateEventSyncState(
  localId: string,
  input: { syncState: SyncState; googleUpdatedAtUtc?: string | null; googleEventId?: string | null },
): Promise<void> {
  await prisma.event.update({
    where: { localId },
    data: {
      syncState: input.syncState,
      googleUpdatedAtUtc:
        input.googleUpdatedAtUtc === undefined
          ? undefined
          : input.googleUpdatedAtUtc
            ? normalizeDate(input.googleUpdatedAtUtc)
            : null,
      googleEventId:
        input.googleEventId === undefined
          ? undefined
          : input.googleEventId,
    },
  })
}

export async function markEventDeletedByGoogle(googleEventId: string, googleUpdatedAtUtc?: string): Promise<void> {
  await prisma.event.updateMany({
    where: { googleEventId },
    data: {
      isDeleted: true,
      syncState: SyncState.CLEAN,
      googleUpdatedAtUtc: googleUpdatedAtUtc ? normalizeDate(googleUpdatedAtUtc) : undefined,
    },
  })
}

export async function upsertRemoteEvent(snapshot: RemoteEventSnapshot): Promise<void> {
  if (snapshot.isDeleted) {
    await markEventDeletedByGoogle(snapshot.googleEventId, snapshot.googleUpdatedAtUtc)
    return
  }

  const googleUpdatedAt = normalizeDate(snapshot.googleUpdatedAtUtc)

  const existing = await prisma.event.findUnique({
    where: { googleEventId: snapshot.googleEventId },
    select: { eventType: true, syncState: true, isDeleted: true, localEditedAtUtc: true },
  })

  // Skip if local event has pending changes (e.g. pending deletion) that haven't synced yet
  if (existing?.syncState === SyncState.PENDING) {
    const remoteMs = googleUpdatedAt.getTime()
    const localMs = existing.localEditedAtUtc.getTime()
    if (localMs >= remoteMs) {
      return  // Skip remote update, local is newer or equal
    }
  }

  const snapshotType = normalizeEventType(snapshot.eventType)
  const preservedEventType = (snapshotType !== '일반')
    ? snapshotType
    : (existing?.eventType && existing.eventType !== '일반')
      ? existing.eventType
      : snapshotType

  const baseData = {
    summary: snapshot.summary,
    description: snapshot.description || null,
    location: snapshot.location || null,
    startAtUtc: normalizeDate(snapshot.startAtUtc),
    endAtUtc: normalizeDate(snapshot.endAtUtc),
    timeZone: snapshot.timeZone,
    recurrenceJson: toRecurrenceJson(snapshot.recurrenceRule, snapshot.skipWeekendsAndHolidays),
    recurringEventId: snapshot.recurringEventId,
    originalStartTimeUtc: snapshot.originalStartTimeUtc
      ? normalizeDate(snapshot.originalStartTimeUtc)
      : null,
    attendeesJson: toAttendeesJson(snapshot.attendees),
    organizerEmail: snapshot.organizerEmail,
    hangoutLink: snapshot.hangoutLink,
    googleUpdatedAtUtc: googleUpdatedAt,
    localEditedAtUtc: googleUpdatedAt,
    syncState: SyncState.CLEAN,
    isDeleted: false,
  }

  await prisma.event.upsert({
    where: { googleEventId: snapshot.googleEventId },
    create: {
      googleEventId: snapshot.googleEventId,
      eventType: snapshotType,
      ...baseData,
    },
    update: {
      eventType: preservedEventType,
      ...baseData,
    },
  })
}

const UPSERT_BATCH_SIZE = 50

export async function upsertRemoteEvents(snapshots: RemoteEventSnapshot[]): Promise<void> {
  for (let i = 0; i < snapshots.length; i += UPSERT_BATCH_SIZE) {
    const batch = snapshots.slice(i, i + UPSERT_BATCH_SIZE)
    await prisma.$transaction(async (tx) => {
      for (const snapshot of batch) {
        await upsertRemoteEventInTx(tx, snapshot)
      }
    })
  }
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function upsertRemoteEventInTx(tx: TxClient, snapshot: RemoteEventSnapshot): Promise<void> {
  if (snapshot.isDeleted) {
    await tx.event.updateMany({
      where: { googleEventId: snapshot.googleEventId },
      data: {
        isDeleted: true,
        syncState: SyncState.CLEAN,
        googleUpdatedAtUtc: snapshot.googleUpdatedAtUtc ? normalizeDate(snapshot.googleUpdatedAtUtc) : undefined,
      },
    })
    return
  }

  const googleUpdatedAt = normalizeDate(snapshot.googleUpdatedAtUtc)

  const existing = await tx.event.findUnique({
    where: { googleEventId: snapshot.googleEventId },
    select: { eventType: true, syncState: true, isDeleted: true, localEditedAtUtc: true },
  })

  if (existing?.syncState === SyncState.PENDING) {
    const remoteMs = googleUpdatedAt.getTime()
    const localMs = existing.localEditedAtUtc.getTime()
    if (localMs >= remoteMs) {
      return  // Skip remote update, local is newer or equal
    }
  }

  const snapshotType = normalizeEventType(snapshot.eventType)
  const preservedEventType = (snapshotType !== '일반')
    ? snapshotType
    : (existing?.eventType && existing.eventType !== '일반')
      ? existing.eventType
      : snapshotType

  const baseData = {
    summary: snapshot.summary,
    description: snapshot.description || null,
    location: snapshot.location || null,
    startAtUtc: normalizeDate(snapshot.startAtUtc),
    endAtUtc: normalizeDate(snapshot.endAtUtc),
    timeZone: snapshot.timeZone,
    recurrenceJson: toRecurrenceJson(snapshot.recurrenceRule, snapshot.skipWeekendsAndHolidays),
    recurringEventId: snapshot.recurringEventId,
    originalStartTimeUtc: snapshot.originalStartTimeUtc
      ? normalizeDate(snapshot.originalStartTimeUtc)
      : null,
    attendeesJson: toAttendeesJson(snapshot.attendees),
    organizerEmail: snapshot.organizerEmail,
    hangoutLink: snapshot.hangoutLink,
    googleUpdatedAtUtc: googleUpdatedAt,
    localEditedAtUtc: googleUpdatedAt,
    syncState: SyncState.CLEAN,
    isDeleted: false,
  }

  await tx.event.upsert({
    where: { googleEventId: snapshot.googleEventId },
    create: {
      googleEventId: snapshot.googleEventId,
      eventType: snapshotType,
      ...baseData,
    },
    update: {
      eventType: preservedEventType,
      ...baseData,
    },
  })
}

export async function applyEventTypeToRecurringSeries(
  seriesGoogleEventId: string,
  eventType: string,
): Promise<void> {
  const normalizedType = normalizeEventType(eventType)
  await prisma.event.updateMany({
    where: {
      isDeleted: false,
      OR: [
        { recurringEventId: seriesGoogleEventId },
        { googleEventId: seriesGoogleEventId },
      ],
    },
    data: {
      eventType: normalizedType,
    },
  })
}
