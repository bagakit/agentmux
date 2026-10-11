import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyReport, verifySourcePins } from './session-capability-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const parse = async file => JSON.parse(await readFile(file, 'utf8'))
const definitions = {
  T001: { name: 'session-continuity-supervision', schema: 'agentmux.session-continuity-supervision-proof.v1', minimum: 37, mutants: 10 },
  T002: { name: 'session-continuity-control', schema: 'agentmux.session-continuity-control-proof.v1', minimum: 23, mutants: 11 },
  T003: { name: 'resume-context-observation', schema: 'agentmux.resume-context-observation-proof.v1', minimum: 33, mutants: 18 },
  T006: { name: 'session-continuity-executor', schema: 'agentmux.session-continuity-executor-proof.v1', minimum: 16, mutants: 10 },
  T007: { name: 'initial-continuity-cancellation', schema: 'agentmux.initial-continuity-cancellation-proof.v1', minimum: 8, mutants: 6 }
}

/** Consume original owner artifacts; authored passed flags cannot replace raw or loaded evidence. */
export async function readSupervisionCoreOwner(root, task, receiptFile) {
  const definition = definitions[task]; assert.ok(definition, 'Unknown supervision owner task')
  const file = path.resolve(root, receiptFile), bytes = await readFile(file), receipt = JSON.parse(bytes)
  assert.equal(receipt.schema, definition.schema); assert.equal(receipt.passed, true); assert.equal(receipt.sourceStable, true)
  const gate = 'packages/core/scripts/verify-' + definition.name + '.mjs'
  const sourceInputs = await verifySourcePins(root, receipt.inputs, gate)
  const baseline = receipt.results.filter(one => one.code === 0), mutations = receipt.results.filter(one => one.code !== 0)
  assert.equal(baseline.length, 1, 'Exactly one original candidate baseline is required')
  assert.ok(mutations.length >= definition.mutants, 'Original supervision owner counterexamples are missing')
  assert.equal(new Set(receipt.results.map(one => one.name)).size, receipt.results.length)
  const cases = new Set()
  for (const result of receipt.results) {
    assert.equal(result.signal, null)
    for (const field of ['total', 'passed', 'failed']) assert.ok(Number.isSafeInteger(result[field]) && result[field] >= 0)
    const directory = path.dirname(file), reportFile = path.join(directory, result.name + '.json')
    const rows = await verifyReport(reportFile, result.code === 0, result.code === 0 ? definition.minimum : 1,
      { total: result.total, passed: result.passed, failed: result.failed })
    const moduleFile = path.join(directory, 'package/dist', result.name + '.mjs')
    assert.equal(hash(await readFile(moduleFile)), result.bundleSha256, 'Original loaded supervision module changed')
    if (result.code === 0) for (const row of rows) cases.add(row.fullName)
    else {
      assert.equal(result.code, 1); assert.equal(result.semanticRed, true)
      assert.notEqual(result.bundleSha256, baseline[0].bundleSha256)
      const failures = rows.filter(one => one.status === 'failed')
      assert.deepEqual(failures.map(one => ({ name: one.fullName, messages: one.failureMessages })), result.failures,
        'Original mutation failure identities and business assertions must match their raw report')
    }
  }
  return { task, receipt: file, sha256: hash(bytes), sourceInputs, baselineCases: [...cases], loadedCounterexamples: mutations.length }
}

