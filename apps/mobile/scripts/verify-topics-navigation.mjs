import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json'))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, 'topics-navigation-sources.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [...new Set(Object.values(manifest).flat())]
assert.ok(files.length > 0)
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(resolve(root, file)))])))
const dependencies = Object.fromEntries(await Promise.all(['@agentmux/core', '@agentmux/core/spatial-state', '@agentmux/host/topic-knowledge', '@agentmux/host/topic-spatial-owner', '@agentmux/host/file-read-owner'].map(async name => {
  const file = fileURLToPath(import.meta.resolve(name))
  return [name, { file, sha256: hash(await readFile(file)) }]
})))
dependencies.environment = { node: process.version, platform: process.platform, arch: process.arch, vitest: hash(await readFile(vitest)), workspaceMoveHelper: hash(await readFile(resolve(root, 'apps/desktop/resources/bin/agentmux-workspace-move'))) }
const base = resolve(root, '.tmp/mobile-workface-architecture/topics-navigation'), current = resolve(base, 'current-receipt.json')
await mkdir(base, { recursive: true })
const mutations = ['sticky-source', 'forget-scope', 'metadata-navigates', 'late-save-body', 'null-origin', 'old-source-frame']
async function validate(receipt) {
  assert.equal(receipt.passed, true); assert.deepEqual(receipt.inputs, inputs); assert.deepEqual(receipt.dependencies, dependencies)
  assert.deepEqual(receipt.runs.map(run => run.label), ['baseline', ...mutations, 'restored'])
  for (const run of receipt.runs) {
    const report = await readFile(resolve(root, run.report)), trace = await readFile(resolve(root, run.trace))
    assert.equal(hash(report), run.reportSHA256); assert.equal(hash(trace), run.traceSHA256)
    const data = JSON.parse(report), executed = data.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const rows = trace.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.ok(rows.length > 0, 'Original modules actually evaluated')
    assert.equal(executed.length, run.executed); assert.ok(executed.length > 0)
    assert.ok(data.testResults.every(file => !file.message), 'No module collection failure')
    for (const row of rows) if (inputs[row.file]) assert.equal(row.originalSHA256, inputs[row.file], 'Same evaluated source: ' + row.file)
    if (mutations.includes(run.label)) {
      assert.equal(run.exitCode, 1); assert.equal(data.numFailedTestSuites, 1); assert.equal(data.numFailedTests, 1); assert.equal(executed.length, 1)
      assert.ok(executed[0].failureMessages.some(message => message.includes('AssertionError')), 'A business assertion bears the failure')
      const owner = run.label === 'late-save-body' ? 'apps/mobile/src/topics/MobileTopicKnowledge.tsx' : 'apps/mobile/src/topics/topics-navigation.ts'
      assert.ok(rows.some(row => row.file === owner && row.mutation === run.label
        && /^[a-f0-9]{64}$/.test(row.originalSHA256) && /^[a-f0-9]{64}$/.test(row.consumedSHA256)
        && row.originalSHA256 === inputs[owner] && row.originalSHA256 !== row.consumedSHA256), 'The exact mutation was evaluated')
    } else {
      assert.equal(run.exitCode, 0); assert.equal(data.numFailedTests, 0); assert.ok(executed.length >= 52, 'Nonempty original and new consumers')
      assert.ok(executed.every(test => test.status === 'passed'))
    }
  }
}
let prior
try { prior = JSON.parse(await readFile(process.env.TOPICS_NAVIGATION_RECEIPT ? resolve(root, process.env.TOPICS_NAVIGATION_RECEIPT) : current, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (prior && JSON.stringify(prior.inputs) === JSON.stringify(inputs) && JSON.stringify(prior.dependencies) === JSON.stringify(dependencies)) {
  await validate(prior)
  console.log(relative(root, current)); process.exit(0)
}
const directory = resolve(base, randomUUID()); await mkdir(directory, { recursive: true })
const receipt = { passed: false, inputs, dependencies, runs: [], boundary: 'Original MobileApp, Topic/Knowledge/File public owners and DeviceWorkface consumers. Controlled private fixtures only; no live App, Session or input. Original durable schema and unknown requests retained.' }
try {
  for (const label of ['baseline', ...mutations, 'restored']) {
    const report = resolve(directory, label + '.json'), trace = resolve(directory, label + '-loaded.jsonl'), log = resolve(directory, label + '.log')
    await writeFile(trace, '')
    const env = { ...process.env, VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '2', TOPICS_NAVIGATION_REGRESSION: '1', TOPICS_NAVIGATION_MUTATION: mutations.includes(label) ? label : 'baseline', TOPICS_NAVIGATION_LOADED: trace }
    const result = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [vitest, 'run', '--config', 'test/topics-navigation.config.mts', '--reporter=json', '--outputFile=' + report], { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes)
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
    })
    await writeFile(log, result.output); assert.equal(result.signal, null, 'Normal process completion')
    const bytes = await readFile(report), data = JSON.parse(bytes)
    const executed = data.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    receipt.runs.push({ label, exitCode: result.code, executed: executed.length, failed: data.numFailedTests,
      report: relative(root, report), reportSHA256: hash(bytes), trace: relative(root, trace), traceSHA256: hash(await readFile(trace)), log: relative(root, log) })
    assert.equal(result.code, mutations.includes(label) ? 1 : 0, 'Expected original consumer result: ' + label)
    if (mutations.includes(label)) {
      assert.equal(executed.length, 1); assert.equal(data.numFailedTests, 1)
      assert.ok(executed[0].failureMessages.some(message => message.includes('AssertionError')), 'Business assertion, not a loader/timeout failure: ' + label)
    } else { assert.ok(executed.length >= 52); assert.equal(data.numFailedTests, 0) }
    console.log(label + ': ' + executed.length + ' executed, ' + data.numFailedTests + ' failed')
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Source stable: ' + file)
  await validate({ ...receipt, passed: true })
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message }
  throw error
} finally {
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
await writeFile(current, JSON.stringify(receipt, null, 2) + '\n')
console.log(relative(root, resolve(directory, 'receipt.json')))
