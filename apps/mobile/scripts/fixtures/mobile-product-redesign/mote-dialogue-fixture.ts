import { fixturePath } from '../../../../../test/fixture-values.mjs'
import type { MoteDialoguePage, MoteMainSetupResult } from '@agentmux/core/mote-dialogue'
import { moteMainBindingDefaults } from '@agentmux/core/spatial-graph'
import { effectiveMoteQuickSave, type MotePresenceReading, type MoteQuickDefaults } from '@agentmux/core/mote-preferences'
import { moteDirectCapture } from '../../../../../packages/client-ui/test/fixtures/mote-direct'
/** Private observations only. No live Mote, schedule, model or Run is operated. */
export function createMoteDialogueCapture(threadLayout = false) {
  const hostId = 'host-original', spaceId = 'mote-original', zoneId = 'zone-mote', workspacePath = fixturePath('mote-original')
  const resource = { hostId, workspaceId: 'workspace-original', workspacePath }, target = { spaceId, zoneId, expectedResource: resource }
  const direct = moteDirectCapture(target)
  const file = { ...resource, zoneId, zonePath: workspacePath, path: 'MOTE.md' }, identity = { hostId, moteId: spaceId }
  const main = { hostId, sessionId: 'session-mote', displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' }
  const b = { ...main, sessionId: 'session-waiting', regionId: 'region-waiting' }
  const originalAt = Date.now() - 60_000
  const work = { sequence: 2, identity, operationId: 'original-capture-work-link', associatedAt: originalAt, kind: 'work' as const, eventId: 'original-research-event', mainRoleRevision: 'original-role-A',
    main: { hostId, agentSessionId: main.sessionId }, origin: { hostId, messageId: 'original-research-assignment', threadId: 'original-research-thread', senderSessionId: main.sessionId, recipientSessionId: b.sessionId, createdAt: originalAt } }
  const alternateWork = { ...work, sequence: 3, operationId: 'original-capture-second-link', eventId: 'original-review-event',
    origin: { ...work.origin, messageId: 'original-review-assignment', threadId: 'original-review-thread', createdAt: originalAt + 1000 } }
  const prior = { sequence: 1, identity, operationId: 'original-capture-main-link', associatedAt: originalAt - 1000, kind: 'main' as const, roleRevision: 'original-role-A', reference: main,
    range: 'whole-session' as const, file: { resource: file, revision: 'sha256:' + 'b'.repeat(64) } }
  let page: MoteDialoguePage = { main: { target, identity, status: 'ready', resource: file, documentRevision: 'sha256:' + 'b'.repeat(64), roleRevision: 'original-role-A', current: main, issue: null },
    links: threadLayout ? [alternateWork, work] : [work], incarnation: 'original-capture-journal', throughSequence: threadLayout ? 3 : 2, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
  const document = { path: 'MOTE.md', content: '# 我的 Mote\n\n保留目标、依据、已作决定和未完成承诺。', revision: 'sha256:' + 'b'.repeat(64) }
  let defaults: MoteQuickDefaults = { executorId: 'fixture-original', conversation: main, conversationRevision: 'original-role-A', presence: { enabled: true, intervalMs: 1800000 } }
  let maintenance: MotePresenceReading = { status: 'paused', issue: null, schedule: { loopId: 'original-mote-heartbeat', hostId, agentSessionId: main.sessionId, providerId: 'codex', workspacePath,
    everyMs: 1800000, intervalMs: 1000, prompt: 'Original frozen internal check of goals, threads, decisions and unfinished commitments.', nextCheckAt: originalAt + 1800000, status: 'paused', revision: 7,
    creationOperationId: 'original-heartbeat-create', futureIntentId: 'original-heartbeat-intent' } }
  let unknown = false
  let retentionSnapshot: MoteMainSetupResult | null = null, setup: MoteMainSetupResult | null = null, releaseSetup: (() => void) | null = null
  const researchReply = '三份样本已读。方案 A 更容易在一天内得到反馈；方案 B 的原依据也已保留。下一步仍由你决定。'
  const longReply = Array.from({ length: 18 }, (_, index) =>
    `**样本 ${index + 1}** 保留原始观察和待验证的证据。先比较两次结果，再把明确结论记录回同一工作。`).join('\n\n')
  const dispatch = { hostId, dispatch: { sourceMessageId: work.origin.messageId, ownerAgentSessionId: main.sessionId, workerAgentSessionId: b.sessionId, threadId: work.origin.threadId,
      openedAt: originalAt, originAwaits: true, events: [{ kind: 'worker_done', senderSessionId: b.sessionId, recipientSessionId: main.sessionId, messageId: 'original-research-report', createdAt: originalAt + 60000 }] },
    source: { envelope: { messageId: work.origin.messageId, threadId: work.origin.threadId, senderSessionId: main.sessionId, recipientSessionId: b.sessionId,
      body: '比较两个实验方向，保留原资料与需要你决定的问题。', createdAt: originalAt } }, replies: [{ envelope: { messageId: 'original-research-report', threadId: work.origin.threadId,
      senderSessionId: b.sessionId, recipientSessionId: main.sessionId, body: threadLayout ? researchReply + '\n\n' + longReply : researchReply, createdAt: originalAt + 60000 } }], identityDiagnostics: [] }
  return {
    // Replay only the typed success/retention facts from the real consumer test.
    // Identities are rebound to this private capture's original target and request; no live owner is called.
    configureRetention(snapshot: MoteMainSetupResult) { retentionSnapshot = snapshot; setup = null },
    releaseSetup() { releaseSetup?.(); releaseSetup = null },
    retentionIssue: () => setup?.issue,
    setStartScene(mode: 'empty' | 'new' | 'history' | 'unknown' | 'policy', checkpoint: import('@agentmux/core/conversation').ConversationCheckpoint) {
      unknown = mode === 'unknown'
      const periods = [0, 1].map(index => ({ ...prior, sequence: index + 1, operationId: 'capture-history-' + index, roleRevision: 'capture-role-' + index,
        period: { id: 'capture-period-' + index, roleRevision: 'capture-role-' + index, reference: main,
          startedAt: originalAt - (2 - index) * 3600000, endedAt: originalAt - (1 - index) * 3600000,
          start: { kind: 'initial' as const, operationId: 'capture-begin-' + index }, end: { kind: 'manual-takeover' as const, operationId: 'capture-end-' + index },
          range: { kind: 'bounded' as const, after: checkpoint, through: checkpoint } } }))
      const empty = mode === 'empty' || mode === 'history'
      defaults = { executorId: 'fixture-original', presence: { enabled: true, intervalMs: 1800000 },
        ...(!empty ? { conversation: main, conversationRevision: 'original-role-A' } : {}) }
      page = { ...page, links: mode === 'history' || mode === 'new' ? periods.reverse() : [work],
        main: { ...page.main, current: empty ? null : main, roleRevision: empty ? 'legacy:' + document.revision : 'original-role-A' } }
      return { defaults, current: page.main.current, target, unknown }
    },
    replaceMain() { page = { ...page, links: threadLayout ? [alternateWork, work, prior] : [work, prior], main: { ...page.main, current: b, roleRevision: 'original-role-B' } } },
    unconfirm() { unknown = true },
    facts: () => ({ target, page, maintenance, defaults }),
    rpc(method: string, input: any) {
      if (method === 'space.mote.direct.list') return direct.list
      if (method === 'space.mote.direct.inspect') return direct.inspect(input.threadId)
      if (method === 'space.state') return { state: { graph: { resources: setup?.record ? { 'core:agent-open': { schema: 'agentmux.spatial-agent-open.v1', requests: { [setup.operationId]: setup.record } } } : {} } } }
      if (method === 'agent.open' && retentionSnapshot?.record) {
        const original = retentionSnapshot, record = original.record!, query = input.moteMain.deferredInput
        const replacement = new Map<string, string>([
          [original.operationId, input.operationId], [record.moteMain!.sourceOperationId, input.moteMain.sourceOperationId], [record.moteMain!.bindOperationId, input.moteMain.bindOperationId],
          [record.agentSessionId, main.sessionId], [record.execution.hostId, hostId], [record.executorId, input.content.executorId],
          ...(query ? [[record.moteMain!.deferredInput!.operationId, query.operationId], [record.moteMain!.deferredInput!.prompt, query.prompt], [original.deferredInput!.route!.key.expectedRun.runId, 'run-session-mote']] as [string, string][] : [])
        ])
        const rewrite = (value: any): any => typeof value === 'string' ? replacement.get(value) ?? value : Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, rewrite(value)])) : value
        setup = rewrite(original)
        setup!.operationId = input.operationId; setup!.ownerHostId = 'local'; setup!.reference = main
        setup!.record = { ...setup!.record!, requestId: input.operationId, moteMain: input.moteMain,
          address: { spaceId, zoneId, workspaceId: resource.workspaceId, displayWorkspaceId: main.displayWorkspaceId, groupId: main.groupId, tabId: main.tabId, regionId: main.regionId },
          execution: { hostId, workspaceId: resource.workspaceId, workspacePath: fixturePath('execution-original') } }
        defaults = moteMainBindingDefaults(setup!.record!)
        setup!.bindingObserved = { kind: 'preferences', source: { resource: file, documentRevision: document.revision, defaults } }
        if (setup!.deferredInput?.route) { setup!.deferredInput.route.identity = identity; setup!.deferredInput.route.reference = main; setup!.deferredInput.route.roleRevision = defaults.conversationRevision! }
        page = { ...page, main: { ...page.main, current: main, roleRevision: defaults.conversationRevision! } }
        return {}
      }
      if (setup && (method === 'space.mote.dialogue.setup.inspect' || method === 'space.mote.dialogue.setup.advance')) {
        if (input.creation.operationId !== setup.operationId) throw Error('Capture must inspect the same original setup operation')
        const reply = structuredClone(setup)
        if (method === 'space.mote.dialogue.setup.advance' && setup.record?.moteMain?.deferredInput && !releaseSetup) return new Promise(resolve => { releaseSetup = () => resolve(reply) })
        return reply
      }
      if (method === 'space.mote.dialogue.read') { if (unknown) throw Error('原主对话读取暂不可用；保留上次确认的角色、原工作与草稿。'); return structuredClone({ ...page, links: page.links.filter(link => !input.kind || link.kind === input.kind) }) }
      if (method === 'message.dispatch.read') {
        if (input.hostId !== hostId) throw Error('Wrong original work source')
        if (input.sourceMessageId === work.origin.messageId) return structuredClone(dispatch)
        if (threadLayout && input.sourceMessageId === alternateWork.origin.messageId) return {
          ...dispatch,
          dispatch: { ...dispatch.dispatch, sourceMessageId: alternateWork.origin.messageId, threadId: alternateWork.origin.threadId,
            events: [{ ...dispatch.dispatch.events[0]!, kind: 'question' }] },
          source: { envelope: { ...dispatch.source.envelope, ...alternateWork.origin, body: '核对不同执行者的原问题。' } },
          replies: [{ envelope: { ...dispatch.replies[0]!.envelope, messageId: 'original-review-question',
            threadId: alternateWork.origin.threadId, body: '是否保留这组原对照结果？' } }],
        }
        throw Error('Wrong original work source')
      }
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
