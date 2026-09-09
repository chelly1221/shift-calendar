// Adapted from Supertone's MIT-licensed nodejs/helper.js (see THIRD_PARTY_VOICE.md).
// Modified for bounded Korean synthesis, cancellation, and reusable CPU sessions.
import { readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import path from 'node:path'
import * as ort from 'onnxruntime-node'

interface ModelConfig {
  ae: { sample_rate: number; base_chunk_size: number }
  ttl: { latent_dim: number; chunk_compress_factor: number }
}
interface StyleValue { dims: number[]; data: number[][][] }
interface VoiceStyle { style_ttl: StyleValue; style_dp: StyleValue }
interface Components {
  config: ModelConfig
  indexer: number[]
  styleTtl: ort.Tensor
  styleDp: ort.Tensor
  duration: ort.InferenceSession
  encoder: ort.InferenceSession
  estimator: ort.InferenceSession
  vocoder: ort.InferenceSession
}

// Give Korean names and short list entries more synthesis detail and speaking time.
const STEPS = 8
const SPEED = 0.90

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('음성 합성이 취소되었습니다.')
    error.name = 'AbortError'
    throw error
  }
}

export function splitNeuralSpeech(text: string): string[] {
  const chunks: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    let characters = Array.from(line.trim())
    while (characters.length > 0) {
      let end = Math.min(120, characters.length)
      if (characters.length > end) {
        for (let index = end - 1; index >= 60; index--) {
          if (/[\s.!?;,]/u.test(characters[index])) { end = index + 1; break }
        }
      }
      const chunk = characters.slice(0, end).join('').trim()
      if (chunk) chunks.push(chunk)
      characters = characters.slice(end)
    }
  }
  return chunks
}

