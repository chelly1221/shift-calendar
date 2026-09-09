import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { VoiceSpeechState } from '../../shared/voice'

// Speech data is delivered only through stdin; this script never contains user text.
const SPEECH_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$speaker = $null
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Speech
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $korean = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'ko-*' } | Select-Object -First 1
  if ($null -ne $korean) { $speaker.SelectVoice($korean.VoiceInfo.Name) }
  $speaker.SetOutputToDefaultAudioDevice()
  $speaker.Volume = 100
  $index = 0
  foreach ($chunk in $request.chunks) {
    [Console]::Out.WriteLine((@{ type = 'chunk'; index = $index } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $speaker.Speak([string]$chunk)
    $index += 1
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $speaker) { $speaker.Dispose() }
}
exit 0
`
const ENCODED_SCRIPT = Buffer.from(SPEECH_SCRIPT, 'utf16le').toString('base64')
const idleState = (): VoiceSpeechState => ({ id: null, status: 'idle', text: '', chunk: '' })

interface SpeechJob {
  state: VoiceSpeechState
  chunks: string[]
}

function splitSpeech(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const characters = Array.from(line.trim())
    const result: string[] = []
    while (characters.length > 0) {
      let length = Math.min(characters.length, 300)
      if (characters.length > length) {
        for (let index = length - 1; index >= 150; index--) {
          if (/\s/u.test(characters[index])) { length = index + 1; break }
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
  private active: { job: SpeechJob; child: ChildProcessWithoutNullStreams | null; watchdog: ReturnType<typeof setTimeout> | null } | null = null
  private lastId: string | null = null
  private scheduled = false
  private closed = false

  constructor(private readonly launch: typeof spawn = spawn, private readonly platform: NodeJS.Platform = process.platform) {}

  speak(text: string): VoiceSpeechState {
    const id = randomUUID()
    const job: SpeechJob = { state: { id, status: 'queued', text, chunk: '' }, chunks: splitSpeech(text) }
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
        job.state.status = 'stopped'
        job.state.chunk = ''
        this.queue.splice(index, 1)
      }
    }
    if (this.active && (!id || this.active.job.state.id === id)) {
      const { job, child } = this.active
      if (this.active.watchdog) clearTimeout(this.active.watchdog)
      this.active.watchdog = null
      job.state.status = 'stopped'
      job.state.chunk = ''
      try {
        child?.kill()
      } catch (error) {
        job.state.status = 'error'
        job.state.error = `PC 음성 재생 중지 실패: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return this.getState(id)
  }

  close(): void {
    this.closed = true
    this.stop()
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.startNext() })
  }

  private startNext(): void {
    if (this.closed || this.active) return
    const job = this.queue.shift()
    if (!job) return
    const active = { job, child: null as ChildProcessWithoutNullStreams | null, watchdog: null as ReturnType<typeof setTimeout> | null }
    this.active = active
    let finished = false
    let stderr = ''
    const finish = (error?: string) => {
      if (finished) return
      finished = true
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
      let stdout = ''
      const failRunningProcess = (message: string) => {
        if (finished || job.state.status === 'stopped' || job.state.status === 'error') return
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = null
        job.state.status = 'error'
        job.state.error = message
        try { child.kill() } catch { /* Keep the queue blocked until this process actually closes. */ }
      }
      const resetWatchdog = (milliseconds: number) => {
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = setTimeout(() => {
          active.watchdog = null
          failRunningProcess('PC 음성 응답 시간이 초과되었습니다. 다시 질문해 주세요.')
        }, milliseconds)
        active.watchdog.unref()
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (data: string) => {
        stdout += data
        const lines = stdout.split(/\r?\n/u)
        stdout = (lines.pop() ?? '').slice(-8192)
        for (const line of lines) {
          if (finished || job.state.status === 'stopped' || job.state.status === 'error') continue
          try {
            const progress: unknown = JSON.parse(line)
            if (progress && typeof progress === 'object' && 'type' in progress && progress.type === 'chunk' && 'index' in progress && typeof progress.index === 'number' && Number.isInteger(progress.index) && progress.index >= 0 && progress.index < job.chunks.length) {
              job.state.status = 'speaking'
              job.state.chunk = job.chunks[progress.index]
              resetWatchdog(Math.max(15_000, Array.from(job.state.chunk).length * 600))
            }
          } catch { /* Ignore non-protocol output, such as a host initialization message. */ }
        }
      })
      child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-4000) })
      child.on('error', (error) => {
        const message = `PC 음성 재생 실패: ${error.message}`
        if (child.pid) failRunningProcess(message)
        else finish(message)
      })
      child.once('close', (code, signal) => finish(code === 0 ? undefined : stderr.trim() || `PC 음성 재생이 종료되었습니다 (${signal ?? code ?? 'unknown'}).`))
      child.stdin.on('error', (error: Error) => failRunningProcess(`PC 음성 전달 실패: ${error.message}`))
      child.stdout.on('error', (error: Error) => failRunningProcess(`PC 음성 상태 확인 실패: ${error.message}`))
      child.stderr.on('error', (error: Error) => failRunningProcess(`PC 음성 상태 확인 실패: ${error.message}`))
      resetWatchdog(15_000)
      child.stdin.end(JSON.stringify({ chunks: job.chunks }), 'utf8')
    } catch (error) {
      const message = `PC 음성 재생 실패: ${error instanceof Error ? error.message : String(error)}`
      if (active.child) {
        if (active.watchdog) clearTimeout(active.watchdog)
        active.watchdog = null
        job.state.status = 'error'
        job.state.error = message
        try { active.child.kill() } catch { /* Wait for process close before allowing another answer. */ }
      } else finish(message)
    }
  }

  private pruneHistory(): void {
    let removable = [...this.jobs.values()].filter(({ state }) => state.status === 'done' || state.status === 'stopped' || state.status === 'error').length - 200
    for (const [id, job] of this.jobs) {
      if (removable <= 0) break
      if (id !== this.lastId && this.active?.job !== job && ['done', 'stopped', 'error'].includes(job.state.status)) {
        this.jobs.delete(id)
        removable--
      }
    }
  }
}
