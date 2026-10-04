import { fixturePath } from './helpers/fixture-values.js'
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AGENTMUX_HOSTED_TRANSFER_MAX_BYTES } from '../src/hosted-value.js'

it('retains exact durable bodies while control and independent readers survive unavailable general observation', async () => {
const store = new AgentMuxMemoryAgentSessionStore()
const base = { kind: 'agent', agentSessionId: 'archive', providerId: 'codex', executorId: 'codex', hostId: 'local',
  workspacePath: fixturePath("tmp/private-hosted-review"), run: { runId: 'archive-run' }, retiredRuns: [],
  hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
await store.compareAndSwap(null, base)
const core = new AgentMuxClient({ store })
await (core as any).registry.load('local'); (core as any).connected = true
let physicalInputs = 0, transportConnected = true
;(core as any).kernel = { isConnected: () => transportConnected, identity: () => ({ buildIdentity: 'private-fixture', protocolVersion: 1, daemonInstanceId: 'private-native-owner' }),
  disconnect: async () => { transportConnected = false },
  input: async (_run, op) => { physicalInputs++; return { run: { acceptedInputBytes: op.expectedByte + 1 },
    appliedByteRange: { startByte: op.expectedByte, endByte: op.expectedByte + 1 } } } }
const fence = { runtimeId: 'private-review-runtime', ownerInstanceId: 'private-review-owner' }
const service = new AgentMuxHostedRuntimeService(core, null, () => ({ ...fence, protocolVersion: 1,
  processId: process.pid, availability: 'connected', ctxmux: core.runtimeIdentity() }))
const events = [], result = { isolation: 'Memory Store and deterministic Native collaborator; actual Core, Hosted service and codec; no user Runtime', transferBudget: AGENTMUX_HOSTED_TRANSFER_MAX_BYTES, artifacts: {} }
let live
const operation = n => ({ ownerInstanceId: 'private-native-owner', operationId: 'private-input-' + n, expectedByte: n, data: 'x' })
const invoke = n => service.call('runtime.invoke', { fence, consumerId: 'private-review-consumer',
  invocation: { method: 'writeTerminal', args: [{ runId: 'healthy-run' }, operation(n)] } })
try {
  live = await service.subscribe('runtime.events', { fence, consumerId: 'private-review-consumer' }, event => { events.push(event) })
  await live.start()
  result.before = await invoke(0)
  assert.equal(physicalInputs, 1)
  const prompt = 'p'.repeat(32768)
  const intents = Object.fromEntries(Array.from({ length: 510 }, (_, index) => ['old-' + index,
    { operationId: 'old-op-' + index, prompt, active: false, message: { userContent: prompt } }]))
  await store.compareAndSwap(base, { ...base, futurePromptIntents: intents })
  await (core as any).registry.load('local')
  await core.saveAgentFuturePromptIntent({ agentSessionId: 'archive', intentId: 'new', operationId: 'new-op', prompt: 'n'.repeat(65536), active: false })
  const current = core.agentSession('archive')
  const stored = await store.load('local')
  result.intentCount = Object.keys(stored[0].futurePromptIntents).length
  assert.equal(result.intentCount, 511)
  assert.equal(current.futurePromptIntents, undefined)
  assert.equal((await core.readAgentFuturePromptIntent('archive', 'new')).prompt, 'n'.repeat(65536))
  result.eventJsonBytes = Buffer.byteLength(JSON.stringify({ kind: 'event', event: { type: 'agent-session', session: current } }))
  assert.ok(result.eventJsonBytes < 2048)
  // Canonical Session-update collaborator: same full event emitted by native Hook client.ts:7367.
  // Hook process/protocol is outside this finite Hosted consumer test.
  ;(core as any).publisher.publish({ type: 'agent-session', session: current })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.find(event => event.type === 'error'), undefined)
  await invoke(1); assert.equal(physicalInputs, 2)
  const cold = await service.subscribe('runtime.events', { fence, consumerId: 'private-cold-review' }, () => {})
  await cold.start(); await cold.dispose()
  await live.dispose()
  await invoke(2); assert.equal(physicalInputs, 3)
  const controls = [], diagnostics = []
  let loseWriteReceipt = false
  const rpc = {
    call: async (method, params, context) => {
      controls.push(method)
      const result = await service.call(method, params, context)
      if (loseWriteReceipt && method === 'runtime.invoke' && params.invocation.method === 'writeTerminal') throw new Error('Original receipt lost after Native accepted input')
      return result
    },
    subscribe: async () => { throw new Error('Only this observation transport is unavailable') }
  }
  const sdk = await connectHostedAgentMux({ rpc: rpc as AgentMuxHostedRpcPort, consumerId: 'private-partial-review', waitForReady: false })
  sdk.onEvent(event => diagnostics.push(event))
  await sdk.writeTerminal({ runId: 'healthy-run' }, operation(3)); assert.equal(physicalInputs, 4)
  assert.equal(sdk.runtimeOwnerIdentity().runtimeId, fence.runtimeId)
  assert.equal((await sdk.readAgentFuturePromptIntent('archive', 'old-509')).prompt, prompt)
  const page = await sdk.listAgentFuturePromptIntents('archive', { limit: 16 })
  assert.equal(page.intents.length, 16); assert.ok(page.nextIntentId)
  loseWriteReceipt = true
  await assert.rejects(sdk.writeTerminal({ runId: 'healthy-run' }, operation(4)), /Original receipt lost/)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(physicalInputs, 5)
  await assert.rejects(service.call('runtime.invoke', { fence: { ...fence, ownerInstanceId: 'foreign-owner' }, consumerId: 'private-partial-review', invocation: { method: 'writeTerminal', args: [{ runId: 'healthy-run' }, operation(5)] } }), error => error.code === 'RUNTIME_OWNER_CHANGED')
  assert.equal(physicalInputs, 5)
  assert.ok(diagnostics.some(event => event.type === 'connection-state' && event.state === 'lost'))
  result.result = 'accepted'; result.physicalInputs = physicalInputs; result.coldBootstrap = 'bounded summaries'; result.exactFutureBody = 'all 511 retained, exact and paged read'; result.observationFailure = 'persistent diagnostic; independently authorized input retained'; result.unknownInput = 'not replayed'; result.foreignFence = 'rejected'
  await sdk.dispose()
} finally { await live?.dispose(); await service.dispose(); await core.dispose() }

})
