import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { defaultShiftSettings, type CalendarEvent, type ShiftSettings } from './calendar'
import { voiceQuerySchema } from './voice'
import { answerVoiceQuery } from './voiceQuery'

const now = DateTime.fromISO('2026-09-08T10:00:00', { zone: 'Asia/Seoul' })
const settings: ShiftSettings = {
  ...defaultShiftSettings,
  teams: {
    A: ['김수헌', '이상승'],
    B: ['박지훈', '최서연'],
    C: ['강준호', '정유진'],
    D: ['한도윤', '윤서아'],
  },
  dayWorkers: ['오지수'],
}

function event(id: string, eventType: string, summary: string, day: string, description = ''): CalendarEvent {
  const start = DateTime.fromISO(day, { zone: 'Asia/Seoul' })
  return {
    localId: id, googleEventId: null, eventType, summary, description, location: '',
    startAtUtc: start.toUTC().toISO()!, endAtUtc: start.plus({ days: 1 }).toUTC().toISO()!, timeZone: 'Asia/Seoul',
    attendees: [], recurrenceRule: null, skipWeekendsAndHolidays: false, recurringEventId: null,
    originalStartTimeUtc: null, organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null,
    localEditedAtUtc: now.toUTC().toISO()!, syncState: 'CLEAN',
  }
}

const events = [
  event('today', '근무', 'B/A', '2026-09-08'),
  event('tomorrow', '근무', 'A/D', '2026-09-09'),
  event('leave', '휴가', '김수헌 연차', '2026-09-08', '휴가대상: 김수헌\n휴가종류: 연차'),
]
const ask = (text: string, items = events, roster = settings) => answerVoiceQuery(voiceQuerySchema.parse({ text }), items, roster, now)

describe('team members versus date-specific working rosters', () => {
  it.each([
    ['A조 근무자 누구야?', 'A조 김수헌 이상승'],
    ['에이조 근무자 알려줘', 'A조 김수헌 이상승'],
    ['B조 근무자 누구야?', 'B조 박지훈 최서연'],
    ['비조 근무자 알려줘', 'B조 박지훈 최서연'],
    ['C조 근무자 누구야?', 'C조 강준호 정유진'],
    ['씨조 근무자 알려줘', 'C조 강준호 정유진'],
    ['시조 근무자 누구야?', 'C조 강준호 정유진'],
    ['D조 근무자 누구야?', 'D조 한도윤 윤서아'],
    ['디조 근무자 알려줘', 'D조 한도윤 윤서아'],
    ['A조 누구야?', 'A조 김수헌 이상승'],
    ['A조 조원 누구야?', 'A조 김수헌 이상승'],
    ['A조 명단 알려줘', 'A조 김수헌 이상승'],
  ])('answers the configured team without a day/night prefix: %s', (text, expected) => {
    const answer = ask(text)
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe(expected)
    expect(answer.speech).toBe(expected)
  })

  it('can answer a team when no shift events are saved', () => {
    expect(ask('A조 근무자 누구야?', []).text).toBe('A조 김수헌 이상승')
  })

  it('keeps both configured members when both are absent today', () => {
    const bothAbsent = [...events, event('second-leave', '휴가', '이상승 연차', '2026-09-08', '휴가대상: 이상승\n휴가종류: 연차')]
    expect(ask('A조 근무자 누구야?', bothAbsent).text).toBe('A조 김수헌 이상승')
    expect(ask('오늘 A조 근무자 누구야?', bothAbsent).text).toBe('야간 A조 없음')
  })

  it('reports an unconfigured team as unspecified', () => {
    const empty = { ...settings, teams: { ...settings.teams, D: [] } }
    const answer = ask('D조 근무자 누구야?', events, empty)
    expect(answer.text).toBe('D조 미지정')
    expect(answer.speech).toBe('D조 미지정')
  })

  it.each([
    ['오늘 A조 근무자 누구야?', '야간 A조 이상승'],
    ['9월 8일 A조 근무자 누구야?', '야간 A조 이상승'],
    ['내일 A조 근무자 누구야?', '주간 A조 김수헌 이상승'],
    ['A조 야간 근무자 누구야?', '야간 A조 이상승'],
    ['A조 주간 근무자 누구야?', '해당 조건의 배정 기록 없음'],
    ['A조 일근 근무자 누구야?', '해당 조건의 배정 기록 없음'],
    ['A조 다음 근무 언제야?', '9월 8일 야간 A조 이상승'],
  ])('keeps dates, shift types and next-shift questions on the actual roster: %s', (text, expected) => {
    expect(ask(text).text).toBe(expected)
  })

  it('distinguishes the configured member count from the working count', () => {
    expect(ask('A조 근무자 몇 명이야?').text).toBe('2명')
    expect(ask('오늘 A조 근무자 몇 명이야?').text).toBe('야간 A조 1명')
  })

  it.each([
    ['이상승 A조 근무야?', '야간 A조입니다.'],
    ['김수헌 A조 근무야?', '근무 없음'],
  ])('keeps a named person on their actual working status: %s', (text, expected) => {
    expect(ask(text).text).toBe(expected)
  })

  it('continues filtering vacation questions by the requested team', () => {
    expect(ask('A조 오늘 휴가 누구야?').text).toBe('김수헌-연차')
  })

  it('clarifies multiple teams instead of selecting one', () => {
    expect(ask('A조 B조 근무자 누구야?').status).toBe('CLARIFY')
  })
})
