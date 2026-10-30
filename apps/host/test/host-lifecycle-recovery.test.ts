import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'

const ports = vi.hoisted(() => ({ client: null as any, runtime: null as any, ssh: null as any }))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, connectSshAgentMux: (...args: Parameters<typeof actual.connectSshAgentMux>) => ports.ssh ? Promise.resolve(ports.ssh) : actual.connectSshAgentMux(...args), startHeadlessAgentMux: async (options: Parameters<typeof actual.startHeadlessAgentMux>[0]) => {
    // Only Native I/O is controlled by rpcOwnerFixture. The source Host, device
    // file, public dispatcher/parser/Unix transport and Core input journal are real.
    const server = new actual.AgentMuxControlServer({ ...options?.service, socketPath: options?.socketPath,
      coreClients: () => [{ hostId: 'local', client: ports.client }] })
    await server.start()
    return ports.runtime = { client: ports.client, hosted: {}, server, stop: vi.fn(() => server.stop()) }
  } }
})
import * as core from '@agentmux/core'
import { DeviceAuthority } from '../src/device-authority.js'
import { startAgentMuxHost } from '../src/host.js'
import { configuredHostClients } from '../src/configured-host-clients.js'
const cleanups: Array<() => void | Promise<void>> = []
function fact(value: object) { if (process.env.HOST_LIFECYCLE_FACTS) appendFileSync(process.env.HOST_LIFECYCLE_FACTS, JSON.stringify(value) + '\n') }
afterEach(async context => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); ports.client = null; ports.runtime = null; ports.ssh = null
  fact({ case: context.task.name, cleanup: errors.length ? 'unknown' : 'confirmed', errors: errors.map(error => String(error)) })
  if (errors.length) throw new AggregateError(errors, 'Private Host lifecycle fixture cleanup failed')
})
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }))
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const root = resolve(import.meta.dirname, '../../..'), loader = join(import.meta.dirname, 'host-lifecycle-recovery-node-loader.mjs')
function sourceChildren() {
  vi.stubEnv('NODE_OPTIONS', ['--experimental-transform-types', '--import', JSON.stringify(loader)].join(' '))
}
async function hostFixture() {
  sourceChildren()
  const h = await rpcOwnerFixture(['caller'], { AgentMuxClient: core.AgentMuxClient, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore })
  cleanups.push(h.close); ports.client = h.client
  const path = join(h.root, 'agentmux-devices.json'), original = await DeviceAuthority.open(path)
  const device = await original.authorizeKey('A'.repeat(43) + '='); await original.flush()
  const bytes = await readFile(path, 'utf8'), assets = join(h.root, 'mobile'); await mkdir(assets)
  const html = '<!doctype html><title>Original private mobile</title>', hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
  await writeFile(join(assets, 'index.html'), html)
  const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId: 'original-host-recovery', files: [{ path: 'index.html', bytes: Buffer.byteLength(html), digest: hash(html) }] }
  await writeFile(join(assets, 'mobile-release.json'), JSON.stringify({ ...manifest, digest: hash(JSON.stringify(manifest)) }))
  const failed = Object.assign(new Error('Original device file observation failed'), { code: 'EACCES' })
  const open = vi.spyOn(DeviceAuthority, 'open').mockRejectedValueOnce(failed)
  const host = await startAgentMuxHost({ store: h.store, socketPath: join(h.root, 'control.sock'), mobilePort: 0, mobileBuildDirectory: assets })
  const runtime = ports.runtime, stopOriginal = runtime.server.stop.bind(runtime.server)
  let expectedDisposalFailure: unknown
  cleanups.push(async () => { try { await host.dispose() } catch (error) { if (error !== expectedDisposalFailure) throw error; await stopOriginal() } })
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const input = async (operationId: string) => {
    const receipt = await rpc.call('agent.input.submit', { agentSessionId: 'caller', expectedRun: { runId: 'run-caller' },
      operationId, prompt: operationId, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    await Reflect.get(h.client, 'inputWaitingRecipients').get('caller')?.pending
    expect((await rpc.call('agent.input.inspect', { key: receipt.key })).input).toMatchObject({ status: 'terminal-confirmed', persistence: 'confirmed' })
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    return receipt.key
  }
  return { h, host, path, original, device, bytes, open, rpc, runtime, input, expectDisposalFailure: (error: unknown) => { expectedDisposalFailure = error } }
}

it('Host lifecycle restores the original device authority and public link without replacing healthy input', async () => {
  const f = await hostFixture()
  expect(f.open).toHaveBeenCalledOnce(); expect(f.host.mobileAccessState().state).toBe('unavailable')
  const before = await f.input('before-authority-recovery')
  const listed = Promise.all([f.rpc.call('device.ls', {}), f.rpc.call('device.ls', {})])
  await expect(listed).resolves.toMatchObject([{ hostId: f.original.hostId }, { hostId: f.original.hostId }])
  const [first, second] = await listed
  expect(first.hostId).toBe(f.original.hostId); expect(second).toEqual(first)
  expect(first.devices).toMatchObject([{ deviceId: f.device.deviceId }]); expect(f.open).toHaveBeenCalledTimes(2)
  expect(f.open.mock.calls[1]?.[2]).toEqual({ createIfMissing: false })
  expect(await readFile(f.path, 'utf8')).toBe(f.bytes)
  let link: core.AgentMuxRpcResult<'device.link'> | undefined
  await vi.waitFor(async () => { link = await f.rpc.call('device.link', {}); expect(link.hostId).toBe(f.original.hostId) }, { timeout: 10_000, interval: 100 })
  expect(link!.relay.useTls).toBe(false)
  expect((await f.host.deviceAuthority()).hostId).toBe(f.original.hostId)
  const after = await f.input('after-authority-recovery')
  fact({ phase: 'authority-recovered', hostId: first.hostId, deviceId: f.device.deviceId, originalBytesRetained: true, before, after, openAttempts: f.open.mock.calls.length, stopCalls: 0 })
})

it('Host lifecycle never mints an identity when the failed original file is absent', async () => {
  const f = await hostFixture(); await rm(f.path)
  const originalFailure = await settle(f.host.deviceAuthority())
  expect(originalFailure).toMatchObject({ error: { code: 'ENOENT' } })
  await expect(readFile(f.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.rpc.call('device.ls', {})).rejects.toBeDefined()
  await expect(readFile(f.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const input = await f.input('identity-missing-healthy-input')
  await writeFile(f.path, f.bytes)
  expect((await f.rpc.call('device.ls', {})).hostId).toBe(f.original.hostId)
  fact({ phase: 'authority-missing-original-retained', noMint: true, originalHostId: f.original.hostId, recoveredFromOriginalBytes: true, input })
})

it('Host lifecycle repeats the same disposal outcome without replaying resource effects', async () => {
  const f = await hostFixture(), failure = new Error('Original resource close is unconfirmed'), release = deferred()
  f.runtime.stop.mockImplementationOnce(async () => { await release.promise; throw failure }); f.expectDisposalFailure(failure)
  const first = f.host.dispose(), firstResult = settle(first), second = f.host.dispose(), secondResult = settle(second)
  expect(second).toBe(first)
  release.resolve()
  await expect(firstResult).resolves.toEqual({ error: failure }); await expect(secondResult).resolves.toEqual({ error: failure })
  await expect(settle(f.host.dispose())).resolves.toEqual({ error: failure }); expect(f.runtime.stop).toHaveBeenCalledOnce()
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  fact({ phase: 'original-dispose-result', samePromise: true, originalFailure: failure.message, closeAttempts: 1, runStopCalls: 0 })
})

it('Host lifecycle repairs only the failed original SSH route and cancels a stale candidate', async () => {
  sourceChildren(); vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', join(import.meta.dirname, 'fixtures/host-lifecycle-runtime.mjs'))
  const f = await headlessFixture(); cleanups.push(() => f.cleanup())
  const seed = await f.client(), run = await seed.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], workspacePath: f.root, createOperationId: 'original-route-terminal' })
  cleanups.push(() => seed.stopTerminal({ runId: run.runId }))
  const bin = join(f.root, 'bin'); await mkdir(bin); await symlink(join(import.meta.dirname, 'fixtures/host-lifecycle-ssh.mjs'), join(bin, 'ssh'))
  const ready = join(bin, 'route-ready'), trace = join(bin, 'ssh.ndjson'), configPath = join(f.root, 'app-config.json')
  vi.stubEnv('PATH', bin + ':' + process.env.PATH); vi.stubEnv('AGENTMUX_FAKE_SSH_HOME', f.root)
  vi.stubEnv('HOST_LIFECYCLE_ROUTE_READY', ready); vi.stubEnv('HOST_CONFIG_SSH_TRACE', trace)
  const command = join(bin, 'amux'), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(command, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(root, 'packages/core/src/agentmux.ts')) + ' "$@"\n', { mode: 0o700 })
  const local = { id: 'local', kind: 'local', label: 'Local' }, remote = (hostname: string, runtimeId = f.owner.runtimeId) => ({ id: 'remote', kind: 'ssh', label: 'Original route', hostname, remoteCommand: command, remoteSocketPath: f.socketPath, runtimeId })
  const save = async (host?: ReturnType<typeof remote>) => { await writeFile(configPath + '.next', JSON.stringify({ hosts: [local, ...(host ? [host] : [])] })); await rename(configPath + '.next', configPath) }
  const observations = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } }
  await save(remote('route-a'))
  const owner = configuredHostClients(configPath)
  cleanups.push(async () => {
    await owner.close()
    const pids = [...new Set((await observations()).flatMap(row => typeof row.pid === 'number' ? [row.pid] : []))]
    expect(pids.length).toBeGreaterThan(0)
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow() }, { timeout: 5000, interval: 25 })
    fact({ phase: 'original-ssh-process-cleanup', pids, exitConfirmed: true })
  })
  owner.start()
  await until(() => owner.clients(), values => values.length === 1, 'original configured SSH lease')
  const client = owner.clients()[0]!.client; await client.connect()
  const retained = async () => expect((await client.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ pid: run.pid, state: 'running' })
  await retained(); const disconnect = vi.spyOn(client, 'dispose')
  const attempts = vi.spyOn(client, 'prepareRoute')
  await save(remote('route-b'))
  await until(observations, rows => rows.some(row => row.phase === 'refused-private-route'), 'one exact failed route confirmation')
  await retained(); expect(disconnect).not.toHaveBeenCalled()
  await writeFile(ready, 'ready')
  await vi.waitFor(async () => {
    const rows = await observations()
    expect(rows.some(row => row.destination === 'route-b' && row.response?.result?.owner?.runtimeId === f.owner.runtimeId)).toBe(true)
  }, { timeout: 12_000, interval: 50 })
  await retained(); expect(owner.clients()[0]!.client).toBe(client)
  const healthyAttempts = attempts.mock.calls.length; await delay(1200); expect(attempts.mock.calls.length).toBe(healthyAttempts)
  attempts.mockRestore()
  const prepareOriginal = client.prepareRoute.bind(client), candidateReady = deferred(), releaseCandidate = deferred()
  let activate: ReturnType<typeof vi.spyOn> | undefined
  vi.spyOn(client, 'prepareRoute').mockImplementationOnce(async (...args) => { const value = await prepareOriginal(...args); activate = vi.spyOn(value, 'activate'); candidateReady.resolve(); await releaseCandidate.promise; return value })
  await save(remote('route-c')); await candidateReady.promise
  await save(); await until(() => owner.clients(), values => values.length === 0, 'revoked exact configuration')
  const closing = owner.close(); releaseCandidate.resolve(); await closing
  expect(activate).not.toHaveBeenCalled(); expect((await seed.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ pid: run.pid, state: 'running' })
  fact({ phase: 'original-route-converged', sameRuntimeId: f.owner.runtimeId, originalRun: run.runId, sameClient: true, oldHealthyRouteRetainedDuringFailure: true, staleActivations: activate!.mock.calls.length, ssh: await observations() })
})

