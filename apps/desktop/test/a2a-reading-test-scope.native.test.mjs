import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'

// Exercise the original verifier function with controlled fact files; omit only its CLI entrypoint.
// These are unit inputs, never recorded product/test execution receipts.
const target = new URL('../scripts/verify-a2a-reference-reading.mjs', import.meta.url).href
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  if (url !== target) return loaded
  const original = String(loaded.source), entrypoint = 'const args = process.argv.slice(2)'
  assert.equal(original.split(entrypoint).length, 2)
  return { ...loaded, source: original.slice(0, original.indexOf(entrypoint)) + '\nexport {testFacts,mergeSources,assertTestPair}\n' }
} })
let testFacts, mergeSources, assertTestPair
try { ({ testFacts, mergeSources, assertTestPair } = await import(target)) } finally { hook.deregister() }
const root = resolve(import.meta.dirname, '../../..'), sha = value => createHash('sha256').update(value).digest('hex')
const owner = 'packages/core/src/agent-message-render.ts', dependency = 'apps/desktop/src/shared/config-edit.ts'
const harness = 'apps/desktop/test/helpers/composer-dom-fixture.tsx'
async function facts(overrides, run) {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const directory = await mkdtemp(join(root, '.tmp/a2a-scope-test-'))
  try {
    const ownerBytes = await readFile(join(root, owner))
    const rows = [{ path: owner, sourceSHA256: sha(ownerBytes), compilerInputSHA256: sha(ownerBytes), bytes: ownerBytes.length },
      { path: dependency, sourceSHA256: '1'.repeat(64), compilerInputSHA256: '1'.repeat(64), bytes: 1 }]
    overrides(rows)
    const report = join(directory, 'report.json'), loaded = join(directory, 'loaded.jsonl')
    await writeFile(report, JSON.stringify({ numTotalTests: 1, numPendingTests: 0, numTodoTests: 0, numFailedTests: 0,
      numPassedTests: 1, success: true, testResults: [{ assertionResults: [{ fullName: 'controlled original assertion', status: 'passed' }] }] }))
    await writeFile(loaded, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    await run({ exitCode: 0, report: relative(root, report), loaded: relative(root, loaded),
      argv: ['apps/desktop/scripts/fixtures/a2a-reference-reading/vitest.owning.config.mts'] })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('unrelated production dependencies retain recorded conditions without claiming the current checkout', async () => {
  await facts(() => {}, async run => {
    const result = await testFacts(run)
    assert.equal(result.cases.length, 1); assert.equal(result.inputs[1].sourceSHA256, '1'.repeat(64))
  })
})

test('a changed owning source remains a refusal to reuse its original result', async () => {
  await facts(rows => { rows[0].sourceSHA256 = '2'.repeat(64); rows[0].compilerInputSHA256 = '2'.repeat(64) }, run => assert.rejects(testFacts(run), { name: 'AssertionError', message: /Actual test consumer source/u }))
})

test('test and harness inputs stay current even outside the declared production owner list', async () => {
  await facts(rows => { rows[1].path = harness }, run => assert.rejects(testFacts(run), { name: 'AssertionError', message: /Actual test consumer source/u }))
})

test('an undeclared dependency mutation cannot masquerade as an original test condition', async () => {
  await facts(rows => { rows[1].compilerInputSHA256 = '3'.repeat(64) }, run => assert.rejects(testFacts(run), { name: 'AssertionError', message: /Unmodified recorded dependency/u }))
})


test('only current owners and harness facts enter the current-source map', () => {
  const current = {}
  mergeSources(current, { [owner]: '1'.repeat(64), [dependency]: '2'.repeat(64), [harness]: '3'.repeat(64) })
  assert.deepEqual(current, { [owner]: '1'.repeat(64), [harness]: '3'.repeat(64) })
})


const paired = () => ({ cases: ['same original assertion'], inputs: [
  { path: owner, sourceSHA256: '1'.repeat(64), compilerInputSHA256: '2'.repeat(64), bytes: 2 },
  { path: dependency, sourceSHA256: '3'.repeat(64), compilerInputSHA256: '3'.repeat(64), bytes: 3 }
] })
test('a valid RED/restore pair differs only in the original target compiler input', () => {
  const red = paired(), green = paired(); green.inputs[0].compilerInputSHA256 = green.inputs[0].sourceSHA256; green.inputs[0].bytes = 1
  assertTestPair(red, green, { path: owner, label: 'original target' })
})

test('individually valid historical dependencies cannot hide a changed RED/restore condition', () => {
  const red = paired(), green = paired(); green.inputs[1].sourceSHA256 = green.inputs[1].compilerInputSHA256 = '4'.repeat(64)
  assert.throws(() => assertTestPair(red, green, { path: owner, label: 'original target' }), { name: 'AssertionError', message: /loading conditions differ/u })
  green.inputs.pop()
  assert.throws(() => assertTestPair(red, green, { path: owner, label: 'original target' }), { name: 'AssertionError', message: /loading conditions differ/u })
})

test('mixed module versions within a run remain unqualified even when the pair has the same set', () => {
  const red = paired(); red.inputs.push({ ...red.inputs[1], sourceSHA256: '4'.repeat(64), compilerInputSHA256: '4'.repeat(64) })
  assert.throws(() => assertTestPair(red, structuredClone(red), { path: owner, label: 'original target' }), { name: 'AssertionError', message: /within one test run/u })
})
