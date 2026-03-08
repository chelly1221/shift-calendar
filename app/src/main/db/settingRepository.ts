import { DateTime } from 'luxon'
import { defaultShiftSettings, type ShiftSettings, type ShiftTeamAssignments, type ShiftTeamMode, type ShiftType } from '../../shared/calendar'
import { prisma } from './prisma'

function defaultSyncWindow() {
  const now = DateTime.utc()
  return {
    syncWindowStartUtc: now.minus({ years: 5 }).toJSDate(),
    syncWindowEndUtc: now.plus({ months: 12 }).toJSDate(),
  }
}

function unboundedSyncWindow() {
  return {
    syncWindowStartUtc: DateTime.utc(1900, 1, 1).startOf('day').toJSDate(),
    syncWindowEndUtc: DateTime.utc(9999, 12, 31).endOf('day').toJSDate(),
  }
}

const MAX_DAY_WORKER_COUNT = 5

function normalizeShiftType(value: unknown): ShiftType {
  return value === 'DAY_NIGHT_OFF_OFF' ? value : defaultShiftSettings.shiftType
}

function normalizeShiftTeamMode(value: unknown): ShiftTeamMode {
  return value === 'SINGLE' || value === 'PAIR'
    ? value
    : defaultShiftSettings.shiftTeamMode
}

function normalizeDayWorkerCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return defaultShiftSettings.dayWorkerCount
  }
  if (value < 1) {
    return 1
  }
  if (value > MAX_DAY_WORKER_COUNT) {
    return MAX_DAY_WORKER_COUNT
  }
  return value
}

function normalizeMembers(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const members: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const trimmed = item.trim()
    if (!trimmed || members.includes(trimmed)) {
      continue
    }
    members.push(trimmed)
    if (members.length >= limit) {
      break
    }
  }

  return members
}

function normalizeShiftTeams(value: unknown): ShiftTeamAssignments {
  const record = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}

  return {
    A: normalizeMembers(record['A'], 2),
    B: normalizeMembers(record['B'], 2),
    C: normalizeMembers(record['C'], 2),
    D: normalizeMembers(record['D'], 2),
  }
}

function applyShiftTeamMode(members: string[], mode: ShiftTeamMode): string[] {
  return mode === 'SINGLE' ? members.slice(0, 1) : members.slice(0, 2)
}

function normalizeAbbreviations(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const record = value as Record<string, unknown>
  const result: Record<string, string> = {}
  const usedChars = new Set<string>()
  for (const [key, val] of Object.entries(record)) {
    const trimmedKey = key.trim()
    if (typeof val === 'string' && val.length === 1 && trimmedKey && !usedChars.has(val)) {
      result[trimmedKey] = val
      usedChars.add(val)
    }
  }
  return result
}

function normalizeShiftPayload(
  value: unknown,
  mode: ShiftTeamMode,
): {
  dayWorkerCount: number
  teams: ShiftTeamAssignments
  dayWorkers: string[]
  abbreviations: Record<string, string>
} {
  const record = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
  const teamSource = typeof record['teams'] === 'object' && record['teams'] !== null
    ? record['teams']
    : record
  const teams = normalizeShiftTeams(teamSource)
  const dayWorkerCount = normalizeDayWorkerCount(record['dayWorkerCount'])
  return {
    dayWorkerCount,
    teams: {
      A: applyShiftTeamMode(teams.A, mode),
      B: applyShiftTeamMode(teams.B, mode),
      C: applyShiftTeamMode(teams.C, mode),
      D: applyShiftTeamMode(teams.D, mode),
    },
    dayWorkers: normalizeMembers(record['dayWorkers'], dayWorkerCount),
    abbreviations: normalizeAbbreviations(record['abbreviations']),
  }
}

export async function ensureSetting(): Promise<{
  id: number
  syncToken: string | null
  syncWindowStartUtc: Date
  syncWindowEndUtc: Date
  accountEmail: string | null
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
  shiftType: string
  shiftTeamMode: string
  shiftTeamsJson: unknown
}> {
  const defaults = defaultSyncWindow()
  return prisma.setting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      ...defaults,
      shiftType: defaultShiftSettings.shiftType,
      shiftTeamMode: defaultShiftSettings.shiftTeamMode,
      shiftTeamsJson: {
        teams: defaultShiftSettings.teams,
        dayWorkers: defaultShiftSettings.dayWorkers,
        dayWorkerCount: defaultShiftSettings.dayWorkerCount,
      },
    },
    update: {},
    select: {
      id: true,
      syncToken: true,
      syncWindowStartUtc: true,
      syncWindowEndUtc: true,
      accountEmail: true,
      selectedCalendarId: true,
      selectedCalendarSummary: true,
      shiftType: true,
      shiftTeamMode: true,
      shiftTeamsJson: true,
    },
  })
}

export async function setSyncToken(syncToken: string | null): Promise<void> {
  await ensureSetting()
  await prisma.setting.update({
    where: { id: 1 },
    data: { syncToken },
  })
}

