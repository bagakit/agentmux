import { mintObjectId } from '@agentmux/core/object-id'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isAgentSchedule, type ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ContinuousProgressPanel } from './ContinuousProgressPanel'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { agentProviderLabel } from './AgentProviderIcon'
import { CalendarScheduleControl } from './CalendarScheduleControl'
import { useAppStore } from '../store'
import { resolveAutomationPreferences } from '../../../shared/automation-preferences'

export type ContinuousProgressStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'

/** Read the original Host only for this visible Session consumer; retained forms stay mounted. */
export function ContinuousProgressControl({ session, onStatusChange, presented = true, visible = presented }: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  onStatusChange?: (status: ContinuousProgressStatus) => void
  /** Only the detail DOM waits for first use; observation and action state stay mounted. */
  presented?: boolean
  /** Visibility controls presentation work without discarding retained forms. */
  visible?: boolean
}) {
  const displayPath = usePathDisplay()
  const target = useMemo(() => ({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId,
    providerId: session.providerId, workspacePath: session.workspacePath }),
  [session.control.hostId, session.control.agentSessionId, session.providerId, session.workspacePath])
  const targetKey = JSON.stringify([target.hostId, target.agentSessionId, target.providerId, target.workspacePath])
  const [initialDefaults] = useState(() => resolveAutomationPreferences(useAppStore.getState().config?.automation))
  const form = useRef({ target, defaults: initialDefaults })
  if (form.current.target !== target) form.current = { target, defaults: resolveAutomationPreferences(useAppStore.getState().config?.automation) }
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
  const [observedTarget, setObservedTarget] = useState<typeof target>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [calendarStatus, setCalendarStatus] = useState<ContinuousProgressStatus>('unconfirmed')
  const [interval, setInterval] = useState(() => String(initialDefaults.progressIntervalMs / 60_000))
  const [prompt, setPrompt] = useState(initialDefaults.progressPrompt)
  const [bindSource, setBindSource] = useState(false)
  const [sourceRoot, setSourceRoot] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [readerPath, setReaderPath] = useState('')
  const hadLoop = useRef(false), edited = useRef(false), progressFormElement = useRef<HTMLFormElement>(null)
  const current = useRef(target); current.current = target
  const updates = useRef(0)
  const reads = useRef(new Map<string, Promise<ContinuousProgressLoop[]>>())
  useEffect(() => {
    updates.current++
    hadLoop.current = false; edited.current = false
    setLoops([]); setError(undefined); setBusy(false); setPrompt(form.current.defaults.progressPrompt); setInterval(String(form.current.defaults.progressIntervalMs / 60_000)); setBindSource(false); setSourceRoot(''); setSourceId(''); setReaderPath('')
  }, [target])
  useEffect(() => {
    if (!visible) return
    let alive = true, reading = false, reread = false
    const refresh = async () => {
      if (!alive || document.hidden) return
      if (reading) { reread = true; return }
      reading = true
      let readCut = updates.current
      try {
        const pending = reads.current.get(targetKey)
        if (pending) await pending.catch(() => {})
        if (!alive || document.hidden) return
        const before = updates.current, request = api.continuousProgress.list(target); readCut = before
        reads.current.set(targetKey, request)
        try {
          const result = await request
          if (alive && !document.hidden && current.current === target && updates.current === before) {
            setLoops(result.filter(loop => !isAgentSchedule(loop))); setObservedTarget(target); setError(undefined)
          }
        } finally { if (reads.current.get(targetKey) === request) reads.current.delete(targetKey) }
      } catch (failure) { if (alive && !document.hidden && updates.current === readCut) setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { reading = false; if (reread) { reread = false; void refresh() } }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    const visibility = () => { void refresh() }
    document.addEventListener('visibilitychange', visibility)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [target, targetKey, visible])
  async function run(action: () => Promise<ContinuousProgressLoop>) {
    if (busy) return
    const captured = target, before = ++updates.current
    setBusy(true)
    try {
      const result = await action()
      if (current.current === captured && updates.current === before) {
        updates.current++
        setLoops(previous => [...previous.filter(loop => loop.loopId !== result.loopId), result]); setObservedTarget(target)
      }
      if (current.current === captured) setError(undefined)
    } catch (failure) { if (current.current === captured) { updates.current++; setError(failure instanceof Error ? failure.message : String(failure)) } }
    finally { if (current.current === captured) setBusy(false) }
  }
  const loop = observedTarget === target ? loops.find(loop => loop.status !== 'stopped') : undefined
  const displayed = loop ?? (observedTarget === target ? loops.at(-1) : undefined)
  useEffect(() => {
    if (loop) { hadLoop.current = true; return }
    if (observedTarget !== target || !hadLoop.current) return
    hadLoop.current = false
    if (edited.current || progressFormElement.current?.contains(document.activeElement)) return
    const defaults = resolveAutomationPreferences(useAppStore.getState().config?.automation)
    form.current.defaults = defaults
    setInterval(String(defaults.progressIntervalMs / 60_000)); setPrompt(defaults.progressPrompt)
    setBindSource(false); setSourceRoot(''); setSourceId(''); setReaderPath('')
  }, [target, loop?.loopId, observedTarget])
  const status: ContinuousProgressStatus = error || displayed?.lastOutcome === 'unknown' || observedTarget !== target
    ? 'unconfirmed' : loop?.status === 'active' ? 'active' : loop?.status === 'paused' ? 'paused' : 'inactive'
  const combinedStatus = [status, calendarStatus].includes('unconfirmed') ? 'unconfirmed' : [status, calendarStatus].includes('active') ? 'active' : [status, calendarStatus].includes('paused') ? 'paused' : 'inactive'
  useEffect(() => { onStatusChange?.(combinedStatus) }, [onStatusChange, combinedStatus])
  const action = (kind: 'pause' | 'resume' | 'stop' | 'check') => loop && void run(() => api.continuousProgress.action(target, loop.loopId, kind, loop, mintObjectId()))
  const progress = displayed || status === 'unconfirmed' ? <>
    {status === 'unconfirmed' ? <p className="continuous-progress-control__notice" role="status">Automatic progress is unconfirmed. {observedTarget !== target && !error ? 'Waiting for loop status. ' : ''}Manual input follows terminal readiness.{error ? ` ${error}` : ''}</p> : null}
    <details className="continuous-progress-control__details" data-progress-details="interval" onToggle={event => event.stopPropagation()}>
      <summary><span className="automation-progress__title">Continuous progress</span> <span>{status === 'unconfirmed' ? 'Unconfirmed' : displayed?.status === 'stopped' ? 'Stopped' : status === 'inactive' ? 'Not enabled' : status === 'active' ? 'Active' : 'Paused'}</span>{displayed ? <small className="automation-progress__summary">{displayed.prompt.split('\n')[0]} · every {displayed.intervalMs / 60000} min</small> : null}</summary>
      <div className="continuous-progress-control__detail-body">
    {displayed ? <ContinuousProgressPanel loop={{ loopId: displayed.loopId, providerLabel: agentProviderLabel(session.providerId),
      executionState: session.status.state, loopState: displayed.status,
      ...(displayed.status === 'active' && status !== 'unconfirmed' ? { nextCheckAt: displayed.nextCheckAt } : {}),
      ...(displayed.lastTickAt !== undefined ? { lastTickAt: displayed.lastTickAt } : {}),
      ...(displayed.lastDecision ? { lastDecision: displayed.lastDecision } : displayed.lastOutcome === 'sent' ? { lastDecision: 'Host accepted the request; a new Agent turn is not yet confirmed.' } : {}) }}
      unconfirmed={status === 'unconfirmed'}
      disabled={busy} onPause={() => action('pause')} onResume={() => action('resume')} onStop={() => action('stop')} onCheck={() => action('check')} />
      : null}
    {displayed ? <details className="continuous-progress-control__details" data-progress-details="configuration" onToggle={event => event.stopPropagation()}>
      <summary>Saved configuration <span>Read only</span></summary>
      <div className="continuous-progress-control__detail-body">
        <dl><dt>Check every</dt><dd>{displayed.intervalMs / 60_000} minutes</dd></dl>
        <div><h4>Continuation prompt</h4><p className="continuous-progress-control__prompt">{displayed.prompt}</p></div>
        {displayed.taskSource?.kind === 'goal' ? <dl><dt>Goal</dt><dd>{displayed.taskSource.goalId}</dd><dt>Confirmed scope</dt><dd>r{displayed.taskSource.alignmentRevision}</dd></dl> : displayed.taskSource ? <dl>
          <dt>Feature ID</dt><dd>{displayed.taskSource.ownerId}</dd>
          <dt>Tracker root</dt><dd>{displayed.taskSource.root}</dd>
          <dt>Public Tracker script</dt><dd>{displayed.taskSource.readerPath}</dd>
        </dl> : <p className="continuous-progress-control__help">No task source bound. Periodic continuation only.</p>}
      </div>
    </details> : null}
      </div>
    </details>
  </> : null
  const progressForm = <form ref={progressFormElement} aria-label="Continuous progress setup" onChange={() => { edited.current = true }} onSubmit={event => { event.preventDefault(); if (!loop) void run(() => api.continuousProgress.create(target, Number(interval) * 60_000, prompt, bindSource ? { root: sourceRoot, ownerId: sourceId, readerPath } : undefined)) }}>
      <section className="continuous-progress-control__group" aria-label="Continuation settings">
        <h4>Continuation settings</h4>
        <label className="continuous-progress-control__interval">Check every (minutes)<TextInput type="number" min="1" value={interval} onChange={event => setInterval(event.target.value)} /></label>
        <label>Continuation prompt<ComposerTextarea value={prompt} onValueChange={setPrompt} /></label>
      </section>
      <section className="continuous-progress-control__group" aria-label="Optional task source">
        <h4>Optional task source</h4>
        <label><input type="checkbox" checked={bindSource} onChange={event => setBindSource(event.target.checked)} />Bind a read-only Feature Tracker source</label>
        {bindSource ? <div className="continuous-progress-control__source-fields">
          <label>Tracker root<TextInput aria-label="Tracker root" value={sourceRoot} onChange={event => setSourceRoot(event.target.value)} /></label>
          <label>Feature ID<TextInput aria-label="Feature ID" value={sourceId} onChange={event => setSourceId(event.target.value)} /></label>
          <label>Public Tracker script<TextInput aria-label="Public Tracker script" value={readerPath} onChange={event => setReaderPath(event.target.value)} /></label>
        </div> : <p className="continuous-progress-control__help">Periodic continuation only. This loop is not bound to a business task source.</p>}
      </section>
        {loop ? <p className="continuous-progress-control__help">Continuous progress is already configured above. Your draft is kept.</p> : null}
        <button type="submit" className="small-button" disabled={!!loop || busy || !prompt.trim() || (bindSource && (!sourceRoot.trim() || !sourceId.trim() || !readerPath.trim()))}>Enable continuous progress</button>
      </form>
  return <div className="continuous-progress-control" data-progress-state={status}>
    <div className="automation-target"><span>Sending to</span><strong>{session.label}</strong><small>{target.agentSessionId}</small></div>
    <CalendarScheduleControl target={target} onStatusChange={setCalendarStatus} presented={visible} unified
      progress={presented ? progress : null} progressForm={presented ? progressForm : null} />
    {presented ? <>
    <details className="continuous-progress-control__details" data-progress-details="target" onToggle={event => event.stopPropagation()}>
      <summary>Target details</summary>
      <dl className="continuous-progress-control__detail-body">
        <dt>Provider</dt><dd>{agentProviderLabel(session.providerId)} ({target.providerId})</dd>
        <dt>Host</dt><dd>{target.hostId}</dd>
        <dt>Session</dt><dd>{target.agentSessionId}</dd>
        <dt>Workspace</dt><dd title={displayPath(target.workspacePath, target.hostId)}>{displayPath(target.workspacePath, target.hostId)}</dd>
      </dl>
    </details>
    </> : null}
  </div>
}