/** Main wire and full Store/UI producers retain their own loaded-source witness format. */
export async function readSupervisionConsumerOwner(root, kind, receiptFile) {
  const definition = kind === 'wire'
    ? { schema: 'agentmux.continuity-control-wire-proof.v1', gate: 'verify-session-continuity-control-wire.mjs', minimum: 3, mutants: 3 }
    : kind === 'consumer'
      ? { schema: 'agentmux.continuity-supervision-consumer-proof.v1', gate: 'verify-session-continuity-supervision.mjs', minimum: 14, mutants: 12 }
      : null
  assert.ok(definition, 'Unknown supervision consumer owner')
  const file = path.resolve(root, receiptFile), bytes = await readFile(file), receipt = JSON.parse(bytes), directory = path.dirname(file)
  assert.equal(receipt.schema, definition.schema); assert.equal(receipt.passed, true); assert.equal(receipt.sourceStable, true)
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  const sourceInputs = await verifySourcePins(root, receipt.sourceBefore, 'apps/desktop/scripts/' + definition.gate)
  assert.equal(receipt.runs.filter(one => one.exitCode === 0).length, 1)
  assert.ok(receipt.runs.filter(one => one.exitCode !== 0).length >= definition.mutants)
  assert.equal(new Set(receipt.runs.map(one => one.id)).size, receipt.runs.length)
  for (const run of receipt.runs) {
    const reportFile = path.resolve(root, run.rawReport)
    assert.equal(hash(await readFile(reportFile)), run.rawSha256, 'Original consumer raw report changed')
    const report = await parse(reportFile), rows = await verifyReport(reportFile, run.exitCode === 0, run.exitCode === 0 ? definition.minimum : 1,
      { total: report.numTotalTests, passed: run.passed, failed: run.failed })
    if (run.exitCode !== 0) {
      assert.equal(run.exitCode, 1)
      const witness = await parse(path.join(directory, run.id + '.loaded.json'))
      assert.deepEqual(witness, run.witness, 'Original consumer loaded witness changed')
      assert.notEqual(witness.original, witness.loaded)
      assert.ok(Object.values(receipt.sourceBefore).includes(witness.original), 'The loaded mutation must belong to an original pinned owner')
      const target = rows.find(one => one.fullName === run.target)
      assert.equal(target?.status, 'failed', 'The original exact consumer target must fail')
      assert.ok(target.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)))
      assert.ok(target.failureMessages.every(message => !/TypeError|ReferenceError|SyntaxError/u.test(message)))
    }
  }
  return { task: 'T004-' + kind, receipt: file, sha256: hash(bytes), sourceInputs,
    baselineCases: receipt.runs.find(one => one.exitCode === 0).passed, loadedCounterexamples: receipt.runs.length - 1 }
}

