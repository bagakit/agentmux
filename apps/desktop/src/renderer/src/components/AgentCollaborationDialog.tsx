import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { createCollaborationAreasSelector, type CollaborationAreaRequest } from '../lib/collaboration-areas'
import type { WorkspaceAgentScopeState } from '../lib/workspace-agent-scope'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { MailboxOriginalMessage } from './MailboxCollaboration'
import { collaborationWorkfaces } from '../lib/collaboration-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useWorkbenchDocument } from '../lib/workbench-document'
import type { FocusContext } from '../lib/focus-context'
import { agentContextForSession } from '../lib/focus-context'
import { agentRegionExecution, useAppStore } from '../store'
import { workspaceForSession, topicIdForSession } from '../lib/workbench-tabs'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { collaborationAgents, collaborationSubjectKey, createCollaborationProjector, visibleCollaboration, type CollaborationEvidence, type CollaborationRelation, type CollaborationSubject } from '../lib/agent-collaboration'
import { useCollaborationReading, type CollaborationSource } from '../lib/use-collaboration-reading'
import { createFocusContextIdentitySelector } from '../lib/focus-context-identity'
import { createFocusGoalLinksSelector } from '../lib/focus-goal-links'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { api } from '../lib/api'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { AgentCollaborationGraph, COLLABORATION_LABELS, type CollaborationSelection } from './AgentCollaborationGraph'
import { MailboxA2A } from './MailboxA2A'

export type CollaborationRequest = { kind: 'focus'; subject: CollaborationSubject; name: string } | ({ kind: 'space' } & CollaborationAreaRequest)
const allKinds = ['communication', 'creation', 'supervision'] as const
const nameOf = (context: FocusContext | undefined, id: string) => context?.name ?? id

export function AgentCollaborationDialog({ request, onClose, onOpen }: { request: CollaborationRequest | null; onClose(): void; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void }) {
  return request ? <CollaborationReadingDialog key={JSON.stringify(request)} request={request} onClose={onClose} onOpen={onOpen} /> : null
}

