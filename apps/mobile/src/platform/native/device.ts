import { App } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import { Keyboard } from '@capacitor/keyboard'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

/** Only public OS capabilities. There is deliberately no credential/secret read method. */
export const nativeDevicePorts = { app: App, clipboard: Clipboard, keyboard: Keyboard, filePicker: FilePicker }
export type NativeDevicePorts = typeof nativeDevicePorts

export function createNativePlatform(base: ClientUiPlatform, ports: Pick<NativeDevicePorts, 'clipboard'> = nativeDevicePorts) {
  const composers = new Map<HTMLElement, () => boolean>()
  const platform: ClientUiPlatform = {
    ...base,
    async copyText(text, reportError) {
      try { await ports.clipboard.write({ string: text }); return true }
      catch (error) { reportError(error); return false }
    },
    bindComposerFocus(element, focus) {
      const unregister = base.bindComposerFocus(element, focus)
      composers.set(element, focus)
      return () => { composers.delete(element); unregister() }
    }
  }
  return { platform, focusComposer(): boolean {
    // iOS keyboard focus must remain in the initiating touch gesture. Foreground events never call this.
    for (const [element, focus] of composers) {
      if (element.isConnected && element.getClientRects().length > 0 && !element.closest('[inert]')
        && element.ownerDocument.visibilityState === 'visible' && focus()) return true
    }
    return false
  } }
}

export type LocalAttachment = { id: string; name: string; mimeType: string; size: number }

/** The system chooser owns access. Selection is local metadata, never a Host file or an upload receipt. */
export async function pickLocalAttachment(ports: Pick<NativeDevicePorts, 'filePicker'> = nativeDevicePorts): Promise<LocalAttachment | null> {
  const result = await ports.filePicker.pickFiles({ limit: 1, readData: false })
  if (result.files.length === 0) return null
  if (result.files.length !== 1) throw new Error('系统文件选择返回了多个文件；这次附件尚未采用。')
  const file = result.files[0]!
  if (!file.name || !Number.isSafeInteger(file.size) || file.size < 0 || !file.mimeType) {
    throw new Error('系统尚未确认附件的名称、类型或大小；这次附件尚未采用。')
  }
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.mimeType, size: file.size }
}

/** Observe OS lifecycle/keyboard only; closing these listeners cannot control a Host or a Run. */
export function bindNativeDevice(options: {
  root: HTMLElement; onForeground(): void; onBack(): void; reportError(error: unknown): void
}, ports: Pick<NativeDevicePorts, 'app' | 'keyboard'> = nativeDevicePorts): { dispose(): Promise<void> } {
  let disposed = false, active: boolean | null = null
  const handles: Array<{ remove(): Promise<void> }> = []
  const registrations: Promise<void>[] = []
  const register = (pending: Promise<{ remove(): Promise<void> }>) => {
    registrations.push(pending.then(async handle => {
      if (disposed) await handle.remove(); else handles.push(handle)
    }).catch(error => { if (!disposed) options.reportError(error) }))
  }
  register(ports.app.addListener('appStateChange', value => {
    if (disposed) return
    const previous = active; active = value.isActive
    if (active && previous !== true) options.onForeground()
  }))
  register(ports.app.addListener('backButton', () => { if (!disposed) options.onBack() }))
  register(ports.keyboard.addListener('keyboardWillShow', () => {
    if (!disposed) options.root.dataset.mobileKeyboard = 'shown'
  }))
  register(ports.keyboard.addListener('keyboardWillHide', () => {
    if (!disposed) options.root.dataset.mobileKeyboard = 'hidden'
  }))
  void ports.app.getState().then(value => { if (!disposed && active === null) active = value.isActive })
    .catch(error => { if (!disposed) options.reportError(error) })
  let closing: Promise<void> | undefined
  return { dispose() {
    if (closing) return closing
    disposed = true
    closing = (async () => {
      await Promise.all(registrations)
      await Promise.all(handles.splice(0).map(handle => handle.remove()))
      delete options.root.dataset.mobileKeyboard
    })()
    return closing
  } }
}

/** Follow the visible viewport, including Safari keyboard panning. Native resize is never subtracted twice. */
export function bindMobileViewport(window: Window, root: HTMLElement): () => void {
  const viewport = window.visualViewport
  let frame: number | undefined
  const update = () => {
    frame = undefined
    if (viewport && viewport.scale !== 1) return
    root.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    root.style.setProperty('--mobile-viewport-top', `${viewport?.offsetTop ?? 0}px`)
    if (!root.dataset.mobileKeyboard) {
      const focused = window.document.activeElement
      const editing = focused instanceof HTMLElement && (focused.isContentEditable || /^(INPUT|TEXTAREA)$/u.test(focused.tagName))
      root.dataset.browserKeyboard = editing && window.innerHeight - (viewport?.height ?? window.innerHeight) > 120 ? 'shown' : 'hidden'
    }
  }
  const schedule = () => { frame ??= window.requestAnimationFrame(update) }
  viewport?.addEventListener('resize', schedule); viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule); window.document.addEventListener('focusin', schedule)
  window.document.addEventListener('focusout', schedule)
  update()
  return () => {
    viewport?.removeEventListener('resize', schedule); viewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule); window.document.removeEventListener('focusin', schedule)
    window.document.removeEventListener('focusout', schedule)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    root.style.removeProperty('--mobile-viewport-height'); root.style.removeProperty('--mobile-viewport-top')
    delete root.dataset.browserKeyboard
  }
}
