import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRpcResult, AgentMuxRpcGoal } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileApp } from '../../../src/MobileApp'
import { createBrowserPlatform } from '../../../src/platform/browser'
import { getDeviceWorkface } from '../../../src/recovery/device-workface'
import '@agentmux/client-ui/styles.css'

type Call = { sequence: number; observedAt: number; method: string; params: unknown }
const calls: Call[] = []
const record = (method: string, params: unknown = {}) => calls.push({ sequence: calls.length + 1, observedAt: Date.now(), method, params: structuredClone(params) })
const original = (id: string): AgentMuxAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'fixture-original',
  hostId: 'host-original', workspacePath: fixturePath("execution-original"), run: { runId: `run-${id}` }, retiredRuns: [], createdAt: 1, updatedAt: 1 })
const main = original('session-mote'), waiting = original('session-waiting'), result = original('session-result')
waiting.pendingInteraction = { request: { kind: 'permission', id: 'request-original', agentSessionId: waiting.agentSessionId,
  title: '请确认本次资料读取', evidence: { source: 'native-hook', observedAt: 1, run: waiting.run },
  options: [{ id: 'allow-original', label: '允许本次读取', kind: 'allow-once' }, { id: 'deny-original', label: '拒绝本次读取', kind: 'reject-once' }] } }
