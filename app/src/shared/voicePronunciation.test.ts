import { describe, expect, it } from 'vitest'
import { prepareVoicePronunciation } from './voicePronunciation'

describe('voice-only Korean clock pronunciation', () => {
  it.each([
    ['18:00', '오후 여섯 시.'],
    ['오후6시', '오후 여섯 시.'],
    ['오후 6시', '오후 여섯 시.'],
    ['6시30분', '여섯 시 삼십 분.'],
    ['6시 30분', '여섯 시 삼십 분.'],
    ['오전9시5분', '오전 아홉 시 오 분.'],
    ['09:01', '오전 아홉 시 일 분.'],
    ['14:10', '오후 두 시 십 분.'],
    ['23:59', '오후 열한 시 오십구 분.'],
    ['오후 2시 11분', '오후 두 시 십일 분.'],
    ['오후 2시 20분', '오후 두 시 이십 분.'],
    ['6시 00분', '여섯 시.'],
    ['6:00', '오전 여섯 시.'],
    ['오후 6:00', '오후 여섯 시.'],
    ['오후 18시', '오후 여섯 시.'],
    ['오전 06시', '오전 여섯 시.'],
    ['1시 2시 3시 4시', '한 시 두 시 세 시 네 시.'],
    ['5시 7시 8시 10시 11시', '다섯 시 일곱 시 여덟 시 열 시 열한 시.'],
  ])('reads clock %s with native Korean hours and Sino-Korean minutes', (input, expected) => {
    expect(prepareVoicePronunciation(input)).toBe(expected)
  })

  it.each([
    ['0시', '자정.'],
    ['00:00', '자정.'],
    ['0시30분', '오전 열두 시 삼십 분.'],
    ['12시', '열두 시.'],
    ['12시00분', '열두 시.'],
    ['12:00', '정오.'],
    ['오전12시', '자정.'],
    ['오후12시', '정오.'],
    ['오전12시00분', '자정.'],
    ['오후12시00분', '정오.'],
    ['24시', '자정.'],
    ['24:00', '자정.'],
    ['오전0시', '자정.'],
    ['오전24시', '자정.'],
    ['12시30분', '열두 시 삼십 분.'],
    ['오전12시30분', '오전 열두 시 삼십 분.'],
    ['오후12시30분', '오후 열두 시 삼십 분.'],
    ['12:30', '오후 열두 시 삼십 분.'],
    ['00:30', '오전 열두 시 삼십 분.'],
  ])('handles midnight and noon consistently: %s', (input, expected) => {
    expect(prepareVoicePronunciation(input)).toBe(expected)
  })

  it('preserves time ranges and Korean clock particles', () => {
    expect(prepareVoicePronunciation('오후6시부터 오후7시까지')).toBe('오후 여섯 시부터 오후 일곱 시까지.')
    expect(prepareVoicePronunciation('18:00~19:30')).toBe('오후 여섯 시~오후 일곱 시 삼십 분.')
    expect(prepareVoicePronunciation('6시30분에 시작')).toBe('여섯 시 삼십 분에 시작.')
    expect(prepareVoicePronunciation('오후12시부터 오전12시까지')).toBe('정오부터 자정까지.')
  })

  it('pronounces clocks before sentence-ending periods', () => {
    expect(prepareVoicePronunciation('회의 오후 6시. 점심 오후 12시. 점검 오전 12시.'))
      .toBe('회의 오후 여섯 시. 점심 정오. 점검 자정.')
    expect(prepareVoicePronunciation('시작 12:00. 종료 18:30.'))
      .toBe('시작 정오. 종료 오후 여섯 시 삼십 분.')
  })

  it.each([
    '6시간', '6시간30분', '6시스템', '6시리즈', '6시청',
    '2026년', '9월', '16일', '6.5시', '3.14', '6회', '6차',
    '1/6', '2026/09/16', '25시', '24시30분', '24:01', '23:60',
    '6시60분', '6시300분', '6시 300분', '6:300', '18:00:30', '12:00.05', '18:30.5',
    '2026-09-16T18:00:00', 'v6:30', 'AB6시',
  ])('does not partially rewrite a non-clock or invalid value: %s', (input) => {
    expect(prepareVoicePronunciation(input)).toBe(`${input}.`)
  })

  it('does not reinterpret conflicting day periods', () => {
    expect(prepareVoicePronunciation('오전 18시')).toBe('오전 18시.')
    expect(prepareVoicePronunciation('오후 0시')).toBe('오후 0시.')
    expect(prepareVoicePronunciation('오후 24시')).toBe('오후 24시.')
  })

  it('preserves dates, counts, and names while pronouncing the adjacent clock', () => {
    expect(prepareVoicePronunciation('9월 16일 이상승 1차 교육 오후6시')).toBe('9월 16일 이상승 1차 교육 오후 여섯 시.')
    expect(prepareVoicePronunciation('2026-09-16 김수헌 0.5일 6회 30분')).toBe('2026-09-16 김수헌 0.5일 6회 30분.')
  })
})

describe('natural spacing for speech', () => {
  it('keeps word spaces and explicit punctuation without adding pauses', () => {
    expect(prepareVoicePronunciation('일근 박혜지 윤형집')).toBe('일근 박혜지 윤형집.')
    expect(prepareVoicePronunciation('일반 장비 상태 확인')).toBe('일반 장비 상태 확인.')
    expect(prepareVoicePronunciation('박혜지, 윤형집. 교육: 안전 교육')).toBe('박혜지, 윤형집. 교육: 안전 교육.')
  })

  it('preserves item boundaries and existing terminal punctuation', () => {
    expect(prepareVoicePronunciation('  일근\t 박혜지  \r\n\n주간 윤형집!\n')).toBe('일근 박혜지.\n주간 윤형집!')
    expect(prepareVoicePronunciation('  \n\t ')).toBe('')
  })

  it('preserves international text and embedded URL or file values', () => {
    expect(prepareVoicePronunciation('José Müller 東京 😀')).toBe('José Müller 東京 😀.')
    expect(prepareVoicePronunciation('https://example.com/6시 C:/6시/회의.txt')).toBe('https://example.com/6시 C:/6시/회의.txt.')
  })

  it('is idempotent and leaves the caller’s display text unchanged', () => {
    const original = '9월 16일 오후6시 이상승 연차'
    const spoken = prepareVoicePronunciation(original)
    expect(prepareVoicePronunciation(spoken)).toBe(spoken)
    expect(original).toBe('9월 16일 오후6시 이상승 연차')
  })
})
