import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCapsuleOwner } from '../dist/node.js'
import { CAPSULE_ASSET_CHUNK_BYTES } from '../dist/index.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'capsule-assets-')), source = join(directory, 'source')
  await mkdir(source)
  await writeFile(join(source, 'index.html'), '<!doctype html><h1>Original page</h1>')
  await writeFile(join(source, 'app.js'), 'window.original = true')
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state') })
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }) })
  const created = await owner.call('capsule.create', { operationId: 'create', sourcePath: source, storageMode: 'path', routing: 'spa' })
  const inspection = await owner.call('capsule.inspect', { capsuleId: created.record.capsuleId })
  const read = (path, rest = {}, context) => owner.call('capsule.asset.read', { capsuleId: created.record.capsuleId,
    expectedRevision: inspection.record.revision, expectedInstanceId: inspection.endpoint.instanceId,
    path, offset: 0, length: CAPSULE_ASSET_CHUNK_BYTES, ...rest }, context)
  return { directory, source, owner, inspection, read }
}
test('asset RPC reads the same MIME, relative files and SPA routes as original HTTP; head has no bytes', async t => {
  const { read, inspection } = await fixture(t)
  for (const [path, accept] of [['/', 'text/html'], ['/app.js', '*/*'], ['/route', 'text/html'], ['/route', '']]) {
    const asset = await read(path, { accept })
    const http = await fetch(inspection.endpoint.url.slice(0, -1) + path, { headers: { accept } })
    assert.equal(asset.status, http.status)
    assert.equal(asset.contentType, http.headers.get('content-type'))
    assert.equal(Buffer.from(asset.bytesBase64, 'base64').toString(), await http.text())
  }
  assert.equal((await read('/missing.css', { accept: 'text/html' })).status, 404)
  assert.equal((await read('/route', { accept: 'application/json' })).status, 404)
  const head = await read('/', { head: true })
  assert.equal(head.bytesBase64, '')
  assert.ok(head.totalBytes > 0)
  const afterEnd = await read('/app.js', { offset: 10_000 })
  assert.equal(afterEnd.bytesBase64, '')
  assert.equal(afterEnd.eof, true)
})
test('chunked large resources keep full bytes and detect replacement rather than mixing versions', async t => {
  const { read, source } = await fixture(t)
  const original = Buffer.alloc(CAPSULE_ASSET_CHUNK_BYTES * 2 + 13, 91)
  await writeFile(join(source, 'large.bin'), original)
  const first = await read('/large.bin')
  assert.equal(first.eof, false)
  const second = await read('/large.bin', { offset: CAPSULE_ASSET_CHUNK_BYTES, assetStamp: first.assetStamp })
  const third = await read('/large.bin', { offset: CAPSULE_ASSET_CHUNK_BYTES * 2, assetStamp: first.assetStamp })
  assert.equal(third.eof, true)
  assert.deepEqual(Buffer.concat([first, second, third].map(part => Buffer.from(part.bytesBase64, 'base64'))), original)
  await writeFile(join(source, 'large.bin'), 'changed')
  await assert.rejects(read('/large.bin', { offset: CAPSULE_ASSET_CHUNK_BYTES, assetStamp: first.assetStamp }), { code: 'CAPSULE_ASSET_CHANGED' })
})
test('path, original revision, process instance and cancellation stay at their accurate boundaries', async t => {
  const { read, directory, source, inspection } = await fixture(t)
  await writeFile(join(directory, 'secret.txt'), 'outside')
  await symlink(join(directory, 'secret.txt'), join(source, 'link.txt'))
  assert.equal((await read('/link.txt')).status, 403)
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%5csecret.txt', '/%00']) assert.equal((await read(path)).status, 400)
  await assert.rejects(read('/', { expectedRevision: inspection.record.revision + 1 }), { code: 'CAPSULE_ASSET_SOURCE_CHANGED' })
  await assert.rejects(read('/', { expectedInstanceId: inspection.record.capsuleId }), { code: 'CAPSULE_ASSET_SOURCE_CHANGED' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(read('/', {}, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal((await read('/')).status, 200)
})
