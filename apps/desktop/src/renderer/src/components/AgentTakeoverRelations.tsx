import { useEffect, useRef, useState } from 'react'
import type { AgentMuxAgentCreationFact, AgentMuxAgentCreationInspection } from '@agentmux/core'
import type { AgentTakeoverPage, AgentTakeoverProvenance, AgentTakeoverQuery } from '@agentmux/core/agent-takeover'
import { Button } from '@agentmux/client-ui/components/Button'
import type { SessionHistoryReference, SessionSnapshot } from '../../../shared/contracts'
import type { FocusContextAccess } from '../lib/focus-context-access'
import { api } from '../lib/api'
import { useAppStore } from '../store'

type CreationReading = { status: 'unread' | 'read' | 'unconfirmed'; creation?: AgentMuxAgentCreationFact; retired?: boolean; issue?: string }
type Reading = { scope: string; creation: CreationReading; query?: AgentTakeoverQuery; outgoing?: AgentTakeoverPage | undefined; incoming?: AgentTakeoverPage | undefined; incomingIssue?: string | undefined; pending: boolean; issue?: string | undefined }
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const nature = (value: AgentTakeoverProvenance['nature']) => value === null ? 'Nature unconfirmed'
  : { takeover: 'Takeover', promotion: 'Promotion', handson: 'Handson', transfer: 'Transfer' }[value]
const organization = (value: AgentTakeoverProvenance['source']['organization']) => value ? `${value.kind === 'mote' ? 'Club' : 'Project'} · ${value.title}` : 'Organization unconfirmed'
const matches = (page: AgentTakeoverPage, query: AgentTakeoverQuery) => page.owner.runtimeId === query.expectedRuntimeId &&
  page.direction === query.direction && page.subject.runtimeId === query.subject.runtimeId && page.subject.agentSessionId === query.subject.agentSessionId &&
  page.coverage.scope === 'selected-owner' && page.coverage.history === 'recorded-takeovers' && page.records.every(record =>
    record.takeover.destination.owner.runtimeId === query.expectedRuntimeId && (query.direction === 'incoming'
      ? record.agent.runtimeId === query.subject.runtimeId && record.agent.agentSessionId === query.subject.agentSessionId
      : record.takeover.source.runtimeId === query.subject.runtimeId && record.takeover.source.agentSessionId === query.subject.agentSessionId))

function ExactTakeover({ value, operationId }: { value: AgentTakeoverProvenance; operationId: string }) {
  return <details><summary>Exact identities and original operation</summary><dl className="agent-information-reader__source">
    <div><dt>Source</dt><dd><code>{value.source.runtimeId}{value.source.agentSessionId ? ` / ${value.source.agentSessionId}` : ''}</code></dd></div>
    {value.source.nativeSource ? <>
      <div><dt>Provider</dt><dd>{value.source.nativeSource.nativeHandle.providerId}</dd></div>
      <div><dt>Native</dt><dd><code>{value.source.nativeSource.nativeHandle.sessionId}</code></dd></div>
      <div><dt>Directory</dt><dd>{value.source.nativeSource.workspacePath}</dd></div>
      <div><dt>Revision</dt><dd><code>{value.source.nativeSource.revision}</code></dd></div>
      <div><dt>Executor</dt><dd>{value.source.executorId ?? 'Not recorded'}</dd></div>
    </> : null}
    {value.source.organization ? <div><dt>From</dt><dd><code>{value.source.organization.reference.runtimeId} / {value.source.organization.reference.spaceId} / {value.source.organization.organizationId}</code></dd></div> : null}
    {value.destination.organization ? <div><dt>To</dt><dd><code>{value.destination.organization.reference.runtimeId} / {value.destination.organization.reference.spaceId} / {value.destination.organization.organizationId}</code></dd></div> : null}
    <div><dt>Owner</dt><dd><code>{value.destination.owner.runtimeId}</code></dd></div>
    <div><dt>Position</dt><dd><code>{value.destination.address.displayWorkspaceId} / {value.destination.address.tabId} / {value.destination.address.regionId}</code></dd></div>
    <div><dt>Operation</dt><dd><code>{operationId}</code></dd></div>
  </dl></details>
}

