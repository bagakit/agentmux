import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

assert.equal(process.platform, 'darwin', 'This gate must exercise the real Darwin frameworks.')
const root = resolve(import.meta.dirname, '../../..')
const output = join(root, '.local/state/mac-mini-first-run/installer-runtime-dependencies')
await mkdir(output, { recursive: true })
const electron = await realpath(join(root, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
const loader = join(root, 'apps/desktop/test/installer-runtime-node-loader.mjs')
const vitest = join(root, 'packages/core/node_modules/vitest/vitest.mjs')
const config = 'apps/desktop/test/vitest.installer-runtime-dependencies.config.mts'
const inputs = ['apps/desktop/scripts/package-native-observation.mjs', 'apps/desktop/scripts/package-process-scope.mjs',
  'apps/desktop/scripts/package-runtime-upgrade.mjs', 'apps/desktop/test/package-installer-runtime-dependencies.test.ts',
  'apps/desktop/test/package-runtime-upgrade-owner.test.ts', 'apps/desktop/test/installer-runtime-node-loader.mjs',
  'apps/desktop/test/package-process-scope.test.ts', 'apps/desktop/test/package-process-title.test.ts',
  'apps/desktop/test/package-process-slow-probe.test.ts',
  'apps/desktop/test/vitest.installer-runtime-dependencies.config.mts', 'apps/desktop/scripts/verify-macos-installer-runtime-dependencies.mjs']
const digest = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [path,
  createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
const before = await digest(), runs = []
let failure
const lines = async path => (await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' }))
  .split('\n').filter(Boolean).map(line => JSON.parse(line))
async function run(name, { bridge, owner, unit = false } = {}) {
  const loaded = join(output, name + '.loaded.jsonl'), calls = join(output, name + '.calls.jsonl')
  await writeFile(loaded, ''); await writeFile(calls, '')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROCESS_IDENTITY_ELECTRON: electron,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${loader}`.trim(),
    INSTALLER_NATIVE_LOADED: loaded, INSTALLER_NATIVE_CALLS: calls,
    INSTALLER_NATIVE_PRODUCT_PROOF: join(output, name + '.product.json') }
  for (const key of ['INSTALLER_NATIVE_MUTANT', 'INSTALLER_OWNER_MUTANT', 'INSTALLER_RUNTIME_UNIT_ONLY']) delete env[key]
  if (bridge) env.INSTALLER_NATIVE_MUTANT = bridge
  if (owner) env.INSTALLER_OWNER_MUTANT = owner
  if (unit) env.INSTALLER_RUNTIME_UNIT_ONLY = '1'
  const report = join(output, name + '.tests.json')
  const child = spawn(electron, [vitest, 'run', '--config', config,
    '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  await writeFile(join(output, name + '.log'), log)
  const modules = await lines(loaded), operations = await lines(calls)
  const tests = JSON.parse(await readFile(report, 'utf8'))
  const active = tests.testResults.flatMap(file => file.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.equal(active.length, unit ? 81 : 3, 'The exact nonempty installer consumer inventory must execute.')
  assert.ok(modules.some(entry => entry.file.endsWith('/package-process-scope.mjs')), 'The original GUI consumer was not loaded.')
  assert.ok(modules.some(entry => entry.file.endsWith('/package-runtime-upgrade.mjs')), 'The original Runtime consumer was not loaded.')
  if (!unit) assert.ok(modules.some(entry => entry.file.endsWith('/package-native-observation.mjs')), 'The actual native child was not loaded.')
  assert.ok(operations.length > 0, 'An empty child-operation inventory is not proof.')
  assert.ok(operations.every(entry => !/(?:^|\/)(?:python[\d.]*|cc|clang|swift|swiftc|xcrun)$/.test(entry.command)), 'A hidden development runtime was invoked.')
  const mutation = bridge ?? owner
  if (mutation) {
    assert.ok(modules.some(entry => entry.mutant === mutation && entry.originalSHA256 !== entry.loadedSHA256), 'The selected mutant was not loaded.')
    assert.notEqual(result.code, 0, 'The loaded installer mutation unexpectedly passed.')
    assert.match(log, /AssertionError|expected |to be|to equal|CF owner|code identity|architecture/i, 'A setup-only failure is not mutation proof.')
    assert.doesNotMatch(log, /Failed to load|Cannot find module|No test files|Test timed out/, 'A harness failure is not mutation proof.')
  } else {
    assert.equal(result.code, 0, `${name} failed; inspect ${join(output, name + '.log')}`)
    assert.equal(result.signal, null)
    assert.equal(tests.numPassedTests, unit ? 81 : 3)
    assert.equal(tests.numFailedTests, 0)
  }
  const receipt = { name, ...result, mutation: mutation ?? null, moduleCount: modules.length,
    nativeChildPids: [...new Set(modules.filter(entry => entry.file.endsWith('/package-native-observation.mjs')).map(entry => entry.pid))],
    operationCount: operations.length, log: join(output, name + '.log'), loaded, calls }
  runs.push(receipt)
  console.log(`${name}: ${mutation ? 'assertion-red' : 'green'}`)
}
try {
  await run('owner-regressions', { unit: true })
  await run('candidate')
  for (const bridge of ['mode-from-argv', 'wrong-kernel-code', 'skip-cf-release']) await run(bridge, { bridge })
  await run('trust-reader-output', { owner: 'trust-reader-output', unit: true })
} catch (error) { failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
const after = await digest()
const proof = { schema: 'agentmux.installer-runtime-dependencies-proof.v1', passed: !failure && JSON.stringify(before) === JSON.stringify(after),
  electron, runs, inputsBefore: before, inputsAfter: after, failure, userRuntimeTouched: false,
  notes: ['Original Darwin consumers and real Koffi/Security/libproc/sysctl children; Python/toolchain calls are rejected.',
    'Real isolated Native Runtime/Run/PID/replay/input continuity. Formal canonical installation is the integrated delivery task.'] }
await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
console.log(JSON.stringify({ passed: proof.passed, output, runs: runs.length, failure }))
if (!proof.passed) process.exitCode = 1
