import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { contentMutations } from '../test/mobile-content-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/content')
await mkdir(directory, { recursive: true })
const runs = []
for (const label of ['baseline', ...Object.keys(contentMutations), 'restored']) {
  const mutant = Object.hasOwn(contentMutations, label), loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
  await writeFile(loaded, '')
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.mobile-content.config.mts', '--reporter=json', '--outputFile=' + result], {
      cwd: root, env: { ...process.env, MOBILE_CONTENT_TEST_MUTANT: mutant ? label : '', MOBILE_CONTENT_TEST_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null)
  const report = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(report.numTotalTests, 1, 'The actual Relay/Desktop-exit/Host-restart content consumer must execute')
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The implementation mutation must be detected')
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'The actual consumer must detect the changed owner, not a build or loader error')
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact changed source must actually execute')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 1)
    for (const path of ['apps/host/src/content-owner.ts', 'apps/host/src/note-file-writer.ts', 'apps/host/src/topic-knowledge.ts', 'apps/host/src/topic-spatial-owner.ts']) assert.ok(evaluations.some(row => row.path === path), 'Original owner must execute: ' + path)
  }
  runs.push({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations })
  process.stdout.write(JSON.stringify({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.headless-mobile-content.v1', scope: 'Private official ctxmux, real Node Host/Main and encrypted Relay; original file/Note history/Topic/CLI consumers with Desktop exit and Host restart. No live App or physical phone.', runs }, null, 2) + '\n')
