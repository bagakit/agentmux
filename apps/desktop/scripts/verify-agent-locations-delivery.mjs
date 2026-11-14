import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const directory = path.join(root, '.tmp/agent-locations/delivery')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(path.resolve(root, file), 'utf8'))
const receipt = { passed: false, evidence: {} }
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
try {
  // Root publishes this exact record only after the independent review and real
  // installation finish. Waiting is observation, never approval or an install retry.
  let ready
  const deadline = Date.now() + 60 * 60 * 1000
  console.log('agent-locations: awaiting original delivery records; no install or navigation is dispatched here')
  while (!ready && Date.now() < deadline) {
    try { ready = await read('.tmp/agent-locations/delivery/ready.json') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(ready, 'Original delivery records have not arrived; delivery remains unconfirmed')
  const candidate = await read('.tmp/agent-locations/candidate/receipt.json')
  assert.equal(candidate.passed, true)
  assert.equal(candidate.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
  assert.equal(ready.sourceCommit, candidate.sourceCommit)
  const target = await read('.tmp/agent-locations/before/targets.json')
  for (const [name, file] of Object.entries(ready.records)) {
    assert.equal(typeof file, 'string')
    receipt.evidence[name] = { file, sha256: sha(await readFile(path.resolve(root, file))) }
  }
  const record = name => { assert.ok(ready.records[name], `Missing ${name} evidence`); return read(ready.records[name]) }
  const beforeApp = (await record('appBefore')).result.observation
  const afterApp = (await record('appAfter')).result.observation
  const installed = await record('installedIdentity')
  assert.equal(installed.sourceCommit, candidate.sourceCommit)
  assert.equal(installed.sourceTree, candidate.sourceTree)
  assert.deepEqual(afterApp.main.package, installed)
  assert.notEqual(afterApp.main.pid, beforeApp.main.pid, 'A new UI OS process has not been observed')
  const renderer = await record('rendererRelease')
  assert.ok(renderer.id && renderer.identity && Object.keys(renderer.files).length > 0)
  assert.equal(afterApp.main.renderer.id, renderer.id)
  assert.deepEqual(afterApp.main.renderer.identity, renderer.identity)
  const beforeAgent = (await record('agentBefore')).result
  const afterAgent = (await record('agentAfter')).result
  assert.equal(afterAgent.session.agentSessionId, beforeAgent.session.agentSessionId)
  assert.deepEqual(afterAgent.session.run, beforeAgent.session.run)
  for (const agent of [beforeAgent, afterAgent]) {
    assert.equal(agent.session.hostId, target.hostId)
    assert.equal(agent.session.agentSessionId, target.agentSessionId)
    assert.equal(agent.session.run.runId, target.runId)
    assert.equal(agent.status.run.runId, target.runId)
  }
  assert.equal(afterAgent.status.run.state, 'running')
  assert.equal(afterAgent.status.run.pid, beforeAgent.status.run.pid)
  const beforeTab = (await record('tabBefore')).result.catalog
  const afterTab = (await record('tabAfter')).result.catalog
  assert.ok(beforeTab.regions.length > 0 && beforeTab.locations.length > 0)
  assert.ok(beforeTab.regions.some(region => region.kind === 'agent' && region.agentSessionId === target.agentSessionId && region.runId === target.runId && region.execution?.hostId === target.hostId))
  assert.ok(beforeTab.regions.some(region => region.kind === 'browser' && region.browserId === target.browserId))
  for (const region of beforeTab.regions) {
    const current = afterTab.regions.find(value => value.tabId === region.tabId && value.regionId === region.regionId)
    assert.ok(current, 'Original Region missing')
    for (const key of ['kind', 'agentSessionId', 'runId', 'browserId']) assert.equal(current[key], region[key])
  }
  for (const location of beforeTab.locations) assert.ok(afterTab.locations.some(value =>
    ['spaceId', 'zoneId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'].every(key => value[key] === location[key])), 'Original workface address missing')
  const mobile = await record('mobilePage')
  assert.equal(mobile.ok, true)
  assert.equal(mobile.result.outcome.kind, 'completed')
  assert.equal(mobile.result.runOperation.browserId, target.browserId)
  const identity = mobile.result.result.identity
  assert.equal(identity.page.buildId, candidate.mobileRelease.buildId)
  assert.equal(identity.page.namespaceDigest, candidate.mobileRelease.digest)
  assert.equal(identity.loaded.accepted, true)
  assert.equal(identity.loaded.buildId, identity.page.buildId)
  assert.equal(identity.loaded.namespaceDigest, identity.page.namespaceDigest)
  assert.equal(identity.loaded.producer.documentId, identity.page.documentId)
  assert.equal(identity.loaded.hostId, target.hostId)
  assert.equal(identity.loaded.producer.devicePrincipalId, target.devicePrincipalId)
  assert.equal(identity.inspection.hostId, target.hostId)
  assert.equal(identity.inspection.client.availability, 'found')
  assert.deepEqual(identity.inspection.client.target, identity.loaded.producer)
  assert.deepEqual(identity.inspection.client.loaded, identity.loaded)
  assert.equal(identity.inspection.active.digest, identity.page.namespaceDigest)
  const reviewPath = ready.records.visualReview
  assert.ok(reviewPath, 'Independent image review missing')
  const review = await readFile(path.resolve(root, reviewPath), 'utf8')
  assert.match(review, /^verdict: deliverable$/m)
  assert.match(review, /^reviewer: \/root\/relay_backpressure$/m)
  assert.ok(review.includes(`source_commit: ${candidate.sourceCommit}`))
  const block = review.match(/```sha256\n([\s\S]+?)\n```/)
  assert.ok(block, 'Reviewed image hashes missing')
  const images = block[1].trim().split('\n')
  assert.ok(images.length > 0)
  for (const line of images) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    assert.ok(match, 'Invalid reviewed image hash line')
    assert.equal(sha(await readFile(path.resolve(root, match[2]))), match[1])
  }
  receipt.sourceCommit = candidate.sourceCommit
  receipt.reviewedImages = images.length
  receipt.mobileRelease = { buildId: identity.page.buildId, digest: identity.page.namespaceDigest }
  receipt.passed = true
} catch (error) { receipt.error = String(error.stack || error); process.exitCode = 1 }
finally {
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: path.relative(root, path.join(directory, 'receipt.json')) }))
}
