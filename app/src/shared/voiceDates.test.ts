import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { normalizeVoiceText, parseVoiceDates } from './voiceDates'

describe('nearest year for spoken dates', () => {
  it.each([
    ['2026-12-15', '1월', '2027-01-01', '2027-02-01'],
    ['2026-01-15', '12월', '2025-12-01', '2026-01-01'],
    ['2026-09-09', '9월', '2026-09-01', '2026-10-01'],
    ['2026-07-01', '1월', '2027-01-01', '2027-02-01'],
    ['2026-12-15', '1월 3일', '2027-01-03', '2027-01-04'],
    ['2026-01-15', '12월 25일', '2025-12-25', '2025-12-26'],
    ['2026-09-08', '2월 29일', '2028-02-29', '2028-03-01'],
    ['2025-01-01', '2월 29일', '2024-02-29', '2024-03-01'],
    ['2026-09-08', '2026년 1월', '2026-01-01', '2026-02-01'],
    ['2026-09-08', '올해 1월', '2026-01-01', '2026-02-01'],
    ['2026-09-08', '내년 9월 10일', '2027-09-10', '2027-09-11'],
    ['2026-09-08', '2026-01-03', '2026-01-03', '2026-01-04'],
    ['2026-12-10', '12월 30일부터 1월 2일까지', '2026-12-30', '2027-01-03'],
    ['2027-01-10', '12월 30일부터 1월 2일까지', '2026-12-30', '2027-01-03'],
    ['2026-09-08', '3월 1일부터 3월 10일까지', '2027-03-01', '2027-03-11'],
    ['2026-09-08', '2026년 3월 1일부터 3월 10일까지', '2026-03-01', '2026-03-11'],
  ])('%s resolves %s as a coherent closest occurrence', (clock, text, start, end) => {
    const answer = parseVoiceDates(normalizeVoiceText(text), DateTime.fromISO(clock, { zone: 'Asia/Seoul' }))
    expect(answer).toHaveProperty('range')
    if ('range' in answer) {
      expect(answer.range.start.toISODate()).toBe(start)
      expect(answer.range.end.toISODate()).toBe(end)
      expect(answer.range.explicit).toBe(true)
    }
  })
  it.each(['13월', '0월', '2월 30일', '9월 20일부터 9월 10일까지', '2026년 12월 30일부터 2026년 1월 2일까지', '2026년 내년 9월'])('rejects invalid or conflicting dates: %s', (text) => {
    expect(parseVoiceDates(normalizeVoiceText(text), DateTime.fromISO('2026-09-08', { zone: 'Asia/Seoul' }))).toHaveProperty('error')
  })
})
