import { DateTime } from 'luxon'
import type { ShiftSettings, ShiftTeamAssignments, ShiftTeamMode, ShiftType } from '../../shared/calendar'
import { prisma } from './prisma'

function defaultSyncWindow() {
  const now = DateTime.utc()
  return {
    syncWindowStartUtc: now.minus({ years: 5 }).toJSDate(),
    syncWindowEndUtc: now.plus({ months: 12 }).toJSDate(),
  }
}

const DEFAULT_SHIFT_SETTINGS: ShiftSettings = {
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

const MAX_DAY_WORKER_COUNT = 5

function normalizeShiftType(value: unknown): ShiftType {
  return value === 'DAY_NIGHT_OFF_OFF' ? value : DEFAULT_SHIFT_SETTINGS.shiftType
}

function normalizeShiftTeamMode(value: unknown): ShiftTeamMode {
  return value === 'SINGLE' || value === 'PAIR'
    ? value
    : DEFAULT_SHIFT_SETTINGS.shiftTeamMode
}

function normalizeDayWorkerCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return DEFAULT_SHIFT_SETTINGS.dayWorkerCount
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

function normalizeShiftPayload(
  value: unknown,
  mode: ShiftTeamMode,
): {
  dayWorkerCount: number
  teams: ShiftTeamAssignments
  dayWorkers: string[]
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
      shiftType: DEFAULT_SHIFT_SETTINGS.shiftType,
      shiftTeamMode: DEFAULT_SHIFT_SETTINGS.shiftTeamMode,
      shiftTeamsJson: {
        teams: DEFAULT_SHIFT_SETTINGS.teams,
        dayWorkers: DEFAULT_SHIFT_SETTINGS.dayWorkers,
        dayWorkerCount: DEFAULT_SHIFT_SETTINGS.dayWorkerCount,
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
  await prisma.setting.update({
    where: { id: 1 },
    data: { syncToken },
  })
}

export async function setAccountEmail(accountEmail: string | null): Promise<void> {
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
  }
}

export async function setShiftSettings(input: ShiftSettings): Promise<ShiftSettings> {
  const shiftTeamMode = normalizeShiftTeamMode(input.shiftTeamMode)
  const shiftPayload = normalizeShiftPayload(
    {
      teams: input.teams,
      dayWorkers: input.dayWorkers,
      dayWorkerCount: input.dayWorkerCount,
    },
    shiftTeamMode,
  )
  const nextSettings: ShiftSettings = {
    shiftType: normalizeShiftType(input.shiftType),
    shiftTeamMode,
    dayWorkerCount: shiftPayload.dayWorkerCount,
    teams: shiftPayload.teams,
    dayWorkers: shiftPayload.dayWorkers,
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
      },
    },
  })

  return nextSettings
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
