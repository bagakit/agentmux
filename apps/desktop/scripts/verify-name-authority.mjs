// Reuse the existing isolated ordinary-Main/Renderer/Runtime harness, not a
// presentation preview. Its name scenario keeps both original Runs alive.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, ".local/state/session-status-diagnosis-fixture/name-implementation")
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const proofs = []
for (const [name, count] of [['name-implementation/label-proof.json', 5], ['root-name-implementation/owner-proof.json', 8]]) {
  const path = resolve(root, ".local/state/session-status-diagnosis-fixture", name)
  const bytes = await readFile(path), proof = JSON.parse(bytes)
  assert.equal(proof.passed, true); assert.equal(proof.userRuntimeTouched, false)
  assert.equal(proof.mutations.length, count); assert.ok(proof.callers.length > 0)
  for (const item of proof.mutations) { assert.equal(item.red, true); assert.equal(item.restored, true); assert.equal(item.green, true) }
  for (const [file, expected] of Object.entries(proof.sourceHashes)) assert.equal(hash(await readFile(resolve(root, file))), expected, `Proof no longer describes source: ${file}`)
  const callerHashes = {}
  for (const [file, anchor] of proof.callers) {
    const source = await readFile(resolve(root, file)); assert.ok(source.toString().includes(anchor), `Missing actual caller: ${file}: ${anchor}`)
    callerHashes[file] = hash(source)
  }
  proofs.push({ path, sha256: hash(bytes), mutations: count, currentCallerHashes: callerHashes,
    coverage: proof.scope, note: 'Mutation inputs match exactly; caller anchors are independently rebound to current actual source.' })
}
process.env.AGENTMUX_VERIFY_RECEIPT ??= resolve(evidence, 'gui-receipt.json')
process.env.AGENTMUX_VERIFY_NAME_AUTHORITY = '1'
const receiptPath = resolve(process.env.AGENTMUX_VERIFY_RECEIPT)
function workbenchIdentity(observation) {
  const { activeWorkspaceId, mainSurface, focus, layouts, tabs } = observation.workbench
  return { activeWorkspaceId, mainSurface, focus, layouts, tabs: tabs.map(tab => ({
    id: tab.id, workspaceId: tab.workspaceId, titleRegionId: tab.titleRegionId, layout: tab.layout,
    regions: tab.regions.map(region => region.kind === 'browser'
      ? { kind: region.kind, regionId: region.regionId, workspaceId: region.workspaceId, browserId: region.browserId, url: region.url }
      : region)
  })) }
}
async function checkGuiReceipt(receipt) {
  assert.equal(receipt.schema, 'agentmux.name-authority.v1')
  assert.equal(receipt.passed, true); assert.equal(receipt.userRuntimeTouched, false); assert.equal(receipt.failure, null)
  assert.equal(receipt.cleanup.rootRemoved, true); assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, [])
  assert.equal(receipt.guis.length, 2)
  assert.deepEqual(receipt.guis.map(gui => gui.label), ['before', 'after'])
  for (const gui of receipt.guis) {
    assert.ok(Number.isSafeInteger(gui.pid) && gui.pid > 1)
    assert.equal(gui.exitCode, 0); assert.equal(gui.signalCode, null); assert.equal(gui.ordinaryQuit.code, 0)
  }
  assert.notEqual(receipt.guis[0].pid, receipt.guis[1].pid)
  assert.equal(receipt.preRestart.main.pid, receipt.guis[0].pid); assert.equal(receipt.after.main.pid, receipt.guis[1].pid)
  assert.equal(receipt.after.workbench.loading, false); assert.ok(receipt.after.workbench.tabs.length > 0)
  assert.ok(Object.keys(receipt.after.workbench.layouts).length > 0)
  assert.deepEqual(workbenchIdentity(receipt.after), workbenchIdentity(receipt.preRestart))
  const applied = receipt.nameHistoryBefore.records.filter(record => record.status === 'applied').at(-1)
  assert.ok(applied); assert.equal(receipt.nameAfter.override, applied.actual)
  assert.equal(receipt.nameAfter.nameRevision, applied.ownerRevision); assert.equal(receipt.nameAfter.availability, 'observed')
  assert.deepEqual(receipt.nameHistoryAfter, receipt.nameHistoryBefore)
  assert.equal(receipt.tabRename.record.status, 'applied'); assert.equal(receipt.tabRename.override, receipt.tabRename.record.actual)
  assert.equal(receipt.bulkRefusal, 'NAME_AUTHORITY_CONFLICT')
  assert.equal(receipt.clear.override, null); assert.equal(receipt.lateLaunch.applied, false); assert.equal(receipt.lateLaunch.label.value, null)
  assert.equal(receipt.runsBefore.length, 2); assert.deepEqual(receipt.runsAfter, receipt.runsBefore)
  assert.equal(new Set(receipt.runsBefore.map(run => run.id)).size, 2)
  for (const run of receipt.runsBefore) {
    assert.ok(Number.isSafeInteger(run.pid) && run.pid > 1); assert.equal(run.state.type, 'running')
    const before = receipt.acksBefore.find(ack => ack.runId === run.id), after = receipt.acksAfter.find(ack => ack.runId === run.id)
    assert.equal(before?.pid, run.pid); assert.equal(after?.pid, run.pid)
    assert.ok(before.inputAfter > before.inputBefore && after.inputAfter > after.inputBefore && after.inputBefore >= before.inputAfter)
    assert.ok(before.outputBytes > 0 && after.outputBytes >= before.outputBytes)
  }
  assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
  const files = Object.entries(receipt.inputsBefore)
  for (const prefix of ['apps/desktop/src/', 'packages/core/src/', 'packages/layout/src/', 'packages/demand/src/', 'packages/client-ui/src/', 'apps/desktop/out/', 'packages/core/dist/', 'packages/demand/dist/']) {
    assert.ok(files.some(([path]) => path.startsWith(resolve(root, prefix) + '/')), `Missing bounded GUI input scope: ${prefix}`)
  }
  for (const script of ['verify-name-authority.mjs', 'verify-focus-terminal-recovery.mjs']) {
    assert.ok(Object.hasOwn(receipt.inputsBefore, resolve(root, 'apps/desktop/scripts', script)))
  }
  // Recheck the original finite source/compiled/dependency signature, including
  // both gate scripts. No current identity is inferred from a successful build.
  for (const [path, expected] of files) assert.equal(hash(await readFile(path)), expected, `GUI input changed: ${path}`)
  return { firstHydration: true, distinctOrdinaryGuiPids: true, healthyOriginalRuns: true, inputs: files.length }
}
let reused = false, receipt, checks, cacheMiss
try {
  receipt = JSON.parse(await readFile(receiptPath)); checks = await checkGuiReceipt(receipt); reused = true
} catch (error) { cacheMiss = error.message }
if (!reused) {
  console.log(JSON.stringify({ guiReceiptReuse: false, reason: cacheMiss }))
  await import('./verify-focus-terminal-recovery.mjs')
  receipt = JSON.parse(await readFile(receiptPath)); checks = await checkGuiReceipt(receipt)
  receipt.consumedNameProofs = proofs
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
} else {
  const reusePath = resolve(evidence, 'gui-reuse-receipt.json')
  await writeFile(reusePath, JSON.stringify({ passed: true, reused: true, originalReceipt: receiptPath,
    originalReceiptSha256: hash(await readFile(receiptPath)), checks, consumedNameProofs: proofs, userRuntimeTouched: false }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, reused: true, receipt: receiptPath, reuseReceipt: reusePath, checks }))
}
