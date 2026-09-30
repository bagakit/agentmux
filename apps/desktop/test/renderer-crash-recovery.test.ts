import { EventEmitter } from 'node:events'
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerRendererCrashRecovery } from '../src/main/renderer-crash-recovery.js'
import { applicationMenuTemplate } from '../src/main/application-menu.js'

function fixture() {
  const windowEvents = new EventEmitter()
  const contentsEvents = new EventEmitter()
  let crashed = false
  let quitting = false
  const reload = vi.fn(() => { crashed = false })
  const requestQuit = vi.fn()
  const showMessageBox = vi.fn(async () => ({ response: 2, checkboxChecked: false }))
  const window = Object.assign(windowEvents, {
    isDestroyed: () => false,
    reload,
    webContents: Object.assign(contentsEvents, {
      isDestroyed: () => false,
      isCrashed: () => crashed
    })
  }) as unknown as BrowserWindow
  const recover = registerRendererCrashRecovery(window, { showMessageBox } as unknown as Dialog, requestQuit, () => quitting)
  return { windowEvents, contentsEvents, reload, requestQuit, showMessageBox, recover,
    crash: () => { crashed = true; contentsEvents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 }) },
    setQuitting: () => { quitting = true }, setRecovered: () => { crashed = false } }
}

describe('Main-owned renderer crash recovery', () => {
  it('offers native recovery on actual Renderer gone without relying on Renderer JavaScript', async () => {
    const f = fixture()
    f.crash()
    await f.recover()
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
    const [window, options] = f.showMessageBox.mock.calls[0] as unknown as [BrowserWindow, MessageBoxOptions]
    expect(window.webContents.isCrashed()).toBe(true)
    expect(options.buttons).toEqual(['Reload interface', 'Quit AgentMux', 'Keep window'])
    expect(options.cancelId).toBe(2)
    expect(options.detail).toContain('not saved may be lost')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
  })

  it('reloads the original window only after the explicit reload action', async () => {
    const f = fixture()
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    f.crash()
    await f.recover()
    expect(f.reload).toHaveBeenCalledTimes(1)
    expect(f.requestQuit).not.toHaveBeenCalled()
    await f.recover()
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('hands explicit Quit to the ordinary application owner', async () => {
    const f = fixture()
    f.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    f.crash()
    await f.recover()
    expect(f.requestQuit).toHaveBeenCalledTimes(1)
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('does not apply a stale reload action after the original interface recovered while the notice was open', async () => {
    const f = fixture()
    let choose: (response: { response: number; checkboxChecked: boolean }) => void = () => {}
    f.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { choose = resolve }))
    f.crash()
    const notice = f.recover()
    f.setRecovered()
    choose({ response: 0, checkboxChecked: false })
    await notice
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
  })

  it('does not claim that a healthy or merely unresponsive Renderer crashed', async () => {
    const f = fixture()
    f.contentsEvents.emit('unresponsive')
    f.windowEvents.emit('focus')
    await f.recover()
    expect(f.showMessageBox).not.toHaveBeenCalled()
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
  })

  it('keeps canceled recovery reachable through the existing native menu without a reload accelerator', async () => {
    const f = fixture()
    f.crash()
    await f.recover()
    const menu = applicationMenuTemplate(true, undefined, () => { void f.recover() })
    const view = menu.find(item => item.label === 'View')
    expect(Array.isArray(view?.submenu)).toBe(true)
    const item = (view!.submenu as import('electron').MenuItemConstructorOptions[]).find(item => item.label === 'Recover interface')
    expect(item).toBeDefined()
    expect(item?.accelerator).toBeUndefined()
    item!.click!({} as never, {} as never, {} as never)
    await f.recover()
    expect(f.showMessageBox).toHaveBeenCalledTimes(2)
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('does not reopen a crash notice during owner disposal, and unregisters on close', async () => {
    const f = fixture()
    f.setQuitting()
    f.crash()
    await f.recover()
    expect(f.showMessageBox).not.toHaveBeenCalled()
    Object.defineProperty(f.windowEvents, 'webContents', { get: () => undefined })
    f.windowEvents.emit('closed')
    expect(f.contentsEvents.listenerCount('render-process-gone')).toBe(0)
    expect(f.windowEvents.listenerCount('focus')).toBe(0)
  })
})
