import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindMobileViewport, bindNativeDevice, createNativePlatform, pickLocalAttachment, type NativeDevicePorts } from '../src/platform/native/device'
import { createBrowserPlatform } from '../src/platform/browser'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function device(late = false) {
  const callbacks = new Map<string, (value: any) => void>()
  const removed: string[] = [], admissions: Array<ReturnType<typeof deferred<{ remove(): Promise<void> }>>> = []
  const addListener = vi.fn((name: string, callback: (value: any) => void) => {
    callbacks.set(name, callback)
    const handle = { async remove() { removed.push(name); callbacks.delete(name) } }
    if (!late) return Promise.resolve(handle)
    const admission = deferred<typeof handle>(); admissions.push(admission)
    return admission.promise
  })
  const ports = { app: { addListener, getState: vi.fn().mockResolvedValue({ isActive: true }) }, keyboard: { addListener } }
  return { ports: ports as unknown as Pick<NativeDevicePorts, 'app' | 'keyboard'>, callbacks, removed, admissions,
    admit() { for (const [i, admission] of admissions.entries()) {
      const name = addListener.mock.calls[i]![0]
      admission.resolve({ async remove() { removed.push(name); callbacks.delete(name) } })
    } } }
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete document.documentElement.dataset.mobileKeyboard })

