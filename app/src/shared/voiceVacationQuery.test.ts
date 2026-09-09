import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { defaultShiftSettings, type CalendarEvent } from './calendar'
import { answerVoiceQuery } from './voiceQuery'
import { voiceQuerySchema } from './voice'

const now = DateTime.fromISO('2026-09-10T10:00', { zone: 'Asia/Seoul' })
const settings = { ...defaultShiftSettings, dayWorkers: ['이종열', '이상승'] }
function leave(id: string, day: string, badge = '연차', extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const date = DateTime.fromISO(day, { zone: 'Asia/Seoul' })
  return {
    localId: id, googleEventId: null, eventType: '휴가', summary: `이상승 ${badge}`,
    description: `휴가대상: 이상승\n휴가종류: ${badge}`, location: '',
    startAtUtc: date.toUTC().toISO()!, endAtUtc: date.plus({ days: 1 }).toUTC().toISO()!,
    timeZone: 'Asia/Seoul', attendees: [], recurrenceRule: null, skipWeekendsAndHolidays: false,
    recurringEventId: null, originalStartTimeUtc: null, organizerEmail: null, hangoutLink: null,
    googleUpdatedAtUtc: null, localEditedAtUtc: now.toUTC().toISO()!, syncState: 'CLEAN', ...extra,
  }
}
const query = (text: string, records: CalendarEvent[]) => answerVoiceQuery(voiceQuerySchema.parse({ text }), records, settings, now)

describe('all planned vacation answers', () => {
  const records = [
    leave('later-year', '2027-03-08'), leave('past', '2026-09-09'), leave('near', '2026-09-16'),
    leave('today', '2026-09-10'), leave('beyond-90-days', '2026-12-24', '대휴'),
    leave('deleted', '2028-01-02', '연차', { isDeleted: true }),
    leave('other-person', '2026-10-03', '연차', { summary: '이종열 연차', description: '휴가대상: 이종열\n휴가종류: 연차' }),
  ]
  it.each(['상승씨 휴가 언제야?', '이상승 대리 다음 휴가 언제야?', '상승씨 앞으로 예정된 휴가 다 알려줘', '상승씨 이후 휴가 모두 알려줘'])('lists every planned date chronologically: %s', (text) => {
    const answer = query(text, records)
    expect(answer.status).toBe('ANSWER')
    expect(answer.eventIds).toEqual(['today', 'near', 'beyond-90-days', 'later-year'])
    expect(answer.text).toBe('9월 10일 이상승 연차\n9월 16일 이상승 연차\n12월 24일 이상승 대휴\n2027년 3월 8일 이상승 연차')
    expect(answer.speech).toBe(answer.text)
  })
  it('preserves the requested vacation kind across the whole future range', () => {
    expect(query('상승씨 언제 연차야?', records).eventIds).toEqual(['today', 'near', 'later-year'])
  })
  it.each(['이상승 연차 언제야?', '상승씨 연차 언제야?'])('does not narrow a person to one exact event title: %s', (text) => {
    const answer = query(text, [
      leave('alone', '2026-09-16'),
      leave('together', '2026-09-18', '연차', { summary: '이상승, 이종열 연차', description: '휴가대상: 이상승, 이종열\n휴가종류: 연차' }),
    ])
    expect(answer.eventIds).toEqual(['alone', 'together'])
    expect(answer.text).toBe('9월 16일 이상승 연차\n9월 18일 이상승 연차')
  })
  it('uses an explicit month as the range and lists all matching dates', () => {
    const answer = query('9월 상승씨 휴가 언제야?', records)
    expect(answer.status).toBe('ANSWER')
    expect(answer.eventIds).toEqual(['past', 'today', 'near'])
  })
  it('returns all people when no person was requested', () => {
    const answer = query('휴가 언제야?', records)
    expect(answer.eventIds).toEqual(['today', 'near', 'other-person', 'beyond-90-days', 'later-year'])
  })
  it('keeps a list longer than the previous answer size limit', () => {
    const answer = query('상승씨 휴가 언제야?', Array.from({ length: 30 }, (_, index) =>
      leave(`leave-${index}`, now.plus({ days: index + 1 }).toISODate()!)))
    expect(answer.status).toBe('ANSWER')
    expect(answer.eventIds).toHaveLength(30)
    expect(answer.text.split('\n')).toHaveLength(30)
    expect(answer.speech.split('\n')).toHaveLength(30)
  })
  it('expands finite recurrence beyond 90 days while respecting cancellation and moved occurrences', () => {
    const answer = query('상승씨 휴가 언제야?', [
      leave('master', '2026-09-16', '연차', { recurrenceRule: 'FREQ=MONTHLY;COUNT=5' }),
      leave('cancelled', '2026-10-16', '연차', { recurringEventId: 'local::master', originalStartTimeUtc: leave('x', '2026-10-16').startAtUtc, isDeleted: true }),
      leave('moved', '2026-11-17', '연차', { recurringEventId: 'local::master', originalStartTimeUtc: leave('x', '2026-11-16').startAtUtc }),
    ])
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe('9월 16일 이상승 연차\n11월 17일 이상승 연차\n12월 16일 이상승 연차\n2027년 1월 16일 이상승 연차')
  })
  it('deduplicates identical displayed records without removing later dates', () => {
    const answer = query('상승씨 휴가 언제야?', [leave('first', '2026-09-16'), leave('duplicate', '2026-09-16'), leave('second', '2026-09-17')])
    expect(answer.text).toBe('9월 16일 이상승 연차\n9월 17일 이상승 연차')
  })
  it('does not restore a recurring vacation occurrence changed to another event type', () => {
    const answer = query('이상승 연차 언제야?', [
      leave('master', '2026-09-16', '연차', { recurrenceRule: 'FREQ=DAILY;COUNT=3' }),
      leave('changed', '2026-09-17', '연차', { eventType: '교육', summary: '안전교육', description: '교육대상: 이상승', recurringEventId: 'local::master', originalStartTimeUtc: leave('x', '2026-09-17').startAtUtc }),
    ])
    expect(answer.text).toBe('9월 16일 이상승 연차\n9월 18일 이상승 연차')
  })
})

