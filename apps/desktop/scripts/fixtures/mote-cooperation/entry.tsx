import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { serializeMoteQuickMode } from '../../../src/shared/mote-quick-mode'
import { projectConversationReading, parseConversationReadPage, conversationRevision } from '@agentmux/core/conversation'
import { moteInputNoticeWire } from '@agentmux/core/mote-input-notice'
import { moteNoticeCaptureFixture } from '../../../../../packages/client-ui/test/fixtures/mote-notice'

const originalSourceHost = 'host-original'

// Opening the private App may request the Reader immediately. Keep those same requests
// pending until the finite source ports below are ready, rather than painting a fake error.
let openReader!: () => void
const readerReady = new Promise<void>(resolve => { openReader = resolve })
api.sessions.notifyInputOccupation = async () => {}
api.conversation.readAgentConversation = async input => { await readerReady; return conversation(input) }
api.conversation.readConversationChanges = async input => { await readerReady; const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => {
  await readerReady
  const page = conversation(input), controller = new AbortController()
  return { hostId: input.hostId, sourceHostId: originalSourceHost, agentSessionId: input.agentSessionId, scope: page.scope, coverage: page.coverage,
    closed: controller.signal, dispose: () => controller.abort() }
}
api.conversation.releaseConversationView = async input => ({ ...input, sourceHostId: originalSourceHost, viewId: input.view, released: true })

// Reuse the existing full-App private Electron bootstrap, not replacement product components.
// It performs the original Store initialization against finite preview API ports and then
// seeds exact workfaces. The complete App owns the floating panel, Workbench and Composer.
await import('../mote-closed-tab-target/entry.mjs')

const writes: Array<{ operation: string; args: unknown[] }> = []
const reads: Array<{ operation: string; target: unknown }> = []
const trustedEvents: Array<{ type: string; trusted: boolean; label: string | null }> = []
const forbidden = ['write', 'paste', 'submitPrompt', 'respondInteraction', 'replyQuestion', 'launchAgent', 'launchTerminal', 'stop'] as const
for (const operation of forbidden) (api.sessions as unknown as Record<string, unknown>)[operation] = async (...args: unknown[]) => {
  writes.push({ operation, args }); throw new Error('A reading/navigation capture must never dispatch ' + operation)
}
for (const type of ['click', 'keydown', 'input']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : null
  trustedEvents.push({ type, trusted: event.isTrusted, label: target?.getAttribute('aria-label') ?? target?.textContent?.trim().slice(0, 120) ?? null })
}, true)

const state = useAppStore.getState()
const workspace = state.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
const reference = { hostId: 'local', sessionId: 'mote-primary', displayWorkspaceId: workspace.id,
  groupId: 'original-mote-group', tabId: 'mote-primary-tab', regionId: 'mote-primary-region' }
const originalList = api.scratch.listTopics
let topicRecords = (await originalList(workspace.id)).map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? {
  ...topic, title: 'Mote', quickMode: { status: 'saved' as const, version: 'private-original-preference', defaults: { conversation: reference } }
} : topic)
const originalTopicRecords = structuredClone(topicRecords)
const originalSessions = state.sessions.map(session => session.kind !== 'agent' ? session : ({ ...session,
  label: session.id === 'mote-primary' ? '主 Agent' : session.id === 'mote-neighbor' ? '实现与校验' : session.id === 'custom-mote' ? '另一位搭档的研究' : session.label,
  nativeSourceObservation: undefined, terminalCapability: undefined, terminalPromptDelivery: undefined,
  pendingInteraction: session.id === 'mote-neighbor' ? { kind: 'question' as const, id: 'original-experiment-choice',
    agentSessionId: session.control.agentSessionId, evidence: { source: 'acp' as const, observedAt: Date.now(), run: session.control.run },
    questions: [{ id: 'experiment', title: '下一步先验证哪一项？', prompt: '实现已经准备好。先核对准确引用，再继续完整场景？',
      options: [{ id: 'references', label: '先核对引用' }, { id: 'complete', label: '继续完整场景' }] }] } : undefined,
  status: { state: session.id === 'mote-neighbor' ? 'waiting' as const : 'working' as const, source: 'native-hook' as const, observedAt: Date.now() },
  semanticStatus: { state: session.id === 'mote-neighbor' ? 'waiting' as const : 'working' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() }
}))
const snapshots = () => ({ [workspace.id]: { ...useAppStore.getState().scratchTopicSnapshots[workspace.id]!, topics: structuredClone(topicRecords), reading: false, error: null } })
api.scratch.listTopics = async () => structuredClone(topicRecords)
api.scratch.readTopic = async (_workspaceId, topicId) => structuredClone(topicRecords.find(topic => topic.id === topicId) ?? null)
api.scratch.ensureMote = async (_workspaceId, topicId) => {
  const topic = topicRecords.find(topic => topic.id === topicId)
  if (!topic) throw new Error('The exact private Mote does not exist')
  return structuredClone(topic)
}
api.demands.list = async () => []
api.continuousProgress.goals = async () => []
api.continuousProgress.list = async () => []
api.sessions.snapshot = async () => ({ sessions: useAppStore.getState().sessions, timelines: {}, recoveryCandidates: [] })
const currentSession = (id: string) => useAppStore.getState().sessions.find(session => session.kind === 'agent' && session.control.agentSessionId === id)
const originalAttach = api.sessions.attach
api.sessions.attach = async control => ({ ...await originalAttach(control), session: currentSession(control.agentSessionId)! })
api.sessions.refreshAttachment = control => api.sessions.attach(control)
api.sessions.refresh = async control => currentSession(control.agentSessionId)!

