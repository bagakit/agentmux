import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react'
import type { AgentExecutionInspection } from '@agentmux/core'
import type { AgentExecutionRecoveryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { reduceLegacyExecutionReference, type PendingAgentLaunch } from '../lib/session-state'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore, adoptAgentRegionObservation, type AgentRegionReference } from '../store'
import { SettingsNavigation } from './SettingsNavigation'
import { SessionConnectingSurface } from './SessionConnectingSurface'

const referenceKey = (target: AgentExecutionRecoveryReference) => JSON.stringify([target.coordinator.hostId, target.coordinator.runtimeId, target.reference.bindingId, target.reference.agentSessionId, target.reference.createOperationId])

/** One visible reader of the original Coordinator. Core owns advancement and every Start fact. */
export function PendingExecutionRecovery({ target, origin, ...surface }: ComponentProps<typeof SessionConnectingSurface> & {
  target: AgentExecutionRecoveryReference
  origin: AgentRegionReference
}) {
  const navigation = useContext(SettingsNavigation)
  const hosts = useAppStore(state => state.config?.hosts)
  const key = referenceKey(target)
  const active = surface.visible !== false
  const latest = useRef({ key, active, sequence: 0 })
  if (latest.current.key !== key || latest.current.active !== active) latest.current = { key, active, sequence: 0 }
  latest.current.active = active
  const [read, setRead] = useState<{ key: string; value?: AgentExecutionInspection | null; error?: string }>({ key })
  const inFlight = useRef<object | null>(null)
  const [busy, setBusy] = useState<object | null>(null)
  const [feedback, setFeedback] = useState<{ key: string; message: string } | null>(null)
  const [advice, setAdvice] = useState<{ key: string; message: string } | null>(null)
  const current = read.key === key ? read : { key }
  const failureHost = hosts?.find(host => host.id === target.failure?.hostId)
  function failed(error: string) { setRead(prior => prior.key === key ? { ...prior, error } : { key, error }) }
  function accept(value: AgentExecutionInspection | null) {
    if (value && (value.bindingId !== target.reference.bindingId || value.agentSessionId !== target.reference.agentSessionId ||
      value.continuation && value.continuation.createOperationId !== target.reference.createOperationId)) {
      failed('The Coordinator returned another original request. No work was replaced.'); return
    }
    setRead({ key, value })
  }
  useEffect(() => {
    if (!active) return
    const source = latest.current
    source.active = true
    const stop = api.sessions.observeExecutionBinding(target, value => {
      if (latest.current === source && source.active) { source.sequence++; accept(value) }
    }, error => { if (latest.current === source && source.active) { source.sequence++; failed(error) } })
    return () => { source.active = false; stop() }
  }, [key, active])
  async function refresh() {
    const source = latest.current, sequence = ++source.sequence
    try { const value = await api.sessions.executionBinding(target); if (latest.current === source && source.active && source.sequence === sequence) accept(value) }
    catch (error) { if (latest.current === source && source.active && source.sequence === sequence) failed(presentError(error)) }
  }
  async function continueOriginal() {
    const source = latest.current, request = surface.request
    if (inFlight.current === source) return
    const stillOwns = () => {
      const state = useAppStore.getState(), region = state.tabs[origin.tabId]?.regions[origin.regionId]
      const retained = state.pendingAgentLaunches[origin.agentSessionId]
      return retained && retained.request === request && retained.requestIssue?.executionRecovery && referenceKey(retained.requestIssue.executionRecovery) === key &&
        region?.kind === 'agent' && region.sessionId === origin.agentSessionId && !state.sessions.some(session => session.id === origin.agentSessionId)
    }
    if (!source.active || latest.current !== source || !stillOwns()) return
    inFlight.current = source
    setBusy(source); setFeedback(null)
    try {
      const result = await api.sessions.continueExecution(target)
      if (result.created.agentSessionId !== target.reference.agentSessionId || result.creation?.createOperationId !== target.reference.createOperationId)
        throw new Error('The response did not confirm this original Session and creation. Its request is retained.')
      const canonical = await useAppStore.getState().canonicalizeAgentLaunch(result) ?? result
      // An already-authorized result may update its exact original Store owner even
      // after this reader hides; it never navigates or replaces a changed workface.
      if (stillOwns()) {
        if (!canonical.session) throw new Error('The original creation was confirmed, but its display read is unavailable. Check the same request; do not create again.')
        adoptAgentRegionObservation({ ...origin, hostId: surface.request?.hostId ?? '' }, canonical)
      }
    } catch (error) {
      if (latest.current === source && source.active) { setFeedback({ key, message: presentError(error) }); void refresh() }
    } finally { if (inFlight.current === source) inFlight.current = null; if (latest.current === source) setBusy(null) }
  }
  async function checkUpdate() {
    if (!failureHost || failureHost.kind !== 'ssh') return
    const source = latest.current
    setAdvice({ key, message: 'Reading this Host’s Core deployment…' })
    try {
      const result = await api.hosts.upgradeCheck(failureHost)
      if (latest.current === source && source.active) setAdvice({ key, message: result.detail })
    } catch (error) { if (latest.current === source && source.active) setAdvice({ key, message: `Core update check unavailable: ${presentError(error)}. The original request can still be checked or continued.` }) }
  }
  const value = current.value
  // The original acknowledged locator is enough to request continuation. A read
  // failure cannot revoke it; Core revalidates the exact intent on every action.
  const description = <>
    <span>{value?.state === 'connected' && !current.error ? 'The original tools are connected. Continue this same request to confirm its Agent result.'
      : value && !current.error ? 'The original request is retained. Continue checks both endpoints and advances only this request, without sending the prompt again.'
        : 'The current original request is not confirmed. Refresh its Coordinator observation; no Agent or input is started by a read.'}</span>
    {target.failure ? <span className="session-connecting__status">Last attempt: {target.failure.stage} on {failureHost?.label ?? target.failure.hostId} ({target.failure.role === 'executor' ? 'project/tools side' : 'Agent side'}).</span> : null}
    {value?.helperStarts ? <span className="session-connecting__status">Project tools: {value.helperStarts.executor.outcome === 'confirmed' ? 'Start receipt confirmed' : value.helperStarts.executor.outcome === 'unknown' ? 'Start outcome unknown' : 'Start not submitted'}. Agent tools: {value.helperStarts.frontend.outcome === 'confirmed' ? 'Start receipt confirmed' : value.helperStarts.frontend.outcome === 'unknown' ? 'Start outcome unknown' : 'Start not submitted'}.</span> : null}
    {current.error ? <span className="session-connecting__status">Latest observation: {current.error}</span> : null}
    {feedback?.key === key ? <span className="session-connecting__status">{feedback.message}</span> : null}
  </>
  const actions = <>
    <button type="button" className="small-button" disabled={busy === latest.current} onClick={() => void continueOriginal()}>{busy === latest.current ? 'Continuing original request…' : 'Continue original request'}</button>
    <button type="button" className="small-button" onClick={() => void refresh()}>Refresh original status</button>
    <details className="surface-state__details"><summary>{target.failure ? 'Environment and previous step' : 'Original request details'}</summary>
      {target.failure ? <p>{target.failure.role} · {target.failure.stage} · {failureHost?.label ?? target.failure.hostId}</p> : null}
      <dl><dt>Original Coordinator</dt><dd>{target.coordinator.hostId} · {target.coordinator.runtimeId}</dd><dt>Binding</dt><dd>{target.reference.bindingId}</dd></dl>
      {failureHost?.kind === 'ssh' ? <button type="button" className="small-button" onClick={() => void checkUpdate()}>Check Core update</button> : null}
      {failureHost && navigation ? <button type="button" className="small-button" onClick={() => navigation.openHost(failureHost.id)}>Open this Host</button> : null}
      {advice?.key === key ? <p role="status">{advice.message}</p> : null}
    </details>
    <details className="surface-state__details"><summary>Other recovery options</summary>{surface.actions}</details>
  </>
  return <SessionConnectingSurface {...surface} actions={actions} creationRecovery={{ waiting: false,
    title: current.error || !value ? 'Original request status is unconfirmed' : value.state === 'connected' ? 'Original tools are connected' : 'Continue the original request', description }} />
}

