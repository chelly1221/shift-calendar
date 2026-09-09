import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from './calendar'
import { buildShiftDaySummary, formatShiftWorkers } from './shiftSummary'

const date = '2026-09-10'
const start = DateTime.fromISO(date, { zone: 'Asia/Seoul' })
const teams = { A: ['김민수', '이지원'], B: ['박지훈', '최서연'], C: [], D: [] }
const event = (localId: string, eventType: string, summary: string, description = ''): CalendarEvent => ({
  localId, eventType, summary, description, googleEventId: null, location: '',
  startAtUtc: start.toUTC().toISO()!, endAtUtc: start.plus({ days: 1 }).toUTC().toISO()!, timeZone: 'Asia/Seoul',
  attendees: [], recurrenceRule: null, skipWeekendsAndHolidays: false, recurringEventId: null, originalStartTimeUtc: null,
  organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null, localEditedAtUtc: start.toUTC().toISO()!, syncState: 'CLEAN',
})
const shift = event('shift', '근무', 'A/B')
const leave = (name: string, kind = '연차') => event(`leave-${name}`, '휴가', kind, `휴가대상: ${name}\n휴가종류: ${kind}`)
const summarize = (events: CalendarEvent[], members = teams) => buildShiftDaySummary(date, events, members, [], new Map(), 'Asia/Seoul')

describe('today shift card attendance', () => {
  it.each(['주간', '야간'])('shows no workers when both %s team members are on separate leave events', (period) => {
    const names = period === '주간' ? teams.A : teams.B
    const result = summarize([shift, ...names.map((name) => leave(name))])
    const roster = period === '주간' ? result.dayRoster : result.nightRoster
    const keys = period === '주간' ? result.dayTeams : result.nightTeams
    expect(roster).toHaveLength(2)
    expect(formatShiftWorkers(keys, roster)).toBe(`${period === '주간' ? 'A' : 'B'}조 근무자 없음`)
  })
  it('handles both names in a single leave event', () => {
    const result = summarize([shift, leave('김민수, 이지원')])
    expect(result.dayMembers).toEqual([])
    expect(formatShiftWorkers(result.dayTeams, result.dayRoster)).toBe('A조 근무자 없음')
    expect(formatShiftWorkers(result.nightTeams, result.nightRoster)).toBe('박지훈 · 최서연')
  })
  it('lists only the remaining worker when one person is on leave', () => {
    const result = summarize([shift, leave('김민수')])
    expect(formatShiftWorkers(result.dayTeams, result.dayRoster)).toBe('이지원')
  })
  it('keeps genuinely missing member settings distinct from no attendance', () => {
    const result = summarize([shift], { ...teams, A: [] })
    expect(formatShiftWorkers(result.dayTeams, result.dayRoster)).toBe('A조 미지정')
    const unassigned = summarize([])
    expect(formatShiftWorkers(unassigned.dayTeams, unassigned.dayRoster)).toBeNull()
  })
  it('keeps a partial-day worker without a leave badge on the today card', () => {
    const result = summarize([shift, leave('김민수'), leave('이지원', '오후 반차')])
    expect(formatShiftWorkers(result.dayTeams, result.dayRoster)).toBe('이지원')
  })
  it('does not remove a substitute because the original worker is on leave', () => {
    const substitution = { ...shift, description: '대체근무자: 강준호\n근무종류: 대리근무\n원근무자: 김민수' }
    const result = summarize([substitution, leave('김민수'), leave('이지원')])
    expect(formatShiftWorkers(result.dayTeams, result.dayRoster)).toBe('강준호')
  })
})
