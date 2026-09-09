import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { parseVoiceCommand } from './voiceCommands'

const now = DateTime.fromISO('2026-09-08T10:00:00+09:00')
const parse = (text: string) => parseVoiceCommand(text, now)

describe('PC calendar voice commands', () => {
  it.each([
    ['2026-12-15', '1월 달력 알려줘', '2027-01-01'],
    ['2026-01-15', '12월 캘린더 보여줘', '2025-12-01'],
    ['2026-09-09', '9월 달력 알려줘', '2026-09-01'],
    ['2026-09-09', '구월 달력 알려줘', '2026-09-01'],
    ['2026-12-15', '2026년 1월 달력 알려줘', '2026-01-01'],
    ['2026-12-15', '올해 1월 달력 알려줘', '2026-01-01'],
  ])('at %s, %s opens the intended year', (clock, text, date) => {
    expect(parseVoiceCommand(text, DateTime.fromISO(clock, { zone: 'Asia/Seoul' })))
      .toEqual({ kind: 'control', control: { type: 'GOTO_DATE', date } })
  })
  it('keeps closest-year rules for drafts and coherent cross-year leave ranges', () => {
    const clock = DateTime.fromISO('2026-12-15', { zone: 'Asia/Seoul' })
    expect(parseVoiceCommand('1월 3일 종일 회의 등록해줘', clock)).toMatchObject({
      kind: 'create', input: { startAtUtc: '2027-01-02T15:00:00.000Z' },
    })
    expect(parseVoiceCommand('12월 30일부터 1월 2일까지 김민수 연차 등록해줘', clock)).toMatchObject({
      kind: 'create', input: { startAtUtc: '2026-12-29T15:00:00.000Z', endAtUtc: '2027-01-02T15:00:00.000Z' },
    })
  })
  it.each([
    ['다음 달 보여줘', 'NEXT_MONTH'], ['다음달로 이동해줘', 'NEXT_MONTH'], ['다음 달 넘겨줘', 'NEXT_MONTH'],
    ['이전 달 보여줘', 'PREVIOUS_MONTH'], ['지난달로 이동해줘', 'PREVIOUS_MONTH'], ['오늘로 이동해줘', 'TODAY'], ['이번 달 보여줘', 'TODAY'],
    ['근무표 보여줘', 'OPEN_ROSTER'], ['2주 근무표 보여줘', 'OPEN_ROSTER'], ['캘린더 열어줘', 'OPEN_CALENDAR'], ['설정 열어줘', 'OPEN_SETTINGS'], ['동기화 화면 열어줘', 'OPEN_SYNC'],
  ])('%s routes to the requested screen', (text, type) => { expect(parse(text)).toEqual({ kind: 'control', control: { type } }) })
  it.each([['9월 15일로 이동해줘', '2026-09-15'], ['10월 보여줘', '2026-10-01'], ['2027년 1월 보여줘', '2027-01-01'], ['내일 보여줘', '2026-09-09']])('%s navigates to a valid date', (text, date) => {
    expect(parse(text)).toEqual({ kind: 'control', control: { type: 'GOTO_DATE', date } })
  })
  it.each(['다음 달 일정 보여줘', '9월 15일 근무자 누구야?', '내일 교육 언제야?', '등록된 일정 알려줘'])('keeps queries separate: %s', (text) => { expect(parse(text).kind).toBe('query') })
  it.each(['내일 오후 2시에 회의 등록해줘', '내일 오후 두 시 회의 추가해줘', '내일 14시 회의 생성해줘'])('creates explicit timed drafts: %s', (text) => {
    const command = parse(text)
    expect(command.kind).toBe('create')
    if (command.kind === 'create') expect(command.input).toMatchObject({ summary: '회의', startAtUtc: '2026-09-09T05:00:00.000Z', endAtUtc: '2026-09-09T06:00:00.000Z', sendUpdates: 'none' })
  })
  it('handles start and end times', () => {
    const command = parse('9월 15일 오후 2시 반부터 오후 4시까지 회의 등록해줘')
    expect(command.kind).toBe('create')
    if (command.kind === 'create') expect(command.input).toMatchObject({ summary: '회의', startAtUtc: '2026-09-15T05:30:00.000Z', endAtUtc: '2026-09-15T07:00:00.000Z' })
  })
  it('keeps midnight end exclusive for all-day ranges', () => {
    const command = parse('9월 10일부터 9월 15일까지 김민수 연차 등록해줘')
    expect(command.kind).toBe('create')
    if (command.kind === 'create') expect(command.input).toMatchObject({ summary: '김민수연차', startAtUtc: '2026-09-09T15:00:00.000Z', endAtUtc: '2026-09-15T15:00:00.000Z' })
  })
  it.each([['매일', 'FREQ=DAILY'], ['매주', 'FREQ=WEEKLY'], ['매월', 'FREQ=MONTHLY']])('creates %s recurrence explicitly', (word, rule) => {
    const command = parse(`내일 ${word} 오후 2시 점검 등록해줘`)
    expect(command.kind).toBe('create')
    if (command.kind === 'create') expect(command.input.recurrenceRule).toBe(rule)
  })
  it.each(['회의 등록해줘', '내일 회의 등록해줘', '내일 2시 회의 등록해줘', '내일 오후 25시 회의 등록해줘', '내일 오후 2시 70분 회의 등록해줘', '내일 오후 4시부터 오후 2시까지 회의 등록해줘', '내일 종일 오후 2시 회의 등록해줘', '2월 30일 종일 회의 등록해줘', '내일 종일 모든일정 삭제해줘', '내일 오후 2시 말고 3시 회의 등록해줘'])('clarifies incomplete or conflicting commands: %s', (text) => { expect(parse(text).kind).toBe('clarify') })
  it('changes a start time while retaining the target date and title', () => { expect(parse('내일 회의 오후 3시로 변경해줘')).toMatchObject({ kind: 'change', action: 'update', title: '회의', date: '2026-09-09', startAtUtc: '2026-09-09T06:00:00.000Z' }) })
  it.each(['내일 밤 12시 회의 등록해줘', '내일 회의 매주 오후 3시로 변경해줘', '내일 회의 제목을 팀회의로 오후 3시 변경해줘', '9월 10일부터 9월 15일까지 오후 2시 회의 등록해줘', '내일 오후 2시 또는 오후 3시 회의 등록해줘'])('does not discard ambiguous command conditions: %s', (text) => { expect(parse(text).kind).toBe('clarify') })
  it('moves to another date without guessing the old time', () => { expect(parse('9월 15일 회의 9월 16일로 옮겨줘')).toMatchObject({ kind: 'change', title: '회의', date: '2026-09-15', dateOnly: true }) })
  it('renames an exact event', () => { expect(parse('내일 회의 제목을 팀회의로 변경해줘')).toMatchObject({ kind: 'change', title: '회의', summary: '팀회의' }) })
  it.each([['이번만', 'THIS'], ['전체', 'ALL'], ['이후', 'FUTURE']])('records the %s recurrence scope', (word, scope) => { expect(parse(`내일 회의 ${word} 삭제해줘`)).toMatchObject({ kind: 'change', action: 'delete', title: '회의', scope }) })
  it.each([['완료 처리해줘', 'complete'], ['미완료 처리해줘', 'uncomplete'], ['완료 취소해줘', 'uncomplete']])('handles routine %s', (phrase, action) => { expect(parse(`오늘 장비점검 ${phrase}`)).toMatchObject({ kind: 'change', title: '장비점검', action }) })
})
