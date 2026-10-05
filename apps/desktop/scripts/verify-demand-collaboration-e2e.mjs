import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runPendingEditRestart } from './pending-edit-restart-proof.mjs'

const repository = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const args = process.argv.slice(2)
assert.ok(args.every(a => a.startsWith('--source-ref=') || a.startsWith('--native-receipt=') || a.startsWith('--receipt-path=')), 'Only the bounded full-source/native-receipt options are accepted')
const sourceRef = args.find(a => a.startsWith('--source-ref='))?.slice('--source-ref='.length) ?? process.env.AGENTMUX_DEMAND_COLLABORATION_SOURCE_REF ?? 'refs/heads/main'
const sourceCommit = (await exec('git', ['rev-parse', '--verify', '--end-of-options', sourceRef + '^{commit}'], { cwd: repository })).stdout.trim()
const nativeReceipt = args.find(a => a.startsWith('--native-receipt='))?.slice('--native-receipt='.length) ?? process.env.AGENTMUX_DEMAND_COLLABORATION_NATIVE_RECEIPT
if (!nativeReceipt) {
  process.exit(await runPendingEditRestart(['--demand-collaboration', '--demand-collaboration-source-ref=' + sourceCommit, ...args.filter(a => a.startsWith('--receipt-path='))], 'demand-collaboration'))
}
const receipt = JSON.parse(await readFile(resolve(repository, nativeReceipt), 'utf8'))
assert.equal(receipt.passed, true); assert.equal(receipt.demandCollaboration?.passed, true)
assert.equal(receipt.sourceCommit, sourceCommit)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const proof = receipt.demandCollaboration
const build = JSON.parse(await readFile(proof.buildReceiptPath, 'utf8'))
const harnessPaths = ['apps/desktop/scripts/pending-edit-restart-proof.mjs', 'apps/desktop/scripts/verify-workbench-persistence-restart.mjs', 'apps/desktop/scripts/demand-collaboration-restart-proof.mjs', 'apps/desktop/scripts/verify-demand-collaboration-e2e.mjs']
assert.deepEqual(Object.keys(build.proofOverlays).sort(), harnessPaths.sort(), 'Exactly four declared test-only overlays')
for (const path of harnessPaths) assert.equal(sha(await readFile(resolve(repository, path))), build.proofOverlays[path], 'Exact loaded/frozen harness: ' + path)
assert.equal(receipt.probeDigest, build.proofOverlays['apps/desktop/scripts/verify-workbench-persistence-restart.mjs'])
const retained = [...proof.frames, proof.durableStore.before, proof.durableStore.after, proof.nameRetention.before, proof.nameRetention.predicted, proof.nameRetention.actual, ...proof.agents.flatMap(agent => [agent.argv, agent.nativeRecord]), ...proof.cliOperations.map(operation => operation.raw)]
assert.ok(proof.frames.length >= 10, 'Actual UI evidence is nonempty')
assert.equal(new Set(retained.map(item => item.path)).size, retained.length)
for (const item of retained) {
  const bytes = await readFile(item.path); assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256, 'Retained actual evidence: ' + item.path)
  if (item.path.endsWith('.png')) assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
}
// Recheck the independent pre-crash prediction against actual retained native documents.
const beforeNames = JSON.parse(await readFile(proof.nameRetention.before.path,'utf8'))
const predictedNames = JSON.parse(await readFile(proof.nameRetention.predicted.path,'utf8'))
const actualNames = JSON.parse(await readFile(proof.nameRetention.actual.path,'utf8'))
const exactNames = structuredClone(beforeNames), addedNames = []
assert.equal(proof.agents.length,2); assert.equal(new Set(proof.agents.map(agent=>agent.tabId)).size,2)
for (const agent of proof.agents) {
  const tab = exactNames.graph.tabs.find(tab=>tab.tabId===agent.tabId)
  assert.ok(tab && typeof tab.name === 'string' && tab.name.length > 0)
  const target = {kind:'tab',id:tab.tabId}, key = JSON.stringify(['tab',tab.tabId]), labels = exactNames.graph.resources['agentmux:display-labels'].labels
  if (Object.hasOwn(labels,key)) continue
  const label = {target,value:tab.name,source:'retained',nameRevision:1,operationId:'retained:'+key}
  labels[key] = label; addedNames.push({key,label})
}
if (addedNames.length) exactNames.revision++
assert.deepEqual(proof.nameRetention.added,addedNames)
assert.deepEqual(predictedNames,exactNames); assert.deepEqual(actualNames,exactNames)
assert.equal(build.sourceCommit, sourceCommit); assert.equal(build.productOverlayProhibited, true)
assert.equal(build.archive.mode, 'complete-immutable-product-source-no-product-overlays')
assert.equal(build.privateRootRemoved, true); assert.equal(build.userRunTouched, false); assert.equal(build.sharedSourceWritten, false)
assert.equal(receipt.cleanup.privateProcessesReaped, true); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.notEqual(receipt.first.pid, receipt.second.pid); assert.equal(receipt.first.signal, 'SIGKILL')
assert.equal(receipt.fixture.ordinaryLaunchSeedControlsAbsent, true)
assert.equal(receipt.fixture.applicationEntry, build.privateRoot + '/apps/desktop')
assert.equal(receipt.fixture.originalManifestMain, './out/main/index.js')
assert.equal(receipt.fixture.manifestSha256, build.sources['apps/desktop/package.json'])
assert.equal(receipt.fixture.storageOrigins.length, 2)
assert.equal(receipt.fixture.storageOrigins[0].origin, receipt.fixture.storageOrigins[1].origin)
for (const observed of receipt.fixture.storageOrigins) {
  const address = new URL(observed.url)
  assert.deepEqual([...address.searchParams.keys()], ['renderer-update'])
  assert.match(address.searchParams.get('renderer-update'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  address.searchParams.delete('renderer-update')
  assert.equal(address.href, pathToFileURL(build.privateRoot + '/apps/desktop/out/renderer/index.html').href)
}
assert.equal(receipt.second.exactDraftRestored, true); assert.equal(receipt.second.exactWorkbenchRestored, true); assert.equal(receipt.second.exactAgentFocusRestored, true)
assert.equal(proof.noDuplicatePtyInput, true); assert.equal(proof.noFinalRoleSeed, true); assert.equal(proof.noMockConfirmed, true)
assert.equal(proof.sourceOnlyNeverDispatch, true); assert.equal(proof.laterOnNeverBackfillsOff, true)
assert.equal(proof.restartAutomaticallyCreatedGoal, false); assert.equal(proof.restartAutomaticallySent, false)
assert.equal(proof.agents.length, 2); assert.deepEqual(proof.agents.map(agent => agent.sourcePolicy), [true, false])
for (const agent of proof.agents) {
  assert.equal(agent.initialPrompt, 'confirmed'); assert.ok(agent.nativeHandle?.sessionId)
  assert.equal(agent.inputBeforeRestore, agent.inputAfterRestore)
  assert.equal(agent.dispatch.stage, 'confirmed'); assert.equal(agent.dispatch.agentSessionId, agent.agentSessionId)
  assert.equal(agent.dispatch.hostId, agent.hostId); assert.equal(agent.dispatch.runId, agent.run.runId)
  assert.equal(agent.dispatch.receipt.kind, 'core-prompt'); assert.equal(agent.dispatch.receipt.itemId, 'prompt:' + agent.dispatch.operationId)
  assert.equal(agent.createdGoal.creationOrigin.requesterParticipationId, agent.source.id)
}
assert.equal(proof.loop.status, 'paused'); assert.equal(proof.navigation.length, 4)
assert.ok(proof.cliOperations.some(record => record.operation === 'goal.activity.append' && record.result.receipt.replayed === true))
assert.ok(proof.cliOperations.some(record => record.operation === 'goal.activity.inspect'))
assert.ok(proof.cliOperations.some(record => record.operation === 'goal.start'))
for (const path of ['apps/desktop/package.json', 'apps/desktop/resources/toolkit/mobile-connection/manifest.json', 'apps/desktop/resources/toolkit/mobile-connection/query.mjs', 'apps/desktop/resources/toolkit/performance.mjs', 'apps/desktop/src/main/toolkit-asset.ts', 'apps/desktop/src/main/toolkit-bundled.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/goal-dispatch-input.ts', 'apps/desktop/src/main/demand-participation.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/RegionCurrentDemand.tsx', 'apps/desktop/src/renderer/src/components/GoalAgentPicker.tsx', 'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx', 'apps/desktop/src/renderer/src/components/settings/GoalsSettingsPane.tsx', 'apps/desktop/src/renderer/src/lib/goal-current-work.ts', 'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts', 'packages/core/src/control-endpoint-listener-worker.ts', 'packages/core/test/fixtures/fake-codex-cli.mjs', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/native/workspace-move.c', 'packages/git/src/index.ts', 'packages/identity/src/index.ts']) {
  const bytes = (await exec('git', ['show', sourceCommit + ':' + path], { cwd: repository, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout
  assert.equal(createHash('sha256').update(bytes).digest('hex'), build.sources[path], 'Exact integrated source: ' + path)
}
for (const path of ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs', 'packages/core/dist/control-endpoint-listener-worker.js', 'packages/core/dist/index.js']) assert.match(build.compiled[path] ?? '', /^[0-9a-f]{64}$/)
assert.equal(receipt.desktopMainDigest, build.compiled['apps/desktop/out/main/index.js'])
assert.equal(receipt.rendererIdentity.coreEntrySha256, build.compiled['packages/core/dist/index.js'])
assert.ok(Object.keys(build.desktopSourceClosure).length > 100)
process.stdout.write(JSON.stringify({ schema: 'agentmux.demand-collaboration-e2e-qualified.v1', passed: true, sourceCommit, nativeReceipt: resolve(repository, nativeReceipt), harnessHashes: build.proofOverlays, retainedEvidence: retained.length, twoActualElectronPids: [receipt.first.pid, receipt.second.pid], nativeCliFixture: 'exact Core Native protocol fixture; no paid model understanding', scope: 'new Goal source ON/OFF, original settings/files/CLI/Main/Core, finite/Continue, activity, navigation and two-PID workface recovery', sliceEvidenceIntegration: 'Root binds accepted Source/mutation/independent visual receipts separately; no full regression or installed-app claim', userRunTouched: false }) + '\n')
