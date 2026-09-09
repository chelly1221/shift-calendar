import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../main/ipc/channels'
import { VOICE_CHANNELS, voiceControlSchema, type VoiceApi } from '../shared/voice'
import type { CalendarCaptureRect } from '../shared/windowCapture'
import type {
  CancelOutboxJobInput,
  CalendarApi,
  CalendarEvent,
  DeleteCalendarEventInput,
  ForcePushResult,
  GoogleCalendarItem,
  GoogleConnectionStatus,
  GoogleOAuthConfig,
  ListOutboxJobsInput,
  ListEventsInput,
  OutboxJobItem,
  SetGoogleOAuthConfigInput,
  SetSelectedCalendarInput,
  SetShiftSettingsInput,
  SelectedCalendar,
  ShiftSettings,
  SyncResult,
  UpsertCalendarEventInput,
} from '../shared/calendar'

const calendarApi: CalendarApi = {
  listEvents: (input?: ListEventsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listEvents, input) as Promise<CalendarEvent[]>,
  upsertEvent: (payload: UpsertCalendarEventInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.upsertEvent, payload) as Promise<CalendarEvent>,
  deleteEvent: (payload: DeleteCalendarEventInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteEvent, payload) as Promise<boolean>,
  getOutboxCount: () => ipcRenderer.invoke(IPC_CHANNELS.getOutboxCount) as Promise<number>,
  listOutboxJobs: (input?: ListOutboxJobsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listOutboxJobs, input) as Promise<OutboxJobItem[]>,
  cancelOutboxJob: (input: CancelOutboxJobInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelOutboxJob, input) as Promise<boolean>,
  requeueFailedJobs: () =>
    ipcRenderer.invoke(IPC_CHANNELS.requeueFailedJobs) as Promise<number>,
  syncNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncNow) as Promise<SyncResult>,
  manualSyncNow: () => ipcRenderer.invoke(IPC_CHANNELS.manualSyncNow) as Promise<SyncResult>,
  forcePushAll: () => ipcRenderer.invoke(IPC_CHANNELS.forcePushAll) as Promise<ForcePushResult>,
  connectGoogle: () =>
    ipcRenderer.invoke(IPC_CHANNELS.connectGoogle) as Promise<GoogleConnectionStatus>,
  disconnectGoogle: () =>
    ipcRenderer.invoke(IPC_CHANNELS.disconnectGoogle) as Promise<GoogleConnectionStatus>,
  getGoogleConnectionStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getGoogleConnectionStatus) as Promise<GoogleConnectionStatus>,
  listGoogleCalendars: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listGoogleCalendars) as Promise<GoogleCalendarItem[]>,
  getSelectedCalendar: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSelectedCalendar) as Promise<SelectedCalendar>,
  setSelectedCalendar: (payload: SetSelectedCalendarInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSelectedCalendar, payload) as Promise<SelectedCalendar>,
  getShiftSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getShiftSettings) as Promise<ShiftSettings>,
  setShiftSettings: (payload: SetShiftSettingsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setShiftSettings, payload) as Promise<ShiftSettings>,
  getGoogleOAuthConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getGoogleOAuthConfig) as Promise<GoogleOAuthConfig>,
  setGoogleOAuthConfig: (payload: SetGoogleOAuthConfigInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setGoogleOAuthConfig, payload) as Promise<GoogleOAuthConfig>,
  exportDatabase: () =>
    ipcRenderer.invoke(IPC_CHANNELS.exportDatabase) as Promise<boolean>,
  importDatabase: () =>
    ipcRenderer.invoke(IPC_CHANNELS.importDatabase) as Promise<boolean>,
  onGoogleAuthRequired: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.googleAuthRequired, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.googleAuthRequired, handler)
    }
  },
}

contextBridge.exposeInMainWorld('calendarApi', calendarApi)

const voiceApi: VoiceApi = {
  getConnection: () => ipcRenderer.invoke(VOICE_CHANNELS.getConnection),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke(VOICE_CHANNELS.setEnabled, enabled),
  onControl: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; control: unknown }) => {
      const control = voiceControlSchema.safeParse(payload?.control)
      if (!control.success || typeof payload.id !== 'string') return
      void callback(control.data).then(
        (text) => ipcRenderer.send(VOICE_CHANNELS.controlResult, { id: payload.id, text, failed: false }),
        () => ipcRenderer.send(VOICE_CHANNELS.controlResult, { id: payload.id, text: 'PC 화면 처리 실패', failed: true }),
      )
    }
    ipcRenderer.on(VOICE_CHANNELS.control, handler)
    return () => ipcRenderer.removeListener(VOICE_CHANNELS.control, handler)
  },
}
contextBridge.exposeInMainWorld('voiceApi', voiceApi)

contextBridge.exposeInMainWorld('windowApi', {
  captureCalendar: (rect: CalendarCaptureRect) => ipcRenderer.invoke(IPC_CHANNELS.windowCaptureCalendar, rect) as Promise<string>,
  minimize: () => ipcRenderer.send(IPC_CHANNELS.windowMinimize),
  maximize: () => ipcRenderer.send(IPC_CHANNELS.windowMaximize),
  close: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
  onMaximizeChanged: (callback: (isMaximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on(IPC_CHANNELS.windowMaximizeChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.windowMaximizeChanged, handler)
    }
  },
})
