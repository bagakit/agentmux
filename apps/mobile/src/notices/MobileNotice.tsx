import { createContext, useContext, useId, useMemo, useState, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
const AvatarNoticeTarget = createContext<{ target: HTMLElement | null; setTarget(target: HTMLDivElement | null): void } | null>(null)
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
  const [avatarTarget, setAvatarTarget] = useState<HTMLDivElement | null>(null)
  const avatarOutlet = useMemo(() => ({ target: avatarTarget, setTarget: setAvatarTarget }), [avatarTarget])
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
  return <AvatarNoticeTarget.Provider value={avatarOutlet}><Notices.Provider value={value}>{children}</Notices.Provider></AvatarNoticeTarget.Provider>
}

/** Presentation only: each original avatar owner keeps its own observation and retry. */
export function MobileAvatarNoticeOutlet() {
  const outlet = useContext(AvatarNoticeTarget)
  return <div ref={outlet?.setTarget} className="mobile-avatar-notice-outlet" />
}

export function MobileAvatarNotice({ owner, identity, name, issue, visible, retry }: {
  owner: object | null; identity: Identity; name: string; issue: string; visible: boolean; retry?: (() => void) | undefined
}) {
  const target = useContext(AvatarNoticeTarget)?.target
  if (!target || !issue) return null
  // Portals retain their React ancestry, which can include an Agent row button.
  // Isolate the notice's own gestures without cancelling their native defaults.
  return createPortal(<div onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onPointerCancel={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') event.stopPropagation() }}
    onKeyUp={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') event.stopPropagation() }}>
    <MobileNotice owner={owner} identity={identity} hidden={!visible} className="mobile-avatar-notice">
      <details><summary>{`头像外观未确认 · ${name}`}</summary><p>{issue}</p>
        {retry ? <button type="button" onClick={retry}>重新读取头像</button> : <p>原对象连接可用后可重新核对。</p>}
      </details>
    </MobileNotice>
  </div>, target)
}

export function MobileNoticeScope({ identity = [], owner, children }: { identity?: Identity; owner?: object | null | undefined; children: ReactNode }) {
  const parent = useContext(Scope)
  return <Scope.Provider value={parent + '/' + JSON.stringify([ownerKey(owner),identityKey(identity)])}>{children}</Scope.Provider>
}
export const useMobileNotices = () => useContext(Notices)

/** Hide only this original notice view. Owners, drafts and recovery operations stay mounted outside it. */
export function MobileNotice({ identity = [], owner, children, className, dismissible = true, kind = 'warning', ...attributes }: HTMLAttributes<HTMLDivElement> & {
  identity?: Identity; owner?: object | null | undefined; dismissible?: boolean; kind?: 'warning' | 'feedback'
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
        presentation ? presentation.dismiss(key) : setLocalDismissed(key)
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
