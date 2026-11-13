import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { registerWindowCloseCheckpoint } from '../src/main/window-state-persistence.js'

afterEach(() => { vi.restoreAllMocks() })

/** A workbench window whose close follows Electron: listeners run in order and may prevent it. */
function workbenchWindow() {
  const windowEvents = new EventEmitter(), contentsEvents = new EventEmitter()
  let destroyed = false
  const executeJavaScript = vi.fn(async (_script: string) => {})
  const window = Object.assign(windowEvents, {
    isDestroyed: () => destroyed,
    webContents: Object.assign(contentsEvents, { isDestroyed: () => destroyed, isCrashed: () => false, executeJavaScript })
  }) as unknown as BrowserWindow
  const close = vi.fn(() => { if (!requestClose()) destroyed = true })
  Object.assign(window, { close })
  /** Emit 'close' as the user's click does; false means a listener kept the window. */
  function requestClose(): boolean {
    const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true } }
    windowEvents.emit('close', event)
    return event.defaultPrevented
  }
  return { window, executeJavaScript, close, requestClose, destroyed: () => destroyed }
}
const saves = (calls: unknown[][]) => calls.filter(([script]) => String(script).includes('agentmuxPrepareRendererUpdate'))

it('holds the close until the Renderer has saved its batch, then closes', async () => {
  const w = workbenchWindow()
  let finish!: () => void
  w.executeJavaScript.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  registerWindowCloseCheckpoint(w.window, () => false)
  expect(w.requestClose()).toBe(true)
  expect(saves(w.executeJavaScript.mock.calls)).toEqual([['window.agentmuxPrepareRendererUpdate("quit")']])
  // A second click while saving neither closes nor saves again.
  expect(w.requestClose()).toBe(true); expect(saves(w.executeJavaScript.mock.calls)).toHaveLength(1)
  expect(w.close).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(w.destroyed()).toBe(true))
  expect(w.close).toHaveBeenCalledTimes(1)
})

it('keeps the window open with the save warning when the save fails, and a second close closes it', async () => {
  const w = workbenchWindow()
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  w.executeJavaScript.mockRejectedValueOnce(new Error('Storage is unavailable'))
  registerWindowCloseCheckpoint(w.window, () => false)
  expect(w.requestClose()).toBe(true)
  await vi.waitFor(() => expect(w.executeJavaScript.mock.calls.some(([script]) => String(script).includes('agentmux-workbench-save-error'))).toBe(true))
  const warning = w.executeJavaScript.mock.calls.map(([script]) => String(script)).find(script => script.includes('agentmux-workbench-save-error'))!
  expect(warning).toContain('Storage is unavailable'); expect(warning).toContain('kept open')
  expect(stderr).toHaveBeenCalled()
  expect(w.destroyed()).toBe(false); expect(w.close).not.toHaveBeenCalled()
  expect(w.requestClose()).toBe(false)
  expect(saves(w.executeJavaScript.mock.calls)).toHaveLength(1)
})

it('leaves a close that is part of quitting, or that another owner kept, to that owner', () => {
  const quitting = workbenchWindow()
  registerWindowCloseCheckpoint(quitting.window, () => true)
  expect(quitting.requestClose()).toBe(false)
  expect(quitting.executeJavaScript).not.toHaveBeenCalled()
  // Detached windows remain: their owner hides the main window first, keeping its Renderer.
  const hidden = workbenchWindow()
  hidden.window.on('close', (event: { preventDefault(): void }) => event.preventDefault())
  registerWindowCloseCheckpoint(hidden.window, () => false)
  expect(hidden.requestClose()).toBe(true)
  expect(hidden.executeJavaScript).not.toHaveBeenCalled()
})
