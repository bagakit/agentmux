import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => /^[a-f0-9]{64}$/u.test(value ?? '')

/** A pointer transports the exact old receipt; it cannot replace it with a summary. */
export async function readOriginalEvidence(file, schema, repository) {
  const pointerBytes = await readFile(file), pointer = JSON.parse(pointerBytes)
  if (pointer.schema !== schema) assert.ok(typeof pointer.path === 'string' && pointer.path.length > 0,
    'An evidence pointer requires the original receipt path.')
  const originalPath = pointer.schema === schema ? file : resolve(repository, pointer.path)
  const bytes = originalPath === file ? pointerBytes : await readFile(originalPath)
  if (originalPath !== file) {
    assert.ok(digest(pointer.sha256), 'An evidence pointer requires the exact original receipt SHA.')
    assert.equal(hash(bytes), pointer.sha256, 'The original evidence changed after the pointer was saved.')
  }
  const receipt = JSON.parse(bytes)
  assert.equal(receipt.schema, schema)
  assert.equal(receipt.passed, true, 'The original evidence did not pass: ' + originalPath)
  return { receipt, reference: { path: originalPath, sha256: hash(bytes), schema,
    ...(originalPath === file ? {} : { pointerPath: file, pointerSha256: hash(pointerBytes) }) } }
}

