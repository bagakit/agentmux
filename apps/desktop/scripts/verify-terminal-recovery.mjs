import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'))
const root = resolve(import.meta.dirname, '../../..'), fixture = 'apps/desktop/scripts/fixtures/terminal-recovery'
const evidence = resolve(process.env.AGENTMUX_TERMINAL_RECOVERY_EVIDENCE ?? join(root, '.local/state/terminal-recovery', randomUUID()))
await mkdir(evidence, { recursive: true })
const product = ['packages/core/src/terminal-recovery-owner.ts', 'packages/core/src/terminal-recovery.ts', 'packages/core/src/client.ts', 'packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/SessionPane.tsx']
const inputs = [...product, 'packages/core/test/terminal-recovery.test.ts', 'apps/desktop/test/terminal-recovery-consumer.test.ts', 'apps/desktop/test/session-recovery-lost-receipt.test.tsx', 'apps/desktop/test/terminal-recovery-native-view.test.tsx',
  ...['vitest.config.mts', 'source-loader.mjs', 'native.mjs', 'worker.mjs'].map(name => fixture + '/' + name), 'apps/desktop/scripts/verify-terminal-recovery.mjs', 'packages/core/src/ctxmux-artifact-contract.json']
const hash = data => createHash('sha256').update(data).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { passed: false, source: await hashes(), cases: [], userAppOrRunTouched: false,
  scope: 'Actual Core durable owner, strict Hosted/public RPC, actual Desktop Main/Store consumers; separate private packaged Native with Core process replacement, real CLI, exact fence continuation and two UI processes preserving original durable Region. No packaging or user actor operations.' }
async function child(args, env, label) {
  const run = await new Promise((yes, no) => {
    const proc = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; proc.stdout.on('data', b => output += b); proc.stderr.on('data', b => output += b)
    proc.once('error', no); proc.once('close', (exit, signal) => yes({ exit, signal, output }))
  })
  await writeFile(join(evidence, label + '.log'), run.output); return run
}
async function tests(label, mutation, pattern, file) {
  const loaded = join(evidence, label + '.loaded.ndjson'), reportPath = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const result = await child(['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + '/vitest.config.mts', ...(file ? [file] : []), '--testNamePattern', pattern ?? 'terminal recovery\\]|recovery receipt:', '--reporter=json', '--outputFile=' + reportPath],
    { AGENTMUX_TERMINAL_RECOVERY_MUTATION: mutation ?? '', AGENTMUX_TERMINAL_RECOVERY_LOADED: loaded }, label)
  const report = JSON.parse(await readFile(reportPath, 'utf8')), graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(result.signal, null)
  assert.equal(report.testResults.length, file ? 1 : 4); assert.ok(report.numTotalTests > 0)
  if (mutation) {
    assert.ok(result.exit > 0 && report.numFailedTests > 0, 'Actual product mutation must be behaviorally RED')
    assert.ok(report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|__VITEST_REJECTS__/u.test(message)))))
    assert.ok(graph.some(row => row.mutation === mutation && row.sha256 !== row.originalSHA256), 'Actual product mutant was loaded')
  } else { assert.equal(result.exit, 0, result.output); assert.equal(report.numFailedTests, 0); assert.ok(report.numPassedTests > 0) }
  receipt.cases.push({ label, exit: result.exit, passed: report.numPassedTests, failed: report.numFailedTests, loaded, reportPath })
}
try {
  // The Runtime publication worker is one existing independent Node entry, not a full Core build.
  const ts = (await import('typescript')).default
  await mkdir(join(root, 'packages/core/dist'), { recursive: true })
  const worker = await readFile(join(root, 'packages/core/src/control-endpoint-listener-worker.ts'), 'utf8')
  await writeFile(join(root, 'packages/core/dist/control-endpoint-listener-worker.js'), ts.transpileModule(worker, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
  await tests('baseline')
  if (process.argv.includes('--mutations')) for (const [mutation, pattern, file] of [
    ['replay-unknown', 'NOT_RETAINED stays unknown', 'packages/core/test/terminal-recovery.test.ts'],
    ['follow-replacement-attempt', 'late .* authority reply', 'packages/core/test/terminal-recovery.test.ts'],
    ['follow-retirement-successor', 'concurrent same continuation', 'packages/core/test/terminal-recovery.test.ts'],
    ['resurrect-retired-attempt', 'cannot undo a confirmed fence', 'packages/core/test/terminal-recovery.test.ts'],
    ['forget-durable-intent', 'lost Start reentry', 'packages/core/test/terminal-recovery.test.ts'],
    ['ignore-original-cwd', 'Core rejects wrong cwd', 'packages/core/test/terminal-recovery.test.ts'],
    ['desktop-new-terminal', 'actual Desktop recovery', 'apps/desktop/test/terminal-recovery-consumer.test.ts'],
    ['stop-late-view', 'late raw Terminal recovery', 'apps/desktop/test/session-recovery-lost-receipt.test.tsx'],
    ['unchecked-hosted-result', 'Hosted rejects extra authority', 'packages/core/test/terminal-recovery.test.ts'],
    ['automatic-continuation', 'actual Pane automatic daemon-restart', 'apps/desktop/test/session-recovery-lost-receipt.test.tsx']
  ]) { await tests(mutation + '-red', mutation, pattern, file); await tests(mutation + '-restored', null, pattern, file) }
  const nativeReceipt = join(evidence, 'native.json')
  const run = await child([fixture + '/native.mjs', nativeReceipt], {}, 'native')
  const proof = JSON.parse(await readFile(nativeReceipt, 'utf8'))
  assert.equal(run.exit, 0, JSON.stringify(proof.error)); assert.equal(proof.passed, true); assert.equal(proof.cleaned, true)
  assert.equal(proof.actual.authority.originalFence.outcome, 'retired'); assert.equal(proof.workbench.sameRegionIds, true)
  receipt.native = { receipt: nativeReceipt, sha256: hash(await readFile(nativeReceipt)) }
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.source)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(join(evidence, 'receipt.json')) }
