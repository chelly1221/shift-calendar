import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { MPEGDecoder, type MPEGDecodedAudio } from 'mpg123-decoder'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeSpeechAudio } from './decodeSpeechAudio'

vi.mock('mpg123-decoder', () => ({ MPEGDecoder: vi.fn() }))

function audio(left: number[] = [0, 0.5, -0.5], right = left): MPEGDecodedAudio {
  return { channelData: [Float32Array.from(left), Float32Array.from(right)], samplesDecoded: left.length, sampleRate: 24000, errors: [] }
}
const decoders: { ready: Promise<void>; decode: ReturnType<typeof vi.fn>; free: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  vi.resetAllMocks()
  decoders.length = 0
  vi.mocked(MPEGDecoder).mockImplementation(function () {
    const decoder = { ready: Promise.resolve(), decode: vi.fn(() => audio()), free: vi.fn() }
    decoders.push(decoder)
    return decoder as unknown as MPEGDecoder
  })
})

describe('decodeSpeechAudio', () => {
  it('returns a correctly sized mono PCM16 WAV and releases decoder resources', async () => {
    const wav = await decodeSpeechAudio(new Uint8Array([1]))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt32LE(28)).toBe(48000)
    expect(wav.readUInt16LE(32)).toBe(2)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect([0, 1, 2].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 16384, -16383])
    expect(decoders[0].free).toHaveBeenCalledOnce()
  })

  it('downmixes stereo and clamps finite decoder peaks without integer overflow', async () => {
    const pending = decodeSpeechAudio(new Uint8Array([1]))
    decoders[0].decode.mockReturnValue(audio([1, -3, 0.25], [0, -1, 0.75]))
    const wav = await pending
    expect([0, 1, 2].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([16384, -32767, 16384])
  })

  it('bounds input before constructing WASM and never decodes an already cancelled reply', async () => {
    await expect(decodeSpeechAudio(new Uint8Array())).rejects.toThrow('크기')
    await expect(decodeSpeechAudio(new Uint8Array(1_048_577))).rejects.toThrow('크기')
    const abort = new AbortController()
    abort.abort()
    await expect(decodeSpeechAudio(new Uint8Array([1]), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(MPEGDecoder).not.toHaveBeenCalled()
  })

  it('feeds small blocks, preserves all decoded samples and yields for cancellation', async () => {
    const wav = await decodeSpeechAudio(new Uint8Array(9000))
    expect(decoders[0].decode.mock.calls.map((call) => (call[0] as Uint8Array).length)).toEqual([4096, 4096, 808])
    expect(wav.readUInt32LE(40)).toBe(18)
    const abort = new AbortController()
    const pending = decodeSpeechAudio(new Uint8Array(9000), abort.signal)
    decoders[1].decode.mockImplementationOnce(() => { abort.abort(); return audio() })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(decoders[1].decode).toHaveBeenCalledOnce()
    expect(decoders[1].free).toHaveBeenCalledOnce()
  })

  it('rejects damaged, empty, and entirely silent decoded replies', async () => {
    for (const decoded of [
      { ...audio(), errors: [{ message: 'broken frame', frameLength: 1, frameNumber: 0, inputBytes: 1, outputSamples: 0 }] },
      audio([], []), audio([0, 0]), audio([NaN, 0.5]),
    ]) {
      const pending = decodeSpeechAudio(new Uint8Array([1]))
      decoders[decoders.length - 1].decode.mockReturnValue(decoded)
      await expect(pending).rejects.toThrow()
      expect(decoders[decoders.length - 1].free).toHaveBeenCalledOnce()
    }
  })

  it('rejects invalid sample rates, channel sizes, and excessive decoded duration before allocating PCM', async () => {
    for (const decoded of [
      { ...audio(), sampleRate: 192000 },
      { ...audio(), samplesDecoded: Infinity },
      { ...audio(), samplesDecoded: 24000 * 90 + 1 },
      { ...audio(), channelData: [new Float32Array(1)] },
      { ...audio(), channelData: [new Float32Array(3), new Float32Array(3), new Float32Array(3)] },
    ]) {
      const pending = decodeSpeechAudio(new Uint8Array([1]))
      decoders[decoders.length - 1].decode.mockReturnValue(decoded)
      await expect(pending).rejects.toThrow()
      expect(decoders[decoders.length - 1].free).toHaveBeenCalledOnce()
    }
  })

  it('rejects a sample-rate change between decoded blocks instead of changing playback speed', async () => {
    const pending = decodeSpeechAudio(new Uint8Array(9000))
    decoders[0].decode.mockReturnValueOnce(audio()).mockReturnValueOnce({ ...audio(), sampleRate: 44100 })
    await expect(pending).rejects.toThrow('재생 형식')
    expect(decoders[0].free).toHaveBeenCalledOnce()
  })

  it('releases resources after decode exceptions and preserves initialization failure messages', async () => {
    const pending = decodeSpeechAudio(new Uint8Array([1]))
    decoders[0].decode.mockImplementation(() => { throw new Error('decode failed') })
    await expect(pending).rejects.toThrow('decode failed')
    expect(decoders[0].free).toHaveBeenCalledOnce()
    const free = vi.fn(() => { throw new Error('not initialized') })
    vi.mocked(MPEGDecoder).mockImplementationOnce(function () {
      return { ready: Promise.reject(new Error('WASM failed')), free } as unknown as MPEGDecoder
    })
    await expect(decodeSpeechAudio(new Uint8Array([1]))).rejects.toThrow('WASM failed')
    expect(free).toHaveBeenCalledOnce()
  })
})

const localSample = path.resolve('../.local-tools/google-translate-sample.mp3')
describe.skipIf(!existsSync(localSample))('locally captured Google MP3 integration', () => {
  it('decodes actual 24 kHz audio and every sample from two concatenated MP3 replies', async () => {
    const actual = await vi.importActual<typeof import('mpg123-decoder')>('mpg123-decoder')
    vi.mocked(MPEGDecoder).mockImplementation(function (options) { return new actual.MPEGDecoder(options) })
    const mp3 = await readFile(localSample)
    const single = await decodeSpeechAudio(mp3)
    const double = await decodeSpeechAudio(Buffer.concat([mp3, mp3]))
    expect(single.readUInt32LE(24)).toBe(24000)
    expect(single.readUInt32LE(40)).toBeGreaterThan(24000)
    expect(double.readUInt32LE(40)).toBe(single.readUInt32LE(40) * 2)
    expect(single.subarray(44).some((byte) => byte !== 0)).toBe(true)
    expect(double.length).toBeLessThan(1_000_000)
  })
})
