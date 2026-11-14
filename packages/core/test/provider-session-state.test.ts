import { afterEach, expect, it } from 'vitest'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'
import { normalizeAgentSession } from "../src/agent-session-codec.js";
import { observeAgent } from '../src/agent-status-freshness.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const native = (sequence: number, turnId: string, extra = {}) => ({ session_id: 'native-main', sourceId: 'source-original', sequence, turnId, ...extra })
async function fixture() {
  const h = await activityCertaintyClient('state-original', 'claude'); closes.push(h.close)
  await h.hook('turn.start', 'main-start', native(1, 'main-turn'))
  await h.hook('turn.start', 'child-start', native(2, 'child-turn', { agent_id: 'child-original' }))
  return h
}

it('public inspection separates an ended main from confirmed child work despite unknown background activity', async () => {
  const h = await fixture()
  await h.hook('turn.complete', 'main-end', native(3, 'main-turn', { reason: 'answer', isAborted: false, backgroundWork: 'pending' }))
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }] }); closes.push(() => service.dispose())
  const params = { target: { kind: 'agent-session' as const, agentSessionId: 'state-original' } }
  const result = await service.call('agent.inspect', params)
  expect(result.status?.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle', nativeTurnId: 'main-turn' },
    subagentSessions: { nativeSessionId: 'native-main', sessions: [{ nativeAgentId: 'child-original', phase: 'running', state: 'working' }] } })
  expect(result.status?.session.currentActivity?.state).toBe('unknown')
  expect(agentTurnCompletionIdentity(result.status!.session)).toBeUndefined()
  expect(parseRpcNativeResult('agent.inspect', result, params)).toEqual(result)
})

it('child settlement preserves main identity and does not manufacture a successful main result', async () => {
  const h = await fixture()
  await h.hook('turn.complete', 'main-end', native(3, 'main-turn', { reason: 'answer', isAborted: false, backgroundWork: 'pending' }))
  await h.hook('turn.complete', 'child-end', native(4, 'child-turn', { agent_id: 'child-original', reason: 'answer', isAborted: false }))
  const status = await h.client.statusAgent('state-original')
  expect(status.session.nativeHandle?.sessionId).toBe('native-main')
  expect(status.session.nativeSubagents?.sessions).toEqual([expect.objectContaining({ nativeAgentId: 'child-original', phase: 'ended' })])
  expect(status.observation.mainSession?.semantic).toBe('idle')
  expect(agentTurnCompletionIdentity(status.session)).toBeUndefined()
})

it('a late end of an older child turn cannot erase a resumed child turn', async () => {
  const h = await fixture()
  await h.hook('turn.start', 'child-resumed', native(3, 'child-turn-new', { agent_id: 'child-original' }))
  await h.hook('turn.complete', 'late-old-child', native(4, 'child-turn', { agent_id: 'child-original', reason: 'answer', isAborted: false }))
  expect(h.client.agentSession('state-original').nativeSubagents?.sessions).toEqual([
    expect.objectContaining({ nativeTurnId: 'child-turn-new', phase: 'running', sequence: 3 })
  ])
})

it('child facts survive Store reload without renewing their observation clock', async () => {
  const h = await fixture()
  const before = h.client.agentSession('state-original').nativeSubagents!
  const saved = (await h.sessions())[0]!
  const reloaded = normalizeAgentSession(JSON.parse(JSON.stringify(saved)))
  expect(reloaded.nativeSubagents).toEqual(before)
  const later = observeAgent({ process: 'running', status: { state: 'running', source: 'run-process', observedAt: Date.now() },
    subagentSessions: reloaded.nativeSubagents, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false },
    before.sessions[0]!.observedAt + 16 * 60_000)
  expect(later.semantic).toBe('unknown')
  expect(later.subagentSessions?.sessions[0]!.observedAt).toBe(before.sessions[0]!.observedAt)
})

it('a failed child save changes no in-memory child truth and can be retried with its original receipt', async () => {
  const h = await fixture(), original = h.client.agentSession('state-original').nativeSubagents
  const store = h.store, cas = store.compareAndSwapMetadata.bind(store)
  store.compareAndSwapMetadata = async (...args) => {
    if (args[1]?.nativeSubagents?.sessions.some(item => item.nativeAgentId === 'child-new')) throw new Error('isolated write failure')
    return cas(...args)
  }
  await expect(h.hook('turn.start', 'child-new-start', native(3, 'new-turn', { agent_id: 'child-new' }))).rejects.toThrow('isolated write failure')
  expect(h.client.agentSession('state-original').nativeSubagents).toEqual(original)
  store.compareAndSwapMetadata = cas
  await h.hook('turn.start', 'child-new-start', native(3, 'new-turn', { agent_id: 'child-new' }))
  expect(h.client.agentSession('state-original').nativeSubagents?.sessions.map(item => item.nativeAgentId)).toEqual(['child-original', 'child-new'])
})

