import 'dotenv/config'
import './bootstrapEnv'
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSetting } from './db/settingRepository'
import { IPC_CHANNELS } from './ipc/channels'
import { registerCalendarIpc } from './ipc/registerCalendarIpc'
import { startOutboxWorker } from './sync/outboxWorker'
import { runSyncNow } from './sync/syncEngine'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = process.env.APP_ROOT ?? path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const appRoot = process.env.APP_ROOT ?? path.join(__dirname, '..')
const RENDERER_DIST = path.join(appRoot, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(appRoot, 'public')
  : RENDERER_DIST

let syncTimer: NodeJS.Timeout | null = null

interface WindowViewportCorrectionPayload {
  active: boolean
  offsetX: number
  offsetY: number
  extraWidth: number
  extraHeight: number
}

function isWindowExpandedForUi(window: BrowserWindow): boolean {
  return window.isFullScreen() || window.isMaximized()
}

function getWindowViewportCorrection(window: BrowserWindow): WindowViewportCorrectionPayload {
  if (!isWindowExpandedForUi(window)) {
    return {
      active: false,
      offsetX: 0,
      offsetY: 0,
      extraWidth: 0,
      extraHeight: 0,
    }
  }

  const bounds = window.getBounds()
  const contentBounds = window.getContentBounds()
  const insetLeft = Math.max(0, contentBounds.x - bounds.x)
  const insetTop = Math.max(0, contentBounds.y - bounds.y)
  const insetRight = Math.max(
    0,
    bounds.x + bounds.width - (contentBounds.x + contentBounds.width),
  )
  const insetBottom = Math.max(
    0,
    bounds.y + bounds.height - (contentBounds.y + contentBounds.height),
  )
  const hasInset = insetLeft > 0 || insetTop > 0 || insetRight > 0 || insetBottom > 0

  return {
    active: hasInset,
    offsetX: -insetLeft,
    offsetY: -insetTop,
    extraWidth: insetLeft + insetRight,
    extraHeight: insetTop + insetBottom,
  }
}

function sendWindowMaximizeChanged(window: BrowserWindow): void {
  window.webContents.send(IPC_CHANNELS.windowMaximizeChanged, isWindowExpandedForUi(window))
}

function sendWindowViewportCorrection(window: BrowserWindow): void {
  window.webContents.send(
    IPC_CHANNELS.windowViewportCorrection,
    getWindowViewportCorrection(window),
  )
}

function sendWindowUiState(window: BrowserWindow): void {
  sendWindowMaximizeChanged(window)
  sendWindowViewportCorrection(window)
}

function toggleWindowMaximize(window: BrowserWindow): void {
  if (window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }
}

function createMainWindow(): BrowserWindow {
  const platformWindowOptions = process.platform === 'win32'
    ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: false,
        backgroundMaterial: 'none' as const,
      }
    : process.platform === 'linux'
      ? {
          titleBarStyle: 'hidden' as const,
      }
      : {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 20, y: 18 },
        }

  const window = new BrowserWindow({
    title: '교대근무 일정관리',
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    autoHideMenuBar: true,
    ...platformWindowOptions,
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.on('maximize', () => {
    sendWindowUiState(window)
  })
  window.on('unmaximize', () => {
    sendWindowUiState(window)
  })
  window.on('enter-full-screen', () => {
    sendWindowUiState(window)
  })
  window.on('leave-full-screen', () => {
    sendWindowUiState(window)
  })
  window.on('resize', () => {
    sendWindowViewportCorrection(window)
  })
  window.on('move', () => {
    sendWindowViewportCorrection(window)
  })

  void window.webContents.setVisualZoomLevelLimits(1, 1).catch((error) => {
    console.warn('Failed to lock visual zoom limits:', error)
  })
  window.webContents.on('zoom-changed', (event) => {
    event.preventDefault()
    window.webContents.setZoomFactor(1)
  })
  window.webContents.on('before-input-event', (event, input) => {
    const isZoomShortcut = (input.control || input.meta)
      && (input.key === '+' || input.key === '=' || input.key === '-' || input.key === '0')
    if (isZoomShortcut) {
      event.preventDefault()
      window.webContents.setZoomFactor(1)
    }
  })
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomFactor(1)
    window.webContents.setZoomLevel(0)
    sendWindowUiState(window)
  })

  if (VITE_DEV_SERVER_URL) {
    window.loadURL(VITE_DEV_SERVER_URL)
  } else {
    window.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  return window
}

app.whenReady().then(() => {
  app.setName('교대근무 일정관리')
  void ensureSetting()
  registerCalendarIpc()

  ipcMain.on(IPC_CHANNELS.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on(IPC_CHANNELS.windowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      toggleWindowMaximize(win)
    }
  })
  ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  startOutboxWorker()
  void runSyncNow().catch((error) => {
    console.error('Initial sync failed:', error)
  })

  syncTimer = setInterval(() => {
    void runSyncNow().catch((error) => {
      console.error('Scheduled sync failed:', error)
    })
  }, 60_000)

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
