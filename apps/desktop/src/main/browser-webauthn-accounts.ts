import { Menu, webContents, type BrowserWindow, type Rectangle, type Session, type WebContents, type WebFrameMain } from 'electron'
import { acquireBrowserWebAuthnWindowMenu, releaseBrowserWebAuthnWindowMenu } from './browser-webauthn-window-menu.js'

export interface BrowserWebAuthnOwner {
  window: BrowserWindow
  bounds: Rectangle | null
  isCurrent: () => boolean
  report: (message: string) => void
}

type ResolveOwner = (contents: WebContents) => BrowserWebAuthnOwner | null
type AccountCallback = (credentialId?: string | null) => void
type AccountListener = (event: Electron.Event, details: Electron.SelectWebauthnAccountDetails, callback: AccountCallback) => void
interface Registration {
  resolveOwner: ResolveOwner
  references: number
  pending: Set<PendingAccount>
}
interface SessionAccounts {
  registrations: Map<ResolveOwner, Registration>
  listener: AccountListener
}
interface FrameSnapshot {
  frame: WebFrameMain
  nodeId: number
  token: string
  url: string
  origin: string
}
interface PendingAccount {
  contents: WebContents
  owner: BrowserWebAuthnOwner
  finish: (credentialId: string | null, message?: string, closeMenu?: boolean) => void
}

const sessions = new WeakMap<Session, SessionAccounts>()
const windowRequests = new WeakMap<BrowserWindow, PendingAccount>()
const contentsRequests = new WeakMap<WebContents, PendingAccount>()
const selectionTimeoutMs = 60_000
const unavailableMessage = '账户选择已取消。请显示原 Browser 页面后重新发起认证。'
const changedMessage = '账户选择已取消：原 Browser 页面已改变。请在当前页面重新发起认证。'
const waitingMessage = '账户选择正在等待。请返回原 Browser 页面并选中原窗口，认证请求仍保留。'

function report(owner: BrowserWebAuthnOwner, message: string): void {
  try { owner.report(message) } catch { /* A local notice must not keep the native request pending. */ }
}

function complete(callback: AccountCallback, credentialId: string | null, owner?: BrowserWebAuthnOwner): void {
  try { callback(credentialId) } catch {
    if (owner) report(owner, '账户选择已结束，但浏览器未接收结果。请在原页面重新发起认证。')
  }
}

function captureFrames(frame: WebFrameMain): FrameSnapshot[] {
  const frames: FrameSnapshot[] = []
  for (let current: WebFrameMain | null = frame; current; current = current.parent) {
    if (current.isDestroyed() || current.detached) throw new Error('Frame unavailable')
    frames.push({ frame: current, nodeId: current.frameTreeNodeId, token: current.frameToken, url: current.url, origin: current.origin })
  }
  return frames
}

function isCurrent(session: Session, contents: WebContents, owner: BrowserWebAuthnOwner, frames: FrameSnapshot[]): boolean {
  try {
    if (contents.isDestroyed() || contents.session !== session || !owner.isCurrent()
      || owner.window.isDestroyed()) return false
    const frame = frames[0]?.frame
    if (!frame || webContents.fromFrame(frame) !== contents) return false
    let current: WebFrameMain | null = frame
    for (const original of frames) {
      if (!current || current.isDestroyed() || current.detached || current.frameTreeNodeId !== original.nodeId
        || current.frameToken !== original.token || current.url !== original.url || current.origin !== original.origin) return false
      current = current.parent
    }
    return current === null
  } catch { return false }
}

// Visibility decides when to present; it does not change the original request's owner.
function presentationBounds(owner: BrowserWebAuthnOwner, requireFocus = true): Rectangle | null {
  try {
    const bounds = owner.bounds
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0 || !owner.window.isVisible()
      || owner.window.isMinimized() || (requireFocus && !owner.window.isFocused())) return null
    return { ...bounds }
  } catch { return null }
}

// Menu labels are plain text; do not let account metadata create native mnemonics or extra lines.
function label(value: string, limit = 160): string {
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  const head = Math.ceil((limit - 1) / 2)
  return (plain.length > limit ? `${plain.slice(0, head)}…${plain.slice(-(limit - head - 1))}` : plain).replace(/&/g, '&&')
}

