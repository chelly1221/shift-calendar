import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { defaultShiftSettings, type CalendarEvent, type ShiftSettings } from './calendar'
import { answerVoiceQuery } from './voiceQuery'
import { normalizeVoiceText, parseVoiceDates } from './voiceDates'
import { voiceQuerySchema } from './voice'

const now = DateTime.fromISO('2026-09-08T10:00:00', { zone: 'Asia/Seoul' })
const settings: ShiftSettings = { ...defaultShiftSettings, teams: { A: ['김민수', '이지원'], B: ['박지훈', '최서연'], C: ['강준호', '정유진'], D: ['한도윤', '윤서아'] }, dayWorkers: ['오지수'] }
const utc = (date: string) => DateTime.fromISO(date, { zone: 'Asia/Seoul' }).toUTC().toISO()!
function event(id: string, type: string, summary: string, day: string, description = '', extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { localId: id, googleEventId: null, eventType: type, summary, description, location: '', startAtUtc: utc(day), endAtUtc: utc(DateTime.fromISO(day).plus({ days: 1 }).toISODate()!), timeZone: 'Asia/Seoul', attendees: [], recurrenceRule: null, skipWeekendsAndHolidays: false, recurringEventId: null, originalStartTimeUtc: null, organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null, localEditedAtUtc: utc('2026-09-01'), syncState: 'CLEAN', ...extra }
}
const events = [
  event('shift', '근무', 'A/B', '2026-09-08'),
  event('tomorrow', '근무', 'D/A', '2026-09-09', '대체근무자: 강준호\n근무종류: 대리근무\n원근무자: 김민수'),
  event('partial', '휴가', '김민수 반차', '2026-09-08', '휴가대상: 김민수\n휴가종류: 오후 반차'),
  event('edu', '교육', '안전교육', '2026-09-08', '교육대상: 이지원', { location: '교육실', startAtUtc: utc('2026-09-08T13:00'), endAtUtc: utc('2026-09-08T17:00') }),
  event('next-edu', '교육', '정기교육', '2026-09-10', '교육대상: 김민수, 최서연', { location: '대회의실', startAtUtc: utc('2026-09-10T14:00'), endAtUtc: utc('2026-09-10T16:00') }),
  event('annual', '휴가', '연차휴가', '2026-09-09', '휴가대상: 윤서아\n휴가종류: 연차'),
  event('routine', '반복업무', '정기점검', '2026-09-08', '반복완료: 2026-09-08', { recurrenceRule: 'FREQ=DAILY;COUNT=3' }),
  event('pending', '반복업무', '장비점검', '2026-09-08'),
]
const ask = (text: string, extra = {}) => answerVoiceQuery(voiceQuerySchema.parse({ text, ...extra }), events, settings, now)

describe('Korean date ranges', () => {
  it.each([
    ['오늘 주간', '2026-09-08', '2026-09-09'], ['내일', '2026-09-09', '2026-09-10'], ['모레', '2026-09-10', '2026-09-11'], ['글피', '2026-09-11', '2026-09-12'], ['어제', '2026-09-07', '2026-09-08'],
    ['그제', '2026-09-06', '2026-09-07'], ['그저께', '2026-09-06', '2026-09-07'], ['이번 주', '2026-09-07', '2026-09-14'], ['다음 주 금요일', '2026-09-18', '2026-09-19'], ['지난주', '2026-08-31', '2026-09-07'],
    ['다음 주말', '2026-09-19', '2026-09-21'], ['이번 달', '2026-09-01', '2026-10-01'], ['다음 달', '2026-10-01', '2026-11-01'], ['지난달', '2026-08-01', '2026-09-01'],
    ['9월 15일', '2026-09-15', '2026-09-16'], ['2028년 2월 29일', '2028-02-29', '2028-03-01'], ['2026-12-31', '2026-12-31', '2027-01-01'], ['9월 10일부터 9월 15일까지', '2026-09-10', '2026-09-16'], ['다음달 3일', '2026-10-03', '2026-10-04'],
  ])('%s resolves in Korean local time', (text, start, end) => {
    const result = parseVoiceDates(normalizeVoiceText(text), now)
    expect('range' in result).toBe(true)
    if ('range' in result) { expect(result.range.start.toISODate()).toBe(start); expect(result.range.end.toISODate()).toBe(end) }
  })
  it.each(['2월 30일', '9월 20일부터 9월 10일까지', '금요일', '내일 모레', '내일부터', '9월 10일부터', '2026년 1월 1일부터 2026년 12월 31일까지', '3일 후', '다다음 주'])('asks instead of guessing: %s', (text) => {
    expect(parseVoiceDates(normalizeVoiceText(text), now)).toHaveProperty('error')
  })
})

