import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') { assert.ok(args[++i]); continue }
  assert.equal(args[i], '--mutations', 'Use --mutations [--output DIRECTORY]')
}
const output = outputIndex < 0 ? join(root, '.tmp/survey-agent-navigation', randomUUID()) : resolve(args[outputIndex + 1])
await mkdir(output, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = {}
for (const name of ['src/renderer/src/components/BrowserPane.tsx', 'src/renderer/src/lib/browser-agent-creation.ts',
  'src/renderer/src/lib/space-agent-control.ts', 'src/renderer/src/store.ts', 'src/renderer/src/components/GlobalSurveySurface.tsx',
  'test/space-agent-control.test.ts', 'test/survey-surface.test.tsx', 'test/survey-agent-navigation.config.mts', 'scripts/verify-survey-agent-navigation.mjs']) {
  const path = 'apps/desktop/' + name; sources[path] = sha(await readFile(join(root, path)))
}
const receipt = { schema: 'agentmux.survey-agent-navigation.v1', passed: false, automatedPassed: false, sources, results: [],
  restart: 'pending-original-Run-native-proof', independentVisualReview: 'pending',
  boundary: 'Mounted original BrowserPane and Survey New Agent Launcher through the real Store and spatial owner. Unit IPC/PTY boundaries do not prove actual Core Run restart or physical composition.' }
async function run(label, mutant) {
  const report = join(output, label + '.json'), hits = join(output, label + '-hits.jsonl')
  const logs = [], started = performance.now()
  const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/survey-agent-navigation.config.mts',
    '--reporter=json', '--outputFile=' + report], { cwd: root, env: { ...process.env,
    SURVEY_AGENT_MUTANT: mutant ?? '', SURVEY_AGENT_MUTATION_HITS: hits }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => logs.push(bytes)); child.stderr.on('data', bytes => logs.push(bytes))
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
  await writeFile(join(output, label + '.log'), Buffer.concat(logs))
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.testResults.length, 2, 'Exactly the two declared mounted consumers must load')
  assert.ok(result.testResults.every(suite => suite.assertionResults.length > 0 && !suite.message), 'Module failure is not a semantic oracle')
  const executed = result.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.equal(executed.length, 7, 'All seven declared navigation scenarios must execute')
  if (!mutant) { assert.equal(code, 0); assert.equal(result.numFailedTests, 0) }
  else {
    const consumed = (await readFile(hits, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(consumed.length > 0 && consumed.every(hit => hit.original === sources[hit.id.slice(root.length + 1)] && hit.original !== hit.consumed))
    assert.notEqual(code, 0)
    assert.ok(executed.some(test => test.status === 'failed' && test.fullName.includes('mounted Survey Browser')), 'The changed navigation owner must fail its actual mounted Browser consumer')
  }
  receipt.results.push({ label, code, elapsedMs: performance.now() - started, executed: executed.length,
    passed: result.numPassedTests, failed: result.numFailedTests })
  console.log(label + ': ' + (mutant ? 'semantic red' : 'green'))
}
try {
  await run('baseline')
  if (args.includes('--mutations')) for (const mutant of ['context', 'global', 'late', 'selected']) await run(mutant, mutant)
  let nativeReceipt = process.env.SURVEY_AGENT_NATIVE_RECEIPT
  if (!nativeReceipt) {
    const nativeOutput = join(output, 'native')
    const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-survey-agent-navigation-electron.mjs'), nativeOutput],
      { cwd: root, env: process.env, stdio: 'inherit' })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'The private original Agent must survive the actual process restart')
    nativeReceipt = join(nativeOutput, 'receipt.json')
  }
  const nativeBytes = await readFile(nativeReceipt), native = JSON.parse(nativeBytes)
  assert.equal(native.passed, true)
  assert.equal(native.phases.length, 2)
  assert.ok(native.phases.every(phase => phase.process.exitConfirmed && phase.process.exitCode === 0 && phase.result.passed))
  assert.notEqual(native.phases[0].result.pid, native.phases[1].result.pid)
  assert.deepEqual(native.cleanup, { errors: [], remaining: [] })
  assert.ok(Object.keys(native.sources).length > 0)
  for (const [path, original] of Object.entries(native.sources)) assert.equal(sha(await readFile(join(root, path))), original, 'Original native consumer source must still match: ' + path)
  receipt.nativeEvidence = { path: resolve(nativeReceipt), sha256: sha(nativeBytes) }
  receipt.restart = 'original-Session-Run-native-handle-and-workface-confirmed'
  for (const [path, original] of Object.entries(sources)) assert.equal(sha(await readFile(join(root, path))), original)
  receipt.automatedPassed = true
} catch (error) { receipt.failure = error.stack ?? String(error) }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ output, automatedPassed: receipt.automatedPassed, pending: [receipt.restart, receipt.independentVisualReview], failure: receipt.failure }, null, 2))
process.exitCode = receipt.automatedPassed ? 2 : 1
