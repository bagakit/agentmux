import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { probePublishedPublic, publicHarnessPaths } from './fixtures/mote-directory-short-public/probe.mjs'
const repository = resolve(import.meta.dirname, '../../..'), option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = (value, label) => assert.ok(value && Object.keys(value).length > 0, label + ' cannot be empty')
if (process.argv.includes('--run')) {
  await probePublishedPublic({ repository, evidence: option('--evidence-dir'), mainRef: option('--main-ref') })
} else {
  const locator = JSON.parse(await readFile(join(repository, '.tmp/mote-directory-short-public/candidate-public.json'), 'utf8').catch(error => {
    throw Error('Approved public qualification locator is unavailable. Execute --run first and bind its independent review. ' + error.message)
  }))
  const rawFile = resolve(repository, option('--raw') ?? locator.raw.path), rawBytes = await readFile(rawFile), raw = JSON.parse(rawBytes)
  const reviewFile = resolve(repository, option('--review') ?? locator.review.path), reviewBytes = await readFile(reviewFile), review = JSON.parse(reviewBytes)
  const candidateFile = resolve(repository, locator.candidateManifest.path), candidateBytes = await readFile(candidateFile)
  assert.equal(digest(rawBytes), locator.raw.sha256); assert.equal(digest(reviewBytes), locator.review.sha256)
  assert.equal(digest(candidateBytes), locator.candidateManifest.sha256)
  assert.equal(review.status, 'approved'); assert.ok(review.tasks.includes('T-003'))
  assert.equal(review.sourceGate.sha256, locator.raw.sha256, 'Independent review must approve this exact public run')
  assert.equal(review.candidateManifest.sha256, locator.candidateManifest.sha256, 'Independent review must bind this exact candidate')
  assert.equal(raw.passed, true); nonempty(raw.source, 'Actual compiled Source'); nonempty(raw.harnessSource, 'Harness Source')
  assert.deepEqual(Object.keys(raw.harnessSource).sort(), [...publicHarnessPaths].sort())
  for (const component of ['mainOwner', 'sourceCLI', 'preload', 'renderer', 'actualIpcStatements']) {
    nonempty(raw.compiledImports[component], component)
    for (const [file, sha] of Object.entries(raw.compiledImports[component])) assert.equal(raw.source[file], sha, component + ' Source mismatch: ' + file)
  }
  const requiredSource = ['packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/src/agentmux.ts', 'packages/core/src/spatial-state.ts', 'apps/desktop/src/main/control-ipc-bridge.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/desktop-host.ts', 'apps/desktop/src/main/file-read-owner.ts',
    'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts']
  for (const file of requiredSource) assert.match(raw.source[file], /^[a-f0-9]{64}$/, 'Original production caller is missing: ' + file)
  assert.match(raw.actualIpcStatements.compiledStatementsSha256, /^[a-f0-9]{64}$/)
  for (const channel of ['spatial:commit', 'files:readPublic', 'sessions:launchAgent', 'sessions:write', 'ui:requestStorageFlush']) assert.ok(raw.actualIpcStatements.channels.includes(channel))
  assert.equal(raw.phases.length, 2); assert.deepEqual(raw.phases.map(one => one.phase), ['seed', 'restore'])
  const [seed, restore] = raw.phases.map(one => one.app)
  assert.notEqual(seed.pid, restore.pid)
  for (const phase of raw.phases) {
    const proof = phase.app; assert.equal(phase.exit.timedOut, false); assert.equal(phase.exit.exitCode, 0); assert.equal(proof.passed, true)
    assert.equal(proof.userRunTouched, false); assert.deepEqual(proof.cleanupErrors, [])
    assert.ok(proof.typedRPC.filter(one => one.method === 'app.snapshot').length >= 2)
    assert.ok(proof.typedRPC.filter(one => one.method === 'file.read').length >= 2)
    assert.ok(proof.sourceCLI.filter(one => one.args[0] === 'app' && one.args[1] === 'snapshot').length >= 2)
    assert.ok(proof.sourceCLI.filter(one => one.args[0] === 'file' && one.args[1] === 'read').length >= 2)
    for (const query of proof.typedRPC.filter(one => one.method === 'file.read')) {
      assert.equal(query.result.result.status, 'read'); assert.match(query.result.result.document.revision, /^sha256:[a-f0-9]{64}$/)
      assert.equal(query.result.resource.zoneId, query.params.zoneId); assert.equal(query.result.resource.hostId, query.params.expectedResource.hostId)
    }
    assert.ok(proof.readOnlyChecks.length >= 2)
    for (const check of proof.readOnlyChecks) { assert.equal(check.metadataBytesPreserved, true); assert.equal(check.noteBytesPreserved, true); assert.deepEqual(check.badDirectoryEntries, []) }
    for (const input of [proof.inputBefore, proof.inputAfter]) {
      assert.equal(input.before.run.state, 'running'); assert.equal(input.after.run.state, 'running')
      assert.equal(input.native.pid, input.before.run.pid); assert.equal(input.after.run.pid, input.before.run.pid)
      assert.equal(input.after.run.runId, input.before.run.runId); assert.equal(input.after.run.workspacePath, input.before.run.workspacePath)
      assert.deepEqual(input.native.object, input.before.target.object)
      assert.ok(input.before.run.acceptedInputBytes !== null && input.after.run.acceptedInputBytes > input.before.run.acceptedInputBytes)
    }
  }
  const opened = seed.typedRPC.find(one => one.method === 'agent.open'); assert.ok(opened); assert.equal(opened.result.outcome, 'opened')
  assert.equal(opened.result.save.diskDurability, 'confirmed')
  const request = seed.bridgeRequests.find(one => one.requestId === opened.params.operationId)
  assert.equal(request.operation, 'agent.open'); assert.deepEqual(request.content, opened.params.content)
  const response = seed.acceptedResponses.find(one => one.requestId === request.requestId); assert.equal(response.ok, true)
  // The original public codec renames transaction identity; its remaining payload is unchanged.
  const { operation, requestId, ...controlPayload } = response.result
  const { operationId, ...publicPayload } = opened.result
  assert.equal(operation, request.operation); assert.equal(requestId, operationId); assert.equal(operationId, opened.params.operationId)
  assert.deepEqual(controlPayload, publicPayload)
  assert.ok(seed.calls.some(one => one.channel === 'sessions:launchAgent')); assert.ok(seed.calls.some(one => one.channel === 'spatial:commit'))
  assert.equal(seed.final.native.target.agentSessionId, opened.result.agent.agentSessionId)
  assert.equal(seed.final.native.run.runId, opened.result.agent.runId)
  assert.equal(seed.final.native.run.workspacePath, opened.result.agent.cwd)
  assert.match(seed.newCreation.physicalDirectoryPath.split('/').at(-1), /^[a-f0-9]{16}$/)
  const newRegion = seed.newCreation.selection.regionId
  assert.equal(seed.beforeRestart.workbench.drafts[newRegion], 'New Mote unsent request')
  assert.equal(seed.beforeRestart.workbench.launcherState.drafts[newRegion].note, 'New Mote utility draft')
  assert.equal(seed.maintenance.objects.find(one => one.id === 'launcher:public-original').state, 'migrated')
  assert.equal(seed.maintenance.success, false); assert.ok(seed.maintenance.issues.some(one => one.code === 'DIRECTORY_IDENTITY_INVALID'))
  assert.deepEqual(restore.restored.after.workbench, seed.beforeRestart.workbench)
  assert.deepEqual(restore.restored.after.native.saved, seed.beforeRestart.native.saved)
  for (const key of ['runId', 'pid', 'workspacePath', 'state']) assert.equal(restore.restored.after.native.run[key], seed.beforeRestart.native.run[key])
  assert.equal(restore.exactPrivateRunStopped, true)
  assert.equal(raw.cleanup.exactPrivateRunsStopped, true); assert.equal(raw.cleanup.privateRootRemoved, true); assert.deepEqual(raw.cleanup.errors, [])
  assert.deepEqual(raw.remainingOwnedProcesses, [])
  const wrapperPath = 'apps/desktop/scripts/verify-mote-directory-short-public.mjs'
  const adapterDeltas = review.adapterOnlyDeltas ?? []
  assert.ok(adapterDeltas.length <= 1 && adapterDeltas.every(delta => delta.path === wrapperPath), 'Only an explicitly reviewed normal-wrapper delta can reuse the Run')
  for (const [file, sha] of Object.entries(raw.harnessSource)) {
    const bytes = await readFile(join(repository, file)), currentSha = digest(bytes)
    if (currentSha === sha) continue
    const delta = adapterDeltas.find(one => one.path === file)
    assert.ok(delta, 'Unreviewed harness drift: ' + file)
    assert.equal(delta.rawSha256, locator.raw.sha256); assert.equal(delta.beforeSha256, sha); assert.equal(delta.afterSha256, currentSha)
    const prior = await readFile(resolve(repository, delta.beforeSource.path)); assert.equal(digest(prior), delta.beforeSource.sha256); assert.equal(digest(prior), sha)
    const runPrefix = text => {
      const start = text.indexOf("if (process.argv.includes('--run')) {")
      assert.ok(start >= 0); const end = text.indexOf('} else {', start); assert.ok(end > start)
      return text.slice(0, end)
    }
    const currentRun = runPrefix(bytes.toString()), originalRun = runPrefix(prior.toString())
    assert.equal(currentRun, originalRun, 'Actual --run entry and driver imports must remain byte identical')
    assert.equal(digest(currentRun), delta.runBranchSha256)
  }
  const current = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repository, encoding: 'utf8' }).trim()
  for (const [file, sha] of Object.entries(raw.source)) if (!(file in raw.harnessSource)) {
    assert.equal(digest(execFileSync('git', ['show', current + ':' + file], { cwd: repository, maxBuffer: 20 * 1024 * 1024 })), sha, 'Published actual Source drift: ' + file)
  }
  assert.equal(digest(execFileSync('git', ['show', current + ':' + raw.artifact.file], { cwd: repository, maxBuffer: 30 * 1024 * 1024 })), raw.artifact.sha256)
  console.log(JSON.stringify({ passed: true, qualification: 'Exact approved raw reuse', sourcePinnedMain: raw.sourcePinnedMain, currentMain: current,
    raw: rawFile, rawSha256: digest(rawBytes), reviewSha256: digest(reviewBytes), candidateManifestSha256: digest(candidateBytes), productionCallers: requiredSource.length }))
}
