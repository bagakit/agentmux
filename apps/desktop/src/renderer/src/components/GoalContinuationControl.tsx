import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { Orbit } from 'lucide-react'
import type { DemandRecord } from '../lib/global-demand-board'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { AgentAvatar } from './AgentAvatar'
import { useAppStore } from '../store'
import '../styles/goal-continuation.css'

/** A thin original Goal caller, shared by Goal details and the Mote current-work surface. */
export function GoalContinuationControl({ demand, onRefresh, onChooseSupervisor, active = true }: {
  demand: DemandRecord; initialSessionId?: string; onRefresh?: () => void; onChooseSupervisor?: () => void; active?: boolean
}) {
  const execute = useAppStore(state => state.executeControl)
  const [loops, setLoops] = useState<ContinuousProgressLoop[]>([])
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
    attempt.current = undefined; mutation.current = undefined; flight.current = undefined
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
      if (attempt.current || alignment?.confirmedAt == null || !supervisorId || !assigneeSessionIds.includes(supervisorId)) return
      attempt.current = { goalId: demand.id, sessionId: supervisorId, intervalMs: Number(minutes) * 60_000, alignmentRevision: alignment.revision, operationId: crypto.randomUUID() }
    }
    const saved = attempt.current
    if (!saved || saved.goalId !== demand.id) return
    const owner = occurrence
    void run(async () => {
      const result = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: saved.operationId, operation: 'demand.start', demandId: saved.goalId, sessionId: saved.sessionId, continuation: { intervalMs: saved.intervalMs, alignmentRevision: saved.alignmentRevision } })
      if (scope.current === owner && result.operation === 'demand.start' && result.continuation?.initialDelivery?.state === 'confirmed' && attempt.current === saved) attempt.current = undefined
    })
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
  const supervisorId = demand.supervisorSessionId ?? null
  const assigneeSessionIds = demand.assigneeSessionIds ?? []
  const openSupervisor = () => {
    if (onChooseSupervisor) onChooseSupervisor()
    else void run(() => execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'goal', goalId: demand.id }, inputPolicy: 'preserve' }))
  }
  return <section className="goals-continuation" aria-label="Goal continuous progress">
    <div className="goals-continuation__heading"><span>Continue this work</span><button type="button" className="goals-button" disabled={busy} onClick={() => void run(() => inspect())}>Refresh</button></div>
    {!supervisorId ? <div className="goals-supervisor-guide">
      <span className="goals-supervisor-guide__orbit" aria-hidden="true"><Orbit size={26} strokeWidth={1.25} /></span>
      <div><strong>Keep this work moving</strong><p>Choose one assignee to supervise ongoing progress.</p></div>
      <button type="button" className="goals-button" disabled={busy} onClick={openSupervisor}>Choose Supervisor</button>
    </div> : <div className="goals-supervisor-identity">
      <div><span>Supervisor</span><GoalContinuationAgent agentSessionId={supervisorId} active={active} size={20} /></div>
      <button type="button" className="goals-button" disabled={busy} onClick={openSupervisor}>Change</button>
    </div>}
    {error ? <p className="goals-service" role="status">{error}</p> : null}
    {observedGoal !== demand.id && !error ? <p className="goals-service">Checking the original continuation…</p> : null}
    {currentLoops.map(loop => <div className="goals-continuation__saved" key={loop.loopId}>
      <div><strong>{loop.status === 'active' ? 'Continuing' : loop.status === 'paused' ? 'Paused' : 'Stopped'}</strong><span>Scope r{loop.taskSource?.kind === 'goal' ? loop.taskSource.alignmentRevision : '?'}</span></div>
      <div className="goals-continuation__original-agent"><GoalContinuationAgent agentSessionId={loop.agentSessionId} hostId={loop.hostId} active={active} size={18} /></div>
      {loop.status !== 'stopped' && loop.agentSessionId !== supervisorId ? <p className="goals-service">This loop keeps its original Agent. Stop it explicitly before starting with the new Supervisor.</p> : null}
      <p>{loop.lastDecision ?? (loop.initialDelivery?.state !== 'confirmed' ? 'The original start receipt is unconfirmed. Your Agent and input are retained.' : 'Uses the same executing Agent. Host acceptance does not mean work is complete.')}</p>
      {loop.status === 'active' ? <small>Next check {new Date(loop.nextCheckAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}
      {loop.status !== 'stopped' && loop.initialDelivery && loop.initialDelivery.state !== 'confirmed' ? <button type="button" className="goals-button" disabled={busy || Boolean(mutation.current)} onClick={() => retrySavedStart(loop)}>Inspect and retry original start</button> : null}
      <div className="goals-continuation__actions">{(['pause', 'resume', 'check', 'stop'] as const).filter(action => action === 'stop' ? loop.status !== 'stopped' : action === 'resume' ? loop.status === 'paused' && loop.initialDelivery?.state === 'confirmed' : loop.status === 'active').map(action => <button type="button" className="goals-button" key={action} disabled={busy || Boolean(mutation.current) || !Number.isSafeInteger(loop.revision) || !loop.revision} onClick={() => mutate(loop, action)}>{action === 'check' ? 'Check now' : action.charAt(0).toUpperCase() + action.slice(1)}</button>)}</div>
    </div>)}
    {supervisorId && !currentLoops.some(loop => loop.status !== 'stopped') && observedGoal === demand.id ? <form className="goals-continuation__start" onSubmit={event => { event.preventDefault(); start() }}>
      <label className="goals-continuation__interval">Check every<TextInput aria-label="Goal continuation minutes" type="number" min="1" value={minutes} disabled={busy || Boolean(attempt.current)} onChange={event => setMinutes(event.target.value)} /> minutes</label>
      <button type="submit" className="goals-button" disabled={busy || Boolean(mutation.current) || Boolean(attempt.current) || demand.alignment?.confirmedAt == null || !assigneeSessionIds.includes(supervisorId) || !Number.isFinite(Number(minutes)) || Number(minutes) < 1}>Start and continue</button>
      {demand.alignment?.confirmedAt == null ? <p className="goals-service">Confirm this Goal’s scope before enabling automatic work.</p> : null}
    </form> : null}
    {error && mutation.current?.goalId === demand.id ? <button type="button" className="goals-button" disabled={busy} onClick={() => { const saved = mutation.current, loop = currentLoops.find(item => item.loopId === saved?.loopId); if (saved && loop) mutate(loop, saved.action, true) }}>Inspect and retry original {mutation.current.action}</button> : null}
    {error && attempt.current?.goalId === demand.id && !currentLoops.some(loop => loop.creationOperationId === attempt.current?.operationId && loop.status !== 'stopped') ? <button type="button" className="goals-button" disabled={busy} onClick={() => start(true)}>Inspect and retry original start</button> : null}
  </section>
}

/** Resolve presentation metadata only; the saved canonical target and Host never change. */
function continuationAgentPresentation(state: ReturnType<typeof useAppStore.getState>, agentSessionId: string, hostId?: string) {
  const candidates = agentSessionPresentationIndex(state.sessions).get(agentSessionId) ?? []
  const matches = candidates.filter(session => session.control.agentSessionId === agentSessionId && session.control.hostId === session.hostId && (hostId === undefined || session.control.hostId === hostId))
  const session = matches.length === 1 ? matches[0] : undefined
  const hosts = [...new Set(matches.map(source => source.hostId))].sort().join(', ')
  return {
    name: session ? agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId }) : `Session ${agentSessionId}${matches.length > 1 ? ` · Hosts ${hosts}` : hostId ? ` · Host ${hostId}` : ''}`,
    identity: `${agentSessionId}\nHost ${(hostId ?? hosts) || 'unconfirmed'}${matches.length > 1 ? '\nPresentation is ambiguous' : ''}`,
    executorId: session?.executorId,
    providerId: session?.providerId,
    appearance: session ? state.config?.executors[session.executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[session.executorId] : undefined
  }
}
function GoalContinuationAgent({ agentSessionId, hostId, active, size }: { agentSessionId: string; hostId?: string; active: boolean; size: number }) {
  const observed = useAppStore(useShallow(state => active ? continuationAgentPresentation(state, agentSessionId, hostId) : null))
  const key = JSON.stringify([agentSessionId, hostId]), retained = useRef<{ key: string; value: ReturnType<typeof continuationAgentPresentation> } | null>(null)
  if (observed !== null) retained.current = { key, value: observed }
  if (retained.current?.key !== key) retained.current = { key, value: continuationAgentPresentation(useAppStore.getState(), agentSessionId, hostId) }
  const face = retained.current.value
  return <><span inert aria-hidden="true"><AgentAvatar label={face.name} providerId={face.providerId} executorId={face.executorId} appearance={face.appearance} size={size} visible={false} /></span><strong title={face.identity}>{face.name}</strong></>
}
