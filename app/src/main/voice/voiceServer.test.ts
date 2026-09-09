import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceServer, isPrivateIpv4 } from './voiceServer'
import type { VoiceSpeechState } from '../../shared/voice'

vi.mock('node:os', () => ({ hostname: () => 'Test PC', networkInterfaces: () => ({ test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] }) }))
const answer = { status: 'ANSWER' as const, text: '테스트', speech: '테스트', source: 'PC에 저장된 일정 기준' as const, answeredAtUtc: '2026-09-08T01:00:00.000Z', context: null, eventIds: [] }
const query = vi.fn(async () => answer)
let server: VoiceServer | undefined
afterEach(async () => { await server?.stop(); query.mockClear() })
async function setup(discoveryPort = 0) {
  server = new VoiceServer(query, discoveryPort)
  const connection = await server.start()
  return `http://${connection.connections[0].address}`
}

describe('automatic LAN connection', () => {
  it.each(['10.0.0.2', '172.16.1.5', '172.31.2.6', '192.168.1.2', '::ffff:192.168.1.2', '127.0.0.1'])('accepts private address %s', (address) => { expect(isPrivateIpv4(address)).toBe(true) })
  it.each(['8.8.8.8', '172.32.1.5', '192.168.1.256', '::1', 'example.com', '0.0.0.0'])('rejects address %s', (address) => { expect(isPrivateIpv4(address)).toBe(false) })
  it('accepts health and queries without a key', async () => {
    const url = await setup()
    expect(await (await fetch(`${url}/v1/health`)).json()).toEqual({ service: 'shiftcalendar-voice', version: 1, name: 'Test PC' })
    const response = await fetch(`${url}/v1/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '오늘 근무 누구야?' }) })
    expect(response.status).toBe(200); expect(await response.json()).toEqual(answer)
    expect(query).toHaveBeenCalledWith({ text: '오늘 근무 누구야?', timeZone: 'Asia/Seoul', selfName: '' })
  })
  it('rejects browser origins, unsupported routes, extra fields and oversized bodies', async () => {
    const url = await setup()
    const request = (body: string, headers = {}) => fetch(`${url}/v1/query`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    expect((await request('{}', { origin: 'https://example.com' })).status).toBe(403)
    expect((await request(JSON.stringify({ text: '질문', delete: true }))).status).toBe(400)
    expect((await request('{')).status).toBe(400)
    expect((await request('a'.repeat(8200))).status).toBe(413)
    expect((await fetch(`${url}/v1/delete`)).status).toBe(404)
    expect(query).not.toHaveBeenCalled()
  })
  it('answers discovery and releases both sockets when stopped', async () => {
    const client = createSocket('udp4')
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve))
    const port = client.address().port
    await new Promise<void>((resolve) => client.close(resolve))
    const url = await setup(port)
    const receiver = createSocket('udp4')
    try {
      await new Promise<void>((resolve) => receiver.bind(0, '127.0.0.1', resolve))
      const received = new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discovery timed out')), 2000)
        receiver.once('message', (message) => { clearTimeout(timeout); resolve(message) })
      })
      receiver.send('SHIFT_CALENDAR_DISCOVER_V1', port, '127.0.0.1')
      expect(JSON.parse((await received).toString())).toEqual({ service: 'shiftcalendar-voice', version: 1, name: 'Test PC', port: Number(new URL(url).port) })
      await server!.stop()
      expect(server!.getConnection().enabled).toBe(false)
      await server!.start()
      expect(server!.getConnection().enabled).toBe(true)
    } finally { receiver.close() }
  })
})

describe('PC speech output', () => {
  const id = '02b223ec-b8c8-4a62-a01d-91a635d232fd'
  const state: VoiceSpeechState = { id, status: 'queued', text: '테스트', chunk: '' }
  const speech = () => ({ speak: vi.fn((text: string) => ({ ...state, text })), getState: vi.fn(() => state), stop: vi.fn(() => ({ ...state, status: 'stopped' as const })) })
  async function setupSpeech() {
    const output = speech()
    const confirm = vi.fn(async () => answer)
    server = new VoiceServer(query, 0, confirm, output)
    const connection = await server.start()
    const url = `http://${connection.connections[0].address}`
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { output, confirm, url, post }
  }
  it('plays answers on the PC and keeps older Android clients silent', async () => {
    const { output, post } = await setupSpeech()
    const response = await post('/v1/query', { text: '오늘 휴가 누구야?' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...answer, speech: '', playback: state })
    expect(output.speak).toHaveBeenCalledExactlyOnceWith('테스트')
  })
  it('plays confirmation results through the same speaker', async () => {
    const { output, confirm, post } = await setupSpeech()
    const response = await post('/v1/confirm', { confirmationId: id, confirm: true })
    expect(response.status).toBe(200)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(id, true)
    expect(output.speak).toHaveBeenCalledExactlyOnceWith('테스트')
  })
  it('finishes silent commands immediately without touching playback or its queue', async () => {
    const { output, post } = await setupSpeech()
    query.mockResolvedValueOnce({ ...answer, text: '', speech: '' })
    const response = await post('/v1/query', { text: '다음 달 보여줘' })
    expect(await response.json()).toEqual({ ...answer, text: '', speech: '',
      playback: { id: null, status: 'done', text: '', chunk: '' } })
    expect(output.speak).not.toHaveBeenCalled()
    expect(output.getState).not.toHaveBeenCalled()
    expect(output.stop).not.toHaveBeenCalled()
    await post('/v1/query', { text: '오늘 휴가 누구야?' })
    expect(output.speak).toHaveBeenCalledExactlyOnceWith('테스트')
  })
  it('polls playback independently without exhausting the question rate limit', async () => {
    const { output, url, post } = await setupSpeech()
    for (let index = 0; index < 65; index++) expect((await fetch(`${url}/v1/speech?id=${id}`)).status).toBe(200)
    expect(output.getState).toHaveBeenCalledWith(id)
    expect((await post('/v1/query', { text: '내일 근무 누구야?' })).status).toBe(200)
    expect((await fetch(`${url}/v1/speech?id=invalid`)).status).toBe(400)
  })
  it('supports replaying a long answer and stopping it', async () => {
    const { output, post } = await setupSpeech()
    const longAnswer = '9월 16일 김수헌 연차\n'.repeat(2000)
    expect((await post('/v1/speech', { action: 'speak', text: longAnswer })).status).toBe(200)
    expect(output.speak).toHaveBeenCalledExactlyOnceWith(longAnswer.trim())
    const stopped = await post('/v1/speech', { action: 'stop', id })
    expect((await stopped.json()).status).toBe('stopped')
    expect(output.stop).toHaveBeenCalledWith(id)
    expect(query).not.toHaveBeenCalled()
  })
  it('validates speech commands and blocks browser origins', async () => {
    const { output, url, post } = await setupSpeech()
    expect((await post('/v1/speech', { action: 'speak', text: '' })).status).toBe(400)
    expect((await post('/v1/speech', { action: 'stop', id: 'other' })).status).toBe(400)
    expect((await post('/v1/speech', { action: 'speak', text: '말해줘', shell: 'command' })).status).toBe(400)
    expect((await fetch(`${url}/v1/speech?id=${id}`, { headers: { origin: 'https://example.com' } })).status).toBe(403)
    expect(output.speak).not.toHaveBeenCalled()
  })
  it('stops pending audio when the voice server closes', async () => {
    const { output } = await setupSpeech()
    await server!.stop()
    expect(output.stop).toHaveBeenCalledWith()
  })
})
