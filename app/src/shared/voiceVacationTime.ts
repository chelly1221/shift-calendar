import { DateTime } from 'luxon'
import type { CalendarEvent } from './calendar'
import { parseVacationInfo } from './parseVacationInfo'
import { formatVoiceSpeech, voiceTimeLabel } from './voiceSpeech'

function requestedTime(text: string, start: string | undefined, end: string | undefined, whole: string): string {
  const wantsStart = /시작/.test(text)
  const wantsEnd = /종료|끝나/.test(text)
  if (wantsStart && !wantsEnd && start) return start
  if (wantsEnd && !wantsStart && end) return end
  return whole
}

/** Calendar date bounds are separate from the hours stored in hourly-leave metadata. */
export function formatVacationTime(event: CalendarEvent, text: string, timeZone: string): string | null {
  const vacation = parseVacationInfo(event.description)
  const memo = vacation.cleanDescription.match(/^[\t ]*시각[\t ]*:[\t ]*([^\r\n]+)\r?$/m)?.[1]?.trim()
  const typeTime = vacation.vacationType?.match(/시간차\s*[(（]([^\r\n)）]+)[)）]/)?.[1]?.trim()
  const titleTime = event.summary.match(/시간차\s*[(（]([^\r\n)）]+)[)）]/)?.[1]?.trim()
  const storedTime = memo || typeTime || titleTime
  if (storedTime) {
    const parts = storedTime.split(/[~～]/).map((part) => part.trim())
    const time = parts.length === 2 ? requestedTime(text, parts[0], parts[1], storedTime) : storedTime
    // Keep incomplete or informal hours as written; do not guess missing hours or AM/PM.
    return formatVoiceSpeech(time)
  }

  const localStart = DateTime.fromISO(event.startAtUtc).setZone(event.timeZone)
  const localEnd = DateTime.fromISO(event.endAtUtc).setZone(event.timeZone)
  if (!localStart.isValid || !localEnd.isValid || localEnd <= localStart) return null
  const isMidnight = (date: DateTime) => date.toMillis() === date.startOf('day').toMillis()
  if (isMidnight(localStart) && isMidnight(localEnd)) return null

  const start = localStart.setZone(timeZone)
  const end = localEnd.setZone(timeZone)
  if (!start.isValid || !end.isValid) return null
  const startLabel = voiceTimeLabel(start.hour, start.minute)
  const endLabel = `${start.hasSame(end, 'day') ? '' : `${end.month}월 ${end.day}일 `}${voiceTimeLabel(end.hour, end.minute)}`
  return requestedTime(text, startLabel, endLabel, `${startLabel}~${endLabel}`)
}
