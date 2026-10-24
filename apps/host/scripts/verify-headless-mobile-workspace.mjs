import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { workspaceMutations } from '../test/mobile-workspace-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/workspace')
await mkdir(directory, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex'), runs = []
for (const label of ['baseline', ...Object.keys(workspaceMutations), 'restored']) {
  const mutant = Object.hasOwn(workspaceMutations, label), loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
  await writeFile(loaded, '')
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.mobile-workspace.config.mts', '--reporter=json', '--outputFile=' + result], {
      cwd: root, env: { ...process.env, HEADLESS_MOBILE_WORKSPACE_MUTANT: mutant ? label : '', HEADLESS_MOBILE_WORKSPACE_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ label, code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null)
  const report = JSON.parse(await readFile(result, 'utf8')), evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(report.numTotalTests, 1, 'The actual Mobile readers must execute')
  for (const path of ['apps/mobile/src/appearance/useHostAppearance.ts', 'apps/mobile/src/conversation/use-mobile-commands.ts', 'apps/host/src/host-appearance.ts', 'apps/host/src/settings-resource-read.ts']) assert.ok(evaluations.some(row => row.path === path), 'The original consumer and owner must actually evaluate: ' + path)
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The implementation mutation must fail: ' + label)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') || message.includes('__VITEST_RESOLVES__'))), 'A consumer assertion must detect the mutation: ' + label)
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact original mutation must evaluate: ' + label)
  } else { assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 1); assert.equal(failures.length, 0) }
  runs.push({ label, exitCode: run.code, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) })
  process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
const inputs = {}
for (const path of new Set(runs.flatMap(run => run.evaluations.map(row => row.path)))) inputs[path] = hash(await readFile(resolve(root, path)))
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.headless-mobile-workspace.v1',
  scope: 'Isolated real ctxmux/Node Host/Main with the actual browser-compatible Relay Hosted connector and Mobile Commands/appearance React consumers. Covers original resource reads, compiled CLI, exact-file updates, visible metadata failure and convergence. No live App, physical phone or package qualification.', inputs, runs }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/workspace/receipt.json' }) + '\n')