describe('hourly leave stored as a calendar day', () => {
  it.each([
    { description: '휴가대상: 이상승\n휴가종류: 시간차\n시각: 13:00~15:00' },
    { description: '휴가대상: 이상승\n휴가종류: 시간차(13:00~15:00)' },
    {},
  ])('reads the saved clock once without the all-day placeholder: %j', (extra) => {
    const answer = query('상승씨 시간차 언제야?', [leave('hourly', '2026-09-16', '시간차', {
      summary: '이상승 시간차(13:00~15:00)', ...extra,
    })])
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe('9월 16일 이상승 시간차(오후 1시~오후 3시)')
    expect(answer.speech).toBe(answer.text)
    expect(answer.text.match(/이상승/g)).toHaveLength(1)
    expect(answer.text).not.toMatch(/종일|미등록/)
  })
  it('lists mixed whole-day and hourly leave with only the requested person', () => {
    const answer = query('상승씨 휴가 언제야?', [
      leave('whole-day', '2026-09-16'), leave('hourly', '2026-09-18', '시간차(16:30~)', {
        description: '휴가대상: 이상승, 이종열\n휴가종류: 시간차(16:30~)',
      }),
    ])
    expect(answer.text).toBe('9월 16일 이상승 연차\n9월 18일 이상승 시간차(오후 4시 30분~)')
    expect(answer.text).not.toContain('이종열')
  })
  it('only reports missing clock data when clock time was explicitly requested', () => {
    const record = leave('hourly', '2026-09-10', '시간차')
    expect(query('상승씨 시간차 언제야?', [record]).text).toBe('9월 10일 이상승 시간차')
    expect(query('오늘 상승씨 시간차 몇시야?', [record]).text).toBe('9월 10일 이상승 시간차(시각 미등록)')
  })
  it('answers each hourly leave instead of offering invented midnight choices', () => {
    const answer = query('오늘 시간차 몇시야?', [
      leave('first', '2026-09-10', '시간차(13:00~14:00)'),
      leave('second', '2026-09-10', '시간차(15:00~16:00)'),
    ])
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe('9월 10일 이상승 시간차(오후 1시~오후 2시)\n9월 10일 이상승 시간차(오후 3시~오후 4시)')
  })
})
