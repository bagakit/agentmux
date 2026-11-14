import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { assertNativeBrowserMeasurements, assertSourceBrowserConsumers } from './lib/browser-capability-cost-collector.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Preserve proof bytes outside an owned worktree so its cleanup cannot erase them.
const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()
const output = join(dirname(commonGit), '.local/browser-daily-p0p1/t005-native')
const indexPath = join(output, 'index.json')
assert.ok(process.argv.slice(2).every(arg => arg === '--fresh'), 'Only explicit --fresh launches this private App proof.')
const fresh = process.argv.includes('--fresh')
async function checkIntegrationMutation(reference, baseline) {
  assert.ok(reference?.path && reference.sha256, 'The current integrated partition mutation must be retained')
  const bytes = await readFile(reference.path); assert.equal(sha(bytes), reference.sha256)
  const mutation = JSON.parse(bytes)
  assert.equal(mutation.schema, 'agentmux.browser-daily-partition-mutation.v1')
  const source = 'apps/desktop/src/main/browser-view-manager.ts', main = 'apps/desktop/out/main/index.js'
  assert.equal(baseline.identityBefore[source], mutation.originalSource.sha256)
  assert.equal(baseline.identityBefore[main], mutation.originalMain.sha256)
  assert.notEqual(mutation.mutatedSource.sha256, mutation.originalSource.sha256)
  assert.notEqual(mutation.mutatedMain.sha256, mutation.originalMain.sha256)
  for (const file of [mutation.originalSource, mutation.originalMain, mutation.mutatedSource, mutation.mutatedMain, mutation.receipt]) {
    assert.equal(sha(await readFile(file.path)), file.sha256)
  }
  const failed = JSON.parse(await readFile(mutation.receipt.path, 'utf8'))
  assert.equal(failed.passed, false); assert.equal(failed.failure.code, 'ERR_ASSERTION')
  assert.equal(failed.failure.phase, 'daily-profile-cookie-isolation')
  assert.equal(failed.identityBefore[source], mutation.mutatedSource.sha256)
  assert.equal(failed.identityBefore[main], mutation.mutatedMain.sha256)
  assert.equal(failed.privateElectronHosts[0].mainSha256, mutation.mutatedMain.sha256)
  assert.ok(failed.daily.profileIsolation.surveyCookie.includes('daily-login=original-default'))
  assert.ok(failed.daily.profileIsolation.namedCookie.includes('daily-login=original-default'))
  assert.equal(failed.daily.extensionOperations, undefined, 'The business RED must precede every native approval')
  assert.equal(failed.cleanup.privateProcessesReaped, true)
  assert.equal(mutation.restoredSourceSha256, mutation.originalSource.sha256)
  assert.equal(mutation.restoredMainSha256, mutation.originalMain.sha256)
}
const check = receipt => {
  assert.equal(receipt.case, 'daily-workface')
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failure)); assert.equal(receipt.completeGate, true)
  const daily = receipt.daily
  assert.equal(daily.complete, true)
  assert.equal(receipt.dailyUserFocusBefore.activationPolicy, 0)
  assert.notEqual(receipt.dailyUserFocusBefore.bundleId, 'com.apple.loginwindow')
  assert.ok(receipt.dailyUserFocusReturn && receipt.dailyUserFocusFinal)
  assert.ok(receipt.dailyEvidence.some(item => item.kind === 'original-app-level-focus'))
  assert.notEqual(receipt.first.pid, receipt.second.pid)
  assert.equal(daily.original.actors.length, 2); assert.equal(daily.recovered.runs.length, 2)
  assert.notEqual(daily.original.actors[0].sid, daily.original.actors[1].sid)
  for (const [index, actor] of daily.original.actors.entries()) {
    const run = daily.recovered.runs[index], ack = daily.recovered.secondAcks[index]
    assert.equal(run.agentSessionId, actor.sid); assert.equal(run.runId, actor.run.runId); assert.equal(run.pid, actor.run.pid)
    assert.equal(run.state, 'running'); assert.equal(ack.runId, actor.run.runId)
    assert.equal(ack.appliedByteRange.startByte, actor.run.acceptedInputBytes); assert.ok(ack.appliedByteRange.endByte > ack.appliedByteRange.startByte)
  }
  assert.equal(receipt.taskData.outcomes.completion.status, 'passed')
  assert.equal(receipt.taskData.producers.length, 2); assert.notEqual(...receipt.taskData.producers)
  assert.equal(receipt.taskData.privateCounterexamples, undefined, 'T005 must consume primary stages without repeating the sealed private matrix')
  assert.ok(daily.privateTaskDataReference.path && daily.privateTaskDataReference.sha256)
  assert.deepEqual(receipt.taskData.currentFailureControlGeometry.map(item => item.label), ['normal', 'narrow', 'short'])
  for (const item of receipt.taskData.currentFailureControlGeometry) {
    assert.ok(item.groups.length > 0 && item.groups.some(group => group.inViewport)); assert.deepEqual(item.violations, [])
  }
  assert.ok(receipt.taskData.failureControlGeometry.cssCounterexample.violations.length > 0)
  assert.ok(receipt.taskData.failureControlGeometry.restored.length > 0)
  assert.deepEqual(receipt.taskData.readerBoundaries.map(item => item.label), ['normal', 'narrow', 'short'])
  assert.deepEqual(daily.coldRead.nativeBefore, []); assert.deepEqual(daily.coldRead.nativeAfter, [])
  assert.equal(daily.coldRead.artifactSha256, receipt.taskData.artifacts[0].sha256); assert.equal(daily.coldRead.actionCount, 2)
  assert.equal(daily.control.stopped, 'stopped'); assert.equal(daily.frames.nativeDocuments.length, 5)
  assert.equal(daily.frames.returnedNodes, 1); assert.equal(daily.frames.clippedWork.axTrees, 5)
  assert.equal(daily.extensions.version, '2.0.0'); assert.equal(daily.recovered.extensions.version, '2.0.0')
  assert.equal(daily.recovered.extensions.nativeId, daily.extensions.nativeId)
  assert.equal(daily.recovered.extensions.contentVersion, '2.0.0'); assert.equal(daily.recovered.extensions.backgroundVersion, '2.0.0')
  assert.equal(daily.extensionOperations.confirmations.length, 2)
  for (const confirmation of daily.extensionOperations.confirmations) {
    assert.equal(confirmation.pid, receipt.first.pid)
    const owner = confirmation.ownerResult
    const prepared = daily.extensionOperations.operations.find(item => item.phase === 'prepare-requested' && item.operationId === confirmation.operationId).review
    assert.equal(owner.state, 'applied'); assert.equal(owner.receipt.operationId, confirmation.operationId)
    assert.equal(owner.receipt.profileId, prepared.profileId); assert.equal(owner.receipt.extensionId, prepared.extensionId)
    assert.equal(owner.receipt.sha256, prepared.sha256); assert.equal(owner.native.sha256, prepared.sha256)
    assert.equal(owner.native.version, prepared.version); assert.equal(owner.native.application.state, 'loaded')
    assert.equal(owner.native.nativeId, daily.extensions.nativeId)
    const audit = confirmation.uiAudit
    assert.ok(['observed', 'unconfirmed'].includes(audit.state))
    assert.equal(audit.pid, receipt.first.pid); assert.equal(audit.reviewId, confirmation.operationId)
    if (audit.state === 'observed') assert.ok(audit.window && audit.action.record)
    else assert.equal(audit.actor, 'unknown')
  }
  assert.ok(receipt.dailyExtensionFixture.requests.length > 0)
  assert.ok(receipt.dailyExtensionFixture.requests.every(request => !request.cookiePresent && !request.authorizationPresent))
  assertNativeBrowserMeasurements(daily.cost); assertSourceBrowserConsumers(daily.sourceConsumers)
  assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
  assert.equal(receipt.cleanup.privateProcessesReaped, true); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
  assert.deepEqual(receipt.cleanup.nativeObservers.remaining, [])
  assert.deepEqual(receipt.cleanup.nativeObservers.errors, [])
  assert.ok(receipt.visual.frames.length >= 7)
}


