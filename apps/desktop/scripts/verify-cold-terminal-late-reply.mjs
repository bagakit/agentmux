import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner, sha, proofRoot as root } from './performance-owner-proof.mjs'

const store = 'apps/desktop/src/renderer/src/store.ts'
const focused = 'apps/desktop/test/cold-terminal-late-reply.test.ts'
const nativeTest = 'apps/desktop/test/cold-terminal-late-reply-native.test.tsx'
const oldTest = 'apps/desktop/test/session-launch-lifecycle.test.ts'
const oldTitle = 'keeps a late successful launch discoverable without recreating its closed Tab'
const tests = [focused, 'apps/desktop/test/reusable-shell-disposal.test.tsx', nativeTest]
const owners = [store, 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx',
  'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts']
const inputs = [...owners, ...tests, oldTest, 'apps/desktop/test/cold-terminal-late-reply.tsconfig.json',
  'apps/desktop/test/helpers/first-execution-ipc-bridge.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/reusable-shell-disposal-fixture.ts',
  'apps/desktop/test/helpers/startup-observation-api-fixture.ts',
  'apps/desktop/test/fixtures/reusable-shell-openings/restart-reader.mjs',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/fixtures/headless-runtime-worker.mjs',
  'packages/core/src/client.ts', 'packages/core/dist/index.js', 'packages/core/dist/client.js',
  'packages/core/dist/hosted-client.js', 'packages/core/dist/headless-runtime-cli.js',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`,
  'apps/desktop/scripts/performance-owner-proof.mjs', 'apps/desktop/scripts/verify-cold-terminal-late-reply.mjs',
  'docs/design/behavior/session-recovery.md', 'docs/design/behavior/workface-launcher.md',
  'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json']
const retention = `        set((current) => current.sessions.some((item) => item.id === session.id)
          ? current
          : { sessions: [...current.sessions, session] })`
const ownerGuard = `        !ownsSessionLaunch(launchOwner?.surface, 'terminal', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))`
const mutants = [
  ['late-success-stopped', store, retention, '        await api.sessions.stop(session.control)'],
  ['late-success-discarded', store, retention, '        // Mutant discards confirmed discovery facts.'],
  ['closing-or-replacement-ownership-ignored', store, ownerGuard, '        false'],
  ['unrelated-warm-overwritten', store, retention, '        set({ warmTerminal: null })\n' + retention],
  ['newer-session-facts-overwritten', store, retention, '        set((current) => ({ sessions: [...current.sessions.filter((item) => item.id !== session.id), session] }))']
]
const directory = join(root, '.local/state/cold-terminal-late-reply')
mkdirSync(directory, { recursive: true })
const locator = join(directory, 'qualification.json')
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const env = { ...process.env, pnpm_config_verify_deps_before_run: '' }
function command(name, args) {
  const child = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const log = join(directory, name + '.log')
  writeFileSync(log, (child.stdout ?? '') + (child.stderr ?? ''))
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.ok(Number.isInteger(child.status))
  assert.equal(child.status, 0, `${name} failed; see ${log}`)
  return { exitCode: child.status, log, sha256: sha(readFileSync(log)) }
}
function validate(saved) {
  assert.equal(saved.passed, true)
  assert.deepEqual(saved.inputs, hashes(), 'qualification is for different source/consumer bytes')
  assert.deepEqual(saved.mutants, mutants)
  for (const [path, digest] of Object.entries(saved.rawFiles)) assert.equal(sha(readFileSync(path)), digest, path)
  for (const entry of Object.values(saved.types)) { assert.equal(entry.exitCode, 0); assert.equal(sha(readFileSync(entry.log)), entry.sha256) }
  const receipt = json(saved.ownerReceipt), normal = json(join(saved.ownerDirectory, 'normal.json'))
  assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.runs.map(row => row.name), ['normal', ...mutants.map(row => row[0])])
  assert.equal(normal.numTotalTests, 17); assert.equal(normal.numPassedTests, 17)
  assert.equal(normal.numFailedTests, 0); assert.equal(normal.numPendingTests, 0); assert.equal(normal.numTodoTests, 0)
  for (const path of owners) assert.equal(receipt.runs[0].loadedSources[join(root, path)], saved.inputs[path])
  for (const [name, path, before, after] of mutants) {
    const result = json(join(saved.ownerDirectory, name + '.json'))
    assert.equal(result.numTotalTests, 11); assert.equal(result.numPendingTests, 0); assert.equal(result.numTodoTests, 0)
    assert.ok(result.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))))
    assert.equal(receipt.runs.find(row => row.name === name).loadedSources[join(root, path)], sha(readFileSync(join(root, path), 'utf8').replace(before, after)))
  }
  const old = json(saved.correctedTest)
  assert.equal(old.numPassedTests, 1); assert.equal(old.numFailedTests, 0)
  assert.equal(old.success, true)
  const oldAssertions = old.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(oldAssertions.every(test => test.status === 'passed' || test.status === 'skipped' || test.status === 'pending'))
  const executed = oldAssertions.filter(test => test.status === 'passed' || test.status === 'failed')
  assert.equal(executed.length, 1); assert.equal(executed[0].title, oldTitle); assert.equal(executed[0].status, 'passed')
  const native = json(saved.native), cleanup = json(saved.nativeCleanup)
  assert.equal(native.passed, true); assert.equal(native.private, true); assert.equal(native.originalRuns.length, 2)
  assert.ok(native.originalRuns.some(run => run.runId === native.lateRunId))
  assert.notEqual(native.originalOwner.ownerInstanceId, native.reopenedOwner.ownerInstanceId)
  assert.ok(native.reread.spatial.graph.tabs.length > 0)
  assert.deepEqual(native.reread.runs.map(run => [run.runId, run.pid]), native.originalRuns.map(run => [run.runId, run.pid]))
  assert.ok(native.reread.runs.every(run => run.interactive && run.state === 'running' && run.acceptedInputBytes > 0))
  for (const [path, digest] of Object.entries(native.source)) assert.equal(digest, saved.inputs[path])
  assert.deepEqual(cleanup.remaining, []); assert.equal(cleanup.privateRootRemoved, true); assert.equal(cleanup.userRunTouched, false)
}
if (existsSync(locator)) {
  const saved = json(locator); validate(saved)
  process.stdout.write(JSON.stringify({ passed: true, exactEvidenceReused: true, normal: 18, mutants: mutants.length, receipt: locator }) + '\n')
} else {
  const before = hashes(), stamp = Date.now()
  const types = { desktop: command('desktop-types-formal-' + stamp, ['exec', 'tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json']),
    focused: command('focused-types-formal-' + stamp, ['exec', 'tsc', '--noEmit', '-p', 'apps/desktop/test/cold-terminal-late-reply.tsconfig.json']) }
  const correctedTest = join(directory, 'corrected-lifecycle-' + stamp + '.json')
  const correctedCommand = command('corrected-lifecycle-' + stamp, ['exec', 'vitest', 'run', oldTest, '-t', oldTitle, '--reporter=json', '--outputFile', correctedTest])
  const native = join(directory, 'native-' + stamp + '.json')
  process.env.AGENTMUX_COLD_TERMINAL_NATIVE_RECEIPT = native
  const proof = provePerformanceOwner({ name: 'cold-terminal-late-reply', owners, tests, minimumTests: 17, mutantTests: [focused], mutants,
    callers: [['apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx', 'promoteWarmTerminal(tabGroupId, launcherRef)'],
      [store, 'const opening = get().launchTerminal(tabGroupId, launcher)'], [store, 'async closeRegion(workspaceId, tabId, regionId)'],
      [store, 'selectSession(id, preferredTabGroupId)'], ['apps/desktop/src/main/ipc.ts', 'args.runtime.launchTerminal(input, config)'],
      ['apps/desktop/src/main/runtime-controller.ts', 'client.createTerminal({'], ['packages/core/src/client.ts', 'this.kernel.start({']] })
  const nativeCleanup = native.replace(/\.json$/u, '-cleanup.json')
  const rawPaths = [...readdirSync(proof.directory).map(file => join(proof.directory, file)), correctedTest, correctedCommand.log,
    ...Object.values(types).map(entry => entry.log), native, nativeCleanup]
  const saved = { passed: true, root, inputs: before, mutants, types, correctedTest, ownerDirectory: proof.directory,
    ownerReceipt: join(proof.directory, 'receipt.json'), native, nativeCleanup,
    rawFiles: Object.fromEntries(rawPaths.map(path => [path, sha(readFileSync(path))])),
    boundary: '18 executed normal assertions/cases (17 complete new/regression/native collection plus the one corrected historical case explicitly selected; its unrelated cases are excluded). Five actual Store source mutants fail executed assertions. Actual React NewTabSurface, registered controlled Main/preload and public Unix Core use private original native PTYs; owner/reader process restarts preserve two original Runs/PIDs and nonempty workface. Not whole Desktop/Renderer restart, installation, original 15-second cause, or full Core test-type green. Public control.open.terminal abort semantics remain unchanged.' }
  assert.deepEqual(hashes(), before); validate(saved)
  writeFileSync(locator, JSON.stringify(saved, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, normal: 18, mutants: mutants.length, receipt: locator }) + '\n')
}
