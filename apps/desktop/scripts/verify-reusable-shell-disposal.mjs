import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner, sha, proofRoot as root } from './performance-owner-proof.mjs'
const store = 'apps/desktop/src/renderer/src/store.ts'
const focused = 'apps/desktop/test/reusable-shell-disposal.test.tsx'
const opening = 'apps/desktop/test/reusable-shell-openings.test.tsx'
const nativeTest = 'apps/desktop/test/reusable-shell-disposal-native.test.tsx'
const tests = [focused, opening, 'apps/desktop/test/launcher-prewarm-recovery.test.tsx', nativeTest]
const owners = [store, 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx',
  'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/src/renderer/src/lib/startup-progress.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts']
const inputs = [...owners, ...tests, 'apps/desktop/test/helpers/reusable-shell-disposal-fixture.ts',
  'apps/desktop/test/fixtures/reusable-shell-openings/disposal-reader.mjs', 'apps/desktop/test/helpers/first-execution-ipc-bridge.ts',
  'apps/desktop/test/helpers/startup-observation-api-fixture.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/fixtures/headless-runtime-worker.mjs',
  'packages/core/src/client.ts', 'packages/core/dist/index.js', 'packages/core/dist/client.js',
  'packages/core/dist/hosted-client.js', 'packages/core/dist/headless-runtime-cli.js',
  'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/scripts/performance-owner-proof.mjs',
  'apps/desktop/scripts/verify-reusable-shell-disposal.mjs', 'docs/design/behavior/workface-launcher.md']
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))
const mutants = [
  ['explicit-request-fact-not-recorded', store, '      held = { ...held, explicitOpening: true }\n', ''],
  ['observation-cleanup-stops-claimed', store, '      if (!warm?.explicitOpening) {', '      if (true) {'],
  ['temporary-token-mistaken-for-ownership', store, '      if (!warm?.explicitOpening) {', '      if (!warm?.claimToken) {'],
  ['unused-prewarming-leaked', store, '      if (!warm?.explicitOpening) {', '      if (false) {'],
  ['retained-request-cleared-after-disposal', store, '      const warm = get().warmTerminal\n      // Observation cleanup', '      const warm = get().warmTerminal\n      set({ warmTerminal: null })\n      // Observation cleanup'],
  ['explicit-fact-lost-with-token', store, '          const { claimToken: _claim, ...retained } = current.warmTerminal', '          const { claimToken: _claim, explicitOpening: _opening, ...retained } = current.warmTerminal'],
  ['actual-returned-dispose-disconnected', store, '      return () => {\n        disposeRuntimeSubscriptions()\n      }', '      return () => {}']
]
const directory = join(root, '.local/state/reusable-shell-disposal')
mkdirSync(directory, { recursive: true })
const locator = join(directory, 'qualification.json')
function validate(saved) {
  assert.equal(saved.passed, true)
  assert.deepEqual(saved.inputs, hashes(), 'Qualification does not match this exact source')
  assert.deepEqual(saved.mutants, mutants)
  assert.equal(sha(readFileSync(saved.ownerReceipt)), saved.ownerReceiptSHA256)
  const receipt = JSON.parse(readFileSync(saved.ownerReceipt))
  assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.runs.map(row => row.name), ['normal', ...mutants.map(row => row[0])])
  const normal = JSON.parse(readFileSync(join(saved.ownerDirectory, 'normal.json')))
  assert.equal(normal.numTotalTests, 29); assert.equal(normal.numPendingTests, 0); assert.equal(normal.numFailedTests, 0)
  for (const path of owners) assert.equal(receipt.runs[0].loadedSources[join(root,path)], saved.inputs[path])
  for (const [label,path,before,after] of mutants) {
    const result = JSON.parse(readFileSync(join(saved.ownerDirectory,label+'.json')))
    assert.equal(result.numTotalTests, 18); assert.equal(result.numPendingTests,0)
    assert.ok(result.testResults.flatMap(suite=>suite.assertionResults).some(test=>test.status==='failed'&&test.failureMessages.some(message=>/AssertionError/u.test(message))))
    assert.equal(receipt.runs.find(row=>row.name===label).loadedSources[join(root,path)],sha(readFileSync(join(root,path),'utf8').replace(before,after)))
  }
  assert.equal(sha(readFileSync(saved.native)),saved.nativeSHA256)
  assert.equal(sha(readFileSync(saved.nativeCleanup)),saved.nativeCleanupSHA256)
  const native=JSON.parse(readFileSync(saved.native)),cleanup=JSON.parse(readFileSync(saved.nativeCleanup))
  assert.equal(native.passed,true);assert.equal(native.private,true)
  assert.deepEqual(native.callbacks.map(row=>row.phase),['pending','released-ready','unused-ready','unused-pending'])
  assert.ok(native.callbacks.every(row=>row.actualInitializeDisposeExecuted))
  for (const row of native.callbacks.slice(0,2)) {
    assert.equal(row.stopCalls,0);assert.equal(row.before.pid,row.afterCallback.pid)
    assert.equal(row.before.runId,row.afterCallback.runId);assert.equal(row.afterCallback.state,'running')
  }
  for(const row of native.callbacks.slice(2)){assert.equal(row.stopCalls,1);assert.notEqual(row.afterCallback.state,'running')}
  assert.equal(native.originalRuns.length,2)
  assert.ok(native.reread.runs.every(row=>row.interactive&&row.state==='running'&&row.acceptedInputBytes>0))
  assert.deepEqual(native.reread.runs.map(row=>[row.runId,row.pid]),native.originalRuns.map(row=>[row.runId,row.pid]))
  for(const[path,digest]of Object.entries(native.source))assert.equal(digest,saved.inputs[path])
  assert.deepEqual(cleanup.remaining,[]);assert.equal(cleanup.privateRootRemoved,true);assert.equal(cleanup.userRunTouched,false)
  return normal.numTotalTests
}
if(existsSync(locator)){
  const saved=JSON.parse(readFileSync(locator)),normal=validate(saved)
  process.stdout.write(JSON.stringify({passed:true,exactEvidenceReused:true,normal,mutants:mutants.length,receipt:locator})+'\n')
}else{
  const before=hashes(),native=join(directory,'native-'+globalThis.crypto.randomUUID()+'.json')
  process.env.AGENTMUX_REUSABLE_SHELL_DISPOSAL_NATIVE=native
  const proof=provePerformanceOwner({name:'reusable-shell-disposal',owners,tests,minimumTests:29,
    mutantTests:[focused,opening],mutants,callers:[
      ['apps/desktop/src/renderer/src/App.tsx','void beginRendererStartup('],
      ['apps/desktop/src/renderer/src/lib/startup-progress.ts','return initialize()'],
      [store,'disposeRuntimeSubscriptions()'],[store,'void stopWarmTerminal(warm)'],
      ['apps/desktop/src/main/ipc.ts','args.runtime.launchTerminal(input, config)'],
      ['apps/desktop/src/main/runtime-controller.ts','client.createTerminal({'],
      ['packages/core/src/client.ts','this.kernel.start({']]})
  const nativeCleanup=native.replace(/\.json$/u,'-cleanup.json')
  const saved={passed:true,inputs:before,mutants,ownerDirectory:proof.directory,ownerReceipt:join(proof.directory,'receipt.json'),
    ownerReceiptSHA256:sha(readFileSync(join(proof.directory,'receipt.json'))),native,nativeCleanup,
    nativeSHA256:sha(readFileSync(native)),nativeCleanupSHA256:sha(readFileSync(nativeCleanup)),
    boundary:'Actual beginRendererStartup→Store.initialize→returned disposal; App.tsx is a real caller anchor, its whole effect is not mounted. Registered Main/preload→public Unix Core→private official native original Run. Two claimed original Runs stay interactive in a separate reader; two never-claimed Runs stop. No installed Desktop restart or cross-Renderer warm.creation durability claim, no user Runs touched.'}
  assert.deepEqual(hashes(),before)
  const normal=validate(saved)
  writeFileSync(locator,JSON.stringify(saved,null,2)+'\n')
  process.stdout.write(JSON.stringify({passed:true,normal,mutants:mutants.length,receipt:locator})+'\n')
}
