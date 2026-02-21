import { DateTime } from 'luxon'
import type { SyncResult } from '../../shared/calendar'
import { ensureSetting, setSyncToken } from '../db/settingRepository'
import { upsertRemoteEvents } from '../db/eventRepository'
import { createGoogleCalendarService } from '../google/calendarService'
import { isGoogleConnected, isGoogleOAuthConfigured } from '../google/oauthClient'
import { getOutboxCount, processOutboxNow } from './outboxWorker'

interface SyncErrorShape {
  code?: number
  status?: number
  response?: {
    status?: number
  }
}

function isSyncTokenExpiredError(error: unknown): boolean {
  const candidate = error as SyncErrorShape
  return candidate.code === 410 || candidate.status === 410 || candidate.response?.status === 410
}

async function pullRemote(mode: 'FULL' | 'DELTA'): Promise<number> {
  const setting = await ensureSetting()
  const google = createGoogleCalendarService()
  let pulledEvents = 0
  let nextPageToken: string | undefined
  let nextSyncToken: string | null = null

  do {
    const page =
      mode === 'DELTA'
        ? await google.pullRemoteEvents({
            syncToken: setting.syncToken ?? undefined,
            pageToken: nextPageToken,
          })
        : await google.pullRemoteEvents({
            timeMin: DateTime.fromJSDate(setting.syncWindowStartUtc).toUTC().toISO() ?? undefined,
            timeMax: DateTime.fromJSDate(setting.syncWindowEndUtc).toUTC().toISO() ?? undefined,
            pageToken: nextPageToken,
          })

    await upsertRemoteEvents(page.events)
    pulledEvents += page.events.length
    nextPageToken = page.nextPageToken ?? undefined
    nextSyncToken = page.nextSyncToken ?? nextSyncToken
  } while (nextPageToken)

  if (nextSyncToken) {
    await setSyncToken(nextSyncToken)
  }

  return pulledEvents
}

export async function runSyncNow(): Promise<SyncResult> {
  await ensureSetting()

  if (!isGoogleOAuthConfigured() || !(await isGoogleConnected())) {
    return {
      mode: 'SKIPPED',
      pulledEvents: 0,
      pushedOutboxJobs: 0,
      outboxRemaining: await getOutboxCount(),
    }
  }

  const setting = await ensureSetting()
  if (!setting.selectedCalendarId) {
    return {
      mode: 'SKIPPED',
      pulledEvents: 0,
      pushedOutboxJobs: 0,
      outboxRemaining: await getOutboxCount(),
    }
  }

  const pushedOutboxJobs = await processOutboxNow()
  if (!setting.syncToken) {
    const pulledEvents = await pullRemote('FULL')
    return {
      mode: 'FULL',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  }

  try {
    const pulledEvents = await pullRemote('DELTA')
    return {
      mode: 'DELTA',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  } catch (error) {
    if (!isSyncTokenExpiredError(error)) {
      throw error
    }

    await setSyncToken(null)
    const pulledEvents = await pullRemote('FULL')
    return {
      mode: 'FULL',
      pulledEvents,
      pushedOutboxJobs,
      outboxRemaining: await getOutboxCount(),
    }
  }
}
