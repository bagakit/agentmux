import { Menu, webContents, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { BrowserWebAuthnOwner } from './browser-webauthn-accounts.js'
import { acquireBrowserWebAuthnWindowMenu, releaseBrowserWebAuthnWindowMenu } from './browser-webauthn-window-menu.js'

type ResolveOwner = (contents: WebContents) => BrowserWebAuthnOwner | null
type DeviceCallback = (deviceId?: string | null) => void
type DeviceListener = (event: Electron.Event, details: Electron.SelectHidDeviceDetails, callback: DeviceCallback) => void
interface Registration { resolveOwner: ResolveOwner; references: number; pending: Set<PendingDevice> }
interface SessionAccess { registrations: Map<ResolveOwner, Registration>; listener: DeviceListener }
interface FrameSnapshot { frame: WebFrameMain; nodeId: number; token: string; url: string; origin: string }
interface PendingDevice { finish: (deviceId: string | null, message?: string, closeMenu?: boolean) => void }

const sessions = new WeakMap<Session, SessionAccess>()
const contentsRequests = new WeakMap<WebContents, PendingDevice>()
const selectionTimeoutMs = 60_000
const changedMessage = '安全密钥选择已取消：原 Browser 页面已改变。请在当前页面重新发起认证。'

function trustedOrigin(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
}

function fidoDevice(device: unknown): device is Electron.HIDDevice {
  if (!device || typeof device !== 'object' || !('collections' in device) || !Array.isArray(device.collections)) return false
  return device.collections.some(collection => collection && typeof collection === 'object' && collection.usagePage === 0xf1d0)
}

function report(owner: BrowserWebAuthnOwner, message: string): void {
  try { owner.report(message) } catch { /* A notice must not retain the native request. */ }
}

function complete(callback: DeviceCallback, deviceId: string | null, owner?: BrowserWebAuthnOwner): void {
  try { callback(deviceId) } catch {
    if (owner) report(owner, '安全密钥选择已结束，但浏览器未接收结果。请在原页面重新发起认证。')
  }
}

function resolve(state: SessionAccess, contents: WebContents): { owner: BrowserWebAuthnOwner; registration: Registration } | null {
  let result: { owner: BrowserWebAuthnOwner; registration: Registration } | null = null
  for (const registration of state.registrations.values()) {
    const owner = registration.resolveOwner(contents)
    if (!owner) continue
    if (result) {
      report(result.owner, '安全密钥请求已取消：无法确定原 Browser 所属窗口。')
      report(owner, '安全密钥请求已取消：无法确定原 Browser 所属窗口。')
      return null
    }
    result = { owner, registration }
  }
  return result
}

function owned(session: Session, state: SessionAccess, contents: WebContents | null): boolean {
  try {
    if (!contents || contents.isDestroyed() || contents.session !== session) return false
    const resolved = resolve(state, contents)
    return !!resolved && resolved.owner.isCurrent() && !resolved.owner.window.isDestroyed()
  } catch { return false }
}

function captureFrames(frame: WebFrameMain): FrameSnapshot[] {
  const frames: FrameSnapshot[] = []
  for (let current: WebFrameMain | null = frame; current; current = current.parent) {
    if (current.isDestroyed() || current.detached) throw new Error('Frame unavailable')
    frames.push({ frame: current, nodeId: current.frameTreeNodeId, token: current.frameToken, url: current.url, origin: current.origin })
  }
  return frames
}

function current(session: Session, contents: WebContents, owner: BrowserWebAuthnOwner, frames: FrameSnapshot[]): boolean {
  try {
    if (contents.isDestroyed() || contents.session !== session || !owner.isCurrent() || owner.window.isDestroyed()) return false
    const frame = frames[0]?.frame
    if (!frame || webContents.fromFrame(frame) !== contents) return false
    let actual: WebFrameMain | null = frame
    for (const original of frames) {
      if (actual !== original.frame || actual.isDestroyed() || actual.detached || actual.frameTreeNodeId !== original.nodeId
        || actual.frameToken !== original.token || actual.url !== original.url || actual.origin !== original.origin) return false
      actual = actual.parent
    }
    return actual === null
  } catch { return false }
}

function presentationBounds(owner: BrowserWebAuthnOwner, requireFocus = true): Electron.Rectangle | null {
  try {
    const bounds = owner.bounds
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0 || !owner.window.isVisible() || owner.window.isMinimized()
      || (requireFocus && !owner.window.isFocused())) return null
    return { ...bounds }
  } catch { return null }
}

function label(value: string): string {
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  return (plain.length > 120 ? `${plain.slice(0, 60)}…${plain.slice(-59)}` : plain).replace(/&/g, '&&')
}

