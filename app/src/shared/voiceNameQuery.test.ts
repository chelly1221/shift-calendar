import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { defaultShiftSettings, type CalendarEvent, type ShiftSettings } from './calendar'
import { answerVoiceQuery } from './voiceQuery'
import { voiceQuerySchema, type VoiceContext } from './voice'

const now = DateTime.fromISO('2026-09-10T10:00', { zone: 'Asia/Seoul' })
const settings: ShiftSettings = {
  ...defaultShiftSettings, teams: { A: ['김수헌', '이상승'], B: ['신유철'], C: ['박혜지'], D: ['이명섭'] }, dayWorkers: ['이종열'],
}
function leave(id: string, day: string, name = '김수헌', extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const date = DateTime.fromISO(day, { zone: 'Asia/Seoul' })
  return {
    localId: id, googleEventId: null, eventType: '휴가', summary: `${name} 연차`,
    description: `휴가대상: ${name}\n휴가종류: 연차`, location: '',
    startAtUtc: date.toUTC().toISO()!, endAtUtc: date.plus({ days: 1 }).toUTC().toISO()!,
    timeZone: 'Asia/Seoul', attendees: [], recurrenceRule: null, skipWeekendsAndHolidays: false,
    recurringEventId: null, originalStartTimeUtc: null, organizerEmail: null, hangoutLink: null,
    googleUpdatedAtUtc: null, localEditedAtUtc: now.toUTC().toISO()!, syncState: 'CLEAN', ...extra,
  }
}
const records = [leave('first', '2026-09-16'), leave('later', '2027-01-18'), leave('other', '2026-09-18', '이상승')]
const ask = (text: string, items = records, roster = settings, context?: VoiceContext | null) =>
  answerVoiceQuery(voiceQuerySchema.parse({ text, context }), items, roster, now)

describe('misrecognized full names in spoken questions', () => {
  it.each(['김수원 휴가 언제야?', '김수원 과장 휴가 언제야?', '김수원과장님 연차 언제야?', '김 수 원 씨 휴가 언제야?'])('corrects the registered name without losing later vacations: %s', (text) => {
    const answer = ask(text)
    expect(answer.status).toBe('ANSWER')
    expect(answer.context?.people).toEqual(['김수헌'])
    expect(answer.eventIds).toEqual(['first', 'later'])
    expect(answer.text).toBe('9월 16일 김수헌 연차\n2027년 1월 18일 김수헌 연차')
    expect(answer.speech).not.toContain('김수원')
  })
  it.each(['9월 16일 김수원 과장 휴가 누구야?', '김수원님 9월 16일 휴가 누구야?'])('keeps name boundaries alongside dates: %s', (text) => {
    expect(ask(text).text).toBe('김수헌-연차')
  })
  it('applies the same rule to another name without a hardcoded alias', () => {
    expect(ask('이상숭 대리 연차 언제야?').context?.people).toEqual(['이상승'])
  })
  it('retains exact and fuzzy names together', () => {
    const answer = ask('김수헌 과장하고 이상숭 대리 휴가 언제야?')
    expect(answer.context?.people).toEqual(['김수헌', '이상승'])
    expect(answer.eventIds).toEqual(['first', 'other', 'later'])
  })
  it('always prefers an exactly registered person over a similar name', () => {
    const answer = ask('김수원 과장 휴가 언제야?', [...records, leave('exact', '2026-09-17', '김수원')])
    expect(answer.context?.people).toEqual(['김수원'])
    expect(answer.eventIds).toEqual(['exact'])
  })
  it('does not add ambiguity from deleted records', () => {
    expect(ask('김수원 휴가 언제야?', [...records, leave('deleted', '2026-09-17', '김수한', { isDeleted: true })]).context?.people).toEqual(['김수헌'])
  })
  it.each(['박수원 과장 휴가 언제야?', '김철수 과장 휴가 언제야?', '수원 과장 휴가 언제야?', '외계인 휴가 언제야?', '김수원자료 휴가 언제야?'])('does not turn a distant or incomplete name into an arbitrary worker: %s', (text) => {
    expect(ask(text).status).toBe('CLARIFY')
  })
  it('does not correct text inside a known event title', () => {
    const answer = ask('김수원자료교육 언제야?', [leave('training', '2026-09-17', '김수헌', {
      eventType: '교육', summary: '김수원자료교육', description: '교육대상: 이상승',
    })])
    expect(answer.status).toBe('ANSWER')
    expect(answer.context?.people).toEqual([])
    expect(answer.eventIds).toEqual(['training'])
  })
  it('resolves names in work and education queries too', () => {
    expect(ask('김수원 과장 오늘 근무야?', [leave('shift', '2026-09-10', '', { eventType: '근무', summary: 'A/B', description: '' })]).text).toBe('주간 A조입니다.')
    expect(ask('김수원 과장 내일 교육 어디야?', [leave('training', '2026-09-11', '', {
      eventType: '교육', summary: '안전교육', description: '교육대상: 김수헌', location: '교육실',
    })]).text).toBe('교육실 안전교육')
  })
})

describe('ambiguous name clarification', () => {
  const items = [...records, leave('similar', '2026-09-17', '김수한')]
  it('asks instead of choosing an arbitrary similar name', () => {
    const answer = ask('김수원 과장 휴가 언제야?', items)
    expect(answer.status).toBe('CLARIFY')
    expect(answer.text).toBe('김수헌, 김수한 중 누구인가요?')
    expect(answer.eventIds).toEqual([])
  })
  it.each(['김수헌', '김수헌이요', '수헌', '김수헌 과장님'])('answers the original question after a short exact choice: %s', (text) => {
    const first = ask('김수원 과장 휴가 언제야?', items)
    expect(ask(text, items, settings, first.context).text).toBe('9월 16일 김수헌 연차\n2027년 1월 18일 김수헌 연차')
  })
  it('lets another full question replace the pending clarification', () => {
    const first = ask('김수원 과장 휴가 언제야?', items)
    expect(ask('이상승 연차 언제야?', items, settings, first.context).eventIds).toEqual(['other'])
  })
  it('does not accept an expired short name choice', () => {
    const first = ask('김수원 과장 휴가 언제야?', items)
    expect(ask('김수헌', items, settings, { ...first.context!, answeredAtUtc: now.minus({ minutes: 3 }).toUTC().toISO()! }).status).toBe('UNSUPPORTED')
  })
})

it('keeps a roster-only follow-up on registered team members', () => {
  const first = ask('A조 근무자 누구야?')
  expect(ask('그럼 B조는?', records, settings, first.context).text).toBe('B조 신유철')
})
