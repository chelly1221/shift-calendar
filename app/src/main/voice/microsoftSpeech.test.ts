import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftSpeech, type SpeechSocketFactory } from './microsoftSpeech'
import type { decodeSpeechAudio } from './decodeSpeechAudio'

const mp3 = Buffer.from([255, 243, 132, 196, 0, 1, 2])
const tail = Buffer.from([3, 4, 5, 6])
const wav = Buffer.from('decoded WAV')
const decode = vi.fn<typeof decodeSpeechAudio>()

function binary(headers: string, data = Buffer.alloc(0)): Buffer {
  const encoded = Buffer.from(headers)
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(encoded.length)
  return Buffer.concat([prefix, encoded, data])
}

class FakeSocket extends EventEmitter {
  send = vi.fn((_message: string, callback?: (error?: Error) => void) => callback?.())
  terminate = vi.fn()
  audio(data = mp3) { this.emit('message', binary('Path:audio\r\nContent-Type:audio/mpeg\r\n', data), true) }
  text(path: string) { this.emit('message', Buffer.from(`Path:${path}\r\n\r\n`), false) }
  complete() { this.audio(); this.text('turn.end') }
}

const sockets: FakeSocket[] = []
const connect = vi.fn<SpeechSocketFactory>()
let onConnection: ((socket: FakeSocket) => void) | undefined

beforeEach(() => {
  vi.resetAllMocks()
  sockets.length = 0
  decode.mockResolvedValue(wav)
  onConnection = (socket) => { socket.emit('open'); socket.complete() }
  connect.mockImplementation(() => {
    const socket = new FakeSocket()
    sockets.push(socket)
    queueMicrotask(() => onConnection?.(socket))
    return socket as unknown as WebSocket
  })
})
afterEach(() => vi.useRealTimers())