describe('public OS ports used by the mobile shell', () => {
  it('confirms clipboard only after the native receipt, reports failure and keeps all visual ports', async () => {
    const receipt = deferred<void>(), write = vi.fn().mockReturnValueOnce(receipt.promise)
    const base = createBrowserPlatform(), report = vi.fn()
    const adapted = createNativePlatform(base, { clipboard: { write } as NativeDevicePorts['clipboard'] })
    let finished = false
    const pending = adapted.platform.copyText('原始文字', report).then(value => { finished = value })
    await Promise.resolve()
    expect(write).toHaveBeenCalledExactlyOnceWith({ string: '原始文字' }); expect(finished).toBe(false)
    receipt.resolve(); await pending; expect(finished).toBe(true)
    const error = new Error('OS denied clipboard')
    write.mockRejectedValueOnce(error)
    expect(await adapted.platform.copyText('不能伪报成功', report)).toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith(error)
    expect(adapted.platform.overlayContainer()).toBe(base.overlayContainer())
    expect(adapted.platform.renderMessageAvatar).toBe(base.renderMessageAvatar)
  })

  it('focuses only a registered visible composer on an explicit action and unregisters each editor', () => {
    const visible = document.createElement('div'), hidden = document.createElement('div')
    document.body.append(hidden, visible)
    vi.spyOn(visible, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    vi.spyOn(hidden, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    const base = createBrowserPlatform(), released = vi.fn()
    base.bindComposerFocus = vi.fn(() => released)
    const adapted = createNativePlatform(base), focus = vi.fn(() => true), hiddenFocus = vi.fn(() => true)
    const releaseHidden = adapted.platform.bindComposerFocus(hidden, hiddenFocus)
    const releaseVisible = adapted.platform.bindComposerFocus(visible, focus)
    expect(focus).not.toHaveBeenCalled(); expect(hiddenFocus).not.toHaveBeenCalled()
    expect(adapted.focusComposer()).toBe(true)
    expect(focus).toHaveBeenCalledOnce(); expect(hiddenFocus).not.toHaveBeenCalled()
    releaseVisible(); expect(adapted.focusComposer()).toBe(false)
    releaseHidden(); expect(released).toHaveBeenCalledTimes(2)
    expect(base.bindComposerFocus).toHaveBeenCalledTimes(2)
  })

  it('selects one system file as metadata without reading its data/path or inventing an upload', async () => {
    const pickFiles = vi.fn().mockResolvedValueOnce({ files: [{ name: 'notes.txt', mimeType: 'text/plain', size: 30,
      path: 'private://phone/file', data: 'must-not-export' }] })
    const ports = { filePicker: { pickFiles } as NativeDevicePorts['filePicker'] }
    const selected = await pickLocalAttachment(ports)
    expect(pickFiles).toHaveBeenCalledExactlyOnceWith({ limit: 1, readData: false })
    expect(selected).toEqual({ id: expect.any(String), name: 'notes.txt', mimeType: 'text/plain', size: 30 })
    expect(selected!.id.length).toBeGreaterThan(0)
    pickFiles.mockResolvedValueOnce({ files: [] }); expect(await pickLocalAttachment(ports)).toBeNull()
    pickFiles.mockResolvedValueOnce({ files: [{ name: 'bad.txt', mimeType: '', size: 30 }] })
    await expect(pickLocalAttachment(ports)).rejects.toThrow('尚未确认')
    pickFiles.mockResolvedValueOnce({ files: [{ name: 'a' }, { name: 'b' }] })
    await expect(pickLocalAttachment(ports)).rejects.toThrow('多个文件')
  })

  it('observes foreground edges, Android Back and native keyboard without duplicate focus or viewport arithmetic', async () => {
    const f = device(), foreground = vi.fn(), back = vi.fn(), report = vi.fn(), root = document.documentElement
    root.style.setProperty('--mobile-viewport-height', '431px')
    const binding = bindNativeDevice({ root, onForeground: foreground, onBack: back, reportError: report }, f.ports)
    await Promise.resolve(); await Promise.resolve()
    expect([...f.callbacks.keys()]).toEqual(['appStateChange', 'backButton', 'keyboardWillShow', 'keyboardWillHide'])
    f.callbacks.get('appStateChange')!({ isActive: false })
    f.callbacks.get('appStateChange')!({ isActive: true }); f.callbacks.get('appStateChange')!({ isActive: true })
    expect(foreground).toHaveBeenCalledOnce()
    f.callbacks.get('backButton')!({ canGoBack: false }); expect(back).toHaveBeenCalledOnce()
    f.callbacks.get('keyboardWillShow')!({ keyboardHeight: 300 })
    expect(root.dataset.mobileKeyboard).toBe('shown')
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('431px')
    f.callbacks.get('keyboardWillHide')!(); expect(root.dataset.mobileKeyboard).toBe('hidden')
    await binding.dispose(); await binding.dispose()
    expect(f.removed).toEqual(['appStateChange', 'backButton', 'keyboardWillShow', 'keyboardWillHide'])
    expect(f.callbacks.size).toBe(0); expect(root.dataset.mobileKeyboard).toBeUndefined(); expect(report).not.toHaveBeenCalled()
  })

  it('releases all listeners admitted after disposal; stale OS callbacks cannot request reconnect or mutate layout', async () => {
    const f = device(true), foreground = vi.fn(), back = vi.fn(), report = vi.fn(), root = document.documentElement
    const binding = bindNativeDevice({ root, onForeground: foreground, onBack: back, reportError: report }, f.ports)
    expect(f.admissions).toHaveLength(4)
    const callbacks = [...f.callbacks.values()], closing = binding.dispose()
    f.admit(); await closing
    callbacks[0]!({ isActive: true }); callbacks[1]!(); callbacks[2]!(); callbacks[3]!()
    expect(f.removed).toEqual(['appStateChange', 'backButton', 'keyboardWillShow', 'keyboardWillHide'])
    expect(f.callbacks.size).toBe(0); expect(foreground).not.toHaveBeenCalled(); expect(back).not.toHaveBeenCalled()
    expect(root.dataset.mobileKeyboard).toBeUndefined(); expect(report).not.toHaveBeenCalled()
  })

  it('coalesces visible-viewport rotation/keyboard updates, preserves pinch zoom and removes its listeners', () => {
    const root = document.documentElement, viewport = new EventTarget()
    Object.assign(viewport, { height: 431, offsetTop: 13, scale: 1 })
    const original = window.visualViewport
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const frames = new Map<number, FrameRequestCallback>(); let next = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const release = bindMobileViewport(window, root)
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('431px')
    expect(root.style.getPropertyValue('--mobile-viewport-top')).toBe('13px')
    Object.assign(viewport, { height: 285, offsetTop: 5 })
    viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(1)
    const [id, callback] = [...frames][0]!; frames.delete(id); callback(1)
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('285px')
    expect(root.style.getPropertyValue('--mobile-viewport-top')).toBe('5px')
    Object.assign(viewport, { height: 100, scale: 2 }); viewport.dispatchEvent(new Event('resize'))
    const [zoomId, zoom] = [...frames][0]!; frames.delete(zoomId); zoom(2)
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('285px')
    viewport.dispatchEvent(new Event('resize')); release()
    expect(frames.size).toBe(0)
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('')
    viewport.dispatchEvent(new Event('scroll')); expect(frames.size).toBe(0)
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: original })
  })
})
