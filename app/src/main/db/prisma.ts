import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient__: PrismaClient | undefined
}

function resolveSqlitePathFromDatabaseUrl(databaseUrl: string): string {
  if (databaseUrl === ':memory:') {
    return ':memory:'
  }
  if (databaseUrl.startsWith('file:')) {
    return databaseUrl.slice('file:'.length)
  }
  return databaseUrl
}

/**
 * Ensure database schema exists for fresh installs.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run on existing databases.
 */
function ensureSchema(dbPath: string): void {
  if (dbPath === ':memory:') return
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
  } catch {
    // directory already exists
  }
  const db = new Database(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE IF NOT EXISTS "Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "syncToken" TEXT,
    "syncWindowStartUtc" DATETIME NOT NULL DEFAULT '1900-01-01T00:00:00.000Z',
    "syncWindowEndUtc" DATETIME NOT NULL DEFAULT '9999-12-31T23:59:59.999Z',
    "accountEmail" TEXT,
    "selectedCalendarId" TEXT,
    "selectedCalendarSummary" TEXT,
    "shiftType" TEXT NOT NULL DEFAULT 'DAY_NIGHT_OFF_OFF',
    "shiftTeamMode" TEXT NOT NULL DEFAULT 'PAIR',
    "shiftTeamsJson" JSONB,
    "googleClientId" TEXT,
    "googleClientSecret" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Event" (
    "localId" TEXT NOT NULL PRIMARY KEY,
    "googleEventId" TEXT,
    "eventType" TEXT NOT NULL DEFAULT '일반',
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startAtUtc" DATETIME NOT NULL,
    "endAtUtc" DATETIME NOT NULL,
    "timeZone" TEXT NOT NULL,
    "recurrenceJson" JSONB,
    "recurringEventId" TEXT,
    "originalStartTimeUtc" DATETIME,
    "attendeesJson" JSONB,
    "organizerEmail" TEXT,
    "hangoutLink" TEXT,
    "googleUpdatedAtUtc" DATETIME,
    "localEditedAtUtc" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncState" TEXT NOT NULL DEFAULT 'CLEAN',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "OutboxJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventLocalId" TEXT,
    "operation" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "dependsOnOutboxId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAtUtc" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxJob_eventLocalId_fkey" FOREIGN KEY ("eventLocalId") REFERENCES "Event" ("localId") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutboxJob_dependsOnOutboxId_fkey" FOREIGN KEY ("dependsOnOutboxId") REFERENCES "OutboxJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Event_googleEventId_key" ON "Event"("googleEventId");
CREATE INDEX IF NOT EXISTS "Event_startAtUtc_idx" ON "Event"("startAtUtc");
CREATE INDEX IF NOT EXISTS "Event_syncState_idx" ON "Event"("syncState");
CREATE INDEX IF NOT EXISTS "Event_isDeleted_startAtUtc_idx" ON "Event"("isDeleted", "startAtUtc");
CREATE INDEX IF NOT EXISTS "OutboxJob_status_nextRetryAtUtc_idx" ON "OutboxJob"("status", "nextRetryAtUtc");
CREATE INDEX IF NOT EXISTS "OutboxJob_eventLocalId_status_idx" ON "OutboxJob"("eventLocalId", "status");
    `)
  } finally {
    db.close()
  }
}

const databaseUrl = process.env.DATABASE_URL ?? 'file:./dev.db'
const resolvedPath = resolveSqlitePathFromDatabaseUrl(databaseUrl)

// Create tables if they don't exist (safe for existing databases).
// Wrapped in try-catch so that test environments with incompatible
// native binaries (e.g. WSL running Windows-compiled better-sqlite3)
// can still import this module.
try {
  ensureSchema(resolvedPath)
} catch (err) {
  console.warn('[prisma] Schema migration skipped:', err)
}

const adapter = new PrismaBetterSqlite3({
  url: resolvedPath,
})

export const prisma = globalThis.__prismaClient__ ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient__ = prisma
}
