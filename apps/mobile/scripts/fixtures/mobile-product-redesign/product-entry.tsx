declare const __AGENTMUX_MOBILE_PROJECT_APPEARANCE__: { kind: string; icon: string | null }
declare const __AGENTMUX_MOBILE_PROVIDER_CATALOG__: ReturnType<AgentMuxHostedClient['catalog']>
import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentInputSubmissionReceipt, AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRpcResult, AgentMuxRpcGoal, AgentSessionHistoryReadInput, AgentSessionUserMessage } from '@agentmux/core'
import { conversationRevision, projectConversationTimeline, type AgentConversationReadPage } from '@agentmux/core/conversation'
import { normalizeSessionHistoryPage } from '../../../../../packages/core/src/session-history'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
import { MobileApp } from '../../../src/MobileApp'
import { MobileWebUpdateSafetyProvider } from '../../../src/mobile-web/update-safety'
import type { MobileWebPageObservation } from '../../../src/mobile-web/use-mobile-web-observation'
import { createBrowserPlatform } from '../../../src/platform/browser'
import { getDeviceWorkface } from '../../../src/recovery/device-workface'
import { DEFAULT_THEME_ID, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import '@agentmux/client-ui/styles.css'

type Call = { sequence: number; observedAt: number; method: string; params: unknown }
const calls: Call[] = []
const record = (method: string, params: unknown = {}) => calls.push({ sequence: calls.length + 1, observedAt: Date.now(), method, params: structuredClone(params) })
const original = (id: string): AgentMuxAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'fixture-original',
  hostId: 'host-original', workspacePath: fixturePath("execution-original"), run: { runId: `run-${id}` }, retiredRuns: [], createdAt: 1, updatedAt: 1 })
const main = original('session-mote'), waiting = original('session-waiting'), result = original('session-result')
const ordinaryReply = '可以。我们先确认你想解决的问题，再比较这两种想法。\n\n我会保留原材料、已经确认的进展和还需要你决定的地方；不会把未知回执当作完成。'
waiting.pendingInteraction = { request: { kind: 'permission', id: 'request-original', agentSessionId: waiting.agentSessionId,
  title: '请确认本次资料读取', evidence: { source: 'native-hook', observedAt: 1, run: waiting.run },
  permissionHook: { receiptId: 'request-original' },
  options: [{ id: 'allow-original', label: '允许本次读取', kind: 'allow-once' }, { id: 'deny-original', label: '拒绝本次读取', kind: 'reject-once' }] } }
const sessions = [main, waiting, result]
const category = { categoryId: 'category-original', title: '产品与研究', hostId: 'host-original', spaceId: 'category-space', directoryPath: fixturePath('category'), revision: 'category-revision' }
const topic = { topicId: 'topic-original', title: '让小实验更容易开始', summary: '保留依据，把讨论变成可以验证的一步。', hostId: 'host-original', zoneId: 'zone-other', directoryPath: fixturePath('other'), categorySpaceIds: ['category-space'], chatIds: ['tab-result'], spatialRevision: 1 }
const knowledge = { topicId: topic.topicId, entryId: '11111111-1111-4111-8111-111111111111', title: '第一周的实验依据', content: '# 从一个小实验开始\n\n先验证最不确定的假设，再扩大范围。\n\n- 保留原始材料和反例。\n- 用一次实际观察决定下一步。', form: 'reference', certainty: 'fact', revision: 'sha256:' + 'd'.repeat(64), updatedAt: 1,
  sources: [{ kind: 'survey', zoneId: 'zone-other', tabId: 'tab-result', regionId: 'region-result' }] }
