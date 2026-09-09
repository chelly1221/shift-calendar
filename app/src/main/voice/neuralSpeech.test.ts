import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  readFile: vi.fn(),
  create: vi.fn(),
  runs: new Map<string, ReturnType<typeof vi.fn>>(),
  releases: [] as ReturnType<typeof vi.fn>[],
}))
vi.mock('node:fs/promises', () => ({ readFile: mock.readFile }))
vi.mock('onnxruntime-node', () => ({
  Tensor: class {
    dispose = vi.fn()
    constructor(readonly type: string, readonly data: Float32Array | BigInt64Array, readonly dims: number[]) {}
  },
  InferenceSession: { create: mock.create },
}))

import { Tensor } from 'onnxruntime-node'
import { encodeSpeechWav, NeuralSpeechSynthesizer, splitNeuralSpeech } from './neuralSpeech'

function result(name: string, values: number[], dims: number[] = [1]): Record<string, Tensor> {
  return { [name]: new Tensor('float32', new Float32Array(values), dims) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.runs.clear()
  mock.releases.length = 0
  const indexer = Array.from({ length: 65536 }, (_, index) => index)
  mock.readFile.mockImplementation(async (file: string) => {
    if (file.endsWith('tts.json')) return JSON.stringify({ ae: { sample_rate: 44100, base_chunk_size: 512 }, ttl: { latent_dim: 24, chunk_compress_factor: 6 } })
    if (file.endsWith('unicode_indexer.json')) return JSON.stringify(indexer)
    return JSON.stringify({ style_ttl: { dims: [1, 1, 1], data: [[[0.5]]] }, style_dp: { dims: [1, 1, 1], data: [[[0.5]]] } })
  })
  mock.create.mockImplementation(async (file: string) => {
    const run = vi.fn(async () => {
      if (file.includes('duration_predictor')) return result('duration', [0.0105])
      if (file.includes('text_encoder')) return result('text_emb', [0])
      if (file.includes('vector_estimator')) return result('denoised_latent', Array(144).fill(0), [1, 144, 1])
      return result('wav_tts', Array(512).fill(0.25), [1, 1, 512])
    })
    const release = vi.fn(async () => undefined)
    mock.runs.set(file.split(/[\\/]/u).pop() ?? '', run)
    mock.releases.push(release)
    return { run, release }
  })
})