const moteSpaceId = directoryIdentity(workspace.hostId, topicRecords.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!.directoryPath)
const notice = moteNoticeCaptureFixture({ recipient: 'mote-primary', member: 'mote-neighbor', phase: 'result',
  source: { spaceId: moteSpaceId, zoneId: homeZoneId(moteSpaceId), tabId: 'mote-neighbor-tab', regionId: 'mote-neighbor-region' } })
if (notice.observation.origin.kind === 'prompt') notice.observation.origin.key.expectedRun = { runId: 'original-run-mote-neighbor' }
if (notice.observation.result?.kind === 'native-turn') for (const reference of notice.observation.result.records) reference.record.hostId = originalSourceHost
notice.item.inputRef!.expectedRun = { runId: 'original-run-mote-primary' }
notice.item.content = moteInputNoticeWire(notice.observation, 'result')
api.sessions.inspectMoteInput = async (target, observationId) => {
  reads.push({ operation: 'mote-observation', target: { ...target, observationId } })
  if (target.hostId !== 'local' || target.agentSessionId !== 'mote-neighbor' || observationId !== notice.observation.id)
    throw new Error('Only the original notice Host/member/observation can be read')
  return structuredClone(notice.inspection)
}

const mainText = '把协作体验补完整：主对话要清楚，成员工作能看见，需要我判断时再叫我。'
function conversation(input: Parameters<typeof api.conversation.readAgentConversation>[0]) {
  reads.push({ operation: 'conversation', target: input })
  const nativeSource = { providerId: 'codex', nativeSessionId: input.agentSessionId === 'mote-neighbor' ? 'preview-member-native' : 'original-native-' + input.agentSessionId }
  const isMain = input.agentSessionId === 'mote-primary'
  const projected = projectConversationReading({ agentSessionId: input.agentSessionId, routeHostId: input.hostId, executionHostId: originalSourceHost,
    historyPage: { agentSessionId: input.agentSessionId, sourceHostId: originalSourceHost, source: nativeSource, nextCursor: null, items: [
      { id: 'original-human', kind: 'user-message', turnId: 'original-turn', startedAt: notice.item.createdAt + 5 * 60 * 60 * 1_000,
        contentParts: [{ kind: 'text', text: isMain ? mainText : '请先核对准确引用，再回到完整体验验证。' }] },
      { id: input.agentSessionId === 'mote-neighbor' ? 'preview-member-reply' : 'original-reply', kind: 'assistant-message', turnId: 'original-turn', startedAt: notice.item.createdAt + 5 * 60 * 60 * 1_000 + 1_000,
        contentParts: [{ kind: 'text', text: isMain ? '我会留在这里接住新的方向。实现与校验正在原成员讨论里推进；需要你选择的事项可以从团队入口查看。'
          : '引用和原操作身份已经整理好。下一步有一个需要你选择的验证顺序；没有发送新的指令。' }] }
    ] }, timeline: { agentSessionId: input.agentSessionId, sourceHostId: originalSourceHost, revision: 1, items: isMain ? [notice.item] : [], stream: { epoch: 'original-notice-epoch', sequence: isMain ? 1 : 0, revision: 1, origin: 'beginning', gaps: [], positions: isMain ? [{ id: notice.item.id, firstSequence: 1, sequence: 1, revision: conversationRevision(notice.item) }] : [] } } }).timeline
  const ref = { hostId: input.hostId, agentSessionId: input.agentSessionId }
  const checkpoint = { ...ref, sourceHostId: originalSourceHost, frontier: { ...ref, hostId: originalSourceHost, scope: projected.scope, cuts: [] } }
  const items = [...projected.events].reverse().map(event => ({ kind: 'item', item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
  return parseConversationReadPage({ ...ref, ...(input.processDetails ? { processDetails: input.processDetails } : {}), sourceHostId: originalSourceHost, scope: projected.scope, coverage: projected.coverage,
    order: { ...projected.order, direction: 'newest-first' }, items, nextCursor: null, budgetBytes: input.maxBytes ?? 64 * 1024,
    window: { id: 'original-window-' + input.agentSessionId, revision: 1, itemCount: items.length, complete: true,
      view: input.view ?? 'original-view-' + input.agentSessionId, replay: 'original-replay', checkpoint, outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => { try { return conversation(input) } catch (error) { reads.push({ operation: 'conversation-error', target: { message: String(error), stack: (error as Error).stack } }); throw error } }
api.conversation.readConversationChanges = async input => { const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => {
  const page = conversation(input), controller = new AbortController()
  return { hostId: input.hostId, sourceHostId: originalSourceHost, agentSessionId: input.agentSessionId,
    scope: page.scope, coverage: page.coverage, closed: controller.signal, dispose: () => controller.abort() }
}
api.conversation.releaseConversationView = async input => ({ ...input, sourceHostId: originalSourceHost, viewId: input.view, released: true })

api.files.readPublic = async params => {
  reads.push({ operation: 'file.read', target: params })
  const resource = { ...params.expectedResource!, zoneId: params.zoneId!, zonePath: workspace.path + '/' + scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path: params.path }
  const content = params.path === 'MOTE.md' ? serializeMoteQuickMode('', { conversation: reference })
    : params.path === 'topic.md' ? '# Mote\n\n把原工作接起来，清楚地合作。\n' : null
  return { resource, result: content === null ? { status: 'deleted' } : { status: 'read', document: { path: params.path, content, revision: 'sha256:' + 'a'.repeat(64) } } }
}
const seededTabs = Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => {
  const topic = topicRecords.find(topic => topic.id === tab.topicId)
  const spaceId = topic && directoryIdentity(workspace.hostId, topic.directoryPath)
  return [id, spaceId ? { ...tab, space: { spaceId, zoneId: homeZoneId(spaceId) } } : tab]
}))
const bindings = { ...state.spaceZoneBindings, ...Object.fromEntries(topicRecords.map(topic => {
  const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath)
  return [homeZoneId(spaceId), { spaceId, workspaceId: workspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'mote' as const }]
})) }
const originalDrafts = { ...state.agentComposerDrafts, 'mote-primary': '还有一个问题先留在这里，暂不发送。', 'mote-neighbor': '核对记录后再决定下一步。' }
useAppStore.setState({ sessions: originalSessions, tabs: seededTabs, spaceZoneBindings: bindings, scratchTopicSnapshots: snapshots(),
  agentNames: Object.fromEntries(originalSessions.map(session => [session.id, session.label])), agentComposerDrafts: originalDrafts,
  viewModes: Object.fromEntries(originalSessions.map(session => [session.id, 'activity'])), demands: {}, error: null, lastError: null })

const theme = (light: boolean) => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, appearance: { ...config.appearance, appAppearance: light ? 'light' : 'dark' } } }) }
const facts = () => {
  const next = useAppStore.getState()
  return { routeHostId: 'local', sourceHostId: originalSourceHost, drafts: next.agentComposerDrafts, identities: Object.fromEntries(Object.entries(next.tabs).map(([id, tab]) => [id,
    Object.fromEntries(Object.entries(tab.regions).map(([id, region]) => [id, region.kind === 'agent' ? { kind: region.kind, sessionId: region.sessionId } : { kind: region.kind }]))])),
    runs: next.sessions.map(session => ({ id: session.id, control: session.control })), selection: next.workbenchSpaceSelection,
    activeWorkspaceId: next.activeWorkspaceId, writes, reads, trustedEvents,
    bootstrap: (window as unknown as { closedTabProof: { facts(): unknown } }).closedTabProof.facts(),
    visibleCooperation: [...document.querySelectorAll<HTMLElement>('[data-mote-cooperation]')].filter(node => node.checkVisibility()).map(node => node.innerText),
    composers: [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message Agent"]')].filter(node => node.checkVisibility()).map(node => node.value) }
}
Object.assign(window, { moteCooperationCapture: { ready: true, facts, theme,
  unknown() {
    topicRecords = topicRecords.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, readError: '原 Mote 资料暂未确认；原成员、工作和输入保留。' } : topic)
    useAppStore.setState({ scratchTopicSnapshots: snapshots(), sessions: useAppStore.getState().sessions.filter(session => session.id !== 'mote-neighbor') })
  },
  restore() { topicRecords = structuredClone(originalTopicRecords); useAppStore.setState({ scratchTopicSnapshots: snapshots(), sessions: originalSessions }) },
  longNames() {
    topicRecords = topicRecords.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, title: '长期合作伙伴：产品体验与可靠实现' } : topic)
    const sessions = originalSessions.map(session => ({ ...session, label: session.id === 'mote-neighbor' ? '实现与校验：跨客户端准确引用及原工作接续验证' : session.label }))
    useAppStore.setState({ sessions, tabs: Object.fromEntries(Object.entries(useAppStore.getState().tabs).map(([id, tab]) => [id, id === 'mote-neighbor-tab' ? { ...tab, name: '实现与校验：跨客户端准确引用及原工作接续验证' } : tab])), agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])), scratchTopicSnapshots: snapshots() })
  },
  reopen() { requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: reference.tabId, reference }) }
} })
openReader()
requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: reference.tabId, reference })
