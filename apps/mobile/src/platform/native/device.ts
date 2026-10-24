import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { App } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import { Keyboard } from '@capacitor/keyboard'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import { Capacitor } from '@capacitor/core'
import { FILE_UPLOAD_MAX_BYTES, fileUploadRevision, parseFileUploadIdentity } from '@agentmux/core/files'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { pickWebFiles } from './web-file-picker'

/** Only public OS capabilities. There is deliberately no credential/secret read method. */
export const nativeDevicePorts = { app: App, clipboard: Clipboard, keyboard: Keyboard,
  filePicker: { pickFiles: (options: Parameters<typeof FilePicker.pickFiles>[0], signal?: AbortSignal) =>
    Capacitor.isNativePlatform() ? FilePicker.pickFiles(options) : pickWebFiles(options, signal) } }
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

export type LocalAttachment = { id: string; name: string; mimeType: string; size: number; revision: string; dataBase64: string }
export type LocalAttachmentFile = { name: string; type?: string; mimeType?: string; size: number; stream(): ReadableStream<Uint8Array> }

async function boundedBytes(stream: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let length = 0
  let abortRead: (() => void) | undefined
  const cancelled = signal && new Promise<never>((_, reject) => {
    abortRead = () => reject(new DOMException('Selection cancelled', 'AbortError'))
    if (signal.aborted) abortRead(); else signal.addEventListener('abort', abortRead, { once: true })
  })
  try {
    for (;;) {
      const part = await (cancelled ? Promise.race([reader.read(), cancelled]) : reader.read())
      if (part.done) break
      length += part.value.byteLength
      if (length > FILE_UPLOAD_MAX_BYTES || length > size) throw new Error('附件在读取时变大；本次尚未上传，原会话与草稿保留。')
      chunks.push(part.value)
    }
  } finally {
    if (abortRead) signal?.removeEventListener('abort', abortRead)
    try { void reader.cancel().catch(() => {}) } catch { /* A broken source cannot retain this reader. */ }
    try { reader.releaseLock() } catch { /* A pending read may finish after cancellation. */ }
  }
  if (length !== size) throw new Error('附件在读取时变化；本次尚未上传，请重新选择原文件。')
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
function base64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(value)
}
function normalizeAttachmentMimeType(name: string, rawMimeType?: string | null): string {
  const lower = (rawMimeType ?? '').trim().toLowerCase()
  if (lower === 'image/jpg') return 'image/jpeg'
  if (lower) return lower
  const ext = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() : undefined
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as const)[ext ?? ''] ?? 'application/octet-stream'
}

export async function localAttachmentFromBlob(file: LocalAttachmentFile, signal?: AbortSignal): Promise<LocalAttachment> {
  const name = file.name || `image-${randomClientRequestId()}.png`
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('系统尚未确认附件的名称、类型或大小；这次附件尚未采用。')
  }
  const mimeType = normalizeAttachmentMimeType(name, file.mimeType ?? file.type)
  parseFileUploadIdentity({ hostId: 'local', agentSessionId: 'local-selection', expectedRun: { runId: 'local-selection' },
    operationId: 'local-selection', name, mimeType, byteLength: file.size, revision: 'sha256:' + '0'.repeat(64) })
  const bytes = await boundedBytes(file.stream(), file.size, signal)
  return { id: randomClientRequestId(), name, mimeType, size: bytes.byteLength,
    revision: fileUploadRevision(bytes), dataBase64: base64(bytes) }
}

/** The system chooser owns access; native paths stay on this device. Byte reads are bounded before upload. */
export async function pickLocalAttachment(ports: Pick<NativeDevicePorts, 'filePicker'> = nativeDevicePorts,
  readNative: (path: string, signal?: AbortSignal) => Promise<Response> = (path, signal) => fetch(Capacitor.convertFileSrc(path), signal ? { signal } : undefined),
  signal?: AbortSignal): Promise<LocalAttachment | null> {
  let result: Awaited<ReturnType<NativeDevicePorts['filePicker']['pickFiles']>>
  try {
    const options = { limit: 1, readData: false }
    result = signal ? await ports.filePicker.pickFiles(options, signal) : await ports.filePicker.pickFiles(options)
  } catch (error) {
    // The native plugin's Android/iOS cancellation contract has this exact message.
    // Browser cancellation is the input's cancel event, never a focus heuristic.
    if (error && typeof error === 'object' && 'message' in error && error.message === 'pickFiles canceled.') return null
    throw error
  }
  if (signal?.aborted) return null
  if (result.files.length === 0) return null
  if (result.files.length !== 1) throw new Error('系统文件选择返回了多个文件；这次附件尚未采用。')
  const file = result.files[0]!
  if (!file.name || !Number.isSafeInteger(file.size)) {
    throw new Error('系统尚未确认附件的名称、类型或大小；这次附件尚未采用。')
  }
  const mimeType = normalizeAttachmentMimeType(file.name, file.mimeType)
  // Reuse the public byte/format budget before reading a Blob or an OS-granted URI.
  parseFileUploadIdentity({ hostId: 'local', agentSessionId: 'local-selection', expectedRun: { runId: 'local-selection' },
    operationId: 'local-selection', name: file.name, mimeType, byteLength: file.size, revision: 'sha256:' + '0'.repeat(64) })
  let stream: ReadableStream<Uint8Array> | null
  if (file.blob) stream = file.blob.stream()
  else {
    if (!file.path) throw new Error('系统尚未提供所选文件的读取权限；本次尚未上传。')
    const response = signal ? await readNative(file.path, signal) : await readNative(file.path)
    if (signal?.aborted) return null
    if (!response.ok) throw new Error('系统暂时无法读取原附件；本次尚未上传。')
    stream = response.body
  }
  if (!stream) throw new Error('这台设备尚未提供有界文件读取；本次尚未上传，原消息仍可发送。')
  const bytes = await boundedBytes(stream, file.size, signal)
  return { id: randomClientRequestId(), name: file.name, mimeType, size: bytes.byteLength,
    revision: fileUploadRevision(bytes), dataBase64: base64(bytes) }
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