describe('rules with real roster and recurrence semantics', () => {
  it.each(['오늘 주간 누구야?', '오늘 낮근무 누가 해?', '오늘주간근무자알려주세요', '주간은?'])('answers roster: %s', (question) => {
    expect(ask(question).status).toBe('ANSWER')
    expect(ask(question).text).toContain('김민수')
    expect(ask(question).text).not.toContain('이지원')
  })
  it('counts partial leave but excludes full education', () => { expect(ask('오늘 주간 몇 명이야?').text).toContain('1명') })
  it('applies substitutes', () => { const answer = ask('내일 야간 누구야?'); expect(answer.text).toContain('강준호'); expect(answer.text).not.toContain('김민수') })
  it('does not infer a missing shift as a day off', () => { expect(ask('모레 야간 누구야?').text).toContain('배정 미등록') })
  it('omits all-day leave from the spoken and displayed roster', () => {
    const answer = ask('내일 주간 누구야?')
    expect(answer.text).toBe('주간 D조 한도윤')
    expect(answer.speech).toBe(answer.text)
  })
  it.each(['오늘 밤 누구 들어와?', '내일 밤 누구야?', '오늘 일근자 누구야?'])('accepts spoken shift synonyms: %s', (text) => { expect(ask(text).status).toBe('ANSWER') })
  it('distinguishes day workers from daytime shifts', () => { const answer = ask('오늘 일근 누구야?'); expect(answer.text).toContain('오지수'); expect(answer.text).not.toContain('김민수') })
  it('excludes day workers on weekends', () => { expect(ask('이번 주 토요일 일근 누구야?').text).toContain('주말·공휴일') })
  it('excludes day workers on fixed holidays', () => { expect(ask('10월 9일 일근 누구야?').text).toContain('주말·공휴일') })
  it.each(['내일 비조 야간 누구야?', '내일 B조 야간 누구야?'])('keeps requested team filter: %s', (text) => { expect(ask(text).text).toBe('해당 조건의 배정 기록 없음') })
  it('filters education targets', () => { expect(ask('김민수 다음 교육 언제야?').text).toContain('정기교육'); expect(ask('김민수 다음 교육 언제야?').text).not.toContain('안전교육') })
  it('returns only the requested location', () => { expect(ask('오늘 안전교육 어디서 해?').text).toBe('교육실') })
  it('returns only the requested start time', () => { expect(ask('오늘 안전교육 몇 시 시작해?').text).toBe('오후 1시') })
  it('counts unique education targets without listing names', () => { expect(ask('모레 교육 몇 명 가?').text).toBe('2명') })
  it('filters vacation kind', () => { expect(ask('내일 연차 누구야?').text).toContain('윤서아') })
  it('does not confuse completion dates across instances', () => { expect(ask('오늘 완료 반복업무 알려줘').text).toContain('정기점검'); expect(ask('내일 완료 반복업무 알려줘').text).toContain('기록 없음') })
  it('lists pending routines', () => { const answer = ask('오늘 미완료 반복업무 알려줘'); expect(answer.text).toContain('장비점검'); expect(answer.text).not.toContain('정기점검') })
  it('honors cancelled recurrence instances', () => {
    const cancelled = event('cancel', '반복업무', '정기점검', '2026-09-09', '', { recurringEventId: 'local::routine', originalStartTimeUtc: utc('2026-09-09'), isDeleted: true })
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 반복업무 알려줘' }), [...events, cancelled], settings, now)
    expect(answer.text).not.toContain('정기점검')
  })
  it('retains the last category on a date follow-up', () => { const first = ask('오늘 야간 누구야?'); expect(ask('그럼 내일은?', { context: first.context }).text).toContain('강준호') })
  it('expires follow-up state', () => { const context = ask('오늘 야간 누구야?').context!; expect(ask('그럼 내일은?', { context: { ...context, answeredAtUtc: utc('2026-09-08T09:57') } }).status).toBe('UNSUPPORTED') })
  it('resolves self only when configured', () => { expect(ask('나 내일 근무야?').status).toBe('CLARIFY'); expect(ask('나 내일 근무야?', { selfName: '이지원' }).text).toBe('야간 A조입니다.') })
  it('supports bounded corrections', () => { expect(ask('오늘 말고 내일 야간 누구야?').text).toContain('강준호') })
  it.each(['외계인 내일 교육 있어?', '김민수 내일 교육 말고 근무 알려줘', '오늘 교육이랑 휴가 알려줘', '김민수 내일 무슨 근무야?'])('unknown or complex input has explicit disposition: %s', (text) => { expect(ask(text).status).not.toBe('UNSUPPORTED') })
  it('does not answer all targets for an unknown name', () => { expect(ask('외계인 내일 교육 있어?').status).toBe('CLARIFY') })
  it.each(['오늘 근무 삭제해줘', '내일 일정 등록해줘', '오늘 반복업무 완료처리해줘'])('never writes: %s', (text) => { expect(ask(text).status).toBe('UNSUPPORTED') })
  it.each(['잔여 연차 얼마야?', '지금 근무 누구야?', '어제 근무 누구야?'])('does not fabricate missing data: %s', (text) => { expect(ask(text).status).toBe('UNAVAILABLE') })
  it('explains supported questions for unknown intents', () => { expect(ask('날씨 어때?').status).toBe('UNSUPPORTED') })
})