/** The existing pending owner receives only a Core-confirmed locator, never reconstructed input. */
export function useLegacyExecutionRecovery(origin: AgentRegionReference | undefined, pending: PendingAgentLaunch | undefined, active: boolean) {
  const request = pending?.request
  const eligible = Boolean(active && origin && pending?.requestIssue && !pending.requestIssue.executionRecovery &&
    request?.hostId && request.createOperationId && request.toolWorkspace?.hostId && request.toolWorkspace.path)
  const key = JSON.stringify([origin?.tabId, origin?.regionId, origin?.agentSessionId])
  const latest = useRef({ request, key, active: eligible })
  if (latest.current.request !== request || latest.current.key !== key || latest.current.active !== eligible)
    latest.current = { request, key, active: eligible }
  const inFlight = useRef<{ source: object; promise: Promise<boolean> } | null>(null)
  const [read, setRead] = useState<{ source: object; message: string } | null>(null)
  async function check(): Promise<boolean> {
    const source = latest.current
    if (!source.active || !origin || !request?.hostId || !request.createOperationId || !request.toolWorkspace) return false
    if (inFlight.current?.source === source) return await inFlight.current.promise
    const current = () => latest.current === source && source.active
    const promise = (async () => {
      try {
        const observation = await api.sessions.resolveExecutionBinding({ hostId: request.hostId!, agentSessionId: origin.agentSessionId,
          createOperationId: request.createOperationId!, toolWorkspace: { hostId: request.toolWorkspace!.hostId, path: request.toolWorkspace!.path } })
        if (!current()) return false
        if (!observation) {
          setRead({ source, message: 'The original Coordinator has not confirmed a matching retained intent. The original request and draft are kept; no Agent or input was started.' })
          return false
        }
        let adopted = false
        useAppStore.setState(state => { const next = reduceLegacyExecutionReference(state, origin, request, observation.target); adopted = next !== state; return next })
        return adopted
      } catch (error) {
        if (current()) setRead({ source, message: `Original intent lookup unavailable: ${presentError(error)}` })
        return false
      }
    })()
    const attempt = { source, promise }; inFlight.current = attempt
    try { return await promise } finally { if (inFlight.current === attempt) inFlight.current = null }
  }
  useEffect(() => {
    const source = latest.current
    source.active = eligible
    if (source.active) void check()
    return () => { source.active = false }
  }, [request, key, eligible])
  return { check, message: read?.source === latest.current && eligible ? read.message : undefined }
}

/** Formal references stay with their original recovery reader. */
export function ExecutionConnectingSurface({ recovery, origin, ...surface }: ComponentProps<typeof SessionConnectingSurface> & {
  recovery?: AgentExecutionRecoveryReference
  origin?: AgentRegionReference
}) {
  return recovery?.reference?.agentSessionId === origin?.agentSessionId &&
    recovery?.reference?.createOperationId === surface.request?.createOperationId &&
    typeof recovery?.coordinator?.hostId === 'string' && typeof recovery?.coordinator?.runtimeId === 'string' && origin
    ? <PendingExecutionRecovery {...surface} target={recovery} origin={origin} />
    : <SessionConnectingSurface {...surface} />
}
