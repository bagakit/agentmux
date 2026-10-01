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

async function bound(base, row) {
  assert.ok(row && typeof row.snapshot === 'string' && row.snapshot && !isAbsolute(row.snapshot), 'Original snapshot path is relative')
  const path = resolve(base, row.snapshot), tail = relative(base, path)
  assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail), 'Original snapshot remains inside the archive')
  const stored = await readFile(path)
  assert.equal(stored.length, row.storedBytes, 'Stored original byte count matches')
  assert.equal(sha(stored), row.storedSha256, 'Stored original SHA matches')
  const bytes = row.gzip === true ? gunzipSync(stored) : stored
  assert.ok(bytes.length > 0, 'Actual original bytes are nonempty')
  assert.equal(bytes.length, row.bytes, 'Original byte count matches')
  assert.equal(sha(bytes), row.sha256, 'Original SHA matches')
  return bytes
}

function retained(state, target, navigationId, status, expectedBytes) {
  const selections = nonempty(state?.selections, 'Actual selected-file collection is nonempty')
  assert.equal(selections.length, 2, 'The original producer selected two distinct inputs')
  assert.equal(new Set(selections.map(row => row.id)).size, selections.length, 'Original selection IDs are distinct')
  assert.equal(state.selectionCount, selections.length)
  assert.equal(state.selectionLimit, 128); assert.equal(state.byteLimit, 128 * 1024 * 1024)
  for (const row of selections) {
    assert.equal(row.browserId, target.id); assert.equal(row.workspaceId, target.workspaceId)
    assert.equal(row.navigationId, navigationId); assert.equal(row.status, status)
    assert.equal(row.byteLength, expectedBytes)
    assert.equal(nonempty(row.files, 'Original selected filenames are nonempty').length, 1)
  }
  assert.equal(state.byteLength, expectedBytes * selections.length, 'Original shared budget counts both snapshots')
  return selections
}

