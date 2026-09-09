import { setImmediate } from 'node:timers/promises'
import { MPEGDecoder } from 'mpg123-decoder'

const MAX_MP3_BYTES = 1_048_576
const MAX_SECONDS = 90
const MAX_PCM_BYTES = 48_000 * MAX_SECONDS * 2
const INPUT_BLOCK_BYTES = 4096
const SAMPLE_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('음성 변환이 취소되었습니다.'), { name: 'AbortError' })
}

/** Decode bounded MP3 replies locally. No ONNX/native codec or file-system audio temporary is needed. */
export async function decodeSpeechAudio(mp3: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal)
  if (mp3.length === 0 || mp3.length > MAX_MP3_BYTES) throw new Error('음성 응답 크기가 올바르지 않습니다.')
  const decoder = new MPEGDecoder()
  let ready = false
  try {
    await decoder.ready
    ready = true
    checkAbort(signal)
    const blocks: Buffer[] = []
    let sampleRate = 0
    let sampleCount = 0
    let audible = false
    // A small feed bounds temporary Float32 allocations even for low-bitrate or malformed input.
    for (let offset = 0; offset < mp3.length; offset += INPUT_BLOCK_BYTES) {
      checkAbort(signal)
      const decoded = decoder.decode(mp3.subarray(offset, offset + INPUT_BLOCK_BYTES))
      if (decoded.errors.length) throw new Error('손상된 음성 응답을 받았습니다.')
      if (!Number.isSafeInteger(decoded.samplesDecoded) || decoded.samplesDecoded < 0) throw new Error('음성 샘플 수가 올바르지 않습니다.')
      if (decoded.samplesDecoded > 0) {
        if (!SAMPLE_RATES.has(decoded.sampleRate) || (sampleRate !== 0 && sampleRate !== decoded.sampleRate)) {
          throw new Error('음성 응답의 재생 형식이 올바르지 않습니다.')
        }
        sampleRate = decoded.sampleRate
        sampleCount += decoded.samplesDecoded
        if (sampleCount > sampleRate * MAX_SECONDS || sampleCount * 2 > MAX_PCM_BYTES) throw new Error('음성 응답이 너무 깁니다.')
        if (decoded.channelData.length < 1 || decoded.channelData.length > 2 ||
          decoded.channelData.some((channel) => !(channel instanceof Float32Array) || channel.length !== decoded.samplesDecoded)) {
          throw new Error('음성 채널 정보가 올바르지 않습니다.')
        }
        const block = Buffer.allocUnsafe(decoded.samplesDecoded * 2)
        for (let index = 0; index < decoded.samplesDecoded; index++) {
          let sample = 0
          for (const channel of decoded.channelData) {
            if (!Number.isFinite(channel[index])) throw new Error('손상된 음성 샘플을 받았습니다.')
            sample += channel[index] / decoded.channelData.length
          }
          const pcm = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
          if (pcm !== 0) audible = true
          block.writeInt16LE(pcm, index * 2)
        }
        blocks.push(block)
      }
      // Let cancellation, HTTP requests and PC playback progress run between decode blocks.
      if (offset + INPUT_BLOCK_BYTES < mp3.length) await setImmediate()
    }
    checkAbort(signal)
    if (sampleCount === 0 || !audible) throw new Error('음성 응답에 읽을 소리가 없습니다.')
    const bytes = sampleCount * 2
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + bytes, 4)
    header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(bytes, 40)
    return Buffer.concat([header, ...blocks], 44 + bytes)
  } finally {
    // A failed WASM initialization may not have a complete decoder to destroy.
    if (ready) decoder.free()
    else { try { decoder.free() } catch { /* Preserve the original initialization failure. */ } }
  }
}
