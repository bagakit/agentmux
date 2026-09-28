import { useEffect, useState, type ReactNode } from 'react'
import { BrandIcon } from './BrandIcon'
import bannerUrl from '../../../../resources/settings-banner.png'

export type FullPageLoadingPhase = 'loading' | 'recovering' | 'failed' | 'parked'

/**
 * Shared full-surface loading stage. It owns presentation only: lifecycle facts,
 * retry policy and durable layout state stay with the caller.
 */
export function FullPageLoadingSurface({
  phase,
  scope,
  eyebrow = 'AgentMux',
  title,
  detail,
  actions,
  children,
  className
}: {
  phase: FullPageLoadingPhase
  scope: 'app' | 'region'
  eyebrow?: string
  title: string
  detail: string
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const failed = phase === 'failed'
  const busy = phase === 'loading' || phase === 'recovering'
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return (
    <section
      className={`full-page-loading full-page-loading--${scope} full-page-loading--${phase}${className ? ` ${className}` : ''}`}
      data-loading-phase={phase}
      data-loading-scope={scope}
      data-document-visible={documentVisible}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-busy={busy}
    >
      <div className="full-page-loading__atmosphere" aria-hidden="true">
        <img className="full-page-loading__art" src={bannerUrl} alt="" onError={(event) => { event.currentTarget.hidden = true }} />
        <div className="full-page-loading__light" />
      </div>
      <div className="full-page-loading__stage">
        <div className="full-page-loading__brand"><BrandIcon size={scope === 'app' ? 28 : 22} /></div>
        <p className="full-page-loading__eyebrow">{eyebrow}</p>
        {children ?? <><h1>{title}</h1><p className="full-page-loading__detail">{detail}</p></>}
        {busy ? <div className="full-page-loading__activity" aria-hidden="true"><i /></div> : null}
        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}
      </div>
    </section>
  )
}