function selectDevice(session: Session, state: SessionAccess, details: Electron.SelectHidDeviceDetails, callback: DeviceCallback): void {
  let owner: BrowserWebAuthnOwner | undefined
  let request: PendingDevice | undefined
  try {
    const frame = details.frame
    const contents = frame && !frame.isDestroyed() && !frame.detached ? webContents.fromFrame(frame) : undefined
    if (!frame || !contents || contents.isDestroyed() || contents.session !== session) { complete(callback, null); return }
    const resolved = resolve(state, contents)
    if (!resolved) { complete(callback, null); return }
    owner = resolved.owner
    const frames = captureFrames(frame)
    if (!trustedOrigin(frame.origin) || !trustedOrigin(frame.url) || !current(session, contents, owner, frames)) {
      report(owner, changedMessage)
      complete(callback, null, owner)
      return
    }
    contentsRequests.get(contents)?.finish(null, '原页面发起了新的安全密钥请求，旧选择已取消。')
    if (!current(session, contents, owner, frames) || contentsRequests.has(contents)) {
      complete(callback, null, owner)
      return
    }
    // Chromium's HID blocklist is unchanged. An empty native list is not evidence
    // that a physical authenticator or platform passkey is available.
    const devices = details.deviceList.filter(fidoDevice).map((device, index) => ({
      deviceId: device.deviceId,
      label: label(device.name || `安全密钥 ${index + 1}`)
    }))
    const ids = devices.map(device => device.deviceId)
    if (ids.some(id => typeof id !== 'string' || id.trim().length === 0) || new Set(ids).size !== ids.length) {
      report(owner, '安全密钥选择已取消：浏览器提供的设备候选无效。')
      complete(callback, null, owner)
      return
    }
    if (devices.length === 0) {
      report(owner, '浏览器没有提供可选 FIDO 安全密钥；设备可用性与系统 passkey 状态尚未确认。')
      complete(callback, null, owner)
      return
    }
    if (devices.length === 1) { complete(callback, devices[0]!.deviceId, owner); return }

    const originalOwner = owner
    const registration = resolved.registration
    const candidates = new Set(ids)
    let settled = false
    let menu: Menu | undefined
    let waitingReported = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let validityCheck: ReturnType<typeof setInterval> | undefined
    const cleanup: Array<() => void> = []
    const finish: PendingDevice['finish'] = (deviceId, message, closeMenu = true) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (validityCheck) clearInterval(validityCheck)
      for (const remove of cleanup) remove()
      registration.pending.delete(request!)
      if (contentsRequests.get(contents) === request) contentsRequests.delete(contents)
      releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
      if (closeMenu && menu) { try { menu.closePopup(originalOwner.window) } catch { /* Still complete the request. */ } }
      if (message) report(originalOwner, message)
      complete(callback, deviceId, originalOwner)
    }
    request = { finish }
    contentsRequests.set(contents, request)
    registration.pending.add(request)
    const cancelChanged = () => finish(null, changedMessage)
    const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (!event.isSameDocument && (event.isMainFrame || (event.frame && frames.some(original => original.nodeId === event.frame!.frameTreeNodeId)))) cancelChanged()
    }
    const removed = (_event: Electron.Event, details: Electron.HidDeviceRemovedDetails) => {
      if (details.frame !== frame || !candidates.delete(details.device.deviceId)) return
      if (candidates.size === 0) finish(null, '安全密钥已移除，原选择已取消。')
    }
    contents.on('did-start-navigation', navigation)
    contents.on('destroyed', cancelChanged)
    contents.on('render-process-gone', cancelChanged)
    originalOwner.window.on('closed', cancelChanged)
    session.on('hid-device-removed', removed)
    cleanup.push(
      () => contents.removeListener('did-start-navigation', navigation),
      () => contents.removeListener('destroyed', cancelChanged),
      () => contents.removeListener('render-process-gone', cancelChanged),
      () => originalOwner.window.removeListener('closed', cancelChanged),
      () => session.removeListener('hid-device-removed', removed)
    )
    timeout = setTimeout(() => finish(null, '安全密钥选择已超时。请在原页面重新发起认证。'), selectionTimeoutMs)
    timeout.unref?.()
    const waiting = () => {
      if (waitingReported) return
      waitingReported = true
      report(originalOwner, '安全密钥选择正在等待，请返回原 Browser 页面并选中原窗口。原认证请求仍保留。')
    }
    const present = () => {
      if (settled) return
      if (!current(session, contents, originalOwner, frames)) { cancelChanged(); return }
      if (menu) {
        if (!presentationBounds(originalOwner, false)) {
          const hiddenMenu = menu
          menu = undefined
          releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
          try { hiddenMenu.closePopup(originalOwner.window) } catch { /* Keep the original request pending. */ }
          waiting()
        }
        return
      }
      const bounds = presentationBounds(originalOwner)
      if (!bounds || !acquireBrowserWebAuthnWindowMenu(originalOwner.window, request!)) { waiting(); return }
      try {
        const displayedMenu = Menu.buildFromTemplate([
          { label: '选择安全密钥', enabled: false },
          { label: `来源：${label(frames[0]!.origin)}`, enabled: false },
          { type: 'separator' },
          ...devices.map(device => ({ label: device.label, click: () => {
            if (menu !== displayedMenu) return
            if (!current(session, contents, originalOwner, frames)) { cancelChanged(); return }
            if (!candidates.has(device.deviceId)) { finish(null, '所选安全密钥已移除，请重新发起认证。'); return }
            finish(device.deviceId)
          } })),
          { type: 'separator' },
          { label: '取消', click: () => { if (menu === displayedMenu) finish(null) } }
        ])
        menu = displayedMenu
        displayedMenu.popup({ window: originalOwner.window, frame, x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + Math.min(32, bounds.height)), callback: () => {
          if (settled || menu !== displayedMenu) return
          if (!current(session, contents, originalOwner, frames)) { cancelChanged(); return }
          if (!presentationBounds(originalOwner, false)) {
            menu = undefined
            releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
            waiting()
            return
          }
          finish(null, undefined, false)
        } })
        if (waitingReported && !settled) {
          waitingReported = false
          report(originalOwner, '安全密钥选择已在原 Browser 页面显示。请选择设备或取消认证。')
        }
      } catch { finish(null, '安全密钥选择无法显示，原请求已取消。请在原页面重新发起认证。') }
    }
    originalOwner.window.on('focus', present)
    originalOwner.window.on('show', present)
    originalOwner.window.on('restore', present)
    originalOwner.window.on('hide', present)
    originalOwner.window.on('minimize', present)
    cleanup.push(
      () => originalOwner.window.removeListener('focus', present),
      () => originalOwner.window.removeListener('show', present),
      () => originalOwner.window.removeListener('restore', present),
      () => originalOwner.window.removeListener('hide', present),
      () => originalOwner.window.removeListener('minimize', present)
    )
    // Only this pending request's original owner is read. There is no focus call,
    // all-Browser scan, AX/CDP work, or timer after the request settles.
    validityCheck = setInterval(present, 250)
    validityCheck.unref?.()
    present()
  } catch {
    const message = '安全密钥选择无法处理，原请求已取消。请在原页面重新发起认证。'
    if (request) request.finish(null, message)
    else { if (owner) report(owner, message); complete(callback, null, owner) }
  }
}

