import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { desktopRequire, root } from '../settings-resource-library/environment.mjs'

const evidence = resolve(process.env.AGENTMUX_SETTINGS_PREVIEW_EVIDENCE || resolve(root, '.bagakit/settings-decision-feedback/preview-proof'))
mkdirSync(evidence, { recursive: true })
const files = ['FocusSettingsPane.tsx', 'FocusSettingsPreview.tsx', 'BrowserAgentControlSettingsPane.tsx', 'BrowserAgentControlPreview.tsx', 'use-settings-preview-return.tsx', 'settings-preview-return.css']
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceInputs = files.map(file => { const path = 'apps/desktop/src/renderer/src/components/settings/' + file; return { file: path, sha256: sha(readFileSync(resolve(root, path))) } })
const focusStyle = 'apps/desktop/src/renderer/src/styles/settings-focus.css'
sourceInputs.push({ file: focusStyle, sha256: sha(readFileSync(resolve(root, focusStyle))) })
const expectedFailures = {
  focus: ['Focus previews the chosen group and returns to the same edited control and reading position without saving or remounting', 'an untouched group returns to its actual preview opener and preserves an open Focus reading example'],
  takeover: ['Agent takeover keeps the original simulation and draft while all three groups return to their own controls'],
  return: ['Focus previews the chosen group and returns to the same edited control and reading position without saving or remounting', 'Agent takeover keeps the original simulation and draft while all three groups return to their own controls', 'an untouched group returns to its actual preview opener and preserves an open Focus reading example']
}
expectedFailures.destination = expectedFailures.return
const excluded = 'actual CLI reads and persists the same preferences through public RPC and rejects invalid values before writing'
let inventory
const runs = []
for (const mode of ['baseline', 'focus', 'takeover', 'return', 'destination', 'restored']) {
  const directory = resolve(evidence, mode), raw = resolve(directory, 'result.json')
  mkdirSync(directory, { recursive: true })
  const env = { ...process.env, AGENTMUX_SETTINGS_PREVIEW_EVIDENCE: directory }
  delete env.AGENTMUX_SETTINGS_PREVIEW_MUTANT
  if (expectedFailures[mode]) env.AGENTMUX_SETTINGS_PREVIEW_MUTANT = mode
  const result = spawnSync(process.execPath, [desktopRequire.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.settings-preview-return.config.mts', '--reporter=json', '--outputFile=' + raw], { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(directory, 'run.log'), (result.stdout || '') + (result.stderr || ''))
  assert.equal(result.error, undefined, 'Process startup or timeout is not a business failure')
  const report = JSON.parse(readFileSync(raw, 'utf8')), tests = report.testResults.flatMap(file => file.assertionResults)
  assert.equal(tests.length, 14, 'All declared component consumers are collected')
  const names = tests.map(test => test.fullName).sort()
  if (!inventory) inventory = names
  assert.deepEqual(names, inventory, 'Baseline, mutations and restored use the same nonempty inventory')
  const skipped = tests.filter(test => test.status !== 'passed' && test.status !== 'failed')
  assert.deepEqual(skipped.map(test => test.fullName), [excluded], 'Only the unchanged public worker test is outside this UI scope')
  const failed = tests.filter(test => test.status === 'failed')
  assert.deepEqual(failed.map(test => test.fullName).sort(), (expectedFailures[mode] || []).sort(), 'Only the declared business consumers fail')
  assert.equal(result.status, failed.length ? 1 : 0, 'Process exit agrees with actual business assertions')
  let mutation
  if (failed.length) {
    for (const test of failed) assert.match(test.failureMessages.join('\n'), /AssertionError/u, 'Owner mutation reaches a business assertion')
    const witnesses = readFileSync(resolve(directory, 'mutation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(witnesses.length, 1, 'One actual source owner is replaced')
    mutation = witnesses[0]
    assert.equal(mutation.mutant, mode)
    assert.notEqual(mutation.original, mutation.consumed)
    assert.equal(sha(readFileSync(resolve(root, mutation.file))), mutation.original, 'Mutation does not edit source on disk')
  }
  runs.push({ mode, raw: relative(evidence, raw), sha256: sha(readFileSync(raw)), exitCode: result.status, passed: tests.filter(test => test.status === 'passed').length, failed: failed.map(test => test.fullName), skipped: [excluded], mutation })
  console.log(mode + ': ' + (failed.length ? failed.length + ' expected business RED' : '13 component tests GREEN'))
}
for (const input of sourceInputs) assert.equal(sha(readFileSync(resolve(root, input.file))), input.sha256, 'Candidate source remains unchanged')
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify({ passed: true, sourceDiskUnchanged: true, sourceInputs, runs,
  boundary: 'Actual SettingsPanel and original Focus/takeover consumers under happy-dom. Focus, drafts, original nodes and reading-position restoration are asserted; real geometry, scrolling, themes and aesthetics require the separate native capture. The unchanged public CLI/RPC worker is excluded explicitly.' }, null, 2) + '\n')
