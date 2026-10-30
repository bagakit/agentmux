import '../mote-cooperation/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { serializeMoteQuickMode } from '../../../src/shared/mote-quick-mode'
import type { MoteDialoguePage, MoteDialogueLink } from '@agentmux/core/mote-dialogue'

const initial = useAppStore.getState(), workspace = initial.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
const original = (window as any).moteCooperationCapture
const captureAt = Date.now()
const topic = initial.scratchTopicSnapshots[workspace.id]!.topics!.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!
const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath), zoneId = homeZoneId(spaceId)
const target = { spaceId, zoneId, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
const reference = { hostId: 'local', sessionId: 'mote-primary', displayWorkspaceId: workspace.id, groupId: 'original-mote-group', tabId: 'mote-primary-tab', regionId: 'mote-primary-region' }
const identity = { hostId: workspace.hostId, moteId: topic.id }, calls: { method: string; input?: unknown }[] = []
let unbound = new URLSearchParams(location.search).has('initialUnbound'), unavailable = false, delay = false
const releaseNative: (() => void)[] = []
const originalReader = api.conversation.readAgentConversation
const query = new URLSearchParams(location.search)
if (query.has('initialDelay')) delay = true
api.conversation.readAgentConversation = async input => {
  calls.push({ method: 'conversation.read', input })
  if (delay && input.agentSessionId === reference.sessionId) await new Promise<void>(resolve => { releaseNative.push(resolve) })
  return originalReader(input)
}
const work: Extract<MoteDialogueLink, { kind: 'work' }> = { kind: 'work', sequence: 1, identity, operationId: 'original-dispatch-association', associatedAt: 2,
 eventId: 'original-work-event', mainRoleRevision: 'original-main-role', main: { hostId: 'local', agentSessionId: reference.sessionId },
 origin: { hostId: 'local', messageId: 'original-dispatch', threadId: 'original-work-thread', senderSessionId: reference.sessionId, recipientSessionId: 'mote-neighbor', createdAt: captureAt - 3_600_000 } }
const page = (): MoteDialoguePage => ({ main: { target, identity, status: 'ready', resource: null, documentRevision: 'sha256:' + 'a'.repeat(64), roleRevision: 'original-main-role', current: unbound ? null : reference, issue: null },
 links: [work], incarnation: 'original-associations', throughSequence: 1, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
api.moteDialogue.read = async input => { calls.push({ method: 'dialogue.read', input }); if (unavailable) throw Error('原主角色暂未确认，已读对话与草稿保留。'); const value = page(); return input.kind === 'main' ? { ...value, links: [] } : value }
api.moteDialogue.inspectRecovery = async input => { calls.push({ method: 'recovery.inspect', input }); return { operation: null } }
api.moteDialogue.ensureRecovery = async input => { calls.push({ method: 'recovery.ensure', input }); if (query.has('initialDelay')) throw Error('原 Agent 恢复结果尚未确认；历史与输入仍保留，可核对原操作。'); return { operation: { operationId: input.operationId, agentSessionId: input.reference.sessionId, trigger: 'manual', previousRun: input.expectedRun, policy: {}, admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'reattachable', reason: 'original-fixture-run-live', evidence: { kind: 'run-alive', observedAt: 1 }, moteMainEntry: { target: input.target, reference: input.reference, expectedRoleRevision: input.expectedRoleRevision } } } as any }
api.motePreferences.read = async input => ({ target: input.target, kind: 'quick', status: 'ready',
 source: { resource: { ...target.expectedResource, zoneId, zonePath: topic.directoryPath, path: scratchTopicDirectoryName(topic.id) + '/MOTE.md' }, result: { status: 'read', document: { path: scratchTopicDirectoryName(topic.id) + '/MOTE.md', content: serializeMoteQuickMode('', unbound ? {} : { conversation: reference }), revision: 'sha256:' + 'a'.repeat(64) } } },
 defaults: unbound ? {} : { conversation: reference }, choices: { executors: [], conversations: [], destinations: [] }, main: true, maintenance: { status: 'unbound', schedule: null, issue: null }, issue: null }) as any
api.sessions.dispatch = async (_target, messageId) => {
 if (messageId !== work.origin.messageId) throw Error('Unknown original dispatch')
 return { hostId: 'local', dispatch: { sourceMessageId: work.origin.messageId, ownerAgentSessionId: reference.sessionId, workerAgentSessionId: work.origin.recipientSessionId, threadId: work.origin.threadId, openedAt: work.origin.createdAt!, originAwaits: true, events: [] },
 source: { envelope: { ...work.origin, body: '补齐 Mote 的产品体验，并核对原会话恢复' } }, replies: [{ envelope: { messageId: 'original-worker-report', threadId: work.origin.threadId, senderSessionId: work.origin.recipientSessionId, recipientSessionId: reference.sessionId, createdAt: work.origin.createdAt! + 60000, body: '主对话和 Threads 已分开，接下来核对实际入口和原会话。' } }], identityDiagnostics: [] } as any
}
const seedTopics = () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value, revision: value.revision + 1,
 topics: value.topics?.map(item => item.id === topic.id ? { ...item, quickMode: { status: 'saved' as const, version: 'original-file-' + String(unbound), defaults: unbound ? {} : { conversation: reference } } } : item) }])) }))
useAppStore.setState({ projectRailOpen: true, sessions: initial.sessions.map(session => session.id === reference.sessionId && query.has('initialDelay') ? { ...session, processState: 'exited' } : session) })
seedTopics()
requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id })
Object.assign(window, { moteDiscussionCapture: { ready: true, captureAt, facts: () => ({ ...original.facts(), calls, nativeDelayed: delay, mainUnbound: unbound }),
 release() { delay = false; for (const release of releaseNative.splice(0)) release() },
 unbound() { unbound = true; seedTopics(); requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id }) },
 unavailable() { unavailable = true; seedTopics() },
 longNames() { original.longNames() }, theme: original.theme,
 restore() { unbound = false; unavailable = false; original.restore(); seedTopics(); requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id }) }
} })
