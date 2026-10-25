import { useEffect, useRef, useState } from 'react'
import type { AgentExecutionInspection } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { ServiceNoticeItem } from '../lib/use-service-notices'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const capabilityNames = { hooks: 'Hooks', skills: 'Skills', mcp: 'MCP calls', 'agent-control': 'Agent control' }

/** A reader of the original Core binding; never a health, retry or lifecycle owner. */
export function AgentToolExecutionNotice({ session, visible, presentation = 'disclosure' }: { session: Agent; visible: boolean; presentation?: 'disclosure' | 'inline' }) {
  const [observationAttempt, setObservationAttempt] = useState(0)
  const binding = session.toolExecution
  const identity = JSON.stringify([session.control.hostId, session.control.agentSessionId, binding?.bindingId])
  const latest = useRef({ identity, revision: 0 })
  if (latest.current.identity !== identity) latest.current = { identity, revision: 0 }
  const [read, setRead] = useState<{ identity: string; inspection?: AgentExecutionInspection | null; error?: string }>({ identity })
  const resourceHost = useAppStore(state => state.config?.hosts.find(host => host.id === binding?.resourceHostId)?.label)
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
      restore: 'Refresh this binding observation. The Agent and terminal remain available; no tool operation is replayed.' }
  } })
  for (const notice of inspection?.notices ?? []) items.push({ id: JSON.stringify([notice.providerId, notice.role, notice.capability]), cause: JSON.stringify([notice.code, notice.state]),
    notice: { kind: 'process-degraded', notice: { step: `${capabilityNames[notice.capability]} · ${notice.state}`, mode: notice.message, restore: notice.action } } })
  async function refresh() {
    if (current.error) setObservationAttempt(value => value + 1)
    const original = latest.current
    const revision = original.revision
    try { const value = await api.sessions.executionBinding(binding!.bindingId); if (latest.current === original && original.revision === revision) accept(value) }
    catch (error) { if (latest.current === original && original.revision === revision) setRead(prior => ({ ...prior, identity, error: error instanceof Error ? error.message : String(error) })) }
  }
  if (presentation === 'inline') return <section className="tool-execution-observation" aria-label="Tool execution observation">
    <header><strong>Tool connection · {current.error || !inspection ? 'Unconfirmed' : inspection.state === 'connected' ? 'Connected' : 'Unavailable'}</strong>
      <button type="button" className="small-button" onClick={() => void refresh()}>Refresh observation</button></header>
    {current.error && inspection ? <p>Last confirmed tool connection: {inspection.state}.</p> : null}
    {items.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
    {!items.length ? <p>No capability notices in this observation. Tool connection does not establish support for every Provider feature.</p> : null}
  </section>
  return <ServiceNoticeDisclosure scope={`local:tool-execution:${identity}`} notices={items} visible={visible}
    available={inspection !== undefined && !current.error} persistentTitle title="Tool execution" detailsTitle={`Tools · ${resourceHost ?? binding.resourceHostId}`}
    actions={<button type="button" className="small-button" onClick={() => void refresh()}>Refresh observation</button>}>
    <p className="tool-execution-resource">{binding.workspacePath}</p>
    {items.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
  </ServiceNoticeDisclosure>
}
