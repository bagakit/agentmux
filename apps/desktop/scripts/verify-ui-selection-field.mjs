import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const vitest = require.resolve('vitest/vitest.mjs')
const evidence = mkdtempSync(join(root, '.tmp/ui-selection-field-verification-'))
const receipt = { schema: 'agentmux.ui-selection-field-verification.v1', passed: false, cases: [] }
const mutants = ['saved-inference', 'drop-description', 'disable-missing']
const expectedAssertions = {
  'saved-inference': ['does not infer a saved selection from a missing option', 'Saved selection'],
  'drop-description': ['uses the caller-provided missing identity and field description', 'runtime-hint'],
  'disable-missing': ['keeps an unknown missing value visible and selectable without marking it disabled', 'aria-disabled'],
}

function run(label, mutant) {
  const directory = join(evidence, label)
  mkdirSync(directory, { recursive: true })
  const env = { ...process.env, CI: 'true', AGENTMUX_SELECTION_EVIDENCE: directory, AGENTMUX_SELECTION_MUTANT: mutant }
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'apps/desktop/test/ui-selection-field.config.mts', '--maxWorkers=1'], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
  })
  writeFileSync(join(directory, 'process.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  const loadedPath = join(directory, 'loaded-source.jsonl')
  const loaded = existsSync(loadedPath) ? readFileSync(loadedPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  const applied = loaded.filter(item => item.applied)
  receipt.cases.push({ label, mutant, exitCode: result.status, applied })
  if (mutant === 'baseline') {
    assert.equal(result.status, 0, `${label}: baseline must pass`)
    assert.equal(applied.length, 0, `${label}: baseline must not mutate source`)
  } else {
    assert.equal(result.status, 1, `${label}: production mutant must fail its targeted assertion`)
    assert.equal(applied.length, 1, `${label}: exactly one loaded production mutation`)
    assert.notEqual(applied[0].originalSHA256, applied[0].consumedSHA256, `${label}: loaded source must actually change`)
    for (const text of expectedAssertions[mutant]) assert.ok(log.includes(text), `${label}: targeted assertion is required: ${text}`)
  }
}

try {
  run('baseline', 'baseline')
  for (const mutant of mutants) {
    run(`${mutant}-mutant`, mutant)
    run(`${mutant}-restored`, 'baseline')
  }
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error instanceof Error ? error.message : String(error) }
  process.exitCode = 1
} finally {
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, join(evidence, 'receipt.json')), failure: receipt.failure }))
}