describe('concise answers for the Android screen and speech', () => {
  it('queries the closest calendar month while preserving an explicit year', () => {
    const january = [event('old', '일반', '지난 회의', '2026-01-03'), event('new', '일반', '새해 회의', '2027-01-03')]
    const clock = DateTime.fromISO('2026-12-15', { zone: 'Asia/Seoul' })
    const nearest = answerVoiceQuery(voiceQuerySchema.parse({ text: '1월 일정 알려줘' }), january, settings, clock)
    expect(nearest.text).toBe('일반: 새해 회의')
    const explicit = answerVoiceQuery(voiceQuerySchema.parse({ text: '2026년 1월 일정 알려줘' }), january, settings, clock)
    expect(explicit.text).toBe('일반: 지난 회의')
  })
  it.each(['내일 일정 알려줘', '내일 스케줄 알려줘', '내일 뭐 있어?'])('lists activity schedules without roster, leave or holidays: %s', (text) => {
    const schedule = [
      event('meeting', '일반', '회의', '2026-09-09'),
      event('outage', '운용중지작업', '레이더 점검', '2026-09-09'),
      event('routine', '반복업무', '장비 확인', '2026-09-09'),
      event('trip', '출장', '본부 방문', '2026-09-09'),
      event('edu', '교육', '안전교육', '2026-09-09', '교육대상: 김민수'),
      event('important', '중요', '보고 마감', '2026-09-09'),
      event('shift', '근무', 'A/B', '2026-09-09'),
      event('leave', '휴가', '연차', '2026-09-09', '휴가대상: 김민수\n휴가종류: 연차'),
      event('holiday', '공휴일', '공휴일', '2026-09-09'),
    ]
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text }), schedule, settings, now)
    expect(answer.text).toBe('반복업무: 장비 확인\n중요: 보고 마감\n출장: 본부 방문\n교육: 안전교육\n일반: 회의')
    expect(answer.speech).toBe(answer.text)
    expect(answer.eventIds).toEqual(['meeting', 'routine', 'trip', 'edu', 'important'])
    const count = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 일정 몇 건이야?' }), schedule, settings, now)
    expect(count.text).toBe('5건')
  })
  it('finds the next activity after earlier roster and leave events', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '다음 일정 언제야?' }), [
      event('shift', '근무', 'A/B', '2026-09-08', '', { startAtUtc: utc('2026-09-08T11:00') }),
      event('leave', '휴가', '시간차', '2026-09-08', '휴가대상: 김민수\n휴가종류: 시간차', { startAtUtc: utc('2026-09-08T12:00') }),
      event('outage', '운용중지작업', '운용중지', '2026-09-08', '', { startAtUtc: utc('2026-09-08T13:00') }),
      event('meeting', '일반', '회의', '2026-09-08', '', { startAtUtc: utc('2026-09-08T14:00'), endAtUtc: utc('2026-09-08T15:00') }),
    ], settings, now)
    expect(answer.text).toBe('9월 8일 오후 2시~오후 3시 회의')
    expect(answer.eventIds).toEqual(['meeting'])
  })
  it('reports no activity schedules when only a roster and leave are present', () => {
    expect(ask('내일 일정 알려줘').text).toBe('반복업무: 정기점검')
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 일정 알려줘' }), events.filter((item) => item.eventType !== '반복업무'), settings, now)
    expect(answer.text).toBe('일정 없음')
    expect(ask('내일 근무자 누구야?').text).toContain('주간 D조 한도윤')
    expect(ask('내일 연차 누구야?').text).toBe('윤서아-연차')
  })
  it('lists only attending workers across all three shifts', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 근무자 누구야?' }), [
      event('shift', '근무', 'A/B', '2026-09-09'),
      event('leave', '휴가', '연차', '2026-09-09', '휴가대상: 오지수, 김민수\n휴가종류: 연차'),
      event('edu', '교육', '교육', '2026-09-09', '교육대상: 박지훈'),
    ], settings, now)
    expect(answer.text).toBe('일근 없음\n주간 A조 이지원\n야간 B조 최서연')
    expect(answer.speech).toBe(answer.text)
  })
  it.each([
    ['오늘 주간 누구야?', '주간 A조 없음'],
    ['오늘 주간 몇 명이야?', '주간 A조 0명'],
  ])('reports a known roster with everyone absent: %s', (text, expected) => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text }), [
      ...events,
      event('full', '휴가', '연차', '2026-09-08', '휴가대상: 김민수\n휴가종류: 연차'),
    ], settings, now)
    expect(answer.text).toBe(expected)
    expect(answer.speech).toBe(expected)
  })
  it('keeps workers with partial leave in the roster', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '오늘 일근 누구야?' }), [
      ...events,
      event('hourly', '휴가', '시간차', '2026-09-08', '휴가대상: 오지수\n휴가종류: 오전 시간차'),
    ], settings, now)
    expect(answer.text).toBe('일근 오지수')
    expect(answer.speech).toBe(answer.text)
  })
  it('skips absent assignments when finding a persons next working day', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '김민수 다음 근무 언제야?' }), [
      event('today', '근무', 'A/B', '2026-09-08'),
      event('tomorrow', '근무', 'A/B', '2026-09-09'),
      event('leave', '휴가', '연차', '2026-09-08', '휴가대상: 김민수\n휴가종류: 연차'),
    ], settings, now)
    expect(answer.text).toBe('9월 9일 주간 A조입니다.')
    expect(answer.speech).toBe(answer.text)
  })
  it('answers a full roster in three lines without a date or introduction', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 근무자 누구야?' }), [event('shift', '근무', 'A/B', '2026-09-09')], settings, now)
    expect(answer.text).toBe('일근 오지수\n주간 A조 김민수 이지원\n야간 B조 박지훈 최서연')
    expect(answer.speech).toBe(answer.text)
    expect(answer.source).toBe('PC에 저장된 일정 기준')
  })
  it.each([
    ['내일 야간 누구야?', '야간 A조 강준호 이지원'],
    ['내일 야간 몇 명이야?', '야간 A조 2명'],
    ['오늘 주간 몇 명이야?', '주간 A조 1명'],
    ['오늘 안전교육 몇 시 종료야?', '오후 5시'],
    ['오늘 안전교육 몇 시야?', '오후 1시~오후 5시'],
    ['내일 연차 누구야?', '윤서아-연차'],
    ['오늘 미완료 반복업무 알려줘', '장비점검'],
    ['오늘 미완료 반복업무 몇 건이야?', '1건'],
    ['다음 교육 언제야?', '9월 8일 오후 1시~오후 5시 안전교육'],
  ])('%s returns only the requested information', (question, expected) => {
    const answer = ask(question)
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe(expected)
    expect(answer.speech).toBe(question === '내일 연차 누구야?' ? '윤서아, 연차.' : expected)
  })
  it('keeps date labels on ranges and future occurrences', () => {
    const range = ask('9월 8일부터 9월 9일까지 야간 누구야?')
    expect(range.text).toBe('9월 8일 야간 B조 박지훈 최서연\n9월 9일 야간 A조 강준호 이지원')
    expect(ask('김민수 다음 교육 언제야?').text).toBe('9월 10일 오후 2시~오후 4시 정기교육')
  })
  it('answers only name and badge for ongoing leave', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 휴가 누구야?' }), [event('leave', '휴가', '연차휴가', '2026-09-08', '휴가대상: 김민수\n휴가종류: 연차', { endAtUtc: utc('2026-09-11') })], settings, now)
    expect(answer.text).toBe('김민수-연차')
    expect(answer.speech).toBe('김민수, 연차.')
  })
  it('groups duplicate and different leave badges under each person once', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '9월 8일부터 9월 10일까지 휴가 누구야?' }), [
      event('annual', '휴가', '김민수 이지원 연차', '2026-09-08', '휴가대상: 김민수, 이지원, 김민수\n휴가종류: 연차'),
      event('annual-copy', '휴가', '김민수 연차', '2026-09-09', '휴가대상: 김민수\n휴가종류: 연차'),
      event('hourly', '휴가', '김민수 시간차', '2026-09-10', '휴가대상: 김민수\n휴가종류: 시간차(13:00~14:00)'),
    ], settings, now)
    expect(answer.text).toBe('김민수-연차·시간차(13:00~14:00)\n이지원-연차')
    expect(answer.speech).toBe('김민수, 연차, 시간차(오후 1시~오후 2시).\n이지원, 연차.')
  })
  it.each(['9월 16일 김민수 휴가 알려줘', '9월 16일부터 9월 18일까지 휴가 누구야?'])('never repeats the date, title, name or badge for leave: %s', (text) => {
    const items = [
      event('long-leave', '휴가', '김민수 연차', '2026-09-15', '휴가대상: 김민수, 김민수\n휴가종류: 연차', { endAtUtc: utc('2026-09-20') }),
      event('duplicate-leave', '휴가', '김민수 연차', '2026-09-16', '휴가대상: 김민수\n휴가종류: 연차'),
    ]
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text }), items, settings, now)
    expect(answer.text).toBe('김민수-연차')
    expect(answer.speech).toBe('김민수, 연차.')
  })
  it('keeps dates when the question explicitly asks when leave occurs', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '김민수 다음 휴가 언제야?' }), [
      event('leave', '휴가', '연차', '2026-09-09', '휴가대상: 김민수\n휴가종류: 연차', { endAtUtc: utc('2026-09-11') }),
    ], settings, now)
    expect(answer.text).toBe('9월 9일~9월 10일 김민수 연차')
  })
  it('does not repeat other targets or the event title for a named leave question', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '김민수 내일 휴가 알려줘' }), [
      event('leave', '휴가', '김민수 이지원 연차', '2026-09-09', '휴가대상: 김민수, 이지원\n휴가종류: 연차'),
    ], settings, now)
    expect(answer.text).toBe('김민수-연차')
  })
  it('distinguishes missing members from zero people', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 야간 몇 명이야?' }), events, { ...settings, teams: { ...settings.teams, A: [] } }, now)
    expect(answer.text).toBe('야간 A조 구성원 미등록')
    const count = answerVoiceQuery(voiceQuerySchema.parse({ text: '오늘 교육 몇 명이야?' }), [...events, event('unknown', '교육', '신규교육', '2026-09-08')], settings, now)
    expect(count.text).toBe('확인된 1명(일부 대상자 미등록)')
  })
  it('keeps holiday answers short without implying complete holiday data', () => {
    expect(ask('10월 9일 공휴일이야?').text).toBe('고정 공휴일')
    expect(ask('내일 공휴일 있어?').text).toBe('등록된 공휴일 없음')
  })
  it('never cuts an event or a name in the middle of long speech', () => {
    const longEvents = Array.from({ length: 22 }, (_, i) => event(`long-${i}`, '교육', `긴 교육 제목 ${i} ${'상세 '.repeat(15)}`, '2026-09-09', '교육대상: 김민수'))
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 교육 알려줘' }), longEvents, settings, now)
    expect(answer.speech).toBe(answer.text)
    expect(answer.speech.length).toBeGreaterThan(650)
    expect(answer.text.split('\n')).toHaveLength(22)
    expect(answer.text.split('\n').every((line) => line.endsWith('김민수'))).toBe(true)
    expect(answer.text).toContain('긴 교육 제목 21')
    expect(answer.eventIds).toHaveLength(22)
  })
})