/** Integrity and the original local probe only. It cannot certify installed Desktop acceptance. */
export async function consumeUploadDocumentPrivateArchive(manifest, base) {
  assert.equal(manifest.schema, 'agentmux.browser-upload-document-lifetime-original-archive.v1')
  assert.equal(manifest.taskId, 'T-034')
  assert.equal(manifest.nativePassed, false); assert.equal(manifest.taskComplete, false)
  assert.ok(/^[a-f0-9]{40}$/.test(manifest.sourceCommit), 'Original Source commit is recorded')
  const files = new Map(), snapshots = new Map()
  for (const row of nonempty(manifest.files, 'Actual archived originals are nonempty')) {
    assert.ok(typeof row.origin === 'string' && row.origin && !files.has(row.origin) && !snapshots.has(row.snapshot), 'Archived original paths are unique')
    const bytes = await bound(base, row)
    files.set(row.origin, { row, bytes }); snapshots.set(row.snapshot, bytes)
  }
  const raw = snapshots.get('original-receipt.json')
  assert.ok(raw, 'The actual original producer receipt exists')
  assert.equal(sha(raw), manifest.originalReceiptSha256, 'Archive binds its exact original receipt')
  const receipt = decode(raw)
  assert.equal(receipt.version, 1); assert.equal(receipt.checked, true)
  assert.equal(receipt.privateProfile, true); assert.equal(receipt.userBrowserTouched, false); assert.equal(receipt.passkeyPassed, false)
  assert.equal(receipt.scope, manifest.scope); assert.ok(!receipt.error, 'Original producer did not report a failure')
  const inputs = Object.entries(receipt.sources ?? {})
  assert.ok(inputs.length > 0, 'Actual producer source inputs are nonempty')
  for (const [path, identity] of inputs) {
    const actual = files.get(path)
    assert.ok(actual, 'The exact producer input is archived: ' + path)
    assert.equal(sha(actual.bytes), identity.sha256); assert.equal(actual.bytes.length, identity.size)
  }
  assert.ok(inputs.some(([path]) => path.endsWith('/browser-uploads.ts')), 'Original Upload store is a bound input')
  assert.ok(inputs.some(([path]) => path.endsWith('/browser-external-owner.ts')), 'Original public Browser owner is a bound input')
  assert.ok(inputs.some(([path]) => path.endsWith('/native.cjs')), 'The actual executed compiled owner is bound')
  assert.ok(snapshots.has('original-producer.mjs'), 'The original producer Source is preserved; ordering is not inferred from checked:true')
  assert.ok(typeof receipt.engine?.product === 'string' && receipt.engine.product && receipt.engine.revision && receipt.engine.protocolVersion, 'Actual browser engine identity is nonempty')
  assert.ok(integer(receipt.chromePid) && receipt.chromePid > 0)
  const first = receipt.firstClient, second = receipt.secondClient
  assert.equal(first?.ready, true); assert.equal(second?.ready, true)
  assert.ok(integer(first.pid) && first.pid > 0 && integer(second.pid) && second.pid > 0)
  assert.notEqual(first.pid, second.pid, 'Fresh Client is a different actual process')
  for (const [phase, pid] of [[receipt.firstExit, first.pid], [receipt.secondExit, second.pid]]) {
    assert.equal(phase?.pid, pid); assert.equal(phase.code, 0); assert.equal(phase.signal, null)
  }
  assert.equal(receipt.dispose?.pid, first.pid); assert.equal(receipt.dispose.disposed, true)
  assert.equal(receipt.secondDispose?.pid, second.pid); assert.equal(receipt.secondDispose.disposed, true)
  assert.equal(receipt.chromeExit?.code, 0); assert.equal(receipt.chromeExit.signal, null)
  const original = receipt.originalPage?.frameTree?.frameTree?.frame, current = receipt.currentFrameTree?.frameTree?.frame
  assert.ok(original?.id && original.loaderId && current?.id && current.loaderId, 'Original and current frame identities exist')
  assert.equal(current.id, original.id); assert.equal(current.loaderId, original.loaderId, 'The actual original document survived both Clients')
  const target = receipt.sharedDocument
  assert.ok(target?.id && target.workspaceId); assert.equal(target.source, 'external'); assert.equal(target.status, 'ready')
  assert.equal(target.navigationId, original.loaderId)
  assert.deepEqual(nonempty(receipt.targetsObserved, 'Actual share discovery is nonempty').map(row => row.id), [target.id])
  assert.equal(receipt.shared?.id, target.id); assert.ok(receipt.extension?.id)
  assert.equal(receipt.popupConnected?.disabled, false)
  const operation = receipt.upload?.runOperation
  assert.equal(receipt.upload?.outcome?.kind, 'completed'); assert.equal(operation?.browserId, target.id)
  assert.equal(operation.phase, 'completed'); assert.ok(operation.id)
  const steps = nonempty(operation.steps, 'Actual SDK journal steps are nonempty')
  const uploads = steps.filter(row => row.method === 'uploadFiles')
  assert.equal(uploads.length, 2); assert.equal(new Set(uploads.map(row => row.ref)).size, 2)
  for (const row of uploads) assert.equal(row.status, 'completed')
  const pageEvidence = nonempty(steps.find(row => row.method === 'snapshot')?.evidence, 'Original snapshot evidence is nonempty')
  for (const row of pageEvidence) {
    assert.equal(row.operationId, operation.id); assert.equal(row.browserId, target.id); assert.equal(row.navigationId, original.loaderId)
  }
  const content = receipt.beforeDispose
  assert.ok(typeof content === 'string' && content.length > 0, 'Original selected contents are nonempty')
  const byteLength = Buffer.byteLength(content)
  assert.deepEqual(receipt.afterDispose, [content, content], 'Actual FileList and FormData reads still work after the first Client exits')
  const before = retained(receipt.beforeRetained, target, original.loaderId, 'selected', byteLength)
  const recovered = retained(receipt.afterRestartRetained, target, original.loaderId, 'unknown', byteLength)
  assert.deepEqual(recovered.map(row => row.id), before.map(row => row.id), 'Fresh store restores exactly the original selections')
  assert.equal(receipt.afterRestart?.read, content); assert.equal(receipt.afterRestart.unread, content); assert.equal(receipt.afterRestart.unreadFormData, content)
  assert.equal(receipt.afterRestart.draft, 'Original human draft'); assert.equal(receipt.afterRestart.active, 'human')
  assert.deepEqual(receipt.afterRestart.files, before.map(row => ({ name: row.files[0], size: byteLength })))
  const image = snapshots.get('selected-files-after-client-restart.png')
  assert.ok(image && image.length > 24, 'Actual original page image exists')
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0)
  return { sourceInputs: inputs.length, archivedOriginals: files.size, processIds: [first.pid, second.pid], chromePid: receipt.chromePid,
    browserId: target.id, navigationId: original.loaderId, restoredSelections: recovered.length, restoredBytes: byteLength * recovered.length,
    originalDocumentPreserved: true, originalDraftAndDocumentFocusPreserved: true,
    firstUnreadOrdering: 'pending-independent-bound-producer-review', visual: 'pending-independent-original-image-review', scope: receipt.scope }
}

export async function verifyUploadDocumentNativeReceipt(args = []) {
  const report = { schema: 'agentmux.browser-upload-document-lifetime-native-consumer.v1', taskId: 'T-034',
    passed: false, nativePassed: false, taskComplete: false, outcome: 'pending', evidence: null, actions: [],
    reason: 'No exact original archive was provided.',
    missing: ['Independent bound-producer first-unread ordering and original image review', 'Installed Main trusted-person cleanup confirmation',
      'Full Desktop/OS focus and ordinary App restart observations'] }
  try {
    if (args.length) {
      assert.ok(args.length === 2 && args[0] === '--receipt' && args[1] && !args[1].startsWith('--'), 'Only --receipt <original-archive-manifest.json> is accepted')
      const path = resolve(args[1]), bytes = await readFile(path)
      assert.ok(bytes.length > 0, 'Original archive manifest is nonempty')
      report.evidence = { path, bytes: bytes.length, sha256: sha(bytes) }
      report.partial = await consumeUploadDocumentPrivateArchive(decode(bytes), dirname(path))
      report.outcome = 'partial'
      report.reason = 'Exact private BrowserUploads/MV3/two-Client originals were consumed. This increment cannot certify complete T034 Native or Desktop recovery.'
    }
  } catch (error) {
    report.outcome = error.code === 'ENOENT' ? 'pending' : 'rejected'
    report.reason = error.message; report.failure = { code: error.code ?? error.name }
  }
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-upload-document-lifetime-native.mjs [--receipt <original-archive-manifest.json>]\nRead-only partial original consumer. Missing, rejected and incomplete Native evidence exits 2. No page action, build, install or user restart.\n')
  } else {
    process.stdout.write(JSON.stringify(await verifyUploadDocumentNativeReceipt(process.argv.slice(2)), null, 2) + '\n')
    process.exitCode = 2
  }
}
