import { BrowserWindow, ipcMain } from 'electron'
import { calendarCaptureSchema } from '../../shared/windowCapture'
import { IPC_CHANNELS } from './channels'

export function registerWindowCaptureIpc(): void {
  ipcMain.handle(IPC_CHANNELS.windowCaptureCalendar, async (event, input: unknown) => {
    const rect = calendarCaptureSchema.parse(input)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || event.sender.isDestroyed()) throw new Error('캘린더 창이 없습니다.')
    const [width, height] = window.getContentSize()
    if (rect.x + rect.width > width || rect.y + rect.height > height) throw new Error('캘린더 영역을 벗어났습니다.')
    const image = await event.sender.capturePage(rect)
    const size = image.getSize()
    const ratio = Math.min(1, 2048 / size.width, 1600 / size.height)
    // Only the requesting application's calendar pixels, kept in memory for the page turn.
    return (ratio < 1 ? image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) }) : image).toDataURL()
  })
}
