import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRpcGoal, ContinuousProgressLoop } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileApp } from '../../../src/MobileApp'
import { createBrowserPlatform } from '../../../src/platform/browser'
import { getDeviceWorkface } from '../../../src/recovery/device-workface'

const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: 'session-original', providerId: 'codex', executorId: 'original', hostId: 'host-original',
  workspacePath: fixturePath("workspace"), run: { runId: 'run-original' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
const goal: AgentMuxRpcGoal = { id: 'goal-original', title: '把这周的想法做成一个小实验', description: '先做一个可核对的小成果，再决定是否扩大范围。',
  status: 'in_progress', priority: 'normal', projectId: null, projectName: null, sessionIds: [session.agentSessionId], createdAt: 1, updatedAt: 1, source: 'session',
  alignment: { summary: '比较两个方案，保留依据和下一步。', criteria: [{ id: 'result', text: '有一份可阅读、可比较的结果。' }], openQuestions: [], revision: 1, confirmedAt: 1 } }
const calls: { method: string; params: unknown }[] = [], listeners = new Set<(event: AgentMuxClientEvent) => void>()
let loops: ContinuousProgressLoop[] = [], loseReceipt = false, connected = true, runtimeId = 'original-runtime', processId = 'process-one'
const client = {
  agentSession: (id: string) => { if (id !== session.agentSessionId) throw new Error('Unknown original Session'); return session },
  agentSessions: () => [session], onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  runtimeOwnerIdentity: () => connected ? { runtimeId, ownerInstanceId: processId, availability: 'connected', protocolVersion: 1, processId: 1,
    ctxmux: { hostId: 'runtime-host', buildIdentity: 'private-source', processId: 2, instanceId: 'original-daemon', protocolVersion: 1 } } : null,
  sessionHistoryPage: async () => ({ agentSessionId: session.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-original' }, nextCursor: null,
    items: [{ id: 'original-question', kind: 'user-message', contentParts: [{ kind: 'text', text: '我们先比较两个小方案，保留原来的工作。' }] },
      { id: 'original-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '好。我会先核对资料，把依据和需要你决定的地方写清楚。' }] }] }),
  sessionTimeline: async () => ({ agentSessionId: session.agentSessionId, revision: 1, items: [] }),
  observeSessionHistory: async () => ({ source: { providerId: 'codex', nativeSessionId: 'native-original' }, dispose() {} }),
  submitAgentPrompt: async () => { throw new Error('This controlled Renderer does not deliver Agent input.') },
  forwardRpc: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params: structuredClone(params) })
    if (!connected) throw new Error('原 Host 暂不可用，原目标与草稿保留。')
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session, displayName: { override: '我的工作搭档', availability: 'observed' } }
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return structuredClone({ goal, goalContinuations: loops })
    if (method === 'goal.start') {
      const continuation = params.continuation as { intervalMs: number; alignmentRevision: number }, operationId = String(params.operationId)
      let loop = loops.find(loop => loop.creationOperationId === operationId)
      if (!loop) { loop = { hostId: session.hostId, agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath,
        loopId: 'original-goal-loop', status: 'active', revision: 1, intervalMs: continuation.intervalMs, nextCheckAt: Date.now() + continuation.intervalMs,
        prompt: goal.description, creationOperationId: operationId, taskSource: { kind: 'goal', goalId: goal.id, alignmentRevision: continuation.alignmentRevision },
        initialDelivery: { operationId, prompt: goal.description, condition: { expectedRun: session.run, afterSubmissionId: null }, state: 'confirmed', startedAt: 1 } }; loops.push(loop) }
      return structuredClone({ goal, continuation: loop, receipt: { goalId: goal.id, sessionId: session.agentSessionId, startedAt: 1 } })
    }
    if (method === 'goal.continuation-action') {
      const loop = loops.find(loop => loop.loopId === params.loopId)!
      if (loop.lastMutation?.operationId !== params.operationId) {
        const action = params.action as 'pause' | 'resume' | 'stop' | 'check'
        loop.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'stop' ? 'stopped' : loop.status
        loop.revision = Number(params.expectedRevision) + 1
        loop.lastMutation = { operationId: String(params.operationId), action, expectedRevision: Number(params.expectedRevision) }
      }
      if (loseReceipt) { loseReceipt = false; throw new Error('原 Host 已保存，但操作回执暂不可用。') }
      return structuredClone({ goalId: goal.id, continuation: loop, diskDurability: 'confirmed' })
    }
    if (method === 'goal.focus') return { focused: true }
    throw new Error('Unsupported controlled observation: ' + method)
  }
} as unknown as AgentMuxHostedClient
localStorage.clear()
getDeviceWorkface().confirmHost({ origin: location.origin === 'file://' || location.origin === 'null' ? 'http://127.0.0.1' : location.origin, hostId: 'relay-original' })
getDeviceWorkface().updateNavigation({ selectedSessionId: session.agentSessionId, hostUrl: 'http://127.0.0.1', panel: 'conversation' })
const platform = createBrowserPlatform()
function Scene() {
  const [, refresh] = useState(0)
  Object.assign(window, { connectedWork: {
    offline: () => { connected = false; refresh(value => value + 1) },
    reconnect: () => { connected = true; processId = 'process-two'; refresh(value => value + 1) },
    foreignHost: () => { runtimeId = 'foreign-runtime'; connected = true; refresh(value => value + 1) },
    loseReceipt: () => { loseReceipt = true },
    result: () => { goal.grounding = { alignmentRevision: 1, submissionId: 'original-result', acceptedAt: null,
      summary: '第一轮比较已保存，还有一项需要核对。', checks: [{ criterionId: 'result', outcome: 'unknown', evidence: ['notes/comparison.md'], note: '第二个方案的结果尚未确认。' }] } },
    facts: () => ({ calls, record: getDeviceWorkface().snapshot().record, loops, runtimeId, connected })
  } })
  return <MobileApp client={client} connection={connected ? { state: 'connected', message: '已连接原 Mac' } : { state: 'disconnected', message: 'Host 连接中断，原工作保留。' }} platform={platform} />
}
createRoot(document.getElementById('root')!).render(<Scene />)
