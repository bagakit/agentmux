import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// Consume this bounded original-owner proof. This entry never creates an Agent,
// copies credentials, sends model input or replaces the independent model gate.
const repository = path.resolve(import.meta.dirname, '../../..')
const hash = value => createHash('sha256').update(value).digest('hex')
async function artifact(locator) {
  assert.ok(locator?.path && /^[a-f0-9]{64}$/.test(locator.sha256 ?? ''))
  const bytes = await fs.readFile(path.resolve(repository, locator.path))
  assert.equal(hash(bytes), locator.sha256, 'Evidence changed: ' + locator.path)
  return JSON.parse(bytes)
}
const locator = JSON.parse(await fs.readFile(path.resolve(repository,
  process.env.AGENTMUX_MOTE_FINITE_GOAL_QUALIFICATION ?? '.tmp/mote-finite-goal/approved.json'), 'utf8'))
const raw = await artifact(locator.raw), review = await artifact(locator.review)
assert.equal(raw.schema, 'agentmux.finite-goal.qualification.v1')
assert.equal(raw.passed, true)
assert.equal(raw.taskId, 'T-010')
assert.equal(raw.modelInputs, 0)
assert.equal(raw.nativeRuns, 0)
assert.equal(raw.authRead, false)
assert.equal(review.approved, true)
assert.ok(review.taskIds.includes('T-010'))
assert.equal(review.sourceGate.sha256, locator.raw.sha256)
const source = await artifact(raw.sourceCheck), types = await artifact(raw.types)
assert.equal(source.passed, true)
assert.equal(source.mutants.length, 3)
for (const mutant of source.mutants) {
  assert.notEqual(mutant.exitCode, 0)
  assert.equal(mutant.signal, null)
  assert.equal(mutant.assertionRed, true)
  assert.equal(mutant.rows.length, 1)
  assert.equal(mutant.rows[0].beforeSha256, source.sourceStoreSha256)
  assert.notEqual(mutant.rows[0].beforeSha256, mutant.rows[0].afterSha256)
  for (const ref of [mutant.log, mutant.loaded]) {
    assert.equal(hash(await fs.readFile(path.resolve(repository, ref.path))), ref.sha256)
  }
}
assert.equal(source.restored.exitCode, 0)
assert.equal(source.restored.signal, null)
assert.ok(source.restored.testsPassed >= 16)
assert.equal(hash(await fs.readFile(source.restored.log.path)), source.restored.log.sha256)
const proofBytes = await fs.readFile(source.restored.loaded.path)
assert.equal(hash(proofBytes), source.restored.loaded.sha256)
const rows = proofBytes.toString().trim().split('\n').map(line => JSON.parse(line))
assert.ok(rows.some(row => row.consumer === 'actual-source-cli'))
assert.ok(rows.some(row => row.consumer === 'actual-vite-module' && row.file === 'apps/desktop/src/renderer/src/store.ts'))
assert.equal(types.passed, true)
assert.equal(types.strict, true)
assert.deepEqual(types.newDiagnostics, [])
assert.ok(!types.candidateDiagnostics.some(row => raw.productPaths.includes(row.file)))
assert.ok(raw.callers.length > 0)
for (const caller of raw.callers) {
  assert.notEqual(caller.definition, caller.file)
  assert.ok(caller.anchor)
  const bytes = execFileSync('git', ['show', raw.candidate + ':' + caller.file], { cwd: repository, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(hash(bytes), raw.source[caller.file])
  assert.ok(bytes.toString().includes(caller.anchor))
}
assert.ok(Object.keys(raw.source).length > 0)
for (const [file, sha256] of Object.entries(raw.source)) {
  const bytes = execFileSync('git', ['show', raw.candidate + ':' + file], { cwd: repository, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(hash(bytes), sha256, 'Qualified original Source changed: ' + file)
}
assert.equal(raw.source['apps/desktop/src/renderer/src/store.ts'], source.sourceStoreSha256)
for (const row of rows.filter(row => row.sha256)) assert.equal(raw.source[row.file], row.sha256)
for (const [file, sha256] of Object.entries(types.source)) assert.equal(raw.source[file], sha256)
console.log(JSON.stringify({ passed: true, taskId: 'T-010', tests: source.restored.testsPassed,
  mutants: source.mutants.length, affectedTypeErrors: 0, baselineTypeErrors: types.baselineDiagnostics.length,
  modelInputs: 0, raw: locator.raw, review: locator.review }))
