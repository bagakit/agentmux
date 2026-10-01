import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
const integer = value => Number.isSafeInteger(value) && value >= 0
const nonempty = (values, label) => { assert.ok(Array.isArray(values) && values.length > 0, label); return values }
const productIdentity = row => ({ path: row.path, commit: row.commit, sha256: row.sha256, bytes: row.bytes })

async function bound(base, row) {
  assert.ok(row && typeof row.snapshot === 'string' && row.snapshot && !isAbsolute(row.snapshot), 'Original snapshot path is relative')
  const path = resolve(base, row.snapshot), tail = relative(base, path)
  assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail), 'Original snapshot remains inside the archive')
  const stored = await readFile(path)
  assert.equal(stored.length, row.storedBytes); assert.equal(sha(stored), row.storedSha256, 'Stored original SHA matches')
  const bytes = row.gzip === true ? gunzipSync(stored) : stored
  assert.ok(bytes.length > 0, 'Actual original bytes are nonempty')
  assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256, 'Original SHA matches')
  return bytes
}

function cliOriginal(bytes, operation) {
  const wrapper = decode(bytes)
  assert.ok(integer(wrapper.pid) && wrapper.pid > 0); assert.equal(wrapper.exit, 0)
  assert.equal(typeof wrapper.stdout, 'string'); assert.equal(typeof wrapper.stderr, 'string')
  const value = JSON.parse(wrapper.stdout)
  assert.equal(value.ok, true); assert.equal(value.operation, operation)
  assert.ok(value.result && typeof value.result === 'object', 'Actual CLI business result is nonempty')
  return { pid: wrapper.pid, result: value.result }
}

