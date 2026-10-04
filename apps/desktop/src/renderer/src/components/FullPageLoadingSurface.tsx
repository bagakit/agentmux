import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { ChevronRight, RotateCcw, SquareTerminal } from 'lucide-react'
import bannerUrl from '../../../../resources/startup-background.png'

export type FullPageLoadingPhase = 'loading' | 'recovering' | 'failed' | 'parked'

/** Local waiting time is presentation, never evidence of Agent or Runtime progress. */
function WaitingActivity({ surface }: { surface: RefObject<HTMLElement | null> }) {
  const [seconds, setSeconds] = useState(0)
  const [visible, setVisible] = useState(true)
  const activity = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const startedAt = Date.now()
    let inView = true
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    function syncVisibility() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      const node = surface.current
      const style = node && window.getComputedStyle(node)
      // Retained hosts keep their geometry. Their existing parking CSS pauses
      // motion even when IntersectionObserver still reports an intersection.
      const parked = activity.current && window.getComputedStyle(activity.current).animationPlayState === 'paused'
      const shown = inView && !document.hidden && node?.isConnected === true &&
        style?.display !== 'none' && style?.visibility !== 'hidden' && !parked
      setVisible(shown)
      if (shown) { tick(); timer = setInterval(tick, 1000) }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting)
      syncVisibility()
    })
    const ancestors = new MutationObserver(() => { observeAncestors(); syncVisibility() })
    function observeAncestors() {
      ancestors.disconnect()
      // Only the current ancestor chain: no subtree scan or unrelated Session
      // facts. A retained host move rebinds this same presentation consumer.
      for (let node: HTMLElement | null = surface.current; node; node = node.parentElement) {
        ancestors.observe(node, { attributes: true, childList: true,
          attributeFilter: ['class', 'style', 'hidden', 'data-active', 'data-workbench-layout-state'] })
      }
    }
    observeAncestors()
    if (surface.current) observer?.observe(surface.current)
    document.addEventListener('visibilitychange', syncVisibility)
    syncVisibility()
    return () => {
      if (timer !== undefined) clearInterval(timer)
      observer?.disconnect()
      ancestors.disconnect()
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [surface])
  return <span className="full-page-loading__waiting" data-waiting-visible={visible} aria-live="off">
    <RotateCcw ref={activity} className="full-page-loading__activity" size={18} aria-hidden="true" />
    <span>{seconds >= 15 ? 'Still waiting' : 'Waiting'}</span>
    <span className="full-page-loading__elapsed" aria-label="Time waiting in this view">{seconds}s</span>
  </span>
}

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
  supplement,
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
  supplement?: ReactNode
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
      aria-label={eyebrow}
      aria-live="polite"
      aria-busy={busy}
    >
      {scope === 'app' ? <div className="full-page-loading__atmosphere" aria-hidden="true">
        <img className="full-page-loading__art" src={bannerUrl} alt="" onError={(event) => { event.currentTarget.hidden = true }} />
        <div className="full-page-loading__light" />
      </div> : null}
      <div className="full-page-loading__stage">
        {children ?? <div className="full-page-loading__heading">
            {busy ? <WaitingActivity key={phase} surface={surfaceRef} /> : null}
            <h1>{title}</h1>
            {!busy && scope === 'region' ? <span className="full-page-loading__mark" aria-hidden="true"><SquareTerminal size={18} /></span> : null}
        </div>}
        {actions ? <div className="full-page-loading__actions">{actions}</div> : null}
        {children == null && detail ? <p className="full-page-loading__detail">{detail}</p> : null}
        {supplement}
        {details ? <details className="full-page-loading__details"><summary><ChevronRight size={12} aria-hidden="true" />{details.summary}</summary>{details.content}</details> : null}
      </div>
    </section>
  )
}
