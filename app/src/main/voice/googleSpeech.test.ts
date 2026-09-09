import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareVoicePronunciation } from '../../shared/voicePronunciation'
import { GoogleTranslateSpeech, splitGoogleSpeech } from './googleSpeech'
import type { decodeSpeechAudio } from './decodeSpeechAudio'

const mp3 = Uint8Array.from([255, 243, 132, 196, 0, 1, 2])
const wav = Buffer.from('decoded WAV')
const request = vi.fn<typeof fetch>()
const decode = vi.fn<typeof decodeSpeechAudio>()
const reply = () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })

beforeEach(() => {
  vi.resetAllMocks()
  request.mockImplementation(async () => reply())
  decode.mockResolvedValue(wav)
})
afterEach(() => vi.useRealTimers())

describe('Google Translate web speech', () => {
  it('uses the public Korean reader with encoded pronunciation text and returns decoded WAV', async () => {
    const text = '일근 박혜지 윤형집 오후 6시 & 확인'
    expect(await new GoogleTranslateSpeech(request, decode).synthesize(text)).toBe(wav)
    const url = new URL(String(request.mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe('https://translate.google.com/translate_tts')
    expect(url.searchParams.get('tl')).toBe('ko')
    expect(url.searchParams.get('client')).toBe('tw-ob')
    expect(url.searchParams.get('q')).toBe('일근 박혜지 윤형집 오후 여섯 시 & 확인.')
    expect(url.searchParams.get('q')).toContain('오후 여섯 시')
    expect(url.searchParams.get('q')).not.toContain(',')
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
    expect(decode).toHaveBeenCalledWith(Buffer.from(mp3), expect.any(AbortSignal))
    expect(text).toBe('일근 박혜지 윤형집 오후 6시 & 확인')
  })

  it('splits expanded long speech sequentially without dropping the final words', async () => {
    const text = '오후 6시 박혜지 윤형집 '.repeat(30)
    const expected = splitGoogleSpeech(prepareVoicePronunciation(text))
    await new GoogleTranslateSpeech(request, decode).synthesize(text)
    const sent = request.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('q')!)
    expect(sent).toEqual(expected)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every((chunk) => chunk.length <= 160)).toBe(true)
    expect(sent.join('').replace(/\s/gu, '')).toBe(prepareVoicePronunciation(text).replace(/\s/gu, ''))
    expect(decode.mock.calls[0][0]).toEqual(Buffer.concat(sent.map(() => Buffer.from(mp3))))
  })

  it('preserves Unicode code points at the web request limit', () => {
    const text = '가나다😀'.repeat(100)
    const chunks = splitGoogleSpeech(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 160 && !chunk.includes('\ufffd'))).toBe(true)
  })

  it('does not request empty or already cancelled speech', async () => {
    const speech = new GoogleTranslateSpeech(request, decode)
    await expect(speech.synthesize(' \n ')).rejects.toThrow('읽을 내용')
    const controller = new AbortController()
    controller.abort()
    await expect(speech.synthesize('취소', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('aborts an in-flight request and can immediately handle the next answer', async () => {
    request.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted request')), { once: true })
    }))
    const controller = new AbortController()
    const speech = new GoogleTranslateSpeech(request, decode)
    const pending = expect(speech.synthesize('취소할 답변', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await pending
    expect(decode).not.toHaveBeenCalled()
    expect(await speech.synthesize('다음 답변')).toBe(wav)
  })

  it('ignores audio decoded after cancellation', async () => {
    const controller = new AbortController()
    decode.mockImplementationOnce(async () => { controller.abort(); return wav })
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('취소', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds a stalled network request and does not expose answer URLs in errors', async () => {
    vi.useFakeTimers()
    request.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('private URL')), { once: true })
    }))
    const pending = expect(new GoogleTranslateSpeech(request, decode).synthesize('시험')).rejects.toThrow('응답 시간이 초과')
    await vi.advanceTimersByTimeAsync(20_000)
    await pending
    expect(decode).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    request.mockRejectedValueOnce(new Error('https://translate.google.com/?q=private-answer'))
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('시험')).rejects.toThrow('인터넷 연결을 확인')
  })

  it('honors rate-limit cooldown without retries or contacting alternate hosts', async () => {
    vi.useFakeTimers()
    request.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '60' } }))
    const speech = new GoogleTranslateSpeech(request, decode)
    await expect(speech.synthesize('첫 답변')).rejects.toThrow('요청이 잠시 제한')
    await expect(speech.synthesize('다음 답변')).rejects.toThrow('요청이 잠시 제한')
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await speech.synthesize('다시 읽기')).toBe(wav)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([403, 500, 503])('reports HTTP %s without trying to decode or silently changing engines', async (status) => {
    request.mockResolvedValueOnce(new Response('unavailable', { status }))
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('답변')).rejects.toThrow(`HTTP ${status}`)
    expect(request).toHaveBeenCalledTimes(1)
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not accept a non-audio page or an empty body as a successful answer', async () => {
    request.mockResolvedValueOnce(new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } }))
    const speech = new GoogleTranslateSpeech(request, decode)
    await expect(speech.synthesize('답변')).rejects.toThrow('음성 데이터를 받지 못')
    request.mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'audio/mpeg' } }))
    await expect(speech.synthesize('답변')).rejects.toThrow('빈 음성')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([true, false])('rejects oversized audio, including missing content-length (%s)', async (advertised) => {
    request.mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1), {
      headers: { 'content-type': 'audio/mpeg', ...(advertised ? { 'content-length': String(1024 * 1024 + 1) } : {}) },
    }))
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('답변')).rejects.toThrow('데이터가 너무 큽니다')
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not return a partial answer when a later upstream chunk fails', async () => {
    request.mockImplementationOnce(async () => reply()).mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('긴 답변 '.repeat(70))).rejects.toThrow('HTTP 503')
    expect(request).toHaveBeenCalledTimes(2)
    expect(decode).not.toHaveBeenCalled()
  })

  it('reports corrupted MP3 instead of returning success', async () => {
    decode.mockRejectedValueOnce(new Error('malformed frame'))
    await expect(new GoogleTranslateSpeech(request, decode).synthesize('답변')).rejects.toThrow('재생 형식으로 변환하지 못')
  })
})