await mkdir(output, { recursive: true })
if (!fresh) {
  let index
  try { index = JSON.parse(await readFile(indexPath, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No original daily-workface proof exists. Run this command with explicit --fresh to launch its private App; default never launches or silently refreshes.'); throw error }
  const bytes = await readFile(index.receipt.path); assert.equal(sha(bytes), index.receipt.sha256)
  const receipt = JSON.parse(bytes); check(receipt)
  await checkIntegrationMutation(index.mutation, receipt)
  const originalInputs = Object.entries(receipt.identityBefore)
  assert.ok(originalInputs.length > 0, 'The original daily proof must bind nonempty source and artifact inputs')
  const byPath = ([left], [right]) => left.localeCompare(right)
  assert.deepEqual(index.inputs.map(item => [item.path, item.sha256]).sort(byPath), originalInputs.sort(byPath),
    'Daily proof inputs must preserve the complete original path/hash set without omissions or duplicates')
  for (const item of index.inputs) {
    const current = await readFile(isAbsolute(item.path) ? item.path : join(repo, item.path))
    assert.equal(sha(current), item.sha256, `Daily workface proof input changed: ${item.path}. No App was launched; inspect drift and use explicit --fresh only when intended.`)
    assert.equal(sha(await readFile(item.archived)), item.sha256, `Original proof bytes changed: ${item.archived}`)
  }
  for (const item of [...index.frames, ...(index.evidence ?? []), ...(index.references ?? [])]) assert.equal(sha(await readFile(item.path)), item.sha256)
  const visual = index.aestheticReview
  assert.ok(visual && typeof visual === 'object' && visual.path && visual.sha256, 'The exact original frames still need independent visual review.')
  const reviewBytes = await readFile(visual.path); assert.equal(sha(reviewBytes), visual.sha256)
  const review = JSON.parse(reviewBytes)
  assert.equal(review.approved, true); assert.ok(review.reviewer && review.reviewer !== review.author)
  assert.ok(review.images?.length >= 7, 'Independently review the actual normal, narrow, short, result-reader and restored views.')
  for (const label of ['normal-task-data-outcomes', 'narrow-task-data-outcomes', 'short-task-data-outcomes', 'normal-task-data-original-fields', 'normal-task-data-restored', 'daily-original-mixed-workface', 'daily-restored-profile-environment']) {
    const candidates = index.frames.filter(frame => frame.label === label && ['os', 'renderer'].includes(frame.kind))
    assert.ok(candidates.some(frame => review.images.some(image => image.path === frame.path && image.sha256 === frame.sha256)), 'A required current full-window view was not reviewed: ' + label)
  }
  for (const reviewed of review.images) assert.ok(index.frames.some(frame => frame.path === reviewed.path && frame.sha256 === reviewed.sha256), 'Visual review must name this exact attempt’s original images')
  console.log(JSON.stringify({ passed: true, appLaunched: false, receipt: index.receipt.path, aestheticReview: visual, scope: 'Original daily-workface native proof, unchanged source/artifact inputs and exact independently reviewed frames; no new App operation.' }))
} else {
  const attempt = await mkdtemp(join(output, 'attempt-'))
  const invocationId = randomUUID()
  const result = await new Promise((done, fail) => {
    const env = { ...process.env, AGENTMUX_DAILY_PROBE_ID: invocationId }; delete env.AGENTMUX_BROWSER_NATIVE_PROOF_INDEX
    const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-daily-workface'], { cwd: repo, env, stdio: 'inherit' })
    child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
  })
  const receiptBytes = await readFile(join(repo, '.tmp/browser-daily-workface-last.json'))
  const receipt = JSON.parse(receiptBytes), receiptPath = join(attempt, 'receipt.json')
  assert.equal(receipt.dailyProbeId, invocationId, 'A stale last receipt cannot stand in for this invocation or authorize cleanup')
  await writeFile(receiptPath, receiptBytes)
  const inputs = [], frames = [], evidence = [], blobs = join(dirname(output), 'proof-blobs')
  await mkdir(blobs, { recursive: true })
  for (const [path, expected] of Object.entries(receipt.identityBefore ?? {})) {
    const bytes = await readFile(isAbsolute(path) ? path : join(repo, path))
    assert.equal(sha(bytes), expected, 'Input drift before independent byte preservation: ' + path)
    const archived = join(blobs, expected)
    // Reuse immutable content without another Electron/compiled-tree copy. The
    // new hard link survives cleanup of the historical proof's directory entry.
    try { await link(join(dirname(output), 't003-native/blobs', expected), archived) }
    catch (error) {
      if (error.code === 'ENOENT') {
        try { await writeFile(archived, bytes, { flag: 'wx' }) }
        catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError }
      } else if (error.code !== 'EEXIST') throw error
    }
    assert.equal(sha(await readFile(archived)), expected, 'An immutable proof blob changed')
    inputs.push({ path, kind: /(?:\/out\/|\/dist\/|\/resources\/bin\/|\/\.build\/)/.test(path) || isAbsolute(path) ? 'artifact' : 'source', sha256: expected, archived })
  }
  for (const frame of receipt.visual?.frames ?? []) {
    for (const [kind, original] of [['renderer', frame.file], ['native', frame.nativePage?.file]]) {
      if (!original) continue
      const path = join(attempt, frame.label + '-' + kind + '.png'); await copyFile(original, path)
      frames.push({ label: frame.label, kind, path, sha256: sha(await readFile(path)) })
    }
  }
  for (const frame of receipt.visual?.osFrames ?? []) {
    for (const [kind, original] of [['os', frame.file], ['os-state', frame.stateFile]]) {
      const path = join(attempt, frame.label + '-' + kind + (kind === 'os' ? '.png' : '.json')); await copyFile(original, path)
      frames.push({ label: frame.label, kind, path, sha256: sha(await readFile(path)) })
    }
  }
  for (const original of [...(receipt.taskData?.artifactFiles ?? []), ...(receipt.taskData?.durableFiles ?? []), ...(receipt.dailyEvidence ?? [])]) {
    const path = join(attempt, original.sha256 + '-' + original.file.split('/').at(-1)); await copyFile(original.file, path)
    assert.equal(sha(await readFile(path)), original.sha256)
    evidence.push({ ...original, path })
  }
  for (const host of receipt.privateElectronHosts ?? []) {
    const bytes = Buffer.from(host.source)
    assert.equal(sha(bytes), host.sha256)
    const path = join(attempt, 'bootstrap-' + host.label + '.cjs'); await writeFile(path, bytes, { flag: 'wx' })
    evidence.push({ kind: 'private-electron-bootstrap', path, sha256: host.sha256 })
  }
  const retained = receipt.daily?.privateTaskDataReference
  const references = retained ? [retained] : []
  const index = { references, schema: 'agentmux.browser-daily-workface-proof.v1', receipt: { path: receiptPath, sha256: sha(receiptBytes) }, inputs, frames, evidence, aestheticReview: 'not-performed', command: [process.execPath, import.meta.filename, '--fresh'], boundary: 'Generated and compiled input bytes and original data artifacts are archived independently per attempt; no subsequent build may overwrite this proof. Actual native actions and original durable owners, normal quit only.' }
  await writeFile(join(attempt, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  const captured = resolve(receipt.visual.captureDirectory)
  assert.ok(captured.startsWith(join(repo, '.tmp/browser-operation-visual-')), 'Only this invocation’s original private capture directory may be removed')
  if (receipt.cleanup.privateProcessesReaped) {
    await rm(captured, { recursive: true })
    for (const host of receipt.privateElectronHosts ?? []) {
      assert.equal(resolve(host.entry), join(repo, 'apps/desktop/out/main', `private-daily-workface-${host.label}.cjs`))
      assert.equal(sha(await readFile(host.entry)), host.sha256, 'An altered bootstrap stays available for its actual owner')
      await rm(host.entry)
    }
  }
  assert.equal(result.signal, null); assert.equal(result.code, 0, JSON.stringify(receipt.failure))
  check(receipt)
  const mutationPath = join(output, `partition-mutation-${receipt.identityBefore['apps/desktop/out/main/index.js']}.json`)
  index.mutation = { path: mutationPath, sha256: sha(await readFile(mutationPath)) }
  await checkIntegrationMutation(index.mutation, receipt)
  await writeFile(join(attempt, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, appLaunched: true, receipt: receiptPath, index: indexPath, aestheticReview: 'not-performed', privateResources: receipt.cleanup }))
}
