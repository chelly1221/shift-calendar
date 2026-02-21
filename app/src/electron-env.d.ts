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
    platform: NodeJS.Platform
    minimize: () => void
    maximize: () => void
    close: () => void
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
    onViewportCorrection: (callback: (payload: {
      active: boolean
      offsetX: number
      offsetY: number
      extraWidth: number
      extraHeight: number
    }) => void) => () => void
  }
}
