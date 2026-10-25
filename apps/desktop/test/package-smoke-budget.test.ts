import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { privatePackageSmokeEnvironment } from '../scripts/package-smoke-context.mjs'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


// Execute the original consumer and its waiting/cleanup helpers. Only the
// clock and filesystem/OS ports are controlled; no second verifier is copied.
const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const names = ['verifyLaunchServices', 'waitForPath', 'waitForProcessExit', 'cleanupProcessScope', 'signalProcessIds']
const functions = names.map(name => {
  const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  if (declarations.length !== 1) throw new Error(`Expected exactly one original ${name}`)
  // Dynamic imports are dependency ports, supplied by the controlled boundaries below.
  return declarations[0]!.getText(ast).replace(/^  const \{ (?:createPrivateRuntimeScope|macosHostService, macosHostServiceRegistration|defaultAgentMuxControlSocketPath) \} = await import\([^\n]+\)\n/gmu, '')
}).join('\n')

type Scenario = {
  readyAt?: number
  ownerAt?: number
  exitAt?: number
  launchMs?: number
  ready?: Record<string, unknown>
  owner?: Record<string, unknown>
  ownerUnknown?: boolean
  cleanupUnknown?: boolean
  runtimeForced?: boolean
  ignoreTerm?: boolean
}

