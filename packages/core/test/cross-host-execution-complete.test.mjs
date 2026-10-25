import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvidence, applyVerificationInputs, validateUi, validateUiInputs, validateRemote } from '../scripts/fixtures/cross-host-execution-complete.mjs'

const commit = 'a'.repeat(40), sha = 'b'.repeat(64)
const candidate = { sourceCommit: commit, remote: { endpoint: { transport: 'ssh', host: 'authorized-host', user: 'owner' }, installedRoot: '/private/test-candidate' } }
const hashes = { 'packages/core/dist/index.js': sha }
test('an explicit harness correction cannot replace product sources or lose the original archive identity', () => {
  const path = 'apps/desktop/scripts/verify-space-agent-cli.mjs', original = { [path]: sha }, updated = 'c'.repeat(64)
  const overlay = { schema: 'agentmux.verification-inputs.v1', sourceCommit: commit, verificationCommit: 'd'.repeat(40), changes: [{ path, originalSha256: sha, sha256: updated }] }
  assert.deepEqual(applyVerificationInputs(original, overlay, commit), { [path]: updated })
  for (const change of [{ ...overlay.changes[0], path: 'apps/desktop/src/main/runtime-controller.ts' },
    { ...overlay.changes[0], originalSha256: updated }, { ...overlay.changes[0], path: 'apps/desktop/scripts/../src/product.ts' }]) {
    assert.throws(() => applyVerificationInputs(original, { ...overlay, changes: [change] }, commit))
  }
  assert.throws(() => applyVerificationInputs(original, overlay, 'e'.repeat(40)))
})
test('the same Core cannot certify a UI built from different or unrecorded workspace sources', () => {
  const inputs = Object.fromEntries(['apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/lib/control-api.ts',
    'apps/host/src/configured-host-clients.ts', 'packages/client-ui/src/index.ts'].map(file => [file, sha]))
  const receipt = { inputs, inputsAfter: structuredClone(inputs), builtInputs: { 'renderer/index.js': sha },
    tools: { electron: { path: '/private/qualified-electron', sha256: sha } }, toolsAfter: { electron: { path: '/private/qualified-electron', sha256: sha } } }
  validateUiInputs(receipt, inputs)
  assert.throws(() => validateUiInputs(receipt, {}))
  assert.throws(() => validateUiInputs({ ...receipt, inputsAfter: { ...inputs, 'apps/host/src/extra.ts': sha } }, inputs))
  const changed = { ...inputs, 'apps/desktop/src/main/runtime-controller.ts': 'c'.repeat(64) }
  assert.throws(() => validateUiInputs({ ...receipt, inputs: changed, inputsAfter: changed }, inputs))
  assert.throws(() => validateUiInputs({ ...receipt, toolsAfter: {} }, inputs))
})
function uiFixture() {
  const original = { agentSessionId: 'sid', run: { runId: 'run' }, creation: { operationId: 'original-create' }, toolExecution: { bindingId: 'binding', resourceHostId: 'local' } }
  const seed = { pid: 11, original, bindingId: 'binding', nativeRuns: { agent: [{ runId: 'run', pid: 31 }], resource: [{ runId: 'helper', pid: 32 }] },
    durable: { tabs: { tab: { regionId: 'region' } }, focus: 'region' }, graph: { tabs: ['tab'] }, agentComposerDrafts: { sid: 'draft' }, launcherNameDrafts: { launcher: 'name' }, launcherSurface: { workspaceId: 'resource', agentWorkspaceId: 'agent' } }
  const restored = { ...structuredClone(seed), originalElectronPid: 11, currentElectronPid: 12, originalSessionId: 'sid', originalRunId: 'run',
    noCreateOrResume: true, originalTerminalAttached: true, continuity: [{ request: [{ run: { runId: 'run' } }], reply: { kind: 'reattachable', session: { id: 'sid' } } }] }
  const exit = { exitCode: 0, exitSignal: null, exitConfirmed: true, timedOut: false }
  return { schema: 'agentmux.space-agent-cli.native.v1', passed: true, actualMachines: 2, direction: 'remote-agent', roles: { agentHostId: 'agent', resourceHostId: 'local' },
    remoteLease: { sourceCommit: commit, endpoint: candidate.remote.endpoint, base: '/private/test-candidate/ui-original', ownsNewScopeOnly: true, installedPackageReadOnly: true, coreHashes: { 'dist/index.js': sha } },
    coreConsumption: { hashes }, phases: [{ phase: 'tool-workspace', exit, native: { passed: true, pid: 11, restartSeed: seed } },
      { phase: 'tool-workspace-restore', exit, native: { passed: true, pid: 12, toolRestart: restored } }], toolRestart: restored,
    toolBinding: { opened: { agent: { hostId: 'agent', agentSessionId: 'sid', runId: 'run', toolExecution: { resourceHostId: 'local' } } } }, cleanup: { errors: [], remaining: [] } }
}
test('an original UI pass cannot qualify a different candidate, route, Run or workface', () => {
  validateUi(uiFixture(), candidate, hashes)
  const changes = [
    value => { value.remoteLease.sourceCommit = 'c'.repeat(40) },
    value => { value.remoteLease.endpoint = { ...candidate.remote.endpoint, host: 'another-host' } },
    value => { value.coreConsumption = { hashes: {} } },
    value => { value.remoteLease.coreHashes = {} },
    value => { value.phases[1].native.pid = 11 },
    value => { value.phases[1].native.toolRestart.originalRunId = 'replacement' },
    value => { value.phases[1].native.toolRestart.durable.focus = 'another-region' },
    value => { value.phases[1].native.toolRestart.nativeRuns.resource[0].pid++ },
    value => { value.phases[1].native.toolRestart.continuity[0].reply.kind = 'reopened' },
    value => { value.toolBinding.opened.agent.toolExecution.resourceHostId = 'agent' },
    value => { value.cleanup.errors.push('original owner unknown') },
  ]
  for (const change of changes) { const value = structuredClone(uiFixture()); change(value); assert.throws(() => validateUi(value, candidate, hashes)) }
})
function remoteFixture() {
  const result = name => ({ name, bindingId: name, agentSessionId: name, originalEffectCount: 1, resumeEffectCount: 1, longEffectCount: 1, contextRetained: true,
    originalRun: { runId: 'first' }, resumedRun: { runId: 'second' },
    samePathIsolation: { requestedAbsolutePath: '/tmp/private-path', agentUnchanged: true, agentOriginal: 'agent', agentFinal: 'agent', resourceOriginal: 'resource', resourceAfter: 'modified\n', resourceAfterCut: 'after-cut\n' },
    qualification: { bothCoreRestarts: ['local', 'remote'].map(host => ({ host, previousPid: 1, currentPid: 2, runtimeId: host, nativePid: 3 })),
      amux: { originalSessionId: name, resumedSessionId: name, originalRun: { runId: 'first' }, resumedRun: { runId: 'second' }, deviceRejected: true, missingCallerRejected: true, ownerUnavailableCode: 'AGENT_TOOL_CONTEXT_UNAVAILABLE', nativeToolsRetained: true },
      readerGap: { originalRequest: { bindingId: name, streamGeneration: 'original', nativeRequestId: 0 }, originalRange: { startByte: 30, endByte: 60 }, acknowledgedByte: 20, pausedPid: 4, kernelState: 'T', payloadDigest: sha, resultDigest: sha, effectCount: 1, originalStartCount: 1 } } })
  return { passed: true, mode: 'reader-gap', actualMachines: 2, bothDirectionsPassed: true, cleanupErrors: [], candidateCommit: commit, results: ['remote-agent', 'local-agent'].map(result) }
}
test('two-direction remote proof rejects duplicate directions, repeated effects and an acknowledged fake reader gap', () => {
  validateRemote(remoteFixture(), 'reader-gap', commit)
  for (const change of [value => { value.results[1] = value.results[0] }, value => { value.candidateCommit = 'c'.repeat(40) },
    value => { value.results[0].qualification.readerGap.effectCount = 2 }, value => { value.results[0].qualification.readerGap.acknowledgedByte = 60 },
    value => { value.results[0].qualification.amux.resumedSessionId = 'replacement' }, value => { value.results[0].samePathIsolation.agentFinal = 'modified' },
    value => { value.cleanupErrors.push('unknown') }]) {
    const value = remoteFixture(); change(value); assert.throws(() => validateRemote(value, 'reader-gap', commit))
  }
  assert.throws(() => validateRemote({ passed: true, results: [] }, 'performance', commit))
})
test('performance qualifies the exact one-MiB and four-MiB streams without inventing a latency SLA', () => {
  const direction = name => ({ name, qualification: { independentBindings: 2, unchangedHelpers: true, oneInitializationPerBinding: true,
    exactFileAndOutputBytes: true, healthyRequestsDuringProducer: true, noNewIdleNativeRequests: true, noNewIdleProcesses: true },
    bindings: ['producer', 'healthy'].map(role => ({ bindingId: name + role, agentSessionId: name + role, nativeHandle: role, initializeCount: 1,
      protocolRequestBytes: 100, protocolOutputBytes: 200, samples: role === 'producer' ? [{ label: 'slow-output', emittedAt: 1, completedAt: 100, roundtripMs: 99 }] : Array.from({ length: 6 }, (_, i) => ({ label: 'under-load', callId: String(i), emittedAt: i + 2, completedAt: i + 6, roundtripMs: 4 })),
      outputs: role === 'producer' ? [['output-1mib', 1], ['slow-output', 4]].map(([label, size]) => ({ label, bytes: size * 1024 * 1024, sha256: sha, roundtripMs: 100 })) : [] })),
    file: { bytes: 1024 * 1024, sha256: sha, roundtripMs: 20 }, idle: { durationMs: 10_001, samples: ['local', 'remote'].map(owner => ({ owner, intervalMs: 10_001, cpuSeconds: 0.1, rssKiB: 50_000 })) },
    concurrencyWindow: { producer: { emittedAt: 1, completedAt: 100 }, totalCount: 6, overlapCount: 6, overlappingCallIds: ['0', '1', '2', '3', '4', '5'], excludedSamples: [] }, healthyWithStoppedIndependentReader: { count: 6 },
    medianLatencyRatio: 1.2, network: { syntheticLatency: false } })
  const receipt = { passed: true, mode: 'performance', actualMachines: 2, bothDirectionsPassed: true, cleanupErrors: [], candidateCommit: commit, results: ['remote-agent', 'local-agent'].map(direction) }
  validateRemote(receipt, 'performance', commit)
  for (const change of [value => { value.results[0].bindings[0].outputs[1].bytes-- },
    value => { value.results[0].qualification.healthyRequestsDuringProducer = false },
    value => { value.results[0].qualification.noNewIdleNativeRequests = false },
    value => { value.results[0].bindings[1].samples[0].completedAt = 200 },
    value => { value.results[0].bindings[1].bindingId = value.results[0].bindings[0].bindingId }]) {
    const bad = structuredClone(receipt); change(bad); assert.throws(() => validateRemote(bad, 'performance', commit))
  }
})
test('evidence references require the original bytes, not only a successful-looking JSON value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'execution-complete-contract-'))
  try {
    const path = join(directory, 'receipt.json'), bytes = JSON.stringify({ passed: true })
    await writeFile(path, bytes)
    const reference = { path, sha256: createHash('sha256').update(bytes).digest('hex') }
    assert.deepEqual(await readEvidence(reference), { passed: true })
    await writeFile(path, JSON.stringify({ passed: true, replaced: true }))
    await assert.rejects(readEvidence(reference), /Original evidence changed/)
    await assert.rejects(readEvidence({ path, sha256: '' }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
