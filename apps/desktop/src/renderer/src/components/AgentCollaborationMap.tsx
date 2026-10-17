import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { createCollaborationAreasSelector } from '../lib/collaboration-areas'
import type { WorkspaceAgentScopeState } from '../lib/workspace-agent-scope'
import type { AgentMuxRpcResult, AgentSessionHistoryDescriptor } from '@agentmux/core'
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
import { collaborationAgents, collaborationSubjectKey, createCollaborationProjector, visibleCollaboration, type CollaborationAgent, type CollaborationArea, type CollaborationEvidence, type CollaborationRelation, type CollaborationSubject } from '../lib/agent-collaboration'
import { useCollaborationReading, type CollaborationSource } from '../lib/use-collaboration-reading'
import { createFocusContextIdentitySelector } from '../lib/focus-context-identity'
import { createFocusGoalLinksSelector } from '../lib/focus-goal-links'
import { WorkbenchPresentationContext, useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { api } from '../lib/api'
import { AgentCollaborationGraph, COLLABORATION_LABELS, type CollaborationSelection } from './AgentCollaborationGraph'
import { MailboxA2A } from './MailboxA2A'
import type { CollaborationMapTarget } from '../lib/collaboration-map-navigation'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import { TopRowLeadingChrome } from './TopRowChrome'
import { collaborationAgentPresentation, collaborationAgentName, collaborationHistoryContext } from '../lib/collaboration-map-presentation'

const allKinds = ['communication', 'creation', 'supervision'] as const

export function AgentCollaborationMap({ request, active = true, onClose, onOpen }: { request: CollaborationMapTarget | null; active?: boolean; onClose(): void; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void }) {
  return request ? <CollaborationReadingMap request={request} visible={active} onClose={onClose} onOpen={onOpen} /> : null
}

function CollaborationReadingMap({ request, visible, onClose, onOpen }: { request: CollaborationMapTarget; visible: boolean; onClose(): void; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void }) {
  const active = useWorkbenchPresentationActive(), workbenchDocument = useWorkbenchDocument()
  const [documentVisible, setDocumentVisible] = useState(!workbenchDocument.hidden)
  useEffect(() => { const update = () => setDocumentVisible(!workbenchDocument.hidden); workbenchDocument.addEventListener('visibilitychange', update); return () => workbenchDocument.removeEventListener('visibilitychange', update) }, [workbenchDocument])
  const enabled = active && documentVisible && visible
  const history = useFocusHistorySources(enabled)
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
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([])
  const reportVisible = useCallback((ids: readonly string[]) => setVisibleIds(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids), [])
  const [peeked, setPeeked] = useState<string | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewAgent = useCallback((id: string | null) => { clearTimeout(previewTimer.current); if (id) setPeeked(id); else previewTimer.current = setTimeout(() => setPeeked(null), 220) }, [])
  useEffect(() => () => clearTimeout(previewTimer.current), [])
  const [sourcesOpen, setSourcesOpen] = useState(false), [query, setQuery] = useState('')
  const [locate, setLocate] = useState<{ token: object; agentId?: string; areaIds?: readonly string[] }>()
  const [selection, setSelection] = useState<CollaborationSelection>(subjectKey ? { kind: 'agent', id: subjectKey } : null)
  const [kinds, setKinds] = useState<ReadonlySet<CollaborationRelation['kind']>>(new Set(allKinds))
  const areaSelector = useMemo(() => createCollaborationAreasSelector(agentRegionExecution), [])
  const scope = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined), [areaSelector, facts, request])
  const catalogCache = useRef(new Map<string, { source: object; name: string | undefined; agent: CollaborationAgent }>())
  const catalog = useMemo(() => {
    const result = new Map<string, CollaborationAgent>(), sessions = new Map<string, Facts['sessions'][number]>(), descriptors = new Map<string, AgentSessionHistoryDescriptor>()
    for (const session of facts.sessions) if (session.kind === 'agent') {
      const subject = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, id = collaborationSubjectKey(subject)
      if (!result.has(id)) {
        const name = facts.names[session.id], held = catalogCache.current.get(id)
        const presentation = held?.source === session && held.name === name ? held.agent : collaborationAgentPresentation(session, name)
        const agent = held && held.agent.name === presentation.name && held.agent.tier === presentation.tier && held.agent.lastActivityAt === presentation.lastActivityAt ? held.agent : { id, subject, sessionId: subject.agentSessionId, ...presentation }
        catalogCache.current.set(id, { source: session, name, agent }); result.set(id, agent)
      }
      if (session.hostId === subject.hostId && !sessions.has(id)) sessions.set(id, session)
    }
    for (const source of history.sources) {
      const subject = { hostId: source.hostId, agentSessionId: source.agentSessionId }, id = collaborationSubjectKey(subject)
      descriptors.set(id, source)
      if (!result.has(id)) result.set(id, { id, subject, sessionId: source.agentSessionId, name: facts.names[source.agentSessionId] ?? source.agentSessionId, tier: source.state === 'retired' ? 'closed' : 'unknown', lastActivityAt: null, provenance: source.state === 'retired' ? 'Retired Session' : 'Retained Session · Current Run unconfirmed' })
    }
    for (const id of catalogCache.current.keys()) if (!result.has(id)) catalogCache.current.delete(id)
    return { agents: result, sessions, history: descriptors }
  }, [facts.sessions, facts.names, history.sources])
  const areas = useMemo<readonly CollaborationArea[]>(() => {
    const placed = new Set(scope.areas.flatMap(area => area.members)), remaining = [...catalog.agents.keys()].filter(id => !placed.has(id))
    return remaining.length ? [...scope.areas, { id: 'retained-unplaced', name: 'Unplaced Agents', kind: 'unplaced' as const, members: remaining }] : scope.areas
  }, [scope.areas, catalog])
  useEffect(() => {
    setSelection(subjectKey ? { kind: 'agent', id: subjectKey } : null)
    setLocate({ token: request, ...(subjectKey ? { agentId: subjectKey } : { areaIds: scope.current }) })
  }, [request])
  const wanted = useMemo(() => new Set([...visibleIds, ...(peeked ? [peeked] : []), ...(selection?.kind === 'agent' ? [selection.id] : [])]), [visibleIds, selection, peeked])
  const subjects = useMemo(() => [...wanted].flatMap(id => { const subject = catalog.agents.get(id)?.subject; return subject ? [subject] : subjectKey === id && request.kind === 'focus' ? [request.subject] : [] }), [wanted, catalog, request, subjectKey])
  const reading = useCollaborationReading(subjects, enabled)
  const project = useMemo(createCollaborationProjector, [])
  const recorded = useMemo(() => project(reading.facts), [project, reading.facts])
  const contextCache = useRef(new Map<string, { session: Facts['sessions'][number] | AgentSessionHistoryDescriptor; name: string | undefined; workspace: ReturnType<typeof workspaceForSession>; topicId: ReturnType<typeof topicIdForSession>; context: FocusContext }>())
  const previousContexts = useRef<FocusContext[]>([])
  const contexts = useMemo(() => {
    const topics = scratchTopicsForConfig(facts.config, facts.scratchTopicSnapshots)
    const rows = [...wanted].flatMap(id => {
      const session = catalog.sessions.get(id)
      if (!session || session.kind !== 'agent') {
        const source = catalog.history.get(id)
        if (!source) return []
        const key = JSON.stringify([source.hostId, source.agentSessionId]), old = contextCache.current.get(key), name = facts.names[source.agentSessionId]
        if (old?.session === source && old.name === name) return [old.context]
        const context = collaborationHistoryContext(source, name)
        contextCache.current.set(key, { session: source, name, workspace: undefined, topicId: null, context })
        return [context]
      }
      const key = JSON.stringify([session.hostId, session.id]), old = contextCache.current.get(key), name = facts.names[session.id]
      const workspace = workspaceForSession(facts.config, session, topics), topicId = topicIdForSession(facts.config, session, topics)
      if (old && old.session === session && old.name === name && old.workspace === workspace && old.topicId === topicId) return [old.context]
      const context = { ...agentContextForSession(session, undefined, name, workspace, topicId), recap: undefined }
      contextCache.current.set(key, { session, name, workspace, topicId, context })
      return [context]
    })
    const presentations = new Set([...catalog.sessions.values()].map(session => JSON.stringify([session.hostId, session.id])))
    for (const key of contextCache.current.keys()) if (!presentations.has(key) && !catalog.history.has(key)) contextCache.current.delete(key)
    if (previousContexts.current.length !== rows.length || rows.some((row, index) => row !== previousContexts.current[index])) previousContexts.current = rows
    return previousContexts.current
  }, [catalog.sessions, catalog.history, facts.config, facts.scratchTopicSnapshots, facts.names, wanted])
  const originals = useMemo(() => {
    const result = collaborationAgents([...contextCache.current.values()].map(value => value.context))
    for (const { context } of contextCache.current.values()) if (!context.control) {
      const id = collaborationSubjectKey({ hostId: context.hostId, agentSessionId: context.id })
      const agent = catalog.agents.get(id)
      if (agent && catalog.history.has(id) && !catalog.sessions.has(id)) result.set(id, { ...agent, context })
    }
    return result
  }, [contexts, catalog.agents, catalog.history, catalog.sessions])
  const overlays = useRef(new Map<string, { base: CollaborationAgent | undefined; context: FocusContext | undefined; agent: CollaborationAgent }>())
  const agents = useMemo(() => {
    const result = new Map([...recorded.agents, ...catalog.agents])
    for (const [id, agent] of originals) {
      const base = result.get(id), old = overlays.current.get(id)
      const merged = old && old.base === base && old.context === agent.context ? old.agent : { ...base, ...agent }
      overlays.current.set(id, { base, context: agent.context, agent: merged }); result.set(id, merged)
    }
    for (const id of overlays.current.keys()) if (!originals.has(id)) overlays.current.delete(id)
    return result
  }, [recorded.agents, catalog.agents, originals])
  const projection = useMemo(() => ({ ...recorded, agents }), [recorded, agents])
  const members = useMemo(() => new Set(areas.flatMap(area => area.members)), [areas])
  const relations = useMemo(() => visibleCollaboration(projection.relations, members, kinds), [projection, members, kinds])
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
  const issues = reading.sources.reduce((count, source) => count + Object.keys(source.issues).length + Number(Boolean(source.observationIssue)), Number(Boolean(history.error)))
  const loading = reading.sources.some(source => source.loading.length)
  const mapPresentation = useMemo(() => ({ active: enabled, retainedRegionId: null }), [enabled])
  const matches = query.trim() ? [...projection.agents.values()].filter(agent => collaborationAgentName(agent).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || agent.sessionId.includes(query.trim())) : []
  const locateAgent = (id: string) => { setSelection({ kind: 'agent', id }); setLocate({ token: {}, agentId: id }); setQuery('') }
  return <WorkbenchPresentationContext.Provider value={mapPresentation}><section className="collaboration-map" data-desktop-space-view="map" aria-label="Agent map" hidden={!visible} inert={!visible}>
      <header className="collaboration-map__header"><TopRowLeadingChrome /><div className="collaboration-map__search"><SemanticIcon name="action.search" size={14} /><input aria-label="Find Agent in map" placeholder="Find Agent" value={query} onChange={event => setQuery(event.target.value)} />{query.trim() ? <div className="collaboration-map__results" role="listbox" aria-label="Matching Agents">{matches.slice(0, 30).map(agent => <button type="button" key={agent.id} role="option" aria-selected={selection?.id === agent.id} onClick={() => locateAgent(agent.id)}>{collaborationAgentName(agent)}<small>{agent.sessionId}</small></button>)}{!matches.length ? <p>No matching Agent</p> : matches.length > 30 ? <p>Refine to find more Agents</p> : null}</div> : null}</div></header>
      <div className="collaboration-toolbar">
        <button type="button" className="collaboration-map__locate" onClick={() => setLocate({ token: {}, ...(subjectKey ? { agentId: subjectKey } : { areaIds: scope.current }) })}><SemanticIcon name="action.locate" size={14} /><span>{request.kind === 'focus' ? request.name : scope.title}</span></button>
        <div className="collaboration-toolbar__kinds" role="group" aria-label="Relation types">{allKinds.map(kind => <button key={kind} type="button" data-kind={kind} aria-pressed={kinds.has(kind)} onClick={() => setKinds(previous => { const next = new Set(previous); if (!next.delete(kind)) next.add(kind); return next })}><span />{COLLABORATION_LABELS[kind]}</button>)}</div>
        <button type="button" className="icon-button" aria-label="Refresh graph sources" title="Refresh graph sources" onClick={() => { history.refresh(); for (const subject of subjects) reading.act(subject, 'refresh') }}><SemanticIcon name="action.refresh" size={14} /></button>
        <button type="button" className="small-button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(value => !value)}>Sources{issues ? ` · ${issues}` : ''}</button>
      </div>
      <div className="collaboration-map__body"><AgentCollaborationGraph active={enabled} locate={locate} onVisibleAgents={reportVisible} peeked={peeked} onPreviewAgent={previewAgent} agents={projection.agents} areas={areas} relations={relations} pulses={enabled ? reading.pulses : []} selection={selection} onSelect={setSelection} onOpen={open} identities={identities} goals={goals} />
        <aside className="collaboration-inspector" aria-label="Collaboration details" hidden={!selection && !sourcesOpen && !navigation}><button type="button" className="icon-button collaboration-inspector__close" aria-label="Close map details" onClick={() => { setSelection(null); setSourcesOpen(false); setNavigation(null) }}><SemanticIcon name="action.close" size={14} /></button>
          {scope.issue || areas.some(area => area.issue) ? <section className="collaboration-area-issues" aria-label="Area membership issues" role="status">{scope.issue ? <p>{scope.issue}</p> : null}{areas.filter(area => area.issue).map(area => <p key={area.id}><strong>{area.name}</strong> · {area.issue}</p>)}</section> : null}
          {navigation ? <section className="collaboration-navigation" aria-label="Original workface locations"><h4>{navigation.context.name}</h4>{navigation.locations.length ? <><p>Choose a workface.</p>{navigation.locations.map(location => <button key={JSON.stringify(location)} type="button" className="small-button" onClick={() => {
            const current = collaborationWorkfaces(useAppStore.getState(), navigation.context, agentRegionExecution)
            if (!current.some(value => JSON.stringify(value) === JSON.stringify(location))) { setNavigation({ context: navigation.context, locations: current }); return }
            onOpen(navigation.context, location); onClose()
          }}>{facts.config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId} · {location.tabId} · {location.regionId}</button>)}</> : <p>Original workface location is unconfirmed. Its identity and reading remain available.</p>}<button type="button" className="small-button" onClick={() => open(navigation.context)}>Refresh locations</button><button type="button" className="small-button" onClick={() => setNavigation(null)}>Dismiss</button></section> : null}
          {selectedAgent ? <><h3>{collaborationAgentName(selectedAgent)}</h3><p>{selectedAgent.provenance ?? selectedAgent.subject?.hostId} · <code>{selectedAgent.sessionId}</code></p>
            {selectedAgent.context?.control ? <button type="button" className="small-button" onClick={() => open(selectedAgent.context!)}>Open workface <SemanticIcon name="action.open-external" size={12} /></button> : <p>Original workface is not confirmed by this record.</p>}
            <h4>Relations</h4>{relations.filter(relation => relation.source === selectedAgent.id || relation.target === selectedAgent.id).map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={setSelection} />)}
          </> : selectedRelation ? <><h3>{COLLABORATION_LABELS[selectedRelation.kind]}</h3><p>{collaborationAgentName(projection.agents.get(selectedRelation.source))} → {collaborationAgentName(projection.agents.get(selectedRelation.target))}</p>
            <p>{selectedRelation.evidence.length} recorded {selectedRelation.kind === 'communication' ? 'messages' : selectedRelation.kind === 'creation' ? 'creations' : 'requests'}</p>
            {selection?.relatedIds && selection.relatedIds.length > 1 ? <div aria-label="Grouped connections">{selection.relatedIds.map(id => projection.relations.find(relation => relation.id === id)).filter((relation): relation is CollaborationRelation => Boolean(relation)).map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={setSelection} />)}</div> : null}
            <div className="collaboration-evidence">{selectedRelation.evidence.map(evidence => <Evidence key={evidence.id} evidence={evidence} active={enabled} />)}</div>
          </> : <><h3>Relations</h3><p>Select an Agent or a connection.</p>{!relations.length && !loading ? <p>No recorded relations in the loaded window.</p> : null}</>}
          <details className="collaboration-sources" open={sourcesOpen || issues > 0}><summary>Sources <small>{loading ? 'Reading…' : `${reading.sources.length} participants`}{issues ? ` · ${issues} issues` : ''}</small></summary>
            {reading.sources.map(source => <Source key={collaborationSubjectKey(source.subject)} source={source} onAction={action => reading.act(source.subject, action)} />)}
          </details>{history.error ? <p role="status">History: {history.error}<button type="button" className="small-button" onClick={history.refresh}>Retry history</button></p> : null}
        </aside>
      </div>
      <footer className="collaboration-map__footer"><span>{relations.length} connections · Loaded records only{loading ? ' · Reading…' : ''}{issues ? ' · Some sources unavailable' : ''}</span><span>{projection.agents.size} Agents · {subjects.length} participants observed</span></footer>
    </section></WorkbenchPresentationContext.Provider>

}

function RelationButton({ relation, agents, onSelect }: { relation: CollaborationRelation; agents: ReturnType<typeof collaborationAgents>; onSelect(selection: CollaborationSelection): void }) {
  const from = agents.get(relation.source), to = agents.get(relation.target)
  return <button type="button" className="collaboration-relation" data-kind={relation.kind} onClick={() => onSelect({ kind: 'relation', id: relation.id })}><span>{collaborationAgentName(from)} → {collaborationAgentName(to)}</span><small>{COLLABORATION_LABELS[relation.kind]} · {relation.evidence.length}</small></button>
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