/** The settings producer owns ConfigOwner, real compiled App frames and original CLI consumption. */
export async function readSupervisionSettingsOwner(root, receiptFile) {
  const file = path.resolve(root, receiptFile), bytes = await readFile(file), receipt = JSON.parse(bytes), directory = path.dirname(file)
  assert.equal(receipt.completed, true)
  const sourceInputs = await verifySourcePins(root, receipt.sourceIdentity, 'apps/desktop/scripts/verify-session-continuity-settings.mjs')
  assert.ok(receipt.runs.length >= 10); assert.equal(receipt.runs.filter(one => one.exitCode === 0).length, 1)
  assert.equal(new Set(receipt.runs.map(one => one.id)).size, receipt.runs.length)
  const plan = await parse(path.join(directory, 'mutations.json'))
  for (const run of receipt.runs) {
    const rows = await verifyReport(path.join(directory, run.id + '.tests.json'), run.exitCode === 0, run.exitCode === 0 ? 12 : 1,
      { total: 12, passed: run.passed, failed: run.failed })
    if (run.exitCode !== 0) {
      assert.equal(run.exitCode, 1); assert.ok(run.consumed > 0)
      const mutation = plan.mutants.find(one => one.id === run.id); assert.ok(mutation)
      const capture = await parse(path.join(directory, run.id + '.capture.json')), loaded = capture.loaded[mutation.file]
      assert.ok(capture.consumed > 0); assert.match(capture.compiled[mutation.file], /^[a-f0-9]{64}$/u)
      assert.equal(loaded.original, receipt.sourceIdentity[mutation.file]); assert.equal(loaded.loaded, hash(mutation.source))
      assert.notEqual(loaded.loaded, loaded.original)
      const target = rows.find(one => one.fullName === mutation.test)
      assert.equal(target?.status, 'failed'); assert.ok(target.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)))
    }
  }
  const nativeDirectory = path.join(directory, 'native'), native = await parse(path.join(nativeDirectory, 'receipt.json'))
  assert.equal(native.completed, true); assert.equal(native.sourceIdentity, receipt.native.sourceIdentity)
  assert.equal(native.sourceIdentity, hash(JSON.stringify(native.source)))
  await verifySourcePins(root, Object.fromEntries(Object.entries(native.source).map(([name, entry]) => [name, entry.sha256])),
    'apps/desktop/scripts/fixtures/session-continuity-settings/scenario.cjs')
  for (const entry of native.compiled) assert.equal(hash(await readFile(path.join(nativeDirectory, 'compiled', entry.file))), entry.sha256)
  for (const entry of native.assets) assert.equal(hash(await readFile(path.join(root, entry.file))), entry.sha256)
  assert.equal(hash(await readFile(path.join(nativeDirectory, 'owner.mjs'))), native.ownerCompiled.sha256)
  assert.deepEqual(native.remainingPrivateProcesses, []); assert.equal(native.privateRootRemoved, true)
  assert.ok(native.processes.length > 0 && native.processes.every(one => one.exitConfirmed && one.exitCode === 0 && !one.timedOut && one.cleanupErrors.length === 0))
  const scene = await parse(path.join(nativeDirectory, 'session-continuity-settings.json'))
  assert.equal(scene.completed, true); assert.equal(scene.settingsOnly, true); assert.equal(scene.surface.exact, true)
  assert.ok(scene.cli.length > 5)
  assert.ok(receipt.native.frames.length > 1)
  for (const frame of receipt.native.frames) assert.equal(hash(await readFile(path.join(nativeDirectory, frame.file))), frame.sha256)
  return { task: 'T004-settings', receipt: file, sha256: hash(bytes), sourceInputs, baselineCases: 12,
    loadedCounterexamples: receipt.runs.length - 1, nativeSourceIdentity: native.sourceIdentity, frames: receipt.native.frames }
}

/** Receipt paths are locators only. Every task still verifies its original producer and raw evidence. */
export async function readSessionSupervisionEvidence(root, files) {
  assert.deepEqual(Object.keys(files).sort(), ['T001', 'T002', 'T003', 'T004', 'T006', 'T007'],
    'Every required original supervision task must provide a receipt locator')
  assert.deepEqual(Object.keys(files.T004).sort(), ['consumer', 'settings', 'wire'])
  const results = []
  for (const task of ['T001', 'T002', 'T003', 'T006', 'T007']) results.push(await readSupervisionCoreOwner(root, task, files[task]))
  results.push(await readSupervisionSettingsOwner(root, files.T004.settings))
  for (const kind of ['wire', 'consumer']) results.push(await readSupervisionConsumerOwner(root, kind, files.T004[kind]))
  return results
}

