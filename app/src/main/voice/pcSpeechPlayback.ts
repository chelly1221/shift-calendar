import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { VoiceSpeechState } from '../../shared/voice'
import { formatVoiceSpeech } from '../../shared/voiceSpeech'

// This fixed helper only plays generated WAV data received through stdin.
const AUDIO_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $line | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String([string]$request.audio)
    $stream = [System.IO.MemoryStream]::new($bytes, $false)
    $player = [System.Media.SoundPlayer]::new($stream)
    try {
      $player.Load()
      [Console]::Out.WriteLine((@{ type = 'chunk'; index = $request.index } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      $player.PlaySync()
      [Console]::Out.WriteLine((@{ type = 'chunkEnd'; index = $request.index } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    } finally {
      $player.Dispose()
      $stream.Dispose()
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
exit 0
`
const ENCODED_SCRIPT = Buffer.from(AUDIO_SCRIPT, 'utf16le').toString('base64')
const idleState = (): VoiceSpeechState => ({ id: null, status: 'idle', text: '', chunk: '' })

export interface PcSpeechSynthesizer {
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>
}
interface SpeechJob { state: VoiceSpeechState; chunks: string[] }
interface ActiveSpeech {
  job: SpeechJob
  child: ChildProcessWithoutNullStreams | null
  watchdog: ReturnType<typeof setTimeout> | null
  controller: AbortController
}

function splitSpeech(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const characters = Array.from(line.trim())
    const result: string[] = []
    while (characters.length > 0) {
      let length = Math.min(characters.length, 120)
      if (characters.length > length) {
        for (let index = length - 1; index >= 50; index--) {
          if (/[\s,.!?]/u.test(characters[index])) { length = index + 1; break }
        }
      }
      const chunk = characters.splice(0, length).join('').trim()
      if (chunk) result.push(chunk)
    }
    return result
  })
}

export class PcSpeechPlayback {
  private readonly jobs = new Map<string, SpeechJob>()
  private readonly queue: SpeechJob[] = []
  private active: ActiveSpeech | null = null
  private lastId: string | null = null
  private scheduled = false
  private closed = false

  constructor(private readonly synthesizer: PcSpeechSynthesizer,
    private readonly launch: typeof spawn = spawn, private readonly platform: NodeJS.Platform = process.platform) {}

  speak(text: string): VoiceSpeechState {
    const spoken = formatVoiceSpeech(text)
    const id = randomUUID()
    const job: SpeechJob = { state: { id, status: 'queued', text: spoken, chunk: '' }, chunks: splitSpeech(spoken) }
    this.jobs.set(id, job)
    this.lastId = id
    if (this.closed || this.platform !== 'win32' || job.chunks.length === 0) {
      job.state.status = 'error'
      job.state.error = this.closed ? 'PC 음성 재생이 종료되었습니다.' : this.platform !== 'win32' ? 'Windows에서만 PC 음성을 재생할 수 있습니다.' : '읽을 내용이 없습니다.'
    } else {
      this.queue.push(job)
      this.schedule()
    }
    this.pruneHistory()
    return { ...job.state }
  }

  getState(id?: string): VoiceSpeechState {
    if (id) {
      const job = this.jobs.get(id)
      return job ? { ...job.state } : { id, status: 'error', text: '', chunk: '', error: '음성 재생 요청을 찾을 수 없습니다.' }
    }
    const job = this.active?.job ?? this.queue[0] ?? (this.lastId ? this.jobs.get(this.lastId) : null)
    return job ? { ...job.state } : idleState()
  }

  stop(id?: string): VoiceSpeechState {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]
      if (!id || job.state.id === id) {
        job.state.status = 'stopped'; job.state.chunk = ''
        this.queue.splice(index, 1)
      }
    }
    if (this.active && (!id || this.active.job.state.id === id)) {
      const { job, child, controller } = this.active
      controller.abort()
      if (this.active.watchdog) clearTimeout(this.active.watchdog)
      this.active.watchdog = null
      job.state.status = 'stopped'; job.state.chunk = ''
      try { child?.kill() } catch (error) {
        job.state.status = 'error'
        job.state.error = `PC 음성 재생 중지 실패: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return this.getState(id)
  }

  close(): void { this.closed = true; this.stop() }

  private schedule(): void {
    if (this.closed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.startNext() })
  }

  private startNext(): void {
    if (this.closed || this.active) return
    const job = this.queue.shift()
    if (!job) return
    const active: ActiveSpeech = { job, child: null, watchdog: null, controller: new AbortController() }
    this.active = active
    let finished = false
    let stderr = ''
    let sent = 0
    let playing = -1
    let completed = -1
    const finish = (error?: string) => {
      if (finished) return
      finished = true
      active.controller.abort()
      if (active.watchdog) clearTimeout(active.watchdog)
      active.watchdog = null
      if (job.state.status !== 'stopped' && job.state.status !== 'error') {
        job.state.status = error ? 'error' : 'done'
        if (error) job.state.error = error
      }
      job.state.chunk = ''
      if (this.active === active) this.active = null
      this.schedule()
    }
    try {
      const child = this.launch('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT], { windowsHide: true, stdio: 'pipe' })
      active.child = child
      const isLive = () => !finished && !active.controller.signal.aborted
      const fail = (message: string) => {
        if (!isLive()) return
        active.controller.abort()
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = null
        job.state.status = 'error'; job.state.error = message
        try { child.kill() } catch { /* Wait for actual exit to prevent overlapping playback. */ }
      }
      const resetWatchdog = (milliseconds: number) => {
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = setTimeout(() => fail('PC 음성 응답 시간이 초과되었습니다. 다시 질문해 주세요.'), milliseconds)
        active.watchdog.unref()
      }
      const prepare = async (index: number) => {
        try {
          const audio = await this.synthesizer.synthesize(job.chunks[index], active.controller.signal)
          if (!isLive()) return
          sent = index + 1
          child.stdin.write(`${JSON.stringify({ index, audio: audio.toString('base64') })}\n`, 'utf8')
          if (sent === job.chunks.length) child.stdin.end()
        } catch (error) {
          fail(`PC AI 음성 생성 실패: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      let stdout = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (data: string) => {
        stdout += data
        const lines = stdout.split(/\r?\n/u)
        stdout = (lines.pop() ?? '').slice(-8192)
        for (const line of lines) {
          if (!isLive()) continue
          try {
            const progress: unknown = JSON.parse(line)
            if (!progress || typeof progress !== 'object' || !('type' in progress) || !('index' in progress) || typeof progress.index !== 'number' || !Number.isInteger(progress.index)) continue
            const index = progress.index
            if (progress.type === 'chunk' && index === playing + 1 && index === completed + 1 && index < sent) {
              playing = index
              job.state.status = 'speaking'; job.state.chunk = job.chunks[index]
              resetWatchdog(Math.max(30_000, Array.from(job.state.chunk).length * 600))
              // Generate only one chunk ahead: prompt playback and bounded memory for long lists.
              if (index + 1 < job.chunks.length) void prepare(index + 1)
            } else if (progress.type === 'chunkEnd' && index === playing && index === completed + 1) {
              completed = index
              resetWatchdog(30_000)
            }
          } catch { /* Ignore host initialization output and malformed progress. */ }
        }
      })
      child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-4000) })
      child.on('error', (error) => {
        const message = `PC 음성 재생 실패: ${error.message}`
        if (child.pid) fail(message); else finish(message)
      })
      child.once('close', (code, signal) => {
        const complete = code === 0 && completed === job.chunks.length - 1
        finish(complete ? undefined : stderr.trim() || `PC 음성 재생이 완료되지 않았습니다 (${signal ?? code ?? 'unknown'}).`)
      })
      child.stdin.on('error', (error: Error) => fail(`PC 음성 전달 실패: ${error.message}`))
      child.stdout.on('error', (error: Error) => fail(`PC 음성 상태 확인 실패: ${error.message}`))
      child.stderr.on('error', (error: Error) => fail(`PC 음성 상태 확인 실패: ${error.message}`))
      resetWatchdog(45_000)
      void prepare(0)
    } catch (error) {
      const message = `PC 음성 재생 실패: ${error instanceof Error ? error.message : String(error)}`
      if (active.child) {
        active.controller.abort()
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = null
        job.state.status = 'error'; job.state.error = message
        try { active.child.kill() } catch { /* Wait for process close before another answer. */ }
      } else finish(message)
    }
  }

  private pruneHistory(): void {
    let removable = [...this.jobs.values()].filter(({ state }) => ['done', 'stopped', 'error'].includes(state.status)).length - 200
    for (const [id, job] of this.jobs) {
      if (removable <= 0) break
      if (id !== this.lastId && this.active?.job !== job && ['done', 'stopped', 'error'].includes(job.state.status)) {
        this.jobs.delete(id); removable--
      }
    }
  }
}
