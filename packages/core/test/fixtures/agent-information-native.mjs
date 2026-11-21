import { fixtureEpoch } from '../../../../test/fixture-values.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

/** Only normalized Provider and Runtime protocol inputs are controlled here.
 * Actual candidate Core owns scope, persistence, receipts, projection and public RPC. */
export async function informationNativeFixture(core, root, { mode = 'create', processId = process.pid } = {}) {
  const { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError } = core
  const id = 'information-original', runId = 'information-run-original', nativeId = 'information-native-original'
  const state = { mode: 'ready', configurationUnavailable: false, current: 'model-small', reads: 0, configurations: 0, writes: [], runtimeWrites: 0,
    observedAt: fixtureEpoch(2, 0, 123) }
  const configuration = () => ({ revision: 'revision-' + state.current, options: [{ id: 'model', name: 'Model', category: 'model',
    type: 'select', currentValue: state.current, choices: [{ value: 'model-small', name: 'Small model' },
      { value: 'model-large', name: 'Large model' }] }] })
  const provider = defineAgentProvider({ catalog: { id: 'information-fixture', label: 'Native information fixture',
    executable: 'native-fixture', expectedProcess: 'native-fixture', promptDelivery: 'positional-argv',
    readySignal: { kind: 'foreground-process', expectedProcess: 'native-fixture' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
    hook: { nativeHandle: { sessionIdKeys: ['session_id'] }, rules: [] }, buildArgs: (_prompt, args) => [...args],
    async readInformation(context, nativeSessionId) {
      assert.equal(nativeSessionId, nativeId); assert.equal(context.processId, processId)
      context.signal.throwIfAborted(); state.reads++
      if (state.mode === 'unavailable') throw new AgentMuxError('The native account read is unavailable.', 'NATIVE_INFORMATION_UNAVAILABLE')
      return { nativeSessionId: state.mode === 'wrong-native' ? 'foreign-native' : nativeId, sourceId: 'native-source-original',
        observedAt: state.observedAt, model: { id: state.current, scope: 'next-turn' }, plan: { id: 'team', name: 'Team' },
        limits: [{ id: 'weekly', name: 'Weekly', usedPercent: 25, windowMinutes: 10080, resetsAt: fixtureEpoch(8, 81_600) }], issues: [] }
    },
    async readConfiguration(context, nativeSessionId) {
      assert.equal(nativeSessionId, nativeId); context.signal.throwIfAborted(); state.configurations++
      if (state.configurationUnavailable === 'null') return null
      if (state.configurationUnavailable) throw new AgentMuxError('The original configuration read is unavailable.', 'NATIVE_CONFIGURATION_UNAVAILABLE')
      return configuration()
    },
    async setConfiguration(context, nativeSessionId, request) {
      assert.equal(nativeSessionId, nativeId); context.signal.throwIfAborted()
      assert.equal(request.expectedRevision, configuration().revision)
      state.writes.push(structuredClone(request))
      if (state.mode !== 'fake-ack') state.current = request.value
      return configuration()
    }
  })
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const existing = await store.readMetadata(id)
  if (mode === 'restore') {
    assert.ok(existing, 'The restoring owner must load its original FileStore; no reseeding is allowed.')
    assert.equal(existing.run.runId, runId); assert.equal(existing.nativeHandle.sessionId, nativeId)
  } else {
    assert.equal(mode, 'create'); assert.equal(existing, null, 'The first owner must create exactly once.')
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: provider.id, executorId: provider.id,
      hostId: 'local', workspacePath: root, run: { runId }, retiredRuns: [],
      hookBindingId: 'information-binding-original', hookToken: 'private-fixture-token', createdAt: 1, updatedAt: 1,
      nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: nativeId } })
  }
  const client = new AgentMuxClient({ store, providers: [provider] })
  await client.registry.load('local'); client.connected = true
  client.kernel.isConnected = () => true
  client.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'information-runtime-original', instanceId: 'information-instance-original',
    buildIdentity: 'private-fixture', protocolVersion: 1 })
  const run = { nativeService: null, runId, lifecycleOperationId: null, program: 'native-fixture', args: [], workspacePath: root,
    pid: processId, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
  client.kernel.status = async requested => { assert.equal(requested, runId); return structuredClone(run) }
  client.kernel.list = async () => [structuredClone(run)]
  for (const method of ['input', 'openInput', 'start', 'stop']) client.kernel[method] = async () => {
    state.runtimeWrites++; throw new Error('Information observation must preserve the healthy original Runtime: ' + method)
  }
  return { client, store, state, run, id, runId, nativeId,
    input: { hostId: 'local', agentSessionId: id, expectedRun: { runId } }, close: () => client.dispose() }
}
