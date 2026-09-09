import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import { prepareVoicePronunciation } from '../../shared/voicePronunciation'
import { decodeSpeechAudio } from './decodeSpeechAudio'

const MAX_INPUT_BYTES = 128 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_AUDIO_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const CLIENT_VERSION = '143.0.3650.75'
// Public Edge reader client identifier; no account credentials are read or saved.
const CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const RATE_LIMIT_MESSAGE = 'Microsoft 음성 요청이 잠시 제한되었습니다. 잠시 후 다시 읽어 주세요.'
const INVALID_RESPONSE_MESSAGE = 'Microsoft에서 올바른 음성 데이터를 받지 못했습니다.'
class MicrosoftSpeechError extends Error {}
const aborted = () => Object.assign(new Error('음성 합성이 취소되었습니다.'), { name: 'AbortError' })
const ignoreSocketError = () => undefined

export type SpeechSocketFactory = (url: URL, options: ClientOptions) => WebSocket

function readerConnection(): { url: URL; options: ClientOptions } {
  const ticks = BigInt(Math.floor((Date.now() / 1000 + 11_644_473_600) / 300) * 300) * 10_000_000n
  const url = new URL('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1')
  url.search = new URLSearchParams({
    TrustedClientToken: CLIENT_TOKEN,
    ConnectionId: randomUUID().replace(/-/g, ''),
    'Sec-MS-GEC': createHash('sha256').update(ticks.toString() + CLIENT_TOKEN).digest('hex').toUpperCase(),
    'Sec-MS-GEC-Version': `1-${CLIENT_VERSION}`,
  }).toString()
  return { url, options: {
    handshakeTimeout: 10_000,
    maxPayload: MAX_AUDIO_BYTES,
    followRedirects: false,
    perMessageDeflate: false,
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      // Fresh anonymous connection identifier, never a browser/profile cookie.
      Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
    },
  } }
}

