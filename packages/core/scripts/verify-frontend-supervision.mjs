import assert from 'node:assert/strict'
import { verifySourceBoundProof } from './lib/source-bound-proof.mjs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = join(root, '.local/state/frontend-startup-convergence/supervision')
await mkdir(output, { recursive: true })
const paths = ['packages/core/scripts/lib/source-bound-proof.mjs', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/supervisor.ts',
  'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/test/frontend-supervision-service.test.ts',
  'packages/core/test/agent-session-initialization-service.test.ts',
  'packages/core/test/frontend-supervision-service.config.mts', 'packages/core/scripts/verify-frontend-supervision.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.frontend-supervision-proof.v1', passed: false, sourceStable: false, userRuntimeTouched: false,
  sourceSHA256: await sources(), results: [] }
const variants = [
  ['candidate'],
  ['drop-creation-observer', 'seeds one durable original creation'],
  ['borrow-another-created-run', 'does not seed a creation observer from other-created-run'],
  ['split-manual-budget', 'joins repeated manual recovery'],
  ['forget-observer-identity', 'joins repeated manual recovery'],
  ['drop-slow-promotion', 'promotes the original count-zero'],
  ['drop-queued-exact-wake', 'retains a queued exact initialization wake'],
  ['drop-original-run-observer', 'seeds one durable original creation'],
  ['resume-ended-frontend-backend', 'backend ends during an unknown reconnect'],
  ['ignore-original-stop', 'later frontend failure bypass an exact prepared Stop']
]
if (process.env.AGENTMUX_REUSE_SOURCE_BOUND_PROOF === '1') {
  console.log(await verifySourceBoundProof(join(output, 'receipt.json'), { inputs: receipt.sourceSHA256,
    minPassed: 15, mutations: variants.slice(1).map(variant => variant[0]) })); process.exit(0)
}
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
try {
  for (const [name, pattern] of variants) {
    const loadedPath = join(output, name + '.loaded.ndjson'), jsonPath = join(output, name + '.json')
    await writeFile(loadedPath, '')
    const env = { ...process.env, AGENTMUX_FRONTEND_SUPERVISION_LOADED: loadedPath }
    delete env.AGENTMUX_FRONTEND_SUPERVISION_MUTATION
    if (name !== 'candidate') env.AGENTMUX_FRONTEND_SUPERVISION_MUTATION = name
    const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/frontend-supervision-service.config.mts',
      '--maxWorkers=1', '--reporter=json', '--outputFile=' + jsonPath, ...(pattern ? ['-t', pattern] : [])]
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
      child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal, text }))
    })
    await writeFile(join(output, name + '.log'), result.text)
    const report = JSON.parse(await readFile(jsonPath, 'utf8'))
    const assertions = report.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(test => test.status === 'failed')
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const changed = loaded.filter(file => file.loadedSHA256 !== file.originalSHA256)
    receipt.results.push({ name, code: result.code, tests: report.numTotalTests, passed: report.numPassedTests,
      failed: report.numFailedTests, assertionFailures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })), loaded })
    await save()
    assert.ok(report.numTotalTests > 0 && assertions.some(test => test.status !== 'pending'), 'Nonempty business tests: ' + name)
    if (name === 'candidate') {
      assert.equal(result.code, 0, result.text); assert.ok(report.numPassedTests >= 15); assert.equal(report.numFailedTests, 0)
    } else {
      assert.equal(changed.length, 1, 'Exactly one production owner mutated: ' + name)
      assert.notEqual(result.code, 0, 'Mutation survived: ' + name)
      assert.ok(failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must fail a business assertion: ' + name)
    }
    process.stdout.write(JSON.stringify({ variant: name, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  assert.deepEqual(await sources(), receipt.sourceSHA256, 'Authored sources changed during proof')
  receipt.sourceStable = true; receipt.passed = true
} finally { await save() }
