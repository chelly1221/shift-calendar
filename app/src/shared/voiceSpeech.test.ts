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

describe('spoken list separators', () => {
  it('uses pauses between duty groups without changing the display answer', () => {
    const text = '9월 10일 일근 김수헌 / 주간 A조 윤태연 이명섭 / 야간 B조 이상승'
    expect(formatVoiceSpeech(text)).toBe('9월 10일 일근 김수헌, 주간 A조 윤태연 이명섭, 야간 B조 이상승')
    expect(text).toContain(' / ')
  })

  it('handles full-width and unspaced separators and preserves line breaks', () => {
    expect(formatVoiceSpeech('일반／회의\n교육/훈련 ／ 출장')).toBe('일반, 회의\n교육, 훈련, 출장')
  })

  it('keeps numeric dates and fractions meaningful', () => {
    expect(formatVoiceSpeech('2026/09/10 또는 9／11, 완료 1 / 2')).toBe('2026/09/10 또는 9／11, 완료 1 / 2')
  })

  it('pauses between clock times after formatting them', () => {
    expect(formatVoiceSpeech('14:00 / 15:30')).toBe('오후 2시, 오후 3시 30분')
  })

  it('leaves links and Windows file paths intact', () => {
    const text = '참고 https://example.com/일정/9월 파일 C:/일정/근무표.txt'
    expect(formatVoiceSpeech(text)).toBe(text)
  })
})
