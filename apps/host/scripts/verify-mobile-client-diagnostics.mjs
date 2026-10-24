import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evidenceDirectory, checkBackendProof, checkScopedProof, checkHTTPDelta, browserJSON,
  originalCLI, originalPage, checkBrowserSourceJoin } from './mobile-web-evidence.mjs'

const backend = await checkBackendProof(), scoped = await checkScopedProof(), httpDelta = await checkHTTPDelta()
const joined = await checkBrowserSourceJoin(), references = []
const read = name => browserJSON(name, references, joined.proof)
const page = originalPage(await read('pending-a'))
const recent = originalCLI(await read('after-connection-recent'), 'system.diagnostics.inspect', true).reads[0]
assert.equal(recent.availability, 'found'); assert.ok(recent.data.items.length > 0)
const detailNames = ['catalog-id', 'connection-id-0', 'connection-id-1', 'connection-id-2']
const records = []
for (const name of detailNames) {
  const detail = originalCLI(await read(name), 'system.diagnostics.inspect', true).reads[0]
  assert.equal(detail.availability, 'found'); assert.equal(detail.authorityStatus, 'verified')
  assert.equal(detail.persistence, 'confirmed')
  const record = detail.data
  assert.equal(record.producer.kind, 'mobile-web')
  assert.equal(record.producer.devicePrincipalId, page.query.loaded.producer.devicePrincipalId)
  assert.equal(record.producer.documentId, page.query.page.documentId)
  assert.equal(record.producer.buildId, page.query.page.buildId)
  assert.equal(record.producer.namespaceDigest, page.query.page.namespaceDigest)
  assert.ok(recent.data.items.some(item => item.recordRef.logId === record.logId && item.occurrenceId === record.report.occurrenceId))
  assert.equal(record.report.code, null); assert.deepEqual(record.report.references, [])
  records.push(record)
}
const partial = records.find(record => record.report.mobile.kind === 'catalog-partial')?.report.mobile
assert.ok(partial); assert.equal(partial.source, 'space.ls'); assert.equal(partial.code, null)
assert.ok(partial.issueCount > 0 && partial.spaceIds.length <= 4)
assert.equal(partial.spaceIds.length + partial.omittedCount, partial.issueCount)
assert.deepEqual(Object.keys(partial).sort(), ['code', 'issueCount', 'kind', 'omittedCount', 'source', 'spaceIds'])
const connections = records.filter(record => record.report.mobile.kind === 'connection-state').map(record => record.report.mobile)
assert.ok(connections.some(value => value.boundary === 'consumer-core' && value.state === 'lost'))
assert.ok(connections.some(value => value.boundary === 'consumer-core' && value.state === 'restored'))
const receipt = { schema: 'agentmux.mobile-client-diagnostics-gate.v1', recordedAt: Date.now(), backend, scoped, httpDelta,
  browserJoin: { path: joined.path, sha256: joined.sha256 }, references,
  result: records.map(record => ({ logId: record.logId, authority: record.authority, producer: record.producer, occurrenceId: record.report.occurrenceId })) }
await writeFile(resolve(evidenceDirectory, 'diagnostics-gate.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: resolve(evidenceDirectory, 'diagnostics-gate.json') }))
