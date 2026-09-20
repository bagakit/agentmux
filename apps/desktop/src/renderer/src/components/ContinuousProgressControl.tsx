import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { ContinuousProgressPanel } from './ContinuousProgressPanel'
import { agentProviderLabel } from './AgentProviderIcon'

/** Existing Main loop owner is observed only for this Session. Closing the leaf does not stop it. */
export function ContinuousProgressControl({ session }: { session: Extract<SessionSnapshot, { kind: 'agent' }> }) {
  const target = useMemo(() => ({ hostId: session.hostId, agentSessionId: session.id,
    providerId: session.providerId, workspacePath: session.workspacePath }),
  [session.hostId, session.id, session.providerId, session.workspacePath])
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
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
    })
    void api.continuousProgress.list(target).then(result => {
      if (alive && updates.current === before) setLoops(result)
    }, failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { alive = false; dispose() }
  }, [target])
  async function run(action: () => Promise<ContinuousProgressLoop>) {
    if (busy) return
    const captured = target, before = updates.current
    setBusy(true)
    try {
      const result = await action()
      if (current.current === captured && updates.current === before) setLoops(previous => [...previous.filter(loop => loop.loopId !== result.loopId), result])
      if (current.current === captured) setError(undefined)
    } catch (failure) { if (current.current === captured) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (current.current === captured) setBusy(false) }
  }
  const loop = loops.find(loop => loop.status !== 'stopped')
  const displayed = loop ?? loops.at(-1)
  const action = (kind: 'pause' | 'resume' | 'stop' | 'check') => loop && void run(() => api.continuousProgress.action(target, loop.loopId, kind))
  return <details className="continuous-progress-control">
    <summary><span className="continuous-progress-control__label">↻ Continuous progress</span>
      {error || displayed?.lastOutcome === 'unknown' ? <span className="continuous-progress-control__status">Unconfirmed</span>
        : loop ? <span className="continuous-progress-control__status">{loop.status}</span> : null}
    </summary>
    <small className="continuous-progress-control__target">{agentProviderLabel(session.providerId)} · {target.hostId} · {target.agentSessionId}<br />{target.workspacePath}</small>
    {error ? <p role="status">Automatic progress is unconfirmed. Manual input follows terminal readiness. {error}</p> : null}
    {displayed?.taskSource ? <small>Task source: {displayed.taskSource.ownerId}<br />{displayed.taskSource.root}<br />{displayed.taskSource.readerPath}</small> : null}
    {!loop && displayed?.lastDecision ? <p role="status">{displayed.lastDecision}</p> : null}
    {loop ? <ContinuousProgressPanel loop={{ loopId: loop.loopId, providerLabel: agentProviderLabel(session.providerId),
      executionState: session.status.state, loopState: loop.status,
      ...(loop.status === 'active' ? { nextCheckAt: loop.nextCheckAt } : {}),
      ...(loop.lastDecision ? { lastDecision: loop.lastDecision } : loop.lastOutcome === 'sent' ? { lastDecision: 'Host accepted the request; a new Agent turn is not yet confirmed.' } : {}) }}
      disabled={busy} onPause={() => action('pause')} onResume={() => action('resume')} onStop={() => action('stop')} onCheck={() => action('check')} />
      : <form onSubmit={event => { event.preventDefault(); void run(() => api.continuousProgress.create(target, Number(interval) * 60_000, prompt, bindSource ? { root: sourceRoot, ownerId: sourceId, readerPath } : undefined)) }}>
        <label>Check every (minutes)<input type="number" min="1" value={interval} onChange={event => setInterval(event.target.value)} /></label>
        <label>Continuation prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
        <label><input type="checkbox" checked={bindSource} onChange={event => setBindSource(event.target.checked)} />Bind a read-only Feature Tracker source</label>
        {bindSource ? <>
          <label>Tracker root<input aria-label="Tracker root" value={sourceRoot} onChange={event => setSourceRoot(event.target.value)} /></label>
          <label>Feature ID<input aria-label="Feature ID" value={sourceId} onChange={event => setSourceId(event.target.value)} /></label>
          <label>Public Tracker script<input aria-label="Public Tracker script" value={readerPath} onChange={event => setReaderPath(event.target.value)} /></label>
        </> : <small>Periodic continuation only. This loop is not bound to a business task source.</small>}
        <button type="submit" className="small-button" disabled={busy || !prompt.trim() || (bindSource && (!sourceRoot.trim() || !sourceId.trim() || !readerPath.trim()))}>Enable continuous progress</button>
      </form>}
  </details>
}
