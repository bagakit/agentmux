import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const directory = path.join(root, '.tmp/agent-location-details/delivery')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const json = async file => JSON.parse(await readFile(path.resolve(root, file), 'utf8'))
const receipt = { passed: false, evidence: {} }
await mkdir(directory, { recursive: true })
try {
  // No action or wait: the delivery owner supplies original completed records.
  const ready = await json('.tmp/agent-location-details/delivery/ready.json')
  assert.ok(ready.mode === 'renderer' || ready.mode === 'app-install')
  assert.equal(ready.sourceCommit, git('rev-parse', 'HEAD'))
  assert.equal(ready.sourceTree, git('rev-parse', 'HEAD^{tree}'))
  git('merge-base', '--is-ancestor', ready.sourceCommit, 'main')
  const target = await json('.tmp/agent-location-details/before/targets.json')
  const record = async name => {
    assert.ok(ready.records[name], `Missing original ${name} record`)
    const file = ready.records[name], bytes = await readFile(path.resolve(root, file))
    receipt.evidence[name] = { file, sha256: sha(bytes) }
    return JSON.parse(bytes.toString())
  }
  const build = await record('rendererBuild')
  assert.equal(build.sourceCommit, ready.sourceCommit)
  assert.equal(build.sourceTree, ready.sourceTree)
  assert.equal(build.sourceStatus, '')
  assert.equal(build.command, ready.mode === 'renderer' ? 'pnpm update:renderer' : 'pnpm package:mac:install --ui-only --app-only')
  assert.equal(build.exitCode, 0)
  assert.ok(Object.keys(build.sourceSHA256).length > 0)
  for (const [file, digest] of Object.entries(build.sourceSHA256)) assert.equal(sha(await readFile(path.join(root, file))), digest)
  const release = await record('rendererRelease')
  assert.equal(build.rendererReleaseSHA256, sha(await readFile(path.resolve(root, ready.records.rendererRelease))))
  assert.ok(release.id && Object.keys(release.files).length > 0)
  if (ready.mode === 'renderer') {
    const update = await record('rendererUpdate')
    assert.equal(update.outcome, 'applied')
    assert.equal(update.requested, release.id); assert.equal(update.current, release.id)
    assert.ok(update.at >= build.startedAt)
  }
  const before = (await record('appBefore')).result.observation
  const after = (await record('appAfter')).result.observation
  for (const [name, key] of [['app', 'appBefore'], ['agent', 'agentBefore'], ['tab', 'tabBefore']]) {
    assert.equal(path.resolve(root, ready.records[key]), path.resolve(root, target.before[name].file))
    assert.equal(sha(await readFile(path.resolve(root, ready.records[key]))), target.before[name].sha256)
  }
  assert.ok(before.main.pid > 0 && after.main.pid > 0)
  if (ready.mode === 'renderer') {
    assert.deepEqual(after.main.package, before.main.package)
    assert.equal(after.main.pid, before.main.pid)
  } else {
    const installed = await record('installedIdentity'), installation = await record('installation')
    assert.equal(installed.sourceCommit, ready.sourceCommit)
    assert.equal(installed.sourceTree, ready.sourceTree)
    assert.deepEqual(after.main.package, installed)
    assert.notEqual(after.main.pid, before.main.pid)
    assert.equal(installation.intent, 'ui-only')
    assert.equal(installation.native.status, 'deferred')
  }
  assert.equal(after.main.renderer.id, release.id)
  assert.deepEqual(after.main.renderer.identity, release.identity)
  const oldAgent = (await record('agentBefore')).result, agent = (await record('agentAfter')).result
  for (const value of [oldAgent, agent]) {
    assert.equal(value.session.hostId, target.hostId)
    assert.equal(value.session.agentSessionId, target.agentSessionId)
    assert.equal(value.session.run.runId, target.runId)
    assert.equal(value.status.run.runId, target.runId)
    assert.equal(value.status.run.pid, target.pid)
  }
  assert.equal(agent.session.hostId, oldAgent.session.hostId)
  assert.equal(agent.session.agentSessionId, oldAgent.session.agentSessionId)
  assert.deepEqual(agent.session.run, oldAgent.session.run)
  assert.equal(agent.status.run.runId, oldAgent.status.run.runId)
  assert.ok(oldAgent.status.run.pid > 0); assert.equal(agent.status.run.pid, oldAgent.status.run.pid)
  assert.equal(agent.status.run.state, 'running')
  const oldTab = (await record('tabBefore')).result.catalog, tab = (await record('tabAfter')).result.catalog
  assert.ok(oldTab.regions.length > 0 && oldTab.locations.length > 0)
  for (const catalog of [oldTab, tab]) {
    assert.ok(catalog.regions.some(region => region.tabId === target.tabId && region.regionId === target.agentRegionId &&
      region.kind === 'agent' && region.agentSessionId === target.agentSessionId && region.runId === target.runId && region.execution?.hostId === target.hostId))
    assert.ok(catalog.regions.some(region => region.tabId === target.tabId && region.regionId === target.browserRegionId &&
      region.kind === 'browser' && region.browserId === target.browserId))
  }
  for (const region of oldTab.regions) {
    const current = tab.regions.find(value => value.tabId === region.tabId && value.regionId === region.regionId)
    assert.ok(current, 'Original Region missing')
    for (const key of ['kind', 'agentSessionId', 'runId', 'browserId']) assert.equal(current[key], region[key])
  }
  for (const location of oldTab.locations) assert.ok(tab.locations.some(value =>
    ['spaceId', 'zoneId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'].every(key => value[key] === location[key])), 'Original display address missing')
  const reviewPath = ready.records.visualReview
  assert.ok(reviewPath)
  const review = await readFile(path.resolve(root, reviewPath), 'utf8')
  receipt.evidence.visualReview = { file: reviewPath, sha256: sha(review) }
  assert.match(review, /^verdict: deliverable$/m)
  assert.match(review, /^reviewer: \/root\/relay_backpressure$/m)
  assert.ok(review.includes(`source_commit: ${ready.sourceCommit}`))
  const lines = review.match(/```sha256\n([\s\S]+?)\n```/)?.[1].trim().split('\n')
  assert.ok(lines?.length)
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    assert.ok(match); assert.equal(sha(await readFile(path.resolve(root, match[2]))), match[1])
  }
  receipt.sourceCommit = ready.sourceCommit
  receipt.reviewedImages = lines.length
  receipt.passed = true
} catch (error) { receipt.error = String(error.stack || error); process.exitCode = 1 }
finally {
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: path.relative(root, path.join(directory, 'receipt.json')) }))
}
