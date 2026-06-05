/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    APP_ROOT: string
    VITE_PUBLIC: string
    VITE_DEV_SERVER_URL?: string
  }
}

interface Window {
  calendarApi: import('./shared/calendar').CalendarApi
  windowApi: {
    minimize: () => void
    maximize: () => void
    close: () => void
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
  }
}