/** Consumes one exact local Main/CLI/MV3 increment; complete Desktop acceptance remains pending. */
export async function consumeExternalTargetPrivateArchive(manifest, base) {
  assert.equal(manifest.schema, 'agentmux.browser-external-current-rpc-private-archive.v1')
  assert.equal(manifest.nativePassed, false); assert.equal(manifest.taskComplete, false)
  assert.ok(/^[a-f0-9]{40}$/.test(manifest.mainCommit), 'Fixed Main identity is present')
  assert.equal(manifest.producerExit, 0); assert.deepEqual(manifest.sourceDrift, [])
  const originals = new Map()
  for (const row of nonempty(manifest.files, 'Actual archived originals are nonempty')) {
    assert.ok(!originals.has(row.snapshot), 'Original snapshot paths are unique')
    originals.set(row.snapshot, { row, bytes: await bound(base, row) })
  }
  const bytes = name => { const row = originals.get(name); assert.ok(row, 'Exact original exists: ' + name); return row.bytes }
  const raw = bytes('original-receipt.json')
  assert.equal(sha(raw), manifest.originalReceiptSha256, 'Archive binds its actual producer receipt')
  const receipt = decode(raw), build = decode(bytes('original-build-manifest.json'))
  assert.equal(receipt.schema, 'agentmux.browser-external-current-rpc-private-native.v1')
  assert.equal(receipt.checked, true); assert.equal(receipt.currentCanonicalRpcProducerPassed, true)
  assert.equal(receipt.extensionProducerPassed, true); assert.equal(receipt.sdkProducerPassed, true)
  assert.equal(receipt.privateProfile, true); assert.equal(receipt.userBrowserTouched, false); assert.equal(receipt.passkeyPassed, false)
  assert.equal(receipt.nativePassed, false); assert.equal(receipt.taskComplete, false)
  assert.equal(receipt.mainCommit, manifest.mainCommit); assert.equal(build.mainCommit, manifest.mainCommit)
  assert.equal(receipt.scope, manifest.scope); assert.ok(!receipt.error); assert.deepEqual(receipt.sourceDrift, [])
  assert.equal(build.schema, 'agentmux.browser-external-fixed-main-private-build.v1')
  assert.equal(build.nativePassed, false); assert.equal(build.taskComplete, false)
  assert.ok(bytes('original-producer.mjs').length > 0 && bytes('original-builder.mjs').length > 0)
  const sourceRows = nonempty(manifest.sourceInputs, 'Actual fixed Main source originals are nonempty')
  const sources = new Map()
  for (const row of sourceRows) {
    assert.ok(!sources.has(row.path), 'Actual Main source paths are unique'); assert.equal(row.commit, manifest.mainCommit)
    sources.set(row.path, await bound(base, row))
  }
  assert.deepEqual(nonempty(receipt.sourceInputs, 'Producer fixed Main source collection is nonempty').map(productIdentity), sourceRows.map(productIdentity))
  assert.deepEqual(nonempty(build.sources, 'Actual compiler fixed Main source collection is nonempty').map(productIdentity), sourceRows.map(productIdentity))
  for (const path of ['packages/core/src/agentmux.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/control-browser-targets.ts',
    'apps/desktop/src/main/browser-external-owner.ts', 'apps/desktop/src/main/browser-page-dispatch.ts']) {
    assert.ok(sources.has(path), 'Actual public consumer and original dispatcher are bound: ' + path)
  }
  const compiled = nonempty(build.compiled, 'Actual compiled originals are nonempty'), emitted = new Set()
  assert.deepEqual(receipt.compiled, compiled)
  const entryExports = new Set(['actual-private-entry:owner', 'actual-private-entry:core-values', 'actual-owner-export.ts'])
  for (const row of compiled) {
    const raw = bytes(row.path + '.original.gz')
    assert.equal(sha(raw), row.sha256); assert.equal(raw.length, row.bytes)
    const metafile = decode(bytes(row.path + '.metafile.json.gz'))
    const outputs = Object.values(metafile.outputs ?? {})
    assert.ok(outputs.length > 0, 'Actual compiler outputs are nonempty')
    for (const output of outputs) for (const [path, input] of Object.entries(output.inputs ?? {})) {
      if (input.bytesInOutput <= 0) continue
      if (entryExports.has(path)) continue
      assert.ok(path.startsWith('fixed-product:'), 'Emitted product input belongs to its exact fixed Main namespace')
      const original = path.slice('fixed-product:'.length)
      assert.ok(sources.has(original), 'Every actual emitted product input has an archived source original')
      emitted.add(original)
    }
  }
  assert.ok(emitted.size > 0, 'Actual emitted Source scan is nonempty')
  const extension = nonempty(receipt.extensionInputs, 'Actual MV3 source collection is nonempty')
  const names = new Set()
  for (const row of extension) {
    assert.ok(!names.has(row.path)); names.add(row.path)
    const snapshot = 'extension-' + row.path.slice(row.path.lastIndexOf('/') + 1) + '.original.gz'
    const raw = bytes(snapshot); assert.equal(sha(raw), row.sha256); assert.equal(raw.length, row.bytes)
  }
  for (const file of ['manifest.json', 'popup.js', 'protocol.js', 'service-worker.js']) assert.ok(names.has('apps/desktop/browser-extension/' + file))
  assert.ok(receipt.extension?.id); assert.equal(receipt.extensionWorkerLoaded, true)
  const selected = nonempty(receipt.sharedTargets, 'Actual MV3 share is nonempty')
  assert.equal(selected.length, 1)
  const target = selected[0]
  assert.ok(target.id && target.workspaceId && target.navigationId); assert.equal(target.source, 'external'); assert.equal(target.status, 'ready')
  const cliTargets = cliOriginal(bytes('public-targets.json'), 'browser.targets')
  const typed = nonempty(receipt.typedCalls, 'Actual typed SDK calls are nonempty')
  assert.equal(typed.length, 1); assert.equal(typed[0].method, 'browser.targets')
  assert.deepEqual(cliTargets.result.targets, selected, 'Public CLI returns exactly the original MV3 shared target')
  assert.deepEqual(typed[0].result.targets, selected, 'Actual typed SDK and CLI bind the same original target')
  const cliRun = cliOriginal(bytes('public-run.json'), 'browser.run')
  assert.notEqual(cliTargets.pid, cliRun.pid, 'Two actual public CLI processes were observed')
  assert.deepEqual(receipt.publicCliProcesses, [{ pid: cliTargets.pid, exit: 0 }, { pid: cliRun.pid, exit: 0 }])
  assert.deepEqual(nonempty(receipt.publicCalls, 'Actual business owner calls are nonempty'), [
    { operation: 'browser.targets' }, { operation: 'browser.targets' }, { operation: 'browser.run', browserId: target.id }
  ])
  assert.deepEqual(cliRun.result, receipt.publicRun, 'Actual public CLI body is bound to its result')
  assert.equal(receipt.publicRun.outcome?.kind, 'completed')
  const projected = receipt.publicRun.runOperation, journal = receipt.operation
  assert.ok(projected?.id && journal?.id); assert.equal(projected.id, journal.id)
  assert.equal(projected.browserId, target.id); assert.equal(journal.browserId, target.id)
  assert.equal(projected.phase, 'completed'); assert.equal(journal.phase, 'completed')
  const steps = nonempty(journal.steps, 'Original SDK journal steps are nonempty')
  assert.deepEqual(steps.map(row => row.method), ['snapshot', 'click', 'js'])
  assert.deepEqual(projected.steps.map(row => [row.sequence, row.method, row.status]), steps.map(row => [row.sequence, row.method, row.status]))
  const ownerOperations = decode(bytes('operations.json')), ownerTargets = decode(bytes('shared-tabs.json'))
  assert.equal(ownerOperations.version, 1); assert.equal(ownerTargets.version, 1)
  const savedOperations = nonempty(ownerOperations.operations, 'Persisted owner operations are nonempty')
  const savedTargets = nonempty(ownerTargets.targets, 'Persisted shared targets are nonempty')
  assert.equal(savedOperations.length, 1); assert.equal(savedTargets.length, 1)
  const savedOperation = savedOperations[0], savedTarget = savedTargets[0]
  assert.equal(savedOperation.id, journal.id); assert.equal(savedOperation.browserId, target.id); assert.equal(savedOperation.phase, 'completed')
  assert.equal(savedTarget.id, target.id); assert.equal(savedTarget.workspaceId, target.workspaceId)
  assert.equal(savedTarget.extensionId, receipt.extension.id); assert.equal(savedTarget.status, 'revoked')
  const savedSteps = nonempty(savedOperation.steps, 'Persisted owner steps are nonempty')
  assert.deepEqual(savedSteps.map(row => [row.sequence, row.method, row.status]), steps.map(row => [row.sequence, row.method, row.status]))
  for (const row of steps) assert.equal(row.status, 'completed')
  assert.ok(typeof steps[1].ref === 'string' && steps[1].ref, 'Actual click consumed its original snapshot ref')
  const clickFacts = row => ({ ref: row.ref, target: row.target })
  assert.deepEqual(clickFacts(steps[1]), clickFacts(savedSteps[1]), 'Receipt click binds the actual persisted owner ref and target')
  assert.deepEqual(clickFacts(steps[1]), clickFacts(projected.steps[1]), 'Receipt click binds the actual public ref and target')
  assert.deepEqual(steps[0].evidence, savedSteps[0].evidence, 'Receipt snapshot evidence binds the persisted owner journal')
  assert.deepEqual(steps[0].evidence, projected.steps[0].evidence, 'Receipt snapshot evidence binds the actual public projection')
  for (const row of nonempty(steps[0].evidence, 'Original snapshot journal evidence is nonempty')) {
    assert.equal(row.operationId, journal.id); assert.equal(row.browserId, target.id); assert.ok(row.navigationId)
    assert.equal(row.navigationId, savedTarget.ledgerNavigationId, 'Snapshot evidence binds the original shared document loader')
  }
  assert.deepEqual(receipt.publicRun.result, { counter: 1, draft: 'Owned draft', focused: 'human', login: 'fixture-signed-in' })
  assert.deepEqual(nonempty(receipt.revokedTargets, 'Actual popup withdrawal is nonempty'), [{ id: target.id, status: 'revoked' }])
  assert.ok(integer(receipt.pid) && receipt.pid > 0); assert.equal(receipt.chromeExit?.code, 0); assert.equal(receipt.chromeExit.signal, null)
  assert.ok(receipt.engine?.product && receipt.engine.revision && receipt.engine.protocolVersion)
  assert.equal(manifest.cleanup?.profileRemoved, true)
  for (const path of ['popup-disconnected.png', 'popup-connected.png', 'popup-shared.png']) {
    const image = bytes(path); assert.ok(image.length > 24)
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0)
  }
  return { mainCommit: manifest.mainCommit, sourceInputs: sources.size, emittedProductInputs: emitted.size, compiledMembers: compiled.length,
    extensionInputs: extension.length, browserId: target.id, operationId: journal.id, publicCliProcessIds: [cliTargets.pid, cliRun.pid],
    chromePid: receipt.pid, originalPageDraftAndDocumentFocusPreserved: true, actualPopupWithdrawal: true,
    images: 3, visual: 'pending-independent-original-popup-image-review', scope: receipt.scope }
}