export async function markSyncWindowUnbounded(): Promise<void> {
  await ensureSetting()
  const unbounded = unboundedSyncWindow()
  await prisma.setting.update({
    where: { id: 1 },
    data: {
      syncWindowStartUtc: unbounded.syncWindowStartUtc,
      syncWindowEndUtc: unbounded.syncWindowEndUtc,
    },
  })
}

export async function setAccountEmail(accountEmail: string | null): Promise<void> {
  await ensureSetting()
  await prisma.setting.update({
    where: { id: 1 },
    data: { accountEmail },
  })
}

export async function getAccountEmail(): Promise<string | null> {
  const setting = await ensureSetting()
  return setting.accountEmail
}

export async function getSelectedCalendar(): Promise<{
  selectedCalendarId: string | null
  selectedCalendarSummary: string | null
}> {
  const setting = await ensureSetting()
  return {
    selectedCalendarId: setting.selectedCalendarId,
    selectedCalendarSummary: setting.selectedCalendarSummary,
  }
}

export async function getShiftSettings(): Promise<ShiftSettings> {
  const setting = await ensureSetting()
  const shiftTeamMode = normalizeShiftTeamMode(setting.shiftTeamMode)
  const shiftPayload = normalizeShiftPayload(setting.shiftTeamsJson, shiftTeamMode)
  return {
    shiftType: normalizeShiftType(setting.shiftType),
    shiftTeamMode,
    dayWorkerCount: shiftPayload.dayWorkerCount,
    teams: shiftPayload.teams,
    dayWorkers: shiftPayload.dayWorkers,
    abbreviations: shiftPayload.abbreviations,
  }
}

export async function setShiftSettings(input: ShiftSettings): Promise<ShiftSettings> {
  const shiftTeamMode = normalizeShiftTeamMode(input.shiftTeamMode)
  const shiftPayload = normalizeShiftPayload(
    {
      teams: input.teams,
      dayWorkers: input.dayWorkers,
      dayWorkerCount: input.dayWorkerCount,
      abbreviations: input.abbreviations,
    },
    shiftTeamMode,
  )
  const nextSettings: ShiftSettings = {
    shiftType: normalizeShiftType(input.shiftType),
    shiftTeamMode,
    dayWorkerCount: shiftPayload.dayWorkerCount,
    teams: shiftPayload.teams,
    dayWorkers: shiftPayload.dayWorkers,
    abbreviations: shiftPayload.abbreviations,
  }

  await prisma.setting.update({
    where: { id: 1 },
    data: {
      shiftType: nextSettings.shiftType,
      shiftTeamMode: nextSettings.shiftTeamMode,
      shiftTeamsJson: {
        teams: nextSettings.teams,
        dayWorkers: nextSettings.dayWorkers,
        dayWorkerCount: nextSettings.dayWorkerCount,
        abbreviations: nextSettings.abbreviations,
      },
    },
  })

  return nextSettings
}

export async function getGoogleOAuthConfig(): Promise<{
  clientId: string | null
  clientSecret: string | null
}> {
  const setting = await ensureSetting()
  const row = await prisma.setting.findUnique({
    where: { id: setting.id },
    select: { googleClientId: true, googleClientSecret: true },
  })
  return {
    clientId: row?.googleClientId ?? null,
    clientSecret: row?.googleClientSecret ?? null,
  }
}

export async function setGoogleOAuthConfig(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await ensureSetting()
  await prisma.setting.update({
    where: { id: 1 },
    data: {
      googleClientId: clientId,
      googleClientSecret: clientSecret,
    },
  })
}

export async function clearGoogleOAuthConfig(): Promise<void> {
  await ensureSetting()
  await prisma.setting.update({
    where: { id: 1 },
    data: {
      googleClientId: null,
      googleClientSecret: null,
    },
  })
}

export async function setSelectedCalendar(input: {
  calendarId: string
  calendarSummary?: string | null
}): Promise<void> {
  const setting = await ensureSetting()
  const nextSummary = input.calendarSummary ?? null
  if (setting.selectedCalendarId === input.calendarId) {
    await prisma.setting.update({
      where: { id: 1 },
      data: {
        selectedCalendarSummary: nextSummary,
      },
    })
    return
  }

  const runningCount = await prisma.outboxJob.count({ where: { status: 'RUNNING' } })
  if (runningCount > 0) {
    console.warn(`[Settings] ${runningCount} RUNNING outbox jobs exist during calendar switch - waiting briefly`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  const pendingCount = await prisma.outboxJob.count({
    where: {
      status: { in: ['QUEUED', 'FAILED', 'RUNNING'] },
    },
  })

  if (pendingCount > 0) {
    console.warn(`[Settings] Switching calendar with ${pendingCount} pending outbox jobs - these will be discarded`)
  }

  await prisma.$transaction([
    prisma.setting.update({
      where: { id: 1 },
      data: {
        selectedCalendarId: input.calendarId,
        selectedCalendarSummary: nextSummary,
        syncToken: null,
      },
    }),
    prisma.outboxJob.deleteMany(),
    prisma.event.deleteMany(),
  ])
}
