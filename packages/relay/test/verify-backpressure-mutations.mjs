import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { backpressureMutations } from './backpressure-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const directory = resolve(root, '.tmp/relay-backpressure', randomUUID())
await mkdir(directory, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = [...new Set(Object.values(backpressureMutations).flatMap(entry => [entry.file, entry.test]))]
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { schema: 'agentmux.relay-backpressure-mutations.v1', passed: false, inputs, runs: [] }
try {
  for (const name of ['baseline', ...Object.keys(backpressureMutations), 'restored']) {
    const variant = backpressureMutations[name]
    const loaded = resolve(directory, name + '.jsonl'), output = resolve(directory, name + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, RELAY_BACKPRESSURE_LOADED: loaded }
    delete env.RELAY_BACKPRESSURE_MUTATION
    if (variant) env.RELAY_BACKPRESSURE_MUTATION = name
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [vitest, 'run', '--config', 'packages/relay/test/backpressure-mutant.config.ts',
        '--reporter=json', '--outputFile=' + output], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''
      child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, log }))
    })
    await writeFile(resolve(directory, name + '.log'), run.log)
    assert.equal(run.signal, null)
    const result = JSON.parse(await readFile(output, 'utf8'))
    const tests = result.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (variant) {
      assert.notEqual(run.code, 0); assert.equal(tests.length, 1)
      assert.equal(result.numFailedTests, 1); assert.equal(result.numPassedTests, 0)
      assert.ok(tests[0].fullName.includes(variant.target))
      assert.ok(tests[0].failureMessages.some(value => value.includes('AssertionError')), 'Only bearing assertion failures count')
      const source = await readFile(resolve(root, variant.file), 'utf8')
      assert.equal(source.split(variant.before).length, 2)
      const expected = sha(source.replace(variant.before, variant.after))
      assert.ok(evaluations.some(value => value.path === variant.file && value.mutation === name
        && value.originalSHA256 === inputs[variant.file] && value.loadedSHA256 === expected
        && value.loadedSHA256 !== value.originalSHA256), 'The changed owner must actually evaluate')
      assert.ok(evaluations.some(value => value.path === variant.test && value.loadedSHA256 === inputs[variant.test]))
    } else {
      assert.equal(run.code, 0, run.log); assert.ok(tests.length >= 11); assert.equal(result.numFailedTests, 0)
      for (const file of sources) assert.ok(evaluations.some(value => value.path === file && value.loadedSHA256 === inputs[file]))
    }
    for (const file of sources) assert.equal(sha(await readFile(resolve(root, file))), inputs[file], 'Original source preserved')
    receipt.runs.push({ name, exitCode: run.code, tests: tests.map(test => ({ name: test.fullName, status: test.status })), evaluations })
    process.stdout.write(JSON.stringify({ name, passed: result.numPassedTests, failed: result.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
