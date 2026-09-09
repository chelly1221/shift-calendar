import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { calendarEventSchema, type CalendarEvent } from './calendar'
import { formatVacationTime } from './voiceVacationTime'

const zone = 'Asia/Seoul'
const utc = (value: string) => DateTime.fromISO(value, { zone }).toUTC().toISO()!
function leave(extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return calendarEventSchema.parse({
    localId: 'hourly', googleEventId: null, eventType: '휴가', summary: '김민수 시간차',
    description: '휴가대상: 김민수\n휴가종류: 시간차',
    startAtUtc: utc('2026-09-16'), endAtUtc: utc('2026-09-17'), timeZone: zone,
    attendees: [], recurrenceRule: null, recurringEventId: null, originalStartTimeUtc: null,
    organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null,
    localEditedAtUtc: utc('2026-09-10'), syncState: 'CLEAN', ...extra,
  })
}

describe('registered hourly leave times', () => {
  it('reads actual UI time metadata even when calendar bounds are midnight', () => {
    const event = leave({ summary: '김민수 시간차(13:00~15:00)', description: '휴가대상: 김민수\n휴가종류: 시간차\n시각: 13:00~15:00' })
    expect(formatVacationTime(event, '시간차 언제야?', zone)).toBe('오후 1시~오후 3시')
  })
  it('prefers the time memo over duplicated type, title and timestamp hours', () => {
    const event = leave({
      description: '휴가대상: 김민수\r\n휴가종류: 시간차(09:00~11:00)\r\n메모\r\n시각: 13:00~15:30\r\n',
      summary: '김민수 시간차(10:00~11:00)', startAtUtc: utc('2026-09-16T16:00'), endAtUtc: utc('2026-09-16T17:00'),
    })
    expect(formatVacationTime(event, '언제야?', zone)).toBe('오후 1시~오후 3시 30분')
  })
  it('reads imported type hours before title hours', () => {
    const event = leave({ description: '휴가대상: 김민수\n휴가종류: 시간차(09:00~13:00)', summary: '김민수 시간차(14:00~15:00)' })
    expect(formatVacationTime(event, '언제야?', zone)).toBe('오전 9시~오후 1시')
  })
  it('reads title-only hours from older records', () => {
    expect(formatVacationTime(leave({ summary: '김민수 시간차 (09:30~11:00)' }), '언제야?', zone)).toBe('오전 9시 30분~오전 11시')
  })
  it.each([
    ['~11:30', '~오전 11시 30분'], ['16:30~', '오후 4시 30분~'],
    ['9~11', '9~11'], ['3시부터', '3시부터'],
  ])('preserves the registered meaning of %s without inventing hours', (stored, expected) => {
    expect(formatVacationTime(leave({ description: `휴가대상: 김민수\n휴가종류: 시간차(${stored})` }), '언제야?', zone)).toBe(expected)
  })
  it.each([
    ['몇 시 시작해?', '오후 1시'], ['몇 시 종료해?', '오후 3시'],
    ['언제 끝나?', '오후 3시'], ['시작과 종료 언제야?', '오후 1시~오후 3시'],
  ])('returns the requested registered field for %s', (question, expected) => {
    expect(formatVacationTime(leave({ description: '휴가종류: 시간차\n시각: 13:00~15:00' }), question, zone)).toBe(expected)
  })
  it('preserves the known open range when the requested endpoint is missing', () => {
    const event = leave({ summary: '김민수 시간차(~11:30)' })
    expect(formatVacationTime(event, '몇시 시작해?', zone)).toBe('~오전 11시 30분')
    expect(formatVacationTime(event, '몇시 끝나?', zone)).toBe('오전 11시 30분')
  })
  it('does not mistake a blank time memo for a clock time', () => {
    expect(formatVacationTime(leave({ description: '휴가종류: 시간차\n시각: \n메모: 병원' }), '언제야?', zone)).toBeNull()
  })
  it('returns no time for an all-day record without registered hours, including other display zones', () => {
    expect(formatVacationTime(leave(), '언제야?', zone)).toBeNull()
    expect(formatVacationTime(leave(), '언제야?', 'UTC')).toBeNull()
  })
  it('falls back to registered event timestamps', () => {
    const event = leave({ startAtUtc: utc('2026-09-16T13:00'), endAtUtc: utc('2026-09-16T15:30') })
    expect(formatVacationTime(event, '언제야?', zone)).toBe('오후 1시~오후 3시 30분')
    expect(formatVacationTime(event, '몇시 시작해?', zone)).toBe('오후 1시')
    expect(formatVacationTime(event, '몇시 종료해?', zone)).toBe('오후 3시 30분')
  })
  it('keeps the end date when timestamp hours cross midnight', () => {
    const event = leave({ startAtUtc: utc('2026-09-16T23:00'), endAtUtc: utc('2026-09-17T01:00') })
    expect(formatVacationTime(event, '언제야?', zone)).toBe('오후 11시~9월 17일 오전 1시')
  })
  it('formats actual timestamp hours in the requested display zone', () => {
    const event = leave({ startAtUtc: utc('2026-09-16T13:00'), endAtUtc: utc('2026-09-16T15:00') })
    expect(formatVacationTime(event, '언제야?', 'UTC')).toBe('오전 4시~오전 6시')
  })
})
