import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PcSpeechPlayback } from './pcSpeechPlayback'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

class SpeechChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
  pid: number | undefined
  input = ''
  constructor() {
    super()
    this.stdin.on('data', (buffer: Buffer) => { this.input += buffer.toString('utf8') })
  }
  progress(index: number) { this.stdout.write(`${JSON.stringify({ type: 'chunk', index })}\n`) }
  endChunk(index: number) { this.stdout.write(`${JSON.stringify({ type: 'chunkEnd', index })}\n`) }
  complete(code = 0) { this.emit('close', code, null) }
  payloads(): { index: number; audio: string }[] {
    return this.input.trim() ? this.input.trim().split('\n').map((line) => JSON.parse(line) as { index: number; audio: string }) : []
  }
}

const children: SpeechChild[] = []
const players: PcSpeechPlayback[] = []
const synthesize = vi.fn<(text: string, signal?: AbortSignal) => Promise<Buffer>>()
const fakeAudio = (text: string) => Buffer.from(`WAV:${text}`, 'utf8')
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const player = (platform: NodeJS.Platform = 'win32') => {
  const instance = new PcSpeechPlayback({ synthesize }, spawn, platform)
  players.push(instance)
  return instance
}
const playAll = async (child: SpeechChild) => {
  for (let index = 0; index < child.payloads().length; index++) {
    child.progress(index)
    await flush()
    child.endChunk(index)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  children.length = 0
  players.length = 0
  synthesize.mockImplementation(async (text) => fakeAudio(text))
  vi.mocked(spawn).mockImplementation(() => {
    const child = new SpeechChild()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  })
})
afterEach(() => {
  for (const instance of players) instance.close()
  vi.useRealTimers()
})

