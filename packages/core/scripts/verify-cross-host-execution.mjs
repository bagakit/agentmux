import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile, chmod, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mutations, tests } from './fixtures/cross-host-execution-checks.mjs'

const repository = resolve(import.meta.dirname, '../../..')
async function buildEnvironment(output) {
  // Use the maintained build (including the pinned SDK bundle and native helper),
  // but resolve its two pnpm exec tools locally without invoking an installer.
  const bin = resolve(output, 'build-tools'); await mkdir(bin)
  const script = resolve(bin, 'tools.mjs')
  await writeFile(script, `import {execFileSync} from 'node:child_process';\nconst [action,tool,...args]=process.argv.slice(2);\nconst commands=${JSON.stringify({ tsc: resolve(repository, 'packages/core/node_modules/typescript/bin/tsc'), esbuild: resolve(repository, 'packages/core/node_modules/esbuild/bin/esbuild') })};\nif(action!=='exec'||!Object.hasOwn(commands,tool))throw new Error('Unqualified build tool request');\nexecFileSync(process.execPath,[commands[tool],...args],{stdio:'inherit'});\n`)
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const shim = resolve(bin, 'pnpm')
  await writeFile(shim, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n')
  await chmod(shim, 0o700)
  return { PATH: bin + delimiter + (process.env.PATH ?? '') }
}
async function manifest(paths) {
  const values = {}
  const visit = async path => {
    try {
      const entries = await readdir(resolve(repository, path), { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) await visit(path + '/' + entry.name)
    } catch (error) {
      if (error.code !== 'ENOTDIR') throw error
      values[path] = createHash('sha256').update(await readFile(resolve(repository, path))).digest('hex')
    }
  }
  for (const path of paths) await visit(path)
  return values
}
export function parseArgs(args) {
  const options = { mutations: false, plan: false, output: undefined }, seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    assert(['--mutations', '--plan', '--output'].includes(flag) && !seen.has(flag), 'Unknown or repeated flag: ' + flag)
    seen.add(flag)
    if (flag === '--output') {
      const value = args[++index]; assert(value && !value.startsWith('--'), '--output requires a fresh directory')
      options.output = resolve(value)
    } else options[flag.slice(2)] = true
  }
  return options
}
export function validateTests(report, mutant = false) {
  assert(report.numTotalTests > 0 && report.testResults?.length > 0, 'Empty test evidence')
  const assertions = report.testResults.flatMap(result => result.assertionResults ?? [])
  assert(assertions.length > 0, 'No assertions executed')
  if (mutant) {
    assert(report.success === false && report.numFailedTests > 0 && assertions.some(result =>
      result.status === 'failed' && result.failureMessages?.some(message => message.includes('AssertionError') ||
        message.startsWith('Error: promise resolved ') && message.includes('instead of rejecting') && message.includes('_Assertion.__VITEST_REJECTS__'))),
    'A loaded mutant must reach a failing assertion, not merely crash or fail to collect')
  } else assert(report.success === true && report.numPassedTests === report.numTotalTests &&
    assertions.every(result => result.status === 'passed'), 'Every selected test must pass without skips')
}
function run(args, env = {}) {
  return new Promise((done, reject) => {
    const childEnv = { ...process.env }; delete childEnv.CROSS_HOST_EXECUTION_MUTATION; delete childEnv.CROSS_HOST_EXECUTION_MUTATION_HIT
    for (const key of ['AGENTMUX_TEST_CLIENT_ENTRY', 'AGENTMUX_TEST_RPC_CLIENT_ENTRY', 'AGENTMUX_TEST_SERVICE_ENTRY', 'AGENTMUX_TEST_OWNER_ENTRY']) delete childEnv[key]
    const child = spawn(process.execPath, args, { cwd: repository, env: { ...childEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, stdout, stderr }))
  })
}
function machineResult(stdout) {
  const results = stdout.split('\n').flatMap(line => { try { const result = JSON.parse(line); return result && typeof result === 'object' ? [result] : [] } catch { return [] } })
  assert.equal(results.length, 1, 'Native proof must emit one structured result')
  return results[0]
}
export function validateNative(name, result) {
  if (name === 'verify-native-execution-helpers') {
    assert(result.actualMachines === 1 && result.fileOnResource === true && result.commandOnResource === true &&
      result.originalSocketAfterReaderDetach === true && result.exactBindingRetained === true &&
      result.publicOperationInspection?.sdkRpcCliAgree === true && result.publicOperationInspection.typedIdPreserved === true,
    'Actual native helper and original-operation inspection evidence required')
  } else assert(result.passed === true && (result.evidence || result.root || result.summary) &&
    Array.isArray(result.errors) && result.errors.length === 0, 'Actual native proof result and private evidence required')
}
export function validateSummary(name, summary) {
  assert(summary.actualMachines === 1 && summary.originalCoreSession && summary.nativeConversationId &&
    summary.firstRun?.runId && summary.resumedRun && summary.firstRun.runId !== summary.resumedRun &&
    summary.helperRuns?.length === 2 && new Set(summary.helperRuns).size === 2 &&
    summary.originalContextRetained === true && summary.originalEffectCount === 1 &&
    Array.isArray(summary.errors) && summary.errors.length === 0, 'Original Session, native context, helpers and once-only effect must be proved')
  if (name === 'verify-native-agent-control') {
    const control = summary.agentControl, restart = summary.ownerRestartEvidence
    assert(control?.originalWhoami === summary.originalCoreSession && control.resumedWhoami === summary.originalCoreSession &&
      control.callerlessRejected === true && control.userOnlyRejected === true && control.ownerChangedRouteUnavailable === true &&
      control.nativeToolsRetained === true && restart?.previousOwner && restart.currentOwner &&
      restart.previousOwner !== restart.currentOwner && restart.runId === summary.resumedRun && restart.nativeInstanceId,
    'The real relay must preserve the original caller and native work across an actual semantic-owner change')
  } else assert(summary.resourceCoreRestarted === true && summary.automaticReadersRestored === true &&
    summary.originalHelperPidsRetained === true && summary.bindingAfterResume?.state === 'connected', 'Actual resource Core restart and original readers required')
}
export async function main(args) {
  const options = parseArgs(args), output = options.output ?? resolve(repository, '.tmp/cross-host-execution-core', `run-${Date.now()}-${process.pid}`)
  const native = ['verify-native-execution-helpers', 'verify-execution-binding', 'verify-native-agent-control']
  const mutationGates = [
    { id: 'relay', script: 'packages/core/scripts/verify-agent-control-mutants.mjs', names: [
      'caller-elevation', 'batch-members', 'invocation-conflict', 'fixed-credential', 'owner-fence',
      'generation-qualification', 'frontend-duplicate-id', 'resource-duplicate-id', 'uncertain-write', 'closed-connection'] },
    { id: 'input', script: 'packages/core/scripts/verify-execution-input-mutants.mjs', names: [
      'wire-numeric-budget', 'source-cursor-midframe', 'unknown-chunk-new-id', 'ignore-confirmed-offset',
      'repartition-old-claim', 'skip-durable-claim'] },
  ]
  const buildArgs = ['packages/core/scripts/build.mjs']
  if (options.plan) return console.log(JSON.stringify({ mode: 'plan-only', buildArgs, tests, mutations: options.mutations ? mutations.map(value => value.id) : [], mutationGates: options.mutations ? mutationGates : [], native, output, actualMachines: 1 }))
  await mkdir(dirname(output), { recursive: true }); await mkdir(output)
  const report = { passed: false, scope: 'Local Core/CLI/native qualification; no real two-machine or UI acceptance', tests: [], mutations: [], native: [] }
  const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  await save()
  try {
    for (const file of tests) await readFile(resolve(repository, file))
    for (const name of native) await readFile(resolve(repository, `packages/core/scripts/${name}.mjs`))
    if (options.mutations) for (const gate of mutationGates) await readFile(resolve(repository, gate.script))
    const sourcePaths = ['packages/core/src', 'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs',
      'packages/core/scripts/generate-guides.mjs', 'packages/core/scripts/check-guides.mjs', 'packages/core/native',
      'packages/core/guides',
      'packages/core/tsconfig.build.json', 'packages/core/tsconfig.json', 'tsconfig.base.json',
      'packages/core/package.json', 'pnpm-lock.yaml']
    const source = await manifest(sourcePaths), built = await run(buildArgs, await buildEnvironment(output))
    await writeFile(resolve(output, 'build.log'), built.stdout + built.stderr)
    assert(built.code === 0 && built.signal === null, 'Exact Core candidate build failed')
    assert.deepEqual(await manifest(sourcePaths), source, 'Core source changed during compilation; candidate is unconfirmed')
    const dependencyPaths = []
    const dependencies = JSON.parse(await readFile(resolve(repository, 'packages/core/package.json'), 'utf8')).dependencies
    for (const [name, version] of Object.entries(dependencies).filter(([, version]) => version.startsWith('workspace:'))) {
      assert(name.startsWith('@agentmux/'), 'Unqualified workspace dependency location')
      const directory = 'packages/' + name.slice('@agentmux/'.length)
      assert.equal(await realpath(resolve(repository, 'packages/core/node_modules', name)), await realpath(resolve(repository, directory)), 'Workspace consumer resolves outside this candidate: ' + name)
      dependencyPaths.push(directory + '/package.json', directory + '/dist')
    }
    const consumedPaths = [...sourcePaths, ...dependencyPaths, 'packages/core/dist', 'packages/core/bin',
      `packages/core/vendor/ctxmux/${process.platform}-${process.arch}`, 'packages/core/test/helpers',
      'packages/core/scripts/fixtures/cross-host-execution-checks.mjs', 'packages/core/scripts/fixtures/vitest.cross-host-execution.config.mts',
      'packages/core/scripts/fixtures/execution-proof-cleanup.mjs',
      'packages/core/scripts/verify-cross-host-execution.mjs', ...(options.mutations ? mutationGates.map(gate => gate.script) : []),
      ...native.map(name => `packages/core/scripts/${name}.mjs`), ...tests]
    const consumed = await manifest(consumedPaths)
    await writeFile(resolve(output, 'candidate.json'), JSON.stringify({ source, consumed, buildArgs, exitCode: built.code,
      node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch }, null, 2))
    report.candidate = resolve(output, 'candidate.json'); await save()
    const testArgs = ['packages/core/node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/scripts/fixtures/vitest.cross-host-execution.config.mts', '--reporter=json']
    const baseline = resolve(output, 'baseline.json')
    const result = await run([...testArgs, '--outputFile=' + baseline])
    await writeFile(resolve(output, 'baseline.log'), result.stdout + result.stderr)
    assert(result.code === 0 && result.signal === null, 'Baseline failed; see baseline.log')
    const baselineReport = JSON.parse(await readFile(baseline, 'utf8')); validateTests(baselineReport)
    for (const file of tests) assert(baselineReport.testResults.some(value => value.name === resolve(repository, file)), 'Selected consumer was not executed: ' + file)
    report.tests = { count: baselineReport.numPassedTests, evidence: baseline }; await save()
    if (options.mutations) for (const mutation of mutations) {
      const json = resolve(output, mutation.id + '.json'), hit = resolve(output, mutation.id + '.hit')
      const result = await run([...testArgs, '--outputFile=' + json], { CROSS_HOST_EXECUTION_MUTATION: mutation.id, CROSS_HOST_EXECUTION_MUTATION_HIT: hit })
      await writeFile(resolve(output, mutation.id + '.log'), result.stdout + result.stderr)
      assert(Number.isInteger(result.code) && result.code !== 0 && result.signal === null, 'Mutant survived or process was interrupted: ' + mutation.id)
      const hits = (await readFile(hit, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert(hits.length > 0 && hits.every(value => value.mutation === mutation.id && value.file.endsWith('/packages/core/src/' + mutation.file)), 'Wrong mutation consumer')
      validateTests(JSON.parse(await readFile(json, 'utf8')), true)
      report.mutations.push({ id: mutation.id, killed: true, evidence: json, hits: hit }); await save()
    }
    if (options.mutations) for (const gate of mutationGates) {
      const directory = resolve(output, gate.id + '-mutants')
      const result = await run([gate.script, directory])
      await writeFile(resolve(output, gate.id + '-mutants.log'), result.stdout + result.stderr)
      assert(result.code === 0 && result.signal === null, gate.id + ' mutation gate failed')
      const receipt = machineResult(result.stdout)
      const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'))
      assert(receipt.passed === true && summary.passed === true && summary.complete === true &&
        summary.errors?.length === 0 && summary.mutations?.length === gate.names.length &&
        new Set(summary.mutations.map(value => value.mutation)).size === gate.names.length &&
        summary.mutations.every(value => value.killed === true && Number.isInteger(value.exitCode) && value.exitCode !== 0 &&
          value.closed === true && value.signal === null && value.totalTests > 0 && value.failedTests > 0),
      gate.id + ' mutations must reach real assertions')
      assert.deepEqual(summary.mutations.map(value => value.mutation).sort(), [...gate.names].sort(), 'Exact mutation coverage required')
      report[gate.id + 'Mutations'] = receipt; await save()
    }
    for (const name of native) {
      const result = await run([`packages/core/scripts/${name}.mjs`])
      await writeFile(resolve(output, name + '.log'), result.stdout + result.stderr)
      assert(result.code === 0 && result.signal === null, name + ' failed; original private evidence retained')
      const receipt = machineResult(result.stdout); validateNative(name, receipt)
      const root = receipt.root ?? receipt.evidence
      assert(typeof root === 'string', 'The native proof must identify its exact private root')
      if (name !== 'verify-native-execution-helpers') validateSummary(name, JSON.parse(await readFile(resolve(root, 'summary.json'), 'utf8')))
      const cleanup = JSON.parse(await readFile(resolve(root, 'cleanup.json'), 'utf8'))
      assert(cleanup.passed === true && Array.isArray(cleanup.errors) && cleanup.errors.length === 0 && cleanup.records?.length > 0,
        'All test-owned cleanup must be confirmed after native verification')
      report.native.push({ name, receipt, cleanup: resolve(root, 'cleanup.json') }); await save()
    }
    const after = await manifest(consumedPaths)
    await writeFile(resolve(output, 'candidate-after.json'), JSON.stringify(after, null, 2))
    assert.deepEqual(after, consumed, 'Consumed Core candidate changed during verification; evidence is unconfirmed')
    report.passed = true; await save(); console.log(JSON.stringify({ passed: true, evidence: resolve(output, 'report.json'), actualMachines: 1 }))
  } catch (error) { report.failure = String(error); await save(); throw error }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
