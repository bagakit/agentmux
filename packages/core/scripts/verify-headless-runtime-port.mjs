import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const workspace = resolve(import.meta.dirname, '../../..')
const core = join(workspace, 'packages/core')
const receiptDirectory = join(workspace, '.tmp/headless-runtime-port-verification', `run-${Date.now()}`)
await mkdir(receiptDirectory, { recursive: true })
const shadow = await mkdtemp(join(workspace, '.tmp/headless-runtime-mutants-'))
const shadowCore = join(shadow, 'packages/core')
const digest = value => createHash('sha256').update(value).digest('hex')
const testFiles = [
  'packages/core/test/headless-runtime-port.integration.test.ts',
  'packages/core/test/federated-runtime-client.integration.test.ts',
  'packages/core/test/headless-runtime-continuity.integration.test.ts',
  'packages/core/test/runtime-reader-lifetime.test.ts',
  'packages/core/test/public-rpc-ssh-channel.test.ts',
  'packages/core/test/hosted-runtime-service.test.ts',
  'packages/core/test/hosted-reading-intent.test.ts',
  'packages/core/test/hosted-retained-session.test.ts',
  'packages/core/test/hosted-agent-message.test.ts',
  'packages/core/test/hosted-value-roundtrip.test.ts',
  'packages/core/test/hosted-output-observer.test.ts'
]
const args = ['node_modules/vitest/vitest.mjs', 'run']
const baselineCases = new Map()
const sourceFiles = ['hosted-client.ts', 'hosted-client-contract.ts', 'hosted-value.ts', 'hosted-output-observer.ts',
  'hosted-runtime-service.ts', 'client-event-publisher.ts', 'runtime-paths.ts', 'durable-write.ts',
  'agent-session-identity.ts', 'agent-prompt-condition.ts', 'headless-runtime.ts', 'headless-runtime-cli.ts', 'runtime-client.ts', 'client.ts',
  'public-rpc.ts', 'public-rpc-service.ts', 'public-rpc-client.ts', 'public-rpc-wire.ts', 'public-rpc-frame.ts', 'public-rpc-server.ts', 'rpc-data.ts',
  'rpc-business-codec.ts', 'rpc-native-codec.ts', 'agent-session-store.ts', 'agent-message.ts', 'agent-session-id.ts',
  'agent-provider.ts', 'agent-discussion.ts', 'agent-global-message-queue.ts', 'session-output-follow.ts',
  'agentmux.ts', 'agentmux-rpc-stdio.ts', 'rpc-ssh-transport.ts', 'rpc-transport-error.ts', 'agent-outbound-message.ts', 'ctxmux-artifact-contract.json']