describe('Microsoft SunHi speech', () => {
  it('sends Korean SunHi at its normal tempo with escaped pronunciation text', async () => {
    const original = '일근 박혜지 윤형집 오후 6시 <확인> & "교육" \'회의\'\u0001😀'
    expect(await new MicrosoftSpeech(connect, decode).synthesize(original)).toBe(wav)
    const [url, options] = connect.mock.calls[0]
    expect(url.origin + url.pathname).toBe('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1')
    expect(url.searchParams.get('Sec-MS-GEC')).toMatch(/^[A-F0-9]{64}$/)
    expect(options).toMatchObject({ followRedirects: false, maxPayload: 1024 * 1024, handshakeTimeout: 10_000 })
    const messages = sockets[0].send.mock.calls.map(([message]) => message)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('audio-24khz-48kbitrate-mono-mp3')
    expect(messages[1]).toContain('ko-KR, SunHiNeural')
    expect(messages[1]).toContain("pitch='+0Hz' rate='+0%'")
    expect(messages[1]).toContain('일근 박혜지 윤형집 오후 여섯 시 &lt;확인&gt; &amp; &quot;교육&quot; &apos;회의&apos;😀.')
    expect(messages[1]).not.toContain('\u0001')
    expect(decode).toHaveBeenCalledWith(mp3, expect.any(AbortSignal))
    expect(original).toContain('오후 6시')
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
  })

  it('keeps every word of a long direct input below the message limit', async () => {
    const text = '박혜지 윤형집 '.repeat(600) + '마지막 이름'
    await new MicrosoftSpeech(connect, decode).synthesize(text)
    expect(sockets[0].send.mock.calls[1][0]).toContain(`${text}.`)
    expect(connect).toHaveBeenCalledOnce()
  })

  it.each(['가'.repeat(128 * 1024), '&'.repeat(15_000)])('rejects oversized input or expanded SSML instead of truncating', async (text) => {
    await expect(new MicrosoftSpeech(connect, decode).synthesize(text)).rejects.toThrow('너무 깁니다')
    expect(connect).not.toHaveBeenCalled()
  })

  it('does not contact Microsoft for empty, invalid-only or already cancelled input', async () => {
    const speech = new MicrosoftSpeech(connect, decode)
    for (const text of [' \n ', '\u0000\ud800\ufffe']) await expect(speech.synthesize(text)).rejects.toThrow('읽을 내용')
    const controller = new AbortController()
    controller.abort()
    await expect(speech.synthesize('취소', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('waits for turn.end after the empty marker and decodes the final audio in order', async () => {
    onConnection = undefined
    const result = new MicrosoftSpeech(connect, decode).synthesize('끝까지 읽기')
    const socket = sockets[0]
    socket.emit('open')
    socket.text('turn.start')
    socket.audio()
    socket.text('audio.metadata')
    socket.audio(tail)
    socket.emit('message', binary('Path:audio\r\n'), true)
    await Promise.resolve()
    expect(decode).not.toHaveBeenCalled()
    socket.text('turn.end')
    expect(await result).toBe(wav)
    expect(decode.mock.calls[0][0]).toEqual(Buffer.concat([mp3, tail]))
    expect(socket.listenerCount('message')).toBe(0)
  })

  it('rejects partial speech if the connection closes before turn.end', async () => {
    onConnection = (socket) => { socket.audio(); socket.emit('close', 1000, Buffer.alloc(0)) }
    await expect(new MicrosoftSpeech(connect, decode).synthesize('긴 답변')).rejects.toThrow('끝나기 전에')
    expect(decode).not.toHaveBeenCalled()
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
  })

  it('rejects an empty successful turn', async () => {
    onConnection = (socket) => { socket.emit('message', binary('Path:audio\r\n'), true); socket.text('turn.end') }
    await expect(new MicrosoftSpeech(connect, decode).synthesize('답변')).rejects.toThrow('빈 음성')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([
    ['missing header length', Buffer.from([0]), true],
    ['truncated header', Buffer.from([0, 10, 65]), true],
    ['wrong path', binary('Path:other\r\nContent-Type:audio/mpeg\r\n', mp3), true],
    ['missing type with data', binary('Path:audio\r\n', mp3), true],
    ['empty audio with type', binary('Path:audio\r\nContent-Type:audio/mpeg\r\n'), true],
    ['wrong type', binary('Path:audio\r\nContent-Type:text/html\r\n', mp3), true],
    ['duplicate path', binary('Path:audio\r\nPath:other\r\nContent-Type:audio/mpeg\r\n', mp3), true],
    ['different request', binary('Path:audio\r\nX-RequestId:wrong\r\nContent-Type:audio/mpeg\r\n', mp3), true],
    ['malformed text', Buffer.from('Path:turn.end'), false],
    ['unknown text path', Buffer.from('Path:failure\r\n\r\nprivate answer'), false],
  ] as const)('rejects %s without decoding partial audio', async (_label, frame, isBinary) => {
    onConnection = (socket) => { socket.audio(); socket.emit('message', frame, isBinary) }
    await expect(new MicrosoftSpeech(connect, decode).synthesize('답변')).rejects.toThrow('올바른 음성 데이터')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([false, true])('bounds a single frame and accumulated response bytes (%s)', async (manyFrames) => {
    onConnection = (socket) => {
      if (manyFrames) for (let index = 0; index < 3; index++) socket.audio(Buffer.alloc(400_000, 1))
      else socket.audio(Buffer.alloc(1024 * 1024, 1))
    }
    await expect(new MicrosoftSpeech(connect, decode).synthesize('답변')).rejects.toThrow('데이터가 너무 큽니다')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each(['connecting', 'receiving'])('cancels while %s, ignores late frames and accepts the next question', async (stage) => {
    onConnection = undefined
    const speech = new MicrosoftSpeech(connect, decode)
    const controller = new AbortController()
    const pending = expect(speech.synthesize('취소', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const socket = sockets[0]
    if (stage === 'receiving') { socket.emit('open'); socket.audio() }
    controller.abort()
    await pending
    socket.emit('error', new Error('late private error'))
    socket.complete()
    expect(decode).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledOnce()
    onConnection = (next) => { next.emit('open'); next.complete() }
    expect(await speech.synthesize('다음 질문')).toBe(wav)
  })

  it('rejects immediately during decoding and ignores a late decoded result', async () => {
    let release: ((buffer: Buffer) => void) | undefined
    let began: (() => void) | undefined
    const started = new Promise<void>((resolve) => { began = resolve })
    decode.mockImplementationOnce(() => { began?.(); return new Promise((resolve) => { release = resolve }) })
    const controller = new AbortController()
    const pending = expect(new MicrosoftSpeech(connect, decode).synthesize('취소', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await pending
    expect(decode.mock.calls[0][1]?.aborted).toBe(true)
    release?.(wav)
    await Promise.resolve()
  })

  it.each(['connecting', 'receiving', 'decoding'])('enforces the total deadline during %s and clears timers', async (stage) => {
    vi.useFakeTimers()
    onConnection = stage === 'decoding' ? (socket) => socket.complete() : undefined
    if (stage === 'decoding') decode.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = expect(new MicrosoftSpeech(connect, decode).synthesize('멈춘 답변')).rejects.toThrow('응답 시간이 초과')
    if (stage === 'receiving') { sockets[0].emit('open'); sockets[0].audio() }
    await vi.advanceTimersByTimeAsync(20_000)
    await pending
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    if (stage === 'decoding') expect(decode.mock.calls[0][1]?.aborted).toBe(true)
  })

  it.each(['60', undefined, 'invalid', 'Wed, 01 Jan 2025 00:02:00 GMT'])('honors 429 cooldown and Retry-After (%s) without retrying', async (retry) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    const requestDestroy = vi.fn()
    const responseDestroy = vi.fn()
    onConnection = (socket) => socket.emit('unexpected-response', { destroy: requestDestroy }, {
      statusCode: 429, headers: { 'retry-after': retry }, destroy: responseDestroy,
    })
    const speech = new MicrosoftSpeech(connect, decode)
    await expect(speech.synthesize('첫 답변')).rejects.toThrow('요청이 잠시 제한')
    await expect(speech.synthesize('다음 답변')).rejects.toThrow('요청이 잠시 제한')
    expect(connect).toHaveBeenCalledOnce()
    expect(requestDestroy).toHaveBeenCalledOnce()
    expect(responseDestroy).toHaveBeenCalledOnce()
    const delay = retry?.startsWith('Wed') ? 120_000 : 60_000
    await vi.advanceTimersByTimeAsync(delay)
    onConnection = (socket) => socket.complete()
    expect(await speech.synthesize('다시 읽기')).toBe(wav)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 302, 500])('fails HTTP %s without changing headers, hosts or retrying', async (statusCode) => {
    onConnection = (socket) => socket.emit('unexpected-response', { destroy: vi.fn() }, { statusCode, headers: {}, destroy: vi.fn() })
    await expect(new MicrosoftSpeech(connect, decode).synthesize('답변')).rejects.toThrow(`HTTP ${statusCode}`)
    expect(connect).toHaveBeenCalledOnce()
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not expose upstream error messages or corrupt audio to the caller', async () => {
    connect.mockImplementationOnce(() => { throw new Error('wss://private-answer-and-cookie') })
    const speech = new MicrosoftSpeech(connect, decode)
    await expect(speech.synthesize('답변')).rejects.toThrow('인터넷 연결을 확인')
    onConnection = (socket) => socket.emit('error', new Error('private answer'))
    await expect(speech.synthesize('답변')).rejects.toThrow('인터넷 연결을 확인')
    onConnection = (socket) => socket.complete()
    decode.mockRejectedValueOnce(new Error('private audio metadata'))
    await expect(speech.synthesize('답변')).rejects.toThrow('재생 형식으로 변환하지 못')
  })

  it('handles a send callback failure and releases the socket', async () => {
    onConnection = (socket) => {
      socket.send.mockImplementationOnce((_message, callback) => callback?.(new Error('private send error')))
      socket.emit('open')
    }
    await expect(new MicrosoftSpeech(connect, decode).synthesize('답변')).rejects.toThrow('인터넷 연결을 확인')
    expect(sockets[0].send).toHaveBeenCalledOnce()
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
  })
})
