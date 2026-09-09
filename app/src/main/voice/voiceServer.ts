import { createServer, type Server } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces, hostname } from 'node:os'
import { voiceQuerySchema, voiceAnswerSchema, voiceConfirmSchema, voiceSpeechRequestSchema, voiceSpeechStateSchema, type VoiceAnswer, type VoiceConnection, type VoiceQuery, type VoiceSpeechState } from '../../shared/voice'

interface VoiceSpeechOutput {
  speak(text: string): VoiceSpeechState
  getState(id?: string): VoiceSpeechState
  stop(id?: string): VoiceSpeechState
}

export function isPrivateIpv4(address: string): boolean {
  const raw = address.replace(/^::ffff:/, '')
  const parts = raw.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127
}

export class VoiceServer {
  private server: Server | null = null
  private discovery: Socket | null = null
  private port = 0
  private starting: Promise<VoiceConnection> | null = null

  constructor(private readonly query: (query: VoiceQuery) => Promise<VoiceAnswer>, private readonly discoveryPort = 43827,
    private readonly confirm?: (id: string, confirm: boolean) => Promise<VoiceAnswer>, private readonly speech?: VoiceSpeechOutput) {}

  private prepareAnswer(answer: VoiceAnswer): VoiceAnswer {
    const parsed = voiceAnswerSchema.parse(answer)
    // A completed screen command has no utterance. A terminal playback result
    // also lets installed phone clients resume listening without polling or TTS.
    if (!parsed.speech.trim()) return {
      ...parsed, speech: '', playback: { id: null, status: 'done', text: '', chunk: '' },
    }
    if (!this.speech) return parsed
    const playback = this.speech.speak(parsed.speech)
    // Older Android clients ignore playback; blank speech prevents duplicate phone audio.
    return voiceAnswerSchema.parse({ ...parsed, speech: '', playback })
  }