function launch(scenario: Scenario = {}) {
  const app = fixturePath('private/package-budget/AgentMux.app')
  const root = fixturePath('private/package-budget/verification')
  const runtime = fixturePath('private/package-budget/runtime')
  const executable = path.join(app, 'Contents/MacOS/AgentMux')
  const daemonPath = path.join(app, 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd')
  const socketPath = path.join(runtime, 'ctxmux.sock')
  // Main awaits Local SemanticHost connect before publishing ready. Model a
  // permitted 30s pre-ready connection, then owner observation and GUI exit.
  const readyAt = scenario.readyAt ?? 30_000
  const ownerAt = scenario.ownerAt ?? 32_000
  const exitAt = scenario.exitAt ?? 35_000
  let now = _historyFixtureEpoch(0, 0, 0), launched = false, killed = false, ownerObserved = false, output = ''
  const removed: string[] = [], signals: string[] = [], launchTimeouts: number[] = [], stderrReads: string[] = []
  const boundaries = {
    privatePackageSmokeEnvironment,
    defaultAgentMuxControlSocketPath: (env: Record<string, string>) => path.join(env.AGENTMUX_RUNTIME_DIRECTORY!, 'control.sock'),
    macosHostService: (input: unknown) => input, macosHostServiceRegistration: async () => null,
    cleanupSmokeHost: async () => ({ status: 'unregistered' }),
    Date: { now: () => now },
    setTimeout: (resolve: () => void, delay: number) => { now += delay; resolve() },
    join: path.join, sep: path.sep,
    realpath: async (value: string) => value,
    mkdir: async () => {}, writeFile: async () => {},
    process: { env: { ELECTRON_RUN_AS_NODE: '1' }, getuid: () => 501,
      stdout: { write: (value: string) => { output += value } },
      kill: (_pid: number, signal: string) => {
        signals.push(signal)
        if (signal === 'SIGKILL' || !scenario.ignoreTerm) killed = true
      } },
    PRODUCT_NAME: 'AgentMux', manifest: { version: '0.1.0' },
    createPrivateRuntimeScope: async () => ({ directory: runtime, daemonPath, socketPath,
      ownerReceiptPath: async () => path.join(runtime, 'owner-exact-runtime-instance-artifact.json'),
      observeOwner: async () => {
        if (scenario.ownerUnknown) throw new Error('Private Runtime owner is unknown')
        ownerObserved = true
      },
      cleanup: async () => {
        if (scenario.cleanupUnknown) throw new Error('Private Runtime cleanup is unknown')
        return { status: 'exited', exitConfirmed: true, signals: scenario.runtimeForced ? ['SIGKILL'] : [] }
      } }),
    processIdsForApplication: async () => launched && !killed && now < exitAt ? [101] : [],
    scopedProcesses: async () => ({ nodeModes: [] }),
    run: async (command: string, _args: string[], options: { timeoutMs?: number }) => {
      if (command === 'open') {
        launchTimeouts.push(options.timeoutMs!)
        launched = true
        now += scenario.launchMs ?? 0
      }
      return { stdout: '', stderr: '' }
    },
    assert: (condition: unknown, message: string) => { if (!condition) throw new Error(message) },
    pathExists: async (value: string) => value.endsWith('desktop-ready.json')
      ? launched && now >= readyAt
      : value.endsWith('owner-exact-runtime-instance-artifact.json') ? launched && now >= ownerAt : false,
    readFile: async (value: string) => {
      if (value.endsWith('desktop-stderr.log')) { stderrReads.push(value); throw new Error('Full stderr read is forbidden') }
      return JSON.stringify(
      value.endsWith('desktop-ready.json')
        ? { productName: 'AgentMux', version: '0.1.0', packaged: true, executable, ...scenario.ready }
        : { daemonPath, socketPath, ...scenario.owner })
    },
    rm: async (value: string) => { removed.push(value) }
  }
  const invoke = new Function(...Object.keys(boundaries), `${functions}\nreturn verifyLaunchServices`)(...Object.values(boundaries))
  return { result: invoke(app, root) as Promise<void>, facts: () => ({ now, ownerObserved, output, removed, signals, launchTimeouts, stderrReads, runtime }) }
}

async function failure(scenario: Scenario, message: string) {
  const attempt = launch(scenario)
  const error = await attempt.result.then(() => { throw new Error('Unexpected successful candidate') }, error => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors.map((entry: Error) => entry.message).join('\n')).toContain(message)
  expect(attempt.facts().output).toBe('')
  expect(attempt.facts().stderrReads).toEqual([])
  return attempt.facts()
}

it('qualifies the exact ready, Runtime owner and normal exit after a 35-second connection/startup sequence', async () => {
  const attempt = launch()
  await expect(attempt.result).resolves.toBeUndefined()
  expect(attempt.facts()).toMatchObject({ now: _historyFixtureEpoch(0, 35, 0), ownerObserved: true,
    output: 'packaged_desktop_launch=passed\n', signals: [], launchTimeouts: [60_000] })
  expect(attempt.facts().removed).toEqual([attempt.facts().runtime])
})

it('accepts confirmed normal exit at the shared absolute deadline', async () => {
  const attempt = launch({ readyAt: _historyFixtureEpoch(0, 59, 960), ownerAt: _historyFixtureEpoch(0, 59, 980), exitAt: _historyFixtureEpoch(0, 60, 0) })
  await expect(attempt.result).resolves.toBeUndefined()
  expect(attempt.facts().now).toBe(60_000)
})

it.each([
  { name: 'pre-ready connect', readyAt: _historyFixtureEpoch(0, 60, 20), ownerAt: _historyFixtureEpoch(0, 60, 20), exitAt: _historyFixtureEpoch(0, 70, 0), stage: 'ready-receipt' },
  { name: 'cumulative ready and owner', readyAt: _historyFixtureEpoch(0, 35, 0), ownerAt: _historyFixtureEpoch(0, 65, 0), exitAt: _historyFixtureEpoch(0, 70, 0), stage: 'runtime-owner-receipt' },
  { name: 'cumulative ready, owner and exit', readyAt: _historyFixtureEpoch(0, 35, 0), ownerAt: _historyFixtureEpoch(0, 40, 0), exitAt: _historyFixtureEpoch(0, 65, 0), stage: 'application-exit' },
  { name: 'launch consumes the same window', launchMs: 61_000, readyAt: _historyFixtureEpoch(0, 0, 0), ownerAt: _historyFixtureEpoch(0, 0, 0), exitAt: _historyFixtureEpoch(0, 61, 0), stage: 'ready-receipt' }
])('rejects $name after the total budget without restarting a stage clock', async ({ stage, ...scenario }) => {
  const facts = await failure(scenario, `Packaged Desktop ${stage} failed:`)
  expect(facts.now).toBeGreaterThanOrEqual(60_000)
})

it.each([
  { name: 'product', ready: { productName: 'Other' }, message: 'wrong product identity' },
  { name: 'version', ready: { version: 'other' }, message: 'wrong product identity' },
  { name: 'packaged flag', ready: { packaged: false }, message: 'did not start the packaged application' },
  { name: 'executable', ready: { executable: fixturePath('other/AgentMux') }, message: 'exact relocated application' },
  { name: 'Runtime executable', owner: { daemonPath: fixturePath('other/ctxmuxd') }, message: 'exact packaged CtxMux runtime' },
  { name: 'Runtime socket', owner: { socketPath: fixturePath('other/ctxmux.sock') }, message: 'exact packaged CtxMux runtime' },
  { name: 'unknown owner', ownerUnknown: true, message: 'Private Runtime owner is unknown' }
])('rejects the original $name guard within the larger window', async ({ message, ...scenario }) => {
  await failure(scenario, message)
})

it('rejects an application that does not exit and keeps original scoped cleanup', async () => {
  const facts = await failure({ exitAt: Infinity }, 'did not exit normally: 101')
  expect(facts.signals).toEqual(['SIGTERM'])
})

it('retains the original Runtime profile when cleanup is unknown', async () => {
  const facts = await failure({ cleanupUnknown: true }, 'Private Runtime cleanup is unknown')
  expect(facts.removed).toEqual([])
})

it.each([
  { name: 'application scope', exitAt: Infinity, ignoreTerm: true, message: 'cleanup required SIGKILL' },
  { name: 'Runtime scope', runtimeForced: true, message: 'Runtime required forced termination' }
])('does not pass a candidate requiring forced termination of its $name', async ({ message, ...scenario }) => {
  const facts = await failure(scenario, message)
  expect(facts.removed).toEqual([])
})
