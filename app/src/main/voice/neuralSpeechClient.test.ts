import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeuralSpeechClient } from './neuralSpeechClient'

vi.mock('node:worker_threads', () => ({ Worker: vi.fn() }))

class SpeechWorker extends EventEmitter {
  postMessage = vi.fn()
  ref = vi.fn()
  unref = vi.fn()
  terminate = vi.fn(async () => 0)
  request(index = this.postMessage.mock.calls.length - 1): { type: string; id: number; text?: string } {
    return this.postMessage.mock.calls[index][0]
  }
  ready(id = this.request().id) { this.emit('message', { type: 'ready', id }) }
  audio(id = this.request().id) { this.emit('message', { type: 'audio', id, audio: new Uint8Array([82, 73, 70, 70]) }) }
}

const workers: SpeechWorker[] = []
const clients: NeuralSpeechClient[] = []
function client(): NeuralSpeechClient {
  const value = new NeuralSpeechClient('C:/app/dist-electron/neuralSpeechWorker.js', 'C:/app/resources/voice-model')
  clients.push(value)
  return value
}

beforeEach(() => {
  vi.resetAllMocks()
  workers.length = 0
  clients.length = 0
  vi.mocked(Worker).mockImplementation(function () {
    const worker = new SpeechWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
})
afterEach(() => { for (const value of clients) value.close(); vi.useRealTimers() })

describe('NeuralSpeechClient', () => {
  it('creates one worker on demand, shares warmup, and releases its idle event-loop reference', async () => {
    const speech = client()
    expect(Worker).not.toHaveBeenCalled()
    const first = speech.warmup()
    expect(speech.warmup()).toBe(first)
    expect(Worker).toHaveBeenCalledWith('C:/app/dist-electron/neuralSpeechWorker.js', {
      workerData: { modelDirectory: 'C:/app/resources/voice-model' },
    })
    workers[0].ready()
    await first
    await speech.warmup()
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    expect(workers[0].ref).toHaveBeenCalled()
    expect(workers[0].unref).toHaveBeenCalled()
  })

  it('serializes requests and receives transferred waveform bytes as a Buffer', async () => {
    const speech = client()
    const first = speech.synthesize('첫 번째')
    const second = speech.synthesize('두 번째')
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    workers[0].audio()
    expect(workers[0].request().text).toBe('두 번째')
    workers[0].audio()
    const [one, two] = await Promise.all([first, second])
    expect(Buffer.isBuffer(one)).toBe(true)
    expect(one.toString()).toBe('RIFF')
    expect(two).toEqual(one)
  })

  it('does not start a worker for a request cancelled beforehand', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(client().synthesize('취소', abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(Worker).not.toHaveBeenCalled()
  })

  it('removes a cancelled waiting request without interrupting current synthesis', async () => {
    const speech = client()
    const first = speech.synthesize('첫 번째')
    const abort = new AbortController()
    const second = speech.synthesize('취소', abort.signal)
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    workers[0].audio()
    await first
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects cancellation immediately, ignores late audio, and reuses the worker after native work ends', async () => {
    const speech = client()
    const abort = new AbortController()
    const first = speech.synthesize('취소', abort.signal)
    const firstId = workers[0].request().id
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = speech.synthesize('다음')
    abort.abort()
    await rejected
    expect(workers[0].request()).toEqual({ type: 'cancel', id: firstId })
    workers[0].audio(firstId)
    expect(workers[0].request().text).toBe('다음')
    workers[0].audio(firstId) // A duplicate late result must not complete the next request.
    expect(workers[0].unref).not.toHaveBeenCalled()
    workers[0].audio()
    await expect(second).resolves.toBeInstanceOf(Buffer)
    expect(Worker).toHaveBeenCalledTimes(1)
  })

  it('restarts a worker that cannot acknowledge cancellation and releases all waiting promises', async () => {
    vi.useFakeTimers()
    const speech = client()
    const abort = new AbortController()
    const first = speech.synthesize('취소', abort.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    const waiting = speech.synthesize('기다림')
    const timedOut = expect(waiting).rejects.toThrow('시간이 초과')
    await vi.advanceTimersByTimeAsync(5_000)
    await timedOut
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const next = speech.synthesize('재시도')
    expect(workers).toHaveLength(2)
    workers[0].emit('exit', 1)
    workers[1].audio()
    await expect(next).resolves.toBeInstanceOf(Buffer)
  })

  it('rejects active and waiting calls on worker failure and creates a fresh worker for retry', async () => {
    const speech = client()
    const first = expect(speech.warmup()).rejects.toThrow('native failure')
    const second = expect(speech.synthesize('대기')).rejects.toThrow('native failure')
    workers[0].emit('error', new Error('native failure'))
    await Promise.all([first, second])
    const next = speech.warmup()
    expect(workers).toHaveLength(2)
    workers[1].ready()
    await next
  })

  it('treats an unexpected clean worker exit as a failure and clears warmup readiness', async () => {
    const speech = client()
    const warmup = speech.warmup()
    workers[0].ready()
    await warmup
    const pending = expect(speech.synthesize('중단')).rejects.toThrow('종료되었습니다 (0)')
    workers[0].emit('exit', 0)
    await pending
    const retry = speech.warmup()
    workers[1].ready()
    await retry
  })

  it('times out stuck native work without blocking a later retry', async () => {
    vi.useFakeTimers()
    const speech = client()
    const timeout = expect(speech.synthesize('멎은 합성')).rejects.toThrow('시간이 초과')
    await vi.advanceTimersByTimeAsync(45_000)
    await timeout
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const next = speech.synthesize('재시도')
    workers[1].audio()
    await next
  })

  it('continues after a recoverable model error without replacing the worker', async () => {
    const speech = client()
    const failed = expect(speech.synthesize('실패')).rejects.toThrow('읽을 수 없음')
    const next = speech.synthesize('다음')
    workers[0].emit('message', { type: 'error', id: workers[0].request().id, name: 'Error', message: '읽을 수 없음' })
    workers[0].audio()
    await failed
    await next
    expect(Worker).toHaveBeenCalledTimes(1)
  })

  it('cleans up app shutdown, rejects pending requests, and refuses new work', async () => {
    const speech = client()
    const first = expect(speech.warmup()).rejects.toThrow('종료되었습니다')
    const second = expect(speech.synthesize('대기')).rejects.toThrow('종료되었습니다')
    speech.close()
    speech.close()
    await Promise.all([first, second])
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    await expect(speech.warmup()).rejects.toThrow('종료되었습니다')
    await expect(speech.synthesize('다음')).rejects.toThrow('종료되었습니다')
  })

  it('turns worker construction and message delivery failures into rejected requests', async () => {
    vi.mocked(Worker).mockImplementationOnce(function () { throw new Error('worker missing') })
    await expect(client().warmup()).rejects.toThrow('worker missing')
    const speech = client()
    const first = speech.warmup()
    workers[0].ready()
    await first
    workers[0].postMessage.mockImplementationOnce(() => { throw new Error('port closed') })
    await expect(speech.synthesize('실패')).rejects.toThrow('port closed')
  })
})
