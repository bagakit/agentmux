import { ArrowRight, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { currentExecutorDetection } from '../lib/executor-detection'
import { configuredExecutors } from '../lib/executors'
import { focusTakeoverResult, inspectTakeover, takeOverSession, type TakeoverSource } from '../lib/session-takeover'
import { executorDetectionKey, useAppStore } from '../store'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { AgentAvatar } from './AgentAvatar'

/** A local workface transition. The underlying Session and editor stay mounted. */
export function SessionTakeoverSurface({ source, active, onClose }: {
  source: TakeoverSource
  active: boolean
  onClose(): void
}) {
  const config = useAppStore(state => state.config)
  const detections = useAppStore(state => state.executorDetections)
  const detect = useAppStore(state => state.detectExecutors)
  const host = config?.hosts.find(item => item.id === source.hostId)
  const executors = useMemo(() => configuredExecutors(config).map(executor => ({ ...executor,
    detection: source.hostId ? currentExecutorDetection(detections[executorDetectionKey(source.hostId, executor.id)], executor.id, executor, host) : undefined
  })), [config?.executors, detections, host, source.hostId])
  const surface = useRef<HTMLElement>(null)
  const admitted = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const visibleRef = useRef(active)
  visibleRef.current = active
  const returnFocus = useRef<HTMLElement | null>(null)
  const cancelled = useRef(false)
  activeRef.current = active
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [closing, setClosing] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  activeRef.current = active && !closing
  function close(cancel = true) {
    cancelled.current = cancel
    activeRef.current = false
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => {
      onCloseRef.current()
      // Removing an inert local stage may leave focus on BODY. Return explicit
      // cancellation to its exact original trigger after the exit completes.
      if (cancelled.current && visibleRef.current && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140)
    return () => clearTimeout(timer)
  }, [closing])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (active && source.hostId && executors.some(item => !item.detection)) void detect(source.hostId)
  }, [active, source.hostId, executors, detect])
  useLayoutEffect(() => {
    if (!active || closing || !surface.current) return
    const node = surface.current, parent = node.parentElement
    const originalHeader = [...document.querySelectorAll<HTMLElement>('.agent-region-header')].find(item =>
      item.dataset.agentSessionId === source.agentSessionId && item.dataset.ownerRegionId === source.origin.regionId)
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const recoveryTrigger = focused?.isConnected && focused.dataset.takeoverSessionId === source.agentSessionId &&
      focused.dataset.takeoverRegionId === source.origin.regionId ? focused : null
    const previous = recoveryTrigger ?? originalHeader?.querySelector<HTMLElement>('.agent-region-header__more') ?? focused
    returnFocus.current = previous
    const held = Array.from(parent?.children ?? []).filter((item): item is HTMLElement => item instanceof HTMLElement && item !== node)
      .map(item => ({ item, inert: item.inert }))
    held.forEach(({ item }) => { item.inert = true })
    // The Region menu yields its close focus; the local surface owns entry focus,
    // including when the original Header is portalled into the Focus bar.
    const frame = requestAnimationFrame(() => (node.querySelector<HTMLButtonElement>('.agent-pick:not(:disabled)') ??
      node.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]'))?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      held.forEach(({ item, inert }) => { item.inert = inert })
      if (node.contains(document.activeElement) || document.activeElement === document.body) {
        const target = previous?.isConnected ? previous : parent?.querySelector<HTMLElement>('.agent-region-header__more')
        target?.focus({ preventScroll: true })
      }
    }
  }, [active, closing])
  async function accept(report: AgentMuxSpaceMutationReport) {
    if (!mounted.current) return
    if (report.outcome === 'opened') {
      if (activeRef.current) focusTakeoverResult(source, report)
      close(false)
      return
    }
    setUnconfirmed(true)
    setIssue(report.issues.map(item => item.message).join('\n') || 'The creation result is unconfirmed. Your original work is kept.')
  }
  async function choose(id: string) {
    if (admitted.current || !activeRef.current) return
    admitted.current = true
    // A focused choice becomes disabled while submitting. Keep keyboard cancel
    // inside the workface rather than letting Chromium drop focus to BODY.
    surface.current?.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]')?.focus({ preventScroll: true })
    setSelected(id); setBusy(true); setIssue(null)
    try { await accept(await takeOverSession(source, id, () => mounted.current && activeRef.current)) }
    catch (error) {
      if (mounted.current) {
        setIssue(presentError(error))
        // A retained spatial intent may already have launched. Re-read it rather
        // than resubmitting after a transport/projection failure.
        setUnconfirmed(true)
      }
    } finally { if (mounted.current) setBusy(false) }
  }
  async function check() {
    if (busy || !activeRef.current) return
    surface.current?.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]')?.focus({ preventScroll: true })
    setBusy(true)
    try {
      const report = await inspectTakeover(source)
      if (report) await accept(report)
      else { admitted.current = false; setUnconfirmed(false); setSelected(null); setIssue(null) }
    } catch (error) { if (mounted.current) setIssue(presentError(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const sourceExecutor = source.executorId ? config?.executors[source.executorId] : undefined
  return <section ref={surface} className="session-takeover" aria-label="Take over this work" hidden={!active} inert={closing || !active}
    data-motion-active={active} data-state={closing ? 'closing' : 'open'} aria-busy={busy}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }}>
    <div className="session-takeover__content">
      <div className="session-takeover__origin">
        <AgentAvatar executorId={source.executorId} providerId={sourceExecutor?.providerId} label={source.label} size={22} />
        <span title={source.label}>{source.label}</span><ArrowRight size={14} aria-hidden="true" />
        <span className="session-takeover__destination">Next Agent</span>
      </div>
      <header className="session-takeover__heading">
        <div><h2>Keep the work moving.</h2><p>Choose an Agent to take over.</p></div>
        <button type="button" className="icon-button session-takeover__cancel" aria-label="Cancel takeover" title="Cancel · Esc" onClick={() => close()}><X size={16} /></button>
      </header>
      <AgentExecutorPicker executors={executors} selected={selected} active={active && !closing} disabled={busy || unconfirmed}
        onSelect={id => { void choose(id) }} />
      <div className="session-takeover__footer" aria-live="polite">
        {busy ? <span><LoaderCircle size={13} className="spin" />{unconfirmed ? 'Checking the original request…' : 'Passing the work to your Agent…'}</span>
          : <span>Context follows automatically. Your original session stays here.</span>}
        <button type="button" className="session-takeover__back" onClick={() => close()}>Back<span aria-hidden="true">Esc</span></button>
      </div>
      {issue ? <div className="session-takeover__issue" role="status">
        <strong>{unconfirmed ? 'Takeover is not confirmed' : 'Could not take over'}</strong><p>{issue}</p>
        <button type="button" className="small-button" disabled={busy} onClick={() => { void check() }}><RefreshCw size={12} /> Check again</button>
      </div> : null}
    </div>
  </section>
}