describe('PcSpeechPlayback', () => {
  it('returns an idle snapshot before receiving speech', () => {
    expect(player().getState()).toEqual({ id: null, status: 'idle', text: '', chunk: '' })
  })

  it('waits for audio playback to start and for its final process exit before reporting completion', async () => {
    const audio = deferred<Buffer>()
    synthesize.mockReturnValueOnce(audio.promise)
    const speech = player()
    const state = speech.speak('이상승 연차')
    expect(state.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(state.status).toBe('queued')
    expect(spawn).not.toHaveBeenCalled()
    await flush()
    expect(children[0].input).toBe('')
    children[0].progress(0)
    expect(speech.getState(state.id!).status).toBe('queued')
    audio.resolve(fakeAudio('이상승 연차'))
    await flush()
    expect(speech.getState(state.id!)).toMatchObject({ status: 'queued', text: '이상승 연차', chunk: '' })
    children[0].progress(0)
    expect(speech.getState(state.id!)).toMatchObject({ status: 'speaking', chunk: '이상승 연차' })
    children[0].endChunk(0)
    expect(speech.getState(state.id!).status).toBe('speaking')
    expect(state.status).toBe('queued')
    children[0].complete()
    expect(speech.getState(state.id!)).toMatchObject({ status: 'done', chunk: '' })
  })

  it('uses a fixed hidden audio helper and transfers only generated WAV data as JSON lines', async () => {
    const text = '김수헌 연차; $(Write-Output "injected") ` $env:PATH'
    player().speak(text)
    await flush()
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(options).toMatchObject({ windowsHide: true, stdio: 'pipe' })
    expect(args).toContain('-EncodedCommand')
    const script = Buffer.from(args![args!.length - 1], 'base64').toString('utf16le')
    expect(script).not.toContain(text)
    expect(script).toContain('[System.Media.SoundPlayer]')
    expect(script).not.toContain('System.Speech')
    expect(synthesize).toHaveBeenCalledWith(text, expect.any(AbortSignal))
    expect(children[0].payloads()).toEqual([{ index: 0, audio: fakeAudio(text).toString('base64') }])
    expect(children[0].input.endsWith('\n')).toBe(true)
    expect(children[0].stdin.writableEnded).toBe(true)
  })

  it('normalizes slash separators and times even when replay is requested directly', async () => {
    const speech = player()
    const state = speech.speak('일근 김수헌 / 주간 A조 ／ 회의 14:30')
    await flush()
    expect(state.text).toBe('일근 김수헌, 주간 A조, 회의 오후 2시 30분')
    expect(synthesize).toHaveBeenCalledWith(state.text, expect.any(AbortSignal))
    children[0].progress(0)
    expect(speech.getState(state.id!).chunk).toBe(state.text)
  })

  it('generates at most one upcoming chunk while the current audio plays', async () => {
    const secondAudio = deferred<Buffer>()
    synthesize.mockResolvedValueOnce(fakeAudio('첫 줄')).mockReturnValueOnce(secondAudio.promise)
    const speech = player()
    speech.speak('첫 줄\n둘째 줄\n셋째 줄')
    await flush()
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(children[0].payloads()).toHaveLength(1)
    expect(children[0].stdin.writableEnded).toBe(false)
    children[0].progress(0)
    await flush()
    expect(synthesize).toHaveBeenCalledTimes(2)
    children[0].progress(0)
    children[0].endChunk(0)
    children[0].progress(1)
    expect(speech.getState().chunk).toBe('첫 줄')
    expect(synthesize).toHaveBeenCalledTimes(2)
    secondAudio.resolve(fakeAudio('둘째 줄'))
    await flush()
    expect(children[0].payloads()).toHaveLength(2)
    expect(synthesize).toHaveBeenCalledTimes(2)
    children[0].progress(1)
    await flush()
    expect(synthesize).toHaveBeenCalledTimes(3)
    expect(children[0].payloads()).toHaveLength(3)
    expect(children[0].stdin.writableEnded).toBe(true)
  })

  it('reads every entry of a long answer in order without starting another job', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `9월 ${index + 1}일 김수헌 연차`)
    const text = lines.join('\n')
    const speech = player()
    const state = speech.speak(text)
    await flush()
    await playAll(children[0])
    expect(synthesize.mock.calls.map(([line]) => line)).toEqual(lines)
    expect(children[0].payloads().map(({ index, audio }) => ({ index, text: Buffer.from(audio, 'base64').toString('utf8') })))
      .toEqual(lines.map((line, index) => ({ index, text: `WAV:${line}` })))
    expect(speech.getState(state.id!)).toMatchObject({ status: 'speaking', text, chunk: lines[59] })
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete()
    expect(speech.getState(state.id!).status).toBe('done')
  })

  it('splits very long lines into short speech without dropping or splitting Unicode characters', async () => {
    const text = '가나다🙂'.repeat(250)
    player().speak(text)
    await flush()
    await playAll(children[0])
    const chunks = synthesize.mock.calls.map(([chunk]) => chunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => Array.from(chunk).length <= 120)).toBe(true)
    expect(chunks.every((chunk) => !chunk.includes('\ufffd'))).toBe(true)
  })

  it('preserves FIFO and does not generate or play another answer while the first process is alive', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('다음 답변')
    await flush()
    await playAll(children[0])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(speech.getState(second.id!).status).toBe('queued')
    expect(speech.getState().id).toBe(first.id)
    children[0].complete()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(['첫 답변', '다음 답변'])
    expect(speech.getState().id).toBe(second.id)
  })

  it('handles fragmented progress and ignores malformed, unsent, duplicate, and out-of-order updates', async () => {
    const speech = player()
    speech.speak('첫 줄\n둘째 줄')
    await flush()
    children[0].stdout.write('host banner\n{"type":"chunk","index":20}\n{"type":"chunkEnd","index":0}\n')
    children[0].progress(1)
    expect(speech.getState().status).toBe('queued')
    children[0].stdout.write('{"type":"chunk",')
    children[0].stdout.write('"index":0}\r\n')
    await flush()
    expect(speech.getState()).toMatchObject({ status: 'speaking', chunk: '첫 줄' })
    children[0].progress(1)
    expect(speech.getState().chunk).toBe('첫 줄')
    children[0].endChunk(1)
    children[0].endChunk(0)
    children[0].progress(0)
    children[0].progress(1)
    children[0].endChunk(1)
    children[0].complete()
    expect(speech.getState().status).toBe('done')
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it.each(['before playback', 'before audio ends', 'before final chunk ends'])('does not report success when the process exits %s', async (stage) => {
    const speech = player()
    speech.speak('첫 줄\n둘째 줄')
    await flush()
    if (stage !== 'before playback') children[0].progress(0)
    if (stage === 'before final chunk ends') {
      await flush()
      children[0].endChunk(0)
      children[0].progress(1)
    }
    children[0].complete()
    expect(speech.getState().status).toBe('error')
  })

  it('cancels a queued job without interrupting the active answer', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('취소할 답변')
    await flush()
    expect(speech.stop(second.id!).status).toBe('stopped')
    expect(children[0].kill).not.toHaveBeenCalled()
    await playAll(children[0])
    children[0].complete()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(speech.getState(first.id!).status).toBe('done')
  })

  it('aborts synthesis and ignores audio that arrives after cancellation', async () => {
    const lateAudio = deferred<Buffer>()
    synthesize.mockReturnValueOnce(lateAudio.promise)
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('다음 답변')
    await flush()
    const signal = synthesize.mock.calls[0][1]!
    expect(signal.aborted).toBe(false)
    expect(speech.stop(first.id!).status).toBe('stopped')
    expect(signal.aborted).toBe(true)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    lateAudio.resolve(fakeAudio('취소된 음성'))
    await flush()
    expect(children[0].input).toBe('')
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].progress(0)
    children[0].endChunk(0)
    expect(speech.getState(first.id!).status).toBe('stopped')
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(speech.getState(second.id!).status).toBe('queued')
  })

  it('ignores a synthesis rejection after a cancelled process has already closed', async () => {
    const lateAudio = deferred<Buffer>()
    synthesize.mockReturnValueOnce(lateAudio.promise)
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    speech.stop(first.id!)
    children[0].complete(1)
    await flush()
    lateAudio.reject(new Error('cancelled inference'))
    await flush()
    expect(speech.getState(first.id!).status).toBe('stopped')
    expect(children[1].kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('stops all jobs and allows a new answer afterward', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('다음 답변')
    await flush()
    speech.stop()
    expect(speech.getState(first.id!).status).toBe('stopped')
    expect(speech.getState(second.id!).status).toBe('stopped')
    children[0].complete(1)
    speech.speak('새 답변')
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(['첫 답변', '새 답변'])
  })

  it('cancels a job before the spawn microtask runs', async () => {
    const speech = player()
    const state = speech.speak('읽지 않을 답변')
    speech.stop(state.id!)
    await flush()
    expect(spawn).not.toHaveBeenCalled()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('reports synthesis failures without overlapping the next queued answer', async () => {
    synthesize.mockRejectedValueOnce(new Error('model unavailable'))
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC AI 음성 생성 실패: model unavailable' })
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reports a nonzero process exit with the actual audio device error', async () => {
    const speech = player()
    speech.speak('답변')
    await flush()
    children[0].stderr.write('사용 가능한 오디오 장치가 없습니다.\n')
    children[0].complete(1)
    expect(speech.getState()).toMatchObject({ status: 'error', error: '사용 가능한 오디오 장치가 없습니다.' })
  })

  it('handles startup errors and starts the next job only once despite later duplicate events', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    children[0].emit('error', new Error('ENOENT'))
    children[0].complete(-1)
    children[0].emit('error', new Error('late duplicate'))
    await flush()
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC 음성 재생 실패: ENOENT' })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('retains a stopped state if a failed startup reports errors later', async () => {
    const speech = player()
    speech.speak('답변')
    await flush()
    speech.stop()
    children[0].emit('error', new Error('cancelled'))
    children[0].complete(-1)
    expect(speech.getState().status).toBe('stopped')
  })

  it('reports synchronous spawn failures without losing subsequent queued work', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn failed') })
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC 음성 재생 실패: spawn failed' })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reports stdin errors, kills the child, and holds the next job until cleanup', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    children[0].stdin.emit('error', new Error('EPIPE'))
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC 음성 전달 실패: EPIPE' })
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('handles an error from a running process without overlapping the next answer', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    children[0].pid = 123
    children[0].emit('error', new Error('running process error'))
    children[0].emit('error', new Error('duplicate error'))
    expect(speech.getState(first.id!).status).toBe('error')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('handles stdout stream errors without uncaught or duplicate failures', async () => {
    const speech = player()
    speech.speak('답변')
    await flush()
    children[0].stdout.emit('error', new Error('read failed'))
    expect(speech.getState()).toMatchObject({ status: 'error', error: 'PC 음성 상태 확인 실패: read failed' })
    children[0].stderr.emit('error', new Error('duplicate stream error'))
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    children[0].complete(1)
  })

  it('ignores late output and duplicate close callbacks from a completed process', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    speech.speak('마지막 답변')
    await flush()
    await playAll(children[0])
    children[0].complete()
    await flush()
    children[0].progress(0)
    children[0].endChunk(0)
    children[0].complete(1)
    expect(speech.getState(first.id!).status).toBe('done')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('returns a useful unknown-job error and protects internal state from snapshot changes', async () => {
    const speech = player()
    const state = speech.speak('답변')
    const snapshot = speech.getState(state.id!)
    snapshot.text = 'changed'
    expect(speech.getState(state.id!).text).toBe('답변')
    expect(speech.stop('missing')).toMatchObject({ id: 'missing', status: 'error' })
    await flush()
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('closes permanently and never starts queued or newly requested playback', async () => {
    const speech = player()
    const queued = speech.speak('답변')
    speech.close()
    expect(speech.getState(queued.id!).status).toBe('stopped')
    expect(speech.speak('다음 답변')).toMatchObject({ status: 'error', error: 'PC 음성 재생이 종료되었습니다.' })
    await flush()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects empty text and unsupported platforms without launching or synthesizing', async () => {
    expect(player().speak(' \n ')).toMatchObject({ status: 'error', error: '읽을 내용이 없습니다.' })
    expect(player('linux').speak('답변')).toMatchObject({ status: 'error', error: 'Windows에서만 PC 음성을 재생할 수 있습니다.' })
    await flush()
    expect(spawn).not.toHaveBeenCalled()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('times out stalled preparation after 45 seconds and advances only after the child closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const neverReady = deferred<Buffer>()
    synthesize.mockReturnValueOnce(neverReady.promise)
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    vi.advanceTimersByTime(44_999)
    expect(speech.getState(first.id!).status).toBe('queued')
    vi.advanceTimersByTime(1)
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC 음성 응답 시간이 초과되었습니다. 다시 질문해 주세요.' })
    expect(synthesize.mock.calls[0][1]!.aborted).toBe(true)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    children[0].progress(0)
    expect(speech.getState(first.id!).status).toBe('error')
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('allows 72 seconds of playback for a 120-character chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('가'.repeat(120))
    await flush()
    children[0].progress(0)
    vi.advanceTimersByTime(71_999)
    expect(speech.getState().status).toBe('speaking')
    vi.advanceTimersByTime(1)
    expect(speech.getState().status).toBe('error')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh minimum 30-second allowance when short audio begins', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('짧은 답변')
    await flush()
    vi.advanceTimersByTime(44_000)
    children[0].progress(0)
    vi.advanceTimersByTime(29_999)
    expect(speech.getState().status).toBe('speaking')
    vi.advanceTimersByTime(1)
    expect(speech.getState().status).toBe('error')
  })

  it('times out a stalled next audio chunk after the prior chunk ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('첫 줄\n둘째 줄')
    await flush()
    children[0].progress(0)
    vi.advanceTimersByTime(20_000)
    children[0].endChunk(0)
    vi.advanceTimersByTime(29_999)
    expect(speech.getState().status).toBe('speaking')
    vi.advanceTimersByTime(1)
    expect(speech.getState().status).toBe('error')
  })

  it('resets the watchdog per chunk without imposing a total answer deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak(Array.from({ length: 20 }, () => '가'.repeat(120)).join('\n'))
    await flush()
    for (let index = 0; index < 20; index++) {
      children[0].progress(index)
      await flush()
      vi.advanceTimersByTime(60_000)
      expect(speech.getState().status).toBe('speaking')
      children[0].endChunk(index)
    }
    children[0].complete()
    expect(speech.getState().status).toBe('done')
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears watchdogs on completion and stop so old jobs cannot terminate a new answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('첫 답변')
    const second = speech.speak('가'.repeat(100))
    await flush()
    await playAll(children[0])
    children[0].complete()
    await flush()
    children[1].progress(0)
    vi.advanceTimersByTime(30_000)
    expect(speech.getState(second.id!).status).toBe('speaking')
    expect(children[1].kill).not.toHaveBeenCalled()
    speech.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