/** One policy set and HID listener for a shared profile Session. */
export function registerBrowserWebAuthnAccess(session: Session, resolveOwner: ResolveOwner): () => void {
  let state = sessions.get(session)
  if (!state) {
    const created: SessionAccess = { registrations: new Map(), listener: (event, details, callback) => {
      event.preventDefault()
      selectDevice(session, created, details, callback)
    } }
    session.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'hid'
      && trustedOrigin(details.securityOrigin) && owned(session, created, contents))
    // Electron routes WebHID through PermissionCheck; its PermissionRequest union
    // contains no HID permission. Every unrelated request remains denied.
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setDevicePermissionHandler(details => details.deviceType === 'hid' && trustedOrigin(details.origin) && fidoDevice(details.device))
    session.on('select-hid-device', created.listener)
    sessions.set(session, created)
    state = created
  }
  let registration = state.registrations.get(resolveOwner)
  if (!registration) {
    registration = { resolveOwner, references: 0, pending: new Set() }
    state.registrations.set(resolveOwner, registration)
  }
  registration.references++
  const originalState = state
  const originalRegistration = registration
  let released = false
  return () => {
    if (released) return
    released = true
    if (--originalRegistration.references > 0) return
    originalState.registrations.delete(resolveOwner)
    if (originalState.registrations.size === 0 && sessions.get(session) === originalState) {
      // Release policies before callbacks, which may register a fresh owner.
      sessions.delete(session)
      session.removeListener('select-hid-device', originalState.listener)
      session.setPermissionCheckHandler(null)
      session.setPermissionRequestHandler(null)
      session.setDevicePermissionHandler(null)
    }
    for (const pending of [...originalRegistration.pending]) pending.finish(null, changedMessage)
  }
}

export function cancelBrowserWebAuthnAccess(contents: WebContents): void {
  contentsRequests.get(contents)?.finish(null, changedMessage)
}
