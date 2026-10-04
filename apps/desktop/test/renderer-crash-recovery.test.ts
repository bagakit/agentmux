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
  let destroyed = false
  const reload = vi.fn(() => { crashed = false })
  const executeJavaScript = vi.fn(async () => {})
  const requestQuit = vi.fn()
  const showMessageBox = vi.fn(async (_window: BrowserWindow, _options: MessageBoxOptions) => ({ response: 2, checkboxChecked: false }))
  const window = Object.assign(windowEvents, {
    isDestroyed: () => destroyed,
    reload,
    webContents: Object.assign(contentsEvents, {
      isDestroyed: () => false,
      isCrashed: () => crashed,
      executeJavaScript
    })
  }) as unknown as BrowserWindow
  const recover = registerRendererCrashRecovery(window, { showMessageBox } as unknown as Dialog, requestQuit, () => quitting)
  return { windowEvents, contentsEvents, reload, requestQuit, showMessageBox, recover, executeJavaScript,
    crash: () => { crashed = true; contentsEvents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 }) },
    setQuitting: () => { quitting = true }, setDestroyed: () => { destroyed = true }, setRecovered: () => { crashed = false } }
}

describe('Main-owned renderer crash recovery', () => {
  it('offers native recovery on actual Renderer gone without relying on Renderer JavaScript', async () => {
    const f = fixture()
    f.crash()
    await f.recover()
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
    expect(f.executeJavaScript).not.toHaveBeenCalled()
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
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
    expect(f.executeJavaScript).not.toHaveBeenCalled()
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

  it('does not automatically claim that a healthy or merely unresponsive Renderer crashed', async () => {
    const f = fixture()
    f.contentsEvents.emit('unresponsive')
    f.windowEvents.emit('focus')
    expect(f.showMessageBox).not.toHaveBeenCalled()
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
  })

  it('offers explicit recovery for a live blank interface and saves before reloading', async () => {
    const f = fixture()
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    let saved: () => void = () => {}
    f.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { saved = resolve }))
    const recovering = f.recover()
    await vi.waitFor(() => expect(f.executeJavaScript).toHaveBeenCalledWith('window.agentmuxPrepareRendererUpdate("reload")'))
    expect(f.reload).not.toHaveBeenCalled()
    const options = f.showMessageBox.mock.calls[0]![1]
    expect(options.message).toBe('Recover the interface')
    expect(options.detail).toContain('unknown')
    saved()
    await recovering
    expect(f.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the original live window on save failure and permits a later retry', async () => {
    const f = fixture()
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    f.executeJavaScript.mockRejectedValueOnce(new Error('Storage is unavailable'))
    await f.recover()
    expect(f.showMessageBox).toHaveBeenCalledTimes(2)
    const failure = f.showMessageBox.mock.calls[1]![1]
    expect(failure.message).toBe('The workbench save is unconfirmed')
    expect(failure.detail).toContain('original window was kept')
    expect(failure.detail).toContain('Storage is unavailable')
    expect(failure.detail).toContain('View → Recover interface')
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await f.recover()
    expect(f.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(f.reload).toHaveBeenCalledTimes(1)
  })

  it('ends a pending live save when the Renderer actually goes away and reloads the same window', async () => {
    const f = fixture()
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    f.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}))
    const recovering = f.recover()
    await vi.waitFor(() => expect(f.executeJavaScript).toHaveBeenCalledTimes(1))
    f.crash()
    await recovering
    expect(f.reload).toHaveBeenCalledTimes(1)
    expect(f.showMessageBox).toHaveBeenCalledTimes(1)
    expect(f.requestQuit).not.toHaveBeenCalled()
    expect(f.contentsEvents.listenerCount('render-process-gone')).toBe(1)
  })

  it.each(['quit', 'destroy'] as const)('does not reload after %s while the save checkpoint is pending', async (state) => {
    const f = fixture()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    f.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    let saved: () => void = () => {}
    f.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { saved = resolve }))
    const recovering = f.recover()
    await vi.waitFor(() => expect(f.executeJavaScript).toHaveBeenCalledTimes(1))
    if (state === 'quit') f.setQuitting()
    else {
      f.setDestroyed()
      Object.defineProperty(f.windowEvents, 'webContents', { get: () => { throw new Error('Object has been destroyed') } })
    }
    saved()
    await recovering
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.requestQuit).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    stderr.mockRestore()
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
