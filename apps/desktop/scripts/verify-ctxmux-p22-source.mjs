import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat, symlink, readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/ctxmux-p22-qualification')
await mkdir(evidence, { recursive: true })
const input = JSON.parse(await readFile(join(evidence, 'input.json'), 'utf8'))
assert.equal(input.candidate, root); assert.equal(input.protocol, 22); assert.equal(input.producerPassed, true)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const artifactRoot = join(root, 'packages/core/vendor/ctxmux/darwin-arm64')
const manifestBytes = await readFile(join(artifactRoot, 'manifest.json')), manifest = JSON.parse(manifestBytes)
assert.equal(hash(manifestBytes), input.manifestSha256); assert.equal(manifest.source.commit, input.sourceCommit)
assert.equal(manifest.product.protocol, 22); assert.equal(manifest.sdk.protocol, 22); assert.equal(manifest.source.worktree_clean, true)
for (const descriptor of [...manifest.binaries, manifest.sdk.archive]) {
  const path = join(artifactRoot, descriptor.path), bytes = await readFile(path), metadata = await stat(path)
  assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256)
  assert.equal((metadata.mode & 0o777).toString(8).padStart(4, '0'), descriptor.mode)
}
const sdk = await import(pathToFileURL(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
assert.equal(sdk.PROTOCOL_VERSION, 22, 'The actually resolved SDK must match the archive')
const sdkTar = await readFile(join(artifactRoot, manifest.sdk.archive.path))
const integrity = `sha512-${createHash('sha512').update(sdkTar).digest('base64')}`
assert.ok((await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).includes(`resolution: {integrity: ${integrity}, tarball: file:packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz}`))
// Verify loaded module bytes against the selected archive, not just a same-version package label.
const archiveEntries = execFileSync('tar', ['-tzf', join(artifactRoot, manifest.sdk.archive.path)], { encoding: 'utf8' })
  .split('\n').filter(path => path.startsWith('package/dist/') && !path.endsWith('/'))
assert.ok(archiveEntries.length > 0)
for (const entry of archiveEntries) {
  const original = execFileSync('tar', ['-xOzf', join(artifactRoot, manifest.sdk.archive.path), entry])
  assert.equal(hash(await readFile(join(root, 'packages/core/node_modules/@ctxmux/sdk', entry.slice('package/'.length)))), hash(original), `Loaded SDK differs: ${entry}`)
}

async function run(command, args, name, allowFailure = false) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes.toString(); assert.ok(output.length < 16 * 1024 * 1024, 'Bounded proof log exceeded') })
  const exit = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => signal ? fail(new Error(`${name} ended by ${signal}`)) : done(code)) })
  const path = join(evidence, `${name}.log`); await writeFile(path, output)
  if (!allowFailure) assert.equal(exit, 0, `${name} failed; see ${relative(root, path)}`)
  return { exit, output, path: relative(root, path), sha256: hash(output), command: [command, ...args] }
}
const tests = ['packages/core/test/output-gap-evidence.test.ts', 'packages/core/test/p22-output-gap-wire.test.ts',
  'packages/core/test/hosted-output-observer.test.ts', 'packages/core/test/ctxmux-native-service.test.ts',
  'packages/core/test/ctxmux-run-current-size.test.ts', 'packages/core/test/ctxmux-version-binding.test.ts',
  'apps/desktop/test/output-gap-disclosure-survives.test.ts', 'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx']
