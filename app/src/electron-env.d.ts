/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    APP_ROOT: string
    VITE_PUBLIC: string
    VITE_DEV_SERVER_URL?: string
  }
}

interface Window {
  voiceApi: import('./shared/voice').VoiceApi
  calendarApi: import('./shared/calendar').CalendarApi
  windowApi: {
    captureCalendar: (rect: import('./shared/windowCapture').CalendarCaptureRect) => Promise<string>
    minimize: () => void
    maximize: () => void
    close: () => void
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
  }
}
