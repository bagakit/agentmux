import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile'), directory = resolve(root, '.tmp/mobile-session-metadata', 'run-' + randomUUID())
await mkdir(directory, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const files = ['apps/mobile/src/conversation/mobile-conversation-session.ts', 'apps/mobile/src/conversation/use-hosted-conversation.ts',
  'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', 'apps/mobile/src/conversation/use-mobile-conversation-reading.tsx',
  'apps/mobile/test/mobile-session-metadata.test.tsx', 'apps/mobile/test/mobile-session-metadata.config.mts', 'apps/mobile/scripts/verify-mobile-session-metadata.mjs']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { schema: 'agentmux.mobile-session-metadata.v1', passed: false, inputs, runs: [],
  scope: 'Actual Mobile metadata and prompt consumers over serialized Hosted SDK/service and original Core registry, memory SessionStore, history and input admission. Only Provider history/native witnesses and ctxmux transport leaves are controlled; no user Session or Run is used.' }
try {
  for (const label of ['baseline', 'cache-only', 'retired-as-unknown', 'sticky-issue', 'restored']) {
    const mutated = !['baseline', 'restored'].includes(label), loaded = resolve(directory, label + '-loaded.jsonl'), report = resolve(directory, label + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, MOBILE_SESSION_METADATA_LOADED: loaded }; delete env.MOBILE_SESSION_METADATA_MUTATION
    if (mutated) env.MOBILE_SESSION_METADATA_MUTATION = label
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'test/mobile-session-metadata.config.mts', '--reporter=json', '--outputFile=' + report], { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value }); child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(directory, label + '.log'), run.log); assert.equal(run.signal, null)
    const result = JSON.parse(await readFile(report, 'utf8')), tests = result.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    for (const file of ['packages/core/src/client.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts', 'apps/mobile/test/mobile-session-metadata.test.tsx']) assert.ok(evaluated.some(row => row.file === file), 'Real owner/consumer evaluated: ' + file)
    if (mutated) {
      assert.notEqual(run.code, 0); assert.equal(tests.length, 1); assert.equal(result.numFailedTests, 1); assert.equal(result.numPassedTests, 0)
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError')), 'The original bearing assertion must fail, not import/setup/hook timeout')
      assert.ok(evaluated.some(row => row.mutation === label && row.originalSHA256 === inputs[row.file] && row.loadedSHA256 !== row.originalSHA256), 'Mutated original source actually evaluated')
    } else {
      assert.equal(run.code, 0, run.log); assert.equal(tests.length, 3); assert.equal(result.numPassedTests, 3); assert.equal(result.numFailedTests, 0)
      assert.ok(evaluated.every(row => row.loadedSHA256 === row.originalSHA256))
    }
    for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), hash, 'Source unchanged: ' + file)
    receipt.runs.push({ label, exitCode: run.code, tests: tests.map(test => ({ name: test.fullName, status: test.status })), evaluated, reportSHA256: sha(await readFile(report)), logSHA256: sha(run.log) })
    process.stdout.write(JSON.stringify({ label, passed: result.numPassedTests, failed: result.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