it('an invalidated native epoch cannot republish its previous main state or renew its clock', async () => {
  const h = await fixture()
  const before = (await h.client.statusAgent('state-original')).observation.mainSession!
  const childBefore = h.client.agentSession('state-original').nativeSubagents!.sessions[0]!.observedAt
  await h.hook('AgentMuxActivityUnavailable', 'delivery-gap', { session_id: 'native-main', sourceId: 'source-original', sequence: 3, reason: 'delivery-gap' })
  const status = await h.client.statusAgent('state-original')
  expect(status.observation.mainSession?.semantic).toBe('unknown')
  expect(status.session.mainSessionActivity?.mainState).toBeUndefined()
  expect(before.semantic).toBe('active')
  // The missing position may be this child's end. Its original identity and clock stay retained.
  expect(status.observation.semantic).toBe('unknown')
  expect(status.session.nativeSubagents?.sessions[0]).toMatchObject({ state: 'unknown', phase: 'running', nativeTurnId: 'child-turn' })
  expect(status.session.nativeSubagents?.sessions[0]?.observedAt).toBe(childBefore)
  await h.hook('turn.complete', 'end-after-gap', native(4, 'child-turn', { agent_id: 'child-original', reason: 'answer', isAborted: false }))
  expect(h.client.agentSession('state-original').nativeSubagents?.sessions[0]).toMatchObject({ state: 'done', phase: 'ended' })
})

it('confirmed child work and an original pending main request stay independent', async () => {
  const h = await fixture()
  await h.hook('PermissionRequest', 'main-permission', { session_id: 'native-main', tool_name: 'Bash', tool_use_id: 'main-tool', tool_input: { command: 'true' } })
  const status = await h.client.statusAgent('state-original')
  expect(status.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'awaiting-input' }, readiness: 'pending' })
  expect(status.session.pendingInteraction?.request.kind).toBe('permission')
  expect(agentTurnCompletionIdentity(status.session)).toBeUndefined()
})

it('an original unordered child receipt cannot refresh its observation on redelivery', async () => {
  const { nextSubagentSessions } = await import('../src/hook-normalizer.js')
  const spec = { rules: [], subagentTracking: { startEvents: ['ChildStart'], stopEvents: ['ChildEnd'], idKeys: ['childId'] } }
  const nativeHandle = { kind: 'provider' as const, providerId: 'native-provider', sessionId: 'native-main' }
  const envelope = { agentSessionId: 'original', providerId: 'native-provider', runId: 'original-run', receiptId: 'original-child-start', eventName: 'ChildStart', payload: { childId: 'child-original' } }
  const subject = { kind: 'child' as const, basis: 'provider-protocol' as const, reason: 'declared-child-subject', nativeSessionId: 'native-main' }
  const original = nextSubagentSessions(spec, envelope, { nativeHandle }, subject, 10)!
  expect(original.sessions[0]?.observedAt).toBe(10)
  expect(nextSubagentSessions(spec, envelope, { nativeHandle, nativeSubagents: original }, subject, 100)).toBeUndefined()
  expect(original.sessions[0]?.observedAt).toBe(10)
})

it('a source gap preserves independent, newer and ended child observations', async () => {
  const { invalidateSubagentSource } = await import('../src/agent-subagent-state.js')
  const child = { nativeAgentId: 'affected', hookReceiptId: 'original-child', sourceId: 'source-a', sequence: 2,
    state: 'working' as const, phase: 'running' as const, observedAt: 10 }
  const independent = { ...child, nativeAgentId: 'independent', sourceId: 'source-b' }
  const newer = { ...child, nativeAgentId: 'newer', sequence: 5 }
  const ended = { ...child, nativeAgentId: 'ended', state: 'done' as const, phase: 'ended' as const }
  const original = { providerId: 'native', nativeSessionId: 'original-native', run: { runId: 'original-run' },
    unconfirmed: false, sessions: [child, independent, newer, ended] }
  const next = invalidateSubagentSource(original, { sourceId: 'source-a', sequence: 4 })!
  expect(next.sessions[0]).toEqual({ ...child, state: 'unknown' })
  expect(next.sessions.slice(1)).toEqual([independent, newer, ended])
  expect(original.sessions[0]).toBe(child)
  expect(next.unconfirmed).toBe(false)
})
