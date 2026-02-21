/*
  Warnings:

  - You are about to drop the `CalendarEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `attempt` on the `OutboxJob` table. All the data in the column will be lost.
  - You are about to drop the column `eventId` on the `OutboxJob` table. All the data in the column will be lost.
  - You are about to drop the column `nextAttemptAt` on the `OutboxJob` table. All the data in the column will be lost.
  - You are about to drop the column `payload` on the `OutboxJob` table. All the data in the column will be lost.
  - Added the required column `payloadJson` to the `OutboxJob` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "CalendarEvent_updatedAt_idx";

-- DropIndex
DROP INDEX "CalendarEvent_startUtc_idx";

-- DropIndex
DROP INDEX "CalendarEvent_googleEventId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "CalendarEvent";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "syncToken" TEXT,
    "syncWindowStartUtc" DATETIME NOT NULL,
    "syncWindowEndUtc" DATETIME NOT NULL,
    "accountEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Event" (
    "localId" TEXT NOT NULL PRIMARY KEY,
    "googleEventId" TEXT,
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
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OutboxJob" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutboxJob_eventLocalId_fkey" FOREIGN KEY ("eventLocalId") REFERENCES "Event" ("localId") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutboxJob_dependsOnOutboxId_fkey" FOREIGN KEY ("dependsOnOutboxId") REFERENCES "OutboxJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OutboxJob" ("createdAt", "id", "lastError", "operation", "status", "updatedAt") SELECT "createdAt", "id", "lastError", "operation", "status", "updatedAt" FROM "OutboxJob";
DROP TABLE "OutboxJob";
ALTER TABLE "new_OutboxJob" RENAME TO "OutboxJob";
CREATE INDEX "OutboxJob_status_nextRetryAtUtc_idx" ON "OutboxJob"("status", "nextRetryAtUtc");
CREATE INDEX "OutboxJob_eventLocalId_status_idx" ON "OutboxJob"("eventLocalId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Event_googleEventId_key" ON "Event"("googleEventId");

-- CreateIndex
CREATE INDEX "Event_startAtUtc_idx" ON "Event"("startAtUtc");

-- CreateIndex
CREATE INDEX "Event_syncState_idx" ON "Event"("syncState");

-- CreateIndex
CREATE INDEX "Event_isDeleted_startAtUtc_idx" ON "Event"("isDeleted", "startAtUtc");