function CollaborationReadingDialog({ request, onClose, onOpen }: { request: CollaborationRequest; onClose(): void; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void }) {
  const active = useWorkbenchPresentationActive(), workbenchDocument = useWorkbenchDocument()
  const [documentVisible, setDocumentVisible] = useState(!workbenchDocument.hidden)
  useEffect(() => { const update = () => setDocumentVisible(!workbenchDocument.hidden); workbenchDocument.addEventListener('visibilitychange', update); return () => workbenchDocument.removeEventListener('visibilitychange', update) }, [workbenchDocument])
  const enabled = active && documentVisible
  type Facts = WorkspaceAgentScopeState & { names: ReturnType<typeof useAppStore.getState>['agentNames'] }
  const retainedFacts = useRef<Facts | null>(null)
  const facts = useAppStore(useShallow(state => {
    if (!enabled && retainedFacts.current) return retainedFacts.current
    retainedFacts.current = { sessions: state.sessions, config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots, names: state.agentNames,
      tabs: state.tabs, layouts: state.layouts, spaceZoneBindings: state.spaceZoneBindings, workbenchSpaceSelection: state.workbenchSpaceSelection,
      topicCategories: state.topicCategories, projectGroups: state.projectGroups, spatialRequests: state.spatialRequests }
    return retainedFacts.current
  }))
  const subjectKey = request.kind === 'focus' ? collaborationSubjectKey(request.subject) : undefined
  const [broader, setBroader] = useState(false), [budget, setBudget] = useState(24)
  const [selection, setSelection] = useState<CollaborationSelection>(subjectKey ? { kind: 'agent', id: subjectKey } : null)
  const [kinds, setKinds] = useState<ReadonlySet<CollaborationRelation['kind']>>(new Set(allKinds))
  const areaSelector = useMemo(() => createCollaborationAreasSelector(agentRegionExecution), [])
  const scope = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined), [areaSelector, facts, request])
  const areas = useMemo(() => request.kind === 'space' && !broader ? scope.areas.filter(area => scope.current.includes(area.id)) : scope.areas, [scope, request.kind, broader])
  const available = useMemo(() => {
    if (request.kind === 'focus' && !broader) return [request.subject]
    const members = new Set(areas.flatMap(area => area.members)), subjects = new Map<string, CollaborationSubject>()
    for (const session of facts.sessions) if (session.kind === 'agent') {
      const subject = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, key = collaborationSubjectKey(subject)
      if (members.has(key)) subjects.set(key, subject)
    }
    return [...subjects.values()]
  }, [request, broader, areas, facts.sessions])
  const subjects = useMemo(() => available.slice(0, budget), [available, budget])
  const reading = useCollaborationReading(subjects, enabled)
  const project = useMemo(createCollaborationProjector, [])
  const recorded = useMemo(() => project(reading.facts), [project, reading.facts])
  const wanted = useMemo(() => new Set([...(request.kind === 'focus' && !broader ? [subjectKey!] : areas.flatMap(area => area.members)), ...recorded.agents.keys()]), [request.kind, broader, subjectKey, areas, recorded.agents])
  const contextCache = useRef(new Map<string, { session: Facts['sessions'][number]; name: string | undefined; workspace: ReturnType<typeof workspaceForSession>; topicId: ReturnType<typeof topicIdForSession>; context: FocusContext }>())
  const previousContexts = useRef<FocusContext[]>([])
  const contexts = useMemo(() => {
    const topics = scratchTopicsForConfig(facts.config, facts.scratchTopicSnapshots)
    const retained = new Set<string>(), rows = facts.sessions.flatMap(session => {
      if (session.kind !== 'agent' || session.hostId !== session.control.hostId || !wanted.has(collaborationSubjectKey(session.control))) return []
      const key = JSON.stringify([session.hostId, session.id]), old = contextCache.current.get(key), name = facts.names[session.id]
      const workspace = workspaceForSession(facts.config, session, topics), topicId = topicIdForSession(facts.config, session, topics)
      retained.add(key)
      if (old && old.session === session && old.name === name && old.workspace === workspace && old.topicId === topicId) return [old.context]
      const context = { ...agentContextForSession(session, undefined, name, workspace, topicId), recap: undefined }
      contextCache.current.set(key, { session, name, workspace, topicId, context })
      return [context]
    })
    for (const key of contextCache.current.keys()) if (!retained.has(key)) contextCache.current.delete(key)
    if (previousContexts.current.length !== rows.length || rows.some((row, index) => row !== previousContexts.current[index])) previousContexts.current = rows
    return previousContexts.current
  }, [facts.sessions, facts.config, facts.scratchTopicSnapshots, facts.names, wanted])
  const originals = useMemo(() => collaborationAgents(contexts), [contexts])
  const agents = useMemo(() => new Map([...recorded.agents, ...originals]), [recorded.agents, originals])
  const projection = useMemo(() => ({ ...recorded, agents }), [recorded, agents])
  const members = useMemo(() => new Set(areas.flatMap(area => area.members)), [areas])
  const relations = useMemo(() => visibleCollaboration(projection.relations, members, kinds, broader ? undefined : subjectKey), [projection, members, kinds, broader, subjectKey])
  const visibleAreas = useMemo(() => {
    if (request.kind !== 'focus' || broader) return areas
    const ids = new Set([subjectKey!, ...relations.flatMap(relation => [relation.source, relation.target])])
    return areas.map(area => ({ ...area, members: area.members.filter(id => ids.has(id)) })).filter(area => area.members.length)
  }, [areas, relations, subjectKey, request.kind, broader])
  const identitySelector = useMemo(createFocusContextIdentitySelector, []), goalSelector = useMemo(createFocusGoalLinksSelector, [])
  const retainedIdentities = useRef<ReturnType<ReturnType<typeof createFocusContextIdentitySelector>>>(new Map())
  const identities = useAppStore(useShallow(state => {
    if (!enabled) return retainedIdentities.current
    retainedIdentities.current = identitySelector(workbenchSelectionCatalog(state), state.tabs, contexts, state.config, state.layouts, agentRegionExecution)
    return retainedIdentities.current
  })), goals = useAppStore(state => goalSelector(state, enabled))
  const selectedAgent = selection?.kind === 'agent' ? projection.agents.get(selection.id) : undefined
  const selectedRelation = selection?.kind === 'relation' ? projection.relations.find(relation => relation.id === selection.id) : undefined
  const [navigation, setNavigation] = useState<{ context: FocusContext; locations: WorkbenchProjectionSelection[] } | null>(null)
  const open = useCallback((context: FocusContext) => {
    const locations = collaborationWorkfaces(useAppStore.getState(), context, agentRegionExecution)
    if (locations.length === 1) { onOpen(context, locations[0]); onClose() }
    else setNavigation({ context, locations })
  }, [onClose, onOpen])
  const issues = reading.sources.reduce((count, source) => count + Object.keys(source.issues).length + Number(Boolean(source.observationIssue)), 0)
  const loading = reading.sources.some(source => source.loading.length)
  return <Dialog.Root open onOpenChange={value => { if (!value) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="collaboration-dialog dialog-surface" aria-describedby="collaboration-coverage">
      <header className="collaboration-dialog__header"><div><SemanticIcon name="object.topology" size={16} /><Dialog.Title>Collaboration</Dialog.Title><span>{request.kind === 'focus' ? request.name : scope.title}</span></div>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close collaboration graph"><SemanticIcon name="action.close" size={16} /></button></Dialog.Close></header>
      <div className="collaboration-toolbar">
        <div className="collaboration-toolbar__scope" role="group" aria-label="Graph scope"><button type="button" aria-pressed={!broader} onClick={() => { setBroader(false); setBudget(24) }}>{request.kind === 'focus' ? 'Direct relations' : 'Current area'}</button><button type="button" aria-pressed={broader} onClick={() => { setBroader(true); setBudget(24) }}>All areas</button></div>
        <div className="collaboration-toolbar__kinds" role="group" aria-label="Relation types">{allKinds.map(kind => <button key={kind} type="button" data-kind={kind} aria-pressed={kinds.has(kind)} onClick={() => setKinds(previous => { const next = new Set(previous); if (!next.delete(kind)) next.add(kind); return next })}><span />{COLLABORATION_LABELS[kind]}</button>)}</div>
        <button type="button" className="icon-button" aria-label="Refresh graph sources" title="Refresh graph sources" onClick={() => { for (const subject of subjects) reading.act(subject, 'refresh') }}><SemanticIcon name="action.refresh" size={14} /></button>
      </div>
      <div className="collaboration-dialog__body"><AgentCollaborationGraph ready={reading.sources.some(source => source.incarnation !== null || Boolean(source.issues.events))} agents={projection.agents} areas={visibleAreas} relations={relations} pulses={enabled ? reading.pulses : []} selection={selection} onSelect={setSelection} onOpen={open} identities={identities} goals={goals} />
        <aside className="collaboration-inspector" aria-label="Collaboration details">
          {scope.issue || areas.some(area => area.issue) ? <section className="collaboration-area-issues" aria-label="Area membership issues" role="status">{scope.issue ? <p>{scope.issue}</p> : null}{areas.filter(area => area.issue).map(area => <p key={area.id}><strong>{area.name}</strong> · {area.issue}</p>)}</section> : null}
          {navigation ? <section className="collaboration-navigation" aria-label="Original workface locations"><h4>{navigation.context.name}</h4>{navigation.locations.length ? <><p>Choose a workface.</p>{navigation.locations.map(location => <button key={JSON.stringify(location)} type="button" className="small-button" onClick={() => {
            const current = collaborationWorkfaces(useAppStore.getState(), navigation.context, agentRegionExecution)
            if (!current.some(value => JSON.stringify(value) === JSON.stringify(location))) { setNavigation({ context: navigation.context, locations: current }); return }
            onOpen(navigation.context, location); onClose()
          }}>{facts.config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId} · {location.tabId} · {location.regionId}</button>)}</> : <p>Original workface location is unconfirmed. Its identity and reading remain available.</p>}<button type="button" className="small-button" onClick={() => open(navigation.context)}>Refresh locations</button><button type="button" className="small-button" onClick={() => setNavigation(null)}>Dismiss</button></section> : null}
          {selectedAgent ? <><h3>{nameOf(selectedAgent.context, selectedAgent.sessionId)}</h3><p>{selectedAgent.provenance ?? selectedAgent.subject?.hostId} · <code>{selectedAgent.sessionId}</code></p>
            {selectedAgent.context ? <button type="button" className="small-button" onClick={() => open(selectedAgent.context!)}>Open workface <SemanticIcon name="action.open-external" size={12} /></button> : <p>Original workface is not confirmed by this record.</p>}
            <h4>Relations</h4>{relations.filter(relation => relation.source === selectedAgent.id || relation.target === selectedAgent.id).map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={setSelection} />)}
          </> : selectedRelation ? <><h3>{COLLABORATION_LABELS[selectedRelation.kind]}</h3><p>{nameOf(projection.agents.get(selectedRelation.source)?.context, projection.agents.get(selectedRelation.source)?.sessionId ?? '')} → {nameOf(projection.agents.get(selectedRelation.target)?.context, projection.agents.get(selectedRelation.target)?.sessionId ?? '')}</p>
            <p>{selectedRelation.evidence.length} recorded {selectedRelation.kind === 'communication' ? 'messages' : selectedRelation.kind === 'creation' ? 'creations' : 'requests'}</p>
            {selection?.relatedIds && selection.relatedIds.length > 1 ? <div aria-label="Grouped connections">{selection.relatedIds.map(id => projection.relations.find(relation => relation.id === id)).filter((relation): relation is CollaborationRelation => Boolean(relation)).map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={setSelection} />)}</div> : null}
            <div className="collaboration-evidence">{selectedRelation.evidence.map(evidence => <Evidence key={evidence.id} evidence={evidence} active={enabled} />)}</div>
          </> : <><h3>Relations</h3><p>Select an Agent or a connection.</p><div className="collaboration-inspector__relations">{relations.map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={setSelection} />)}</div>{!relations.length && !loading ? <p>No recorded relations in the loaded window.</p> : null}</>}
          <details className="collaboration-sources" open={issues > 0}><summary>Sources <small>{loading ? 'Reading…' : `${reading.sources.length} participants`}{issues ? ` · ${issues} issues` : ''}</small></summary>
            {reading.sources.map(source => <Source key={collaborationSubjectKey(source.subject)} source={source} onAction={action => reading.act(source.subject, action)} />)}
          </details>
        </aside>
      </div>
      <footer id="collaboration-coverage" className="collaboration-dialog__footer"><span>{relations.length} connections · Loaded records only{loading ? ' · Reading…' : ''}{issues ? ' · Some sources unavailable' : ''}</span><span>{subjects.length} of {available.length} participants observed{subjects.length < available.length ? <button type="button" onClick={() => setBudget(value => value + 24)}>Observe more</button> : null}</span></footer>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}

