import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'

export const DELIVERY_DISMISSAL_STORAGE = 'agentmux-mobile-dismissed-delivery-v1'
type Identity = readonly (string | number | boolean | null | undefined)[]
type Presentation = {
  dismissed: ReadonlySet<string>
  deliveryDismissed: ReadonlySet<string>
  hasDismissed: boolean
  dismiss(key: string): void
  restore(): void
  updateDelivery(mutate: (next: Set<string>) => void): void
}
const Notices = createContext<Presentation | null>(null)
const Scope = createContext('')
type AvatarNoticeEntry = { key: string; name: string; issue: string; retry?: (() => void) | undefined }
const AvatarNotices = createContext<{
  entries: ReadonlyMap<string, AvatarNoticeEntry>
  register(id: string, entry: AvatarNoticeEntry): () => void
} | null>(null)
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0
// Object identity is local to this presentation tree; no business object is serialized or inferred.
function ownerKey(owner: object | null | undefined): number | null {
  if (!owner) return null
  let id = objectIds.get(owner)
  if (id === undefined) { id = ++nextObjectId; objectIds.set(owner, id) }
  return id
}
function identityKey(identity: Identity): string {
  return JSON.stringify(identity.map(value => [typeof value, value ?? null]))
}

export function MobileNoticeProvider({ children }: { children: ReactNode }) {
  const [avatarEntries, setAvatarEntries] = useState<Map<string, AvatarNoticeEntry>>(new Map())
  const registerAvatar = useCallback((id: string, entry: AvatarNoticeEntry) => {
    setAvatarEntries(previous => new Map(previous).set(id, entry))
    return () => setAvatarEntries(previous => { const next = new Map(previous); next.delete(id); return next })
  }, [])
  const avatars = useMemo(() => ({ entries: avatarEntries, register: registerAvatar }), [avatarEntries, registerAvatar])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [deliveryDismissed, setDeliveryDismissed] = useState(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem(DELIVERY_DISMISSAL_STORAGE) ?? 'null'); return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(-64) : []) }
    catch { return new Set<string>() }
  })
  const value = useMemo<Presentation>(() => ({ dismissed, deliveryDismissed, hasDismissed: dismissed.size > 0 || deliveryDismissed.size > 0,
    dismiss(key) { setDismissed(previous => new Set([...previous, key].slice(-256))) },
    restore() {
      setDismissed(new Set()); setDeliveryDismissed(new Set())
      try { localStorage.removeItem(DELIVERY_DISMISSAL_STORAGE) } catch { /* A presentation preference cannot prevent restoring the current view. */ }
    },
    updateDelivery(mutate) {
      setDeliveryDismissed(previous => {
        const next = new Set(previous); mutate(next)
        const bounded = new Set([...next].slice(-64))
        try { localStorage.setItem(DELIVERY_DISMISSAL_STORAGE, JSON.stringify([...bounded])) } catch { /* Presentation preference only. */ }
        return bounded
      })
    }
  }), [dismissed, deliveryDismissed])
  return <AvatarNotices.Provider value={avatars}><Notices.Provider value={value}>{children}</Notices.Provider></AvatarNotices.Provider>
}

/** Presentation only: each original avatar owner keeps its own observation and retry. */
export function MobileAvatarNoticeOutlet() {
  const avatars = useContext(AvatarNotices), presentation = useMobileNotices()
  const entries = [...(avatars?.entries.values() ?? [])].filter(entry => !presentation?.dismissed.has(entry.key))
  return <div className="mobile-avatar-notice-outlet">{entries.length > 0 && <MobileNotice
    identity={entries.map(entry => entry.key)} className="mobile-avatar-notice"
    onDismiss={() => entries.forEach(entry => presentation?.dismiss(entry.key))}>
    <details><summary><SemanticIcon name="status.warning" size={13} /><span>{entries.length === 1
      ? `头像外观未确认 · ${entries[0]!.name}` : `${entries.length} 个图标外观未确认`}</span></summary>
      <div className="mobile-avatar-notice__list">{entries.map(entry => <section key={entry.key} className="mobile-avatar-notice__item" data-avatar-notice-key={entry.key}>
        {entries.length > 1 && <strong>{entry.name}</strong>}
        <p>图标暂未显示，仍可继续使用。</p>
        {entry.retry ? <button type="button" onClick={entry.retry}>重新读取头像</button> : <p>连接可用后可重新读取。</p>}
        <details><summary>技术信息</summary><p>{entry.issue}</p></details>
      </section>)}</div>
    </details>
  </MobileNotice>}</div>
}