export async function qualifyNativeEvidence(file, kind, repository, currentHash) {
  const schema = kind === 'responsibility' ? 'agentmux.goal-responsibility-native.v1' : 'agentmux.typed-native-restart.v1'
  const { receipt, reference } = await readOriginalEvidence(file, schema, repository)
  const artifactHashes = { [reference.path]: reference.sha256,
    ...(reference.pointerPath ? { [reference.pointerPath]: reference.pointerSha256 } : {}) }
  const inputs = receipt.inputs
  assert.ok(inputs && Object.keys(inputs).length > 0, 'Native input/source/build identity must be nonempty.')
  assert.deepEqual(receipt.inputsAfter, inputs, 'The original Native proof changed source or build during execution.')
  for (const [source, expected] of Object.entries(inputs)) {
    assert.ok(digest(expected), 'A Native input SHA is invalid: ' + source)
    assert.equal(await currentHash(resolve(repository, source)), expected, 'Native evidence is stale for this source/build: ' + source)
  }
  // This is the actual Vite output recorded by the owner, separate from its Core dist inputs.
  assert.ok(receipt.compiled && Object.keys(receipt.compiled).length > 0,
    'Native evidence must identify the actual private compiled artifacts.')
  const manifestPath = resolve(dirname(reference.path), 'compiled.json'), manifestBytes = await readFile(manifestPath)
  artifactHashes[manifestPath] = hash(manifestBytes)
  assert.deepEqual(JSON.parse(manifestBytes), receipt.compiled, 'The original compiled manifest and receipt disagree.')
  for (const [compiled, value] of Object.entries(receipt.compiled)) {
    assert.ok(compiled.length > 0 && digest(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0,
      'Native compiled artifacts must have nonempty bytes and exact hashes.')
    const compiledPath = resolve(dirname(reference.path), kind === 'responsibility' ? 'compiled-main' : 'compiled', compiled)
    const bytes = await readFile(compiledPath)
    assert.equal(bytes.length, value.bytes)
    assert.equal(hash(bytes), value.sha256, 'The actual retained Native compiled artifact changed: ' + compiled)
    artifactHashes[compiledPath] = hash(bytes)
  }
  assert.deepEqual(receipt.phases.map(phase => phase.phase), ['seed', 'restore'])
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 2, 'Native restart requires two distinct actual owner processes.')
  const phases = []
  for (const phase of receipt.phases) {
    assert.ok(Number.isSafeInteger(phase.native.pid) && phase.native.pid > 0)
    assert.equal(phase.exit.exitConfirmed, true)
    assert.equal(phase.exit.exitCode, 0)
    assert.equal(phase.exit.timedOut, false)
    assert.equal(phase.native.passed, true)
    assert.equal(phase.native.phase, phase.phase)
    const phasePath = resolve(dirname(reference.path), phase.receipt ?? phase.phase + '.json')
    const bytes = await readFile(phasePath)
    artifactHashes[phasePath] = hash(bytes)
    if (phase.receiptSha256 !== undefined) assert.equal(hash(bytes), phase.receiptSha256)
    assert.deepEqual(JSON.parse(bytes), phase.native, 'The actual phase file and original owner receipt disagree.')
    phases.push({ phase: phase.phase, pid: phase.native.pid, path: phasePath, sha256: hash(bytes) })
  }
  const [seed, restored] = receipt.phases.map(phase => phase.native)
  if (kind === 'responsibility') {
    assert.deepEqual(seed.ids, restored.ids, 'Original Goal execution identities changed on Native restart.')
    assert.ok(Object.keys(seed.ids).length >= 3 && seed.lostReceipt?.ack, 'A real original manager/finite/delegated Run and accepted lost ACK are required.')
    assert.ok(Array.isArray(seed.cli) && seed.cli.length > 0 && Array.isArray(restored.cli) && restored.cli.length > 0)
    assert.equal(seed.after.patrols.length, 1)
    assert.equal(seed.after.patrols[0].attempts.length, 1)
    assert.ok(seed.after.patrols[0].attempts[0].attemptedAt && !seed.after.patrols[0].report)
    assert.equal(seed.after.patrols[0].operationId, restored.after.patrols[0].operationId)
    assert.ok(seed.after.responsibility.executions.length >= 2 && seed.after.responsibility.executions.every(row => row.alert !== null))
    assert.deepEqual(restored.beforeRuns, restored.afterRuns, 'An original attempted input was replayed on restart.')
    assert.ok(restored.beforeRuns.length >= 3)
    assert.ok(restored.after.patrols[0].report?.applied && restored.after.responsibility.executions.length >= 2)
    assert.ok(restored.after.responsibility.executions.every(row => row.alert === null && row.nextOwner.kind === 'human'))
    assert.equal(restored.after.goalState.status, 'in_review')
  } else {
    assert.ok(Array.isArray(receipt.originalRuns) && receipt.originalRuns.length > 0)
    assert.deepEqual(receipt.originalRuns, receipt.survivingRuns, 'The original healthy Run/PID was replaced on workface restart.')
    for (const run of receipt.originalRuns) assert.ok(typeof run.runId === 'string' && Number.isSafeInteger(run.pid) && run.pid > 0)
    assert.deepEqual(seed.persisted.pendingInteraction, restored.persisted.pendingInteraction)
    assert.equal(restored.persisted.pendingInteraction.nativeInput.delivery, 'unknown')
    for (const field of ['tabs', 'layouts', 'drafts', 'focus', 'activeWorkspaceId'])
      assert.deepEqual(seed.saved[field], restored.initial[field], 'Original workface changed on restart: ' + field)
    assert.ok(Object.keys(seed.saved.tabs).length > 0 && Object.keys(seed.saved.layouts).length > 0 && Object.keys(seed.saved.drafts).length > 0)
    for (const phase of [seed, restored]) {
      assert.equal(phase.beforeTyped, phase.afterTyped, 'An ineligible old typed grant wrote input bytes.')
      assert.ok(phase.freshNativeInput.afterNative > phase.freshNativeInput.beforeNative, 'The original terminal could not accept fresh input.')
      assert.equal(phase.saved.session.processState, 'running')
    }
  }
  assert.deepEqual(receipt.cleanup.errors, [])
  assert.deepEqual(receipt.cleanup.remaining, [])
  assert.equal(receipt.cleanup.temporaryRootRemoved, true)
  return { ...reference, kind, phases, inputs, compiled: receipt.compiled, artifactHashes,
    compiledManifest: { path: manifestPath, sha256: hash(manifestBytes) },
    boundary: receipt.proofBoundary ?? receipt.limitations }
}

