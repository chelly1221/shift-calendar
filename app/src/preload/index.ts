import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../main/ipc/channels'
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
  syncNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncNow) as Promise<SyncResult>,
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
}

contextBridge.exposeInMainWorld('calendarApi', calendarApi)

contextBridge.exposeInMainWorld('windowApi', {
  platform: process.platform,
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
  onViewportCorrection: (
    callback: (payload: {
      active: boolean
      offsetX: number
      offsetY: number
      extraWidth: number
      extraHeight: number
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        active: boolean
        offsetX: number
        offsetY: number
        extraWidth: number
        extraHeight: number
      },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.windowViewportCorrection, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.windowViewportCorrection, handler)
    }
  },
})
