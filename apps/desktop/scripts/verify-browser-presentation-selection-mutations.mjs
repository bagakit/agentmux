import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mutations, owners } from './fixtures/browser-presentation-selection/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(resolve(root, 'package.json'))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const evidence = resolve(root, '.tmp/browser-presentation-selection-mutations', 'attempt-' + globalThis.crypto.randomUUID())
mkdirSync(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries([...Object.values(owners), 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/test/browser-presentation-selection.test.tsx', 'apps/desktop/test/browser-presentation-selection-caller.test.tsx',
  'apps/desktop/test/browser-presentation-registration-recovery.test.tsx',
  'apps/desktop/scripts/fixtures/browser-presentation-selection/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/browser-presentation-selection/mutations.mjs',
  'apps/desktop/scripts/fixtures/browser-presentation-selection/verify-production-callers.mjs',
  'apps/desktop/scripts/verify-browser-presentation-selection-mutations.mjs'].map(path => [path, hash(readFileSync(resolve(root, path)))]))
const run = variant => {
  const name = variant ?? 'restored-green', report = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '.loaded.jsonl')
  const env = { ...process.env, AGENTMUX_PRESENTATION_SELECTION_LOADED: loaded }
  delete env.AGENTMUX_PRESENTATION_SELECTION_BASELINE
  if (variant) env.AGENTMUX_PRESENTATION_SELECTION_MUTATION = variant
  else delete env.AGENTMUX_PRESENTATION_SELECTION_MUTATION
  const execution = spawnSync(process.execPath, [vitest, 'run', '--config', 'apps/desktop/scripts/fixtures/browser-presentation-selection/vitest.owning.config.mts', '--reporter=json', '--outputFile=' + report],
    { cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(evidence, name + '.stdout'), execution.stdout ?? '')
  writeFileSync(resolve(evidence, name + '.stderr'), execution.stderr ?? '')
  const result = JSON.parse(readFileSync(report, 'utf8'))
  const actualLoaded = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(result.numTotalTests >= 30, 'Nonempty real owning tests must collect')
  assert.ok(result.testResults.every(suite => suite.assertionResults.length > 0), 'Loading or fixture failures are not mutation proof')
  const failures = result.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed'))
  if (variant) {
    assert.notEqual(execution.status, 0, 'Mutation must be detected')
    assert.ok(failures.length > 0, 'Mutation must fail a real behavior assertion')
    assert.ok(actualLoaded.some(input => input.variant === variant && input.modified && input.originalSHA256 !== input.loadedSHA256 && input.path === owners[mutations[variant][0]]), 'Exact mutated production Source must actually load')
  } else {
    assert.equal(execution.status, 0, 'Restored unchanged Source must pass')
    assert.equal(result.numFailedTests, 0)
    for (const path of Object.values(owners)) assert.ok(actualLoaded.some(input => input.path === path && input.originalSHA256 === inputs[path] && input.loadedSHA256 === inputs[path]), 'Green must consume pinned production owner ' + path)
  }
  return { variant: variant ?? 'restored-green', exitCode: execution.status, tests: result.numTotalTests, failedAssertions: failures.map(test => test.fullName),
    report: relative(root, report), reportSHA256: hash(readFileSync(report)), loaded: relative(root, loaded), loadedSHA256: hash(readFileSync(loaded)) }
}
const variants = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(mutations)
assert.ok(variants.length > 0 && new Set(variants).size === variants.length && variants.every(name => Object.hasOwn(mutations, name)), 'Nonempty known unique loaded mutation cases')
const receipt = { schema: 'agentmux.browser-presentation-selection-mutations.v1', passed: false, inputs, selectedVariants: variants, cases: [] }
try {
  for (const variant of variants) receipt.cases.push(run(variant))
  receipt.restored = run(null)
  receipt.sourceAfter = Object.fromEntries(Object.keys(inputs).map(path => [path, hash(readFileSync(resolve(root, path)))]))
  assert.deepEqual(receipt.sourceAfter, inputs, 'No Source is edited by mutations')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ evidence: relative(root, evidence), passed: receipt.passed, cases: receipt.cases.length, failure: receipt.failure }))