export function MobileAvatarNotice({ owner, identity, name, issue, visible, retry }: {
  owner: object | null; identity: Identity; name: string; issue: string; visible: boolean; retry?: (() => void) | undefined
}) {
  const register = useContext(AvatarNotices)?.register, scope = useContext(Scope), id = useId()
  const key = JSON.stringify([scope, id, ownerKey(owner), identityKey(identity)])
  const retryRef = useRef(retry)
  retryRef.current = retry
  const canRetry = Boolean(retry)
  useLayoutEffect(() => {
    if (!register || !visible || !issue) return
    return register(id, { key, name, issue, ...(canRetry ? { retry: () => retryRef.current?.() } : {}) })
  }, [register, id, key, name, issue, visible, canRetry])
  return null
}

export function MobileNoticeScope({ identity = [], owner, children }: { identity?: Identity; owner?: object | null | undefined; children: ReactNode }) {
  const parent = useContext(Scope)
  return <Scope.Provider value={parent + '/' + JSON.stringify([ownerKey(owner),identityKey(identity)])}>{children}</Scope.Provider>
}
export const useMobileNotices = () => useContext(Notices)

/** Hide only this original notice view. Owners, drafts and recovery operations stay mounted outside it. */
export function MobileNotice({ identity = [], owner, children, className, dismissible = true, kind = 'warning', onDismiss, ...attributes }: HTMLAttributes<HTMLDivElement> & {
  identity?: Identity; owner?: object | null | undefined; dismissible?: boolean; kind?: 'warning' | 'feedback'; onDismiss?(): void
}) {
  const presentation = useMobileNotices(), scope = useContext(Scope), id = useId()
  const key = JSON.stringify([scope, id, ownerKey(owner), identityKey(identity)])
  const [localDismissed, setLocalDismissed] = useState<string | null>(null)
  if (dismissible && (presentation ? presentation.dismissed.has(key) : localDismissed === key)) return null
  return <div role="status" {...attributes} data-notice-kind={kind} className={`mobile-notice${className ? ' ' + className : ''}`}>
    <div className="mobile-notice__body">{children}</div>
    {dismissible && <button type="button" className="mobile-notice__dismiss" aria-label="收起提醒" title="收起提醒；可从菜单恢复显示"
      onClick={event => {
        const button = event.currentTarget
        const focusTarget = button.closest<HTMLElement>('[role="dialog"]') ?? button.closest('.mobile-app')?.querySelector<HTMLElement>('.mobile-main')
        focusTarget?.focus({ preventScroll: true })
        if (onDismiss) onDismiss()
        else presentation ? presentation.dismiss(key) : setLocalDismissed(key)
      }}><SemanticIcon name="action.close" size={14} /></button>}
  </div>
}

export function MobileNoticeRestore({ onRestored }: { onRestored?(): void }) {
  const notices = useMobileNotices()
  return <div className="mobile-notice-settings">
    <p>{notices?.hasDismissed ? '有已收起的提醒。恢复后可在原位置查看原因和恢复操作。' : '提醒可随时收起；收起后可从这里恢复显示。'}</p>
    <p>此操作只恢复显示，保留原草稿和请求，不会重试、发送或确认操作结果。</p>
    <button type="button" className="mobile-secondary" onClick={() => { notices?.restore(); onRestored?.() }}>恢复已收起提醒</button>
  </div>
}
