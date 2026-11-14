import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.tmp/browser-navigation-observation', 'run-' + randomUUID())
const vitest = resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
await mkdir(directory, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceFiles = ['packages/core/src/browser-targets.ts', 'packages/core/src/control-browser-targets.ts', 'packages/core/src/index.ts',
  'packages/core/src/control-codec.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/src/agentmux.ts',
  'packages/browser/src/browser-page-dispatch.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/test/browser-view-manager.test.ts',
  'apps/desktop/test/browser-navigation-observation.config.mts', 'apps/desktop/scripts/verify-browser-navigation-observation.mjs']
const compiledFiles = ['packages/core/dist/control-browser-targets.js', 'packages/core/dist/control-codec.js',
  'packages/core/dist/public-rpc-server.js', 'packages/core/dist/agentmux.js']
const requiredEvaluated = ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/test/browser-view-manager.test.ts',
  'packages/core/dist/control-browser-targets.js', 'packages/core/dist/control-codec.js', 'packages/core/dist/public-rpc-server.js',
  'packages/browser/src/browser-page-dispatch.ts']
const bearing = {
  'main-hides-request-and-error': 'Main must expose the original requested URL and issue independently of the old native document',
  'codec-drops-navigation': 'Core wire codec must preserve original navigation facts'
}
const receipt = { schema: 'agentmux.browser-navigation-observation.v1', passed: false, inputs: {}, compiled: {}, runs: [],
  scope: 'Original BrowserViewManager with only Electron/CDP transport leaves controlled; real ControlServer/JSON wire/strict Core codec, compiled public Browser targets CLI, and public browser.run invoking actual runScript/pageInfo. No real user Browser, Session, App or permissions are touched. Four selected cases in the original manager suite; other cases are outside this narrow gate.' }
let baselineNames, baselineUnselected
try {
  for (const file of sourceFiles) receipt.inputs[file] = sha(await readFile(resolve(root, file)))
  for (const file of compiledFiles) receipt.compiled[file] = sha(await readFile(resolve(root, file)))
  for (const label of ['baseline', ...Object.keys(bearing), 'restored']) {
    const mutated = label in bearing, loaded = resolve(directory, label + '-loaded.jsonl'), report = resolve(directory, label + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, BROWSER_NAVIGATION_LOADED: loaded }; delete env.BROWSER_NAVIGATION_MUTATION
    if (mutated) env.BROWSER_NAVIGATION_MUTATION = label
    const command = [vitest, 'run', '--config', 'apps/desktop/test/browser-navigation-observation.config.mts', '--reporter=json', '--outputFile=' + report]
    const run = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, command, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(directory, label + '.log'), run.log)
    assert.equal(run.signal, null)
    const result = JSON.parse(await readFile(report, 'utf8'))
    const all = result.testResults.flatMap(file => file.assertionResults)
    const selected = all.filter(test => !['pending', 'skipped'].includes(test.status))
    const unselected = all.filter(test => ['pending', 'skipped'].includes(test.status)).map(test => test.fullName).sort()
    const evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.ok(selected.length > 0 && evaluated.length > 0, 'Actual owners and selected consumers must be nonempty')
    for (const file of requiredEvaluated) assert.ok(evaluated.some(row => row.file === file), 'Original module actually evaluated: ' + file)
    for (const row of evaluated) {
      assert.equal(row.sourceSHA256, receipt.inputs[row.sourceFile], 'Actual source provenance: ' + row.sourceFile)
      assert.equal(row.diskSHA256, receipt.inputs[row.file] ?? receipt.compiled[row.file], 'Actual loaded file: ' + row.file)
    }
    if (mutated) {
      assert.notEqual(run.code, 0); assert.equal(selected.length, 1); assert.equal(result.numFailedTests, 1); assert.equal(result.numPassedTests, 0)
      assert.ok(selected[0].fullName.includes('main-frame-event'))
      assert.ok(selected[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(bearing[label])),
        'The exact navigation observation assertion must fail, not protocol/import/timeout: ' + label)
      assert.ok(evaluated.some(row => row.mutation === label && row.loadedSHA256 !== row.originalSHA256), 'Mutated producer/codec actually evaluated: ' + label)
    } else {
      assert.equal(run.code, 0, run.log); assert.equal(selected.length, 4); assert.equal(result.numPassedTests, 4); assert.equal(result.numFailedTests, 0)
      assert.equal(result.numTodoTests, 0)
      const names = selected.map(test => test.fullName).sort()
      if (label === 'baseline') { baselineNames = names; baselineUnselected = unselected }
      else { assert.deepEqual(names, baselineNames); assert.deepEqual(unselected, baselineUnselected) }
      assert.ok(evaluated.every(row => row.loadedSHA256 === row.originalSHA256))
    }
    for (const [file, hash] of Object.entries({ ...receipt.inputs, ...receipt.compiled })) assert.equal(sha(await readFile(resolve(root, file))), hash, 'Input unchanged: ' + file)
    receipt.runs.push({ label, command: [process.execPath, ...command], exitCode: run.code, selected: selected.map(test => ({ name: test.fullName, status: test.status })),
      unselectedCount: unselected.length, evaluated, reportSHA256: sha(await readFile(report)), logSHA256: sha(run.log) })
    process.stdout.write(JSON.stringify({ label, passed: result.numPassedTests, failed: result.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