// Same SID occurs first outside the Mote and then at its intended original Mote location.
const catalog = {
  spaces: [{ spaceId: 'other-space', kind: 'folder', name: '并行项目', hostId: 'host-original', directoryPath: fixturePath("other"), projectId: null },
    { spaceId: 'mote-original', kind: 'mote', topicId: PMO_TEAMS_TOPIC_ID, name: '我的 Mote', hostId: 'host-original', directoryPath: fixturePath("mote-original"), projectId: null }],
  zones: [{ zoneId: 'zone-other', workspaceId: 'workspace-original', kind: 'directory', hostId: 'host-original', directoryPath: fixturePath("other"), branch: null },
    { zoneId: 'zone-mote', workspaceId: 'workspace-original', kind: 'directory', hostId: 'host-original', directoryPath: fixturePath("mote-original"), branch: null }],
  tabs: [{ tabId: 'tab-other', zoneId: 'zone-other', workspaceId: 'workspace-original', name: '另一个展示', regionIds: ['region-other'] },
    { tabId: 'tab-mote', zoneId: 'zone-mote', workspaceId: 'workspace-original', name: '日常协作', regionIds: ['region-mote', 'region-waiting'] },
    { tabId: 'tab-result', zoneId: 'zone-other', workspaceId: 'workspace-original', name: '结果', regionIds: ['region-result'] }],
  regions: [{ regionId: 'region-other', tabId: 'tab-other', kind: 'agent', agentSessionId: main.agentSessionId, runId: main.run.runId, execution: { hostId: 'host-original', cwd: fixturePath("execution-original") } },
    { regionId: 'region-mote', tabId: 'tab-mote', kind: 'agent', agentSessionId: main.agentSessionId, runId: main.run.runId, execution: { hostId: 'host-original', cwd: fixturePath("execution-original") } },
    { regionId: 'region-waiting', tabId: 'tab-mote', kind: 'agent', agentSessionId: waiting.agentSessionId, runId: waiting.run.runId, execution: { hostId: 'host-original', cwd: fixturePath("execution-original") } },
    { regionId: 'region-result', tabId: 'tab-result', kind: 'agent', agentSessionId: result.agentSessionId, runId: result.run.runId, execution: { hostId: 'host-original', cwd: fixturePath("execution-original") } }],
  bindings: [{ spaceId: 'other-space', zoneId: 'zone-other' }, { spaceId: 'mote-original', zoneId: 'zone-mote' }],
  locations: [{ spaceId: 'other-space', zoneId: 'zone-other', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-other', tabId: 'tab-other', regionId: 'region-other' },
    { spaceId: 'mote-original', zoneId: 'zone-mote', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' },
    { spaceId: 'mote-original', zoneId: 'zone-mote', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-waiting' },
    { spaceId: 'other-space', zoneId: 'zone-other', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-other', tabId: 'tab-result', regionId: 'region-result' }],
  agentPresentation: [{ agentSessionId: main.agentSessionId, name: '日常协作', project: '我的 Mote', group: 'working', state: 'working', stateMark: 'working', stateLabel: '执行中', projectGroup: { key: 'original-mote-project', projectId: 'mote-project', hostId: 'local', name: '我的 Mote', spaceId: 'mote-original' }, detail: '正在整理你的想法', providerId: 'codex', recap: { text: '先保留原始材料，再比较两个方案。', source: 'native-hook' } },
    { agentSessionId: waiting.agentSessionId, name: '资料整理', project: '我的 Mote', group: 'attention', state: 'waiting', detail: '等待本次权限回应', providerId: 'codex', recap: { text: '请确认这次资料读取；其他工作继续。', source: 'native-hook' } },
    { agentSessionId: result.agentSessionId, name: '实验建议', project: '并行项目', group: 'results', state: 'done', stateMark: 'results', stateLabel: '已完成', projectGroup: { key: 'original-parallel-project', projectId: 'parallel-project', hostId: 'local', name: '并行项目', spaceId: 'space-original' }, detail: '有新结果', providerId: 'codex', recap: { text: '已形成一份可直接阅读的建议，等待你决定下一步。', source: 'native-hook' } }],
  appearance: [{ spaceId: 'mote-original', preset: 'primary-mote', expression: 'thinking' }],
  motePresentation: [{ spaceId: 'mote-original', content: { zoneId: 'zone-mote', hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original") },
    quickMode: { status: 'saved', version: 'sha256:' + 'b'.repeat(64), defaults: { executorId: 'fixture-original', recovery: 'on-open', conversation: {
      hostId: 'host-original', sessionId: main.agentSessionId, displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' } } },
    conversation: { hostId: 'host-original', sessionId: main.agentSessionId, displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' } }],
  survey: { items: [{ zoneId: 'zone-other', name: '本周实验资料' }], selection: null }
} as AgentMuxRpcResult<'space.ls'>['catalog']
// A file-only Mote stays a Profile/Agents view; its full resources remain in Space.
const resourceNames = ['BEHAVIOR.md', 'SOUL.md', 'MEMORY.md', '一份保留完整来源的协作资料说明.md']
catalog.spaces.push({ spaceId: 'mote-resources', kind: 'mote', name: '资料协作', hostId: 'host-original', directoryPath: fixturePath('mote-resources'), projectId: null })
catalog.zones.push({ zoneId: 'zone-resources', workspaceId: 'workspace-original', kind: 'home', hostId: 'host-original', directoryPath: fixturePath('mote-resources'), branch: null })
catalog.bindings.push({ spaceId: 'mote-resources', zoneId: 'zone-resources' })
catalog.spaces.push({ spaceId: 'space-resources', kind: 'folder', name: '资料工作区', hostId: 'host-original', directoryPath: fixturePath('mote-resources'), projectId: null })
catalog.bindings.push({ spaceId: 'space-resources', zoneId: 'zone-resources' })
catalog.motePresentation!.push({ spaceId: 'mote-resources', content: { zoneId: 'zone-resources', hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath('mote-resources') }, quickMode: { status: 'missing' }, conversation: null })
for (const [index, name] of ['', ...resourceNames].entries()) {
  const tabId = `resource-tab-${index}`, regionId = `resource-region-${index}`
  catalog.tabs.push({ tabId, zoneId: 'zone-resources', workspaceId: 'workspace-original', name: '', regionIds: [regionId] })
  catalog.regions.push(index === 0 ? { tabId, regionId, kind: 'launcher' } : { tabId, regionId, kind: 'file', file: { workspaceId: 'workspace-original', path: name } })
}
const claude = { ...original('session-claude'), providerId: 'claude', executorId: 'fixture-claude' }
sessions.push(claude)
catalog.agentPresentation![1]!.avatar = { tint: '#6d9ee7', badge: 'shield' }
catalog.agentPresentation!.push({ ...catalog.agentPresentation![2]!, agentSessionId: claude.agentSessionId, name: '视觉方向评审', providerId: 'claude', avatar: { tint: '#ae55e8', badge: 'spark' }, recap: { text: '保留原身份图和颜色，核对手机上的实际观感。', source: 'native-hook' } })
const goal: AgentMuxRpcGoal = { id: 'goal-original', title: '把两个想法变成一个小实验', description: '比较已有资料，选择本周可以开始的方向。', status: 'in_progress', priority: 'normal', projectId: null,
  sessionIds: [main.agentSessionId, result.agentSessionId], source: 'session', activityLog: [], createdAt: 1, updatedAt: 2,
  alignment: { revision: 1, summary: '给出小步可验证的建议，保留两种方案的依据。', criteria: [{ id: 'criterion-original', text: '形成可开始的实验步骤' }], openQuestions: [], confirmedAt: 1 },
  grounding: { alignmentRevision: 1, submissionId: 'result-original', summary: '建议先做范围更清晰的方案 A；以下是依据和第一步。', acceptedAt: null,
    checks: [{ criterionId: 'criterion-original', outcome: 'met', note: '已整理步骤、比较依据与需要你决定的地方。', evidence: ['原资料/实验建议.md'] }] } }
let connected = location.hash !== '#fixture-offline', unknownNext = false, promptReadFails = false, appearanceRevision = 0
let holdFileUpload = false
let releaseFileUpload: (() => void) | null = null
let directoryComparisons = 0, inspectFails = false
let agentMenuScene = false, densityScene = false, copyFails = false
const copiedTexts: string[] = []
const menuAgentName = '讨论布局与原始资料核对的协作 Agent'
let inspectRelease: (() => void) | null = null, inspectWait: Promise<void> | null = null
let appearanceSubscriber: { onEvent(event: { type: 'snapshot'; data: unknown }): void } | null = null
const appearanceSnapshot = (appAppearance: 'dark' | 'light') => ({
  sourceId: 'fixture-host', revision: ++appearanceRevision, issues: [],
  values: { themeId: DEFAULT_THEME_ID, theme: themeValue(GRAPHITE_THEME), appAppearance, terminalTheme: 'workspace' as const }
})
const submittedBySession = new Map<string, Array<{ id: string; text: string }>>()
const listeners = new Set<(event: AgentMuxClientEvent) => void>()
const client = {
  agentSession: (id: string) => { record('sdk.agentSession', { id }); const found = sessions.find(session => session.agentSessionId === id); if (!found) throw Error('Unknown original fixture Session'); return found },
  agentSessions: () => { record('sdk.agentSessions'); return structuredClone(sessions) },
  catalog: () => { record('sdk.catalog'); return __AGENTMUX_MOBILE_PROVIDER_CATALOG__ },
  onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); record('sdk.onEvent'); return () => { listeners.delete(listener); record('sdk.releaseEvent') } },
  runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original', availability: connected ? 'connected' : 'disconnected' }),
  statusAgent: async (id: string) => {
    if (!densityScene) throw Error('Run status is not observed by this metadata fixture')
    record('sdk.statusAgent', { id })
    const session = sessions.find(value => value.agentSessionId === id)
    if (!session) throw Error('Unknown original fixture Session')
    return { session, run: { ...session.run, state: 'running' }, observation: { process: 'running', semantic: 'active', readiness: 'ready', source: 'native-hook', observedAt: Date.now(), stale: false } }
  },
  ensureAgentContinuity: async (input: { agentSessionId: string; expectedRun: { runId: string }; operationId: string; trigger: string }) => {
    record('sdk.ensureAgentContinuity', input)
    return { kind: 'reattachable', agentSessionId: input.agentSessionId, previousRun: input.expectedRun }
  },
  sessionHistoryPage: async (id: string) => { record('sdk.sessionHistoryPage', { id }); return { agentSessionId: id, source: { providerId: densityScene ? main.providerId : 'codex', nativeSessionId: `native-${id}${agentMenuScene ? '-original-source-reference'.repeat(6) : ''}` }, nextCursor: null,
    items: [...(agentMenuScene && id === main.agentSessionId ? [
      { id: `${id}-user-short`, kind: 'user-message' as const, startedAt: _tailRefreshFixtureEpoch(0, 1), contentParts: [{ kind: 'text' as const, text: '可以，继续。' }] }
    ] : []), { id: `${id}-user-original`, kind: 'user-message', ...(agentMenuScene ? { startedAt: _tailRefreshFixtureEpoch(0, 2) } : {}), contentParts: [{ kind: 'text', text: agentMenuScene
      ? '这两个想法，先从哪一个做成小实验比较好？请保留原来的依据。手机里的消息头应该紧凑对齐，长内容完整可读，复制和详情都能直接操作。'
      : '这两个想法，先从哪一个做成小实验比较好？请保留原来的依据。' }] },
      { id: `${id}-answer-original`, kind: 'assistant-message', ...(densityScene ? { messagePhase: 'final' as const } : {}), ...(agentMenuScene ? { startedAt: _tailRefreshFixtureEpoch(0, 3) } : {}), contentParts: [{ kind: 'text', text: id === result.agentSessionId ? '我建议先试方案 A。它的范围更清晰，一天就能取得第一批反馈。\n\n1. 保留现有资料和两种方案。\n2. 选三个最关键的问题。\n3. 先观察真实反馈，再决定是否继续。\n\n方案 B 仍有价值，原依据已经保留。' : ordinaryReply }] },
      ...(densityScene && id === main.agentSessionId ? [
        { id: `${id}-progress`, kind: 'assistant-message' as const, messagePhase: 'progress' as const, startedAt: _tailRefreshFixtureEpoch(0, 4), contentParts: [{ kind: 'text' as const, text: '正在核对原材料与工具布局，完整进度保留。' }] },
        { id: `${id}-report`, kind: 'activity' as const, startedAt: _tailRefreshFixtureEpoch(0, 5), collaboration: { kind: 'message' as const,
          source: { providerId: main.providerId, nativeSessionId: 'native-' + id + '-original-source-reference'.repeat(6) }, sender: '/root/review/layout', recipient: '/root' },
          contentParts: [{ kind: 'text' as const, text: 'Native envelope\n\n**检查完成**，原生回报与完整来源保留。', readingRange: { start: 17, end: 'Native envelope\n\n**检查完成**，原生回报与完整来源保留。'.length }, contentEligibility: 'public' as const }] }
      ] : []),
      ...(submittedBySession.get(id) ?? []).map(item => ({ id: item.id, kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text: item.text }] }))] } },
  readAgentInputMailbox: async (input: { agentSessionId: string; maxBytes?: number }) => ({
    agentSessionId: input.agentSessionId, queueId: 'controlled-original-journal',
    cut: { incarnation: 'controlled-original-journal', throughSequence: 0 }, budgetBytes: input.maxBytes ?? 128 * 1024,
    items: [], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' }
  }),
  readAgentSessionHistory: async (input: AgentSessionHistoryReadInput) => {
    record('sdk.readAgentSessionHistory', input)
    if (input.hostId !== 'local' || !sessions.some(session => session.agentSessionId === input.agentSessionId)) throw Error('Wrong exact original history target')
    const text = input.cursor ? '更早的实验依据：先比较三份样本，再决定是否继续。' : input.source === 'native'
      ? '这两个想法，先从哪一个做成小实验比较好？请保留原来的依据。' : '把测试步骤写成三点，保留原始资料和判断依据。'
    const id = input.cursor ? 'older-input' : input.source === 'native' ? input.agentSessionId + '-user-original' : 'captured-input'
    const message: AgentSessionUserMessage = { id: input.source === 'native' ? 'native:codex:native-' + input.agentSessionId + ':' + id : 'captured:' + id,
      rawId: id, agentSessionId: input.agentSessionId,
      source: input.source === 'native' ? { kind: 'native', providerId: 'codex', nativeSessionId: 'native-' + input.agentSessionId, recordId: id }
        : { kind: 'captured', submissionId: id, channel: 'message-tool', device: { hostId: 'sender-original', deviceId: 'phone-original', name: '我的手机' } },
      author: input.source === 'native' ? { kind: 'unknown' } : { kind: 'human' }, content: text, contentParts: [{ kind: 'text', text }],
      ...(input.source === 'captured' ? { recordedAt: _tailRefreshFixtureEpoch(0, 1), deliveryStatus: 'complete' } : {}) }
    const messages = input.query && !text.includes(input.query) ? [] : [message]
    const nextCursor = input.source === 'native' && input.query === '实验依据' && !input.cursor ? 'original-native-older' : null
    return { hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.source, revision: 'a'.repeat(64), availability: messages.length ? 'available' : 'empty',
      order: 'newest-first', items: [], nextCursor, budgetBytes: input.maxBytes ?? 128 * 1024,
      kind: 'user-message', userMessages: messages, scan: { examined: input.cursor ? 32 : 200, complete: nextCursor === null },
      ...(input.source === 'native' ? { nativeSource: { providerId: 'codex', nativeSessionId: 'native-' + input.agentSessionId } } : {}) }
  },
  sessionTimeline: async (id: string) => { record('sdk.sessionTimeline', { id }); return { agentSessionId: id, revision: 1, items: [] } },
  observeSessionHistory: async (id: string) => { record('sdk.observeSessionHistory', { id }); return { source: { providerId: 'codex', nativeSessionId: `native-${id}` }, dispose() { record('sdk.releaseHistory', { id }) } } },
  readAgentConversation: async (input: Parameters<AgentMuxHostedClient['readAgentConversation']>[0]) => {
    const sourceHostId = sessions.find(session => session.agentSessionId === input.agentSessionId)?.hostId ?? 'host-original'
    const rawHistory = await client.sessionHistoryPage(input.agentSessionId)
    const historyPage = densityScene ? { ...rawHistory, ...normalizeSessionHistoryPage(rawHistory.source, rawHistory, 100) } : rawHistory
    const captured = await client.sessionTimeline(input.agentSessionId)
    const timeline = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: sourceHostId,
      historyPage: { ...historyPage, sourceHostId }, timeline: { ...captured, sourceHostId,
        stream: { epoch: 'original-mobile-stream', sequence: captured.items.length, revision: 1, origin: 'beginning', gaps: [], positions: [] } } })
    const reference = { hostId: input.hostId, agentSessionId: input.agentSessionId }
    const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: timeline.scope, cuts: [] } }
    return { ...reference, sourceHostId, scope: timeline.scope, coverage: timeline.coverage,
      order: { ...timeline.order, direction: 'newest-first' }, budgetBytes: input.maxBytes ?? 128 * 1024, nextCursor: null,
      items: [...timeline.events].reverse().map(event => ({ kind: 'item', item: { event,
        records: timeline.records.filter(recordEntry => event.recordIds.includes(recordEntry.id)) } })),
      window: { id: 'original-mobile-window', revision: 1, itemCount: timeline.events.length, complete: true,
        view: 'original-mobile-view', replay: 'original-mobile-replay-1', checkpoint,
        outside: { older: null, newer: null }, navigation: { older: null, newer: null } } } satisfies AgentConversationReadPage
  },
  readConversationChanges: async (input: Parameters<AgentMuxHostedClient['readConversationChanges']>[0]) => ({ ...await client.readAgentConversation(input), checkpoint: input.checkpoint, more: false }),
  observeConversation: async (input: Parameters<AgentMuxHostedClient['observeConversation']>[0]) => {
    const frame = await client.readAgentConversation(input)
    return { hostId: frame.hostId, sourceHostId: frame.sourceHostId, agentSessionId: frame.agentSessionId,
      scope: frame.scope, coverage: frame.coverage, closed: new AbortController().signal, dispose() {} }
  },
  releaseConversationView: async () => ({}),
  inspectAgentInput: async (params: unknown) => { record('sdk.inspectAgentInput', params); return null },
  subscribeRpc: async (_method: string, _params: unknown, handlers: { onInitial(value: { observation: unknown }): void; onEvent(event: { type: 'snapshot'; data: unknown }): void }) => {
    appearanceSubscriber = handlers
    handlers.onInitial({ observation: appearanceSnapshot('dark') })
    return { subscriptionId: 'fixture-appearance', dispose: async () => { if (appearanceSubscriber === handlers) appearanceSubscriber = null } }
  },
  submitAgentPrompt: async (params: Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0]): Promise<AgentInputSubmissionReceipt | void> => {
    record('sdk.submitAgentPrompt', params)
    if (unknownNext) {
      unknownNext = false
      throw Error('原 Host 已受理输入，但确认回执在返回途中断开。当前结果未知；保留原 operation、Session、Run 和正文，显式核对原请求后再决定是否重试。此处不会自动重发，后来补充的草稿也保留。')
    }
    if ('admissionIntent' in params && params.admissionIntent?.kind === 'manual-actor' && params.operationId) {
      const list = submittedBySession.get(params.agentSessionId) ?? []
      list.push({ id: `submitted-${params.operationId}`, text: params.prompt })
      submittedBySession.set(params.agentSessionId, list)
      const key = { kind: 'prompt' as const, agentSessionId: params.agentSessionId, expectedRun: params.expectedRun, submissionId: params.operationId }
      const ref = { key, waitGeneration: 1 }, gateId = 'controlled-gate-' + params.operationId
      return { key, ref, persistence: 'confirmed', status: 'terminal-confirmed', observation: 'closed',
        control: { ref, state: 'dispatch-authorized', gateId, at: _tailRefreshFixtureEpoch(0, 1) },
        admission: { agentSessionId: params.agentSessionId, run: params.expectedRun, admission: { inputKey: key, inputDispatch: { ref, gateId },
          submissionId: params.operationId, operationId: params.operationId, transport: 'pty', startByte: 0,
          endByte: new TextEncoder().encode(params.prompt + '\r').byteLength, acknowledged: true,
          intent: { run: params.expectedRun, ownerInstanceId: 'controlled-original-owner', prompt: params.prompt, execution: 'immediate',
            admissionIntent: { kind: 'manual-actor', expectedRun: params.expectedRun }, plan: { kind: 'single-phase', data: params.prompt + '\r' },
            message: { userContent: params.prompt, authorHuman: true } } } } }
    }
  },
  respondAgentInteraction: async (params: Parameters<AgentMuxHostedClient['respondAgentInteraction']>[0]) => {
    record('sdk.respondAgentInteraction', params)
    return { agentSessionId: params.agentSessionId, operationId: params.operationId, run: params.expectedRun,
      expectedRequest: params.expectedRequest, response: params.response, delivery: 'connection-written' as const }
  },
  forwardRpc: async (method: string, params: Record<string, unknown>) => {
    record(method, params)
    if (!connected) throw Error('原 Host 连接中断；原对象、历史与草稿保留。')
    if (method === 'file.upload' && holdFileUpload) return await new Promise(resolve => {
      releaseFileUpload = () => { const { dataBase64: _data, ...identity } = params; resolve({ ...identity, status: 'uploaded', path: '/opaque/原资料截图.png' }) }
    })
    if (method === 'skill.ls') {
      const original = sessions.find(session => session.agentSessionId === params.agentSessionId)!
      return { hostId: 'local', sourceHostId: original.hostId, agentSessionId: original.agentSessionId, providerId: original.providerId,
        workspacePath: original.workspacePath, skills: [{ name: 'review-evidence', description: '核对原始资料与实验依据', path: fixturePath('skills/review-evidence/SKILL.md'), source: 'project' }] }
    }
    if (method === 'settings.prompts.ls' && promptReadFails) throw Error('原自定义 Commands 读取失败；原命令与草稿保留。')
    if (method === 'settings.prompts.ls') return { operation: 'settings.resource.list', resource: 'prompts', partial: true, items: [
      { id: 'original-review', value: { keyword: 'compact', label: '核对依据', body: '逐项核对原始依据，保留未知与引用。' } },
      { id: 'original-codex', value: { keyword: 'review', label: '检查当前修改', body: '检查原修改并给出证据。', providerId: 'codex' } },
      { id: 'another-provider', value: { keyword: 'private', label: '另一 Provider 专用', body: '不展示给原 Agent', providerId: 'claude' } }
    ] }
    if (method === 'settings.executors.ls') return { items: [{ id: 'fixture-original', value: { name: 'Codex' } }], partial: true }
    if (method === 'space.inspect' && (params.target as { spaceId?: string }).spaceId === 'space-original') return { catalog: { ...catalog, appearance: [...catalog.appearance!, { spaceId: 'space-original', preset: __AGENTMUX_MOBILE_PROJECT_APPEARANCE__.kind, image: { dataUrl: __AGENTMUX_MOBILE_PROJECT_APPEARANCE__.icon } }] } }
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: { ...catalog } }
    if (method === 'app.snapshot') return { agents: [], projects: [], executors: [], workspaces: [], unavailable: [] }
    if (method === 'agent.inspect') {
      if (inspectWait) await inspectWait
      if (inspectFails) throw Error('原生消耗读取暂不可用，原会话仍可使用。')
      return { routeHostId: 'host-original', session: sessions.find(session => session.agentSessionId === (params.target as { agentSessionId: string }).agentSessionId), displayName: { override: '原 Agent', availability: 'observed' } }
    }
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal, goalContinuations: [] }
    if (method === 'goal.decisions') return { decisions: [] }
    if (method === 'file.read') {
      if (params.zoneId !== 'zone-mote' || params.spaceId !== 'mote-original'
        || JSON.stringify(params.expectedResource) !== JSON.stringify({ hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original") })) throw Error('Wrong original Mote file scope')
      return { resource: { hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original"), zoneId: 'zone-mote', zonePath: fixturePath("mote-original"), path: params.path },
        result: { status: 'read', document: { path: params.path, revision: 'sha256:' + 'c'.repeat(64),
          content: '# 合作方式\n\n我们围绕你的原始目标继续讨论，先把事实和未知分清，再选本周能验证的一小步。\n\n- 保留原对象、历史和草稿。\n- 需要你回应时说明具体决定。\n- 结果可阅读、可追溯，再由你决定是否接受。' } } }
    }
    if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect') return { topic, unavailable: [] }
    if (method === 'topic.knowledge.ls' || method === 'topic.knowledge.search') return { entries: [knowledge], unavailable: [] }
    if (method === 'topic.knowledge.read') return { entry: knowledge }
    if (method === 'message.delivery.report') return { stored: true }
    throw Error('Unsupported controlled public method: ' + method)
  }
} as unknown as AgentMuxHostedClient
if (!localStorage.getItem('mobile-product-fixture-initialized')) {
  localStorage.setItem('agentmux-mobile-home', 'mote')
  getDeviceWorkface().confirmHost({ origin: 'http://127.0.0.1', hostId: 'relay-original' })
  localStorage.setItem('mobile-product-fixture-initialized', 'true')
}
const browserPlatform = createBrowserPlatform()
const platform = { ...browserPlatform, copyText: async (text: string, reportError: (error: unknown) => void) => {
  if (!agentMenuScene) return browserPlatform.copyText(text, reportError)
  record('fixture.copy', { text })
  if (copyFails) { reportError(new Error('原复制回执未确认，原正文保留，可直接重试。')); return false }
  copiedTexts.push(text)
  return true
} }
// Exact controlled page and Host observations exercise the real update UI; they are not live Relay evidence.
const updatePage = { documentId: 'fixture-original-page', buildId: 'fixture-old-build', namespaceDigest: 'sha256:' + 'a'.repeat(64) }
const updateProducer = { devicePrincipalId: 'fixture-original-device', documentId: updatePage.documentId }
const updateLoaded = { ...updatePage, hostId: 'fixture-original-host', hostInstanceId: 'fixture-host-instance', producer: updateProducer,
  occurrenceId: 'fixture-loaded-occurrence', observedAt: 100, receivedAt: 200, accepted: true, reason: null }
const webUpdateObservation: MobileWebPageObservation = { page: updatePage, connected: true,
  loaded: { pending: false, result: updateLoaded, issue: null }, inspection: { pending: false, issue: null,
    result: { hostId: updateLoaded.hostId, hostInstanceId: updateLoaded.hostInstanceId,
      active: { buildId: 'fixture-new-build', digest: 'sha256:' + 'b'.repeat(64), bytes: 100, fileCount: 2, revision: 2 },
      retained: [], retention: 'active-and-previous', operation: null, clients: [updateLoaded],
      client: { target: updateProducer, availability: 'found', loaded: updateLoaded, namespace: 'retained' },
      coverage: { lifetime: 'current-host-instance', operationsRetained: 0, operationsEvicted: 0, loadedRetained: 1, loadedRejected: 0 }, observedAt: 300 } },
  reporter: { inFlight: false, queuedCount: 0, queuedBytes: 0, droppedCount: 0, receipt: null, issue: null },
  refresh: async () => { record('fixture.mobile-assets.inspect') }, retryReports: () => {} }
const verifyWebUpdateConnection = async () => () => connected
function Scene() {
  const [, refresh] = useState(0)
  const [densityMount, remountDensity] = useState(0)
  const [unconfirmedClient, setUnconfirmedClient] = useState(false)
  const [webUpdateScene, setWebUpdateScene] = useState(false)
  Object.assign(window, { mobileProductScene: {
    prepareWebUpdate: () => setWebUpdateScene(true),
    prepareFocusState: () => {
      catalog.agentPresentation![1]!.stateMark = 'unknown'
      catalog.agentPresentation![1]!.stateLabel = 'Activity not confirmed'
    },
    prepareAgentMenu: () => { agentMenuScene = true; catalog.agentPresentation![0]!.name = menuAgentName },
    prepareDensity: () => {
      densityScene = true; agentMenuScene = true
      const provider = __AGENTMUX_MOBILE_PROVIDER_CATALOG__.find(value => value.postureControl)
      if (!provider) throw Error('Original Provider catalog with posture control is required')
      main.providerId = provider.id
      main.semanticStatus = { state: 'working', source: 'native-hook', observedAt: Date.now() }
      catalog.agentPresentation![0]!.name = menuAgentName
      catalog.agentPresentation![0]!.providerId = provider.id
    },
    seedDensityRetainedUpload: async () => {
      const upload = { runtimeId: 'runtime-original', identity: { hostId: main.hostId, agentSessionId: main.agentSessionId,
        expectedRun: main.run, operationId: 'original-unknown-density-upload', name: '原资料截图.png', mimeType: 'image/png', byteLength: 128, revision: 'sha256:' + 'a'.repeat(64) },
        phase: 'unknown' as const, issue: '原上传回执未确认，原文件与正文保留。\n原 Host 是否保存尚未确认；请核对同一操作，不会自动重传。[UPLOAD_RESULT_UNKNOWN]' }
      await getDeviceWorkface().retainFileUpload(upload)
      remountDensity(value => value + 1)
      return upload
    },
    setCopyFailure: (value: boolean) => { copyFails = value },
    seedMenuDirectory: (count: number) => {
      main.turnUsage = { inputTokens: 12500, outputTokens: 4200, totalTokens: 16700, observedAt: 1, scope: 'response',
        context: { usedTokens: 52700, capacityTokens: 200000 }, cumulative: { scope: 'native-session', inputTokens: 178000, outputTokens: 42000, totalTokens: 220000 } }
      const populated = sessions.filter(session => session.agentSessionId.startsWith('population-agent-')).length
      for (let index = populated; index < count; index++) {
        const id = 'population-agent-' + index, owner = 'population-mote-' + Math.floor(index / 5), zone = owner + '-zone', tab = owner + '-tab', region = id + '-region'
        const value = original(id); sessions.push(value)
        if (index % 5 === 0) {
          const mote = Math.floor(index / 5) % 2 === 0
          catalog.spaces.push({ spaceId: owner, name: '协作项目 ' + Math.floor(index / 5), kind: mote ? 'mote' : 'folder', hostId: 'host-original', directoryPath: fixturePath(owner), projectId: null })
          catalog.zones.push({ zoneId: zone, workspaceId: 'workspace-original', kind: 'directory', hostId: 'host-original', directoryPath: fixturePath(owner), branch: null })
          catalog.bindings.push({ spaceId: owner, zoneId: zone })
          catalog.tabs.push({ tabId: tab, zoneId: zone, workspaceId: 'workspace-original', name: '原讨论', regionIds: [] })
          if (mote) {
            catalog.appearance!.push({ spaceId: owner, preset: 'primary-mote' })
            catalog.motePresentation!.push({ spaceId: owner, content: null, quickMode: { status: 'missing' }, conversation: null })
          }
        }
        catalog.tabs.find(value => value.tabId === tab)!.regionIds.push(region)
        catalog.regions.push({ regionId: region, tabId: tab, kind: 'agent', agentSessionId: id, runId: value.run.runId, execution: { hostId: 'host-original', cwd: fixturePath(owner) } })
        catalog.locations.push({ spaceId: owner, zoneId: zone, workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-' + owner, tabId: tab, regionId: region })
        catalog.agentPresentation!.push({ agentSessionId: id, name: '资料协作 ' + index, project: '协作项目 ' + Math.floor(index / 5), group: 'working', state: 'working', providerId: 'codex', detail: '保持原协作记录', projectGroup: { key: owner, name: '协作项目 ' + Math.floor(index / 5), spaceId: owner, projectId: owner, hostId: 'local' } })
      }
      // Count actual predicate work without changing Array.some semantics or the production source.
      const some = Array.prototype.some
      Object.defineProperty(catalog.regions, 'some', { configurable: true, value: function(predicate: (value: unknown, index: number, source: unknown[]) => unknown, receiver?: unknown) {
        return some.call(this, (value: unknown, index: number, source: unknown[]) => { directoryComparisons++; return predicate.call(receiver, value, index, source) })
      } })
    },
    resetDirectoryWork: () => { directoryComparisons = 0 },
    holdInspection: () => { inspectWait = new Promise<void>(resolve => { inspectRelease = resolve }) },
    releaseInspection: () => { inspectRelease?.(); inspectWait = null; inspectRelease = null },
    failInspection: (value: boolean) => { inspectFails = value },
    unconfirmMoteBindings: () => {
      const tab = catalog.tabs.find(tab => tab.tabId === 'tab-mote')!
      tab.issue = 'The original Agent binding is unconfirmed; its saved workface is preserved.'
      for (const region of catalog.regions) if (region.tabId === tab.tabId && region.kind === 'agent') region.agentSessionId = null
      catalog.motePresentation!.find(value => value.spaceId === 'mote-original')!.conversation = null
    },
    setPromptReadFailure: (fail: boolean) => { promptReadFails = fail },
    seedSpatialRecovery: async () => {
      const owner = getDeviceWorkface(), runtimeId = client.runtimeOwnerIdentity!()!.runtimeId!, deviceHostId = owner.snapshot().record.host?.hostId ?? null
      for (const [operationId, destination] of [
        ['retained-new-tab', { spaceId: 'mote-resources', zoneId: 'zone-resources', newTab: true }],
        ['retained-launcher', { spaceId: 'mote-resources', zoneId: 'zone-resources', tabId: 'resource-tab-0', regionId: 'resource-region-0' }]
      ] as const) await owner.retainAgentCreate({ runtimeId, deviceHostId,
        input: { operationId, content: { kind: 'new-agent', executorId: 'fixture-original', prompt: '保留原意图，不自动重放。' }, destination, focus: false }, phase: 'unknown' }, owner.recordIdentity())
    },
    seedGoalRecovery: async () => {
      const owner = getDeviceWorkface()
      const item = { runtimeId: 'runtime-original', ownerInstanceId: 'owner-original', deviceHostId: 'host-original', origin: location.origin,
        method: 'goal.delete' as const, request: { goalId: '原目标-已删除', operationId: 'original-goal-operation', confirmation: 'delete' } }
      await owner.retainGoalRequest(item, owner.recordIdentity())
      return item
    },
    holdGoalRecoveryWrite: async () => {
      const saved = await getDeviceWorkface().preparePageReload()
      if (!saved()) throw Error('The original workface must be stable before the controlled write failure')
      const original = indexedDB.open.bind(indexedDB)
      let held = false
      indexedDB.open = ((name: string, version?: number) => {
        if (name !== 'agentmux-device-workface-write-lock' || held) return original(name, version)
        held = true
        return {} as IDBOpenDBRequest
      }) as typeof indexedDB.open
    },
    unknownNext: () => { unknownNext = true },
    setAppearance: (mode: 'dark' | 'light') => { appearanceSubscriber?.onEvent({ type: 'snapshot', data: appearanceSnapshot(mode) }) },
    offline: () => { connected = false; refresh(value => value + 1) },
    reconnect: () => { connected = true; refresh(value => value + 1) },
    setUnconfirmedClient: (value: boolean) => { connected = !value; setUnconfirmedClient(value) },
    holdFileUpload: () => { holdFileUpload = true },
    releaseFileUpload: () => { releaseFileUpload?.() },
    appearanceReady: () => Boolean(appearanceSubscriber),
    facts: () => ({ calls, record: getDeviceWorkface().snapshot().record, directoryComparisons, directoryFacts: catalog.regions.length + catalog.locations.length + catalog.spaces.length,
      directoryScope: { sessions: sessions.length, regions: catalog.regions.length, locations: catalog.locations.length, spaces: catalog.spaces.length, motes: catalog.spaces.filter(owner => owner.kind === 'mote').length },
      menuAgentName, expectedReply: ordinaryReply, copiedTexts, controlledCopy: agentMenuScene, controlledSdk: true, physicalPhone: false,
      intendedOccurrence: catalog.locations.find(location => location.regionId === 'region-mote'), sessionIds: sessions.map(session => ({ sessionId: session.agentSessionId, runId: session.run.runId })) })
  } })
  const app = <MobileApp key={densityMount} client={unconfirmedClient ? null : client} connection={connected ? { state: 'connected', message: '已连接原 Host' } : { state: 'disconnected', message: '连接中断；原工作面与草稿保留。' }} platform={platform} webObservation={webUpdateScene ? webUpdateObservation : null} />
  return webUpdateScene ? <MobileWebUpdateSafetyProvider verifyConnection={verifyWebUpdateConnection}>{app}</MobileWebUpdateSafetyProvider> : app
}
createRoot(document.getElementById('root')!).render(<Scene />)