/** One explicit Source reading. Original Core records own every relationship and its bounded coverage. */
export function AgentTakeoverRelations({ subject, access, sourceRuntimeId: originalRuntimeId, snapshot, active, beforeOpen }: {
  subject?: SessionHistoryReference | undefined; access?: FocusContextAccess | undefined
  sourceRuntimeId?: string | null | undefined
  snapshot?: SessionSnapshot | undefined; active: boolean; beforeOpen?(): void
}) {
  const scope = JSON.stringify([access ? ['source', access.identity] : subject && { hostId: subject.hostId, agentSessionId: subject.agentSessionId, runtimeId: originalRuntimeId },
    snapshot?.kind === 'agent' ? snapshot.creation?.createOperationId : null])
  const observed: CreationReading = snapshot?.kind === 'agent' && snapshot.creation ? { status: 'read', creation: snapshot.creation } : { status: 'unread' }
  const [reading, setReading] = useState<Reading>(), [revision, setRevision] = useState(0), [locationIssue, setLocationIssue] = useState('')
  const lifetime = useRef(0)
  useEffect(() => {
    const epoch = ++lifetime.current
    if (!active) return
    const current = () => lifetime.current === epoch
    const previous = reading?.scope === scope ? reading : undefined
    const knownCreation = previous?.creation ?? observed
    setReading({ ...previous, scope, creation: knownCreation, pending: true, issue: undefined, incomingIssue: undefined })
    void (async () => {
      if (!access && (!subject || !originalRuntimeId) || access && !access.identity.runtimeId) throw Error('The original Agent Runtime is unconfirmed. Its source and reading are retained.')
      const { owner } = await api.spatial.owner()
      if (previous?.query && owner.runtimeId !== previous.query.expectedRuntimeId) throw Error('The admission Runtime changed. The original reading and records are retained.')
      const sourceRuntimeId = access?.identity.runtimeId ?? (await api.sessions.owner(subject!.hostId, originalRuntimeId!)).owner.runtimeId
      const sourceSessionId = access?.identity.agentSessionId ?? subject!.agentSessionId
      const query: AgentTakeoverQuery = { expectedRuntimeId: owner.runtimeId, direction: 'outgoing', subject: { runtimeId: sourceRuntimeId, agentSessionId: sourceSessionId }, limit: 10 }
      const creationRead = access ? Promise.resolve(knownCreation) : (async (): Promise<CreationReading> => {
        const inspection: AgentMuxAgentCreationInspection = await api.sessions.creation(subject!.hostId, sourceSessionId)
        await api.sessions.owner(subject!.hostId, sourceRuntimeId)
        const creation = inspection.kind === 'retired-agent' ? inspection.history?.creation : inspection.creation
        if (inspection.hostId !== subject!.hostId || inspection.agentSessionId !== sourceSessionId || knownCreation.creation && creation?.createOperationId !== knownCreation.creation.createOperationId)
          throw Error('The original creation identity no longer matches this reading.')
        return { status: 'read', retired: inspection.kind === 'retired-agent', ...(creation ? { creation } : {}) }
      })()
      const incomingQuery: AgentTakeoverQuery = { ...query, direction: 'incoming' }
      const [origin, destinations, parents] = await Promise.allSettled([creationRead, api.sessions.takeovers(query), api.sessions.takeovers(incomingQuery)])
      if (!current()) return
      const page = destinations.status === 'fulfilled' && matches(destinations.value, query) ? destinations.value : undefined
      const parentPage = parents.status === 'fulfilled' && matches(parents.value, incomingQuery) ? parents.value : undefined
      setReading({ scope, query, pending: false, creation: origin.status === 'fulfilled' ? origin.value : { ...knownCreation, status: 'unconfirmed', issue: reason(origin.reason) },
        outgoing: page ?? previous?.outgoing, incoming: parentPage ?? previous?.incoming,
        ...(!page ? { issue: destinations.status === 'rejected' ? reason(destinations.reason) : 'The returned owner or source did not match this Takeover reading.' } : {}),
        ...(!parentPage ? { incomingIssue: parents.status === 'rejected' ? reason(parents.reason) : 'The returned owner or target did not match this incoming Takeover reading.' } : {}) })
    })().catch(error => { if (current()) setReading({ ...previous, scope, creation: knownCreation, pending: false, issue: reason(error), incomingIssue: reason(error) }) })
    return () => { if (current()) ++lifetime.current }
  }, [scope, active, revision])
  const held = reading?.scope === scope ? reading : undefined, creationMetadata = held?.creation ?? observed
  const takeover = creationMetadata.creation?.takeover
  async function older(direction: AgentTakeoverQuery['direction']) {
    const original = held, epoch = lifetime.current, previous = direction === 'incoming' ? held?.incoming : held?.outgoing
    if (!original?.query || !previous?.nextCursor || original.pending) return
    const query = { ...original.query, direction, cursor: previous.nextCursor }
    setReading({ ...original, pending: true, ...(direction === 'incoming' ? { incomingIssue: undefined } : { issue: undefined }) })
    try {
      const page = await api.sessions.takeovers(query)
      if (epoch !== lifetime.current) return
      if (!matches(page, query)) throw Error('The next page did not retain the original Takeover owner, direction and subject.')
      setReading({ ...original, pending: false, [direction === 'incoming' ? 'incoming' : 'outgoing']: { ...page, records: [...previous.records, ...page.records] } })
    } catch (error) { if (epoch === lifetime.current) setReading({ ...original, pending: false, [direction === 'incoming' ? 'incomingIssue' : 'issue']: reason(error) }) }
  }
  async function locate(runtimeId: string, agentSessionId: string) {
    const epoch = lifetime.current
    setLocationIssue('')
    if (access?.identity.runtimeId === runtimeId && access.identity.agentSessionId === agentSessionId && access.isCurrent?.()) {
      access.select(); beforeOpen?.(); return
    }
    const candidates = useAppStore.getState().sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === agentSessionId)
    const hosts = [...new Set(candidates.map(session => session.control.hostId))]
    const routes = await Promise.allSettled(hosts.map(async hostId => ({ hostId, identity: (await api.sessions.owner(hostId, runtimeId)).owner })))
    if (epoch !== lifetime.current) return
    const confirmed = new Set(routes.flatMap(route => route.status === 'fulfilled' && route.value.identity.runtimeId === runtimeId ? [route.value.hostId] : []))
    const current = useAppStore.getState(), found = current.sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === agentSessionId && confirmed.has(session.control.hostId))
    if (found.length === 1 && current.requestSessionLocations(found[0]!.id, { subject: { hostId: found[0]!.control.hostId, agentSessionId, runtimeId } })) beforeOpen?.()
    else setLocationIssue('The exact Agent location is not confirmed in this view. Its original Runtime and Session reference are retained; refresh its original source.')
  }
  function relationship(record: AgentTakeoverPage['records'][number], direction: AgentTakeoverQuery['direction']) {
    const value = record.takeover
    const phase = record.phase === 'retired' ? 'Created, then closed' : record.phase === 'prepared'
      ? 'Position admitted; new Agent not confirmed' : record.phase === 'unconfirmed' ? 'Creation result unconfirmed' : 'Created Agent recorded'
    return <li key={record.requestId}>
      <p className="agent-information-takeovers__heading"><strong>{nature(value.nature)}</strong><span>{phase}</span></p>
      <p className="agent-information-takeovers__route">{organization(value.source.organization)} → {organization(value.destination.organization)}</p>
      <p className="agent-information-takeovers__reference"><code>{record.agent.agentSessionId}</code></p>
      {direction === 'incoming' ? value.source.agentSessionId ? <>
        <p>Original Agent <code>{value.source.agentSessionId}</code></p>
        <Button type="button" onClick={() => void locate(value.source.runtimeId, value.source.agentSessionId!)}>Locate source Agent</Button>
      </> : <p>Original Provider conversation <code>{value.source.nativeSource?.nativeHandle.providerId} / {value.source.nativeSource?.nativeHandle.sessionId}</code> · No AgentMux Session was recorded.</p>
        : record.phase === 'active' && record.agent.runtimeId ? <Button type="button" onClick={() => void locate(record.agent.runtimeId!, record.agent.agentSessionId)}>Locate created Agent</Button> : null}
      {record.issue ? <p role="status">{record.issue}</p> : null}
      {value.source.organizationIssue && value.source.organizationIssue !== record.issue ? <p role="status">{value.source.organizationIssue}</p> : null}
      <ExactTakeover value={value} operationId={record.requestId} />
    </li>
  }
  return <section className="agent-information-takeovers" aria-label="Recorded Takeover relationships">
    <h4>Work taken over from</h4>
    {held?.incoming?.records.length ? <ul>{held.incoming.records.map(record => relationship(record, 'incoming'))}</ul>
      : held?.incoming ? <p>No incoming Takeovers are recorded in this owner’s returned records.</p> : null}
    {held?.incomingIssue ? <p role="status">Incoming Takeovers unavailable. {held.incoming ? 'Previously read records are retained. ' : ''}{held.incomingIssue}</p> : null}
    {held?.incoming?.nextCursor ? <Button type="button" disabled={held.pending} onClick={() => void older('incoming')}>More sources</Button> : null}
    <details><summary>Original creation metadata</summary>
      {creationMetadata.retired ? <p>The receiving Agent was created, then closed.</p> : null}
      {takeover ? <>
        <p><strong>{nature(takeover.nature)}</strong> · {organization(takeover.source.organization)} → {organization(takeover.destination.organization)}</p>
        {takeover.source.agentSessionId ? <p>Original Agent <code>{takeover.source.agentSessionId}</code></p>
          : <p>Original Provider conversation <code>{takeover.source.nativeSource?.nativeHandle.providerId} / {takeover.source.nativeSource?.nativeHandle.sessionId}</code> · No AgentMux Session was recorded.</p>}
        {takeover.source.organizationIssue ? <p role="status">{takeover.source.organizationIssue}</p> : null}
        <ExactTakeover value={takeover} operationId={creationMetadata.creation!.createOperationId} />
      </> : <p>{creationMetadata.status === 'unread' ? 'Creation metadata has not been read.' : creationMetadata.status === 'unconfirmed'
        ? 'Creation metadata is unconfirmed.' : 'No Takeover source is recorded in this creation metadata. This does not replace the admission owner’s incoming records.'}</p>}
      {creationMetadata.issue ? <p role="status">{creationMetadata.issue}</p> : null}
    </details>
    <h4>Recorded destinations</h4>
    {held?.outgoing?.records.length ? <ul>{held.outgoing.records.map(record => relationship(record, 'outgoing'))}</ul>
      : held?.outgoing ? <p>No recorded destinations in this owner’s returned records.</p> : null}
    {held?.pending ? <p role="status">Reading recorded Takeovers…</p> : null}
    {held?.issue ? <p role="status">Takeover destinations unavailable. {held.outgoing ? 'Previously read records are retained. ' : ''}{held.issue}</p> : null}
    {held?.outgoing?.nextCursor ? <Button type="button" disabled={held.pending} onClick={() => void older('outgoing')}>More destinations</Button> : null}
    <Button type="button" disabled={held?.pending} onClick={() => setRevision(value => value + 1)}>Refresh Takeover records</Button>
    <details><summary>Reading scope · recorded here</summary>
      <p className="focus-context-hover__coverage">This view reads recorded Takeovers from one admission owner. It does not describe all history or current membership.</p>
      {held?.query ? <p className="focus-context-hover__coverage">Admission owner <code>{held.query.expectedRuntimeId}</code></p> : null}
    </details>
    {locationIssue ? <p role="status">{locationIssue}</p> : null}
  </section>
}
