import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.AGENTMUX_EXTERNAL_NATIVE_CONSUMER_MODULE
  ? pathToFileURL(resolve(process.env.AGENTMUX_EXTERNAL_NATIVE_CONSUMER_MODULE)).href
  : new URL('../../verify-browser-external-target-native-receipt.mjs', import.meta.url).href
const { verifyExternalTargetNativeReceipt } = await import(moduleUrl)
assert.ok(process.env.AGENTMUX_EXTERNAL_NATIVE_ORIGINAL, 'Provide the actual immutable current RPC/MV3 archive; generated Native fixtures are not substituted')
const archive = resolve(process.env.AGENTMUX_EXTERNAL_NATIVE_ORIGINAL)
const manifest = JSON.parse(await readFile(join(archive, 'manifest.json')))
const original = JSON.parse(await readFile(join(archive, 'original-receipt.json')))
const scratch = await mkdtemp(join(tmpdir(), 'amx-external-native-consumer-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
after(() => rm(scratch, { recursive: true }))
let index = 0

async function changed(receiptChange = null, manifestChange = null) {
  const base = join(scratch, String(index++)); await mkdir(base)
  for (const row of await readdir(archive, { withFileTypes: true })) {
    if (row.name !== 'manifest.json' && row.name !== 'original-receipt.json') await symlink(join(archive, row.name), join(base, row.name))
  }
  const receipt = structuredClone(original), value = structuredClone(manifest)
  receiptChange?.(receipt)
  const bytes = Buffer.from(JSON.stringify(receipt)), identity = sha(bytes)
  const row = value.files.find(row => row.snapshot === 'original-receipt.json')
  assert.ok(row, 'Actual manifest binds its original producer receipt')
  Object.assign(row, { sha256: identity, storedSha256: identity, bytes: bytes.length, storedBytes: bytes.length })
  value.originalReceiptSha256 = identity
  manifestChange?.(value)
  await writeFile(join(base, 'original-receipt.json'), bytes)
  await writeFile(join(base, 'manifest.json'), JSON.stringify(value))
  return { path: join(base, 'manifest.json'), base, manifest: value }
}

test('actual fixed Main CLI/typed SDK/MV3 packet consumes only a partial Native scope', async () => {
  const report = await verifyExternalTargetNativeReceipt(['--receipt', join(archive, 'manifest.json')])
  assert.equal(report.outcome, 'partial')
  assert.equal(report.partial.mainCommit, original.mainCommit)
  assert.equal(report.partial.sourceInputs, original.sourceInputs.length)
  assert.ok(report.partial.emittedProductInputs > 0)
  assert.equal(report.partial.compiledMembers, 3); assert.equal(report.partial.extensionInputs, 6)
  assert.equal(report.partial.browserId, original.sharedTargets[0].id)
  assert.equal(report.partial.operationId, original.operation.id)
  assert.deepEqual(report.partial.publicCliProcessIds, original.publicCliProcesses.map(row => row.pid))
  assert.equal(report.partial.actualPopupWithdrawal, true)
  assert.deepEqual(report.actions, []); assert.equal(report.nativeComplete, false); assert.equal(report.taskComplete, false)
})

test('missing originals, unknown schema and unsupported arguments remain nonpassed', async () => {
  assert.equal((await verifyExternalTargetNativeReceipt()).outcome, 'pending')
  assert.equal((await verifyExternalTargetNativeReceipt(['--produce'])).outcome, 'rejected')
  const sample = await changed(null, row => { row.schema = 'unknown-original-schema' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('archive cannot erase every actual Source original or upgrade its private scope', async () => {
  for (const change of [row => { row.sourceInputs = [] }, row => { row.files = [] }, row => { row.nativePassed = true }]) {
    const sample = await changed(null, change)
    assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('stale Source identity cannot inherit the original compiled candidate', async () => {
  const sample = await changed(row => { row.sourceInputs[0].sha256 = '0'.repeat(64) })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('actual compiled bytes cannot drift behind a valid outer manifest', async () => {
  const sample = await changed()
  const row = sample.manifest.files.find(row => row.snapshot === 'owner.cjs.original.gz')
  assert.ok(row, 'The actual executed owner bundle is bound')
  const path = join(sample.base, row.snapshot)
  await rm(path); await writeFile(path, Buffer.from('corrupted-actual-bundle'))
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('typed SDK cannot silently select a different shared target', async () => {
  const sample = await changed(row => { row.typedCalls[0].result.targets[0].id += '-other' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('actual public execution dispatch cannot route the program to another target', async () => {
  const sample = await changed(row => { row.publicCalls[2].browserId += '-other' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('original snapshot evidence cannot bind another operation', async () => {
  const sample = await changed(row => { row.operation.steps[0].evidence[0].operationId += '-other' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('the actual click must retain a nonempty original ref', async () => {
  const sample = await changed(row => { row.operation.steps[1].ref = '' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('another nonempty click ref cannot replace the actual owner and public journal ref', async () => {
  const sample = await changed(row => { row.operation.steps[1].ref = '@different-nonempty-ref' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('another nonempty snapshot navigation cannot replace the original shared document', async () => {
  const sample = await changed(row => { row.operation.steps[0].evidence[0].navigationId = 'different-nonempty-loader' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('empty actual share and journal collections cannot white-green', async () => {
  for (const change of [row => { row.sharedTargets = [] }, row => { row.operation.steps = [] }]) {
    const sample = await changed(change)
    assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('whole empty emitted Source scan cannot white-green', async () => {
  const sample = await changed()
  for (const row of sample.manifest.files.filter(row => row.snapshot.endsWith('.metafile.json.gz'))) {
    const { gunzipSync, gzipSync } = await import('node:zlib')
    const originalBytes = gunzipSync(await readFile(join(archive, row.snapshot)))
    const value = JSON.parse(originalBytes)
    for (const output of Object.values(value.outputs)) output.inputs = {}
    const decoded = Buffer.from(JSON.stringify(value)), stored = gzipSync(decoded)
    const path = join(sample.base, row.snapshot)
    await rm(path); await writeFile(path, stored)
    Object.assign(row, { sha256: sha(decoded), bytes: decoded.length, storedSha256: sha(stored), storedBytes: stored.length })
  }
  await writeFile(sample.path, JSON.stringify(sample.manifest))
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('wrong target cannot inherit an actual popup withdrawal', async () => {
  const sample = await changed(row => { row.revokedTargets[0].id += '-other' })
  assert.equal((await verifyExternalTargetNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})