function RelationButton({ relation, agents, onSelect }: { relation: CollaborationRelation; agents: ReturnType<typeof collaborationAgents>; onSelect(selection: CollaborationSelection): void }) {
  const from = agents.get(relation.source), to = agents.get(relation.target)
  return <button type="button" className="collaboration-relation" data-kind={relation.kind} onClick={() => onSelect({ kind: 'relation', id: relation.id })}><span>{nameOf(from?.context, from?.sessionId ?? '')} → {nameOf(to?.context, to?.sessionId ?? '')}</span><small>{COLLABORATION_LABELS[relation.kind]} · {relation.evidence.length}</small></button>
}
function Source({ source, onAction }: { source: CollaborationSource; onAction(action: 'refresh' | 'earlier' | 'updates' | 'created'): void }) {
  return <section><strong>{source.subject.agentSessionId}</strong><small>{source.subject.hostId} · {source.events.length} events · {source.spawns.length} creations</small>
    {Object.entries(source.issues).map(([kind, issue]) => <p role="status" key={kind}>{kind}: {issue}</p>)}{source.observationIssue ? <p role="status">{source.observationIssue}</p> : null}
    <div><button type="button" disabled={source.loading.length > 0} onClick={() => onAction('refresh')}>Refresh</button>{source.history?.before ? <button type="button" disabled={source.loading.includes('events')} onClick={() => onAction('earlier')}>Earlier events</button> : null}{source.updates?.more ? <button type="button" disabled={source.loading.includes('events')} onClick={() => onAction('updates')}>More updates</button> : null}{source.spawnCreated?.nextCursor ? <button type="button" disabled={source.loading.includes('created')} onClick={() => onAction('created')}>More creations</button> : null}</div>
  </section>
}
function Evidence({ evidence, active }: { evidence: CollaborationEvidence; active: boolean }) {
  const [read, setRead] = useState(false)
  const hostId = evidence.subject.hostId, agentSessionId = evidence.subject.agentSessionId
  const incarnation = evidence.kind === 'creation' ? null : evidence.incarnation
  const sender = evidence.kind === 'communication' ? evidence.message.senderSessionId : null
  const recipient = evidence.kind === 'communication' ? evidence.message.recipientSessionId : null
  const threadId = evidence.kind === 'communication' ? evidence.message.threadId : null
  const bodyOwner = useMemo(() => ({}), [active, read, hostId, agentSessionId, incarnation, sender, recipient, threadId])
  const live = useRef<object | null>(null)
  useLayoutEffect(() => { live.current = active && read ? bodyOwner : null; return () => { if (live.current === bodyOwner) live.current = null } }, [bodyOwner, active, read])
  const readMessage = useCallback(async (messageId: string) => {
    const reference = { hostId, agentSessionId }
    const page = await api.sessions.messageEvents(reference, { latest: true, messageId, limit: 1 })
    if (page.hostId !== hostId || page.incarnation !== incarnation) throw Error('The source journal changed. Refresh the original source before reading its message.')
    if (live.current !== bodyOwner) throw Error('This reading surface closed. The original message is retained.')
    const result = await api.sessions.readMessage(reference, messageId)
    if (result.hostId !== hostId || result.message && (result.message.envelope.senderSessionId !== sender || result.message.envelope.recipientSessionId !== recipient || result.message.envelope.threadId !== threadId)) throw Error('The original message source did not match.')
    return result.message
  }, [bodyOwner, hostId, agentSessionId, incarnation, sender, recipient, threadId])
  if (evidence.kind === 'creation') return <article><strong>{evidence.record.agentSessionId}</strong><p>Created by {evidence.record.creation.createdBy.agentSessionId}</p><small>Recorded {evidence.record.phase} · {new Date(evidence.record.createdAt).toLocaleString()}</small><p>Creation provenance · task ownership is separate.</p></article>
  const mid = evidence.kind === 'communication' ? evidence.message.messageId : evidence.events[0]?.messages[0]?.messageId
  return <article><code>{mid}</code>{evidence.kind === 'supervision' ? <p>{'Supervision recorded'}</p> : null}
    <ol>{evidence.events.map(event => <li key={event.sequence}><span>{event.kind}{event.state ? ` · ${event.state}` : ''}{event.eventKind ? ` · ${event.eventKind}` : ''}</span>{event.at ? <time>{new Date(event.at).toLocaleTimeString()}</time> : null}{event.reason ? <p>{event.reason}</p> : null}</li>)}</ol>
    {evidence.kind === 'supervision' && mid ? <><button type="button" className="small-button" onClick={() => setRead(value => !value)}>{read ? 'Close request' : 'Read supervised request'}</button>{read ? <SupervisionSource subject={evidence.subject} messageId={mid} incarnation={evidence.incarnation} active={active} /> : null}</> : null}
    {evidence.kind === 'communication' && mid ? <><button type="button" className="small-button" onClick={() => setRead(value => !value)}>{read ? 'Close message' : 'Read original message'}</button>{read ? <MailboxA2A reference={evidence.subject} direction={evidence.message.senderSessionId === evidence.subject.agentSessionId ? 'outgoing' : 'incoming'} items={[]} selectedKey={`a2a:${mid}`} active={active} loading={false} error={null} observationError={null} nextCursor={null} refresh={() => {}} loadEarlier={() => {}} readMessage={readMessage} onOpen={() => {}} /> : null}</> : null}
  </article>
}