describe('complete lists and focused responses', () => {
  it('reads every schedule title in a long range without dates, times or excluded event types', () => {
    const types = ['반복업무', '중요', '출장', '교육', '일반']
    const items = Array.from({ length: 35 }, (_, i) => event(`item-${i}`, types[i % types.length], `일정 제목 ${i}`, `2026-09-${String(9 + i % 10).padStart(2, '0')}`, '교육대상: 김민수'))
    items.push(event('outage', '운용중지작업', '숨겨질 운용중지', '2026-09-09'), event('anniversary', '기념일', '숨겨질 기념일', '2026-09-09'))
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '9월 9일부터 9월 20일까지 일정 알려줘' }), items, settings, now)
    expect(answer.text.split('\n').map((line) => line.split(':')[0])).toEqual(types)
    expect(answer.text).not.toMatch(/9월|2026년|오전|오후|김민수|숨겨질|외 \d/)
    for (let i = 0; i < 35; i++) expect(answer.text).toContain(`일정 제목 ${i}`)
    expect(answer.speech).toBe(answer.text)
    expect(answer.eventIds).toHaveLength(35)
  })
  it.each(['내일 근무자 누구야?', '내일 주간 누구야?', '내일 주간 몇 명이야?'])('omits both leave names and reasons from a work answer: %s', (text) => {
    const items = [
      event('shift', '근무', 'A/B', '2026-09-09'),
      event('first-leave', '휴가', '연차', '2026-09-09', '휴가대상: 김민수\n휴가종류: 연차'),
      event('second-leave', '휴가', '대휴', '2026-09-09', '휴가대상: 이지원\n휴가종류: 대휴'),
    ]
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text }), items, settings, now)
    expect(answer.text).toContain(text.includes('몇 명') ? '주간 A조 0명' : '주간 A조 없음')
    expect(answer.text).not.toMatch(/김민수|이지원|휴가|연차|대휴|부재|미지정|미등록/)
    expect(answer.speech).toBe(answer.text)
    expect(answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 휴가 누구야?' }), items, settings, now).text).toBe('김민수-연차\n이지원-대휴')
  })
  it.each(['오늘 근무자 누구야?', '오늘 주간 몇 명이야?', '김민수 오늘 근무야?', '윤서아 내일 근무야?'])('does not insert leave badges into any work response: %s', (text) => {
    const answer = ask(text)
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).not.toMatch(/휴가|연차|반차|시간차|부재|교육/)
    expect(answer.speech).toBe(answer.text)
  })
  it.each([
    ['이지원 내일 근무야?', '야간 A조입니다.'],
    ['김민수 오늘 근무야?', '주간 A조입니다.'],
    ['윤서아 내일 근무야?', '근무 없음'],
    ['이지원 오늘 근무야?', '근무 없음'],
    ['오지수 오늘 근무야?', '일근입니다.'],
    ['박지훈 모레 근무야?', '배정 기록 없음'],
  ])('%s answers just the persons recorded state', (question, expected) => {
    expect(ask(question).text).toBe(expected)
  })
  it('keeps recorded leave without a shift assignment', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '윤서아 내일 근무야?' }), events.filter((e) => e.eventType !== '근무'), settings, now)
    expect(answer.text).toBe('근무 없음')
  })
  it('reads every leave badge past the old twenty-person limit', () => {
    const many = Array.from({ length: 35 }, (_, i) => event(`leave-${i}`, '휴가', '연차', '2026-09-09', `휴가대상: 직원${i}\n휴가종류: 연차`))
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 휴가 누구야?' }), many, settings, now)
    expect(answer.text.split('\n')).toHaveLength(35)
    expect(answer.speech.split('\n')).toHaveLength(35)
    expect(answer.speech).toContain('직원34, 연차.')
    expect(answer.eventIds).toHaveLength(35)
  })
  it('reads all days in a roster range beyond thirty-one days', () => {
    const many = Array.from({ length: 40 }, (_, i) => event(`shift-${i}`, '근무', 'A/B', now.plus({ days: i }).toISODate()!))
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '9월 8일부터 10월 17일까지 야간 누구야?' }), many, settings, now)
    expect(answer.text.split('\n')).toHaveLength(40)
    expect(answer.speech).toContain('10월 17일 야간 B조 박지훈 최서연')
  })
  it('groups schedule titles without dates, times or unasked targets', () => {
    const answer = ask('오늘 일정 알려줘')
    expect(answer.text).toBe('반복업무: 정기점검, 장비점검\n교육: 안전교육')
  })
})

