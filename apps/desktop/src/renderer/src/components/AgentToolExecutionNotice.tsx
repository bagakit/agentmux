import { useEffect, useRef, useState } from 'react'
import type { AgentExecutionInspection } from '@agentmux/core'
import { Button } from '@agentmux/client-ui/components/Button'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { ServiceNoticeItem } from '../lib/use-service-notices'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const capabilityNames = { hooks: 'Hooks', skills: 'Skills', mcp: 'MCP calls', 'agent-control': 'Agent control' }

/** Observe the original Core binding; explicit recovery stays with that same owner. */
export function AgentToolExecutionNotice({ session, visible, presentation = 'disclosure' }: { session: Agent; visible: boolean; presentation?: 'disclosure' | 'inline' }) {
  const [observationAttempt, setObservationAttempt] = useState(0)
  const binding = session.toolExecution
  const identity = JSON.stringify([session.control.hostId, session.control.agentSessionId, binding?.bindingId])
  const latest = useRef({ identity, revision: 0, readRequest: 0 })
  if (latest.current.identity !== identity) latest.current = { identity, revision: 0, readRequest: 0 }
  const [read, setRead] = useState<{ identity: string; inspection?: AgentExecutionInspection | null; error?: string }>({ identity })
  const [rejoinState, setRejoinState] = useState<{ identity: string; pending: boolean; error?: string }>({ identity, pending: false })
  const rejoining = useRef<string | null>(null)
  const resourceHost = useAppStore(state => state.config?.hosts.find(host => host.id === session.workPlacement?.resourceHostId)?.label)
  function accept(value: AgentExecutionInspection | null) {
    if (latest.current.identity !== identity) return
    latest.current.revision++
    if (value === null) {
      setRead(prior => ({ ...(prior.identity === identity ? prior : {}), identity, error: 'The original execution binding was not present in this observation.' }))
      return
    }
    if (value && (value.bindingId !== binding?.bindingId || value.agentHostId !== session.control.hostId || value.agentSessionId !== session.control.agentSessionId ||
      value.resourceHostId !== binding.resourceHostId || value.resourceWorkspacePath !== binding.workspacePath)) {
      setRead(prior => ({ ...(prior.identity === identity ? prior : {}), identity, error: 'The observation did not identify this original execution binding.' }))
      return
    }
    setRead({ identity, inspection: value })
  }
  useEffect(() => {
    if (!binding || !visible) return
    let active = true
    const stop = api.sessions.observeExecutionBinding(binding.bindingId, value => { if (active) accept(value) }, error => {
      if (active) { latest.current.revision++; setRead(prior => ({ ...(prior.identity === identity ? prior : {}), identity, error })) }
    })
    return () => { active = false; stop() }
  }, [identity, visible, observationAttempt])
  if (!binding) return null
  const current = read.identity === identity ? read : { identity }
  const inspection = current.inspection
  const items: ServiceNoticeItem[] = []
  if (current.error || !inspection || inspection.state === 'unavailable') items.push({ id: 'observation', cause: current.error ?? inspection?.diagnostic?.code ?? 'unobserved', notice: {
    kind: 'indeterminate', notice: { step: 'Tool execution observation is unconfirmed',
      mode: current.error ?? inspection?.diagnostic?.message ?? 'The original tool binding is retained; its current service state has not been read.',
      restore: 'Refresh this connection status. The original Session and terminal entry are kept; this observation does not confirm running or input availability. No tool operation is replayed.' }
  } })
  for (const notice of inspection?.notices ?? []) items.push({ id: JSON.stringify([notice.providerId, notice.role, notice.capability]), cause: JSON.stringify([notice.code, notice.state]),
    notice: { kind: 'process-degraded', notice: { step: `${capabilityNames[notice.capability]} · ${notice.state}`, mode: notice.message, restore: notice.action } } })
  for (const diagnostic of inspection?.diagnostics ?? []) {
    const target = diagnostic.operation ? `Operation ${JSON.stringify(diagnostic.operation.nativeRequestId)} · generation ${diagnostic.operation.streamGeneration}`
      : `${diagnostic.scope === 'unclassified' ? 'Unclassified tool issue' : `${diagnostic.scope} issue`}${diagnostic.generation ? ` · generation ${diagnostic.generation}` : ''}`
    items.push({ id: JSON.stringify(['diagnostic', diagnostic.scope, diagnostic.side, diagnostic.runId, diagnostic.generation, diagnostic.operation, diagnostic.code]),
      cause: diagnostic.message, notice: { kind: 'process-degraded', notice: {
        step: `${target} · ${diagnostic.code}`, mode: diagnostic.message,
        restore: diagnostic.scope === 'operation' ? 'This original operation remains unresolved. Reconnecting does not by itself confirm its outcome.'
          : 'This issue is separate from the tool connection. The original Session and binding are kept; their running and input availability are not established by this issue.'
      } } })
  }
  async function refresh() {
    if (current.error) setObservationAttempt(value => value + 1)
    const original = latest.current
    const revision = original.revision
    const request = ++original.readRequest
    try { const value = await api.sessions.executionBinding(binding!.bindingId); if (latest.current === original && original.readRequest === request && original.revision === revision) accept(value) }
    catch (error) { if (latest.current === original && original.readRequest === request && original.revision === revision) setRead(prior => ({ ...prior, identity, error: error instanceof Error ? error.message : String(error) })) }
  }
  async function rejoin() {
    if (rejoining.current === identity) return
    rejoining.current = identity
    setRejoinState({ identity, pending: true })
    const original = latest.current, revision = original.revision, request = ++original.readRequest
    try {
      const value = await api.sessions.rejoinExecutionBinding(binding!.bindingId)
      if (latest.current === original) {
        if (original.readRequest === request && original.revision === revision) accept(value)
        setRejoinState({ identity, pending: false })
      }
    } catch (error) {
      if (latest.current === original) setRejoinState({ identity, pending: false, error: error instanceof Error ? error.message : String(error) })
    } finally { if (rejoining.current === identity) rejoining.current = null }
  }
  const recovery = rejoinState.identity === identity ? rejoinState : { identity, pending: false }
  const connectionUnconfirmed = Boolean(current.error || !inspection || inspection.state === 'unavailable')
  if (recovery.error) items.push({ id: 'rejoin', cause: recovery.error, notice: { kind: 'indeterminate', notice: {
    step: 'Original tool connection could not be rejoined', mode: recovery.error,
    restore: 'The original binding and pending operations are retained. Check the named cause before reconnecting again.'
  } } })
  const actions = <><Button type="button" onClick={() => void refresh()}>Refresh observation</Button>
    {connectionUnconfirmed || recovery.pending || recovery.error ? <Button type="button" disabled={recovery.pending} onClick={() => void rejoin()}>{recovery.pending ? 'Reconnecting…' : 'Reconnect original tools'}</Button> : null}</>
  const recoveryDetails = connectionUnconfirmed ? <p className="tool-execution-recovery-scope">Reconnect to the same Agent and tools. Pending tool work may continue, without sending your prompt again.</p> : null
  const connectionTitle = current.error || !inspection ? 'Unconfirmed' : inspection.state === 'connected' ? 'Connected' : 'Unavailable'
  const unresolved = inspection?.diagnostics?.some(item => item.scope === 'operation')
  const capabilityNeedsReview = inspection?.notices?.some(item => item.state === 'unsupported' || item.state === 'unqualified')
  const summary = current.error || !inspection
    ? 'Current project-tool status is unknown. Refresh to check the original connection.'
    : inspection.state === 'unavailable'
      ? 'The connection to this project’s tools is unavailable. Refresh its status or reconnect the original tools.'
      : unresolved ? 'Project tools are connected. An earlier tool operation still needs review.'
        : capabilityNeedsReview ? 'Project tools are connected. A capability needs attention; see details.' : 'Project tools are connected.'
  const details = <>
    {current.error && inspection ? <p>Last confirmed tool connection: {inspection.state}.</p> : null}
    {items.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
    {!items.length ? <p>No capability notices in this observation. Tool connection does not establish support for every Provider feature.</p> : null}
    {recovery.error ? <p>The reconnect result is from the last attempt; the connection status above follows the current observation.</p> : null}
    {recoveryDetails}
  </>
  if (presentation === 'inline') return <section className="tool-execution-observation" aria-label="Tool execution observation">
    <header><strong>Tool connection · {connectionTitle}</strong><div className="tool-execution-actions">{actions}</div></header>
    <p className="tool-execution-summary" role="status">{summary}</p>
    <details className="tool-execution-details"><summary>Connection details{items.length ? ` · ${items.length}` : ''}</summary>{details}</details>
  </section>
  return <ServiceNoticeDisclosure scope={`local:tool-execution:${identity}`} notices={items} visible={visible}
    available={inspection !== undefined && !current.error} persistentTitle title="Project tools" detailsTitle={`Tools · ${resourceHost ?? session.workPlacement?.resourceHostId ?? 'Host unknown'}`}
    actions={actions}>
    <p className="tool-execution-summary" role="status">{summary}</p>
    <p className="tool-execution-resource">{binding.workspacePath}</p>
    {details}
  </ServiceNoticeDisclosure>
}
