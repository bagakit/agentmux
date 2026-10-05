import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { DemandRecord } from '../lib/global-demand-board'
import { sessionPresentationById } from '../lib/session-presentation'
import { SelectionField } from './SelectionField'
import { useAppStore } from '../store'

/** A thin original Goal caller, shared by Goal details and the Mote current-work surface. */
export function GoalContinuationControl({ demand, initialSessionId, onRefresh, active = true }: {
  demand: DemandRecord; initialSessionId?: string; onRefresh?: () => void; active?: boolean
}) {
  const observedLinked = useAppStore(useShallow(state => {
    if (!active) return null
    const byId = sessionPresentationById(state.sessions)
    return Object.fromEntries(demand.sessionIds.flatMap(id => {
      const session = byId.get(id)
      return session?.kind === 'agent' && session.control.agentSessionId === id ? [[id, session.label]] : []
    }))
  }))
  const retainedLinked = useRef<{ goalId: string; value: Record<string, string> } | null>(null)
  if (observedLinked !== null) retainedLinked.current = { goalId: demand.id, value: observedLinked }
  if (retainedLinked.current?.goalId !== demand.id) {
    const byId = sessionPresentationById(useAppStore.getState().sessions)
    retainedLinked.current = { goalId: demand.id, value: Object.fromEntries(demand.sessionIds.flatMap(id => {
      const session = byId.get(id); return session?.kind === 'agent' && session.control.agentSessionId === id ? [[id, session.label]] : []
    })) }
  }
  const linked = retainedLinked.current.value
  const execute = useAppStore(state => state.executeControl)
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
  const [selected, setSelected] = useState(initialSessionId ?? '')
  const [minutes, setMinutes] = useState('30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [observedGoal, setObservedGoal] = useState<string>()
  const occurrence = useMemo(() => ({ goalId: demand.id }), [demand.id])
  const scope = useRef(occurrence); scope.current = occurrence
  const inspected = useRef<object | null>(null)
  const flight = useRef<object | undefined>(undefined)
  const mutation = useRef<{ goalId: string; loopId: string; action: 'pause' | 'resume' | 'stop' | 'check'; expectedRevision: number; operationId: string } | undefined>(undefined)
  const attempt = useRef<{ goalId: string; sessionId: string; intervalMs: number; alignmentRevision: number; operationId: string } | undefined>(undefined)
  async function inspect(goalId = demand.id, owner = scope.current) {
    inspected.current = owner
    const result = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation: 'demand.show', demandId: goalId })
    if (scope.current !== owner || result.operation !== 'demand.show') return
    setLoops(result.goalContinuations); setObservedGoal(goalId)
  }
  useEffect(() => {
    setLoops([]); setObservedGoal(undefined); setError(undefined); setBusy(false)
    setSelected(initialSessionId ?? ''); attempt.current = undefined; mutation.current = undefined; flight.current = undefined
    inspected.current = null
  }, [demand.id])
  useEffect(() => {
    if (!active || inspected.current === occurrence) return
    const owner = occurrence
    void inspect(demand.id, owner).catch(failure => { if (scope.current === owner) setError(failure instanceof Error ? failure.message : String(failure)) })
  }, [active, demand.id])
  async function run(action: () => Promise<unknown>) {
    if (flight.current) return
    const goalId = demand.id, owner = occurrence, token = {}
    flight.current = token
    setBusy(true)
    try { await action(); if (scope.current === owner) { setError(undefined); await inspect(goalId, owner); if (scope.current === owner) onRefresh?.() } }
    catch (failure) {
      if (scope.current === owner) { setError(failure instanceof Error ? failure.message : String(failure)); await inspect(goalId, owner).catch(() => {}) }
    } finally { if (flight.current === token) { flight.current = undefined; if (scope.current === owner) setBusy(false) } }
  }
  function start(retry = false) {
    if (flight.current || mutation.current) return
    const alignment = demand.alignment
    if (!retry) {
      if (alignment?.confirmedAt == null || !Object.hasOwn(linked, selected)) return
      attempt.current = { goalId: demand.id, sessionId: selected, intervalMs: Number(minutes) * 60_000, alignmentRevision: alignment.revision, operationId: crypto.randomUUID() }
    }
    const saved = attempt.current
    if (!saved || saved.goalId !== demand.id) return
    void run(() => execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: saved.operationId, operation: 'demand.start', demandId: saved.goalId, sessionId: saved.sessionId, continuation: { intervalMs: saved.intervalMs, alignmentRevision: saved.alignmentRevision } }))
  }
  function retrySavedStart(loop: ContinuousProgressLoop) {
    if (flight.current || mutation.current || loop.taskSource?.kind !== 'goal' || loop.taskSource.goalId !== demand.id ||
        !loop.creationOperationId || loop.initialDelivery?.operationId !== loop.creationOperationId || loop.initialDelivery.state === 'confirmed') return
    attempt.current = { goalId: demand.id, sessionId: loop.agentSessionId, intervalMs: loop.intervalMs,
      alignmentRevision: loop.taskSource.alignmentRevision, operationId: loop.creationOperationId }
    start(true)
  }
  function mutate(loop: ContinuousProgressLoop, action: 'pause' | 'resume' | 'stop' | 'check', retry = false) {
    if (flight.current) return
    if (!retry) {
      if (mutation.current || !Number.isSafeInteger(loop.revision) || !loop.revision || loop.revision < 1) return
      mutation.current = { goalId: demand.id, loopId: loop.loopId, action, expectedRevision: loop.revision, operationId: crypto.randomUUID() }
    }
    const saved = mutation.current
    if (!saved || saved.goalId !== demand.id || saved.loopId !== loop.loopId || saved.action !== action) return
    const owner = occurrence
    void run(async () => {
      await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: saved.operationId, operation: 'demand.continuation-action', demandId: saved.goalId, loopId: saved.loopId, action: saved.action, expectedRevision: saved.expectedRevision })
      if (scope.current === owner && mutation.current === saved) mutation.current = undefined
    })
  }
  const currentLoops = observedGoal === demand.id ? loops : []
  return <section className="goals-continuation" aria-label="Goal continuous progress">
    <div className="goals-continuation__heading"><span>Continue this work</span><button type="button" className="goals-button" disabled={busy} onClick={() => void run(() => inspect())}>Refresh</button></div>
    {error ? <p className="goals-service" role="status">{error}</p> : null}
    {observedGoal !== demand.id && !error ? <p className="goals-service">Checking the original continuation…</p> : null}
    {currentLoops.map(loop => <div className="goals-continuation__saved" key={loop.loopId}>
      <div><strong>{loop.status === 'active' ? 'Continuing' : loop.status === 'paused' ? 'Paused' : 'Stopped'}</strong><span>Scope r{loop.taskSource?.kind === 'goal' ? loop.taskSource.alignmentRevision : '?'}</span></div>
      <p>{loop.lastDecision ?? (loop.initialDelivery?.state !== 'confirmed' ? 'The original start receipt is unconfirmed. Your Agent and input are retained.' : 'Uses the same executing Agent. Host acceptance does not mean work is complete.')}</p>
      {loop.status === 'active' ? <small>Next check {new Date(loop.nextCheckAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}
      {loop.status !== 'stopped' && loop.initialDelivery && loop.initialDelivery.state !== 'confirmed' ? <button type="button" className="goals-button" disabled={busy || Boolean(mutation.current)} onClick={() => retrySavedStart(loop)}>Inspect and retry original start</button> : null}
      <div className="goals-continuation__actions">{(['pause', 'resume', 'check', 'stop'] as const).filter(action => action === 'stop' ? loop.status !== 'stopped' : action === 'resume' ? loop.status === 'paused' && loop.initialDelivery?.state === 'confirmed' : loop.status === 'active').map(action => <button type="button" className="goals-button" key={action} disabled={busy || Boolean(mutation.current) || !Number.isSafeInteger(loop.revision) || !loop.revision} onClick={() => mutate(loop, action)}>{action === 'check' ? 'Check now' : action.charAt(0).toUpperCase() + action.slice(1)}</button>)}</div>
    </div>)}
    {!currentLoops.some(loop => loop.status !== 'stopped') && observedGoal === demand.id ? <form onSubmit={event => { event.preventDefault(); start() }}>
      <label>Executing Agent<SelectionField label="Goal continuation Agent" value={selected} onValueChange={value => { setSelected(value); attempt.current = undefined }} options={[{ value: '', label: 'Choose an associated Agent…' }, ...Object.entries(linked).map(([id, label]) => ({ value: id, label }))]} /></label>
      <label>Check every<TextInput aria-label="Goal continuation minutes" type="number" min="1" value={minutes} onChange={event => { setMinutes(event.target.value); attempt.current = undefined }} /> minutes</label>
      <button type="submit" className="goals-button" disabled={busy || Boolean(mutation.current) || demand.alignment?.confirmedAt == null || !Object.hasOwn(linked, selected) || !Number.isFinite(Number(minutes)) || Number(minutes) < 1}>Start and continue</button>
      {demand.alignment?.confirmedAt == null ? <p className="goals-service">Confirm this Goal’s scope before enabling automatic work.</p> : null}
    </form> : null}
    {error && mutation.current?.goalId === demand.id ? <button type="button" className="goals-button" disabled={busy} onClick={() => { const saved = mutation.current, loop = currentLoops.find(item => item.loopId === saved?.loopId); if (saved && loop) mutate(loop, saved.action, true) }}>Inspect and retry original {mutation.current.action}</button> : null}
    {error && attempt.current?.goalId === demand.id && !currentLoops.some(loop => loop.creationOperationId === attempt.current?.operationId && loop.status !== 'stopped') ? <button type="button" className="goals-button" disabled={busy} onClick={() => start(true)}>Inspect and retry original start</button> : null}
  </section>
}