describe('given names and role names in person queries', () => {
  const roster = { ...settings, teams: { ...settings.teams, A: ['김민수', '이지원'] } }
  const items = [
    event('leave', '휴가', '김민수 연차', '2026-09-16', '휴가대상: 김민수\n휴가종류: 연차'),
    event('other', '휴가', '이지원 연차', '2026-09-15', '휴가대상: 이지원\n휴가종류: 연차'),
  ]
  const query = (text: string, members = roster, records = items) => answerVoiceQuery(voiceQuerySchema.parse({ text }), records, members, now)
  it.each(['민수씨 언제 연차야?', '민수 씨 언제 연차야?', '민수님 언제 연차야?', '민수 언제 연차야?', '민수는 언제 연차야?', '김민수씨 언제 연차야?'])('matches the same person without requiring a full name: %s', (text) => {
    const answer = query(text)
    expect(answer.status).toBe('ANSWER')
    expect(answer.text).toBe('9월 16일 김민수 연차')
    expect(answer.speech).toBe(answer.text)
    expect(answer.context?.people).toEqual(['김민수'])
    expect(answer.eventIds).toEqual(['leave'])
  })
  it.each(['9월 16일 민수씨 연차 누구야?', '이번 달 민수님 휴가 누구야?', '다음 주 수요일 민수 휴가 알려줘'])('accepts a name after a date: %s', (text) => {
    expect(query(text).text).toBe('김민수-연차')
  })
  it.each(['김민수 대리', '김민수대리님', '김민수 과장', '김민수 과장님', '민수 대리', '민수과장님', '김민수 주임', '김민수 차장님', '김민수 부장', '김민수 팀장님'])('accepts a job title after a registered full or given name: %s', (person) => {
    const answer = query(`${person} 언제 연차야?`)
    expect(answer.text).toBe('9월 16일 김민수 연차')
    expect(answer.context?.people).toEqual(['김민수'])
  })
  it('keeps title-qualified names in work and education queries', () => {
    expect(ask('이지원 과장 내일 근무야?').text).toBe('야간 A조입니다.')
    expect(ask('지원 대리님 오늘 교육 어디야?').text).toBe('교육실 안전교육')
  })
  it.each(['김민수 소장님', '민수 소장님'])('does not add the director when 소장 follows an explicit name: %s', (person) => {
    expect(query(`${person} 언제 연차야?`).context?.people).toEqual(['김민수'])
  })
  it.each(['외계인 과장 언제 연차야?', '이민수 대리 언제 연차야?', '대리님 언제 연차야?'])('does not guess a person from an unknown name or job title alone: %s', (text) => {
    expect(query(text).status).toBe('CLARIFY')
  })
  it('supports given names for work and education as well', () => {
    expect(ask('내일 지원씨 근무야?').text).toBe('야간 A조입니다.')
    expect(ask('지원님 오늘 교육 어디야?').text).toBe('교육실 안전교육')
  })
  it('keeps the resolved person in follow-up questions', () => {
    const first = ask('지원씨 오늘 근무야?')
    expect(ask('그럼 내일은?', { context: first.context }).text).toBe('야간 A조입니다.')
  })
  it('asks for a surname when two registered people share a given name', () => {
    const shared = { ...roster, dayWorkers: ['박민수'] }
    const answer = query('민수씨 언제 연차야?', shared)
    expect(answer.status).toBe('CLARIFY')
    expect(answer.text).toContain('김민수, 박민수')
    expect(query('김민수 언제 연차야?', shared).eventIds).toEqual(['leave'])
  })
  it('ignores deleted records when resolving a unique given name', () => {
    expect(query('민수씨 언제 연차야?', roster, [...items,
      event('deleted', '휴가', '박민수 연차', '2026-09-14', '휴가대상: 박민수\n휴가종류: 연차', { isDeleted: true }),
    ]).eventIds).toEqual(['leave'])
  })
  it.each(['이민수 언제 연차야?', '박민수씨 언제 연차야?', '민 언제 연차야?', '외계인 언제 연차야?'])('never substitutes a known person for an unknown or incomplete name: %s', (text) => {
    expect(query(text).status).toBe('CLARIFY')
  })
  it('does not find given names inside an event title', () => {
    expect(query('다음 지역지원교육 언제야?', roster, [event('training', '교육', '지역지원교육', '2026-09-16')]).context?.people).toEqual([])
  })
  it('supports two distinct given names in one leave query', () => {
    expect(query('이번 달 민수씨랑 지원씨 휴가 누구야?').text).toBe('이지원-연차\n김민수-연차')
  })
  it.each(['소장', '소장님', '소장 님'])('resolves %s to the day worker marked as director', (title) => {
    expect(ask(`${title} 오늘 근무야?`).text).toBe(ask('오지수 오늘 근무야?').text)
    const answer = query(`${title} 언제 연차야?`, { ...roster, dayWorkers: ['김민수', '이지원'] })
    expect(answer.text).toBe('9월 16일 김민수 연차')
    expect(answer.context?.people).toEqual(['김민수'])
  })
  it('uses the current director setting and never defaults to another worker', () => {
    expect(query('소장님 언제 연차야?', { ...roster, dayWorkers: ['이지원', '김민수'] }).eventIds).toEqual(['other'])
    const missing = query('소장님 언제 연차야?', { ...roster, dayWorkers: [] })
    expect(missing.status).toBe('CLARIFY')
    expect(missing.text).toBe('소장 이름이 등록되지 않았습니다.')
  })
  it('does not confuse 소장 inside a title with the director', () => {
    expect(query('다음 소장자료교육 언제야?', roster, [event('training', '교육', '소장자료교육', '2026-09-16')]).context?.people).toEqual([])
  })
  it.each(['소장', '소장님', '오지수'])('matches legacy role targets and the current director equally: %s', (person) => {
    const records = [event('legacy', '휴가', '소장님 연차', '2026-09-16', '휴가대상: 소장님\n휴가종류: 연차')]
    const answer = query(`${person} 연차 언제야?`, roster, records)
    expect(answer.text).toBe('9월 16일 오지수 연차')
    expect(answer.context?.people).toEqual(['오지수'])
    expect(answer.eventIds).toEqual(['legacy'])
    expect(records[0].description).toBe('휴가대상: 소장님\n휴가종류: 연차')
    expect(records[0].summary).toBe('소장님 연차')
  })
  it('does not let a legacy role target hide the director alias on a work query', () => {
    const records = [event('legacy', '휴가', '소장님 연차', '2026-09-16', '휴가대상: 소장님\n휴가종류: 연차')]
    expect(query('소장님 오늘 근무야?', roster, records).text).toBe('일근입니다.')
    expect(query('소장 오늘 근무야?', roster, records).text).toBe('일근입니다.')
  })
  it('applies legacy role leave to actual attendance', () => {
    const records = [event('legacy', '휴가', '소장 연차', '2026-09-08', '휴가대상: 소장\n휴가종류: 연차')]
    expect(query('소장님 오늘 근무야?', roster, records).text).toBe('근무 없음')
    expect(query('오늘 일근 누구야?', roster, records).text).toBe('일근 없음')
  })
  it('matches education targets saved as a role', () => {
    const records = [event('legacy', '교육', '소장님 교육', '2026-09-08', '교육대상: 소장님', { location: '교육실' })]
    expect(query('소장님 오늘 교육 어디야?', roster, records).text).toBe('교육실 오지수 교육')
    expect(query('소장님 오늘 교육 어디야?', roster, records).context?.people).toEqual(['오지수'])
  })
})