const sessions = [main, waiting, result]
// Same SID occurs first outside the Mote and then at its intended original Mote location.
const catalog = {
  spaces: [{ spaceId: 'other-space', kind: 'folder', name: '并行项目', hostId: 'host-original', directoryPath: fixturePath("other"), projectId: null },
    { spaceId: 'mote-original', kind: 'mote', name: '我的 Mote', hostId: 'host-original', directoryPath: fixturePath("mote-original"), projectId: null }],
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
  agentPresentation: [{ agentSessionId: main.agentSessionId, name: '日常协作', project: '我的 Mote', group: 'working', state: 'working', detail: '正在整理你的想法', providerId: 'codex', recap: { text: '先保留原始材料，再比较两个方案。', source: 'native-hook' } },
    { agentSessionId: waiting.agentSessionId, name: '资料整理', project: '我的 Mote', group: 'attention', state: 'waiting', detail: '等待本次权限回应', providerId: 'codex', recap: { text: '请确认这次资料读取；其他工作继续。', source: 'native-hook' } },
    { agentSessionId: result.agentSessionId, name: '实验建议', project: '并行项目', group: 'results', state: 'done', detail: '有新结果', providerId: 'codex', recap: { text: '已形成一份可直接阅读的建议，等待你决定下一步。', source: 'native-hook' } }],
  appearance: [{ spaceId: 'mote-original', preset: 'primary-mote', expression: 'thinking' }],
  motePresentation: [{ spaceId: 'mote-original', content: { zoneId: 'zone-mote', hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original") },
    quickMode: { status: 'saved', version: 'sha256:' + 'b'.repeat(64), defaults: { executorId: 'fixture-original', recovery: 'on-open', conversation: {
      hostId: 'host-original', sessionId: main.agentSessionId, displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' } } },
    conversation: { hostId: 'host-original', sessionId: main.agentSessionId, displayWorkspaceId: 'display-original', groupId: 'group-mote', tabId: 'tab-mote', regionId: 'region-mote' } }]
} as AgentMuxRpcResult<'space.ls'>['catalog']
const goal: AgentMuxRpcGoal = { id: 'goal-original', title: '把两个想法变成一个小实验', description: '比较已有资料，选择本周可以开始的方向。', status: 'in_progress', priority: 'normal', projectId: null,
  sessionIds: [main.agentSessionId, result.agentSessionId], source: 'session', activityLog: [], createdAt: 1, updatedAt: 2,
  alignment: { revision: 1, summary: '给出小步可验证的建议，保留两种方案的依据。', criteria: [{ id: 'criterion-original', text: '形成可开始的实验步骤' }], openQuestions: [], confirmedAt: 1 },
  grounding: { alignmentRevision: 1, submissionId: 'result-original', summary: '建议先做范围更清晰的方案 A；以下是依据和第一步。', acceptedAt: null,
    checks: [{ criterionId: 'criterion-original', outcome: 'met', note: '已整理步骤、比较依据与需要你决定的地方。', evidence: ['原资料/实验建议.md'] }] } }
let connected = location.hash !== '#fixture-offline', unknownNext = false
const listeners = new Set<(event: AgentMuxClientEvent) => void>()
const client = {
  agentSession: (id: string) => { record('sdk.agentSession', { id }); const found = sessions.find(session => session.agentSessionId === id); if (!found) throw Error('Unknown original fixture Session'); return found },
  agentSessions: () => { record('sdk.agentSessions'); return sessions },
  catalog: () => { record('sdk.catalog'); return [{ id: 'codex', capabilities: { promptExecution: { immediate: 'native-steer' } } }] },
  onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); record('sdk.onEvent'); return () => { listeners.delete(listener); record('sdk.releaseEvent') } },
  runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original', availability: connected ? 'connected' : 'disconnected' }),
  sessionHistoryPage: async (id: string) => { record('sdk.sessionHistoryPage', { id }); return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: null,
    items: [{ id: `${id}-user-original`, kind: 'user-message', contentParts: [{ kind: 'text', text: '这两个想法，先从哪一个做成小实验比较好？请保留原来的依据。' }] },
      { id: `${id}-answer-original`, kind: 'assistant-message', contentParts: [{ kind: 'text', text: id === result.agentSessionId ? '我建议先试方案 A。它的范围更清晰，一天就能取得第一批反馈。\n\n1. 保留现有资料和两种方案。\n2. 选三个最关键的问题。\n3. 先观察真实反馈，再决定是否继续。\n\n方案 B 仍有价值，原依据已经保留。' : '可以。我们先确认你想解决的问题，再比较这两种想法。\n\n我会保留原材料、已经确认的进展和还需要你决定的地方；不会把未知回执当作完成。' }] }] } },
  sessionTimeline: async (id: string) => { record('sdk.sessionTimeline', { id }); return { agentSessionId: id, revision: 1, items: [] } },
  observeSessionHistory: async (id: string) => { record('sdk.observeSessionHistory', { id }); return { source: { providerId: 'codex', nativeSessionId: `native-${id}` }, dispose() { record('sdk.releaseHistory', { id }) } } },
  submitAgentPrompt: async (params: unknown) => { record('sdk.submitAgentPrompt', params); if (unknownNext) { unknownNext = false; throw Error('原 Host 已受理输入，但确认回执在返回途中断开。当前结果未知；保留原 operation、Session、Run 和正文，显式核对原请求后再决定是否重试。此处不会自动重发，后来补充的草稿也保留。') } },
  respondAgentInteraction: async (params: unknown) => { record('sdk.respondAgentInteraction', params) },
  forwardRpc: async (method: string, params: Record<string, unknown>) => {
    record(method, params)
    if (!connected) throw Error('原 Host 连接中断；原对象、历史与草稿保留。')
    if (method === 'space.ls' || method === 'space.inspect') return { catalog }
    if (method === 'app.snapshot') return { agents: [], projects: [], executors: [], workspaces: [], unavailable: [] }
    if (method === 'agent.inspect') return { session: sessions.find(session => session.agentSessionId === (params.target as { agentSessionId: string }).agentSessionId), displayName: { override: '原 Agent', availability: 'observed' } }
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal, goalContinuations: [] }
    if (method === 'file.read') {
      if (params.zoneId !== 'zone-mote' || params.spaceId !== 'mote-original'
        || JSON.stringify(params.expectedResource) !== JSON.stringify({ hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original") })) throw Error('Wrong original Mote file scope')
      return { resource: { hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath("mote-original"), zoneId: 'zone-mote', zonePath: fixturePath("mote-original"), path: params.path },
        result: { status: 'read', document: { path: params.path, revision: 'sha256:' + 'c'.repeat(64),
          content: '# 合作方式\n\n我们围绕你的原始目标继续讨论，先把事实和未知分清，再选本周能验证的一小步。\n\n- 保留原对象、历史和草稿。\n- 需要你回应时说明具体决定。\n- 结果可阅读、可追溯，再由你决定是否接受。' } } }
    }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'message.delivery.report') return { stored: true }
    throw Error('Unsupported controlled public method: ' + method)
  }
} as unknown as AgentMuxHostedClient
if (!localStorage.getItem('mobile-product-fixture-initialized')) {
  localStorage.setItem('agentmux-mobile-home', 'mote')
  getDeviceWorkface().confirmHost({ origin: 'http://127.0.0.1', hostId: 'relay-original' })
  localStorage.setItem('mobile-product-fixture-initialized', 'true')
}
const platform = createBrowserPlatform()
function Scene() {
  const [, refresh] = useState(0)
  Object.assign(window, { mobileProductScene: {
    unknownNext: () => { unknownNext = true },
    offline: () => { connected = false; refresh(value => value + 1) },
    reconnect: () => { connected = true; refresh(value => value + 1) },
    facts: () => ({ calls, record: getDeviceWorkface().snapshot().record, controlledSdk: true, physicalPhone: false,
      intendedOccurrence: catalog.locations.find(location => location.regionId === 'region-mote'), sessionIds: sessions.map(session => ({ sessionId: session.agentSessionId, runId: session.run.runId })) })
  } })
  return <MobileApp client={client} connection={connected ? { state: 'connected', message: '已连接原 Host' } : { state: 'disconnected', message: '连接中断；原工作面与草稿保留。' }} platform={platform} />
}
createRoot(document.getElementById('root')!).render(<Scene />)
