import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { RotateCcw, SquareTerminal } from 'lucide-react'
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
  details,
  children,
  className
}: {
  phase: FullPageLoadingPhase
  scope: 'app' | 'region'
  eyebrow?: string
  title: string
  detail: string
  actions?: ReactNode
  details?: { summary: string; content: ReactNode }
  children?: ReactNode
  className?: string
}) {
  const failed = phase === 'failed'
  const busy = phase === 'loading' || phase === 'recovering'
  const surfaceRef = useRef<HTMLElement>(null)
  const frameRef = useRef<number | null>(null)
  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current) }, [])
  function resetLight() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    for (const name of ['--startup-focus-x', '--startup-focus-y', '--startup-offset-x', '--startup-offset-y']) surfaceRef.current?.style.removeProperty(name)
  }
  function moveLight(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const { clientX, clientY } = event
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const surface = surfaceRef.current
      if (!surface) return
      const bounds = surface.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const x = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
      const y = Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height))
      surface.style.setProperty('--startup-focus-x', `${x * 100}%`)
      surface.style.setProperty('--startup-focus-y', `${y * 100}%`)
      surface.style.setProperty('--startup-offset-x', `${(x - .5) * 8}px`)
      surface.style.setProperty('--startup-offset-y', `${(y - .5) * 6}px`)
    })
  }
  return (
    <section
      ref={surfaceRef}
      className={`full-page-loading full-page-loading--${scope} full-page-loading--${phase}${className ? ` ${className}` : ''}`}
      data-loading-phase={phase}
      data-loading-scope={scope}
      onPointerMove={scope === 'app' ? moveLight : undefined}
      onPointerLeave={scope === 'app' ? resetLight : undefined}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-busy={busy}
    >
      {scope === 'app' ? <div className="full-page-loading__atmosphere" aria-hidden="true">
        <img className="full-page-loading__art" src={bannerUrl} alt="" onError={(event) => { event.currentTarget.hidden = true }} />
        <div className="full-page-loading__light" />
      </div> : null}
      <div className="full-page-loading__stage">
        <div className="full-page-loading__brand" aria-hidden="true">{scope === 'app' ? <BrandIcon size={28} /> : busy ? <RotateCcw size={16} /> : <SquareTerminal size={16} />}</div>
        <p className="full-page-loading__eyebrow">{eyebrow}</p>
        {children ?? <><h1>{title}</h1><p className="full-page-loading__detail">{detail}</p></>}
        {busy ? <div className="full-page-loading__activity" aria-hidden="true"><i /><i /><i /></div> : null}
        {details ? <details className="full-page-loading__details"><summary>{details.summary}</summary>{details.content}</details> : null}
        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}
      </div>
    </section>
  )
}