function prepareKoreanText(text: string): string {
  let prepared = text.normalize('NFKD')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/[–‑—]/gu, '-')
    .replace(/[_[\]|/#→←]/gu, ' ')
    .replace(/[♥☆♡©\\]/gu, '')
    .replace(/[“”]/gu, '"')
    .replace(/[‘’´`]/gu, "'")
    .replace(/\s+/gu, ' ').trim()
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/u.test(prepared)) prepared += '.'
  return `<ko>${prepared}</ko>`
}

function floatTensor(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor('float32', data, dims)
}

function floatOutput(tensor: ort.Tensor | undefined, name: string): Float32Array {
  if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error(`Invalid speech model output: ${name}`)
  return tensor.data
}

export function encodeSpeechWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index++) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
  }
  return buffer
}

export class NeuralSpeechSynthesizer {
  private components: Components | null = null
  private initialization: Promise<void> | null = null
  private inferenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly modelDirectory: string) {}

  warmup(): Promise<void> {
    if (this.components) return Promise.resolve()
    if (this.initialization) return this.initialization
    this.initialization = this.load().finally(() => { this.initialization = null })
    return this.initialization
  }

  private async load(): Promise<void> {
    const onnxDirectory = path.join(this.modelDirectory, 'onnx')
    const [configuration, indexerJson, styleJson] = await Promise.all([
      readFile(path.join(onnxDirectory, 'tts.json'), 'utf8'),
      readFile(path.join(onnxDirectory, 'unicode_indexer.json'), 'utf8'),
      readFile(path.join(this.modelDirectory, 'voice_styles', 'F1.json'), 'utf8'),
    ])
    const config = JSON.parse(configuration) as ModelConfig
    const indexer = JSON.parse(indexerJson) as number[]
    const style = JSON.parse(styleJson) as VoiceStyle
    if (config.ae.sample_rate !== 44100 || config.ae.base_chunk_size !== 512 || config.ttl.latent_dim !== 24 || config.ttl.chunk_compress_factor !== 6) {
      throw new Error('지원하지 않는 음성 모델 구성입니다.')
    }
    const styleTtl = floatTensor(Float32Array.from(style.style_ttl.data.flat(2)), style.style_ttl.dims)
    const styleDp = floatTensor(Float32Array.from(style.style_dp.data.flat(2)), style.style_dp.dims)
    const created: ort.InferenceSession[] = []
    try {
      // Sequential initialization reduces the memory peak during model optimization.
      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.max(1, Math.min(4, cpus().length)),
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      }
      for (const file of ['duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx']) {
        created.push(await ort.InferenceSession.create(path.join(onnxDirectory, file), options))
      }
      this.components = { config, indexer, styleTtl, styleDp, duration: created[0], encoder: created[1], estimator: created[2], vocoder: created[3] }
    } catch (error) {
      await Promise.allSettled(created.map((session) => session.release()))
      styleTtl.dispose()
      styleDp.dispose()
      throw error
    }
  }

  synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const result = this.inferenceTail.then(() => this.synthesizeNext(text, signal))
    // A cancelled or failed request must release the next queued request.
    this.inferenceTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async synthesizeNext(text: string, signal?: AbortSignal): Promise<Buffer> {
    checkAbort(signal)
    const chunks = splitNeuralSpeech(text)
    if (chunks.length === 0) throw new Error('읽을 내용이 없습니다.')
    await this.warmup()
    checkAbort(signal)
    const components = this.components
    if (!components) throw new Error('음성 모델을 불러오지 못했습니다.')
    const samples: Float32Array[] = []
    let total = 0
    for (const chunk of chunks) {
      checkAbort(signal)
      const audio = await this.infer(chunk, components, signal)
      if (samples.length > 0) {
        const silence = new Float32Array(Math.round(components.config.ae.sample_rate * 0.18))
        samples.push(silence)
        total += silence.length
      }
      samples.push(audio)
      total += audio.length
    }
    checkAbort(signal)
    const joined = new Float32Array(total)
    let offset = 0
    for (const sample of samples) { joined.set(sample, offset); offset += sample.length }
    return encodeSpeechWav(joined, components.config.ae.sample_rate)
  }

  private async infer(text: string, model: Components, signal?: AbortSignal): Promise<Float32Array> {
    const tensors = new Set<ort.Tensor>()
    const keep = (tensor: ort.Tensor): ort.Tensor => { tensors.add(tensor); return tensor }
    const run = async (session: ort.InferenceSession, inputs: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>> => {
      checkAbort(signal)
      const outputs = await session.run(inputs)
      for (const tensor of Object.values(outputs)) keep(tensor)
      checkAbort(signal)
      return outputs
    }
    try {
      const prepared = prepareKoreanText(text)
      const ids = BigInt64Array.from(Array.from(prepared, (character) => {
        const id = model.indexer[character.charCodeAt(0)]
        if (!Number.isSafeInteger(id) || id < 0) throw new Error('음성 모델이 읽을 수 없는 문자가 있습니다.')
        return BigInt(id)
      }))
      const textIds = keep(new ort.Tensor('int64', ids, [1, ids.length]))
      const textMask = keep(floatTensor(new Float32Array(ids.length).fill(1), [1, 1, ids.length]))
      const durations = await run(model.duration, { text_ids: textIds, style_dp: model.styleDp, text_mask: textMask })
      const duration = floatOutput(durations.duration, 'duration')[0] / SPEED
      // A corrupt prediction must not allocate arbitrary amounts of memory.
      if (!Number.isFinite(duration) || duration <= 0 || duration > 90) throw new Error('음성 길이를 계산하지 못했습니다.')
      const textEncoded = await run(model.encoder, { text_ids: textIds, style_ttl: model.styleTtl, text_mask: textMask })
      const sampleRate = model.config.ae.sample_rate
      const sampleLength = Math.floor(duration * sampleRate)
      const chunkSize = model.config.ae.base_chunk_size * model.config.ttl.chunk_compress_factor
      const latentLength = Math.floor((duration * sampleRate + chunkSize - 1) / chunkSize)
      const maskedLength = Math.floor((sampleLength + chunkSize - 1) / chunkSize)
      const dimensions = model.config.ttl.latent_dim * model.config.ttl.chunk_compress_factor
      let latent = new Float32Array(dimensions * latentLength)
      for (let index = 0; index < latent.length; index++) {
        const u1 = Math.max(1e-10, Math.random())
        latent[index] = index % latentLength < maskedLength ? Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random()) : 0
      }
      const latentMaskData = new Float32Array(latentLength)
      latentMaskData.fill(1, 0, maskedLength)
      const latentMask = keep(floatTensor(latentMaskData, [1, 1, latentLength]))
      const totalStep = keep(floatTensor(new Float32Array([STEPS]), [1]))
      for (let step = 0; step < STEPS; step++) {
        const noisyLatent = keep(floatTensor(latent, [1, dimensions, latentLength]))
        const currentStep = keep(floatTensor(new Float32Array([step]), [1]))
        const estimated = await run(model.estimator, {
          noisy_latent: noisyLatent, text_emb: textEncoded.text_emb,
          style_ttl: model.styleTtl, text_mask: textMask, latent_mask: latentMask,
          total_step: totalStep, current_step: currentStep,
        })
        latent = Float32Array.from(floatOutput(estimated.denoised_latent, 'denoised_latent'))
        for (const tensor of [noisyLatent, currentStep, ...Object.values(estimated)]) {
          tensors.delete(tensor)
          tensor.dispose()
        }
      }
      const decoded = await run(model.vocoder, { latent: keep(floatTensor(latent, [1, dimensions, latentLength])) })
      return floatOutput(decoded.wav_tts, 'wav_tts').slice(0, sampleLength)
    } finally {
      for (const tensor of tensors) tensor.dispose()
    }
  }
}