describe('NeuralSpeechSynthesizer', () => {
  it('writes a playable mono PCM16 WAV and clamps invalid/out-of-range samples', () => {
    const wav = encodeSpeechWav(new Float32Array([-2, -0.5, 0, 0.5, 2, NaN]), 44100)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(44100)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(12)
    expect(Array.from({ length: 6 }, (_, i) => wav.readInt16LE(44 + i * 2))).toEqual([-32767, -16383, 0, 16384, 32767, 0])
  })

  it('bounds unpunctuated Korean text without dropping any characters', () => {
    const text = '가'.repeat(361)
    const chunks = splitNeuralSpeech(text)
    expect(chunks.map((chunk) => chunk.length)).toEqual([120, 120, 120, 1])
    expect(chunks.join('')).toBe(text)
  })

  it('preserves every list entry and respects line boundaries', () => {
    expect(splitNeuralSpeech('일근 김수헌\n\n주간 A조 윤태연 이명섭\n야간 B조 이상승\n')).toEqual(['일근 김수헌', '주간 A조 윤태연 이명섭', '야간 B조 이상승'])
  })

  it.each([
    ['일근 박혜지 윤형집', '일근 박혜지 윤형집.'],
    ['일반 장비 상태 확인', '일반 장비 상태 확인.'],
    ['박혜지, 윤형집. 교육: 안전 교육', '박혜지, 윤형집. 교육: 안전 교육.'],
    ['9월 16일 오전 9시 30분 시간차', '9월 16일 오전 9시 30분 시간차.'],
    ['2026-09-16 회의 14:30~15:00', '2026-09-16 회의 14:30~15:00.'],
    ['  일근\t 박혜지   윤형집  ', '일근 박혜지 윤형집.'],
  ])('preserves natural word spacing and explicit punctuation in model input: %s', async (text, expected) => {
    await new NeuralSpeechSynthesizer('models').synthesize(text)
    const inputs = mock.runs.get('duration_predictor.onnx')!.mock.calls[0][0] as { text_ids: Tensor }
    const tokens = inputs.text_ids.data as BigInt64Array
    const modelText = Array.from(tokens, (token) => String.fromCharCode(Number(token))).join('').normalize('NFC')
    expect(modelText).toBe(`<ko>${expected}</ko>`)
  })

  it('shares warmup and reuses loaded sessions for later requests', async () => {
    const speech = new NeuralSpeechSynthesizer('models')
    await Promise.all([speech.warmup(), speech.warmup()])
    const wav = await speech.synthesize('안녕하세요.')
    await speech.synthesize('반갑습니다.')
    expect(mock.create).toHaveBeenCalledTimes(4)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.length).toBeGreaterThan(800)
    expect(mock.runs.get('vector_estimator.onnx')).toHaveBeenCalledTimes(16)
  })

  it('releases partial initialization and can retry a failed warmup', async () => {
    const normalCreate = mock.create.getMockImplementation()
    mock.create.mockImplementationOnce(normalCreate!).mockRejectedValueOnce(new Error('load failure'))
    const speech = new NeuralSpeechSynthesizer('models')
    await expect(speech.warmup()).rejects.toThrow('load failure')
    expect(mock.releases[0]).toHaveBeenCalledOnce()
    await expect(speech.warmup()).resolves.toBeUndefined()
    expect(mock.create).toHaveBeenCalledTimes(6)
  })

  it('does not load models for an already cancelled request', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(new NeuralSpeechSynthesizer('models').synthesize('안녕', abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.readFile).not.toHaveBeenCalled()
  })

  it('stops between inference stages when cancelled and still handles the next request', async () => {
    const speech = new NeuralSpeechSynthesizer('models')
    await speech.warmup()
    const abort = new AbortController()
    mock.runs.get('duration_predictor.onnx')!.mockImplementationOnce(async () => { abort.abort(); return result('duration', [0.0105]) })
    await expect(speech.synthesize('취소', abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.runs.get('text_encoder.onnx')).not.toHaveBeenCalled()
    await expect(speech.synthesize('다음')).resolves.toBeInstanceOf(Buffer)
  })

  it('serializes simultaneous requests so their shared sessions never overlap', async () => {
    const speech = new NeuralSpeechSynthesizer('models')
    await speech.warmup()
    let resolveDuration: ((value: Record<string, Tensor>) => void) | undefined
    const duration = mock.runs.get('duration_predictor.onnx')!
    duration.mockImplementationOnce(() => new Promise<Record<string, Tensor>>((resolve) => { resolveDuration = resolve }))
    const first = speech.synthesize('첫 번째')
    const second = speech.synthesize('두 번째')
    await vi.waitFor(() => expect(resolveDuration).toBeTypeOf('function'))
    expect(duration).toHaveBeenCalledTimes(1)
    resolveDuration!(result('duration', [0.0105]))
    await Promise.all([first, second])
    expect(duration).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid duration predictions before allocating waveform tensors', async () => {
    const speech = new NeuralSpeechSynthesizer('models')
    await speech.warmup()
    mock.runs.get('duration_predictor.onnx')!.mockResolvedValueOnce(result('duration', [Infinity]))
    await expect(speech.synthesize('안녕')).rejects.toThrow('음성 길이')
    expect(mock.runs.get('vector_estimator.onnx')).not.toHaveBeenCalled()
  })

  it('rejects empty speech without loading models', async () => {
    await expect(new NeuralSpeechSynthesizer('models').synthesize(' \n ')).rejects.toThrow('읽을 내용')
    expect(mock.create).not.toHaveBeenCalled()
  })
})
