import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { provePerformanceOwner, sha, proofRoot as root } from './performance-owner-proof.mjs'
const store = 'apps/desktop/src/renderer/src/store.ts'
const secondary = 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx'
const focused = 'apps/desktop/test/reusable-shell-openings.test.tsx'
const recovery = 'apps/desktop/test/launcher-prewarm-recovery.test.tsx'
const tests = [focused, recovery, 'apps/desktop/test/launcher-prewarm-failure.test.tsx', 'apps/desktop/test/warm-terminal-ownership.test.ts',
  'apps/desktop/test/terminal-create-confirmation-ipc.test.ts', 'apps/desktop/test/reusable-shell-openings-native.test.tsx']
const owners = [store, secondary, 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts']
const inputs = [...owners, ...tests, 'apps/desktop/test/fixtures/reusable-shell-openings/restart-reader.mjs',
  'apps/desktop/test/helpers/first-execution-ipc-bridge.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'packages/core/test/helpers/headless-runtime-fixture.ts',
  'packages/core/test/fixtures/headless-runtime-worker.mjs', 'packages/core/src/client.ts', 'packages/core/dist/client.js',
  'packages/core/dist/index.js', 'packages/core/dist/hosted-client.js', 'packages/core/dist/headless-runtime-cli.js',
  'apps/desktop/scripts/performance-owner-proof.mjs', 'apps/desktop/scripts/verify-launcher-warm-recovery-mutations.mjs',
  'docs/design/behavior/workface-launcher.md', 'apps/desktop/scripts/verify-reusable-shell-openings.mjs']
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))
const directory = join(root, '.local/state/reusable-shell-openings')
mkdirSync(directory, { recursive: true })
const locator = join(directory, 'qualification.json')
const mutants = [
  ['busy-cache-refuses-independent-open', store,
    '      if (state.warmTerminal?.key !== key || state.warmTerminal.claimToken) {',
    "      if (state.warmTerminal?.claimToken) throw new Error('cache is busy')\n      if (state.warmTerminal?.key !== key || state.warmTerminal.claimToken) {"],
  ['duplicate-opening-submits-again', store,
    '    if (existing && (!launcher || surface !== undefined && (surface === existing.surface || surface === existing.pendingSurface))) return existing.promise\n', ''],
  ['removed-target-joins-undefined', store, 'surface !== undefined && (surface === existing.surface || surface === existing.pendingSurface)',
    '(surface === existing.surface || surface === existing.pendingSurface)'],
  ['old-flight-erases-replacement', store,
    '      if (terminalOpeningCalls.get(openingKey) === flight) terminalOpeningCalls.delete(openingKey)',
    '      terminalOpeningCalls.delete(openingKey)'],
  ['settled-failure-retains-flight', store, 'error => { release(); rejectOpening(error) }', 'error => { rejectOpening(error) }'],
  ['claim-reservation-not-set', store, '      set({ warmTerminal: { ...held, claimToken } })', '      set({ warmTerminal: { ...held } })'],
  ['warm-hit-creates-an-extra-shell', store, '      if (state.warmTerminal?.key !== key || state.warmTerminal.claimToken) {', '      if (true) {'],
  ['same-request-uuid-changed', store, '    const request = creation.request\n', '    const request = { ...creation.request, createOperationId: crypto.randomUUID() }\n'],
  ['late-warm-success-stops-original', store, '          // Closing/replacing a presentation is not permission to stop this candidate.',
    '          await stopTerminalSession(session)\n          // Closing/replacing a presentation is not permission to stop this candidate.'],
  ['exact-target-admission-disconnected', store,
    "      if (!layout || !groupIds(layout.root).includes(tabGroupId) || !findGroup(layout, tabGroupId) || launcherTab && !findGroup(layout, tabGroupId)!.tabOrder.includes(launcherTab.id)) throw new Error('The exact Terminal display position is unavailable')",
    '      // mutant: exact target not checked'],
  ['mounted-launcher-open-disconnected', secondary, "() => promoteWarmTerminal(tabGroupId, launcherRef)", '() => Promise.resolve()'],
  ['ordinary-topic-consumer-disconnected', store,
    '      await get().promoteWarmTerminal(createdGroup, { tabId: targetTab.id, regionId: targetTab.layout.activeRegionId })',
    '      await Promise.resolve()']
]
function validate(saved) {
  assert.equal(saved.passed, true)
  assert.deepEqual(saved.inputs, hashes(), 'Qualification does not match this exact candidate')
  assert.deepEqual(saved.mutants, mutants)
  const receipt = JSON.parse(readFileSync(saved.ownerReceipt))
  assert.equal(receipt.passed, true)
  assert.equal(receipt.runs.length, 1 + mutants.length)
  const normal = JSON.parse(readFileSync(join(saved.ownerDirectory, 'normal.json')))
  assert.ok(normal.numTotalTests >= 27); assert.equal(normal.numPendingTests, 0); assert.equal(normal.numFailedTests, 0)
  for (const path of owners) assert.equal(receipt.runs[0].loadedSources[join(root, path)], saved.inputs[path])
  for (const [label, path, before, after] of mutants) {
    const result = JSON.parse(readFileSync(join(saved.ownerDirectory, label + '.json')))
    assert.ok(result.numTotalTests >= 13); assert.equal(result.numPendingTests, 0)
    assert.ok(result.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))))
    const run = receipt.runs.find(row => row.name === label)
    assert.equal(run.loadedSources[join(root,path)], sha(readFileSync(join(root,path),'utf8').replace(before,after)))
  }
  assert.equal(sha(readFileSync(saved.native)), saved.nativeSHA256)
  assert.equal(sha(readFileSync(saved.nativeCleanup)), saved.nativeCleanupSHA256)
  const native = JSON.parse(readFileSync(saved.native)), cleanup = JSON.parse(readFileSync(saved.nativeCleanup))
  assert.equal(native.passed, true); assert.equal(native.private, true)
  assert.equal(native.originalRuns.length, 2)
  assert.notEqual(native.originalRequests[0].createOperationId, native.originalRequests[1].createOperationId)
  assert.notEqual(native.originalRuns[0].runId, native.originalRuns[1].runId)
  assert.notEqual(native.originalOwner.ownerInstanceId, native.reopenedOwner.ownerInstanceId)
  assert.ok(native.reread.runs.every(run => run.interactive && run.state === 'running' && run.acceptedInputBytes > 0))
  for (const [path, digest] of Object.entries(native.source)) assert.equal(digest, sha(readFileSync(join(root, path))))
  assert.deepEqual(cleanup.remaining, []); assert.equal(cleanup.privateRootRemoved, true); assert.equal(cleanup.userRunTouched, false)
  return normal.numTotalTests
}
if (existsSync(locator)) {
  const saved = JSON.parse(readFileSync(locator))
  const count = validate(saved)
  process.stdout.write(JSON.stringify({ passed: true, exactEvidenceReused: true, normal: count, mutants: mutants.length, receipt: locator }) + '\n')
} else {
  const before = hashes()
  const native = join(directory, 'native-' + globalThis.crypto.randomUUID() + '.json')
  process.env.AGENTMUX_REUSABLE_SHELL_NATIVE_RECEIPT = native
  const proof = provePerformanceOwner({ name: 'reusable-shell-openings', owners, tests, minimumTests: 27,
    mutantTests: [focused, recovery], mutants,
    callers: [[secondary, 'promoteWarmTerminal(tabGroupId, launcherRef)'], [store, 'get().promoteWarmTerminal(createdGroup,'],
      [store, 'get().launchTerminal(tabGroupId, launcher)'], ['apps/desktop/src/main/ipc.ts', 'args.runtime.launchTerminal(input, config)'],
      ['apps/desktop/src/preload/index.ts', 'unwrapSessionLaunchResult'], ['apps/desktop/src/main/runtime-controller.ts', 'client.createTerminal({'],
      ['packages/core/src/client.ts', 'this.kernel.start({']] })
  const nativeCleanup = native.replace(/\.json$/u, '-cleanup.json')
  const saved = { passed: true, inputs: before, mutants, ownerDirectory: proof.directory, ownerReceipt: join(proof.directory,'receipt.json'), native, nativeCleanup,
    nativeSHA256: sha(readFileSync(native)), nativeCleanupSHA256: sha(readFileSync(nativeCleanup)),
    boundary: 'Actual mounted Launcher and ordinary Topic creation, registered Main/preload, public Unix Core, private official ctxmux, actual owner and reader restart with original PID/Run input/output. Does not claim actual Desktop restart/installation or initialize dispose protection. Never touches user Runs.' }
  assert.deepEqual(hashes(), before)
  const count = validate(saved)
  writeFileSync(locator, JSON.stringify(saved, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, normal: count, mutants: mutants.length, receipt: locator }) + '\n')
}
