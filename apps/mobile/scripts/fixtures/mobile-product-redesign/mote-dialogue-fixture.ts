import { fixturePath } from '../../../../../test/fixture-values.mjs'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { effectiveMoteQuickSave, type MotePresenceReading } from '@agentmux/core/mote-preferences'
/** Private observations only. No live Mote, schedule, model or Run is operated. */
export function createMoteDialogueCapture() {
  const hostId = 'host-original', spaceId = 'mote-original', zoneId = 'zone-mote', workspacePath = fixturePath('mote-original')
  const resource = { hostId, workspaceId: 'workspace-original', workspacePath }, target = { spaceId, zoneId, expectedResource: resource }
  const file = { ...resource, zoneId, zonePath: workspacePath, path: 'MOTE.md' }, identity = { hostId, moteId: spaceId }
  const main = { hostId, sessionId: 'session-mote', displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' }
  const b = { ...main, sessionId: 'session-waiting', regionId: 'region-waiting' }
  const originalAt = Date.now() - 60_000
  const work = { sequence: 2, identity, operationId: 'original-capture-work-link', associatedAt: originalAt, kind: 'work' as const, eventId: 'original-research-event', mainRoleRevision: 'original-role-A',
    main: { hostId, agentSessionId: main.sessionId }, origin: { hostId, messageId: 'original-research-assignment', threadId: 'original-research-thread', senderSessionId: main.sessionId, recipientSessionId: b.sessionId, createdAt: originalAt } }
  const prior = { sequence: 1, identity, operationId: 'original-capture-main-link', associatedAt: originalAt - 1000, kind: 'main' as const, roleRevision: 'original-role-A', reference: main,
    range: 'whole-session' as const, file: { resource: file, revision: 'sha256:' + 'b'.repeat(64) } }
  let page: MoteDialoguePage = { main: { target, identity, status: 'ready', resource: file, documentRevision: 'sha256:' + 'b'.repeat(64), roleRevision: 'original-role-A', current: main, issue: null },
    links: [work], incarnation: 'original-capture-journal', throughSequence: 2, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
  const document = { path: 'MOTE.md', content: '# 我的 Mote\n\n保留目标、依据、已作决定和未完成承诺。', revision: 'sha256:' + 'b'.repeat(64) }
  let defaults = { executorId: 'fixture-original', conversation: main, conversationRevision: 'original-role-A', presence: { enabled: true, intervalMs: 1800000 } }
  let maintenance: MotePresenceReading = { status: 'paused', issue: null, schedule: { loopId: 'original-mote-heartbeat', hostId, agentSessionId: main.sessionId, providerId: 'codex', workspacePath,
    everyMs: 1800000, intervalMs: 1000, prompt: 'Original frozen internal check of goals, threads, decisions and unfinished commitments.', nextCheckAt: originalAt + 1800000, status: 'paused', revision: 7,
    creationOperationId: 'original-heartbeat-create', futureIntentId: 'original-heartbeat-intent' } }
  let unknown = false
  const dispatch = { hostId, dispatch: { sourceMessageId: work.origin.messageId, ownerAgentSessionId: main.sessionId, workerAgentSessionId: b.sessionId, threadId: work.origin.threadId,
      openedAt: originalAt, originAwaits: true, events: [{ kind: 'worker_done', senderSessionId: b.sessionId, recipientSessionId: main.sessionId, messageId: 'original-research-report', createdAt: originalAt + 60000 }] },
    source: { envelope: { messageId: work.origin.messageId, threadId: work.origin.threadId, senderSessionId: main.sessionId, recipientSessionId: b.sessionId,
      body: '比较两个实验方向，保留原资料与需要你决定的问题。', createdAt: originalAt } }, replies: [{ envelope: { messageId: 'original-research-report', threadId: work.origin.threadId,
      senderSessionId: b.sessionId, recipientSessionId: main.sessionId, body: '三份样本已读。方案 A 更容易在一天内得到反馈；方案 B 的原依据也已保留。下一步仍由你决定。', createdAt: originalAt + 60000 } }], identityDiagnostics: [] }
  return {
    replaceMain() { page = { ...page, links: [work, prior], main: { ...page.main, current: b, roleRevision: 'original-role-B' } } },
    unconfirm() { unknown = true },
    facts: () => ({ target, page, maintenance }),
    rpc(method: string, input: any) {
      if (method === 'space.mote.dialogue.read') { if (unknown) throw Error('原主对话读取暂不可用；保留上次确认的角色、原工作与草稿。'); return structuredClone(page) }
      if (method === 'message.dispatch.read') { if (input.hostId !== hostId || input.sourceMessageId !== work.origin.messageId) throw Error('Wrong original work source'); return structuredClone(dispatch) }
      if (method === 'space.mote.preferences.read') return { kind: 'quick', target, status: 'ready', source: { resource: file, result: { status: 'read', document } }, defaults,
        choices: { executors: [{ id: 'fixture-original', name: 'Codex', providerId: 'codex' }], conversations: [{ reference: main, label: '原承接者' }, { reference: b, label: '当前承接者' }],
          destinations: [{ reference: { kind: 'occurrence', displayWorkspaceId: main.displayWorkspaceId, groupId: main.groupId, tabId: main.tabId, regionId: main.regionId }, label: '原 Mote 位置' }] }, main: false, issue: null, maintenance }
      if (method === 'space.mote.preferences.save') { defaults = effectiveMoteQuickSave(input) as typeof defaults; return { kind: 'quick', target, operationId: input.operationId, status: 'saved', source: { resource: file, document, defaults }, message: null } }
      if (method === 'schedule.resume') {
        const schedule = { ...maintenance.schedule!, status: 'active' as const, revision: input.expectedRevision + 1, lastMutation: { action: 'resume' as const, operationId: input.operationId, expectedRevision: input.expectedRevision } }
        maintenance = { status: 'active', schedule, issue: null }; return { schedule, diskDurability: 'confirmed', executionScope: 'connected-host' }
      }
      return undefined
    }
  }
}
