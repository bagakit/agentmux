import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { focusDirectoryMutations } from '../test/mobile-focus-directory-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-directory-fix/focus-verification')
await mkdir(directory, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex'), runs = []
for (const label of ['baseline', ...Object.keys(focusDirectoryMutations), 'restored']) {
  const mutant = Object.hasOwn(focusDirectoryMutations, label), loaded = resolve(directory, label + '-loaded.jsonl')
  const result = resolve(directory, label + '-result.json'), facts = resolve(directory, label + '-facts.jsonl')
  await Promise.all([writeFile(loaded, ''), writeFile(facts, '')])
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/mobile-focus-directory.config.mts',
      '--reporter=json', '--outputFile=' + result], { cwd: root,
      env: { ...process.env, MOBILE_FOCUS_DIRECTORY_MUTANT: mutant ? label : '', MOBILE_FOCUS_DIRECTORY_LOADED: loaded, MOBILE_FOCUS_DIRECTORY_FACTS: facts },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ label, code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null, 'The exact test process must complete normally: ' + label)
  const report = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(report.numTotalTests, 3, 'All three original public/mobile consumers must execute: ' + label)
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(evaluations.length > 0, 'An implementation owner must actually evaluate')
  for (const path of ['apps/host/src/spatial-presentation.ts', 'packages/client-ui/src/lib/focus-order.ts', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'packages/core/src/public-rpc-service.ts']) {
    assert.ok(evaluations.some(row => row.path === path), 'The owning public/mobile chain must load: ' + path)
  }
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The original implementation mutation must fail: ' + label)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))),
      'A product assertion must detect the mutation, not a loading/build failure: ' + label)
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256),
      'The changed implementation must actually execute: ' + label)
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 3); assert.equal(failures.length, 0)
    const claims = (await readFile(facts, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.deepEqual(claims.map(value => value.case), ['work-order', 'original-object-groups', 'owner-conflict'])
    assert.ok(claims.length > 0); assert.ok(claims.every(value => value.sameSpatialBytes === true))
    assert.equal(claims[0].publicCliExitCode, 0); assert.equal(claims[1].independentTopics, 2)
    assert.equal(claims[1].distinctTopicReads, 2); assert.equal(claims[2].wrongIdentityNotAdopted, true)
  }
  runs.push({ label, exitCode: run.code, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) })
  process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
const inputs = {}
for (const path of new Set(runs.flatMap(run => run.evaluations.map(row => row.path)))) inputs[path] = hash(await readFile(resolve(root, path)))
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.mobile-focus-directory-proof.v1',
  scope: 'Isolated actual Core FileStore, public Unix RPC/server, compiled object CLI, exact Topic filesystem owner and mounted production MobileSpatialNavigation. Runtime bytes are deterministic ports; no installed App or physical phone claim.',
  inputs, runs }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-directory-fix/focus-verification/receipt.json' }) + '\n')
