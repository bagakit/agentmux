import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), core = join(root, 'packages/core')
const require = createRequire(join(core, 'package.json')), exec = promisify(execFile)
const native = process.env.AGENTMUX_TEST_CODEX_EXECUTABLE ?? join(homedir(), '.codex/packages/app-server-daemon/releases',
  `0.163.0-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin/bin/codex`)
const evidencePath = process.env.AGENTMUX_FRONTEND_STARTUP_EVIDENCE
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function sources(path) {
  const values = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) Object.assign(values, await sources(file))
    else values[file.slice(root.length + 1)] = digest(await readFile(file))
  }
  return values
}
const related = ['apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/lib/session-recovery-banner.ts', 'apps/desktop/test/session-startup-service-window.test.tsx',
  'apps/desktop/scripts/verify-session-startup-service-window.mjs', 'apps/desktop/test/session-startup-service-window.config.mts', 'apps/desktop/src/renderer/src/lib/initial-native-composer-binding.ts', 'apps/desktop/src/renderer/src/store.ts',
  'packages/core/test/frontend-startup-continuity.integration.test.ts', 'packages/core/test/frontend-startup-continuity.config.mts',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/helpers/codex-offline-endpoint.ts',
  'packages/core/test/helpers/private-codex-config.ts', 'packages/core/scripts/verify-frontend-startup-continuity.mjs']
const candidateSources = async () => ({ ...await sources(join(core, 'src')),
  ...Object.fromEntries(await Promise.all(related.map(async path => [path, digest(await readFile(join(root, path)))]))) })
if (process.env.AGENTMUX_REUSE_SOURCE_BOUND_PROOF === '1') {
  assert.ok(evidencePath, 'The original integrated receipt path is required')
  const proof = JSON.parse(await readFile(evidencePath, 'utf8'))
  assert.equal(proof.passed, true); assert.equal(proof.sourceStable, true); assert.equal(proof.userRuntimeTouched, false)
  assert.deepEqual(proof.sources, await candidateSources(), 'Integrated candidate or consumer sources changed')
  assert.deepEqual(proof.consumers.map(row => row.mode).sort(), ['creation', 'empty', 'manual'])
  for (const row of proof.consumers) {
    assert.equal(row.firstLaunchNoExit, true); assert.equal(row.samePid, true); assert.equal(row.sameSpatialStateAcrossOwner, true)
    assert.equal(row.frontendCount, 2); assert.equal(row.activeSupervisionCount, 1); assert.equal(row.nativeUserInputCount, 2)
    assert.equal(row.actualRejoinedTuiInput, true); assert.equal(row.userRuntimeTouched, false)
    if (row.mode === 'empty') assert.equal(row.emptyUnknownHistory, true)
  }
  const mutant = proof.identityMutation
  assert.notEqual(mutant.code, 0); assert.match(mutant.candidateSHA256, /^[a-f0-9]{64}$/u)
  assert.match(mutant.mutantSHA256, /^[a-f0-9]{64}$/u); assert.notEqual(mutant.candidateSHA256, mutant.mutantSHA256)
  assert.equal(mutant.loadedFile, 'dist/agent-session-recovery/reconciliation.js')
  assert.ok(mutant.failures.some(test => test.messages.some(message => message.includes('AssertionError') && message.includes('Empty creation'))))
  console.log('Integrated source-bound Native/TUI consumer proof PASS'); process.exit(0)
}
assert.equal((await exec(native, ['--version'])).stdout.trim(), 'codex-cli 0.163.0', 'Qualification requires the declared managed-create protocol')
const directory = join(core, '.tmp/frontend-startup-continuity'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), pkg = join(attempt, 'package')
const receipt = { schema: 'agentmux.frontend-startup-continuity-proof.v1', native,
  nativeVersion: 'codex-cli 0.163.0', nativeSHA256: digest(await readFile(native)),
  passed: false, userRuntimeTouched: false, sources: await candidateSources() }