function SupervisionSource({ subject, messageId, incarnation, active }: { subject: CollaborationSubject; messageId: string; incarnation: string | null; active: boolean }) {
  const [reading, setReading] = useState<{ record?: AgentMuxRpcResult<'message.dispatch.read'>; error?: string | undefined; loading: boolean }>({ loading: true })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    let current = true, generation = 0
    async function load() {
      const request = ++generation
      setReading(previous => ({ ...previous, loading: true, error: undefined }))
      try {
        const page = await api.sessions.messageEvents(subject, { latest: true, messageId, limit: 1 })
        if (page.hostId !== subject.hostId || page.incarnation !== incarnation) throw Error('The source journal changed. Refresh its recorded evidence before reading this request.')
        if (!current || generation !== request) return
        const record = await api.sessions.dispatch(subject, messageId)
        if (record.hostId !== subject.hostId || record.dispatch.sourceMessageId !== messageId || record.source.envelope.messageId !== messageId || record.dispatch.ownerAgentSessionId !== subject.agentSessionId && record.dispatch.workerAgentSessionId !== subject.agentSessionId) throw Error('The original request did not match this Host and participant.')
        if (current && generation === request) setReading({ record, loading: false })
      } catch (error) { if (current && generation === request) setReading(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) })) }
    }
    void load()
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => { if (hostId === subject.hostId && event.type === 'agent-message-changed' && event.messageId === messageId) void load() })
    return () => { current = false; ++generation; unsubscribe() }
  }, [subject.hostId, subject.agentSessionId, messageId, incarnation, active, retry])
  return <section aria-label="Original supervised request">{reading.loading ? <p role="status">Reading original request…</p> : null}{reading.error ? <p role="status">{reading.error}<button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : null}{reading.record ? <><p>{reading.record.dispatch.originAwaits ? 'Origin awaits report' : 'Worker report recorded'} · Task acceptance is separate</p><MailboxOriginalMessage record={reading.record.source} />{reading.record.replies.map(reply => <MailboxOriginalMessage key={reply.envelope.messageId} record={reply} />)}</> : null}</section>
}
