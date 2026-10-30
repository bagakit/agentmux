import '../mote-continuous-frame/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { MoteDialoguePage, MoteDialogueRead } from '@agentmux/core/mote-dialogue'
const workspace = useAppStore.getState().config!.workspaces.find(w => w.id === '__scratch__')!
const reference = { hostId: 'local', sessionId: 'mote-primary', displayWorkspaceId: workspace.id, groupId: 'original-mote-group', tabId: 'mote-primary-tab', regionId: 'mote-primary-region' }
const worker = { ...reference, sessionId: 'mote-neighbor', tabId: 'mote-neighbor-tab', regionId: 'mote-neighbor-region' }
let current = reference, unavailable = false
const dialogueReads: unknown[] = []
const dispatchReads: unknown[] = []
const initialNativeReadFailure = new URLSearchParams(location.search).get('nativeReaderFailure') === '1'
const identity = { hostId: 'local', moteId: PMO_TEAMS_TOPIC_ID }
const original = initialNativeReadFailure ? null : await api.conversation.readAgentConversation({ hostId: 'local', agentSessionId: reference.sessionId })
const times = (original?.items ?? []).flatMap(item => item.kind === 'item' ? item.item.records.flatMap(record => typeof record.recordedAt === 'number' ? [record.recordedAt] : []) : []).sort((a,b)=>a-b)
const occurredAt = Math.floor(times.length > 1 ? (times.at(-2)! + times.at(-1)!) / 2 : Date.now() - 1000)
const work = { sequence: 2, kind: 'work' as const, identity, operationId: 'original-link-work', associatedAt: occurredAt + 800,
  eventId: 'original-product-work', mainRoleRevision: 'original-role-A', main: { hostId: 'local', agentSessionId: reference.sessionId },
  origin: { hostId: 'local', messageId: 'original-work-message', threadId: 'original-work-thread', senderSessionId: reference.sessionId, recipientSessionId: worker.sessionId, createdAt: Math.floor(occurredAt) } }
const unknownDate = { ...work, sequence: 3, operationId: 'original-link-research', eventId: 'original-research-work', origin: { ...work.origin, messageId: 'original-research-message', threadId: 'original-research-thread', createdAt: null } }
api.moteDialogue.read = async (query: MoteDialogueRead): Promise<MoteDialoguePage> => { dialogueReads.push(query); return ({ main: { target: query.target, identity, status: 'ready', resource: null,
  documentRevision: 'original-MOTE-file', roleRevision: current === reference ? 'original-role-A' : 'original-role-B', current, issue: null },
  links: unavailable ? [] : [unknownDate, work, { sequence: 1, kind: 'main', identity, operationId: 'original-main-source', associatedAt: occurredAt + 900, roleRevision: 'original-role-A', reference,
    range: 'whole-session', file: { resource: { ...query.target.expectedResource, zoneId: query.target.zoneId, zonePath: workspace.path + '/' + scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) + '/MOTE.md' }, revision: 'original-MOTE-file' } }],
  incarnation: 'original-source-links', throughSequence: 3, next: null, coverage: 'linked-sources-only', sourceStatus: unavailable ? 'unconfirmed' : 'read', sourceIssue: unavailable ? '原事件来源暂未确认；已有工作与主对话保留。' : null }) }
api.sessions.dispatch = async (_target, messageId) => {
  dispatchReads.push({ target: _target, messageId })
  const source = messageId === work.origin.messageId ? work : unknownDate
  return { hostId: source.origin.hostId, dispatch: { sourceMessageId: source.origin.messageId, ownerAgentSessionId: source.main.agentSessionId, workerAgentSessionId: source.origin.recipientSessionId, threadId: source.origin.threadId, openedAt: source.origin.createdAt ?? occurredAt,
    originAwaits: true, events: messageId === work.origin.messageId ? [{ kind: 'worker_done', eventId: 'original-report', createdAt: occurredAt + 3000 }] : [] },
    source: { envelope: { ...source.origin, body: messageId === work.origin.messageId ? '补齐主对话体验，核对原引用与旧输入的去向' : '研究现有界面，整理可借鉴的交互细节' } },
    replies: messageId === work.origin.messageId ? [{ envelope: { messageId: 'original-work-reply', threadId: source.origin.threadId, senderSessionId: worker.sessionId, recipientSessionId: reference.sessionId, body: '主对话与事件历史已接上原来源。下一步检查切换承接者时的阅读与草稿。', createdAt: occurredAt + 3000 } }] : [], identityDiagnostics: [] } as any
}
const schedule = { loopId: 'original-heartbeat', hostId: 'local', agentSessionId: reference.sessionId, providerId: 'codex', workspacePath: workspace.path, everyMs: 1800000, intervalMs: 1800000, prompt: 'Original Mote heartbeat', nextCheckAt: Math.floor(occurredAt + 1800000), status: 'paused' as const, revision: 1, lastOutcome: 'unknown' as const }
api.motePreferences.read = async input => {
  const logical = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), file = { ...input.target.expectedResource, zoneId: input.target.zoneId, zonePath: workspace.path + '/' + logical, path: logical + '/MOTE.md' }
  return { ...input, kind: 'quick', status: 'ready', source: { resource: file, result: { status: 'read', document: { path: file.path, content: '# Original Mote settings', revision: 'sha256:' + 'b'.repeat(64) } } }, defaults: { conversation: current }, main: true, choices: { executors: [], conversations: [], destinations: [] }, issue: null, maintenance: { status: 'paused', schedule, issue: null } }
}
;(window as any).moteDialogueCapture = { switchMain() { current = worker }, unknown() { unavailable = true }, restore() { unavailable = false }, facts() { return { current, occurredAt, dialogueReads, dispatchReads, initialNativeReadFailure } },
  workface() { const state = useAppStore.getState(); return { tabs: state.tabs, layouts: state.layouts, bindings: state.spaceZoneBindings, drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, runs: state.sessions.map(session => session.control) } }
}
// Invalidate the first preview read after installing the finite actual public ports.
useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id,snapshot]) => [id, snapshot.topics ? { ...snapshot, topics: snapshot.topics.map(t => t.id === PMO_TEAMS_TOPIC_ID ? { ...t, quickMode: { status: 'saved' as const, version: 'dialogue-preview-ready', defaults: { conversation: reference } } } : t) } : snapshot])) }))