describe('vacation dates without all-day time placeholders', () => {
  it.each(['연차', '대휴', '장기휴가', '오후 반차', '병가', '공가'])('answers %s with date, name and badge only', (kind) => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '민수씨 언제 휴가야?' }), [
      event('leave', '휴가', `김민수 ${kind}`, '2026-09-16', `휴가대상: 김민수, 이지원\n휴가종류: ${kind}`),
    ], settings, now)
    expect(answer.text).toBe(`9월 16일 김민수 ${kind}`)
    expect(answer.speech).toBe(answer.text)
    expect(answer.text).not.toMatch(/시각|미등록|종일|이지원/)
  })
  it('suppresses clock times for non-hourly leave even when the event stores a time', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '민수씨 연차 몇 시 시작해?' }), [
      event('leave', '휴가', '김민수 연차', '2026-09-08', '휴가대상: 김민수\n휴가종류: 연차', { startAtUtc: utc('2026-09-08T13:00'), endAtUtc: utc('2026-09-08T18:00') }),
    ], settings, now)
    expect(answer.text).toBe('9월 8일 김민수 연차')
  })
  it('still provides the registered times for hourly leave', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '민수씨 시간차 언제야?' }), [
      event('leave', '휴가', '김민수 시간차', '2026-09-16', '휴가대상: 김민수\n휴가종류: 시간차', { startAtUtc: utc('2026-09-16T13:00'), endAtUtc: utc('2026-09-16T15:00') }),
    ], settings, now)
    expect(answer.text).toBe('9월 16일 오후 1시~오후 3시 김민수 시간차')
  })
  it('keeps missing-time information for hourly leave', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '민수씨 시간차 언제야?' }), [
      event('leave', '휴가', '김민수 시간차', '2026-09-16', '휴가대상: 김민수\n휴가종류: 시간차'),
    ], settings, now)
    expect(answer.text).toContain('시각 미등록')
  })
  it('does not suggest midnight when distinguishing non-hourly leave events', () => {
    const answer = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 휴가 언제야?' }), [
      event('first', '휴가', '김민수 연차', '2026-09-09', '휴가대상: 김민수\n휴가종류: 연차'),
      event('second', '휴가', '이지원 대휴', '2026-09-09', '휴가대상: 이지원\n휴가종류: 대휴'),
    ], settings, now)
    expect(answer.text).not.toMatch(/12시|종일|시각/)
  })
})