  getConnection(): VoiceConnection {
    if (!this.server?.listening) return { enabled: false, connections: [] }
    const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter((item) => item?.family === 'IPv4' && !item.internal && isPrivateIpv4(item.address)).map((item) => item!.address))]
    return {
      enabled: true,
      connections: addresses.map((address) => ({ address: `${address}:${this.port}` })),
    }
  }

  async start(): Promise<VoiceConnection> {
    if (this.starting) return this.starting
    if (this.server?.listening) return this.getConnection()
    this.starting = this.listen()
    try { return await this.starting } finally { this.starting = null }
  }

  private async listen(): Promise<VoiceConnection> {
    let requests = 0
    let windowStart = Date.now()
    let speechPolls = 0
    let speechWindowStart = Date.now()
    let busy = false
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      const send = (status: number, value: unknown) => { if (!response.destroyed) { response.writeHead(status); response.end(JSON.stringify(value)) } }
      if (!isPrivateIpv4(request.socket.remoteAddress ?? '') || request.headers.origin) { send(403, { error: '같은 와이파이의 앱에서 연결해 주세요.' }); return }
      const [pathname, search = ''] = (request.url ?? '/').split('?')
      if (request.method === 'GET' && pathname === '/v1/speech') {
        if (!this.speech) { send(404, { error: 'PC 음성 출력을 지원하지 않습니다. PC 앱을 업데이트해 주세요.' }); return }
        if (Date.now() - speechWindowStart >= 60_000) { speechPolls = 0; speechWindowStart = Date.now() }
        if (++speechPolls > 600) { send(429, { error: '음성 상태 조회가 너무 많습니다.' }); return }
        const id = new URLSearchParams(search).get('id') ?? undefined
        if (id && !voiceSpeechStateSchema.shape.id.safeParse(id).success) { send(400, { error: '음성 재생 번호가 올바르지 않습니다.' }); return }
        send(200, voiceSpeechStateSchema.parse(this.speech.getState(id)))
        return
      }
      if (Date.now() - windowStart >= 60_000) { requests = 0; windowStart = Date.now() }
      if (++requests > 60) { send(429, { error: '질문이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }); return }
      if (request.method === 'GET' && request.url === '/v1/health') { send(200, { service: 'shiftcalendar-voice', version: 1, name: hostname() }); return }
      if (request.method !== 'POST' || !['/v1/query', '/v1/confirm', '/v1/speech'].includes(request.url ?? '')) { send(404, { error: '지원하지 않는 요청입니다.' }); return }
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) { send(415, { error: 'JSON 형식이 필요합니다.' }); return }
      const isSpeech = request.url === '/v1/speech'
      if (isSpeech && !this.speech) { send(404, { error: 'PC 음성 출력을 지원하지 않습니다. PC 앱을 업데이트해 주세요.' }); return }
      if (busy && !isSpeech) { send(429, { error: '다른 질문을 처리 중입니다. 잠시 후 다시 시도해 주세요.' }); return }
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > (isSpeech ? 1_048_576 : 8192)) { send(413, { error: '질문이 너무 깁니다.' }); return }
          chunks.push(buffer)
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (isSpeech) {
          const parsed = voiceSpeechRequestSchema.safeParse(payload)
          if (!parsed.success) { send(400, { error: '음성 재생 요청이 올바르지 않습니다.' }); return }
          const state = parsed.data.action === 'speak' ? this.speech!.speak(parsed.data.text) : this.speech!.stop(parsed.data.id)
          send(200, voiceSpeechStateSchema.parse(state))
          return
        }
        const parsed = request.url === '/v1/confirm' ? voiceConfirmSchema.safeParse(payload) : voiceQuerySchema.safeParse(payload)
        if (!parsed.success) { send(400, { error: '질문 형식을 확인해 주세요.' }); return }
        // Recheck after reading the body; requests can arrive concurrently.
        if (busy) { send(429, { error: '다른 질문을 처리 중입니다.' }); return }
        busy = true
        try {
          if ('confirmationId' in parsed.data) {
            if (!this.confirm) { send(404, { error: '일정 조작을 지원하지 않는 PC 버전입니다.' }); return }
            send(200, this.prepareAnswer(await this.confirm(parsed.data.confirmationId, parsed.data.confirm)))
          } else send(200, this.prepareAnswer(await this.query(parsed.data)))
        }
        finally { busy = false }
      } catch (error) {
        send(error instanceof SyntaxError ? 400 : 503, { error: error instanceof SyntaxError ? '질문 형식이 올바르지 않습니다.' : 'PC 일정 데이터를 읽을 수 없습니다. PC 앱 상태를 확인해 주세요.' })
      }
    })
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.timeout = 15_000
    server.maxHeadersCount = 20
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', () => { server.removeListener('error', reject); resolve() })
      })
    } catch (error) { server.close(); throw error }
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('연결 포트를 열 수 없습니다.') }
    server.on('error', () => { void this.stop() })
    this.port = address.port
    this.server = server
    const discovery = createSocket('udp4')
    try {
      await new Promise<void>((resolve, reject) => {
        discovery.once('error', reject)
        discovery.bind(this.discoveryPort, '0.0.0.0', () => { discovery.removeListener('error', reject); resolve() })
      })
      let discoveries = 0
      let discoveryWindow = Date.now()
      discovery.on('message', (message, remote) => {
        if (message.toString('utf8') !== 'SHIFT_CALENDAR_DISCOVER_V1' || !isPrivateIpv4(remote.address)) return
        if (Date.now() - discoveryWindow > 60_000) { discoveries = 0; discoveryWindow = Date.now() }
        if (++discoveries > 120) return
        const data = Buffer.from(JSON.stringify({ service: 'shiftcalendar-voice', version: 1, name: hostname(), port: this.port }))
        discovery.send(data, remote.port, remote.address, () => undefined)
      })
      discovery.on('error', () => { /* Keep HTTP available; report discovery errors on the next restart. */ })
      this.discovery = discovery
    } catch (error) {
      discovery.close(); server.closeAllConnections(); server.close(); this.server = null
      throw error
    }
    return this.getConnection()
  }

  async stop(): Promise<VoiceConnection> {
    if (this.starting) await this.starting.catch(() => undefined)
    const server = this.server
    this.server = null
    this.discovery?.close()
    this.discovery = null
    this.port = 0
    this.speech?.stop()
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    return this.getConnection()
  }
}
