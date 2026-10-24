import { createContext, createElement, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { getDeviceWorkface } from '../recovery/device-workface'
import { mobileUpdateFragment } from '../connection/reload-identity'
import { createAttachmentPageOwner, type AttachmentPageOwner } from '../conversation/attachment-page-owner'

export type MobileWebUpdateResult = { status: 'navigating' } | { status: 'blocked'; message: string }
type SafetyOwner = () => string | null
type ConnectionCheck = () => Promise<() => boolean>
type DispatchMatch = (candidate: unknown) => boolean
type SafetyContext = { apply(): Promise<MobileWebUpdateResult>; register(owner: SafetyOwner): () => void;
  trackDispatch(key: string, match: DispatchMatch): () => void; isDispatched(key: string, candidate: unknown): boolean; attachmentOwner(): AttachmentPageOwner }
const unavailable = '当前页面无法确认原连接；请保留工作内容并恢复原 Mac 连接后重试。'
const Safety = createContext<SafetyContext | null>(null)

/** Owners report live, document-local facts, not rendered labels or a selected Session. */
export function useMobileWebUpdateSafetyOwner(owner: SafetyOwner): void {
  const context = useContext(Safety), current = useRef(owner)
  current.current = owner
  useLayoutEffect(() => context?.register(() => current.current()), [context])
}

export function useMobileWebUpdateSafety(): Pick<SafetyContext, 'apply'> {
  const context = useContext(Safety)
  return context ?? { apply: async () => ({ status: 'blocked', message: unavailable }) }
}

/** One original attachment owner survives presentation remounts within this page. */
export function useMobileWebAttachmentOwner(): AttachmentPageOwner {
  const context = useContext(Safety), owner = useRef<AttachmentPageOwner | null>(null)
  if (!owner.current) owner.current = context?.attachmentOwner() ?? createAttachmentPageOwner()
  return owner.current
}

/** Keep an accepted operation protected even if its presenting component unmounts. */
export function useMobileWebUpdatePendingAction() {
  const context = useContext(Safety)
  return async <T,>(message: string | (() => string), action: (allowUpdate: () => void) => Promise<T>): Promise<T> => {
    let pendingContinuation = true
    const release = context?.register(() => pendingContinuation ? typeof message === 'function' ? message() : message : null)
    try { return await action(() => { pendingContinuation = false }) } finally { release?.() }
  }
}

/** The original operation owns its matcher until that exact invocation settles. */
export function useMobileWebDispatchedOperations() {
  const context = useContext(Safety)
  return { track: (key: string, match: DispatchMatch) => context?.trackDispatch(key, match) ?? (() => {}),
    includes: (key: string, candidate: unknown) => context?.isDispatched(key, candidate) ?? false }
}

/** Explicit navigation retains the page when any preservation check is unknown. */
export function MobileWebUpdateSafetyProvider({ children, verifyConnection, prepareReload, native = false }: {
  children: ReactNode; verifyConnection: ConnectionCheck; prepareReload?: () => () => void; native?: boolean
}) {
  const owners = useRef(new Set<SafetyOwner>()), dispatched = useRef(new Map<string, Set<DispatchMatch>>()), ownersRevision = useRef(0), attachment = useRef<AttachmentPageOwner | null>(null), current = useRef({ verifyConnection, prepareReload, native })
  current.current = { verifyConnection, prepareReload, native }
  const context = useMemo<SafetyContext>(() => ({
    attachmentOwner() {
      if (!attachment.current) { attachment.current = createAttachmentPageOwner(() => { ownersRevision.current++ }); ownersRevision.current++ }
      return attachment.current
    },
    trackDispatch(key, match) {
      const group = dispatched.current.get(key) ?? new Set<DispatchMatch>()
      group.add(match); dispatched.current.set(key, group)
      return () => { group.delete(match); if (!group.size && dispatched.current.get(key) === group) dispatched.current.delete(key) }
    },
    isDispatched(key, candidate) { for (const match of dispatched.current.get(key) ?? []) if (match(candidate)) return true; return false },
    register(owner) {
      owners.current.add(owner); ownersRevision.current++
      return () => { if (owners.current.delete(owner)) ownersRevision.current++ }
    },
    async apply() {
      const blocked = (message: string): MobileWebUpdateResult => ({ status: 'blocked', message })
      if (current.current.native) return blocked('当前不是手机网页，请使用设备的应用更新方式。')
      const originalOwnersRevision = ownersRevision.current
      const checkOwners = () => { const issue = attachment.current?.issue(); if (issue) return issue; for (const owner of owners.current) { const issue = owner(); if (issue) return issue } return null }
      const issue = checkOwners()
      if (issue) return blocked(issue)
      const original = current.current
      let connectionStillOriginal: () => boolean, finalConnectionStillOriginal: () => boolean, workfaceStillSaved: () => boolean
      const abort = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          (async () => {
            const connection = await original.verifyConnection()
            const workface = await getDeviceWorkface().preparePageReload(abort.signal)
            const response = await fetch('/', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'follow', signal: abort.signal })
            const finalConnection = await original.verifyConnection()
            return { connection, finalConnection, workface, response }
          })(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new Error('Observation ended')) }, 15000) })
        ])
        connectionStillOriginal = result.connection
        finalConnectionStillOriginal = result.finalConnection
        workfaceStillSaved = result.workface
        const response = result.response
        const destination = new URL(response.url)
        if (!response.ok || destination.origin !== location.origin || !/^\/mobile\/[^/]+\/[a-f0-9]{64}\/index\.html$/u.test(destination.pathname)) {
          return blocked('新版入口暂时无法确认；当前页面和工作内容保留，请恢复连接后重试。')
        }
      } catch {
        return blocked('原连接或新版入口暂时无法确认；当前页面和工作内容保留，请恢复连接及设备存储后重试。')
      } finally { clearTimeout(timeout); abort.abort() }
      const finalIssue = checkOwners()
      if (finalIssue) return blocked(finalIssue)
      if (ownersRevision.current !== originalOwnersRevision || current.current.verifyConnection !== original.verifyConnection || current.current.prepareReload !== original.prepareReload || current.current.native !== original.native || !connectionStillOriginal() || !finalConnectionStillOriginal() || !workfaceStillSaved()) {
        return blocked('连接或设备工作面在检查期间发生变化，或尚未保存；当前页面保留，请核对并重试。')
      }
      // No asynchronous boundary between the last owner checks and the navigation.
      let rollback: (() => void) | undefined
      try {
        rollback = original.prepareReload?.()
        if (checkOwners() || ownersRevision.current !== originalOwnersRevision || !finalConnectionStillOriginal() || !workfaceStillSaved()) {
          rollback?.(); return blocked('连接或工作面发生变化；当前页面保留，请核对后重试。')
        }
        location.assign('/' + mobileUpdateFragment); return { status: 'navigating' }
      } catch { try { rollback?.() } catch { /* Retain any unresolved handoff. */ } return blocked('原身份交接或网页重开未确认；当前页面保留，请恢复设备存储后重试。') }
    }
  }), [])
  return createElement(Safety.Provider, { value: context }, children)
}
