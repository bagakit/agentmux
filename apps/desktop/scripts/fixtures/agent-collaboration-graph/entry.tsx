import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { conversationRevision, parseConversationReadPage, projectConversationTimeline, type ConversationTimelineReadInput } from '@agentmux/core/conversation'
import { parseMessageEventsPage } from '../../../../../packages/core/src/agent-message-events'
import type { AgentMuxMessageEvent, AgentMuxSpawnRecord, AgentTimelineSnapshot } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../../../src/shared/contracts'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

// All controlled values enter at the platform boundary. Product Store actions,
// App initialization, Graph, card intent and the sole Reader host stay original.
const originalConfig = await api.config.get(), originalSnapshot = await api.sessions.snapshot()
const base = originalSnapshot.sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent')
if (!base || !originalConfig.workspaces[0]) throw Error('Nonempty typed platform samples required')
const now = Date.now(), hostId = 'local', incarnation = 'fixture-collaboration-journal'
const projects = [
  { ...originalConfig.workspaces[0], id: 'fixture-protocol', hostId, name: 'Agent protocol', path: fixturePath('private/graph/protocol'), kind: 'folder' as const },
  { ...originalConfig.workspaces[0], id: 'fixture-quality', hostId, name: 'Product quality', path: fixturePath('private/graph/quality'), kind: 'folder' as const }
]
const identities = [
  ['fixture-ui', 'Conversation renderer', 'codex', 0], ['fixture-core', 'A2A delivery', 'claude', 0],
  ['fixture-review', 'Read model review', 'gemini', 1], ['fixture-design', 'Interaction design', 'codex', 1]
] as const
const { pendingInteraction: _pending, ...plainBase } = base
const sessions: SessionSnapshot[] = identities.map(([id, label, providerId, area], index) => ({ ...plainBase,
  id, label, providerId, executorId: providerId, hostId, workspacePath: projects[area]!.path,
  processState: 'running', status: { state: index === 2 ? 'done' : 'working', source: 'native-hook', observedAt: now },
  control: { ...base.control, hostId, agentSessionId: id, run: { runId: 'fixture-run-' + id } }
}))
const timelines: Record<string, AgentTimelineSnapshot> = Object.fromEntries(identities.map(([id, label]) => {
  const items: AgentTimelineSnapshot['items'] = [
    { id: id + '-input', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', title: 'User message', content: 'Keep the original Session and inspect its recorded relationships.', authorHuman: true, createdAt: now - 40000, updatedAt: now - 40000 },
    { id: id + '-reply', agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: `${label}: the original owner and message identities are preserved. The next step is a bounded read of the recorded evidence.`, createdAt: now - 10000, updatedAt: now - 10000 }
  ]
  return [id, { agentSessionId: id, sourceHostId: hostId, revision: 2, items,
    stream: { epoch: 'fixture-stream-' + id, revision: 2, sequence: 2, origin: 'beginning', gaps: [],
      positions: items.map((item, at) => ({ id: item.id, firstSequence: at + 1, sequence: at + 1, revision: conversationRevision(item) })) } }]
}))
const config = { ...originalConfig, hosts: originalConfig.hosts.filter(host => host.id === hostId), workspaces: projects,
  appearance: { ...originalConfig.appearance, appAppearance: 'dark' as const }, focus: { recentActivityHours: 48 as const, ...originalConfig.focus, previewTrigger: 'quick' as const } }
const tabs = Object.fromEntries(sessions.map((session, at) => { const project = projects[at < 2 ? 0 : 1]!
  const tab = createWorkbenchTab('tab-' + session.id, { regionId: 'region-' + session.id, workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: session.id }, session.label)
  return [tab.id, tab] }))
const layouts = Object.fromEntries(projects.map((project, area) => [project.id, createWorkspaceLayout('group-' + area, sessions.slice(area * 2, area * 2 + 2).map(session => 'tab-' + session.id))]))
// Feed the original spatial API before App's real initialize reads it. Execution
// Host/cwd live in its region facts, rather than in a mocked resolver or action.
const initialSpatial = await api.spatial.read()
await api.spatial.commit({ expectedRevision: initialSpatial?.revision ?? 0,
  graph: desktopSpatialGraph({ ...useAppStore.getState(), config, sessions, tabs, layouts }, []) })
api.config.get = async () => structuredClone(config)
api.sessions.snapshot = async () => ({ sessions: structuredClone(sessions), timelines: structuredClone(timelines), recoveryCandidates: [] })
api.sessions.timeline = async control => structuredClone(timelines[control.agentSessionId]!)
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId, workspacePath: projects.find(project => project.id === id)?.path ?? projects[0]!.path })
const listeners = new Set<(event: RuntimeEvent) => void>()
api.sessions.onEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
const reads: Array<{ kind: string; participant?: string; options?: unknown }> = [], controls: string[] = []
for (const name of ['launchAgent', 'stop', 'resume', 'write', 'interrupt', 'submitPrompt'] as const) {
  const original = api.sessions[name]
  Object.assign(api.sessions, { [name]: (...args: never[]) => { controls.push(name); return (original as (...args: never[]) => unknown)(...args) } })
}
function conversation(input: ConversationTimelineReadInput) {
  const timeline = timelines[input.agentSessionId]
  if (!timeline) throw Error('Unknown private conversation participant')
  const projected = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: hostId, timeline })
  const checkpoint = { hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId,
    frontier: { hostId, agentSessionId: input.agentSessionId, scope: projected.scope,
      cuts: [{ kind: 'captured' as const, epoch: timeline.stream!.epoch, sequence: timeline.stream!.sequence }] } }
  const units = [...projected.events].reverse().map(event => ({ kind: 'item' as const, item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
  return parseConversationReadPage({ hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, scope: projected.scope,
    coverage: projected.coverage, order: { ...projected.order, direction: 'newest-first' }, items: units, nextCursor: null,
    budgetBytes: input.maxBytes ?? 65536, window: { id: 'fixture-window-' + input.agentSessionId, revision: 1, itemCount: units.length,
      complete: true, view: 'fixture-view-' + input.agentSessionId, replay: 'fixture-replay', checkpoint,
      outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => { reads.push({ kind: 'conversation', participant: input.agentSessionId }); return conversation(input) }
api.conversation.readConversationChanges = async input => { const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => {
  const page = conversation(input), closed = new AbortController()
  return { hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, scope: page.scope, coverage: page.coverage, closed: closed.signal, dispose() { closed.abort() } }
}
api.conversation.releaseConversationView = async input => ({ hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, viewId: input.view, released: true })
const reference = (messageId: string, senderSessionId: string, recipientSessionId: string) => ({ messageId, senderSessionId, recipientSessionId, threadId: messageId, replyTo: null })
const refs = [reference('fixture-request', 'fixture-ui', 'fixture-core'), reference('fixture-review-request', 'fixture-core', 'fixture-review'), reference('fixture-design-question', 'fixture-ui', 'fixture-design'), reference('fixture-return-report', 'fixture-core', 'fixture-ui')]
const events: AgentMuxMessageEvent[] = [
  { sequence: 1, kind: 'message', at: now - 9000, messages: [refs[0]!] },
  { sequence: 2, kind: 'message', at: now - 8000, messages: [refs[1]!] },
  { sequence: 3, kind: 'message', at: now - 7000, messages: [refs[2]!] },
  { sequence: 4, kind: 'delivery', state: 'delivered', at: now - 6000, messages: [refs[0]!] },
  { sequence: 5, kind: 'dispatch-open', at: now - 5000, messages: [refs[0]!] },
  { sequence: 6, kind: 'message', at: now - 4000, messages: [refs[3]!] }
]
let failEvents = false
api.sessions.messageEvents = async (subject, options = {}) => {
  reads.push({ kind: 'events', participant: subject.agentSessionId, options: structuredClone(options) })
  if (failEvents) throw Error('The original fixture message source is temporarily unavailable. Existing work is retained.')
  queueMicrotask(() => { for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-message-observation', state: 'available' } }) })
  const throughSequence = options.throughSequence ?? events.at(-1)!.sequence
  let selected = events.filter(event => event.sequence <= throughSequence && event.messages.some(message => (message.senderSessionId === subject.agentSessionId || message.recipientSessionId === subject.agentSessionId) && (!options.messageId || options.messageId === message.messageId)))
  if (options.beforeSequence !== undefined) selected = selected.filter(event => event.sequence < options.beforeSequence!)
  else if (options.afterSequence !== undefined) selected = selected.filter(event => event.sequence > options.afterSequence!)
  const backward = options.latest === true || options.beforeSequence !== undefined, limit = Math.min(options.limit ?? 50, 4)
  const more = selected.length > limit
  selected = backward ? selected.slice(-limit) : selected.slice(0, limit)
  const input = { ...options, participantSessionId: subject.agentSessionId }
  return { ...parseMessageEventsPage({ participantSessionId: subject.agentSessionId, afterSequence: options.afterSequence ?? 0,
    latest: options.latest ?? false, beforeSequence: options.beforeSequence ?? null, throughSequence, incarnation,
    messageId: options.messageId ?? null, broadcastOperationId: null, events: selected,
    nextAfterSequence: !backward && more ? selected.at(-1)!.sequence : null,
    nextBeforeSequence: backward && more ? selected[0]!.sequence : null }, input), hostId: subject.hostId }
}
const creation: AgentMuxSpawnRecord = { agentSessionId: 'fixture-core', phase: 'active', currentRun: { runId: 'fixture-run-fixture-core' }, createdAt: now - 50000,
  creation: { createOperationId: 'fixture-creation', initialPrompt: 'not-requested', createdRun: { runId: 'fixture-run-fixture-core' },
    createdBy: { agentSessionId: 'fixture-ui', run: { runId: 'fixture-run-fixture-ui' }, owner: { kind: 'local' } } } }
api.sessions.spawns = async (subject, options) => {
  reads.push({ kind: 'spawns', participant: subject.agentSessionId, options: structuredClone(options) })
  const matches = options.direction === 'created' ? subject.agentSessionId === 'fixture-ui' : subject.agentSessionId === 'fixture-core'
  return { hostId: subject.hostId, participantSessionId: subject.agentSessionId, direction: options.direction, creatorRuntimeId: null,
    records: matches ? [creation] : [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }
}
api.sessions.dispatches = async subject => ({ hostId: subject.hostId, participantSessionId: subject.agentSessionId, dispatches: [], nextSourceMessageId: null })
api.sessions.readMessage = async (subject, mid) => {
  reads.push({ kind: 'body', participant: subject.agentSessionId, options: mid })
  const ref = refs.find(ref => ref.messageId === mid)
  if (!ref) throw Error('Unknown private source message')
  return { hostId: subject.hostId, message: { sequence: events.find(event => event.kind === 'message' && event.messages[0]?.messageId === mid)!.sequence,
    envelope: { ...ref, schema: 'agentmux.a2a.v1', operationId: 'fixture-operation-' + mid, body: 'Inspect the original delivery boundary and report any concrete issue. Keep existing work and authorization.', createdAt: now - 9000,
      sender: { kind: 'agent-session', agentSessionId: ref.senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: ref.recipientSessionId },
      senderRunId: 'fixture-run-' + ref.senderSessionId, recipientRunId: null, workspaceId: null, correlationId: mid }, delivery: { state: 'delivered', at: now - 6000 } } }
}
createClientUiRoot(document.getElementById('root')!).render(createElement(App))
let originalState: ReturnType<typeof useAppStore.getState> | undefined, originalDraft: HTMLTextAreaElement | null = null
Object.assign(window, { graphCapture: {
  ready: true, reads, controls,
  prepare() {
    useAppStore.setState({ activeWorkspaceId: projects[0]!.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
      agentNames: Object.fromEntries(identities.map(([id, name]) => [id, name])), agentComposerDrafts: { 'fixture-ui': 'Original unsent reply · retain this exact draft.' } })
    useAppStore.getState().focusRegion(projects[0]!.id, 'tab-fixture-ui', 'region-fixture-ui', 'pointer', 'group-0')
  },
  remember() { originalState = useAppStore.getState(); originalDraft = document.querySelector('[data-fixture-session="fixture-ui"] textarea'); originalDraft?.setSelectionRange(4, 12) },
  appearance(appAppearance: 'dark' | 'light') { useAppStore.setState(state => ({ config: state.config ? { ...state.config, appearance: { ...state.config.appearance, appAppearance } } : null })) },
  surface(surface: 'workbench' | 'agents') { useAppStore.getState().setMainSurface(surface) },
  fail(value: boolean) { failEvents = value },
  live(live = true) {
    const sequence = events.at(-1)!.sequence + 1, mid = 'fixture-live-' + sequence, ref = reference(mid, 'fixture-core', 'fixture-ui')
    refs.push(ref); events.push({ sequence, kind: 'message', at: now + sequence, messages: [ref] })
    for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-message-changed', messageId: mid, senderSessionId: ref.senderSessionId, recipientSessionId: ref.recipientSessionId, sequence, messageSequence: sequence, recordKind: 'message', live } })
  },
  facts() { const state = useAppStore.getState(); return { loading: state.loading, ids: state.sessions.map(session => session.id),
    sameTabs: state.tabs === originalState?.tabs, sameLayouts: state.layouts === originalState?.layouts,
    sameDrafts: state.agentComposerDrafts === originalState?.agentComposerDrafts, sameFocus: state.agentFocus === originalState?.agentFocus,
    sameSelection: state.workbenchSpaceSelection === originalState?.workbenchSpaceSelection,
    draftMounted: originalDraft?.isConnected, sameDraft: originalDraft === document.querySelector('[data-fixture-session="fixture-ui"] textarea'),
    draft: originalDraft?.value, range: [originalDraft?.selectionStart, originalDraft?.selectionEnd], reads: [...reads], controls: [...controls],
    selectedSession: state.agentFocus.execution.sessionId, originalRun: sessions[0]!.control.run.runId,
    graph: Boolean(document.querySelector('.collaboration-dialog')), readers: document.querySelectorAll('[data-agent-reading-host]').length } }
} })
