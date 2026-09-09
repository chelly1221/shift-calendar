import { prepareVoicePronunciation } from '../../shared/voicePronunciation'
import { decodeSpeechAudio } from './decodeSpeechAudio'

const MAX_TEXT_LENGTH = 160
const MAX_AUDIO_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const RATE_LIMIT_MESSAGE = '구글 번역 음성 요청이 잠시 제한되었습니다. 잠시 후 다시 읽어 주세요.'
class GoogleSpeechError extends Error {}
const aborted = () => Object.assign(new Error('음성 합성이 취소되었습니다.'), { name: 'AbortError' })

/** Leave room under the web reader's 200-character limit after pronunciation expansion. */
export function splitGoogleSpeech(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const characters = Array.from(line.trim())
    const result: string[] = []
    while (characters.length) {
      let end = 0
      let length = 0
      while (end < characters.length && length + characters[end].length <= MAX_TEXT_LENGTH) {
        length += characters[end++].length
      }
      if (end < characters.length) {
        for (let index = end - 1; index >= Math.floor(end / 2); index--) {
          if (/[\s,.!?;:]/u.test(characters[index])) { end = index + 1; break }
        }
      }
      const chunk = characters.splice(0, end).join('').trim()
      if (chunk) result.push(chunk)
    }
    return result
  })
}

/** Unofficial Google Translate web reader. No Cloud project, credentials, or saved answer audio. */
export class GoogleTranslateSpeech {
  private blockedUntil = 0

  constructor(private readonly request: typeof fetch = fetch,
    private readonly decode: typeof decodeSpeechAudio = decodeSpeechAudio) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw aborted()
    const chunks = splitGoogleSpeech(prepareVoicePronunciation(text))
    if (!chunks.length) throw new Error('읽을 내용이 없습니다.')
    if (Date.now() < this.blockedUntil) throw new GoogleSpeechError(RATE_LIMIT_MESSAGE)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)
    timer.unref()
    let decoding = false
    try {
      const audio: Buffer[] = []
      let total = 0
      for (const chunk of chunks) {
        if (controller.signal.aborted) throw aborted()
        const url = new URL('https://translate.google.com/translate_tts')
        url.search = new URLSearchParams({ ie: 'UTF-8', tl: 'ko', client: 'tw-ob', q: chunk }).toString()
        const response = await this.request(url, {
          signal: controller.signal, redirect: 'error', credentials: 'omit',
          headers: { Accept: 'audio/mpeg' },
        })
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 429) {
            const retry = response.headers.get('retry-after')
            const seconds = retry?.trim() && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN
            const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : retry ? Date.parse(retry) : NaN
            this.blockedUntil = Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60_000
            throw new GoogleSpeechError(RATE_LIMIT_MESSAGE)
          }
          throw new GoogleSpeechError(`구글 번역 음성을 사용할 수 없습니다 (HTTP ${response.status}). 잠시 후 다시 읽어 주세요.`)
        }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (!['audio/mpeg', 'audio/mp3'].includes(type ?? '') || !response.body) {
          await response.body?.cancel()
          throw new GoogleSpeechError('구글 번역에서 음성 데이터를 받지 못했습니다.')
        }
        const advertised = Number(response.headers.get('content-length'))
        if (advertised > MAX_AUDIO_BYTES - total) {
          await response.body.cancel()
          throw new GoogleSpeechError('구글 번역 음성 데이터가 너무 큽니다.')
        }
        const reader = response.body.getReader()
        let received = 0
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            received += value.byteLength
            if (total > MAX_AUDIO_BYTES) throw new GoogleSpeechError('구글 번역 음성 데이터가 너무 큽니다.')
            audio.push(Buffer.from(value))
          }
          if (controller.signal.aborted) throw aborted()
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        if (!received) throw new GoogleSpeechError('구글 번역에서 빈 음성을 받았습니다.')
      }
      if (controller.signal.aborted) throw aborted()
      decoding = true
      const wav = await this.decode(Buffer.concat(audio, total), controller.signal)
      if (controller.signal.aborted) throw aborted()
      return wav
    } catch (error) {
      if (signal?.aborted) throw aborted()
      if (timedOut) throw new Error('구글 번역 음성 응답 시간이 초과되었습니다. 다시 읽어 주세요.')
      if (error instanceof GoogleSpeechError) throw error
      // Fetch errors can include the URL (and answer text). Never expose them in UI/logs.
      throw new Error(decoding ? '구글 번역 음성을 재생 형식으로 변환하지 못했습니다.'
        : '구글 번역 음성에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
