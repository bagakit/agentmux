import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { fork, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function owner(originalRoot?: string, ownerMode: 'create' | 'restore' = 'create', nativeProcessId?: number) {
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('The public product test requires the exact compiled gate candidate.')
  const root = originalRoot ?? await mkdtemp(join(tmpdir(), 'amx-information-public-'))
  if (!originalRoot) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = objectCliEnvironment(root, { HOME: root, USERPROFILE: root,
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href,
    AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux') })
  const worker = fork(resolve(import.meta.dirname, 'fixtures/agent-information-owner.mjs'), [root, ownerMode,
    ...(nativeProcessId === undefined ? [] : [String(nativeProcessId)])], {
    env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''; worker.stderr!.setEncoding('utf8'); worker.stderr!.on('data', chunk => { stderr += chunk })
  const exited = new Promise<number | null>(done => worker.once('exit', done))
  const stop = async () => {
    if (worker.exitCode !== null || worker.signalCode !== null) return
    worker.send({ type: 'close' }); const timeout = setTimeout(() => worker.kill('SIGKILL'), 3000)
    try { expect(await exited, stderr).toBe(0) } finally { clearTimeout(timeout) }
  }
  cleanup.push(stop)
  const message = () => new Promise<any>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('The isolated compiled information owner did not reply: ' + stderr)), 10000)
    worker.once('message', value => { clearTimeout(timeout); done(value) })
    worker.once('error', error => { clearTimeout(timeout); reject(error) })
    worker.once('exit', code => { clearTimeout(timeout); reject(new Error('Owner exited ' + code + ': ' + stderr)) })
  })
  const ready = await message(); expect(ready.type, stderr).toBe('ready'); expect(ready.pid).toBe(worker.pid)
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + ready.endpoint, ...args], env,
      input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const mode = async (value: string) => { const pending = message(); worker.send({ type: 'native-mode', mode: value }); await pending }
  const stats = async () => { const pending = message(); worker.send({ type: 'stats' }); return await pending }
  return { root, cli, mode, stats, stop, pid: worker.pid }
}

it('the compiled information CLI reads the actual Core owner and its agent.inspect projection', async () => {
  const f = await owner()
  const information = await f.cli(['agent', 'information', 'inspect', '--host', 'local', '--session', 'information-original', '--run', 'information-run-original'])
  expect(information).toMatchObject({ kind: 'information', snapshot: { nativeSessionId: 'information-native-original',
    sourceId: 'native-source-original', observedAt: fixtureEpoch(2, 0, 123), plan: { id: 'team', name: 'Team' },
    model: { id: 'model-small' }, limits: [{ usedPercent: 25 }] }, configuration: { options: [{ category: 'model' }] } })
  const inspected = await f.cli(['agent', 'inspect', '--session', 'information-original'])
  expect(inspected.status.session.nativeInformation).toEqual(information.snapshot)
  expect(inspected.status.session.nativeConfiguration).toEqual(information.configuration)
  await f.mode('unavailable')
  const unavailable = await f.cli(['agent', 'information', 'inspect', '--host', 'local', '--session', 'information-original', '--run', 'information-run-original'])
  expect(unavailable.snapshot).toEqual(information.snapshot)
  expect(unavailable.issue).toBeDefined()
  const stats = await f.stats(); expect(stats.reads).toBe(2); expect(stats.runtimeWrites).toBe(0)
})

it('the compiled configuration CLI changes the original model once and inspects the retained native ACK', async () => {
  const f = await owner()
  const initial = await f.cli(['agent', 'information', 'inspect', '--host', 'local', '--session', 'information-original', '--run', 'information-run-original'])
  const input = { target: initial.target, operationId: 'cli-model-original', configId: 'model', value: 'model-large',
    expectedRevision: initial.configuration.revision }
  const receipt = await f.cli(['agent', 'configuration', 'set', '--input', '-'], input)
  expect(receipt).toMatchObject({ outcome: 'applied', operationId: input.operationId, target: initial.target,
    acknowledgement: { options: [{ currentValue: 'model-large' }] }, diskDurability: 'confirmed' })
  expect(await f.cli(['agent', 'configuration', 'set', '--input', '-'], input)).toEqual(receipt)
  const retained = await f.cli(['agent', 'configuration', 'inspect', '--host', 'local', '--session', 'information-original', '--operation-id', input.operationId])
  expect(retained).toMatchObject({ kind: 'operation', operation: receipt })
  const stats = await f.stats(); expect(stats.writes).toHaveLength(1); expect(stats.runtimeWrites).toBe(0)
})

it('a new Core owner reads the same original information and clock from FileStore without rereading or reseeding', async () => {
  // The isolated original Agent process remains alive while the two real Core owners exit/start.
  const native = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    { env: { PATH: process.env.PATH, NODE_OPTIONS: '' }, stdio: 'ignore' })
  const nativeExited = new Promise(done => native.once('exit', done))
  cleanup.push(async () => {
    if (native.exitCode !== null || native.signalCode !== null) return
    native.kill('SIGTERM'); const timeout = setTimeout(() => native.kill('SIGKILL'), 3000)
    try { await nativeExited } finally { clearTimeout(timeout) }
  })
  expect(native.pid).toBeGreaterThan(0)
  const first = await owner(undefined, 'create', native.pid)
  const information = await first.cli(['agent', 'information', 'inspect', '--host', 'local', '--session', 'information-original', '--run', 'information-run-original'])
  expect(information.snapshot).toMatchObject({ nativeSessionId: 'information-native-original', observedAt: fixtureEpoch(2, 0, 123) })
  await first.stop()
  expect(native.exitCode).toBeNull(); expect(native.signalCode).toBeNull()
  const restored = await owner(first.root, 'restore', native.pid)
  expect(restored.pid).not.toBe(first.pid)
  const inspected = await restored.cli(['agent', 'inspect', '--session', 'information-original'])
  expect(inspected.status.session).toMatchObject({ agentSessionId: 'information-original', run: { runId: 'information-run-original' },
    nativeHandle: { kind: 'provider', sessionId: 'information-native-original' }, nativeInformation: information.snapshot })
  const stats = await restored.stats(); expect(stats.reads).toBe(0); expect(stats.runtimeWrites).toBe(0)
})