export async function verifyExternalTargetNativeReceipt(args = []) {
  const report = { schema: 'agentmux.browser-external-target-native-consumer.v1', taskId: 'T-029', passed: false,
    nativeComplete: false, taskComplete: false, outcome: 'pending', actions: [], evidence: null,
    reason: 'No exact private original archive was provided.',
    missing: ['Independent exact popup image review', 'Full installed MainIPC/Store and Desktop composed OS focus',
      'Ordinary two-process Desktop restore with original layout and healthy Session/Run preservation', 'Current candidate full Native acceptance'] }
  try {
    if (args.length) {
      assert.ok(args.length === 2 && args[0] === '--receipt' && args[1] && !args[1].startsWith('--'), 'Only --receipt <original-archive-manifest.json> is accepted')
      const path = resolve(args[1]), raw = await readFile(path)
      assert.ok(raw.length > 0, 'Original manifest is nonempty')
      report.evidence = { path, sha256: sha(raw), bytes: raw.length }
      report.partial = await consumeExternalTargetPrivateArchive(decode(raw), dirname(path))
      report.outcome = 'partial'
      report.reason = 'Exact fixed Main public CLI/typed SDK/Owner/MV3 originals were consumed. This private increment cannot certify complete T029 Native or Desktop recovery.'
    }
  } catch (error) {
    report.outcome = error.code === 'ENOENT' ? 'pending' : 'rejected'
    report.reason = error.message; report.failure = { code: error.code ?? error.name }
  }
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-external-target-native-receipt.mjs [--receipt <original-archive-manifest.json>]\nRead-only partial original consumer. Missing, rejected and incomplete Native evidence exits 2. No build, Browser action, install or user restart.\n')
  } else {
    process.stdout.write(JSON.stringify(await verifyExternalTargetNativeReceipt(process.argv.slice(2)), null, 2) + '\n')
    process.exitCode = 2
  }
}