function speechMessage(text: string, requestId: string): string {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new MicrosoftSpeechError('읽을 내용이 너무 깁니다.')
  const xmlCharacters = Array.from(text).filter((character) => {
    const code = character.codePointAt(0)!
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000
  }).join('')
  const prepared = prepareVoicePronunciation(xmlCharacters)
  if (!prepared) throw new MicrosoftSpeechError('읽을 내용이 없습니다.')
  const escaped = prepared.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'><voice name='Microsoft Server Speech Text to Speech Voice (ko-KR, SunHiNeural)'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escaped}</prosody></voice></speak>`
  const message = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toUTCString()}Z\r\nPath:ssml\r\n\r\n${ssml}`
  // PcSpeechPlayback supplies short chunks. Reject oversized direct callers instead of truncating speech.
  if (Buffer.byteLength(message, 'utf8') >= MAX_MESSAGE_BYTES) throw new MicrosoftSpeechError('읽을 내용이 너무 깁니다. 나누어 읽어 주세요.')
  return message
}

function parseHeaders(bytes: Buffer): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of bytes.toString('utf8').split('\r\n')) {
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
    const key = line.slice(0, separator).trim().toLowerCase()
    if (headers.has(key)) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
    headers.set(key, line.slice(separator + 1).trim())
  }
  return headers
}

function asBuffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

/** Unofficial Microsoft Edge reader, fixed Korean SunHi voice. No Azure subscription or automatic retry. */
export class MicrosoftSpeech {
  private blockedUntil = 0

  constructor(private readonly connect: SpeechSocketFactory = (url, options) => new WebSocket(url, options),
    private readonly decode: typeof decodeSpeechAudio = decodeSpeechAudio) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw aborted()
    const requestId = randomUUID().replace(/-/g, '')
    const message = speechMessage(text, requestId)
    if (Date.now() < this.blockedUntil) throw new MicrosoftSpeechError(RATE_LIMIT_MESSAGE)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)
    timer.unref()
    let rejectInterruption: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = () => reject(aborted())
      controller.signal.addEventListener('abort', rejectInterruption, { once: true })
    })
    let decoding = false
    try {
      const work = async () => {
        const audio = await this.receiveSpeech(message, requestId, controller.signal)
        if (controller.signal.aborted) throw aborted()
        decoding = true
        const wav = await this.decode(audio, controller.signal)
        if (controller.signal.aborted) throw aborted()
        return wav
      }
      return await Promise.race([work(), interrupted])
    } catch (error) {
      if (signal?.aborted) throw aborted()
      if (timedOut) throw new Error('Microsoft 음성 응답 시간이 초과되었습니다. 다시 읽어 주세요.')
      if (error instanceof MicrosoftSpeechError) throw error
      // Upstream errors can contain URLs, headers or answer text. Keep them out of UI/logs.
      throw new Error(decoding ? 'Microsoft 음성을 재생 형식으로 변환하지 못했습니다.'
        : 'Microsoft 음성에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (rejectInterruption) controller.signal.removeEventListener('abort', rejectInterruption)
      controller.abort()
    }
  }

  private receiveSpeech(message: string, requestId: string, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const { url, options } = readerConnection()
      const socket = this.connect(url, options)
      const parts: Buffer[] = []
      let total = 0
      let receivedBytes = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        socket.off('open', onOpen).off('message', onMessage).off('close', onClose)
          .off('error', onError).off('unexpected-response', onResponse)
        // terminate() while connecting can emit error later; retain only a closure-free sink.
        socket.on('error', ignoreSocketError)
        try { socket.terminate() } catch { /* Already closed. */ }
        if (error) reject(error)
        else resolve(Buffer.concat(parts, total))
        parts.length = 0
      }
      const onAbort = () => finish(aborted())
      const onError = () => finish(new MicrosoftSpeechError('Microsoft 음성에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'))
      const onClose = () => finish(new MicrosoftSpeechError('Microsoft 음성이 끝나기 전에 연결이 끊어졌습니다. 다시 읽어 주세요.'))
      const onResponse = (request: ClientRequest, response: IncomingMessage) => {
        const status = response.statusCode
        if (status === 429) {
          const retry = response.headers['retry-after']?.trim()
          const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN
          const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : retry ? Date.parse(retry) : NaN
          this.blockedUntil = Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60_000
        }
        // Never retry 401/403, alter the clock, follow redirects, or change service hosts.
        finish(new MicrosoftSpeechError(status === 429 ? RATE_LIMIT_MESSAGE : status === 401 || status === 403
          ? `Microsoft 음성 접근이 거부되었습니다 (HTTP ${status}).`
          : `Microsoft 음성을 사용할 수 없습니다 (HTTP ${status ?? '알 수 없음'}).`))
        request.destroy()
        response.destroy()
      }
      const onOpen = () => {
        if (settled) return
        const config = { context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        } } } }
        try {
          socket.send(`X-Timestamp:${new Date().toUTCString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(config)}\r\n`, (error) => { if (error) onError() })
          if (!settled) socket.send(message, (error) => { if (error) onError() })
        } catch { onError() }
      }
      const onMessage = (raw: RawData, isBinary: boolean) => {
        if (settled) return
        try {
          const bytes = asBuffer(raw)
          receivedBytes += bytes.length
          if (bytes.length > MAX_AUDIO_BYTES || receivedBytes > MAX_AUDIO_BYTES) {
            throw new MicrosoftSpeechError('Microsoft 음성 데이터가 너무 큽니다.')
          }
          let headers: Map<string, string>
          let payload: Buffer
          if (isBinary) {
            if (bytes.length < 2) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
            const headerLength = bytes.readUInt16BE(0)
            if (headerLength + 2 > bytes.length) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
            headers = parseHeaders(bytes.subarray(2, headerLength + 2))
            payload = bytes.subarray(headerLength + 2)
          } else {
            const boundary = bytes.indexOf('\r\n\r\n')
            if (boundary < 0) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
            headers = parseHeaders(bytes.subarray(0, boundary))
            payload = bytes.subarray(boundary + 4)
          }
          const returnedRequest = headers.get('x-requestid')
          if (returnedRequest && returnedRequest.toLowerCase() !== requestId) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
          const path = headers.get('path')
          if (isBinary) {
            if (path !== 'audio') throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
            const type = headers.get('content-type')?.toLowerCase()
            // The service's empty final audio marker has no Content-Type. It is not turn.end.
            if (type === undefined && payload.length === 0) return
            if (type !== 'audio/mpeg' || !payload.length) throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
            total += payload.length
            parts.push(Buffer.from(payload))
          } else if (path === 'turn.end') {
            finish(total ? undefined : new MicrosoftSpeechError('Microsoft에서 빈 음성을 받았습니다.'))
          } else if (path !== 'turn.start' && path !== 'response' && path !== 'audio.metadata') {
            throw new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE)
          }
        } catch (error) {
          finish(error instanceof MicrosoftSpeechError ? error : new MicrosoftSpeechError(INVALID_RESPONSE_MESSAGE))
        }
      }
      socket.on('error', onError).on('close', onClose).on('unexpected-response', onResponse)
        .on('open', onOpen).on('message', onMessage)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
}
