import type { ReactNode } from 'react'
import { BrandIcon } from './BrandIcon'

export type FullPageLoadingPhase = 'loading' | 'recovering' | 'failed'

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
  return (
    <section
      className={`full-page-loading full-page-loading--${scope} full-page-loading--${phase}${className ? ` ${className}` : ''}`}
      data-loading-phase={phase}
      data-loading-scope={scope}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-busy={!failed}
    >
      <div className="full-page-loading__grid" aria-hidden="true" />
      <div className="full-page-loading__stage">
        <div className="full-page-loading__signal" aria-hidden="true">
          <span /><span /><span />
          <i />
          <b>+</b>
        </div>
        <div className="full-page-loading__brand"><BrandIcon size={scope === 'app' ? 36 : 28} /></div>
        <p className="full-page-loading__eyebrow">{eyebrow}</p>
        {children ?? <><h1>{title}</h1><p className="full-page-loading__detail">{detail}</p></>}
        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}
      </div>
    </section>
  )
}
