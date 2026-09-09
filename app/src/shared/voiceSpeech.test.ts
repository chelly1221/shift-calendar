import { describe, expect, it } from 'vitest'
import { formatVoiceSpeech, voiceTimeLabel } from './voiceSpeech'

describe('spoken time labels', () => {
  it.each([[0, 0, '오전 12시'], [12, 0, '오후 12시'], [14, 30, '오후 2시 30분'], [23, 59, '오후 11시 59분']] as const)('reads %s:%s naturally', (hour, minute, expected) => {
    expect(voiceTimeLabel(hour, minute)).toBe(expected)
  })
  it('preserves dates and confirmation details while reading clock times naturally', () => {
    expect(formatVoiceSpeech('2026-09-10 회의 14:00~15:30\n범위: 전체\n확인 또는 취소')).toBe('2026-09-10 회의 오후 2시~오후 3시 30분\n범위: 전체\n확인 또는 취소')
  })
})
