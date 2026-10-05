import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner, proofRoot as root, sha } from './performance-owner-proof.mjs'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const renderer = 'apps/desktop/src/renderer/src/lib/renderer-performance.ts'
const preload = 'apps/desktop/src/preload/index.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const main = 'apps/desktop/src/main/runtime-controller.ts'
const core = 'packages/core/src/client.ts'
const recorder = 'packages/core/src/performance-diagnostics.ts'
const hosted = 'packages/core/src/hosted-client.ts'
const service = 'packages/core/src/hosted-runtime-service.ts'
const metrics = 'packages/core/src/metrics.ts'
const inputTest = 'apps/desktop/test/terminal-input-performance.test.ts'
const coreTest = 'packages/core/test/performance-input-correlation.test.ts'
const publicTest = 'packages/core/test/performance-public-diagnostics.test.ts'
const owners = [terminal, renderer, preload, ipc, main, core, recorder, hosted, service, metrics]
const tests = [inputTest, coreTest, publicTest, 'apps/desktop/test/performance-stage-sampler.test.ts', 'packages/core/test/performance-stage-diagnostics.test.ts']
const mainConnection = "const client = await diagnostic.measure('connected-client', () => this.connectedClient(control.hostId, 'runtime'))\n      try { diagnostic.executionOwner(client.runtimeIdentity().instanceId) } catch { /* Diagnostic identity is optional. */ }\n      await diagnostic.measure('host-call', () => control.kind === 'agent' ? client.writeAgent({"
const wireStage = "const encoded = encodedWire ? Object.getOwnPropertyDescriptors(input) : undefined\n  if (encoded && encoded.$agentmuxValue?.value === 'record' && Array.isArray(encoded.entries?.value) && Reflect.ownKeys(input).length === 2) {"
const mutants = [
  ['source-sequence-reset', renderer, 'sequence: cost.started', 'sequence: 1', [coreTest]],
  ['recorder-domain-reused', renderer, 'observerId: nonce(), source:', "observerId: '11111111-1111-4111-8111-111111111111', source:", [coreTest]],
  ['renderer-write-parent-disconnected', terminal, 'api.sessions.write(session.control, data, source, observation.parent)', 'api.sessions.write(session.control, data, source, undefined)', [inputTest]],
  ['renderer-paste-parent-disconnected', terminal, 'api.sessions.paste(session.control, text, terminalData, observation.parent)', 'api.sessions.paste(session.control, text, terminalData, undefined)', [inputTest]],
  ['synchronous-write-never-settles', terminal, "try { request = api.sessions.write(session.control, data, source, observation.parent) }\n          catch (error) { observation.fail(); throw error }", "try { request = api.sessions.write(session.control, data, source, observation.parent) }\n          catch (error) { throw error }", [inputTest]],
  ['synchronous-paste-never-settles', terminal, "try { request = api.sessions.paste(session.control, text, terminalData, observation.parent) }\n            catch (error) { observation.fail(); throw error }", "try { request = api.sessions.paste(session.control, text, terminalData, observation.parent) }\n            catch (error) { throw error }", [inputTest]],
  ['preload-optional-clone-gates-input', preload, "const parent = readInputObservation(observation)\n      return ipcRenderer.invoke('sessions:write'", "const parent = observation\n      return ipcRenderer.invoke('sessions:write'", [inputTest]],
  ['main-connection-wait-lost', main, mainConnection, mainConnection.replace("diagnostic.measure('connected-client', () => this.connectedClient(control.hostId, 'runtime'))", "this.connectedClient(control.hostId, 'runtime')"), [inputTest]],
  ['main-agent-parent-disconnected', main, 'agentSessionId: control.agentSessionId, expectedRun: control.run, data, source, ...(parent ? { observation: parent } : {})', 'agentSessionId: control.agentSessionId, expectedRun: control.run, data, source', [inputTest]],
  ['main-terminal-parent-disconnected', main, '}, parent ?? undefined))', '}, undefined))', [inputTest]],
  ['main-trusted-window-facts-lost', ipc, 'window = currentMetricsWindow()', 'window = null', [inputTest]],
  ['main-operation-owner-not-updated', main, 'diagnostic.executionOwner(ownerInstanceId)', 'void ownerInstanceId', [inputTest]],
  ['core-agent-parent-disconnected', core, 'kind: diagnosticInput.kind, bytes: diagnosticInput.bytes, parent: diagnosticInput.parent ?? null', 'kind: diagnosticInput.kind, bytes: diagnosticInput.bytes, parent: null', [coreTest]],
  ['core-paste-parent-disconnected', core, ": input.terminalData, 'user', 'paste', readInputObservationField(input))", ": input.terminalData, 'user', 'paste', undefined)", [inputTest]],
  ['core-terminal-parent-disconnected', core, 'parent: readInputObservation(observation)', 'parent: null', [inputTest]],
  ['core-execution-owner-not-updated', core, 'diagnostic.executionOwner(ownerInstanceId)', 'void ownerInstanceId', [coreTest]],
  ['core-terminal-target-owner-lost', core, 'diagnostic.executionOwner(operation.ownerInstanceId, identity.hostId)', 'diagnostic.executionOwner(identity.instanceId, identity.hostId)', [coreTest]],
  ['hosted-encode-optional-gates-input', hosted, 'args = sanitizeInputObservationArguments(method, args)', 'args = args', [coreTest]],
  ['hosted-decode-optional-gates-input', service, 'decodeHostedValue(sanitizeHostedInputInvocation(p.invocation))', 'decodeHostedValue(p.invocation)', [coreTest]],
  ['raw-business-mistaken-for-wire', recorder, wireStage, "const encoded = Object.getOwnPropertyDescriptors(input)\n  if (encoded && encoded.$agentmuxValue?.value === 'record' && Array.isArray(encoded.entries?.value)) {", [coreTest]],
  ['duplicate-parent-called-unique', recorder, "counts.get(key(entry.parent))! > 1 ? 'ambiguous'", "false ? 'ambiguous'", [coreTest]],
  ['omitted-oldest-called-complete', recorder, 'oldestPendingMs: omittedActive > 0 || pending === 0 ? null', 'oldestPendingMs: pending === 0 ? null', [coreTest]],
  ['queue-wait-includes-connection', recorder, "entry.stage === 'queued' ? Math.max(0, now() - observed.stageStart) : 0", "entry.stage === 'queued' ? Math.max(0, now() - start) : 0", [coreTest]],
  ['parent-snapshot-aliased', recorder, 'parent: entry.parent && { ...entry.parent }, sender:', 'parent: entry.parent, sender:', [coreTest]],
  ['public-reference-validation-lost', metrics, 'if (!readInputObservation(value)) invalid()', 'void value', [publicTest]],
  ['active-retention-unbounded', recorder, 'if (active.size < 64)', 'if (active.size < 4096)', [coreTest]],
  ['recent-retention-unbounded', recorder, 'if (recent.length === 32)', 'if (recent.length === 4096)', [coreTest]]
]
const inputs = [...owners, ...tests,
  'packages/core/src/types.ts', 'packages/core/src/control.ts', 'packages/core/src/index.ts', 'packages/core/src/renderer-performance.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/shared/session-input-result.ts',
  'packages/core/test/helpers/input-correlation.ts', 'packages/core/test/helpers/renderer-performance.ts', 'packages/core/test/helpers/toolkit-metrics.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/hosted-runtime-port.ts', 'apps/desktop/test/helpers/first-execution-ipc-bridge.ts',
  'apps/desktop/scripts/performance-owner-proof.mjs', 'apps/desktop/scripts/verify-performance-input-correlation.mjs',
  'vitest.config.ts', 'vitest.dist-freshness.ts', 'packages/core/bin/amux',
  'packages/core/src/agentmux-cli-resource-guide.ts', 'docs/design/behavior/settings-and-observation.md',
  ...['agentmux', 'agentmux-cli-commands', 'agentmux-cli-resource-guide', 'control', 'control-codec', 'metrics', 'performance-diagnostics',
    'renderer-performance', 'toolkit', 'public-rpc-client', 'public-rpc-service', 'client', 'hosted-client', 'hosted-runtime-service', 'index'].map(name => `packages/core/dist/${name}.js`)]
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))
const directory = join(root, '.local/state/t002-input')
mkdirSync(directory, { recursive: true })
const locator = join(directory, 'qualification.json')
function validate(saved) {
  assert.equal(saved.passed, true)
  assert.deepEqual(saved.inputs, hashes(), 'Qualification requires the exact current source, test, caller and compiled bytes')
  assert.deepEqual(saved.mutants, mutants)
  for (const [path, hash] of Object.entries(saved.evidence)) assert.equal(sha(readFileSync(path)), hash, `evidence changed: ${path}`)
  const receipt = JSON.parse(readFileSync(saved.ownerReceipt))
  assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.runs.map(run => run.name), ['normal', ...mutants.map(m => m[0])])
  const normal = JSON.parse(readFileSync(join(saved.ownerDirectory, 'normal.json')))
  assert.equal(normal.numTotalTests, 27); assert.equal(normal.numFailedTests, 0); assert.equal(normal.numPendingTests, 0)
  for (const path of owners) assert.equal(receipt.runs[0].loadedSources[join(root, path)], saved.inputs[path])
  for (const [label, path, before, after] of mutants) {
    const result = JSON.parse(readFileSync(join(saved.ownerDirectory, label + '.json')))
    assert.ok(result.numTotalTests > 0); assert.equal(result.numPendingTests, 0)
    assert.ok(result.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))))
    const source = readFileSync(join(root, path), 'utf8')
    assert.equal(source.split(before).length, 2)
    assert.equal(receipt.runs.find(run => run.name === label).loadedSources[join(root, path)], sha(source.replace(before, after)))
  }
  const evidence = readFileSync(saved.executionEvidence, 'utf8').trim().split('\n').map(JSON.parse)
  const chain = evidence.find(row => row.case === 'actual-renderer-ipc-main-hosted-core')
  assert.equal(chain.nativeCalls, 4); assert.equal(chain.nativeMetadataAbsent, true)
  assert.equal(chain.main.completed, 4); assert.equal(chain.core.completed, 4); assert.equal(chain.renderer.completed, 4)
  assert.deepEqual(chain.main.recent.map(entry => entry.parent), chain.core.recent.map(entry => entry.parent))
  assert.deepEqual(chain.main.recent.map(entry => entry.parent), chain.renderer.recent.map(entry => entry.parent))
  const publicChain = evidence.find(row => row.case === 'actual-unix-compiled-cli-typed-toolkit')
  for (const fact of ['toolkitReceiptParsed', 'unixToolkitExact', 'cliMetricsExact', 'cliToolkitExact']) assert.equal(publicChain[fact], true)
  assert.equal(publicChain.compiledCLISHA256, saved.inputs['packages/core/dist/agentmux.js'])
  assert.ok(publicChain.diagnostics.data.main.input.recent[0].parent)
  return normal.numTotalTests
}
if (existsSync(locator)) {
  const saved = JSON.parse(readFileSync(locator)), normal = validate(saved)
  process.stdout.write(JSON.stringify({ passed: true, exactEvidenceReused: true, normal, mutants: mutants.length, receipt: locator }) + '\n')
} else {
  const before = hashes()
  const proof = provePerformanceOwner({ name: 'input-correlation', owners, tests, minimumTests: 27, mutantTests: [coreTest, inputTest], mutants,
    astOwners: [[terminal, '__AGENTMUX_TERMINAL_VIEW_SOURCE__']], callers: [
      [terminal, 'rendererPerformance.beginInputRequest('], [terminal, 'api.sessions.write(session.control, data, source, observation.parent)'],
      ['apps/desktop/src/renderer/src/lib/api.ts', 'preload.sessions.write(...args).then(unwrapSessionInputWriteResult)'],
      [preload, "ipcRenderer.invoke('sessions:write'"], [ipc, "handleWithEvent('sessions:write'"], [ipc, 'args.runtime.write(session, data, source,'],
      [main, 'this.inputPerformance.begin('], [main, "diagnostic.measure('connected-client'"], [main, 'client.writeTerminal(control.run,'],
      [hosted, 'args = sanitizeInputObservationArguments(method, args)'], [service, 'decodeHostedValue(sanitizeHostedInputInvocation(p.invocation))'],
      [core, 'this.serializeAgentInput(requestedSession,'], [core, 'this.kernel.input(session.run.runId, {'],
      ['apps/desktop/src/renderer/src/store.ts', 'rendererPerformance.snapshot()'],
      ['packages/core/src/public-rpc.ts', "'system.metrics.get': 'metrics.get'"], ['packages/core/src/public-rpc.ts', "'toolkit.inspect': 'toolkit.get'"]
    ] })
  const executionEvidence = join(proof.directory, 'normal.ast-loaded.jsonl.correlation')
  const evidencePaths = [join(proof.directory, 'receipt.json'), executionEvidence,
    ...['normal', ...mutants.map(m => m[0])].flatMap(name => [join(proof.directory, name + '.json'), join(proof.directory, name + '.loaded.json')]),
    join(proof.directory, 'normal.ast-loaded.jsonl')]
  const saved = { passed: true, inputs: before, mutants, ownerDirectory: proof.directory, ownerReceipt: join(proof.directory, 'receipt.json'), executionEvidence,
    evidence: Object.fromEntries(evidencePaths.map(path => [path, sha(readFileSync(path))])),
    boundary: 'Actual production TerminalView declarations and event/OSC/paste helpers → real preload, registered Main IPC and RuntimeController → actual Hosted client/service/value codec → actual Core FIFO/controlled native input port. Actual private Unix get/watch + compiled metrics/Toolkit CLI and full typed Toolkit receipt preserve nonempty metadata. No user Run, installed Renderer, native process health, restart, original 15s incident causality, cross-process clock subtraction or CPU attribution qualification.' }
  assert.deepEqual(hashes(), before)
  const normal = validate(saved)
  writeFileSync(locator, JSON.stringify(saved, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, normal, mutants: mutants.length, receipt: locator }) + '\n')
}
