import { describe, expect, it, vi } from 'vitest'
import { DateTime } from 'luxon'
import { calendarEventSchema, defaultShiftSettings, type CalendarEvent } from '../../shared/calendar'
import { voiceQuerySchema } from '../../shared/voice'
import { VoiceCommandService } from './voiceCommandService'

const initial = calendarEventSchema.parse({ localId: 'meeting', googleEventId: null, eventType: '일반', summary: '회의', description: '', location: '', startAtUtc: '2026-09-09T05:00:00.000Z', endAtUtc: '2026-09-09T06:00:00.000Z', timeZone: 'Asia/Seoul', attendees: [], recurrenceRule: null, recurringEventId: null, originalStartTimeUtc: null, organizerEmail: null, hangoutLink: null, googleUpdatedAtUtc: null, localEditedAtUtc: '2026-09-08T01:00:00.000Z', syncState: 'CLEAN' })
function setup(data: CalendarEvent[] = []) {
  let events = data
  let now = DateTime.fromISO('2026-09-08T10:00:00+09:00')
  const upsert = vi.fn(async () => initial)
  const remove = vi.fn(async () => true)
  const control = vi.fn(async () => '화면 이동 완료')
  const service = new VoiceCommandService({ events: async () => events, settings: async () => defaultShiftSettings, upsert, remove, control, sync: async () => '동기화 요청 완료', clock: () => now })
  return { service, upsert, remove, control, query: (text: string) => service.query(voiceQuerySchema.parse({ text })), setEvents: (value: CalendarEvent[]) => { events = value }, advance: () => { now = now.plus({ minutes: 3 }) } }
}
describe('voice action previews and writes', () => {
  it('creates only after confirmation and retries at most once', async () => {
    const s = setup()
    const preview = await s.query('내일 오후 2시에 회의 등록해줘')
    expect(preview.status).toBe('PREVIEW'); expect(s.upsert).not.toHaveBeenCalled()
    expect(preview.text).toBe('등록: [일반] 회의\n2026년 9월 9일 14:00~15:00\n확인 또는 취소라고 말씀해 주세요.')
    const [first, second] = await Promise.all([s.service.confirm(preview.confirmationId!, true), s.service.confirm(preview.confirmationId!, true)])
    expect(first.status).toBe('ANSWER'); expect(second).toEqual(first); expect(s.upsert).toHaveBeenCalledTimes(1)
    expect(first.text).toBe('회의 등록 완료'); expect(first.speech).toBe(first.text)
    expect(s.upsert).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: 'none', attendees: [] }))
  })
  it('cancels and never executes a cancelled confirmation', async () => {
    const s = setup(); const preview = await s.query('내일 종일 회의 등록해줘')
    await s.service.confirm(preview.confirmationId!, false); await s.service.confirm(preview.confirmationId!, true)
    expect(s.upsert).not.toHaveBeenCalled()
  })
  it('expires previews', async () => { const s = setup(); const preview = await s.query('내일 종일 회의 등록해줘'); s.advance(); expect((await s.service.confirm(preview.confirmationId!, true)).status).toBe('UNAVAILABLE'); expect(s.upsert).not.toHaveBeenCalled() })
  it('refuses existing duplicate creates', async () => { const s = setup([initial]); expect((await s.query('내일 오후 2시 회의 등록해줘')).status).toBe('CLARIFY') })
  it('rechecks duplicates before committing', async () => { const s = setup(); const preview = await s.query('내일 오후 2시 회의 등록해줘'); s.setEvents([initial]); expect((await s.service.confirm(preview.confirmationId!, true)).status).toBe('CLARIFY'); expect(s.upsert).not.toHaveBeenCalled() })
  it('keeps the old duration on time updates', async () => {
    const s = setup([initial]); const preview = await s.query('내일 회의 오후 3시로 변경해줘')
    expect(preview.status).toBe('PREVIEW'); await s.service.confirm(preview.confirmationId!, true)
    expect(s.upsert).toHaveBeenCalledWith(expect.objectContaining({ localId: 'meeting', startAtUtc: '2026-09-09T06:00:00.000Z', endAtUtc: '2026-09-09T07:00:00.000Z' }))
  })
  it('rejects edits when the event changed since preview', async () => {
    const s = setup([initial]); const preview = await s.query('내일 회의 삭제해줘')
    s.setEvents([{ ...initial, summary: '변경된회의' }]); expect((await s.service.confirm(preview.confirmationId!, true)).status).toBe('CLARIFY'); expect(s.remove).not.toHaveBeenCalled()
  })
  it('requires a recurrence scope and targets a virtual occurrence using the master id', async () => {
    const s = setup([{ ...initial, recurrenceRule: 'FREQ=DAILY;COUNT=4' }])
    expect((await s.query('모레 회의 삭제해줘')).status).toBe('CLARIFY')
    const preview = await s.query('모레 회의 이번만 삭제해줘'); expect(preview.status).toBe('PREVIEW')
    await s.service.confirm(preview.confirmationId!, true)
    expect(s.remove).toHaveBeenCalledWith(expect.objectContaining({ localId: 'meeting', recurrenceScope: 'THIS', originalStartTimeUtc: '2026-09-10T05:00:00.000Z' }))
  })
  it('does not select among duplicate titles', async () => { const s = setup([initial, { ...initial, localId: 'other' }]); expect((await s.query('내일 회의 삭제해줘')).status).toBe('CLARIFY'); expect(s.remove).not.toHaveBeenCalled() })
  it('updates completion for the selected occurrence only', async () => {
    const s = setup([{ ...initial, eventType: '반복업무', summary: '장비점검', recurrenceRule: 'FREQ=DAILY;COUNT=3' }])
    const preview = await s.query('모레 장비점검 완료 처리해줘'); expect(preview.status).toBe('PREVIEW')
    await s.service.confirm(preview.confirmationId!, true)
    expect(s.upsert).toHaveBeenCalledWith(expect.objectContaining({ recurrenceScope: 'THIS', description: '반복완료: 2026-09-10' }))
  })
  it.each([
    ['다음 달 보여줘', 'NEXT_MONTH'], ['이전 달 보여줘', 'PREVIOUS_MONTH'],
    ['오늘 보여줘', 'TODAY'], ['9월 달력 보여줘', 'GOTO_DATE'],
    ['근무표 열어줘', 'OPEN_ROSTER'], ['달력 열어줘', 'OPEN_CALENDAR'],
    ['설정 열어줘', 'OPEN_SETTINGS'], ['동기화 창 열어줘', 'OPEN_SYNC'],
  ])('executes %s without a spoken or written acknowledgement', async (text, type) => {
    const s = setup()
    expect(await s.query(text)).toMatchObject({ status: 'ANSWER', text: '', speech: '' })
    expect(s.control).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type }))
  })
  it('waits for screen control to finish before returning its silent result', async () => {
    const s = setup()
    let finish!: (value: string) => void
    s.control.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve }))
    const completed = vi.fn()
    const result = s.query('다음 달 보여줘').then(completed)
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    finish('화면 이동 완료')
    await result
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ text: '', speech: '' }))
  })
  it('keeps synchronization commands silent', async () => {
    expect(await setup().query('동기화해줘')).toMatchObject({ status: 'ANSWER', text: '', speech: '' })
  })
  it('still reports a failed screen command', async () => {
    const s = setup(); s.control.mockRejectedValue(new Error('closed'))
    const result = await s.query('다음 달 보여줘')
    expect(result.status).toBe('UNAVAILABLE')
    expect(result.speech).toContain('PC 앱 상태를 확인')
  })
  it('does not report failure to refresh as failure to save', async () => { const s = setup(); s.control.mockRejectedValue(new Error('closed')); const preview = await s.query('내일 종일 회의 등록해줘'); const result = await s.service.confirm(preview.confirmationId!, true); expect(result.status).toBe('ANSWER'); expect(result.text).toContain('새로고침을 확인하지 못했습니다'); expect(s.upsert).toHaveBeenCalledTimes(1) })
})
