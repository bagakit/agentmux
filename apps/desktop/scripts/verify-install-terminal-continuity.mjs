import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'))
const root = resolve(import.meta.dirname, '../../..'), fixture = 'apps/desktop/scripts/fixtures/install-terminal-continuity'
const evidence = resolve(process.env.AGENTMUX_INSTALL_TERMINAL_EVIDENCE ?? join(root, '.local/state/install-terminal-continuity', randomUUID()))
await mkdir(evidence, { recursive: true })
const installer = 'apps/desktop/scripts/package-macos.mjs', native = 'apps/desktop/scripts/package-runtime-upgrade.mjs'
const files = [installer, native, 'apps/desktop/test/package-install-workbench-continuity.test.ts', ...['vitest.config.mts', 'core-observation.ts', 'source-loader.mjs', 'native.mjs'].map(f => fixture + '/' + f), 'apps/desktop/scripts/verify-install-terminal-continuity.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { passed: false, source: await hashes(), cases: [], userAppOrRunTouched: false,
  scope: 'Actual installApplication/qualifyUi/transaction with controlled external OS/app observations, actual fenced helper child; separate packaged private Native proves authoritative old/new/cwd reads. No build/package/reinstall.' }
async function child(args, env, label) {
  const result = await new Promise((yes, no) => {
    const process = spawn(globalThis.process.execPath, args, { cwd: root, env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; process.stdout.on('data', b => output += b); process.stderr.on('data', b => output += b)
    process.once('error', no); process.once('close', (exit, signal) => yes({ exit, signal, output }))
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  return result
}
async function tests(label, mutation, pattern) {
  const loaded = join(evidence, label + '.loaded.ndjson'), reportPath = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const run = await child(['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + '/vitest.config.mts', '--reporter=json', '--outputFile=' + reportPath,
    ...(pattern ? ['--testNamePattern', pattern] : [])], { INSTALL_TERMINAL_LOADED: loaded, INSTALL_TERMINAL_MUTANT: mutation ? JSON.stringify(mutation) : '' }, label)
  const report = JSON.parse(await readFile(reportPath, 'utf8')), graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(run.signal, null); assert.equal(report.testResults.length, 1); assert.ok(report.numTotalTests >= 81)
  assert.ok(graph.some(row => row.file === installer)); assert.ok(graph.some(row => row.file === native))
  if (mutation) {
    assert.ok(run.exit > 0 && report.numFailedTests > 0, 'The actual product mutant must fail its behavior assertions')
    assert.ok(report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/.test(message)))))
    const original = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(original.split(mutation.before).length, 2)
    assert.ok(graph.some(row => row.file === mutation.file && row.sha256 === hash(original.replace(mutation.before, mutation.after))), 'Exact actual product mutant loaded')
  } else { assert.equal(run.exit, 0, run.output); assert.equal(report.numFailedTests, 0); assert.ok(report.numPassedTests > 0) }
  receipt.cases.push({ label, exit: run.exit, passed: report.numPassedTests, failed: report.numFailedTests, loaded, reportPath })
}
try {
  await tests('baseline')
  if (process.argv.includes('--mutations')) {
    const mutations = [
      { label: 'terminal-run-as-durable-session', file: installer, before: 'const { sessionId, control, processState, ...descriptor } = region', after: 'const { control, processState, ...descriptor } = region', pattern: 'admits only proven' },
      { label: 'unwired-native-qualification', file: installer, before: 'await confirmUiTerminalRebindings(runtimePlan, confirmation, before, observed)', after: '[]', pattern: 'unproven replacement cwd' },
      { label: 'unproved-native-state-and-cwd', file: native,
        before: "previous.state.type === 'interrupted' && previous.state.reason === 'daemon_restart' && current.state.type === 'running' &&\n      typeof previous.workspacePath === 'string' && previous.workspacePath.length > 0 && current.workspacePath === previous.workspacePath",
        after: 'true', pattern: 'unproven replacement cwd' },
      { label: 'healthy-run-fence', file: installer, before: "(region.kind === 'agent' || region.kind === 'terminal') && region.processState === 'running'", after: 'false', pattern: 'keeps healthy Run qualification for different Run' }
    ]
    for (const mutation of mutations) {
      await tests(mutation.label + '-red', mutation, mutation.pattern)
      await tests(mutation.label + '-restored', null, mutation.pattern)
    }
  }
  const nativeReceipt = join(evidence, 'native.json'), loader = pathToFileURL(join(root, fixture, 'source-loader.mjs')).href
  const run = await child(['--experimental-transform-types', '--import=' + loader, fixture + '/native.mjs', nativeReceipt],
    { NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --experimental-transform-types --import=' + loader }, 'native')
  const proof = JSON.parse(await readFile(nativeReceipt, 'utf8'))
  assert.equal(run.exit, 0, run.output + JSON.stringify(proof.error)); assert.equal(proof.passed, true); assert.equal(proof.native.proof.length, 1)
  receipt.native = { receipt: nativeReceipt, sha256: hash(await readFile(nativeReceipt)) }
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.source)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(join(evidence, 'receipt.json')) }
