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
  const current = useRef(target); current.current = target
  const updates = useRef(0)
  useEffect(() => {
    let alive = true
    setLoops([]); setError(undefined); setBusy(false); setPrompt(''); setInterval('30')
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
  const action = (kind: 'pause' | 'resume' | 'stop' | 'check') => loop && void run(() => api.continuousProgress.action(target, loop.loopId, kind))
  return <details className="continuous-progress-control">
    <summary>↻ Continuous progress{loop ? ` · ${loop.status}` : ''}</summary>
    <small className="continuous-progress-control__target">{agentProviderLabel(session.providerId)} · {target.hostId} · {target.agentSessionId}<br />{target.workspacePath}</small>
    {error ? <p role="status">Automatic progress is unconfirmed. Manual input remains available. {error}</p> : null}
    {loop ? <ContinuousProgressPanel loop={{ loopId: loop.loopId, providerLabel: agentProviderLabel(session.providerId),
      executionState: session.status.state, loopState: loop.status,
      ...(loop.status === 'active' ? { nextCheckAt: loop.nextCheckAt } : {}),
      ...(loop.lastDecision ? { lastDecision: loop.lastDecision } : loop.lastOutcome === 'sent' ? { lastDecision: 'Host accepted the request; a new Agent turn is not yet confirmed.' } : {}) }}
      disabled={busy} onPause={() => action('pause')} onResume={() => action('resume')} onStop={() => action('stop')} onCheck={() => action('check')} />
      : <form onSubmit={event => { event.preventDefault(); void run(() => api.continuousProgress.create(target, Number(interval) * 60_000, prompt)) }}>
        <label>Check every (minutes)<input type="number" min="1" value={interval} onChange={event => setInterval(event.target.value)} /></label>
        <label>Continuation prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
        <small>Periodic continuation only. This loop is not bound to a business task source.</small>
        <button type="submit" className="small-button" disabled={busy || !prompt.trim()}>Enable continuous progress</button>
      </form>}
  </details>
}
