import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.AGENTMUX_UPLOAD_DOCUMENT_NATIVE_CONSUMER_MODULE
  ? pathToFileURL(resolve(process.env.AGENTMUX_UPLOAD_DOCUMENT_NATIVE_CONSUMER_MODULE)).href
  : new URL('../../verify-browser-upload-document-lifetime-native.mjs', import.meta.url).href
const { verifyUploadDocumentNativeReceipt } = await import(moduleUrl)
assert.ok(process.env.AGENTMUX_UPLOAD_DOCUMENT_NATIVE_ORIGINAL, 'Provide the actual immutable archive; no generated Native fixture substitutes for it')
const archive = resolve(process.env.AGENTMUX_UPLOAD_DOCUMENT_NATIVE_ORIGINAL)
const manifest = JSON.parse(await readFile(join(archive, 'manifest.json')))
const original = JSON.parse(await readFile(join(archive, 'original-receipt.json')))
const scratch = await mkdtemp(join(tmpdir(), 'amx-upload-consumer-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
after(() => rm(scratch, { recursive: true }))
let index = 0

async function changed(changeReceipt = null, changeManifest = null) {
  const base = join(scratch, String(index++)); await mkdir(base)
  for (const row of await readdir(archive, { withFileTypes: true })) {
    if (row.name !== 'manifest.json' && row.name !== 'original-receipt.json') await symlink(join(archive, row.name), join(base, row.name))
  }
  const receipt = structuredClone(original), value = structuredClone(manifest)
  changeReceipt?.(receipt)
  const bytes = Buffer.from(JSON.stringify(receipt)), identity = sha(bytes)
  const row = value.files.find(row => row.snapshot === 'original-receipt.json')
  assert.ok(row, 'Actual manifest binds the raw receipt')
  Object.assign(row, { sha256: identity, storedSha256: identity, bytes: bytes.length, storedBytes: bytes.length })
  value.originalReceiptSha256 = identity
  changeManifest?.(value)
  await writeFile(join(base, 'original-receipt.json'), bytes)
  await writeFile(join(base, 'manifest.json'), JSON.stringify(value))
  return { path: join(base, 'manifest.json'), base }
}

test('actual original MV3 and two Client archive remains partial', async () => {
  const report = await verifyUploadDocumentNativeReceipt(['--receipt', join(archive, 'manifest.json')])
  assert.equal(report.outcome, 'partial')
  assert.deepEqual(report.partial.processIds, [original.firstClient.pid, original.secondClient.pid])
  assert.equal(report.partial.restoredSelections, 2); assert.equal(report.partial.restoredBytes, original.afterRestartRetained.byteLength)
  assert.equal(report.partial.sourceInputs, Object.keys(original.sources).length)
  assert.equal(report.partial.originalDocumentPreserved, true)
  assert.equal(report.partial.firstUnreadOrdering, 'pending-independent-bound-producer-review')
  assert.equal(report.partial.visual, 'pending-independent-original-image-review')
  assert.equal(report.nativePassed, false); assert.equal(report.taskComplete, false)
})

test('missing original and unsupported arguments cannot claim Native success', async () => {
  assert.equal((await verifyUploadDocumentNativeReceipt()).outcome, 'pending')
  assert.equal((await verifyUploadDocumentNativeReceipt(['--produce'])).outcome, 'rejected')
})

test('archive cannot promote private Native scope or erase actual Source originals', async () => {
  for (const change of [row => { row.nativePassed = true }, row => { row.files = [] }]) {
    const sample = await changed(null, change)
    assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('corrupted actual compiled original cannot inherit its immutable SHA', async () => {
  const sample = await changed()
  const row = manifest.files.find(row => row.origin.endsWith('/native.cjs'))
  assert.ok(row, 'Original executed compiled owner is nonempty')
  const path = join(sample.base, row.snapshot)
  await rm(path); await writeFile(path, Buffer.from('corrupt-original'))
  assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('same process cannot masquerade as a Client restart', async () => {
  const sample = await changed(row => {
    row.secondClient.pid = row.firstClient.pid
    row.secondDispose.pid = row.firstClient.pid
    row.secondExit.pid = row.firstClient.pid
  })
  assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('replacement document cannot inherit old FileList recovery', async () => {
  const sample = await changed(row => { row.currentFrameTree.frameTree.frame.loaderId += '-replacement' })
  assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('whole empty recovered selection collection is rejected', async () => {
  const sample = await changed(row => {
    row.afterRestartRetained.selections = []
    row.afterRestartRetained.selectionCount = 0
    row.afterRestartRetained.byteLength = 0
  })
  assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('snapshot bytes and original Workspace ownership cannot drift', async () => {
  for (const change of [row => { row.afterRestartRetained.byteLength++ }, row => { row.afterRestartRetained.selections[0].workspaceId += '-other' }]) {
    const sample = await changed(change)
    assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('recovered previously unread contents cannot silently differ', async () => {
  const sample = await changed(row => { row.afterRestart.unread = 'Different contents' })
  assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('journal remains bound to its exact original shared target and epoch', async () => {
  for (const change of [row => { row.upload.runOperation.browserId += '-other' }, row => { row.upload.runOperation.steps[0].evidence[0].navigationId += '-other' }]) {
    const sample = await changed(change)
    assert.equal((await verifyUploadDocumentNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})
