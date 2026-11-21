import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createNativeModelStateFixture } from './codex-model-state-native.mjs'
const { runCompiledObjectCli } = await import('../helpers/object-cli-rpc.ts')

const evidence = resolve(process.env.AMX_MODEL_SYNC_NATIVE_EVIDENCE ?? '.bagakit/model-state-sync-repair/native-production.json')
await mkdir(resolve(evidence, '..'), { recursive: true })
let fixture, proof = {}
try {
  fixture = await createNativeModelStateFixture()
  proof = fixture.proof
  const initialRequests = fixture.modelHttpRequests
  const fromTui = await fixture.selectInTui()
  proof.tuiToCore = { snapshot: fromTui, mainPublications: structuredClone(fixture.bridge.runtimeEvents) }
  assert.ok(fixture.bridge.runtimeEvents.length > 0, 'The original Core must reach actual Main publication.')
  const model = fromTui.options.find(option => option.category === 'model')
  const desired = model.choices.find(choice => choice.value !== model.currentValue).value
  const observed = fixture.waitConfiguration(value => value.observation?.state === 'confirmed' &&
    value.options.some(option => option.category === 'model' && option.currentValue === desired), 'Main setting reaches the original producer and Core')
  const input = { target: fixture.inspection.target, operationId: 'native-model-public-selection', configId: 'model', value: desired,
    expectedRevision: fromTui.revision }
  proof.setterIntent = input
  proof.configurationBeforeSet = structuredClone(fixture.client.agentSession(fixture.original.agentSessionId).nativeConfiguration)
  const receipt = await fixture.bridge.setConfiguration(fixture.bridge.control, input)
  proof.setterReceipt = receipt
  assert.equal(receipt.outcome, 'applied'); assert.equal(receipt.value, desired)
  assert.equal(receipt.acknowledgement.options[0].currentValue, desired)
  const after = (await observed).nativeConfiguration, native = await fixture.nativeRead()
  assert.equal(native.model, desired); assert.equal(native.turns.length, 1)
  assert.equal(fixture.modelHttpRequests, initialRequests, 'Model selection must not dispatch another model turn.')
  assert.equal(fixture.client.agentSession(fixture.original.agentSessionId).run.runId, fixture.original.run.runId)
  await fixture.verifyExternalInTui(desired)
  proof.mainToTui = { input, receipt, snapshot: after, native: { id: native.id, sessionId: native.sessionId,
    model: native.model, modelProvider: native.modelProvider, turnCount: native.turns.length } }
  const cliEnvironment = { ...process.env, AGENTMUX_TEST_OBJECT_CLI: join(process.env.AMX_INFORMATION_CANDIDATE, 'core/bin/amux') }
  const inspect = await runCompiledObjectCli(['--endpoint', 'unix:' + fixture.bridge.endpoint, 'agent', 'inspect', '--session', fixture.original.agentSessionId], cliEnvironment)
  assert.equal(inspect.code, 0, inspect.stderr + inspect.stdout)
  const wire = JSON.parse(inspect.stdout).result
  assert.equal(wire.status.session.nativeConfiguration.options[0].currentValue, desired)
  assert.equal(wire.status.session.nativeConfiguration.observation.sourceId, after.observation.sourceId)
  const retained = await runCompiledObjectCli(['--endpoint', 'unix:' + fixture.bridge.endpoint, 'agent', 'configuration', 'inspect',
    '--host', 'local', '--session', fixture.original.agentSessionId, '--operation-id', input.operationId], cliEnvironment)
  assert.equal(retained.code, 0, retained.stderr + retained.stdout)
  assert.deepEqual(JSON.parse(retained.stdout).result.operation, receipt)
  proof.publicCli = { originalAgentProjection: true, retainedReceipt: true }
  if (process.env.AMX_MODEL_SYNC_NATIVE_TRACE) {
    proof.nativeRequestScope = 'Every instrumented Provider/native-rpc connection, including the original managed producer and fixture read-only connection; external Rust TUI frames are separate vendor traffic.'
    const frames = (await readFile(process.env.AMX_MODEL_SYNC_NATIVE_TRACE, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const connections = new Set(frames.filter(frame => frame.threadId === native.id).map(frame => frame.connection))
    const sent = frames.filter(frame => connections.has(frame.connection) && frame.phase === 'send' && frame.method)
    proof.nativeRequests = Object.fromEntries([...new Set(sent.map(frame => frame.method))].sort().map(method => [method, sent.filter(frame => frame.method === method).length]))
    const scene = sent.filter(frame => BigInt(frame.monotonicNs) >= BigInt(proof.modelSceneStartedMonotonicNs))
    proof.modelSceneNativeRequests = Object.fromEntries([...new Set(scene.map(frame => frame.method))].sort().map(method => [method, scene.filter(frame => frame.method === method).length]))
    for (const method of ['thread/resume', 'thread/start', 'turn/start', 'model/list', 'account/read', 'account/rateLimits/read'])
      assert.equal(proof.modelSceneNativeRequests[method] ?? 0, 0, 'The model scene must reuse its original scope and catalog: ' + method)
    proof.originalProducerSettingsNotifications = frames.filter(frame => frame.phase === 'receive' && frame.method === 'thread/settings/updated' && frame.threadId === native.id).length
    assert.ok(proof.originalProducerSettingsNotifications >= 2)
    assert.equal(proof.nativeRequests['thread/settings/update'], 1, 'Only the actual public setter, not an observer, may set a model.')
    const nativeSetter = sent.find(frame => frame.method === 'thread/settings/update')
    assert.equal(nativeSetter.id, receipt.nativeOperationId, 'The retained public receipt must identify its actual native JSON-RPC setter.')
    proof.nativeSetterRequestId = nativeSetter.id
  }
  proof.phase = 'passed'
} catch (error) {
  proof = error.nativeProof ?? proof; proof.phase = 'failed'; proof.failure = String(error)
  if (fixture) proof.terminalTail = fixture.terminalOutput.slice(-16000)
  process.exitCode = 1
} finally {
  try { await fixture?.close() } catch (error) { proof.phase = 'failed'; proof.cleanupFailure = String(error); process.exitCode = 1 }
  await writeFile(evidence, JSON.stringify(proof, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ phase: proof.phase, version: proof.version, setup: proof.setup,
    binary: proof.binary, nativeBinary: proof.nativeBinary, modelSceneNativeRequests: proof.modelSceneNativeRequests,
    nativeRequests: proof.nativeRequests, originalProducerSettingsNotifications: proof.originalProducerSettingsNotifications,
    cleanup: proof.cleanup, failure: proof.failure, evidence }) + '\n')
}
