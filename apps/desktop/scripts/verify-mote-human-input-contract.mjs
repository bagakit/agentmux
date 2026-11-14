import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/state/mote-human-input-contract')
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owners = ['apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/host/src/mote-dialogue.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/ctxmux-run-adapter.ts']
const runs = []
async function run(name, extra = {}, pattern) {
  const trace = join(evidence, name + '.sources.jsonl'), report = join(evidence, name + '.json')
  await writeFile(trace, '')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/mote-human-input-contract.config.mts',
    '--reporter=json', '--outputFile', report, ...(pattern ? ['--testNamePattern', pattern] : [])]
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTMUX_MOTE_HUMAN_TRACE: trace, ...extra } })
  let log = '', timedOut = false
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += String(bytes) })
  const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGTERM') }, 120_000)
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) }).finally(() => clearTimeout(timer))
  await writeFile(join(evidence, name + '.log'), log)
  assert.equal(timedOut, false, name + ' exceeded its bounded private test run')
  const result = JSON.parse(await readFile(report, 'utf8'))
  const sources = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(result.numTotalTests > 0 && result.numPassedTests + result.numFailedTests > 0, name + ' must execute real tests')
  const row = { name, code, passed: result.numPassedTests, failed: result.numFailedTests, sources: sources.filter(s => s.stage === 'evaluated') }
  runs.push(row)
  return { ...row, result }
}
let failure
try {
  const baseline = await run('baseline')
  assert.equal(baseline.code, 0); assert.equal(baseline.failed, 0); assert.equal(baseline.passed, 6)
  for (const file of owners) {
    const facts = baseline.sources.filter(row => row.file === file)
    assert.ok(facts.length, 'Real product consumer evaluated: ' + file)
    const current = hash(await readFile(join(root, file)))
    assert.ok(facts.every(row => row.fileSHA256 === current && row.sourceSHA256 === current && row.loadedSHA256 === current && row.mutation === null), 'Exact source identity: ' + file)
  }
  const adjacent = await run('adjacent', { AGENTMUX_TEST_MOTE_HUMAN_ADJACENT: '1' },
    'actual App keeps one editor|explicit member Send|passes only the original reference through direct manual input|keeps a lost direct intake reply|captures an exact native target only for a new draft|fresh Send uses the exact native queue|Send while a request is pending keeps the message unbound|carries the first fresh recovery input once|rechecks the exact original recovery')
  assert.equal(adjacent.code, 0); assert.equal(adjacent.failed, 0); assert.equal(adjacent.passed, 9)
  const mutant = await run('native-only-main', { AGENTMUX_MOTE_HUMAN_MUTATION: 'restore-native-only-main' }, 'ordinary working TUI')
  assert.notEqual(mutant.code, 0); assert.equal(mutant.passed, 0); assert.equal(mutant.failed, 1)
  const failures = mutant.result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  assert.ok(failures[0].failureMessages.some(message => message.includes('Fresh manual Main input must not require an optional native actor')), 'Mutation must fail at the actual native-only routing regression')
  const changed = mutant.sources.filter(row => row.mutation)
  assert.ok(changed.length > 0 && changed.every(row => row.file === owners[0] && row.loadedSHA256 !== row.sourceSHA256), 'Only evaluated producer is mutated')
  for (const row of baseline.sources) assert.equal(hash(await readFile(join(root, row.file))), row.fileSHA256, 'Source preserved after mutation: ' + row.file)
} catch (error) { failure = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed: !failure,
  boundary: 'Mounted real Mote Composer → Store → RuntimeController → Host Files/role → RPC → Core → private ctxmux original PTY. Terminal-confirmed proves ordered bytes, not model acceptance. No user Session or retained input is touched.',
  runs, ...(failure ? { failure } : {}) }, null, 2))
console.log(JSON.stringify({ passed: !failure, evidence, runs: runs.map(({ name, passed, failed }) => ({ name, passed, failed })), ...(failure ? { failure: failure.message } : {}) }))
if (failure) process.exitCode = 1
