import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateTests } from './verify-cross-host-execution.mjs'

const args = process.argv.slice(2)
const physicalAt = args.indexOf('--physical')
const physical = physicalAt >= 0 ? args.splice(physicalAt, 2)[1] : undefined
assert((physicalAt < 0 || physical && !physical.startsWith('--')) &&
  new Set(args).size === args.length && args.every(arg => arg === '--mutations' || arg === '--native'),
  'Use verify-project-execution-recovery.mjs [--mutations] [--native] [--physical exact-private-installation.json]')
const repository = resolve(import.meta.dirname, '../../..')
const evidence = await mkdtemp(join(tmpdir(), 'amux-project-execution-recovery-'))
const config = 'packages/core/scripts/fixtures/vitest.project-execution-recovery.config.mts'
const baseline = 'same socket and generation|changed-native|missing-evidence|honors exact client cancellation|late native initialization response|private initialization cancellation|automatically replaces only|recovers a lost project helper|forwards retirement only'
const mutations = [
  { id: 'skip-recovery', file: 'packages/core/src/agent-execution/executor.ts', test: 'same socket and generation',
    before: 'if (plan) current = start(generation, nativeConnectionRecovery(plan))', after: 'if (false) current = start(generation, nativeConnectionRecovery(plan))' },
  { id: 'ignore-provider-contract', file: 'packages/providers/src/claude/execution-protocol.ts', test: 'changed-native',
    before: ' && isDeepStrictEqual(next.payload.result, result)', after: '' },
  { id: 'drop-cancellation', file: 'packages/core/src/agent-execution/executor.ts', test: 'honors exact client cancellation',
    before: 'if (pending?.awaitingDispatch) { pending.cancelled = true; return }', after: 'void pending' },
  { id: 'ignore-retirement', file: 'packages/core/src/agent-execution/frontend.ts', test: 'same socket and generation',
    before: "frame.type === 'retire-frontend-requests'", after: "frame.type === 'unused-retirement'" },
  { id: 'unfenced-retirement', file: 'packages/core/src/agent-execution/bridge.ts', test: 'forwards retirement only',
    before: "frame.type === 'retire-frontend-requests' && this.state.projectRecoveryId !== undefined &&\n        this.state.retireFrontendThrough !== undefined && frame.through === this.state.retireFrontendThrough",
    after: "frame.type === 'retire-frontend-requests'" },
  { id: 'skip-original-agent-proof', file: 'packages/core/src/agent-execution-coordinator.ts', test: 'automatically replaces only',
    before: 'if (automatic) await this.confirmActiveRecoverySession(record, hosts)', after: 'void automatic' },
]
const report = { passed: false, evidence, baseline: 0, mutations: [], native: null, physical: null }
const save = () => writeFile(join(evidence, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
const run = (args, overrides = {}) => new Promise((resolveChild, reject) => {
  const env = { ...process.env }
  delete env.AGENTMUX_PROJECT_RECOVERY_MUTATION
  delete env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE
  const child = spawn(process.execPath, args, { cwd: repository, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  child.once('error', reject)
  child.once('close', (code, signal) => resolveChild({ code, signal, stdout, stderr }))
})

async function test(id, name, mutation) {
  const output = join(evidence, id + '.json'), receipt = join(evidence, id + '.hit')
  const result = await run(['packages/core/node_modules/vitest/vitest.mjs', 'run', '--config', config, '-t', name,
    '--reporter=json', '--outputFile=' + output], mutation ? { AGENTMUX_PROJECT_RECOVERY_MUTATION: JSON.stringify({ ...mutation, receipt }) } : {})
  await writeFile(join(evidence, id + '.log'), result.stdout + result.stderr)
  const verdict = JSON.parse(await readFile(output, 'utf8'))
  const selected = verdict.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped')
  assert(selected.length > 0 && result.signal === null, 'The original recovery assertions must run.')
  if (!mutation) {
    assert.equal(result.code, 0, 'The project recovery baseline failed.')
    assert.equal(selected.length, 11, 'The complete project recovery baseline must run.')
    assert(selected.every(test => test.status === 'passed') && verdict.success === true)
  } else {
    assert(result.code > 0 && (await readFile(receipt, 'utf8')).trim().endsWith('/' + mutation.file))
    validateTests(verdict, true)
  }
  return selected.length
}

function assertProjectProof(proof) {
  assert(proof.passed === true && proof.mode === 'project-recovery' && proof.resourceInstanceChanged === true &&
    proof.freshNativeFileRead === true && proof.originalEffectCount === 1 && proof.oldOutcomeUnknown === true &&
    proof.originalWaitSettled === true && proof.originalAgentRunId && proof.originalGeneration && Number.isInteger(proof.originalFrontendPid))
}

try {
  report.baseline = await test('baseline', baseline)
  await save()
  if (args.includes('--mutations')) for (const mutation of mutations) {
    await test(mutation.id, mutation.test, mutation)
    report.mutations.push(mutation.id)
    await save()
  }
  if (args.includes('--native')) {
    const result = await run(['packages/core/scripts/verify-claude-execution.mjs', '--project-recovery'])
    await writeFile(join(evidence, 'native.log'), result.stdout + result.stderr)
    assert.equal(result.code, 0, 'Actual Claude project recovery failed.')
    const proof = JSON.parse(result.stdout.trim())
    assertProjectProof(proof)
    const cleanup = JSON.parse(await readFile(proof.cleanup, 'utf8'))
    assert(cleanup.passed === true && cleanup.errors?.length === 0 && cleanup.records?.length > 0)
    report.native = proof
  }
  if (physical) {
    const installation = resolve(physical)
    const { authorization } = JSON.parse(await readFile(installation, 'utf8'))
    assert(authorization?.role === 'user' && typeof authorization.target === 'string', 'Physical proof needs the original private installation authorization.')
    const result = await run(['packages/core/scripts/verify-claude-execution-remote.mjs', '--installation', installation,
      '--authorized-target', authorization.target, '--project-recovery'])
    await writeFile(join(evidence, 'physical.log'), result.stdout + result.stderr)
    assert.equal(result.code, 0, 'Actual dual-host Claude project recovery failed.')
    const receipt = JSON.parse(result.stdout.trim()), proof = JSON.parse(await readFile(receipt.summary, 'utf8'))
    assert(proof.actualMachines === 2 && proof.results?.length === 1 && proof.results[0].direction === 'remote-agent')
    assertProjectProof(proof.results[0])
    assert(proof.cleanup?.length === 2 && proof.cleanup.every(owner => owner.code === 0 && owner.signal === null &&
      owner.receipt?.stopped === true && owner.receipt.errors?.length === 0))
    report.physical = receipt
  }
  report.passed = true
} finally {
  await save()
  console.log(JSON.stringify(report))
}
