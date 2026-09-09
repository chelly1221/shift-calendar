import { Worker } from 'node:worker_threads'

export type NeuralSpeechRequest =
  | { type: 'warmup'; id: number }
  | { type: 'synthesize'; id: number; text: string }
  | { type: 'cancel'; id: number }
export type NeuralSpeechResponse =
  | { type: 'ready'; id: number }
  | { type: 'audio'; id: number; audio: Uint8Array }
  | { type: 'error'; id: number; message: string; name: string }

interface Request {
  message: Exclude<NeuralSpeechRequest, { type: 'cancel' }>
  resolve: (audio?: Buffer) => void
  reject: (error: Error) => void
  settled: boolean
  signal?: AbortSignal
  abort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

const aborted = (): Error => Object.assign(new Error('음성 합성이 취소되었습니다.'), { name: 'AbortError' })

/** ONNX performs synchronous native calls, so even its Promise API must run off the main thread. */
export class NeuralSpeechClient {
  private worker: Worker | null = null
  private active: Request | null = null
  private readonly queue: Request[] = []
  private sequence = 0
  private ready = false
  private warming: Promise<void> | null = null
  private closed = false

  constructor(private readonly workerPath: string, private readonly modelDirectory: string) {}

  warmup(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('PC 음성 합성이 종료되었습니다.'))
    if (this.ready) return Promise.resolve()
    if (this.warming) return this.warming
    const warming = this.request({ type: 'warmup', id: ++this.sequence }).then(() => undefined)
    this.warming = warming
    void warming.then(() => { if (this.warming === warming) this.warming = null }, () => {
      if (this.warming === warming) this.warming = null
    })
    return warming
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw aborted()
    const audio = await this.request({ type: 'synthesize', id: ++this.sequence, text }, signal)
    if (!audio) throw new Error('음성 합성 결과가 없습니다.')
    return audio
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.reset(new Error('PC 음성 합성이 종료되었습니다.'))
  }

  private request(message: Request['message'], signal?: AbortSignal): Promise<Buffer | undefined> {
    if (this.closed) return Promise.reject(new Error('PC 음성 합성이 종료되었습니다.'))
    if (signal?.aborted) return Promise.reject(aborted())
    return new Promise<Buffer | undefined>((resolve, reject) => {
      const request: Request = { message, resolve, reject, signal, settled: false }
      if (signal) {
        request.abort = () => {
          this.settle(request, aborted())
          if (this.active === request) {
            // A native ONNX call cannot receive cancel until it yields. Bound that wait,
            // while rejecting the caller immediately and discarding any late audio.
            this.arm(request, 5_000)
            try { this.worker?.postMessage({ type: 'cancel', id: message.id } satisfies NeuralSpeechRequest) }
            catch (error) { this.reset(this.error(error)) }
          } else {
            const index = this.queue.indexOf(request)
            if (index >= 0) this.queue.splice(index, 1)
          }
        }
        signal.addEventListener('abort', request.abort, { once: true })
      }
      this.queue.push(request)
      this.dispatch()
    })
  }

  private dispatch(): void {
    if (this.closed || this.active) return
    const request = this.queue.shift()
    if (!request) { this.worker?.unref(); return }
    this.active = request
    try {
      const worker = this.ensureWorker()
      worker.ref()
      this.arm(request, request.message.type === 'warmup' ? 60_000 : 45_000)
      worker.postMessage(request.message)
    } catch (error) { this.reset(this.error(error)) }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerPath, { workerData: { modelDirectory: this.modelDirectory } })
    this.worker = worker
    worker.on('message', (message: NeuralSpeechResponse) => {
      if (this.worker !== worker || !this.active || message?.id !== this.active.message.id) return
      const request = this.active
      if (message.type === 'error') {
        this.settle(request, Object.assign(new Error(message.message), { name: message.name }))
      } else if (message.type === 'ready' && request.message.type === 'warmup') {
        this.ready = true
        this.settle(request)
      } else if (message.type === 'audio' && request.message.type === 'synthesize' && message.audio instanceof Uint8Array) {
        this.ready = true
        this.settle(request, undefined, Buffer.from(message.audio.buffer, message.audio.byteOffset, message.audio.byteLength))
      } else {
        this.reset(new Error('PC 음성 작업의 응답이 올바르지 않습니다.'))
        return
      }
      if (request.timer) clearTimeout(request.timer)
      this.active = null
      this.dispatch()
    })
    worker.on('error', (error) => { if (this.worker === worker) this.reset(error) })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.reset(new Error(`PC 음성 작업이 종료되었습니다 (${code}).`))
    })
    return worker
  }

  private arm(request: Request, milliseconds: number): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = setTimeout(() => {
      if (this.active === request) this.reset(new Error('PC 음성 합성 시간이 초과되었습니다. 다시 질문해 주세요.'))
    }, milliseconds)
    request.timer.unref()
  }

  private settle(request: Request, error?: Error, audio?: Buffer): void {
    if (request.settled) return
    request.settled = true
    if (request.abort) request.signal?.removeEventListener('abort', request.abort)
    if (error) request.reject(error); else request.resolve(audio)
  }

  private reset(error: Error): void {
    const worker = this.worker
    this.worker = null
    this.ready = false
    this.warming = null
    const requests = this.active ? [this.active, ...this.queue] : [...this.queue]
    this.active = null
    this.queue.length = 0
    for (const request of requests) {
      if (request.timer) clearTimeout(request.timer)
      this.settle(request, error)
    }
    if (worker) {
      worker.unref()
      void worker.terminate().catch(() => { /* This generation is already detached and cannot publish audio. */ })
    }
  }

  private error(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
}