function selectAccount(session: Session, state: SessionAccounts, details: Electron.SelectWebauthnAccountDetails, callback: AccountCallback): void {
  let owner: BrowserWebAuthnOwner | undefined
  let request: PendingAccount | undefined
  try {
    const frame = details.frame
    const contents = frame && !frame.isDestroyed() && !frame.detached ? webContents.fromFrame(frame) : undefined
    if (!frame || !contents || contents.isDestroyed() || contents.session !== session) {
      complete(callback, null)
      return
    }
    let registration: Registration | undefined
    for (const candidate of state.registrations.values()) {
      const resolved = candidate.resolveOwner(contents)
      if (!resolved) continue
      if (owner) {
        report(owner, '账户选择已取消：无法确定原 Browser 所属窗口。请在原页面重新发起认证。')
        report(resolved, '账户选择已取消：无法确定原 Browser 所属窗口。请在原页面重新发起认证。')
        complete(callback, null)
        return
      }
      owner = resolved
      registration = candidate
    }
    if (!owner || !registration) { complete(callback, null); return }
    const frames = captureFrames(frame)
    if (!isCurrent(session, contents, owner, frames)) {
      report(owner, unavailableMessage)
      complete(callback, null, owner)
      return
    }
    const existing = windowRequests.get(owner.window)
    if (existing && existing.contents !== contents) {
      report(owner, '此窗口正在选择另一个 Browser 的账户。请完成或取消该选择后重新发起认证。')
      complete(callback, null, owner)
      return
    }
    existing?.finish(null, '账户选择已取消：原页面发起了新的认证请求。')
    if (!isCurrent(session, contents, owner, frames)) {
      report(owner, changedMessage)
      complete(callback, null, owner)
      return
    }
    // Cancellation invokes the native callback. If it synchronously starts another request,
    // preserve that new owner instead of overwriting its pending menu.
    if (windowRequests.has(owner.window)) {
      report(owner, '此窗口已开始新的账户选择。请完成或取消该选择后重新发起认证。')
      complete(callback, null, owner)
      return
    }
    // Do not filter malformed/duplicate candidates into a guessed single account.
    const credentialIds = details.accounts.map(account => account.credentialId)
    if (credentialIds.some(id => typeof id !== 'string' || id.trim().length === 0)
      || new Set(credentialIds).size !== credentialIds.length) {
      report(owner, '账户选择已取消：浏览器提供的账户候选无效。请在原页面重新发起认证。')
      complete(callback, null, owner)
      return
    }
    const accounts = details.accounts.map((account, index) => ({
      credentialId: account.credentialId,
      label: account.displayName && account.name && account.displayName !== account.name
        ? `${label(account.displayName, 76)} · ${label(account.name, 80)}`
        : label(account.displayName || account.name || `账户 ${index + 1}`)
    }))
    if (accounts.length === 0) {
      report(owner, '账户选择已取消：浏览器没有提供可选账户。请在原页面重新发起认证。')
      complete(callback, null, owner)
      return
    }
    if (accounts.length === 1) {
      // The authenticator already supplied the only account. Its user verification
      // remains separate; continue this exact native request without a second approval.
      complete(callback, accounts[0]!.credentialId, owner)
      return
    }
    const originalOwner = owner
    const originalRegistration = registration
    let settled = false
    let menu: Menu | undefined
    let waitingReported = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let validityCheck: ReturnType<typeof setInterval> | undefined
    const cleanup: Array<() => void> = []
    const finish: PendingAccount['finish'] = (credentialId, message, closeMenu = true) => {
      if (settled) return
      settled = true
      releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
      if (timeout) clearTimeout(timeout)
      if (validityCheck) clearInterval(validityCheck)
      for (const remove of cleanup) remove()
      if (contentsRequests.get(contents) === request) contentsRequests.delete(contents)
      originalRegistration.pending.delete(request!)
      if (windowRequests.get(originalOwner.window) === request) windowRequests.delete(originalOwner.window)
      // macOS fires MenuWillClose before itemSelected. The popup callback, not that event,
      // cancels; a real click wins first. Detach request state before closing a menu.
      if (closeMenu && menu) {
        try { menu.closePopup(originalOwner.window) } catch { /* Callback still receives cancellation. */ }
      }
      if (message) report(originalOwner, message)
      complete(callback, credentialId, originalOwner)
    }
    request = { contents, owner: originalOwner, finish }
    contentsRequests.set(contents, request)
    originalRegistration.pending.add(request)
    windowRequests.set(originalOwner.window, request)
    const cancelChanged = () => finish(null, changedMessage)
    const cancelUnavailable = () => finish(null, unavailableMessage)
    const navigation = (navigation: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (navigation.isMainFrame || (navigation.frame && frames.some((original) => original.nodeId === navigation.frame!.frameTreeNodeId))) cancelChanged()
    }
    contents.on('did-start-navigation', navigation)
    contents.on('destroyed', cancelUnavailable)
    contents.on('render-process-gone', cancelUnavailable)
    originalOwner.window.on('closed', cancelUnavailable)
    cleanup.push(
      () => contents.removeListener('did-start-navigation', navigation),
      () => contents.removeListener('destroyed', cancelUnavailable),
      () => contents.removeListener('render-process-gone', cancelUnavailable),
      () => originalOwner.window.removeListener('closed', cancelUnavailable)
    )
    timeout = setTimeout(() => finish(null, '账户选择已超时。请在原 Browser 页面重新发起认证。'), selectionTimeoutMs)
    timeout.unref?.()
    const waitForOwner = () => {
      if (waitingReported) return
      waitingReported = true
      report(originalOwner, waitingMessage)
    }
    const present = () => {
      if (settled) return
      if (!isCurrent(session, contents, originalOwner, frames)) { cancelChanged(); return }
      if (menu) {
        // A native menu can itself blur the window. Never reopen or cancel for that.
        if (presentationBounds(originalOwner, false)) return
        const hiddenMenu = menu
        menu = undefined
        releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
        // Detach the old menu first: its close callback must not cancel this request
        // or a menu subsequently shown on the restored original surface.
        try { hiddenMenu.closePopup(originalOwner.window) } catch { /* Keep the original request pending. */ }
        waitForOwner()
        return
      }
      const bounds = presentationBounds(originalOwner)
      if (!bounds) { waitForOwner(); return }
      if (!acquireBrowserWebAuthnWindowMenu(originalOwner.window, request!)) { waitForOwner(); return }
      try {
        const displayedMenu = Menu.buildFromTemplate([
          { label: `选择 ${label(details.relyingPartyId)} 的账户`, enabled: false },
          { label: `来源：${label(frames[0]!.origin)}`, enabled: false },
          { type: 'separator' },
          ...accounts.map((account) => ({ label: account.label, click: () => {
            if (menu !== displayedMenu) return
            if (!isCurrent(session, contents, originalOwner, frames)) { cancelChanged(); return }
            finish(account.credentialId)
          } })),
          { type: 'separator' },
          { label: '取消', click: () => { if (menu === displayedMenu) finish(null) } }
        ])
        menu = displayedMenu
        displayedMenu.popup({ window: originalOwner.window, frame, x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + Math.min(32, bounds.height)), callback: () => {
          if (settled || menu !== displayedMenu) return
          if (!isCurrent(session, contents, originalOwner, frames)) { cancelChanged(); return }
          // Hiding/minimizing the original surface can close a menu without a user
          // cancellation. Keep that exact request until its surface returns.
          if (!presentationBounds(originalOwner, false)) {
            menu = undefined
            releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)
            waitForOwner()
            return
          }
          finish(null, undefined, false)
        } })
        if (waitingReported && !settled) {
          waitingReported = false
          report(originalOwner, '账户选择已在原 Browser 页面显示。请选择账户或取消认证。')
        }
      } catch {
        finish(null, '账户选择无法显示，认证已取消。请在原 Browser 页面重新发起认证。')
      }
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
    // WebFrameMain has no public removal event. Read only this pending original owner;
    // no AX/CDP, focus calls, or scan across other Browser resources.
    validityCheck = setInterval(present, 250)
    validityCheck.unref?.()
    present()
  } catch {
    const message = '账户选择无法显示，认证已取消。请在原 Browser 页面重新发起认证。'
    if (request) request.finish(null, message)
    else { if (owner) report(owner, message); complete(callback, null, owner) }
  }
}

