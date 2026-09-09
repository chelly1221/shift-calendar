import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { VOICE_CHANNELS, voiceConnectionSchema, voiceControlSchema, type VoiceControl } from '../../shared/voice'
import { listCalendarEvents } from '../db/eventRepository'
import { getShiftSettings } from '../db/settingRepository'
import { VoiceServer } from '../voice/voiceServer'
import { VoiceCommandService } from '../voice/voiceCommandService'
import { PcSpeechPlayback } from '../voice/pcSpeechPlayback'
import { executeCalendarDelete, executeCalendarUpsert } from './registerCalendarIpc'
import { runSyncNow } from '../sync/syncEngine'

const pendingControls = new Map<string, { senderId: number; done: (text: string, failed: boolean) => void }>()

async function controlPc(input: VoiceControl): Promise<string> {
  const control = voiceControlSchema.parse(input)
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!window || window.webContents.isDestroyed()) throw new Error('PC 캘린더 창이 없습니다.')
  if (control.type !== 'REFRESH') {
    if (window.isMinimized()) window.restore()
    window.show()
  }
  const id = randomUUID()
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { pendingControls.delete(id); reject(new Error('PC 화면 응답 시간 초과')) }, 5000)
    pendingControls.set(id, { senderId: window.webContents.id, done: (text, failed) => {
      clearTimeout(timer); pendingControls.delete(id)
      if (failed) reject(new Error(text)); else resolve(text)
    } })
    window.webContents.send(VOICE_CHANNELS.control, { id, control })
  })
}

const commands = new VoiceCommandService({
  events: listCalendarEvents, settings: getShiftSettings,
  upsert: executeCalendarUpsert, remove: executeCalendarDelete, control: controlPc,
  sync: async () => {
    void runSyncNow().then(() => controlPc({ type: 'REFRESH' })).catch((error) => console.error('휴대폰에서 요청한 동기화:', error))
    return '동기화를 요청했습니다. PC의 동기화 화면에서 결과를 확인해 주세요.'
  },
})
const pcSpeech = new PcSpeechPlayback()
export const voiceServer = new VoiceServer((query) => commands.query(query), 43827, (id, confirm) => commands.confirm(id, confirm), pcSpeech)

export function registerVoiceIpc(): void {
  ipcMain.removeAllListeners(VOICE_CHANNELS.controlResult)
  ipcMain.on(VOICE_CHANNELS.controlResult, (event, payload: unknown) => {
    const parsed = z.object({ id: z.string().uuid(), text: z.string().max(1000), failed: z.boolean() }).strict().safeParse(payload)
    if (!parsed.success) return
    const pending = pendingControls.get(parsed.data.id)
    if (pending?.senderId === event.sender.id) pending.done(parsed.data.text, parsed.data.failed)
  })
  ipcMain.removeHandler(VOICE_CHANNELS.getConnection)
  ipcMain.removeHandler(VOICE_CHANNELS.setEnabled)
  ipcMain.handle(VOICE_CHANNELS.getConnection, () => voiceConnectionSchema.parse(voiceServer.getConnection()))
  ipcMain.handle(VOICE_CHANNELS.setEnabled, async (_event, payload: unknown) => {
    const enabled = z.boolean().parse(payload)
    if (!enabled) commands.clear()
    return voiceConnectionSchema.parse(await (enabled ? voiceServer.start() : voiceServer.stop()))
  })
}
