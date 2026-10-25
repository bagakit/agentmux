import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mutations, productFiles, componentFiles, parseArgs, sha, validateRetained, validateTests, validateVisual } from '../scripts/verify-remote-execution-settings.mjs'

test('illustration and CSS bind visual approval without pretending to be consumed component source', () => {
  assert(productFiles.includes('apps/desktop/src/renderer/src/assets/settings/remote-execution.png'))
  assert(productFiles.includes('apps/desktop/src/renderer/src/styles/remote-execution-settings.css'))
  assert(componentFiles.length > 0 && componentFiles.every(path => /\.tsx?$/u.test(path)))
  assert.equal(componentFiles.length, productFiles.length - 2)
})

test('full gate consumes canonical independent visual approval; a checks-only run remains distinct', () => {
  assert.match(parseArgs([]).visualReview, /remote-execution-settings\/visual-review\.json$/u)
  assert.equal(parseArgs(['--checks-only']).checksOnly, true)
  assert.throws(() => parseArgs(['--checks-only', '--visual-review', 'review.json']))
  assert.throws(() => parseArgs(['--output', 'a', '--output', 'b']))
  assert.throws(() => parseArgs(['--unknown']))
})
test('empty test runs, infrastructure failure and timeout never qualify a baseline or mutant', () => {
  assert.throws(() => validateTests({ success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [] }))
  const report = { success: false, numTotalTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [{ status: 'failed', failureMessages: ['Error: Test timed out'] }] }] }
  assert.throws(() => validateTests(report, true), /Infrastructure/)
  report.testResults[0].assertionResults[0].failureMessages = ['AssertionError: exact original binding differs']
  validateTests(report, true)
  assert.throws(() => validateTests(report), /baseline/)
})
test('visual approval binds exact current source and actual reviewed image bytes, never capture alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-review-'))
  try {
    const path = join(directory, 'reviewed.png'), bytes = Buffer.from('test image identity')
    await writeFile(path, bytes)
    const expected = { 'product.tsx': sha('current product') }
    const review = { schema: 'agentmux.remote-execution-settings.visual.v1', status: 'approved', reviewer: 'independent-reviewer',
      sourceHashes: expected, frames: [{ path, sha256: sha(bytes) }] }
    await validateVisual(review, expected)
    await assert.rejects(validateVisual({ ...review, status: 'captured' }, expected))
    await assert.rejects(validateVisual({ ...review, reviewer: '' }, expected))
    await assert.rejects(validateVisual({ ...review, sourceHashes: {} }, expected), /Visual source differs/)
    await assert.rejects(validateVisual({ ...review, frames: [] }, expected))
    await writeFile(path, 'changed image')
    await assert.rejects(validateVisual(review, expected), /Reviewed frame changed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('retaining checks requires all original process, assertion and exact source mutation evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-retained-'))
  const ref = async (name, value) => { const path = join(directory, name), bytes = typeof value === 'string' ? value : JSON.stringify(value); await writeFile(path, bytes); return { path, sha256: sha(bytes) } }
  try {
    const inputs = Object.fromEntries(componentFiles.map(path => [path, sha(path)]))
    const checks = []
    for (const id of ['baseline', ...mutations]) {
      const mutant = id !== 'baseline'
      checks.push({ id, execution: await ref(id + '-exit.json', { code: mutant ? 1 : 0, signal: null }),
        report: await ref(id + '-tests.json', { success: !mutant, numTotalTests: 1, numPassedTests: mutant ? 0 : 1, numFailedTests: mutant ? 1 : 0,
          testResults: [{ assertionResults: [{ status: mutant ? 'failed' : 'passed', failureMessages: mutant ? ['AssertionError: wrong original target'] : [] }] }] }),
        ...(mutant ? { mutation: await ref(id + '-mutation.jsonl', JSON.stringify({ mutant: id, path: productFiles[0], original: inputs[productFiles[0]], consumed: sha('mutated') })) } : {}) })
    }
    const prior = { schema: 'agentmux.remote-execution-settings.gate.v1', componentChecksPassed: true, inputs, checks,
      consumption: await ref('consumed.jsonl', componentFiles.map(path => JSON.stringify({ path, sha256: inputs[path] })).join('\n')) }
    await validateRetained(prior, inputs)
    await assert.rejects(validateRetained({ ...prior, checks: checks.slice(0, -1) }, inputs), /All original checks/)
    await assert.rejects(validateRetained(prior, { ...inputs, [productFiles[0]]: sha('changed') }), /exact current source/)
    await writeFile(checks[0].execution.path, JSON.stringify({ code: 1, signal: null }))
    await assert.rejects(validateRetained(prior, inputs), /Original evidence changed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