// Timer policy is isolated from SSH I/O here. The preceding case proves the
// same owner against the original SDK, system-SSH leaf and real Core RPC.
it('Host lifecycle backs off only failed route observation and rechecks changed configuration immediately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hlr-backoff-')); cleanups.push(() => rm(directory, { recursive: true }))
  const path = join(directory, 'config.json'), runtimeId = 'original-runtime'
  const local = { id: 'local', kind: 'local', label: 'Local' }, remote = (hostname: string, id = runtimeId) => ({ id: 'remote', kind: 'ssh', label: 'Original', hostname, runtimeId: id })
  const save = async (target: ReturnType<typeof remote>) => { await writeFile(path + '.next', JSON.stringify({ hosts: [local, target] })); await rename(path + '.next', path) }
  const client = { prepareRoute: vi.fn(async () => { throw new Error('Original candidate route unavailable') }), setRemoteCommand: vi.fn(), dispose: vi.fn(async () => {}) }
  ports.ssh = client; await save(remote('route-a'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const originalTimeout = globalThis.setTimeout, delays: number[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
    if (milliseconds !== undefined && milliseconds >= 1000) delays.push(milliseconds)
    return originalTimeout(callback, milliseconds, ...args)
  }) as typeof setTimeout)
  const owner = configuredHostClients(path); cleanups.push(() => owner.close()); owner.start()
  await vi.waitFor(() => expect(owner.clients()).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(10_000); expect(client.prepareRoute).not.toHaveBeenCalled(); expect(delays).toEqual([])
  await save(remote('route-b')); await vi.waitFor(() => expect(client.prepareRoute).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(0)
  for (const milliseconds of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    expect(delays.at(-1)).toBe(milliseconds)
    const before = client.prepareRoute.mock.calls.length
    await vi.advanceTimersByTimeAsync(milliseconds)
    await vi.waitFor(() => expect(client.prepareRoute).toHaveBeenCalledTimes(before + 1)); await vi.advanceTimersByTimeAsync(0)
  }
  const attempts = client.prepareRoute.mock.calls.length
  await save(remote('foreign-route', 'another-runtime')); await delay(30)
  expect(client.prepareRoute).toHaveBeenCalledTimes(attempts); expect(owner.clients()[0]!.client).toBe(client)
  await save(remote('route-c')); await vi.waitFor(() => expect(client.prepareRoute).toHaveBeenCalledTimes(attempts + 1)); await vi.advanceTimersByTimeAsync(0)
  expect(delays.at(-1)).toBe(1000)
  await owner.close(); const stopped = client.prepareRoute.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000); expect(client.prepareRoute).toHaveBeenCalledTimes(stopped)
  expect(client.dispose).toHaveBeenCalledOnce()
  fact({ phase: 'failed-route-backoff-policy', delays, foreignRuntimeActivations: 0, healthyRoutePolls: 0, closedOwnerAdditionalAttempts: 0 })
})