const production = ['packages/core/src/ctxmux-run-adapter.ts', 'packages/core/src/client.ts', 'packages/core/src/types.ts',
  'packages/core/src/runtime-paths.ts', 'packages/core/src/output-gap-evidence.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/hosted-output-observer.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/vendor/ctxmux/darwin-arm64/manifest.json', 'packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz',
  'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmux', 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/store.ts']
const proofFiles = ['apps/desktop/scripts/verify-ctxmux-p22-source.mjs', 'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/core-gap.mjs',
  'packages/core/scripts/build.mjs', 'pnpm-lock.yaml', 'packages/core/test/helpers/output-gap.ts', ...tests]
async function fingerprints(paths) {
  const result = {}; for (const path of paths) result[path] = hash(await readFile(join(root, path)))
  assert.ok(Object.keys(result).length > 0); return result
}
await run('pnpm', ['--filter', '@agentmux/client-ui...', 'build'], 'build')
await run('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'packages/core/tsconfig.build.json', '--incremental', 'false', '--composite', 'false'], 'production-types')
const consumerRoot = join(evidence, 'public-types'); await mkdir(join(consumerRoot, 'node_modules/@agentmux'), { recursive: true })
try { await symlink(join(root, 'packages/core'), join(consumerRoot, 'node_modules/@agentmux/core')) } catch (error) { if (error.code !== 'EEXIST') throw error }
await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n')
await writeFile(join(consumerRoot, 'consumer.ts'), `import { AgentMuxClient, type AgentMuxAttachmentGapObservation, type AgentMuxOutputGapCauses, type AgentMuxClientEvent } from '@agentmux/core'\ndeclare const client: AgentMuxClient\nclient.onEvent((event: AgentMuxClientEvent) => {\n  if (event.type === 'agent-error' && event.evidence.outputGap?.kind === 'live-stream') {\n    const observation: AgentMuxAttachmentGapObservation = event.evidence.outputGap.observation\n    const causes: AgentMuxOutputGapCauses = event.evidence.outputGap.causes\n    void observation.recoveryAfterByte; void causes.clientViewPressure\n  }\n})\n`)
await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, module: 'NodeNext', target: 'ES2023',
  lib: ['ES2023', 'DOM'], types: [], strict: true, skipLibCheck: false }, files: ['consumer.ts'] }) + '\n')
await run('pnpm', ['exec', 'tsc', '-p', relative(root, join(consumerRoot, 'tsconfig.json'))], 'public-node-free-types')
const testReport = join(evidence, 'tests.json')
await run('pnpm', ['exec', 'vitest', 'run', '--maxWorkers=1', ...tests, '--reporter=json', `--outputFile=${testReport}`], 'tests')
const collected = await json(testReport)
assert.equal(collected.success, true); assert.equal(collected.numFailedTests, 0); assert.ok(collected.numPassedTests > 0)
for (const path of tests) {
  const suite = collected.testResults.find(suite => suite.name === join(root, path))
  assert.ok(suite?.assertionResults.length > 0, `No actual collected assertions: ${path}`)
  assert.ok(suite.assertionResults.every(assertion => assertion.status === 'passed'))
}
const before = await fingerprints([...production, ...proofFiles])
await run(process.execPath, ['apps/desktop/scripts/fixtures/ctxmux-p22-qualification/core-gap.mjs'], 'actual-core-gap')
const native = await json(join(evidence, 'core-gap-runtime.json'))
assert.equal(native.passed, true); assert.equal(native.userRuntimeTouched, false)
assert.equal(native.sourceCommit, input.sourceCommit); assert.equal(native.nativeIdentity.protocolGeneration, 22)
assert.equal(native.cleanup.rootRemoved, true); assert.deepEqual(native.cleanup.remaining, [])
assert.ok(native.liveEvents > 0 && native.inputReceipts.length > 0); assert.equal(native.orderedLiveBeforeGap, true)