describe('short clarification answers', () => {
  const meetings = [
    event('am', '일반', '회의', '2026-09-09', '', { startAtUtc: utc('2026-09-09T09:00'), endAtUtc: utc('2026-09-09T10:00'), location: '오전 회의실' }),
    event('pm', '일반', '회의', '2026-09-09', '', { startAtUtc: utc('2026-09-09T14:00'), endAtUtc: utc('2026-09-09T15:00'), location: '오후 회의실' }),
  ]
  const query = (text: string, context = answerVoiceQuery(voiceQuerySchema.parse({ text: '내일 회의 어디야?' }), meetings, settings, now).context, items = meetings) =>
    answerVoiceQuery(voiceQuerySchema.parse({ text, context }), items, settings, now)
  it('offers timed options with no usage lecture', () => {
    expect(query('내일 회의 어디야?', null).text).toBe('오전 9시 회의, 오후 2시 회의 중 어느 일정인가요?')
  })
  it.each(['오후', '오후요', '오후 2시', '14시', '두 번째', '2번'])('accepts a short option: %s', (text) => {
    expect(query(text).text).toBe('오후 회의실')
  })
  it('does not substitute another event if the chosen event was removed', () => {
    expect(query('첫 번째', undefined, [meetings[1]]).status).toBe('CLARIFY')
  })
  it('lets a new question replace pending clarification', () => {
    expect(query('내일 일정 알려줘').text).toBe('일반: 회의, 회의')
  })
  it('expires old choices', () => {
    const first = query('내일 회의 어디야?', null)
    expect(query('오후', { ...first.context!, answeredAtUtc: now.minus({ minutes: 3 }).toUTC().toISO()! }).status).toBe('UNSUPPORTED')
  })
  it('replaces a rejected date while keeping the person and query', () => {
    const first = ask('김민수 오늘 내일 근무야?')
    expect(first.text).toBe('어느 날짜인가요?')
    expect(ask('오늘', { context: first.context }).text).toBe('주간 A조입니다.')
  })
  it('keeps the weekday when the user clarifies which week', () => {
    const first = ask('금요일 일정 알려줘')
    expect(first.text).toBe('이번 주인가요, 다음 주인가요?')
    expect(ask('다음 주', { context: first.context }).context?.startDate).toBe('2026-09-18')
  })
})
