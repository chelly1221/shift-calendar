-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "googleEventId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startUtc" DATETIME NOT NULL,
    "endUtc" DATETIME NOT NULL,
    "timeZone" TEXT NOT NULL,
    "attendees" JSONB NOT NULL,
    "recurrenceRule" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "remoteUpdatedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OutboxJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutboxJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_googleEventId_key" ON "CalendarEvent"("googleEventId");

-- CreateIndex
CREATE INDEX "CalendarEvent_startUtc_idx" ON "CalendarEvent"("startUtc");

-- CreateIndex
CREATE INDEX "CalendarEvent_updatedAt_idx" ON "CalendarEvent"("updatedAt");

-- CreateIndex
CREATE INDEX "OutboxJob_status_nextAttemptAt_idx" ON "OutboxJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxJob_eventId_status_idx" ON "OutboxJob"("eventId", "status");