const gapTest = 'packages/core/test/output-gap-evidence.test.ts', wireTest = 'packages/core/test/p22-output-gap-wire.test.ts'
const mutations = [
  { name: 'sdk-runtime-identity', source: 'packages/core/src/ctxmux-run-adapter.ts', test: gapTest, title: 'keeps complete daemon SDK facts at the public publisher',
    before: 'daemonInstanceId: observation.runtime.daemonInstanceId', after: 'daemonInstanceId: observation.runtime.runtimeId' },
  { name: 'sdk-cause', source: 'packages/core/src/ctxmux-run-adapter.ts', test: gapTest, title: 'keeps complete daemon SDK facts at the public publisher',
    before: 'sourceDiscontinuity: causes.source_discontinuity', after: 'sourceDiscontinuity: false' },
  { name: 'sdk-recovery-baseline', source: 'packages/core/src/ctxmux-run-adapter.ts', test: gapTest, title: 'keeps complete daemon SDK facts at the public publisher',
    before: 'recoveryAfterByte: observation.recoveryAfterByte', after: 'recoveryAfterByte: event.latest_output_bytes' },
  { name: 'primary-publisher-unknown', source: 'packages/core/src/client.ts', test: gapTest, title: 'keeps complete daemon SDK facts at the public publisher',
    before: '            observation: event.observation\n', after: '            observation: { ...event.observation, missingOutputBytes: 0 }\n' },
  { name: 'independent-publisher-boundary', source: 'packages/core/src/client.ts', test: wireTest, title: 'preserves the independent public Core output reader evidence through agent.output',
    before: "              publishedThroughByte, representation: 'raw', causes: event.causes", after: "              publishedThroughByte: null, representation: 'raw', causes: event.causes" },
  { name: 'rpc-gap-run-binding', source: 'packages/core/src/output-gap-evidence.ts', test: wireTest, title: 'rejects foreign-run on the actual Runtime RPC edge without touching the owner',
    before: '  if (o.runId !== run!.runId) fail()', after: '  if (false) fail()' },
  { name: 'rpc-independent-evidence', source: 'packages/core/src/public-rpc-service.ts', test: wireTest, title: 'preserves the independent public Core output reader evidence through agent.output',
    before: 'message: event.message, evidence: event.evidence', after: 'message: event.message, evidence: undefined' },
  { name: 'hosted-independent-evidence', source: 'packages/core/src/hosted-output-observer.ts', test: wireTest, title: 'preserves the independent reader Gap through the public hosted Core API',
    before: '      evidence: evidence ?? {', after: '      evidence: {' },
  { name: 'mounted-unknown-loss', source: 'apps/desktop/src/renderer/src/lib/session-state.ts', test: 'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx', title: 'discloses daemon Gap facts through the real Main/preload/Store and mounted notice',
    before: "decoded output missed by this observation: ${o.missingOutputBytes ?? 'unknown'}", after: 'decoded output missed by this observation: ${o.missingOutputBytes ?? 0}' }
]
const mutationReceipts = []
await writeFile(join(evidence, 'source-mutations.json'), JSON.stringify({ passed: false, mutations: [] }, null, 2) + '\n')
for (const mutation of mutations) {
  const path = join(root, mutation.source), original = await readFile(path), source = original.toString('utf8')
  assert.equal(source.split(mutation.before).length - 1, 1, `Ambiguous mutation: ${mutation.name}`)
  const broken = source.replace(mutation.before, mutation.after)
  assert.notEqual(hash(broken), hash(original))
  const command = ['exec', 'vitest', 'run', '--maxWorkers=1', mutation.test, '-t', mutation.title, '--reporter=default', '--reporter=json']
  let red
  try {
    await writeFile(path, broken)
    if (mutation.source.startsWith('packages/core/')) await run('pnpm', ['--filter', '@agentmux/core...', 'build'], `${mutation.name}-red-build`)
    const report = join(evidence, `${mutation.name}-red.json`)
    red = await run('pnpm', [...command, `--outputFile=${report}`], `${mutation.name}-red`, true)
    const result = await json(report), assertions = result.testResults.flatMap(suite => suite.assertionResults)
    assert.notEqual(red.exit, 0); assert.equal(result.numFailedTests, 1)
    assert.equal(assertions.filter(item => item.status === 'failed').length, 1)
    assert.ok(red.output.includes('AssertionError:'), 'Setup or timeout alone is not behavior RED')
    const failed = assertions.find(item => item.status === 'failed')
    assert.ok(failed.fullName.includes(mutation.title)); assert.ok(failed.failureMessages.some(message => message.includes('AssertionError:')))
  } finally {
    await writeFile(path, original)
    assert.equal(hash(await readFile(path)), hash(original), 'Exact source bytes must be restored')
    if (mutation.source.startsWith('packages/core/')) await run('pnpm', ['--filter', '@agentmux/core...', 'build'], `${mutation.name}-restored-build`)
  }
  const greenReport = join(evidence, `${mutation.name}-green.json`)
  const green = await run('pnpm', [...command, `--outputFile=${greenReport}`], `${mutation.name}-green`)
  const result = await json(greenReport)
  assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 0)
  mutationReceipts.push({ name: mutation.name, source: mutation.source, test: mutation.test, title: mutation.title,
    sourceSha256: hash(original), mutatedSha256: hash(broken), restoredSha256: hash(await readFile(path)),
    testSha256: hash(await readFile(join(root, mutation.test))), red: true, green: true,
    redLog: red.path, redLogSha256: red.sha256, greenLog: green.path, greenLogSha256: green.sha256,
    redReport: `.tmp/ctxmux-p22-qualification/${mutation.name}-red.json`,
    redReportSha256: hash(await readFile(join(evidence, `${mutation.name}-red.json`))),
    greenReport: relative(root, greenReport), greenReportSha256: hash(await readFile(greenReport)),
    command: green.command, before: mutation.before, after: mutation.after })
  await writeFile(join(evidence, 'source-mutations.json'), JSON.stringify({ passed: false, mutations: mutationReceipts }, null, 2) + '\n')
  console.log(`Production mutation ${mutation.name}: assertion RED, exact restore GREEN.`)
}
assert.equal(mutationReceipts.length, mutations.length)
await writeFile(join(evidence, 'source-mutations.json'), JSON.stringify({ passed: true, mutations: mutationReceipts }, null, 2) + '\n')
const callerSpecs = [
  { path: 'packages/core/src/client.ts', expression: /observation: event\.observation/u, role: 'Both original Core publishers consume the SDK adapter facts', test: gapTest },
  { path: 'packages/core/src/public-rpc-client.ts', expression: /parseOutputGapEvidence\(/u, role: 'The original public receiving edge validates Gap evidence', test: wireTest },
  { path: 'packages/core/src/public-rpc-service.ts', expression: /message: event\.message, evidence: event\.evidence/u, role: 'The independent public output DTO retains original Core evidence', test: wireTest },
  { path: 'packages/core/src/hosted-client.ts', expression: /const output = createHostedOutputObservation\(/u, role: 'The original hosted reader consumes the same public output lease', test: wireTest },
  { path: 'apps/desktop/src/main/runtime-controller.ts', expression: /this\.publish\(prepared\.id, event\)/u, role: 'The original Main subscription forwards Core events', test: 'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx' },
  { path: 'apps/desktop/src/renderer/src/store.ts', expression: /runtimeDiagnosticNotice\((?:get\(\)|useAppStore\.getState\(\))/u, role: 'The original service-window consumer uses Gap evidence', test: 'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx' }
]
const callers = []
for (const spec of callerSpecs) {
  const source = await readFile(join(root, spec.path), 'utf8')
  const found = source.split('\n').flatMap((line, index) => !/^\s*(?:import|export|\/\/)/u.test(line) && spec.expression.test(line)
    ? [{ path: spec.path, line: index + 1, text: line.trim(), role: spec.role, test: spec.test }] : [])
  assert.ok(found.length > 0, `Missing nondefinition product caller: ${spec.path}`); callers.push(...found)
}
const after = await fingerprints([...production, ...proofFiles]); assert.deepEqual(after, before, 'Source changed during proof')
const compiledFiles = []
for (const path of ['packages/core/dist', 'packages/client-ui/dist']) {
  for (const entry of await readdir(join(root, path), { recursive: true, withFileTypes: true })) if (entry.isFile()) compiledFiles.push(relative(root, join(entry.parentPath, entry.name)))
}
assert.ok(compiledFiles.length > 0)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const receipt = { schema: 'agentmux.ctxmux-p22-source.v1', passed: true, userRuntimeTouched: false,
  protocol: 22, sourceCommit: input.sourceCommit, candidateCommit: commit,
  candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  inputSha256: hash(await readFile(join(evidence, 'input.json'))), manifestSha256: hash(manifestBytes),
  loadedSdkFiles: archiveEntries.length, nativeIdentity: native.nativeIdentity, nativeExecutableSha256: native.nativeExecutableSha256,
  actualCoreGap: { receipt: '.tmp/ctxmux-p22-qualification/core-gap-runtime.json', sha256: hash(await readFile(join(evidence, 'core-gap-runtime.json'))),
    cause: native.gap.evidence.outputGap.causes, origins: native.gap.evidence.outputGap.observation.origins, replay: native.exactReplay },
  tests: { passed: collected.numPassedTests, files: tests, sha256: hash(await readFile(testReport)) },
  publicTypes: { nodeAmbientTypes: false, consumerSha256: hash(await readFile(join(consumerRoot, 'consumer.ts'))) },
  callers, mutations: mutationReceipts, sourceInputs: after, compiledInputs: await fingerprints(compiledFiles), cleanup: native.cleanup }
await writeFile(join(evidence, 'source.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(`P22 source passed: ${collected.numPassedTests} narrow tests, actual Core Gap and ${mutationReceipts.length} finite production mutations.`)
