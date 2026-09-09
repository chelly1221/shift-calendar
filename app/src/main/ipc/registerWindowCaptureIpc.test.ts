import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle }, BrowserWindow: { fromWebContents: mocks.fromWebContents } }))
import { registerWindowCaptureIpc } from './registerWindowCaptureIpc'

describe('calendar page texture capture', () => {
  beforeEach(() => vi.clearAllMocks())
  function setup() {
    const smaller = { toDataURL: vi.fn(() => 'data:image/png;base64,small') }
    const image = { getSize: () => ({ width: 2600, height: 1800 }), resize: vi.fn(() => smaller), toDataURL: vi.fn() }
    const sender = { isDestroyed: () => false, capturePage: vi.fn(async () => image) }
    mocks.fromWebContents.mockReturnValue({ isDestroyed: () => false, getContentSize: () => [1440, 920] })
    registerWindowCaptureIpc()
    return { sender, image, invoke: (rect: unknown) => mocks.handle.mock.calls[0][1]({ sender }, rect) }
  }
  it('captures only the requesting window region and bounds texture size', async () => {
    const { sender, image, invoke } = setup()
    const rect = { x: 280, y: 52, width: 1160, height: 868 }
    expect(await invoke(rect)).toBe('data:image/png;base64,small')
    expect(mocks.fromWebContents).toHaveBeenCalledExactlyOnceWith(sender)
    expect(sender.capturePage).toHaveBeenCalledExactlyOnceWith(rect)
    expect(image.resize).toHaveBeenCalledWith({ width: 2048, height: 1418 })
  })
  it.each([
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 1441, height: 500 },
    { x: 0, y: 900, width: 30, height: 30 },
    { x: 0, y: 0, width: 8192, height: 8192 },
    { x: 0, y: 0, width: 200, height: 200, windowId: 2 },
  ])('rejects invalid or out-of-window capture %j', async (rect) => {
    const { sender, invoke } = setup()
    await expect(invoke(rect)).rejects.toThrow()
    expect(sender.capturePage).not.toHaveBeenCalled()
  })
})
