import type { Session, WebContents } from 'electron'
import type { BrowserWebAuthnOwner } from './browser-webauthn-accounts.js'
import { allowsBrowserWebAuthnDevice, allowsBrowserWebAuthnHid, registerBrowserWebAuthnAccess } from './browser-webauthn-access.js'

interface BrowserSessionPermissionOwner {
  ownsContents(contents: WebContents): boolean
  /** A prepared Profile candidate can retain site requests before presentation commits. */
  ownsSiteContents?(contents: WebContents): boolean
  resolveHidOwner(contents: WebContents): BrowserWebAuthnOwner | null
  checkSitePermission?(contents: WebContents, permission: string, origin: string, details: Electron.PermissionCheckHandlerHandlerDetails): boolean
  requestSitePermission?(contents: WebContents, permission: string, details: Electron.PermissionRequest, callback: (allow: boolean) => void): void
}
interface SessionPermissions { registrations: Map<BrowserSessionPermissionOwner, { references: number; releaseHid(): void }> }
const sessions = new WeakMap<Session, SessionPermissions>()

/** One permission-slot owner; Chromium retains secure-context, focus and frame-policy checks. */
export function registerBrowserSessionPermissions(session: Session, owner: BrowserSessionPermissionOwner): () => void {
  let state = sessions.get(session)
  if (!state) {
    const created: SessionPermissions = { registrations: new Map() }
    const owns = (contents: WebContents | null): boolean => {
      if (sessions.get(session) !== created || !contents || contents.isDestroyed() || contents.session !== session) return false
      return [...created.registrations.keys()].filter(owner => owner.ownsContents(contents)).length === 1
    }
    const siteOwner = (contents: WebContents | null) => {
      if (sessions.get(session) !== created || !contents || contents.isDestroyed() || contents.session !== session) return undefined
      const candidates = [...created.registrations.keys()].filter(value => value.ownsSiteContents?.(contents) ?? value.ownsContents(contents))
      return candidates.length === 1 ? candidates[0] : undefined
    }
    session.setPermissionCheckHandler((contents, permission, origin, details) =>
      permission === 'clipboard-sanitized-write' ? owns(contents)
        : permission === 'hid' ? sessions.get(session) === created && allowsBrowserWebAuthnHid(session, contents, details.securityOrigin)
          : !!contents && (siteOwner(contents)?.checkSitePermission?.(contents, permission, origin, details) ?? false))
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'clipboard-sanitized-write') { callback(owns(contents)); return }
      const original = siteOwner(contents)
      if (!original?.requestSitePermission) { callback(false); return }
      original.requestSitePermission(contents, permission, details, callback)
    })
    session.setDevicePermissionHandler(details => sessions.get(session) === created && allowsBrowserWebAuthnDevice(details))
    sessions.set(session, created)
    state = created
  }
  let registration = state.registrations.get(owner)
  if (!registration) {
    registration = { references: 0, releaseHid: registerBrowserWebAuthnAccess(session, owner.resolveHidOwner) }
    state.registrations.set(owner, registration)
  }
  registration.references++
  const originalState = state, originalRegistration = registration
  let released = false
  return () => {
    if (released) return
    released = true
    if (--originalRegistration.references > 0) return
    originalState.registrations.delete(owner)
    if (originalState.registrations.size === 0 && sessions.get(session) === originalState) {
      sessions.delete(session)
      // Cancellation may register a new owner; retire only these original slots first.
      session.setPermissionCheckHandler(null)
      session.setPermissionRequestHandler(null)
      session.setDevicePermissionHandler(null)
    }
    originalRegistration.releaseHid()
  }
}
