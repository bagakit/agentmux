import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { mutations, productFiles, componentFiles, parseArgs, sha, sourceObservation, dependencyManifest, dependencyChanges, reusableChecks, validateRetained, validateTests, validateVisual } from '../scripts/verify-remote-execution-settings.mjs'

test('records both exact hashes for Vite source-map blanking without accepting other source drift', () => {
  const source = "export * from './types.js';\n//# sourceMappingURL=index.js.map", loaded = source.replace('//# sourceMappingURL=index.js.map', ' '.repeat(33))
  const record = sourceObservation('packages/example/dist/index.js', source, loaded)
  assert.equal(record.sha256, sha(source)); assert.equal(record.loadedSHA256, sha(loaded)); assert.equal(record.normalization, 'source-map-comment-blanking')
  assert.equal(sourceObservation('source.ts', 'export const value=1', 'export const value=1').normalization, 'none')
  assert.throws(() => sourceObservation('source.ts', source, loaded.replace('types', 'wrong')), /Unaccounted loaded source/)
})

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
const extraDependencies = ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'apps/desktop/src/renderer/src/lib/launcher-submit.ts', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs']
async function retainedFixture(directory) {
  const ref = async (name, value) => { const path = join(directory, 'evidence', name), bytes = typeof value === 'string' ? value : JSON.stringify(value); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); return { path, sha256: sha(bytes) } }
  const verificationFiles = ['apps/desktop/test/vitest.remote-execution-settings.config.mts', 'apps/desktop/scripts/verify-remote-execution-settings.mjs']
  const files = [...componentFiles, ...extraDependencies, ...verificationFiles]
  for (const path of files) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), path) }
  const verificationHashes = Object.fromEntries(verificationFiles.map(path => [path, sha(path)])), checks = []
  for (const id of ['baseline', ...mutations]) {
    const mutant = id !== 'baseline'
    // A dependency only consumed by the baseline cannot invalidate unrelated mutant evidence.
    const consumed = [...componentFiles, ...(mutant ? [] : extraDependencies)].map(path => ({ path, sha256: sha(path) }))
    const dependencies = dependencyManifest(consumed, verificationHashes)
    checks.push({ id, dependencies, verificationHashes, consumption: await ref(id + '-consumed.jsonl', consumed.map(item => JSON.stringify(item)).join('\n')),
      execution: await ref(id + '-exit.json', { code: mutant ? 1 : 0, signal: null }),
      report: await ref(id + '-tests.json', { success: !mutant, numTotalTests: 1, numPassedTests: mutant ? 0 : 1, numFailedTests: mutant ? 1 : 0,
        testResults: [{ assertionResults: [{ status: mutant ? 'failed' : 'passed', failureMessages: mutant ? ['AssertionError: wrong original target'] : [] }] }] }),
      ...(mutant ? { mutation: await ref(id + '-mutation.jsonl', JSON.stringify({ mutant: id, path: productFiles[0], original: dependencies[productFiles[0]], consumed: sha('mutated') })) } : {}) })
  }
  const inputs = dependencyManifest(checks.flatMap(check => Object.entries(check.dependencies).map(([path, sha256]) => ({ path, sha256 }))), {})
  return { schema: 'agentmux.remote-execution-settings.gate.v1', componentChecksPassed: true, inputs, checks, consumption: checks[0].consumption }
}
test('retaining checks requires all original process, assertion and exact source mutation evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-retained-'))
  try {
    const prior = await retainedFixture(directory)
    await validateRetained(prior, prior.inputs, directory)
    await assert.rejects(validateRetained({ ...prior, checks: prior.checks.slice(0, -1) }, prior.inputs, directory), /All original checks/)
    await assert.rejects(validateRetained(prior, { ...prior.inputs, [productFiles[0]]: sha('changed') }, directory), /exact current source/)
    await writeFile(prior.checks[0].execution.path, JSON.stringify({ code: 1, signal: null }))
    await assert.rejects(validateRetained(prior, prior.inputs, directory), /Original evidence changed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('consumed Launcher, workbench and fixture/config dependency changes reject old green and retain unchanged checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-dependency-'))
  try {
    const prior = await retainedFixture(directory)
    for (const path of extraDependencies) {
      await writeFile(join(directory, path), 'changed actual dependency')
      await assert.rejects(validateRetained(prior, prior.inputs, directory), /Consumed dependencies changed for baseline/)
      const decisions = await reusableChecks(prior, directory)
      assert.deepEqual(decisions[0].changed, [path]); assert.equal(decisions[0].reusable, false)
      assert(decisions.slice(1).every(item => item.reusable))
      assert.equal(decisions[1].check, prior.checks[1], 'Unchanged checks retain the original reports, exits and mutation identities')
      await writeFile(join(directory, path), path)
    }
    await rm(join(directory, extraDependencies[0]))
    assert.deepEqual(await dependencyChanges(prior.inputs, directory), [extraDependencies[0]])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('unconsumed source and presentation-only changes do not invalidate component evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-unrelated-'))
  try {
    const prior = await retainedFixture(directory)
    for (const path of ['packages/unrelated/src/unused.ts', ...productFiles.filter(path => !componentFiles.includes(path))]) {
      await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), 'changed')
    }
    await validateRetained(prior, prior.inputs, directory)
    assert((await reusableChecks(prior, directory)).every(item => item.reusable))
    assert.deepEqual(dependencyManifest([{ path: 'visual.css', sha256: sha('css') }, { path: 'image.png', sha256: sha('png') }], { 'loader.mjs': sha('loader') }), { 'loader.mjs': sha('loader') })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('a consumed source changing during a check or a manifest omitting it cannot qualify', async () => {
  assert.throws(() => dependencyManifest([{ path: 'same.ts', sha256: sha('before') }, { path: 'same.ts', sha256: sha('after') }], {}), /changed while consumed/)
  const directory = await mkdtemp(join(tmpdir(), 'amx-settings-omission-'))
  try {
    const prior = await retainedFixture(directory)
    delete prior.checks[0].dependencies[extraDependencies[0]]
    await assert.rejects(reusableChecks(prior, directory), /exactly reflect the original consumption/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
