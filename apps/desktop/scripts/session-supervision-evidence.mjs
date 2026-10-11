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
  T003: { name: 'resume-context-observation', schema: 'agentmux.resume-context-observation-proof.v1', minimum: 33, mutants: 18 }
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

export async function readSupervisionCoreEvidence(root) {
  const results = []
  for (const [task, definition] of Object.entries(definitions)) {
    const pointer = await parse(path.join(root, 'packages/core/.tmp', definition.name, 'latest.json'))
    results.push(await readSupervisionCoreOwner(root, task, pointer.receipt))
  }
  return results
}
