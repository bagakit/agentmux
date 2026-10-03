import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// A bounded evidence join. It never connects to a Host or repeats an approved Runtime run.
const root = path.resolve(import.meta.dirname, '../../..'), task = 'T-005'
const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
assert.ok(!flag('--task') || flag('--task') === task)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = file => fs.readFile(path.resolve(root, file))
const fixture = 'apps/mobile/scripts/fixtures/mote-daily-connected/'
const ownPaths = [
  'apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/mobile.css',
  'apps/mobile/src/navigation/MobileGoalWork.tsx', 'apps/mobile/src/navigation/goal-work.ts',
  'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/test/connected-goal.test.tsx',
  'apps/mobile/test/device-workface.test.tsx', 'docs/design/behavior/session-recovery.md',
  ...['vitest.config.mts', 'source-probe.mjs', 'types-probe.mjs', 'capture-connected.mjs', 'connected-entry.tsx', 'connected-main.cjs'].map(name => fixture + name),
  ...['runtime-owner.ts', 'runtime-probe.mjs'].map(name => 'apps/desktop/scripts/fixtures/mote-daily-device/' + name),
  'apps/desktop/scripts/verify-mote-daily-connected.mjs'
].sort()
async function reference(file, base) {
  assert.ok(file, 'An explicit original receipt is required')
  return { file: path.relative(root, path.resolve(root, file)), sha256: hash(await bytes(file)), ...(base ? { base } : {}) }
}
async function artifact(ref) {
  assert.ok(ref?.file && /^[a-f0-9]{64}$/.test(ref.sha256), 'A nonempty exact artifact is required')
  const original = await bytes(ref.file)
  assert.equal(hash(original), ref.sha256, 'Artifact changed: ' + ref.file)
  return JSON.parse(original)
}
async function exactFile(file, sha256) {
  assert.match(sha256, /^[a-f0-9]{64}$/)
  assert.equal(hash(await bytes(file)), sha256, 'Original bytes changed: ' + file)
}
const gitHashes = new Map()
function gitHash(ref, file) {
  const key = ref + ':' + file
  if (!gitHashes.has(key)) gitHashes.set(key, hash(execFileSync('git', ['show', key], { cwd: root, maxBuffer: 30 * 1024 * 1024 })))
  return gitHashes.get(key)
}
async function originalSource(source, manifest, mainRef, label, dependencyBase = '') {
  assert.ok(source && Object.keys(source).length > 0, 'Nonempty actual ' + label + ' Source required')
  const currentMain = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim()
  for (const [file, sha256] of Object.entries(source)) {
    if (file.includes('node_modules')) { await exactFile(path.join(dependencyBase, file), sha256); continue }
    if (manifest.paths[file]) {
      assert.equal(sha256, manifest.paths[file], label + ' candidate differs: ' + file)
      await exactFile(file, sha256)
    } else {
      assert.equal(gitHash(mainRef, file), sha256, label + ' pinned Main differs: ' + file)
      assert.equal(gitHash(currentMain, file), sha256, label + ' current Main drift: ' + file)
    }
  }
}
const callerChecks = [
  ['original Mobile workface', 'apps/mobile/src/navigation/MobileGoalWork.tsx', 'apps/mobile/src/MobileApp.tsx', '<MobileGoalWork'],
  ['original persisted selection', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/navigation/MobileGoalWork.tsx', 'owner.selectGoal(target)'],
  ['original pending operation', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/navigation/MobileGoalWork.tsx', 'owner.retainGoalOperation(operation)'],
  ['exact receipt retirement', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/navigation/goal-work.ts', 'owner.confirmGoalOperation(operation)'],
  ['one original public Goal caller', 'apps/mobile/src/navigation/goal-work.ts', 'apps/mobile/src/navigation/MobileGoalWork.tsx', 'await sendGoalOperation('],
  ['original public Goal list', 'packages/core/src/public-rpc.ts', 'apps/mobile/src/navigation/MobileGoalWork.tsx', "client.forwardRpc('goal.ls'"],
  ['original public Goal start', 'packages/core/src/public-rpc.ts', 'apps/mobile/src/navigation/goal-work.ts', "client.forwardRpc('goal.start'"],
  ['original public Goal action', 'packages/core/src/public-rpc.ts', 'apps/mobile/src/navigation/goal-work.ts', "client.forwardRpc('goal.continuation-action'"],
  ['final Host navigation admission', 'apps/mobile/src/navigation/goal-work.ts', 'apps/mobile/src/navigation/MobileGoalWork.tsx', 'admitsGoalWorkTarget(selection, goalWorkTarget(']
]
async function qualify(raw, manifest) {
  assert.equal(raw.schema, 'agentmux.mobile.goal-original-host-qualification.v1')
  assert.equal(raw.task, task); assert.equal(raw.passed, true)
  assert.deepEqual(Object.keys(manifest.paths).sort(), ownPaths, 'Exact nonempty owned product set required')
  assert.deepEqual(raw.ownPaths, ownPaths)
  for (const [file, sha256] of Object.entries(manifest.paths)) await exactFile(file, sha256)
  const source = await artifact(raw.references.source), types = await artifact(raw.references.types)
  const baselineTypes = await artifact(raw.references.baselineTypes), nativeTypes = await artifact(raw.references.nativeTypes)
  const renderer = await artifact(raw.references.renderer), runtime = await artifact(raw.references.runtime)
  assert.equal(source.schema, 'agentmux.mobile.goal-source.v1'); assert.equal(source.passed, true)
  assert.equal(source.mutants.length, 19)
  assert.equal(new Set(source.mutants.map(row => row.name)).size, 19)
  if (source.reusedQualification) {
    const reuse = source.reusedQualification, prior = await artifact(reuse.reference)
    assert.equal(prior.passed, true); assert.equal(prior.mutants.length, 19); assert.equal(reuse.mutants.length, 18)
    assert.ok(!reuse.mutants.includes('late-intent'))
    for (const name of reuse.mutants) assert.deepEqual(source.mutants.find(row => row.name === name), prior.mutants.find(row => row.name === name))
    for (const delta of [reuse.testDelta, reuse.producerDelta]) {
      assert.equal(prior.source[delta.file], delta.beforeSha256)
      await exactFile(delta.beforeFile, delta.beforeSha256); await exactFile(delta.file, delta.afterSha256)
      assert.equal(source.source[delta.file], delta.afterSha256)
    }
    assert.equal(reuse.testDelta.file, 'apps/mobile/test/connected-goal.test.tsx')
    assert.equal(reuse.producerDelta.file, fixture + 'source-probe.mjs')
    const before = (await bytes(reuse.testDelta.beforeFile)).toString(), after = (await bytes(reuse.testDelta.file)).toString()
    assert.equal(before.split(reuse.testDelta.start).length, 2); assert.equal(after.split(reuse.testDelta.start).length, 2)
    assert.equal(before.split(reuse.testDelta.start)[0], after.split(reuse.testDelta.start)[0])
    assert.equal(before.split(reuse.testDelta.end).length, 2); assert.equal(after.split(reuse.testDelta.end).length, 2)
    assert.equal(before.split(reuse.testDelta.end)[1], after.split(reuse.testDelta.end)[1])
    assert.deepEqual(Object.keys(prior.source).sort(), Object.keys(source.source).sort())
    for (const [file, sha256] of Object.entries(prior.source)) if (![reuse.testDelta.file, reuse.producerDelta.file].includes(file)) assert.equal(source.source[file], sha256)
  }
  for (const run of [source.initial, source.restored]) {
    assert.equal(run.exitCode, 0); assert.equal(run.signal, null)
    assert.equal(run.passedTests, 42); assert.equal(run.failedTests, 0)
    for (const [name, shaName] of [['log', 'logSHA'], ['report', 'reportSHA'], ['loaded', 'loadedSHA']]) await exactFile(run[name], run[shaName])
  }
  for (const mutation of source.mutants) {
    assert.notEqual(mutation.exitCode, 0); assert.equal(mutation.signal, null); assert.equal(mutation.assertionRed, true)
    assert.equal(mutation.rows.length, 1); assert.notEqual(mutation.rows[0].beforeSha256, mutation.rows[0].afterSha256)
    for (const [name, shaName] of [['log', 'logSHA'], ['report', 'reportSHA'], ['loaded', 'loadedSHA']]) await exactFile(mutation[name], mutation[shaName])
    const report = JSON.parse((await bytes(mutation.report)).toString())
    assert.ok(report.testResults.flatMap(row => row.assertionResults).some(row => row.status === 'failed' && row.failureMessages.some(message => message.includes('AssertionError'))))
  }
  const loaded = (await bytes(source.restored.loaded)).toString().trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
  assert.ok(loaded.some(row => row.consumer === 'actual-vite-module' && row.file.startsWith('packages/core/src/')))
  assert.ok(loaded.some(row => row.file === 'apps/mobile/src/MobileApp.tsx'))
  await originalSource(source.source, manifest, raw.mainRef, 'owning loaded')
  assert.ok(types.roots.length > 0 && baselineTypes.roots.length > 0)
  assert.equal(types.diagnosticCount, types.diagnostics.length)
  assert.equal(baselineTypes.diagnosticCount, baselineTypes.diagnostics.length)
  // Existing Relay errors remain visible. An identical original Main baseline is not full strict zero.
  assert.deepEqual(types.diagnostics, baselineTypes.diagnostics, 'New type diagnostics cannot borrow old Relay qualification')
  assert.ok(baselineTypes.baselineMain)
  for (const diagnostic of types.diagnostics) {
    assert.ok(diagnostic.file && !ownPaths.includes(diagnostic.file), 'Owned source must have zero type diagnostics')
    assert.equal(types.source[diagnostic.file], baselineTypes.source[diagnostic.file], 'A changed failed dependency needs its own qualification')
    assert.equal(gitHash(baselineTypes.baselineMain, diagnostic.file), baselineTypes.source[diagnostic.file])
  }
  await originalSource(types.source, manifest, raw.mainRef, 'owning types')
  assert.ok(Object.keys(types.dependencies).length > 0)
  for (const [file, sha256] of Object.entries(types.dependencies)) await exactFile(path.join(raw.references.types.base ?? '', file), sha256)
  assert.ok(nativeTypes.roots.includes('apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts'))
  assert.deepEqual(nativeTypes.diagnostics, baselineTypes.diagnostics)
  await originalSource(nativeTypes.source, manifest, raw.nativeTypeMainRef, 'private Host caller types')
  assert.ok(Object.keys(nativeTypes.dependencies).length > 0)
  for (const [file, sha256] of Object.entries(nativeTypes.dependencies)) await exactFile(path.join(raw.references.nativeTypes.base ?? '', file), sha256)
  assert.equal(renderer.passed, true); assert.equal(renderer.renderer.passed, true); assert.equal(renderer.process.exitCode, 0)
  assert.equal(renderer.captureOnly, true); assert.equal(renderer.captureSubset, 'connected-goal-work')
  assert.equal(Object.keys(renderer.images).length, 8)
  assert.equal(renderer.renderer.operations.length, 8)
  for (const operation of renderer.renderer.operations) assert.equal(operation.overflow, false)
  const unknown = renderer.renderer.operations.find(row => row.name === 'goal-unknown-operation-phone')
  const offline = renderer.renderer.operations.find(row => row.name === 'goal-offline-retains-phone')
  const result = renderer.renderer.operations.find(row => row.name === 'goal-result-phone')
  const foreign = renderer.renderer.operations.find(row => row.name === 'goal-foreign-host-wide')
  assert.equal(unknown.record.goalWork.pending.length, 1)
  assert.deepEqual(offline.record.goalWork.pending, unknown.record.goalWork.pending)
  assert.equal(result.record.goalWork.pending.length, 0)
  assert.notEqual(foreign.runtimeId, result.runtimeId)
  assert.ok(offline.text.includes('Host 连接中断') && foreign.text.includes('当前连接尚未确认同一身份'))
  const actions = result.calls.filter(row => row.method === 'goal.continuation-action')
  assert.equal(actions.length, 2); assert.deepEqual(actions[0].params, actions[1].params)
  await originalSource(renderer.source, manifest, raw.mainRef, 'actual operated Renderer', raw.references.renderer.dependencyBase ?? raw.references.renderer.base ?? '')
  for (const [file, sha256] of Object.entries(renderer.images)) await exactFile(path.join(raw.references.renderer.base ?? '', file), sha256)
  assert.equal(runtime.passed, true); assert.equal(runtime.taskId, task)
  assert.equal(runtime.schema, 'agentmux.mobile-goal.original-runtime-recovery.v1')
  assert.equal(runtime.userRunTouched, false)
  assert.ok(runtime.phases.length === 2 && runtime.phases[0].pid !== runtime.phases[1].pid)
  assert.deepEqual(runtime.sourceChanges, [])
  await originalSource(runtime.source, manifest, runtime.mainRef, 'actual original SDK and private Host')
  assert.ok(Object.keys(runtime.source).length > 100)
  assert.ok(Object.keys(runtime.harnessSource).length === 2 && Object.keys(runtime.overlays).length >= 3)
  for (const [file, sha256] of Object.entries(runtime.harnessSource)) await exactFile(file, sha256)
  assert.equal(runtime.beforeRestart.owner.runtimeId, runtime.restored.owner.runtimeId)
  assert.notEqual(runtime.beforeRestart.owner.ownerInstanceId, runtime.restored.owner.ownerInstanceId)
  assert.equal(runtime.restored.hostedOwner.runtimeId, runtime.restored.owner.runtimeId)
  for (const field of ['runId', 'pid', 'workspacePath']) assert.equal(runtime.beforeRestart.run[field], runtime.restored.run[field])
  assert.equal(runtime.beforeRestart.run.state, 'running'); assert.equal(runtime.restored.run.state, 'running')
  assert.equal(runtime.beforeRestart.session.id, runtime.restored.session.id)
  assert.deepEqual(runtime.beforeRestart.loop, runtime.restored.loop)
  assert.deepEqual(runtime.beforeRestart.device.record, runtime.restored.device.record)
  assert.deepEqual(runtime.beforeRestart.launcher, runtime.restored.launcher)
  assert.equal(runtime.operation.kind, 'action'); assert.equal(runtime.operation.action, 'pause')
  assert.deepEqual(runtime.pause.after.device.record.goalWork.pending, [runtime.operation])
  assert.equal(runtime.pause.after.loop.status, 'paused')
  assert.deepEqual(runtime.retry.operation, runtime.operation)
  assert.deepEqual(runtime.retry.after.device.record.goalWork.pending, [])
  assert.equal(runtime.retry.after.loop.lastMutation.operationId, runtime.operation.operationId)
  assert.equal(runtime.retry.after.loop.revision, runtime.pause.after.loop.revision)
  assert.equal(runtime.retry.before.run.acceptedInputBytes, runtime.retry.after.run.acceptedInputBytes)
  assert.equal(runtime.noDuplicateNativeInput, true)
  assert.equal(runtime.inputs.length, 2)
  for (const input of runtime.inputs) {
    assert.ok(input.after.run.acceptedInputBytes > input.before.run.acceptedInputBytes)
    assert.equal(input.after.run.state, 'running'); assert.ok(input.after.output.includes(input.label))
  }
  assert.ok(runtime.actualCalls.some(row => row.method === 'goal.ls' && row.result.goals.some(goal => goal.id === runtime.operation.goalId)))
  assert.ok(runtime.actualCalls.some(row => row.method === 'goal.inspect' && row.result.goal.id === runtime.operation.goalId))
  const actualActions = runtime.actualCalls.filter(row => row.method === 'goal.continuation-action')
  assert.equal(actualActions.length, 2)
  for (const row of actualActions) {
    assert.equal(row.params.operationId, runtime.operation.operationId)
    assert.equal(row.context.runtimeFence.runtimeId, runtime.operation.runtimeId)
    assert.equal(row.result.diskDurability, 'confirmed')
  }
  const controlActions = [runtime.pause.after, runtime.retry.after].flatMap(row => row.controlCalls).filter(row => row.request.operation === 'demand.continuation-action')
  assert.equal(controlActions.length, 2)
  for (const { request } of controlActions) {
    assert.equal(request.requestId, runtime.operation.operationId); assert.equal(request.demandId, runtime.operation.goalId)
    assert.equal(request.loopId, runtime.operation.loopId); assert.equal(request.action, runtime.operation.action)
    assert.equal(request.expectedRevision, runtime.operation.expectedRevision)
  }
  assert.equal(runtime.result.inspected.goal.status, 'done')
  assert.equal(runtime.result.after.loop.status, 'stopped'); assert.equal(runtime.result.after.run.state, 'running')
  assert.ok(Array.isArray(runtime.actualCallees) && runtime.actualCallees.length >= 6)
  assert.equal(runtime.sourceCli.method, 'goal.inspect'); assert.equal(runtime.sourceCli.params.goalId, runtime.operation.goalId)
  assert.equal(runtime.sourceCli.result.ok, true); assert.equal(runtime.sourceCli.result.result.goal.id, runtime.operation.goalId)
  const runtimeEvidence = path.dirname(raw.references.runtime.file)
  await exactFile(path.join(runtimeEvidence, 'source-cli-inspect.log'), runtime.sourceCli.logSha256)
  await exactFile(path.join(runtimeEvidence, runtime.nativeOrderedInput.path), runtime.nativeOrderedInput.sha256)
  const ordered = (await bytes(path.join(runtimeEvidence, runtime.nativeOrderedInput.path))).toString().trim().split('\n').map(line => JSON.parse(line))
  assert.equal(ordered.length, runtime.nativeOrderedInput.chunks)
  assert.equal(ordered.filter(row => row.data === runtime.nativeOrderedInput.initialPrompt).length, 1)
  for (const input of runtime.inputs) assert.equal(ordered.filter(row => row.data === input.label).length, 1)
  assert.ok(ordered.every((row, index) => row.sequence === index + 1))
  assert.equal(runtime.cleanup.exactPrivateRunStopped, true); assert.equal(runtime.cleanup.privateRootRemoved, true)
  assert.deepEqual(runtime.cleanup.errors, [])
  assert.equal(raw.callers.length, callerChecks.length)
  for (const row of raw.callers) {
    assert.notEqual(row.definition, row.caller); assert.ok(row.line > 0)
    await exactFile(row.caller, row.sha256)
    assert.ok((await bytes(row.caller)).toString().includes(row.anchor))
  }
  return { source, types, baselineTypes, renderer, runtime }
}

if (process.argv.includes('--assemble')) {
  const references = {}
  for (const [name, option] of Object.entries({ source: '--source-proof', types: '--types-proof', baselineTypes: '--baseline-types-proof', nativeTypes: '--native-types-proof', renderer: '--renderer-proof', runtime: '--runtime-proof' })) {
    references[name] = await reference(flag(option), name === 'renderer' ? flag('--renderer-base') : name === 'types' || name === 'nativeTypes' ? flag('--types-base') : undefined)
  }
  if (flag('--renderer-dependency-base')) references.renderer.dependencyBase = flag('--renderer-dependency-base')
  const candidateManifest = await reference(flag('--manifest')), manifest = await artifact(candidateManifest)
  const raw = { schema: 'agentmux.mobile.goal-original-host-qualification.v1', task, passed: true,
    mainRef: flag('--main-ref'), nativeTypeMainRef: flag('--native-type-main-ref'), candidateManifest, ownPaths, references, callers: [], limitations: [
      'Original connected MobileApp/Goal/Device Workface uses existing public methods. No new backend, Store, transport or clock.',
      'Controlled SDK replies qualify actual Mobile Renderer layout and interaction; the separate original hosted SDK/private Core proof qualifies public forwarding, same-operation and healthy Run recovery.',
      'Expanded TypeScript graph retains its exact original Main Relay diagnostics; owned mobile source has no new diagnostics. This is not a full-program strict-zero claim.',
      'Actual Renderer proof preserves original Composer DOM/text/draft and selected Core Session; it does not claim DOM Range restoration.',
      'No model, live Relay network, device OS, package, installation or user App/Run qualification.' ] }
  assert.match(raw.mainRef, /^[a-f0-9]{40}$/)
  assert.match(raw.nativeTypeMainRef, /^[a-f0-9]{40}$/)
  for (const [symbol, definition, caller, anchor] of callerChecks) {
    const text = (await bytes(caller)).toString(); assert.ok(text.includes(anchor))
    raw.callers.push({ symbol, definition, caller, anchor, line: text.slice(0, text.indexOf(anchor)).split('\n').length, sha256: hash(text) })
  }
  await qualify(raw, manifest)
  const output = path.resolve(root, flag('--evidence-dir') ?? '.tmp/mote-daily-connected/qualification-raw')
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(raw, null, 2) + '\n')
  console.log(path.relative(root, path.join(output, 'receipt.json')))
} else {
  const locator = JSON.parse((await bytes(process.env.AGENTMUX_DAILY_CONNECTED_QUALIFICATION ?? '.tmp/mote-daily-connected/qualification.json')).toString())
  const raw = await artifact(locator.receipt), manifest = await artifact(locator.manifest), review = await artifact(locator.review)
  assert.equal(review.approved, true); assert.ok(review.tasks.includes(task))
  assert.equal(review.sourceGate.sha256, locator.receipt.sha256)
  assert.equal(review.candidateManifest.sha256, locator.manifest.sha256)
  assert.equal(review.captureReceipt.sha256, raw.references.renderer.sha256)
  assert.equal(review.runtimeReceipt.sha256, raw.references.runtime.sha256)
  assert.deepEqual(raw.candidateManifest, locator.manifest)
  await qualify(raw, manifest)
  const output = path.join(root, '.tmp/mote-daily-connected/normal-' + globalThis.crypto.randomUUID() + '.json')
  await fs.writeFile(output, JSON.stringify({ passed: true, task, receipt: locator.receipt, manifest: locator.manifest, review: locator.review }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: path.relative(root, output) }))
}
