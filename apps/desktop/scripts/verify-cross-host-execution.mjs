import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..')
const mutantNames = ['tool-target', 'local-host-inventory', 'notices', 'initial-order', 'reader-isolation']
export function parseArgs(values) {
  const options = { mutations: false, plan: false, output: undefined }
  const seen = new Set()
  for (let index = 0; index < values.length; index++) {
    const flag = values[index]
    assert(['--mutations', '--plan', '--output'].includes(flag) && !seen.has(flag), `Unknown or repeated flag: ${flag}`)
    seen.add(flag)
    if (flag === '--output') {
      const value = values[++index]
      assert(value && !value.startsWith('--'), '--output requires a fresh evidence directory')
      options.output = resolve(value)
    } else options[flag.slice(2)] = true
  }
  return options
}
export function planChecks(output, mutations) {
  const checks = [{ id: 'baseline', executable: resolve(repository, 'packages/core/node_modules/.bin/vitest'), args: ['run', '--config', 'apps/desktop/test/vitest.tool-execution-ui.config.mts', '--reporter=json', '--outputFile=' + resolve(output, 'baseline.json')], evidence: resolve(output, 'baseline.json') }]
  if (mutations) checks.push({ id: 'mutations', executable: process.execPath, args: ['apps/desktop/scripts/verify-tool-execution-ui-mutants.mjs', resolve(output, 'mutations')], evidence: resolve(output, 'mutations/receipt.json') })
  checks.push({ id: 'native-ipc', executable: process.execPath, args: ['apps/desktop/scripts/verify-space-agent-cli.mjs', resolve(output, 'native-ipc'), '--tool-workspace'], evidence: resolve(output, 'native-ipc/receipt.json') },
    { id: 'visual-capture-and-restart', executable: process.execPath, args: ['apps/desktop/scripts/capture-tool-execution-ui.mjs', resolve(output, 'visual')], evidence: resolve(output, 'visual/receipt.json') })
  return checks
}
export function validateEvidence(id, value) {
  if (id === 'baseline') {
    assert(value.success === true && value.numTotalTests > 0 && value.numPassedTests === value.numTotalTests && value.numFailedTests === 0, 'The actual baseline must execute a nonempty passing test set')
  } else if (id === 'mutations') {
    assert(Array.isArray(value) && value.length === mutantNames.length, 'All five mutations must run')
    assert.deepEqual(value.map(item => item.mutation).sort(), [...mutantNames].sort(), 'Exact mutation coverage is required')
    assert(value.every(item => item.killed === true && Number.isInteger(item.exitCode) && item.exitCode !== 0), 'Every mutant must hit the product source and fail its assertions')
  } else if (id === 'native-ipc') {
    assert(value.passed === true && value.phases?.length === 2, 'Both actual tool-workspace Electron generations are required')
    assert.deepEqual(value.phases.map(phase => phase.phase), ['tool-workspace', 'tool-workspace-restore'])
    const [seed, restored] = value.phases
    assert(seed.native?.pid !== restored.native?.pid, 'Restart must be a different real Electron process')
    for (const phase of value.phases) {
      const observation = phase.native?.bindingObservation
      assert(phase.exit?.exitCode === 0 && phase.exit.timedOut === false && phase.native.passed === true && observation?.originalRunRetained === true, 'Each native IPC reader must retain the original Run')
      assert(observation.observedBinding?.bindingId && observation.observedBinding.bindingId === observation.rendererBinding?.bindingId && observation.observedBinding.agentSessionId === observation.rendererBinding.agentSessionId, 'Read and subscription must identify the same original binding and Session')
    }
    const restart = restored.native.toolRestart, original = seed.native.toolBinding?.original
    assert(restart?.passed === true && restart.noCreateOrResume === true && restart.originalTerminalAttached === true &&
      restart.originalSessionId === original?.agentSessionId && restart.originalRunId === original?.run?.runId &&
      restart.bindingId === original?.toolExecution?.bindingId, 'The restored workface must retain the exact native Session, Run and binding without create/resume')
    assert(value.cleanup?.errors?.length === 0 && value.cleanup.remaining?.length === 0 && value.cleanup.report, 'Exact test-owned cleanup evidence is required')
  } else if (id === 'visual-capture-and-restart') {
    assert(value.passed === true && value.captureOnly === true && value.frames?.length > 0 && value.restart?.passed === true, 'Actual captures and separate-process restart are required')
    assert(value.process?.exitCode === 0 && value.restartProcess?.exitCode === 0 && value.ui?.pid !== value.restart.pid, 'Both independent private Electron processes must complete')
  } else throw new Error('Unknown check: ' + id)
}
export function runChild(check) {
  return new Promise((done, reject) => {
    const env = { ...process.env }; delete env.TOOL_EXECUTION_UI_MUTANT
    const child = spawn(check.executable, check.args, { cwd: repository, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && signal === null ? done() : reject(new Error(`${check.id} failed: exit=${code}, signal=${signal}`)))
  })
}
export async function runChecks(checks, reportPath, execute = runChild) {
  assert(checks.length > 0, 'No verification checks selected')
  const report = { checksPassed: false, independentVisualReview: { status: 'pending', reason: 'Capture success does not approve aesthetics. An independent reviewer must open the generated frames.' }, checks: checks.map(check => ({ ...check, status: 'pending' })) }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
  await save()
  for (const check of report.checks) {
    check.status = 'running'; await save()
    try {
      await execute(check)
      validateEvidence(check.id, JSON.parse(await readFile(check.evidence, 'utf8')))
      check.status = 'passed'; await save()
    } catch (error) {
      check.status = 'failed'; check.failure = error instanceof Error ? error.message : String(error)
      await save(); throw error
    }
  }
  report.checksPassed = true; await save()
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const output = options.output ?? resolve(repository, '.tmp/cross-host-execution', `run-${Date.now()}-${process.pid}`)
  const checks = planChecks(output, options.mutations)
  if (options.plan) console.log(JSON.stringify({ mode: 'plan-only', output, checks, independentVisualReview: 'pending; no checks executed' }, null, 2))
  else {
    await mkdir(dirname(output), { recursive: true }); await mkdir(output)
    await runChecks(checks, resolve(output, 'report.json'))
    console.log(JSON.stringify({ checksPassed: true, report: resolve(output, 'report.json'), independentVisualReview: 'pending' }))
  }
}
