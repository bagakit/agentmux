import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evidenceDirectory, readJSON, checkBackendProof, checkOwnerDelta, checkScopedProof, checkHTTPDelta,
  browserJSON, originalCLI, originalPage, checkBrowserSourceJoin } from './mobile-web-evidence.mjs'

const backend = await checkBackendProof(), owner = await checkOwnerDelta(), scoped = await checkScopedProof(), httpDelta = await checkHTTPDelta()
const joined = await checkBrowserSourceJoin(), references = []
const read = name => browserJSON(name, references, joined.proof)
const activateA = originalCLI(await read('activate-a'), 'app.mobile.assets.activate', true)
const activateB = originalCLI(await read('activate-b'), 'app.mobile.assets.activate', true)
assert.equal(activateA.status, 'active'); assert.equal(activateB.status, 'active')
assert.equal(activateB.hostInstanceId, activateA.hostInstanceId)
assert.equal(activateB.expectedActiveRevision, activateA.activeRevision)
assert.notEqual(activateA.candidate.digest, activateB.candidate.digest)
for (const [name, activation] of [['a', activateA], ['b', activateB]]) {
  const inspection = originalCLI(await read('inspect-' + name), 'app.mobile.assets.inspect', true)
  assert.deepEqual(inspection.operation.receipt, activation)
  const response = await read(name === 'a' ? 'http-a-before' : 'http-b-after')
  const manifest = await readJSON(resolve(evidenceDirectory, 'product-content-' + name, 'mobile-release.json'))
  assert.equal(response.exitCode, 0); assert.equal(response.buildId, activation.candidate.buildId)
  assert.equal(response.digest, activation.candidate.digest); assert.equal(response.digest, manifest.digest)
  assert.equal(response.files.length, manifest.files.length); assert.ok(response.files.length > 0)
  assert.equal(new Set(response.files.map(file => file.path)).size, response.files.length)
  for (const file of manifest.files) {
    const actual = response.files.find(item => item.path === file.path)
    assert.ok(actual); assert.equal(actual.status, 200); assert.equal(actual.bytes, file.bytes)
    assert.equal(actual.digest, file.digest); assert.equal(actual.buildHeader, manifest.buildId)
    assert.equal(new URL(actual.url).pathname, '/mobile/' + encodeURIComponent(manifest.buildId) + '/' + manifest.digest.slice(7) + '/' + file.path)
  }
}
const old = originalCLI(await read('page-a-after-activation'), 'app.mobile.assets.inspect')
const pageB = originalPage(await read('current-b'))
const loadedB = originalCLI(await read('page-b-loaded'), 'app.mobile.assets.inspect')
assert.equal(old.active.digest, activateB.candidate.digest)
assert.equal(old.client.loaded.namespaceDigest, activateA.candidate.digest)
assert.equal(old.client.loaded.buildId, activateA.candidate.buildId)
assert.equal(old.client.loaded.accepted, true)
assert.deepEqual(loadedB.client.loaded, pageB.query.loaded)
assert.equal(pageB.query.page.namespaceDigest, activateB.candidate.digest)
assert.equal(pageB.query.page.buildId, activateB.candidate.buildId)
assert.equal(pageB.query.loaded.producer.documentId, pageB.query.page.documentId)
assert.equal(pageB.query.loaded.namespaceDigest, activateB.candidate.digest)
assert.equal(pageB.query.loaded.hostInstanceId, activateA.hostInstanceId)
assert.equal(pageB.query.loaded.producer.devicePrincipalId, old.client.loaded.producer.devicePrincipalId)
assert.notEqual(pageB.query.loaded.producer.documentId, old.client.loaded.producer.documentId)
const before = originalCLI(await read('original-session-before'), 'agent.inspect')
const after = originalCLI(await read('original-session-after'), 'agent.inspect')
assert.equal(before.session.agentSessionId, after.session.agentSessionId)
assert.equal(before.status.run.runId, after.status.run.runId)
assert.equal(before.status.run.pid, after.status.run.pid); assert.equal(after.status.run.state, 'running')
const harness = await read('browser-harness'), processObservation = await read('host-process-after')
assert.deepEqual(joined.proof.hostBefore, harness.owner)
assert.equal(processObservation.exitCode, 0); assert.equal(processObservation.hostPid, harness.owner.processId)
assert.equal(processObservation.runPid, before.status.run.pid)
assert.ok(processObservation.stdout.split('\n').some(line => line.startsWith(String(processObservation.hostPid) + ' ') && line.includes('/mobile-web-host.mjs')))
assert.equal(joined.proof.hostAfter.hostPid, processObservation.hostPid)
assert.equal(joined.proof.hostAfter.assetInstanceId, activateA.hostInstanceId)
const activateC = originalCLI(await read('activate-c'), 'app.mobile.assets.activate', true)
assert.equal(activateC.status, 'active'); assert.equal(activateC.hostInstanceId, activateA.hostInstanceId)
assert.equal(activateC.expectedActiveRevision, activateB.activeRevision)
const finalPage = originalPage(await read('current-c'))
const finalLoaded = originalCLI(await read('page-c-loaded'), 'app.mobile.assets.inspect')
assert.deepEqual(finalLoaded.client.loaded, finalPage.query.loaded)
assert.equal(finalPage.query.loaded.namespaceDigest, activateC.candidate.digest)
assert.equal(finalPage.query.loaded.buildId, activateC.candidate.buildId)
assert.equal(finalPage.query.loaded.producer.devicePrincipalId, pageB.query.loaded.producer.devicePrincipalId)
const evicted = originalCLI(await read('page-a-after-third'), 'app.mobile.assets.inspect')
assert.equal(evicted.client.namespace, 'not-retained')
assert.deepEqual(evicted.client.loaded, old.client.loaded)
const finalRun = originalCLI(await read('original-session-final'), 'agent.inspect')
assert.equal(finalRun.status.run.runId, before.status.run.runId)
assert.equal(finalRun.status.run.pid, before.status.run.pid); assert.equal(finalRun.status.run.state, 'running')
const receipt = { schema: 'agentmux.mobile-web-assets-gate.v1', recordedAt: Date.now(),
  backend, owner, scoped, httpDelta, browserJoin: { path: joined.path, sha256: joined.sha256 }, references,
  result: { hostInstanceId: activateA.hostInstanceId, oldLoaded: old.client.loaded, secondLoaded: pageB.query.loaded,
    currentLoaded: finalPage.query.loaded } }
await writeFile(resolve(evidenceDirectory, 'assets-gate.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: resolve(evidenceDirectory, 'assets-gate.json') }))