/** One native Session listener, even when multiple BrowserViewManagers share a profile. */
export function registerBrowserWebAuthnAccounts(session: Session, resolveOwner: ResolveOwner): () => void {
  let state = sessions.get(session)
  if (!state) {
    const registrations = new Map<ResolveOwner, Registration>()
    state = { registrations, listener: (_event, details, callback) => selectAccount(session, state!, details, callback) }
    sessions.set(session, state)
    session.on('select-webauthn-account', state.listener)
  }
  let registration = state.registrations.get(resolveOwner)
  if (!registration) {
    registration = { resolveOwner, references: 0, pending: new Set() }
    state.registrations.set(resolveOwner, registration)
  }
  registration.references++
  const originalState = state
  const originalRegistration = registration
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    if (--originalRegistration.references > 0) return
    originalState.registrations.delete(resolveOwner)
    for (const pending of [...originalRegistration.pending]) pending.finish(null, unavailableMessage)
    if (originalState.registrations.size === 0) {
      session.removeListener('select-webauthn-account', originalState.listener)
      sessions.delete(session)
    }
  }
}

/** Hiding one native Browser must not cancel another Browser's account selection. */
export function cancelBrowserWebAuthnAccounts(contents: WebContents): void {
  contentsRequests.get(contents)?.finish(null, unavailableMessage)
}