try {
  await exec('pnpm', ['--filter', '@agentmux/core...', 'build'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
  const builtSources = await sources(join(core, 'src'))
  for (const [path, hash] of Object.entries(builtSources)) assert.equal(hash, receipt.sources[path], 'Production source changed during the package build: ' + path)
  receipt.sources = await candidateSources()
  await mkdir(pkg)
  for (const name of ['dist', 'bin', 'src', 'package.json']) await cp(join(core, name), join(pkg, name), { recursive: true })
  for (const name of ['vendor', 'node_modules']) await symlink(join(core, name), join(pkg, name))
  const owner = join(attempt, 'owner.mjs'), entry = pathToFileURL(join(pkg, 'dist/index.js')).href
  await writeFile(owner, `import {join} from 'node:path';import {startHeadlessAgentMux} from ${JSON.stringify(entry)};
const owner=await startHeadlessAgentMux({socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock')});
process.stdout.write(JSON.stringify({owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\\n');
process.once('SIGTERM',()=>{void owner.stop()});\n`)
  const report = join(attempt, 'tests.json'), proof = join(attempt, 'consumer.ndjson')
  let result
  try {
    result = await exec(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config',
      'packages/core/test/frontend-startup-continuity.config.mts', '--reporter=default', '--reporter=json', '--outputFile=' + report], {
      cwd: root, maxBuffer: 8 * 1024 * 1024, env: { ...process.env,
        AGENTMUX_NATIVE_STARTUP_CORE_ENTRY: entry, AGENTMUX_TEST_CODEX_EXECUTABLE: native,
        AGENTMUX_TEST_OWNER_ENTRY: owner, AGENTMUX_TEST_OBJECT_CLI: join(pkg, 'bin/amux'), AGENTMUX_FRONTEND_STARTUP_CONSUMER: proof }
    })
  } catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error }
  process.stdout.write(result.stdout)
  const tests = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(tests.numPassedTests, 3); assert.equal(tests.numFailedTests, 0)
  receipt.consumers = (await readFile(proof, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(receipt.consumers.length, 3)
  const compiled = join(pkg, 'dist/agent-session-recovery/reconciliation.js')
  const originalCompiled = await readFile(compiled, 'utf8')
  const needle = 'const needsIdentity = controlled && !session.nativeHandle;'
  assert.equal(originalCompiled.split(needle).length, 2, 'The compiled production identity owner must be the loaded mutation target')
  const mutantCompiled = originalCompiled.replace(needle, 'const needsIdentity = false;')
  await writeFile(compiled, mutantCompiled)
  let mutantResult
  const mutantReport = join(attempt, 'identity-mutant.json')
  try {
    await exec(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config',
      'packages/core/test/frontend-startup-continuity.config.mts', '-t', 'later empty frontend', '--reporter=json', '--outputFile=' + mutantReport], {
      cwd: root, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AGENTMUX_NATIVE_STARTUP_CORE_ENTRY: entry,
        AGENTMUX_TEST_CODEX_EXECUTABLE: native, AGENTMUX_TEST_OWNER_ENTRY: owner, AGENTMUX_TEST_OBJECT_CLI: join(pkg, 'bin/amux'),
        AGENTMUX_FRONTEND_STARTUP_CONSUMER: '' } })
    mutantResult = { code: 0 }
  } catch (error) { mutantResult = { code: error.code } }
  finally { await writeFile(compiled, originalCompiled) }
  const mutantTests = JSON.parse(await readFile(mutantReport, 'utf8'))
  const failures = mutantTests.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  assert.notEqual(mutantResult.code, 0); assert.equal(mutantTests.numFailedTests, 1)
  assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') && message.includes('Empty creation'))))
  receipt.identityMutation = { name: 'drop-empty-native-identity', code: mutantResult.code,
    loadedFile: 'dist/agent-session-recovery/reconciliation.js', candidateSHA256: digest(originalCompiled),
    mutantSHA256: digest(mutantCompiled), failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) }
  receipt.sourceStable = JSON.stringify(await candidateSources()) === JSON.stringify(receipt.sources)
  assert.ok(receipt.sourceStable, 'Candidate sources changed during qualification')
  receipt.passed = true
} catch (error) {
  receipt.error = error.message
  throw error
} finally {
  if (evidencePath) { await mkdir(dirname(resolve(evidencePath)), { recursive: true }); await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + '\n') }
  await rm(attempt, { recursive: true, force: true })
}