const evidenceFiles = [...testFiles, 'packages/core/test/helpers/headless-runtime-fixture.ts',
  'packages/core/test/helpers/hosted-runtime-port.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/test/fixtures/headless-runtime-worker.mjs', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts']
const tests = Object.fromEntries(await Promise.all(evidenceFiles.map(async file => [file, digest(await readFile(join(workspace, file)))])))
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(join(core, 'src', file)))])))
const mutants = [
  { name: 'durable-semantic-owner-replaced-on-restart', file: 'headless-runtime.js',
    original: 'runtimeId = state.runtimeId;', changed: 'runtimeId = randomUUID();', assertion: 'expected', test: testFiles[2] },
  { name: 'stale-owner-epoch-admitted', file: 'hosted-runtime-service.js',
    original: 'if (p.ownerInstanceId !== owner.ownerInstanceId)',
    changed: 'if (false)', assertion: 'stale owner epoch must be rejected', test: testFiles[1] },
  { name: 'original-bytes-reencoded-as-text', file: 'hosted-value.js',
    original: 'String.fromCharCode(...value.subarray(offset, offset + 8192))', changed: 'String.fromCharCode(...new TextEncoder().encode(new TextDecoder().decode(value)).subarray(offset, offset + 8192))', assertion: 'expected', test: testFiles[1] },
  { name: 'healthy-run-blocked-by-provider-probe', file: 'client.js',
    original: "run?.state !== 'running' && catalog?.resumeStrategy.kind", changed: 'catalog?.resumeStrategy.kind', assertion: 'healthy Run remains reattachable through failed Provider probe', test: testFiles[2] },
  { name: 'closing-one-reader-detaches-healthy-run', file: 'hosted-runtime-service.js',
    original: '!current.readers.size && this.runs.get(runId) === current', changed: 'this.runs.get(runId) === current',
    assertion: 'second reader survives cancellation', test: testFiles[1] },
  { name: 'one-reader-failure-disconnects-the-endpoint', file: 'hosted-client.js',
    original: 'failure = error;\n            reject(error);', changed: 'failure = error; stream = undefined;\n            reject(error);',
    assertion: 'reader failure keeps the semantic endpoint connected', test: testFiles[1] },
  { name: 'overlapping-replay-repeats-terminal-text', file: 'hosted-client.js',
    original: 'data: new TextDecoder().decode(dataBytes)', changed: 'data: event.data',
    assertion: 'overlapping replay keeps text and bytes on the same unread range', test: testFiles[1] },
  { name: 'oversized-observation-reader-fails-silently', file: 'hosted-runtime-service.js',
    original: 'for (const reader of recipients)\n                reader.fail(error);', changed: 'if (false) {}',
    assertion: 'serialization failure must terminate its exact reader visibly', test: testFiles[1] },
  { name: 'old-reader-release-overlaps-new-core-lease', file: 'hosted-runtime-service.js',
    original: 'current.closing ??=', changed: 'this.runs.delete(runId); current.closing ??=',
    assertion: 'new reader cannot overlap the previous Core lease release', test: testFiles[3] },
  { name: 'history-reader-failure-retains-native-observer', file: 'hosted-runtime-service.js',
    original: 'consumer = reader(emit, {}, stop);', changed: 'consumer = reader(emit, {}, () => {});',
    assertion: 'failed history reader releases its native observer without waiting for peer disconnect', test: testFiles[3] },
  { name: 'desktop-address-forwarded-without-core-identity', file: 'public-rpc-service.js',
    original: "operationId, text, target: { kind: 'agent-session', agentSessionId: recipientId } }, context)", changed: 'operationId, text, target: p.target }, context)',
    assertion: 'Desktop region routes its canonical Session to the original remote owner', test: testFiles[0] },
  { name: 'native-confirmed-input-prefix-is-lost', file: 'public-rpc-frame.js',
    original: 'data?.controlFailure === undefined ? undefined : parseRpcControlFailure(data.controlFailure)', changed: 'undefined',
    assertion: 'remote error retains Native confirmed input prefix', test: testFiles[1] },
  { name: 'ssh-probe-uses-business-deadline', file: 'rpc-ssh-transport.js',
    original: "'CONTROL_TIMEOUT')), AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS)", changed: "'CONTROL_TIMEOUT')), 2_000)",
    assertion: 'SSH establishment precedes the original short business deadline', test: testFiles[4] },
  { name: 'warm-ssh-intents-open-another-process', file: 'public-rpc-client.js',
    original: 'if (!this.ssh)', changed: 'if (true)',
    assertion: 'warm calls and readers share one SSH process', test: testFiles[4] },
  { name: 'one-ssh-reader-cancels-its-peer', file: 'rpc-ssh-transport.js',
    original: 'this.subscriptions.delete(consumer.subscriptionId);', changed: 'this.dispose(); this.subscriptions.delete(consumer.subscriptionId);',
    assertion: 'cancelling one SSH reader preserves its peer', test: testFiles[4] },
  { name: 'ssh-transit-is-mistaken-for-business-failure', file: 'public-rpc-client.js',
    original: 'if (!handlers)\n                return;', changed: "if (!handlers) { deadline = setTimeout(() => end(new AgentMuxError('Finite intent was cut by a transport stopwatch.', 'CONTROL_TIMEOUT')), 2_000); return; }",
    assertion: 'SSH response transit cannot masquerade as a failed short business intent', test: testFiles[4] },
  { name: 'ephemeral-store-claims-durable-runtime-identity', file: 'headless-runtime.js',
    original: 'if (storePath !== null)\n            try {', changed: 'if (true)\n            try {', assertion: 'promise resolved', test: testFiles[0] },
  { name: 'offline-sdk-read-demands-native-reconnect', file: 'hosted-runtime-service.js',
    original: 'if (!OFFLINE_METHODS.has(invocation.method))', changed: 'if (true)', assertion: 'promise rejected', test: testFiles[7] },
  { name: 'marker-shaped-ordinary-record-loses-identity', file: 'hosted-value.js',
    original: "if (Object.hasOwn(value, '$agentmuxValue'))", changed: 'if (false)', assertion: 'expected', test: testFiles[9] },
  { name: 'same-consumer-receives-duplicated-semantic-events', file: 'hosted-runtime-service.js',
    original: 'reader.eventDestination ?? reader', changed: 'reader', assertion: 'expected', test: testFiles[5] },
  { name: 'closed-consumer-admits-late-sdk-prompt', file: 'hosted-runtime-service.js',
    original: 'if (this.consumer(id) !== original)', changed: 'if (false)', assertion: 'promise resolved', test: testFiles[5] },
  { name: 'typed-prompt-cancellation-field-is-not-forwarded', file: 'hosted-client.js',
    original: 'if (isAbortSignal(input.signal))', changed: 'if (false)', assertion: 'expected', test: testFiles[5] },
  { name: 'foreign-native-source-replaces-history-window', file: 'hosted-client.js',
    original: 'if (read.source && (read.source.providerId !== value.source.providerId || read.source.nativeSessionId !== value.source.nativeSessionId))',
    changed: 'if (false)', assertion: 'a foreign native source cannot replace the original history window', test: testFiles[5] },
  { name: 'explicit-sdk-refresh-operation-identity-is-lost', file: 'hosted-runtime-service.js',
    original: '...(refresh && operationId !== undefined ? [operationId] : [])', changed: '...(refresh && operationId !== undefined ? [undefined] : [])',
    assertion: 'expected', test: testFiles[5] }
,
  { name: 'endpoint-retry-diagnostic-contaminates-agent-errors', file: 'hosted-client.js',
    original: "connectionState(reconnectAttempts >= 8 ? 'unrecoverable' : 'lost', error)",
    changed: "emit({ type: 'agent-error', code: error.code, message: error.message, evidence: { source: 'agentmux', observedAt: Date.now() } })",
    assertion: 'expected', test: testFiles[5] }
,
  { name: 'one-endpoint-loss-repeats-its-state-transition', file: 'hosted-client.js',
    original: 'if (connectionPhase === state)', changed: 'if (false)', assertion: 'one endpoint loss has one state transition even when its retry fails', test: testFiles[5] },
  { name: 'initial-endpoint-confirmation-does-not-settle-service-window', file: 'hosted-client.js',
    original: 'else if (connectionPhase !== undefined)', changed: 'else if (false)',
    assertion: 'first confirmation settles its original endpoint service window', test: testFiles[5] },
  { name: 'native-restored-event-leaves-a-stale-input-fence', file: 'hosted-client.js',
    original: 'bootstrap.identity = structuredClone(restored.ctxmux);', changed: 'void restored.ctxmux;',
    assertion: 'the same Hosted stream carries the current Native identity before a new input fence', test: testFiles[2] }

]
const results = []
const run = async (label, selected = testFiles) => {
  const reportPath = join(receiptDirectory, `${label}.json`)
  let result
  try { const output = await execute(process.execPath, [...args, ...selected, '--maxWorkers=1', '--reporter=json', '--outputFile', reportPath], { cwd: shadow,
    env: { ...process.env, AGENTMUX_TEST_OWNER_ENTRY: join(shadowCore, 'test/fixtures/headless-runtime-worker.mjs'),
      AGENTMUX_TEST_CLIENT_ENTRY: join(shadowCore, 'dist/hosted-client.js'), AGENTMUX_TEST_SERVICE_ENTRY: join(shadowCore, 'dist/hosted-runtime-service.js'),
      AGENTMUX_TEST_PUBLIC_RPC_SERVICE_ENTRY: join(shadowCore, 'dist/public-rpc-service.js'),
      AGENTMUX_TEST_RPC_CLIENT_ENTRY: join(shadowCore, 'dist/public-rpc-client.js'),
      AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY: join(shadowCore, 'dist/runtime-client.js') },
    maxBuffer: 8 * 1024 * 1024 }); result = { exitCode: 0, output: output.stdout + output.stderr } }
  catch (error) { result = { exitCode: typeof error.code === 'number' ? error.code : -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  await writeFile(join(receiptDirectory, `${label}.log`), result.output)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert(selected.length > 0, `${label}: the owning product scope must be nonempty.`)
  assert.deepEqual(report.testResults.map(file => file.name).sort(), selected.map(file => resolve(shadow, file)).sort(), `${label}: all exact owning product files must be collected.`)
  for (const file of report.testResults) {
    const executed = file.assertionResults.filter(item => ['passed', 'failed'].includes(item.status)).map(item => item.fullName).sort()
    assert(executed.length > 0, `${label}: ${file.name} must execute actual consumer assertions.`)
    if (label === 'baseline') baselineCases.set(file.name, executed)
    else assert.deepEqual(executed, baselineCases.get(file.name), `${label}: the exact baseline consumer cases must execute without an empty/skipped/setup-only suite.`)
  }
  const count = selected.reduce((total, file) => total + baselineCases.get(resolve(shadow, file)).length, 0)
  assert.equal(report.numTotalTests, count)
  if (selected.length === testFiles.length) assert.equal(count, 56, `${label}: all fifty-six owning product behaviors must execute.`)
  assert.equal(report.numPendingTests, 0)
  result.failures = report.testResults.flatMap(file => file.assertionResults.filter(item => item.status === 'failed').map(item => ({ file: file.name, name: item.fullName, messages: item.failureMessages })))
  return result
}
try {
  await mkdir(shadowCore, { recursive: true })
  // Keep the normal freshness guard against this immutable consumed candidate.
  // Preserve producer timestamps; copying an old build cannot make it fresh.
  for (const file of ['vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts', 'tsconfig.base.json']) {
    await cp(join(workspace, file), join(shadow, file), { preserveTimestamps: true })
  }
  for (const packageName of ['core', 'demand']) {
    const target = join(shadow, 'packages', packageName), original = join(workspace, 'packages', packageName)
    await mkdir(target, { recursive: true })
    for (const file of ['src', 'dist', 'package.json']) await cp(join(original, file), join(target, file), { recursive: true, preserveTimestamps: true })
  }
  await cp(join(core, 'test'), join(shadowCore, 'test'), { recursive: true, preserveTimestamps: true })
  await cp(join(core, 'bin'), join(shadowCore, 'bin'), { recursive: true, preserveTimestamps: true })
  for (const [file, sha256] of Object.entries(sources)) assert.equal(digest(await readFile(join(shadowCore, 'src', file))), sha256, `${file}: producer changed while capturing its candidate.`)
  for (const [file, sha256] of Object.entries(tests)) assert.equal(digest(await readFile(join(shadow, file))), sha256, `${file}: owning oracle changed while capturing its candidate.`)
  await symlink(join(workspace, 'node_modules'), join(shadow, 'node_modules'), 'dir')
  await symlink(join(core, 'node_modules'), join(shadowCore, 'node_modules'), 'dir')
  await symlink(join(core, 'vendor'), join(shadowCore, 'vendor'), 'dir')
  assert.equal((await run('baseline')).exitCode, 0, 'Actual private Runtime baseline must be green before mutation.')
  for (const mutant of mutants) {
    const path = join(shadowCore, 'dist', mutant.file)
    const original = await readFile(path, 'utf8')
    assert(original.includes(mutant.original), `${mutant.name}: emitted implementation anchor must exist.`)
    assert.equal(original.split(mutant.original).length, 2, `${mutant.name}: anchor must identify exactly one block.`)
    const changed = original.replace(mutant.original, mutant.changed)
    await writeFile(path, changed)
    assert(mutant.test, `${mutant.name}: each production block must declare its exact owning file.`)
    const selected = [mutant.test]
    const red = await run(mutant.name, selected)
    assert.notEqual(red.exitCode, 0, `${mutant.name}: changing this actual owner block must turn its consumer test red.`)
    const targetAssertions = red.failures.filter(item => (!mutant.test || item.file === resolve(shadow, mutant.test)) &&
      item.messages.some(message => message.includes('AssertionError') && message.includes(mutant.assertion)))
    assert(targetAssertions.length > 0, `${mutant.name}: the exact target behavior must fail an AssertionError, not setup/compilation or an incidental exception.`)
    await writeFile(path, original)
    const restored = await run(`${mutant.name}-restored`, selected)
    assert.equal(restored.exitCode, 0, `${mutant.name}: the identical delivered source must restore green.`)
    assert.equal(digest(await readFile(path)), digest(original))
    results.push({ name: mutant.name, file: mutant.file, originalSha256: digest(original), mutantSha256: digest(changed),
      redExitCode: red.exitCode, restoredExitCode: restored.exitCode, targetAssertions,
      owningFile: mutant.test, owningCases: baselineCases.get(resolve(shadow, mutant.test)) })
  }
  assert.equal((await run('final-restored')).exitCode, 0, 'All fifty-six product behaviors must remain green after every emitted block is restored.')
  // Product consumers are taken from real source references, excluding each definition and all tests.
  const callerSpecs = [
    ['connectHostedAgentMux', 'packages/core/src/hosted-client.ts'],
    ['startHeadlessAgentMux', 'packages/core/src/headless-runtime.ts'],
    ['AgentMuxHostedRuntimeService', 'packages/core/src/hosted-runtime-service.ts']
  ]
  const callers = []
  for (const [symbol, definition] of callerSpecs) {
    const output = await execute('rg', ['-n', symbol, 'packages/core/src', 'apps/desktop/src/main', 'apps/host/src'], { cwd: workspace })
    const lines = output.stdout.trim().split('\n').filter(line => !line.startsWith(`${definition}:`) &&
      !line.startsWith('packages/core/src/index.ts:') && !line.includes('import ') && !line.includes('export '))
    assert(lines.length > 0, `${symbol}: there must be a production consumer beyond definition/export/import.`)
    callers.push({ symbol, callsites: lines })
  }
  const currentSourceMatchesCandidate = (await Promise.all(Object.entries(sources).map(async ([file, sha256]) =>
    digest(await readFile(join(core, 'src', file))) === sha256))).every(Boolean)
  const currentOracleMatchesCandidate = (await Promise.all(Object.entries(tests).map(async ([file, sha256]) =>
    digest(await readFile(join(workspace, file))) === sha256))).every(Boolean)
  const receipt = { schema: 'agentmux.headless-runtime-port-verification.v1', status: 'qualified',
    platform: `${process.platform}-${process.arch}`, node: process.version, command: [process.execPath, ...args, ...testFiles, '--maxWorkers=1'],
    perBlockScope: 'exact owning cases derived from the full nonempty baseline; full product baseline and final restoration retained',
    verificationScriptSha256: digest(await readFile(resolve(import.meta.filename))),
    sources, tests, currentOracleMatchesCandidate, mutants: results, callers, privateOrdinaryOwner: true, officialCtxmux: true,
    immutableConsumedCandidate: true, ordinaryFreshnessGuardPreserved: true, currentSourceMatchesCandidate, sharedDistWasNotMutated: true }
  await writeFile(join(receiptDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ status: receipt.status, receipt: join(receiptDirectory, 'receipt.json') }))
} finally { await rm(shadow, { recursive: true, force: true }) }
