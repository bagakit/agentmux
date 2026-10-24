import { retainedFocusContext } from '../lib/focus-context'
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
import { useCollaborationIdentities, resolveCollaborationIdentities } from '../lib/use-collaboration-identities'
import { CollaborationMapToolbar } from './CollaborationMapToolbar'
import { collaborationAgentPresentation, collaborationAgentName } from '../lib/collaboration-map-presentation'

const allKinds = ['communication', 'creation', 'supervision'] as const

export function AgentCollaborationMap({ request, active = true, onOpen, onViewInFocus }: { request: CollaborationMapTarget | null; active?: boolean; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void
  onViewInFocus(subject: { hostId: string; agentSessionId: string }, presentationSessionId?: string): void }) {
  return request ? <CollaborationReadingMap request={request} visible={active} onOpen={onOpen} onViewInFocus={onViewInFocus} /> : null
}

function CollaborationReadingMap({ request, visible, onOpen, onViewInFocus }: { request: CollaborationMapTarget; visible: boolean; onOpen(context: FocusContext, reference?: WorkbenchProjectionSelection): void
  onViewInFocus(subject: { hostId: string; agentSessionId: string }, presentationSessionId?: string): void }) {
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
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [locate, setLocate] = useState<{ token: object; agentId?: string; areaIds?: readonly string[] }>()
  const [selection, setSelection] = useState<CollaborationSelection>(subjectKey ? { kind: 'agent', id: subjectKey } : null)
  const [kinds, setKinds] = useState<ReadonlySet<CollaborationRelation['kind']>>(new Set(allKinds))
  const areaSelector = useMemo(() => createCollaborationAreasSelector(agentRegionExecution), [])
  const catalogCache = useRef(new Map<string, { source: object; name: string | undefined; agent: CollaborationAgent }>())
  const catalog = useMemo(() => {
    const result = new Map<string, CollaborationAgent>(), sessions = new Map<string, Facts['sessions'][number]>(), descriptors = new Map<string, AgentSessionHistoryDescriptor>()
    for (const session of facts.sessions) if (session.kind === 'agent') {
      const subject = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, id = collaborationSubjectKey(subject)
      if (!result.has(id)) {
        const name = facts.names[session.id], held = catalogCache.current.get(id)
        const presentation = held?.source === session && held.name === name ? held.agent : collaborationAgentPresentation(session, name)
        const agent = held && held.agent.name === presentation.name && held.agent.tier === presentation.tier && held.agent.lastActivityAt === presentation.lastActivityAt && held.agent.providerId === presentation.providerId && held.agent.executorId === presentation.executorId ? held.agent : { id, subject, sessionId: subject.agentSessionId, ...presentation }
        catalogCache.current.set(id, { source: session, name, agent }); result.set(id, agent)
      }
      if (session.hostId === subject.hostId && !sessions.has(id)) sessions.set(id, session)
    }
    for (const source of history.sources) {
      const subject = { hostId: source.hostId, agentSessionId: source.agentSessionId }, id = collaborationSubjectKey(subject)
      descriptors.set(id, source)
      if (!result.has(id)) result.set(id, { id, subject, sessionId: source.agentSessionId, name: facts.names[source.agentSessionId] ?? source.agentSessionId, ...(source.history ? { providerId: source.history.providerId, executorId: source.history.executorId } : {}), tier: source.state === 'retired' ? 'closed' : 'unknown', lastActivityAt: null, provenance: source.state === 'retired' ? 'Retired Session' : 'Retained Session · Current Run unconfirmed' })
    }
    for (const id of catalogCache.current.keys()) if (!result.has(id)) catalogCache.current.delete(id)
    return { agents: result, sessions, history: descriptors }
  }, [facts.sessions, facts.names, history.sources])
  const scope = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined, catalog.history), [areaSelector, facts, request, catalog.history])
  const areaReferences = useMemo(() => {
    const result = new Map<string, CollaborationAgent>()
    for (const area of scope.areas) for (const [id, member] of area.affiliations ?? []) if (!result.has(id)) result.set(id, { id, subject: member.subject, sessionId: member.subject.agentSessionId })
    return result
  }, [scope.areas])
  useEffect(() => {
    setSelection(subjectKey ? { kind: 'agent', id: subjectKey } : null)
    setLocate({ token: request, ...(subjectKey ? { agentId: subjectKey } : { areaIds: scope.current }) })
  }, [request])
  const wanted = useMemo(() => new Set([...visibleIds, ...(peeked ? [peeked] : []), ...(selection?.kind === 'agent' ? [selection.id] : [])]), [visibleIds, selection, peeked])
  const subjects = useMemo(() => [...wanted].flatMap(id => { const subject = (catalog.agents.get(id) ?? areaReferences.get(id))?.subject; return subject ? [subject] : subjectKey === id && request.kind === 'focus' ? [request.subject] : [] }), [wanted, catalog, areaReferences, request, subjectKey])
  const activityScope = useRef<ReadonlySet<string>>(new Set())
  const reading = useCollaborationReading(subjects, enabled, activityScope)
  const project = useMemo(createCollaborationProjector, [])
  const recordedFacts = useMemo(() => project(reading.facts, history.sources), [project, reading.facts, history.sources])
  const recorded = useMemo(() => ({ ...recordedFacts, agents: new Map([...areaReferences, ...recordedFacts.agents]) }), [recordedFacts, areaReferences])
  const metadata = useCollaborationIdentities(recorded.agents, wanted, catalog.agents, enabled, facts.config?.hosts)
  const resolved = useMemo(() => resolveCollaborationIdentities(recorded, metadata.reads), [recorded, metadata.reads])
  const descriptors = useMemo(() => new Map([...resolved.sources, ...catalog.history]), [resolved.sources, catalog.history])
  const contextDemand = useMemo(() => new Set([...wanted].map(id => resolved.aliases.get(id) ?? id)), [wanted, resolved.aliases])
  const contextCache = useRef(new Map<string, { session: Facts['sessions'][number] | AgentSessionHistoryDescriptor; name: string | undefined; workspace: ReturnType<typeof workspaceForSession>; topicId: ReturnType<typeof topicIdForSession>; context: FocusContext }>())
  const previousHeldContexts = useRef<FocusContext[]>([]), previousContexts = useRef<FocusContext[]>([])
  const heldContexts = useMemo(() => {
    const topics = scratchTopicsForConfig(facts.config, facts.scratchTopicSnapshots)
    // Retained marks still show live metadata after leaving body demand. Refresh
    // only demanded or previously held identities, without consulting timelines.
    const refresh = new Set([...contextDemand, ...contextCache.current.keys()])
    for (const id of refresh) {
      const session = catalog.sessions.get(id)
      if (!session || session.kind !== 'agent') {
        const source = descriptors.get(id)
        if (!source) continue
        const key = id, old = contextCache.current.get(key), name = facts.names[source.agentSessionId]
        if (old?.session === source && old.name === name) continue
        const context = retainedFocusContext(source, name)
        contextCache.current.set(key, { session: source, name, workspace: undefined, topicId: null, context })
        continue
      }
      const key = id, old = contextCache.current.get(key), name = facts.names[session.id]
      const workspace = workspaceForSession(facts.config, session, topics), topicId = topicIdForSession(facts.config, session, topics)
      if (old && old.session === session && old.name === name && old.workspace === workspace && old.topicId === topicId) continue
      const context = { ...agentContextForSession(session, undefined, name, workspace, topicId), recap: undefined }
      contextCache.current.set(key, { session, name, workspace, topicId, context })
    }
    for (const id of contextCache.current.keys()) if (!catalog.sessions.has(id) && !descriptors.has(id)) contextCache.current.delete(id)
    const rows = [...contextCache.current.values()].map(value => value.context)
    if (previousHeldContexts.current.length !== rows.length || rows.some((row, index) => row !== previousHeldContexts.current[index])) previousHeldContexts.current = rows
    return previousHeldContexts.current
  }, [catalog.sessions, descriptors, facts.config, facts.scratchTopicSnapshots, facts.names, contextDemand])
  const contexts = useMemo(() => {
    const rows = [...contextDemand].flatMap(id => contextCache.current.get(id)?.context ?? [])
    if (previousContexts.current.length !== rows.length || rows.some((row, index) => row !== previousContexts.current[index])) previousContexts.current = rows
    return previousContexts.current
  }, [heldContexts, contextDemand])
  const originals = useMemo(() => {
    const result = collaborationAgents(heldContexts)
    for (const context of heldContexts) if (!context.control) {
      const id = collaborationSubjectKey({ hostId: context.hostId, agentSessionId: context.id })
      const agent = catalog.agents.get(id) ?? resolved.agents.get(id)
      if (agent && descriptors.has(id) && !catalog.sessions.has(id)) result.set(id, { ...agent, context })
    }
    return result
  }, [heldContexts, catalog.agents, descriptors, catalog.sessions, resolved.agents])
  const overlays = useRef(new Map<string, { base: CollaborationAgent | undefined; context: FocusContext | undefined; agent: CollaborationAgent }>())
  const agents = useMemo(() => {
    const result = new Map([...resolved.agents, ...catalog.agents])
    for (const [id, agent] of originals) {
      const base = result.get(id), old = overlays.current.get(id)
      const merged = old && old.base === base && old.context === agent.context ? old.agent : { ...base, ...agent }
      overlays.current.set(id, { base, context: agent.context, agent: merged }); result.set(id, merged)
    }
    for (const id of overlays.current.keys()) if (!originals.has(id)) overlays.current.delete(id)
    return result
  }, [resolved.agents, catalog.agents, originals])
  const projection = useMemo(() => ({ ...resolved, agents }), [resolved, agents])
  const affiliation = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined, descriptors), [areaSelector, facts, request, descriptors])
  const areas = useMemo<readonly CollaborationArea[]>(() => {
    const placed = new Set(affiliation.areas.flatMap(area => area.members)), unplaced: string[] = [], unresolved: string[] = []
    for (const [id, agent] of agents) if (!placed.has(id)) (agent.subject ? unplaced : unresolved).push(id)
    return [...affiliation.areas, ...(unplaced.length ? [{ id: 'retained-unplaced', name: 'Area unconfirmed', kind: 'unplaced' as const, members: unplaced }] : []),
      ...(unresolved.length ? [{ id: 'unresolved-references', name: 'Unresolved references', kind: 'unplaced' as const, members: unresolved }] : [])]
  }, [affiliation.areas, agents])
  // The notification scope follows original displayed identities; it never expands history/body demand.
  activityScope.current = useMemo(() => new Set([...agents.values()].flatMap(agent => agent.subject ? [collaborationSubjectKey(agent.subject)] : [])), [agents])
  const resolvedSelection = selection ? { ...selection, id: resolved.aliases.get(selection.id) ?? selection.id } : null
  const members = useMemo(() => new Set(areas.flatMap(area => area.members)), [areas])
  const relations = useMemo(() => visibleCollaboration(projection.relations, members, kinds), [projection, members, kinds])
  const identitySelector = useMemo(createFocusContextIdentitySelector, []), goalSelector = useMemo(createFocusGoalLinksSelector, [])
  const retainedIdentities = useRef<ReturnType<ReturnType<typeof createFocusContextIdentitySelector>>>(new Map())
  const identities = useAppStore(useShallow(state => {
    if (!enabled) return retainedIdentities.current
    retainedIdentities.current = identitySelector(workbenchSelectionCatalog(state), state.tabs, contexts, state.config, state.layouts, agentRegionExecution)
    return retainedIdentities.current
  })), goals = useAppStore(state => goalSelector(state, enabled))
  const selectedAgent = resolvedSelection?.kind === 'agent' ? projection.agents.get(resolvedSelection.id) : undefined
  const selectedAffiliations = selectedAgent ? areas.filter(area => area.kind !== 'unplaced' && area.affiliations?.has(selectedAgent.id)) : []
  const selectedMetadata = selectedAgent ? [...metadata.reads].find(([id]) => (resolved.aliases.get(id) ?? id) === selectedAgent.id) : undefined
  const selectedRelation = resolvedSelection?.kind === 'relation' ? projection.relations.find(relation => relation.id === resolvedSelection.id) : undefined
  const [navigation, setNavigation] = useState<{ context: FocusContext; locations: WorkbenchProjectionSelection[] } | null>(null)
  const open = useCallback((context: FocusContext) => {
    const locations = collaborationWorkfaces(useAppStore.getState(), context, agentRegionExecution)
    if (locations.length === 1) { onOpen(context, locations[0]) }
    else setNavigation({ context, locations })
  }, [onOpen])
  const issues = reading.sources.reduce((count, source) => count + Object.keys(source.issues).length + Number(Boolean(source.observationIssue)), Number(Boolean(history.error)))
  const metadataIssues = [...metadata.reads].filter(([, read]) => read.issue)
  const sourceIssues = issues + metadataIssues.length + Number(Boolean(scope.issue)) + areas.filter(area => area.issue).length
  const loading = history.loading || reading.sources.some(source => source.loading.length) || [...metadata.reads.values()].some(read => read.loading)
  const mapPresentation = useMemo(() => ({ active: enabled, retainedRegionId: null }), [enabled])
  const locateAgent = useCallback((id: string) => { setSelection({ kind: 'agent', id }); setLocate({ token: {}, agentId: id }); setSourcesOpen(false); setNavigation(null) }, [])
  const select = useCallback((value: CollaborationSelection) => { setSelection(value); setSourcesOpen(false); setNavigation(null) }, [])
  const agentRelations = selectedAgent ? relations.filter(relation => relation.source === selectedAgent.id || relation.target === selectedAgent.id) : []
  return <WorkbenchPresentationContext.Provider value={mapPresentation}><section className="collaboration-map" data-desktop-focus-view="map" aria-label="Agent map" hidden={!visible} inert={!visible}>
      <CollaborationMapToolbar active={enabled} agents={projection.agents} selectedKinds={kinds} onToggleKind={kind => setKinds(previous => { const next = new Set(previous); if (!next.delete(kind)) next.add(kind); return next })}
        onLocate={locateAgent} sourcesOpen={sourcesOpen} onSources={() => { setSourcesOpen(value => !value); setNavigation(null) }} issues={sourceIssues} loading={loading} connections={relations.length} participants={subjects.length}
        onRefresh={() => { history.refresh(); for (const [id] of metadataIssues) metadata.retry(id); for (const subject of subjects) reading.act(subject, 'refresh') }} />
      <div className="collaboration-map__body"><div className="collaboration-map__world"><AgentCollaborationGraph active={enabled} locate={locate} context={{ name: request.kind === 'focus' ? request.name : scope.title, onLocate: () => setLocate({ token: {}, ...(subjectKey ? { agentId: subjectKey } : { areaIds: scope.current }) }) }} onVisibleAgents={reportVisible} peeked={peeked} onPreviewAgent={previewAgent} agents={projection.agents} areas={areas} relations={relations} pulses={enabled ? reading.pulses : []} selection={resolvedSelection} onSelect={select} onOpen={open} identities={identities} goals={goals} /></div>
        <aside className="collaboration-inspector" aria-label="Collaboration details" hidden={!selection && !sourcesOpen && !navigation}><button type="button" className="icon-button collaboration-inspector__close" aria-label="Close map details" onClick={() => { setSelection(null); setSourcesOpen(false); setNavigation(null) }}><SemanticIcon name="action.close" size={14} /></button>
          {scope.issue || areas.some(area => area.issue) ? <section className="collaboration-area-issues" aria-label="Area membership issues" role="status">{scope.issue ? <p>{scope.issue}</p> : null}{areas.filter(area => area.issue).map(area => <p key={area.id}><strong>{area.name}</strong> · {area.issue}</p>)}</section> : null}
          {navigation ? <section className="collaboration-navigation" aria-label="Original workface locations"><h4>{navigation.context.name}</h4>{navigation.locations.length ? <><p>Choose a workface.</p>{navigation.locations.map(location => <button key={JSON.stringify(location)} type="button" className="small-button" onClick={() => {
            const current = collaborationWorkfaces(useAppStore.getState(), navigation.context, agentRegionExecution)
            if (!current.some(value => JSON.stringify(value) === JSON.stringify(location))) { setNavigation({ context: navigation.context, locations: current }); return }
            onOpen(navigation.context, location)
          }}>{facts.config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId} · {location.tabId} · {location.regionId}</button>)}</> : <p>Original workface location is unconfirmed. Its identity and reading remain available.</p>}<button type="button" className="small-button" onClick={() => open(navigation.context)}>Refresh locations</button><button type="button" className="small-button" onClick={() => setNavigation(null)}>Dismiss</button></section> : null}
          {sourcesOpen ? <>
            <div className="collaboration-inspector__heading"><span className="collaboration-inspector__eyebrow">Map</span><h3>Sources</h3><p>{projection.agents.size} Agents · {relations.length} connections</p></div>
            <p>{loading ? 'Reading original records…' : `${reading.sources.length} participants observed`} · Loaded records only</p>
            {selection ? <button type="button" className="small-button" onClick={() => setSourcesOpen(false)}><SemanticIcon name="navigation.previous" size={13} />Back to selection</button> : null}
            <div className="collaboration-sources">{reading.sources.map(source => <Source key={collaborationSubjectKey(source.subject)} source={source} onAction={action => reading.act(source.subject, action)} />)}</div>
            {metadataIssues.map(([id, read]) => <p role="status" key={id}>{read.reference.agentSessionId}: {read.issue}<button type="button" className="small-button" onClick={() => metadata.retry(id)}>Retry identity</button></p>)}
            {history.error ? <p role="status">History: {history.error}<button type="button" className="small-button" onClick={history.refresh}>Retry history</button></p> : null}
          </> : null}
          <div hidden={sourcesOpen} inert={sourcesOpen}>{selectedAgent ? <>
            <div className="collaboration-inspector__heading"><span className="collaboration-inspector__eyebrow">Agent</span><h3>{collaborationAgentName(selectedAgent)}</h3></div>
            <div className="collaboration-inspector__actions">{selectedAgent.subject ? <button type="button" className="small-button"
              onClick={() => onViewInFocus(selectedAgent.subject!, selectedAgent.context?.id)}>View in Focus <SemanticIcon name="action.open-external" size={12} /></button> : null}<button type="button" className="small-button" onClick={() => locateAgent(selectedAgent.id)}><SemanticIcon name="action.locate" size={13} />Locate</button>
              {selectedAgent.context?.control ? <button type="button" className="small-button" onClick={() => open(selectedAgent.context!)}>Open workface <SemanticIcon name="action.open-external" size={12} /></button> : null}</div>
            <details className="collaboration-identity"><summary>Identity</summary><p>{selectedAgent.provenance ?? selectedAgent.subject?.hostId} · <code>{selectedAgent.sessionId}</code></p>{!selectedAgent.context?.control ? <p>Original workface is not confirmed by this record.</p> : null}</details>
            {selectedMetadata?.[1].loading ? <p role="status">Reading original identity…</p> : selectedMetadata?.[1].issue ? <p role="status">{selectedMetadata[1].issue}<button type="button" className="small-button" onClick={() => metadata.retry(selectedMetadata[0])}>Retry identity</button></p> : null}
            {descriptors.get(selectedAgent.id)?.history ? <dl className="collaboration-identity"><dt>Provider</dt><dd>{descriptors.get(selectedAgent.id)!.history!.providerId}</dd><dt>Workspace</dt><dd>{descriptors.get(selectedAgent.id)!.history!.workspacePath}</dd></dl> : null}
            <section aria-label="Area affiliation">{selectedAffiliations.length ? <dl>{selectedAffiliations.map(area => {
              const member = area.affiliations!.get(selectedAgent.id)!
              return <div key={area.id}><dt>{member.basis === 'spatial' ? 'Display binding' : member.basis === 'collaborator' ? 'Recorded collaborator' : 'Workspace association'}</dt><dd>{area.name}{member.workspacePath ? <small>{member.workspacePath}</small> : null}</dd></div>
            })}</dl> : <p>{selectedAgent.subject ? 'Area unconfirmed. No original binding or matching work resource is confirmed.' : 'Original identity is unresolved. Area association is unconfirmed.'}</p>}</section>
            <h4>Relations <span>{agentRelations.length}</span></h4>{agentRelations.length ? agentRelations.map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} subjectId={selectedAgent.id} onSelect={select} />) : <p>No recorded relations in the loaded window.</p>}
          </> : selectedRelation ? <>
            <div className="collaboration-inspector__heading"><span className="collaboration-inspector__eyebrow">Relation</span><h3>{COLLABORATION_LABELS[selectedRelation.kind]}</h3></div>
            <div className="collaboration-endpoints">{[selectedRelation.source, selectedRelation.target].map((id, index) => <button key={`${id}-${index}`} type="button" onClick={() => locateAgent(id)} title="Locate Agent in map"><small>{index ? 'To' : 'From'}</small><span>{collaborationAgentName(projection.agents.get(id))}</span><SemanticIcon name="action.locate" size={13} /></button>)}</div>
            <p>{selectedRelation.evidence.length} recorded {selectedRelation.kind === 'communication' ? 'message' : selectedRelation.kind === 'creation' ? 'creation' : 'request'}{selectedRelation.evidence.length === 1 ? '' : 's'}</p>
            {selection?.relatedIds && selection.relatedIds.length > 1 ? <div aria-label="Grouped connections">{selection.relatedIds.map(id => projection.relations.find(relation => relation.id === id)).filter((relation): relation is CollaborationRelation => Boolean(relation)).map(relation => <RelationButton key={relation.id} relation={relation} agents={projection.agents} onSelect={select} />)}</div> : null}
            <div className="collaboration-evidence">{selectedRelation.evidence.map(evidence => <Evidence key={evidence.id} evidence={evidence} active={enabled && !sourcesOpen} />)}</div>
          </> : null}</div>
        </aside>
      </div>
    </section></WorkbenchPresentationContext.Provider>

}

function RelationButton({ relation, agents, subjectId, onSelect }: { relation: CollaborationRelation; agents: ReturnType<typeof collaborationAgents>; subjectId?: string; onSelect(selection: CollaborationSelection): void }) {
  const from = agents.get(relation.source), to = agents.get(relation.target), outgoing = relation.source === subjectId
  const title = subjectId ? collaborationAgentName(outgoing ? to : from) : `${collaborationAgentName(from)} → ${collaborationAgentName(to)}`
  return <button type="button" className="collaboration-relation" data-kind={relation.kind} aria-label={`${collaborationAgentName(from)} → ${collaborationAgentName(to)} · ${COLLABORATION_LABELS[relation.kind]}`} onClick={() => onSelect({ kind: 'relation', id: relation.id })}>
    <span className="collaboration-relation-key" data-kind={relation.kind} aria-hidden="true" /><span className="collaboration-relation__body"><span>{title}</span><small>{subjectId ? `${outgoing ? 'Outgoing' : 'Incoming'} · ` : ''}{COLLABORATION_LABELS[relation.kind]} · {relation.evidence.length}</small></span><SemanticIcon name="navigation.next" size={13} />
  </button>
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
