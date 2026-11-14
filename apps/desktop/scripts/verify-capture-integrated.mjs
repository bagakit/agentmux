import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { arch, release } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })
assert.equal(diff.length, 0, 'Integrated acceptance requires a clean tracked candidate')
const receipt = { schema: 'agentmux.capture-integrated-candidate.v1', passed: false, candidate: { head, trackedDiffHash: createHash('sha256').update(diff).digest('hex') },
  productionInputs: {}, baseline: null, machine: { platform: process.platform, arch: arch(), release: release(), displayTopology: null }, scenarios: [], samples: [], performance: [], cleanup: {}, aestheticReview: 'pending-independent-review', stages: [] }
const out = join(root, '.local/state/capture-experience-polish/integrated-candidate.json')
await mkdir(dirname(out), { recursive: true })
async function stage(name, script, args, receiptFromLog) {
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false, kill
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { const text = String(bytes); log += text; process.stdout.write(text) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, 1800000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timedOut, log }) })
  })
  assert.equal(result.timedOut, false, name + ': timeout is not a passing receipt')
  assert.equal(result.signal, null, name + ': external termination is not a passing receipt')
  assert.equal(result.code, 0, name + ': command failed')
  const path = receiptFromLog(result.log)
  assert.ok(path, name + ': original receipt path missing')
  const proof = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(proof.passed, true, name + ': original receipt did not pass')
  receipt.stages.push({ name, receipt: path, passed: true })
  return proof
}
function jsonReceipt(log) {
  for (const line of log.split('\n').reverse()) { try { const row = JSON.parse(line); if (row.receipt) return row.receipt } catch {} }
  return null
}
try {
  const real = await stage('real-startup', 'apps/desktop/scripts/verify-capture-real-startup.mjs', [], jsonReceipt)
  assert.equal(real.candidate.head, head); assert.equal(real.samples.length, 24); assert.equal(real.comparisons.length, 4)
  assert.ok(Object.keys(real.productionInputs?.baseline?.files ?? {}).length && Object.keys(real.productionInputs?.candidate?.files ?? {}).length)
  receipt.productionInputs = real.productionInputs; receipt.baseline = real.baseline; receipt.machine.displayTopology = real.samples[0].topology
  receipt.samples = real.samples; receipt.performance = real.comparisons; receipt.cleanup.realStartup = real.cleanup
  const lifecycle = await stage('real-lifecycle', 'apps/desktop/scripts/verify-capture-live.mjs', ['--scenario', 'lifecycle'], jsonReceipt)
  assert.ok(lifecycle.native?.cases?.length && lifecycle.native.checks?.length && lifecycle.native.checks.every(row => row.passed))
  assert.equal(lifecycle.native.cleanup.nativeDisposed, true); assert.equal(lifecycle.native.cleanup.windowsRemaining, 0)
  receipt.scenarios = lifecycle.native.cases; receipt.cleanup.realLifecycle = lifecycle.native.cleanup
  const selection = await stage('public-selection', 'apps/desktop/scripts/verify-capture-public-selection.mjs', [], jsonReceipt)
  assert.ok(selection.native?.cases?.length && selection.mutations?.length, 'The real public consumer and its mutations must execute')
  const pasted = await stage('pasted-consumers', 'apps/desktop/scripts/verify-pasted-image-persistence.mjs', [], log => log.match(/Pasted image proof: (.+)/)?.[1])
  assert.ok(pasted.baselineQualified, 'The real pasted-image consumer proof must qualify its baseline')
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head, 'The candidate changed during integrated verification')
  assert.equal(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }).length, 0, 'Tracked inputs changed during integrated verification')
  assert.ok(receipt.machine.displayTopology?.length && receipt.scenarios.length && receipt.samples.length && receipt.performance.length)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  await writeFile(out, JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: out, failure: receipt.failure, aestheticReview: receipt.aestheticReview }) + '\n')
