import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ContinuousProgressPanel } from './ContinuousProgressPanel'
import { ComposerTextarea } from './ComposerTextarea'
import { agentProviderLabel } from './AgentProviderIcon'

export type ContinuousProgressStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'

/** Existing Main loop owner is observed only for this Session, even while its mailbox page is hidden. */
export function ContinuousProgressControl({ session, onStatusChange }: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  onStatusChange?: (status: ContinuousProgressStatus) => void
}) {
  const target = useMemo(() => ({ hostId: session.hostId, agentSessionId: session.id,
    providerId: session.providerId, workspacePath: session.workspacePath }),
  [session.hostId, session.id, session.providerId, session.workspacePath])
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
  const [observedTarget, setObservedTarget] = useState<typeof target>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [interval, setInterval] = useState('30')
  const [prompt, setPrompt] = useState('')
  const [bindSource, setBindSource] = useState(false)
  const [sourceRoot, setSourceRoot] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [readerPath, setReaderPath] = useState('')
  const current = useRef(target); current.current = target
  const updates = useRef(0)
  useEffect(() => {
    let alive = true
    setLoops([]); setError(undefined); setBusy(false); setPrompt(''); setInterval('30'); setBindSource(false); setSourceRoot(''); setSourceId(''); setReaderPath('')
    const before = updates.current
    const dispose = api.continuousProgress.onChanged(loop => {
      if (!alive || loop.hostId !== target.hostId || loop.agentSessionId !== target.agentSessionId ||
          loop.providerId !== target.providerId || loop.workspacePath !== target.workspacePath) return
      updates.current++
      setLoops(previous => [...previous.filter(value => value.loopId !== loop.loopId), loop])
      setObservedTarget(target)
    })
    void api.continuousProgress.list(target).then(result => {
      if (alive && updates.current === before) { setLoops(result); setObservedTarget(target) }
    }, failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { alive = false; dispose() }
  }, [target])
  async function run(action: () => Promise<ContinuousProgressLoop>) {
    if (busy) return
    const captured = target, before = updates.current
    setBusy(true)
    try {
      const result = await action()
      if (current.current === captured && updates.current === before) {
        setLoops(previous => [...previous.filter(loop => loop.loopId !== result.loopId), result]); setObservedTarget(target)
      }
      if (current.current === captured) setError(undefined)
    } catch (failure) { if (current.current === captured) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (current.current === captured) setBusy(false) }
  }
  const loop = observedTarget === target ? loops.find(loop => loop.status !== 'stopped') : undefined
  const displayed = loop ?? (observedTarget === target ? loops.at(-1) : undefined)
  const status: ContinuousProgressStatus = error || displayed?.lastOutcome === 'unknown' || observedTarget !== target
    ? 'unconfirmed' : loop?.status === 'active' ? 'active' : loop?.status === 'paused' ? 'paused' : 'inactive'
  useEffect(() => { onStatusChange?.(status) }, [onStatusChange, status])
  const action = (kind: 'pause' | 'resume' | 'stop' | 'check') => loop && void run(() => api.continuousProgress.action(target, loop.loopId, kind))
  return <div className="continuous-progress-control" data-progress-state={status}>
    <header className="continuous-progress-control__heading">
      <h3>Continuous progress</h3>
      <span>{status === 'unconfirmed' ? 'Unconfirmed' : displayed?.status === 'stopped' ? 'Stopped' : status === 'inactive' ? 'Not enabled' : status === 'active' ? 'Active' : 'Paused'}</span>
    </header>
    {status === 'unconfirmed' ? <p className="continuous-progress-control__notice" role="status">Automatic progress is unconfirmed. {observedTarget !== target && !error ? 'Waiting for loop status. ' : ''}Manual input follows terminal readiness.{error ? ` ${error}` : ''}</p> : null}
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
        {displayed.taskSource ? <dl>
          <dt>Feature ID</dt><dd>{displayed.taskSource.ownerId}</dd>
          <dt>Tracker root</dt><dd>{displayed.taskSource.root}</dd>
          <dt>Public Tracker script</dt><dd>{displayed.taskSource.readerPath}</dd>
        </dl> : <p className="continuous-progress-control__help">No task source bound. Periodic continuation only.</p>}
      </div>
    </details> : null}
    {!loop ? <form onSubmit={event => { event.preventDefault(); void run(() => api.continuousProgress.create(target, Number(interval) * 60_000, prompt, bindSource ? { root: sourceRoot, ownerId: sourceId, readerPath } : undefined)) }}>
      <section className="continuous-progress-control__group" aria-label="Continuation settings">
        <h4>Continuation settings</h4>
        <label className="continuous-progress-control__interval">Check every (minutes)<input type="number" min="1" value={interval} onChange={event => setInterval(event.target.value)} /></label>
        <label>Continuation prompt<ComposerTextarea value={prompt} onValueChange={setPrompt} /></label>
      </section>
      <section className="continuous-progress-control__group" aria-label="Optional task source">
        <h4>Optional task source</h4>
        <label><input type="checkbox" checked={bindSource} onChange={event => setBindSource(event.target.checked)} />Bind a read-only Feature Tracker source</label>
        {bindSource ? <div className="continuous-progress-control__source-fields">
          <label>Tracker root<input aria-label="Tracker root" value={sourceRoot} onChange={event => setSourceRoot(event.target.value)} /></label>
          <label>Feature ID<input aria-label="Feature ID" value={sourceId} onChange={event => setSourceId(event.target.value)} /></label>
          <label>Public Tracker script<input aria-label="Public Tracker script" value={readerPath} onChange={event => setReaderPath(event.target.value)} /></label>
        </div> : <p className="continuous-progress-control__help">Periodic continuation only. This loop is not bound to a business task source.</p>}
      </section>
        <button type="submit" className="small-button" disabled={busy || !prompt.trim() || (bindSource && (!sourceRoot.trim() || !sourceId.trim() || !readerPath.trim()))}>Enable continuous progress</button>
      </form> : null}
    <details className="continuous-progress-control__details" data-progress-details="target" onToggle={event => event.stopPropagation()}>
      <summary>Target details</summary>
      <dl className="continuous-progress-control__detail-body">
        <dt>Provider</dt><dd>{agentProviderLabel(session.providerId)} ({target.providerId})</dd>
        <dt>Host</dt><dd>{target.hostId}</dd>
        <dt>Session</dt><dd>{target.agentSessionId}</dd>
        <dt>Workspace</dt><dd>{target.workspacePath}</dd>
      </dl>
    </details>
  </div>
}
