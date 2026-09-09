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
  complete(code = 0) { this.emit('close', code, null) }
}

const children: SpeechChild[] = []
const players: PcSpeechPlayback[] = []
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const player = (platform: NodeJS.Platform = 'win32') => {
  const instance = new PcSpeechPlayback(spawn, platform)
  players.push(instance)
  return instance
}

beforeEach(() => {
  vi.resetAllMocks()
  children.length = 0
  players.length = 0
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

  it('queues synchronously and waits for a real chunk signal before marking speech active', async () => {
    const speech = player()
    const state = speech.speak('이상승 연차')
    expect(state.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(state.status).toBe('queued')
    expect(spawn).not.toHaveBeenCalled()
    await flush()
    expect(speech.getState(state.id!)).toMatchObject({ status: 'queued', text: '이상승 연차', chunk: '' })
    children[0].progress(0)
    expect(speech.getState(state.id!)).toMatchObject({ status: 'speaking', chunk: '이상승 연차' })
    expect(state.status).toBe('queued')
    children[0].complete()
    expect(speech.getState(state.id!)).toMatchObject({ status: 'done', chunk: '' })
  })

  it('uses a fixed hidden command and sends potentially executable text only as UTF-8 JSON stdin', async () => {
    const text = '김수헌 연차; $(Write-Output "injected") ` $env:PATH'
    player().speak(text)
    await flush()
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(options).toMatchObject({ windowsHide: true, stdio: 'pipe' })
    expect(args).toContain('-EncodedCommand')
    const script = Buffer.from(args![args!.length - 1], 'base64').toString('utf16le')
    expect(script).not.toContain(text)
    expect(script).toContain('[Console]::In.ReadToEnd() | ConvertFrom-Json')
    expect(script).toContain("Culture.Name -like 'ko-*'")
    expect(script).toContain('$speaker.Volume = 100')
    expect(script).toContain('$speaker.SetOutputToDefaultAudioDevice()')
    expect(JSON.parse(children[0].input)).toEqual({ chunks: [text] })
  })

  it('reads all lines of a long answer in one job and finishes only when the process closes', async () => {
    const text = Array.from({ length: 60 }, (_, index) => `9월 ${index + 1}일 김수헌 연차`).join('\n')
    const speech = player()
    const state = speech.speak(text)
    await flush()
    const payload = JSON.parse(children[0].input) as { chunks: string[] }
    expect(payload.chunks).toHaveLength(60)
    children[0].progress(59)
    expect(speech.getState(state.id!)).toMatchObject({ status: 'speaking', text, chunk: payload.chunks[59] })
    children[0].complete()
    expect(speech.getState(state.id!).status).toBe('done')
  })

  it('splits very long lines without dropping words or splitting Unicode characters', async () => {
    const text = '가나다🙂'.repeat(250)
    player().speak(text)
    await flush()
    const payload = JSON.parse(children[0].input) as { chunks: string[] }
    expect(payload.chunks.length).toBeGreaterThan(1)
    expect(payload.chunks.join('')).toBe(text)
    expect(payload.chunks.every((chunk) => Array.from(chunk).length <= 300)).toBe(true)
  })

  it('preserves FIFO and does not start a second answer while the first process is playing', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('다음 답변')
    await flush()
    children[0].progress(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(speech.getState(second.id!).status).toBe('queued')
    expect(speech.getState().id).toBe(first.id)
    children[0].complete()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(JSON.parse(children[1].input)).toEqual({ chunks: ['다음 답변'] })
    expect(speech.getState().id).toBe(second.id)
  })

  it('handles fragmented progress and ignores malformed or out-of-range output', async () => {
    const speech = player()
    speech.speak('첫 줄\n둘째 줄')
    await flush()
    children[0].stdout.write('host banner\n{"type":"chunk","index":20}\n')
    expect(speech.getState().status).toBe('queued')
    children[0].stdout.write('{"type":"chunk",')
    children[0].stdout.write('"index":1}\r\n')
    expect(speech.getState()).toMatchObject({ status: 'speaking', chunk: '둘째 줄' })
  })

  it('cancels a queued job without interrupting the active answer', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('취소할 답변')
    await flush()
    expect(speech.stop(second.id!).status).toBe('stopped')
    expect(children[0].kill).not.toHaveBeenCalled()
    children[0].complete()
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(speech.getState(first.id!).status).toBe('done')
  })

  it('waits for a stopped active process to close before starting the next queued answer', async () => {
    const speech = player()
    const first = speech.speak('첫 답변')
    const second = speech.speak('다음 답변')
    await flush()
    children[0].progress(0)
    expect(speech.stop(first.id!).status).toBe('stopped')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].progress(0)
    expect(speech.getState(first.id!).status).toBe('stopped')
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(speech.getState(second.id!).status).toBe('queued')
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
    expect(JSON.parse(children[1].input)).toEqual({ chunks: ['새 답변'] })
  })

  it('cancels a job before the spawn microtask runs', async () => {
    const speech = player()
    const state = speech.speak('읽지 않을 답변')
    speech.stop(state.id!)
    await flush()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a nonzero process exit with the actual synthesizer error', async () => {
    const speech = player()
    speech.speak('답변')
    await flush()
    children[0].stderr.write('사용 가능한 오디오 장치가 없습니다.\n')
    children[0].complete(1)
    expect(speech.getState()).toMatchObject({ status: 'error', error: '사용 가능한 오디오 장치가 없습니다.' })
  })

  it('reports process startup errors and starts the next job only once despite a later close event', async () => {
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

  it('handles stdout stream errors without uncaught error events', async () => {
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
    children[0].complete()
    await flush()
    children[0].progress(0)
    children[0].complete(1)
    expect(speech.getState(first.id!).status).toBe('done')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('returns a useful error for an unknown job and cannot mutate internal state through snapshots', async () => {
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

  it('rejects empty text and unsupported platforms without launching a child', async () => {
    expect(player().speak(' \n ')).toMatchObject({ status: 'error', error: '읽을 내용이 없습니다.' })
    expect(player('linux').speak('답변')).toMatchObject({ status: 'error', error: 'Windows에서만 PC 음성을 재생할 수 있습니다.' })
    await flush()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('times out preparation after 15 seconds and continues the queue after killing the stalled process', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    const first = speech.speak('첫 답변')
    speech.speak('다음 답변')
    await flush()
    vi.advanceTimersByTime(14_999)
    expect(speech.getState(first.id!).status).toBe('queued')
    vi.advanceTimersByTime(1)
    expect(speech.getState(first.id!)).toMatchObject({ status: 'error', error: 'PC 음성 응답 시간이 초과되었습니다. 다시 질문해 주세요.' })
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    children[0].progress(0)
    expect(speech.getState(first.id!).status).toBe('error')
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].complete(1)
    await flush()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('allows at least 180 seconds for a 300-character chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('가'.repeat(300))
    await flush()
    children[0].progress(0)
    vi.advanceTimersByTime(179_999)
    expect(speech.getState().status).toBe('speaking')
    vi.advanceTimersByTime(1)
    expect(speech.getState().status).toBe('error')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh minimum 15-second allowance after the first short chunk begins', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak('짧은 답변')
    await flush()
    vi.advanceTimersByTime(14_000)
    children[0].progress(0)
    vi.advanceTimersByTime(14_999)
    expect(speech.getState().status).toBe('speaking')
    vi.advanceTimersByTime(1)
    expect(speech.getState().status).toBe('error')
  })

  it('resets the watchdog per chunk without applying a total answer deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const speech = player()
    speech.speak(Array.from({ length: 20 }, () => '가'.repeat(200)).join('\n'))
    await flush()
    for (let index = 0; index < 20; index++) {
      children[0].progress(index)
      vi.advanceTimersByTime(100_000)
      expect(speech.getState().status).toBe('speaking')
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
    children[0].progress(0)
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