/** Qualify the actual existing runner result, never a newly authored success manifest. */
export function verifySupervisionProduct(receipt) {
  assert.equal(receipt.schema, 'agentmux.continuity-supervision-product.v1'); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.phases.map(one => one.phase), ['seed', 'restore', 'reconnect'])
  assert.equal(new Set(receipt.phases.map(one => one.native.pid)).size, 3)
  for (const phase of receipt.phases) {
    assert.equal(phase.exit.originalPid, phase.native.pid, 'The original process receipt must identify the actual App generation')
    assert.equal(phase.exit.exitConfirmed, true); assert.equal(phase.exit.exitCode, 0); assert.equal(phase.exit.timedOut, false)
    assert.deepEqual(phase.exit.cleanupErrors, [])
  }
  const [seed, restore, reconnect] = receipt.phases.map(one => one.native)
  const original = seed.supervision, firstRoot = original.final.workingRoot, cancelledRun = original.cancelled.run
  assert.equal(firstRoot.supervision.attemptCount, 1); assert.equal(firstRoot.supervision.attemptLimit, 2)
  assert.equal(firstRoot.supervision.phase, 'retry-wait'); assert.equal(firstRoot.policy.retryMaxAttempts, 0)
  assert.ok(original.scheduled.nextAttemptAt > original.scheduled.observedAt)
  assert.equal(firstRoot.supervision.nextAttemptAt, original.scheduled.nextAttemptAt)
  assert.equal(original.controls.length, 2); assert.equal(original.authoredControls.length, 2)
  for (const authored of original.authoredControls) {
    assert.equal(authored.persistedBeforeDispatch, true)
    assert.ok(original.controls.some(one => JSON.stringify(one.request) === JSON.stringify(authored.request)))
  }
  assert.deepEqual(original.controls.map(one => one.outcome).sort(), ['cancelled', 'continued'])
  for (const [index, native] of [seed, restore, reconnect].entries()) {
    const value = native.supervision
    assert.equal(native.passed, true); assert.equal(value.kind, 'durability')
    assert.ok(Number.isSafeInteger(native.pid) && native.pid > 0); assert.equal(value.schedulerOwnerPid, native.pid)
    assert.deepEqual(value.healthy, original.healthy)
    assert.equal(value.rawInput.length, 1)
    assert.equal(value.rawInput[0].runId, original.healthy.runId); assert.equal(value.rawInput[0].pid, original.healthy.pid)
    assert.equal(value.rawInput[0].consumedOnce, true); assert.ok(value.rawInput[0].body)
    assert.deepEqual(value.controls, original.controls)
    assert.equal(value.cancelled.root.supervision.phase, 'cancelled'); assert.equal(value.cancelled.root.supervision.attemptCount, 1)
    assert.deepEqual(value.cancelled.run, cancelledRun); assert.equal(value.cancelled.noNewAttempt, true); assert.equal(value.cancelled.noInputReplay, true)
    assert.equal(value.publicCli.passed, true); assert.equal(value.publicCli.zeroLifecycleOrInput, true)
    assert.equal(value.publicCli.checks.length, 2); assert.ok(value.publicCli.nativeBefore.length >= 3)
    assert.deepEqual(value.publicCli.nativeAfter, value.publicCli.nativeBefore)
    for (const control of value.publicCli.checks) assert.ok(original.controls.some(one => JSON.stringify(one) === JSON.stringify(control.reply.result.receipt)))
    assert.equal(Object.keys(value.final.view.tabs).length, 2)
    assert.ok(Object.values(value.final.view.drafts).length >= 3 && Object.values(value.final.view.drafts).every(one => typeof one === 'string' && one))
    assert.ok(value.final.spatial?.graph && Object.keys(value.final.spatial.graph).length > 0)
    if (index > 0) {
      const previous = index === 1 ? seed : restore
      assert.deepEqual(native.spatialBefore, previous.supervision.final.spatial)
      assert.deepEqual(native.initial.tabs, previous.supervision.final.view.tabs)
      assert.deepEqual(native.initial.focus, previous.supervision.final.view.focus)
      assert.deepEqual(native.initial.drafts, previous.supervision.final.view.drafts)
      assert.deepEqual(value.recovered.root.launchInput, firstRoot.launchInput)
      assert.deepEqual(value.recovered.root.policy, firstRoot.policy)
      assert.equal(value.recovered.root.supervision.attemptCount, 2); assert.equal(value.recovered.root.supervision.attemptLimit, 2)
      assert.equal(value.recovered.processRunning, true); assert.equal(value.recovered.providerContextConfirmed, false)
      assert.equal(value.recovered.oldTaskContinuationConfirmed, false); assert.equal(value.recovered.oldInputReplayCount, 0)
      assert.deepEqual(value.recovered.child.recoveryInputs, { reminder: '', continuation: '' }); assert.equal(value.recovered.child.launchInput, undefined)
    }
  }
  assert.ok(restore.supervision.preDue.observedAt < restore.supervision.preDue.root.supervision.nextAttemptAt)
  assert.equal(restore.supervision.preDue.root.supervision.nextAttemptAt, firstRoot.supervision.nextAttemptAt)
  assert.deepEqual(reconnect.supervision.recovered.run, restore.supervision.recovered.run)
  assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
}
