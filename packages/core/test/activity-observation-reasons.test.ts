import { fixtureEpoch as _tailRefreshFixtureEpoch } from "./helpers/fixture-values.js"
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { observeAgent, currentAgentSemanticStatus } from '../src/agent-status-freshness.js'
import type { AgentStatus } from '../src/types.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const NOW = _tailRefreshFixtureEpoch(1), OLD = NOW - 25 * 60_000
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function observe(retainedStatus?: AgentStatus, display?: AgentStatus) {
  return observeAgent({ process: 'running', status: display ?? currentAgentSemanticStatus(retainedStatus) ?? { state: 'running', source: 'run-process', observedAt: NOW },
    retainedStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, NOW)
}
it.each(['native-hook', 'native-transcript', 'acp'] as const)('expired %s working retains its original observation and never becomes a task timeout', source => {
  const fact: AgentStatus = { state: 'working', source, observedAt: OLD }
  expect(observe(fact)).toMatchObject({ semantic: 'unknown', readiness: 'ready', reason: 'activity-stale', lastKnownActivity: fact })
  expect(observe(fact, { ...fact, state: 'running' })).toEqual(observe(fact))
})
it('bare process and consumed completion are unconfirmed, including when their observations are old', () => {
  expect(observe()).toMatchObject({ semantic: 'unknown', reason: 'activity-unconfirmed' })
  expect(observe().lastKnownActivity).toBeUndefined()
  const consumed: AgentStatus = { state: 'done', source: 'native-hook', observedAt: OLD, idleEvidenceConsumed: true }
  expect(observe(consumed)).toMatchObject({ semantic: 'unknown', reason: 'activity-unconfirmed', lastKnownActivity: { state: 'done', observedAt: OLD } })
  expect(observe({ state: 'running', source: 'native-hook', observedAt: OLD }).lastKnownActivity).toBeUndefined()
})
it.each(['waiting', 'blocked', 'done', 'error'] as const)('old confirmed %s is not relabeled as an activity observation problem', state => {
  const observation = observe({ state, source: 'acp', observedAt: OLD })
  expect(observation.semantic).toBe(state === 'waiting' || state === 'blocked' ? 'awaiting-input' : 'idle')
  expect(observation.reason).toBeUndefined(); expect(observation.lastKnownActivity).toBeUndefined()
})
it('expired child aggregate retains the current activity observation rather than an older main completion', () => {
  expect(observe({ state: 'done', source: 'native-hook', observedAt: OLD - 1000, aggregateActivityAt: OLD })).toMatchObject({
    reason: 'activity-stale', lastKnownActivity: { state: 'working', observedAt: OLD } })
})
it('actual FileStore/Core/service and compiled inspect preserve explanations and reject malformed public facts', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await activityCertaintyClient('reason-public', 'grok', { semanticStatus: { state: 'working', source: 'native-hook', observedAt: OLD } })
  cleanup.push(h.close)
  const before = await h.sessions(), status = await h.client.statusAgent('reason-public')
  expect(status.observation).toMatchObject({ semantic: 'unknown', readiness: 'ready', reason: 'activity-stale', lastKnownActivity: { state: 'working', observedAt: OLD } })
  const server = new AgentMuxControlServer({ socketPath: join(h.directory, 'reason.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', 'reason-public'], objectCliEnvironment(h.directory))
  expect(result.code, result.stderr).toBe(0)
  const value = JSON.parse(result.stdout).result
  expect(value.status.observation).toEqual(status.observation)
  const params = { target: { kind: 'agent-session', agentSessionId: 'reason-public' } }
  expect(parseRpcNativeResult('agent.inspect', value, params)).toEqual(value)
  const invalid = structuredClone(value); invalid.status.observation.reason = 'task-timeout'
  expect(() => parseRpcNativeResult('agent.inspect', invalid, params)).toThrow()
  const untrusted = structuredClone(value); untrusted.status.observation.lastKnownActivity.source = 'terminal-output'
  expect(() => parseRpcNativeResult('agent.inspect', untrusted, params)).toThrow()
  expect(await h.sessions()).toEqual(before)
})
it('provides a private visual scene from actual public Core observations of four distinct durable states', async () => {
  const now = Date.now()
  const bare = await activityCertaintyClient('scene-bare', 'grok'); cleanup.push(bare.close)
  const rows = [await bare.client.statusAgent('scene-bare')]
  for (const [id, state, observedAt] of [
    ['scene-stale', 'working', now - 25 * 60_000], ['scene-working', 'working', now], ['scene-idle', 'done', now]
  ] as const) {
    const h = await activityCertaintyClient(id, 'grok', { workspacePath: bare.directory, semanticStatus: { state, source: 'native-hook', observedAt } })
    cleanup.push(h.close); rows.push(await h.client.statusAgent(id))
  }
  expect(rows.map(row => row.observation.semantic)).toEqual(['unknown', 'unknown', 'active', 'idle'])
  if (process.env.AGENTMUX_OBSERVATION_SCENE_SEED) await writeFile(process.env.AGENTMUX_OBSERVATION_SCENE_SEED,
    JSON.stringify({ schema: 'agentmux.activity-certainty-public-scene-seed.v1', rows, observerNow: now,
      boundary: 'Actual public Core and private FileStore; fixed Run transport and retained native facts, no real vendor or user Run operated.' }, null, 2))
})