export async function qualifyCostEvidence(file, repository, currentHash) {
  const { receipt, reference } = await readOriginalEvidence(file, 'agentmux.goal-cost-mutations.v1', repository)
  const artifactHashes = { [reference.path]: reference.sha256,
    ...(reference.pointerPath ? { [reference.pointerPath]: reference.pointerSha256 } : {}) }
  assert.equal(receipt.slice, 'cost')
  assert.ok(Array.isArray(receipt.candidate) && receipt.candidate.length > 0)
  for (const source of receipt.candidate) {
    assert.ok(typeof source.file === 'string' && digest(source.sha256))
    assert.equal(await currentHash(resolve(repository, source.file)), source.sha256, 'Original cost source/oracle changed: ' + source.file)
  }
  const baselinePath = resolve(repository, receipt.baseline.json), baselineBytes = await readFile(baselinePath)
  assert.equal(hash(baselineBytes), receipt.baseline.jsonSha256)
  assert.equal(receipt.baseline.code, 0)
  artifactHashes[baselinePath] = hash(baselineBytes)
  const baseline = JSON.parse(baselineBytes)
  assert.ok(baseline.numPassedTests > 0 && baseline.numFailedTests === 0 && baseline.numTotalTests === baseline.numPassedTests,
    'Cost baseline requires a nonempty actual GREEN oracle set.')
  const artifact = receipt.baseline.costArtifact, costPath = resolve(repository, artifact.path), costBytes = await readFile(costPath)
  assert.equal(hash(costBytes), artifact.sha256)
  artifactHashes[costPath] = hash(costBytes)
  const costs = JSON.parse(costBytes)
  assert.deepEqual(costs.map(cost => cost.goals), [1, 1000])
  for (const cost of costs) assert.deepEqual(cost, { goals: cost.goals, fileReads: 0, versionReads: 1, snapshotParses: 0, individualGoalClones: 1 })
  assert.equal(receipt.cases.length, 2)
  assert.equal(receipt.restoration.exactOriginalSource, true)
  assert.equal(receipt.restoration.allPlannedCases, 2)
  // Reuse the owning runner's exact current production mutations and named semantic
  // oracles. --check-qualified only reads original evidence; it cannot run a mutant.
  const qualificationPointer = resolve(dirname(reference.path), '../qualified-receipt.json')
  artifactHashes[qualificationPointer] = hash(await readFile(qualificationPointer))
  const runner = resolve(repository, 'apps/desktop/scripts/verify-goal-responsibility-mutations.mjs')
  const { stdout } = await promisify(execFile)(process.execPath,
    [runner, '--slice', 'cost', '--check-qualified', qualificationPointer], { cwd: repository, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const qualified = JSON.parse(stdout.trim())
  assert.equal(qualified.passed, true)
  assert.equal(qualified.sourceShaVerified, true)
  assert.equal(qualified.verifiedCases, 2)
  assert.equal(resolve(qualified.receipt), reference.path)
  assert.equal(qualified.receiptSha256, reference.sha256)
  const proofFiles = []
  for (const mutant of receipt.cases) for (const kind of ['red', 'restored']) {
    const proof = mutant[kind], proofPath = resolve(repository, proof.json), bytes = await readFile(proofPath)
    assert.equal(hash(bytes), proof.jsonSha256)
    const raw = JSON.parse(bytes), actual = raw.testResults.flatMap(suite => suite.assertionResults)
      .filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
    assert.equal(actual.length, 1)
    assert.equal(actual[0].status, kind === 'red' ? 'failed' : 'passed')
    artifactHashes[proofPath] = hash(bytes)
    proofFiles.push({ name: mutant.name, kind, path: proofPath, sha256: hash(bytes), oracle: actual[0].fullName })
  }
  return { ...reference, candidate: receipt.candidate, baselineTests: baseline.numPassedTests, artifactHashes,
    costs: { path: costPath, sha256: hash(costBytes), values: costs }, oracles: proofFiles,
    qualifiedCheck: { pointer: qualificationPointer, stdoutSha256: hash(stdout), result: qualified }, boundary: receipt.proofBoundary }
}
