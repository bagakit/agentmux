import { createConnection, createServer, type Socket } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HostTailcatListener, configuredTailcatListener } from '../src/tailcat-listener.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { parseTailcatListenerObservation } from '../../../packages/core/src/host-runtime-observation.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const root = resolve(import.meta.dirname, '../../..'), command = { executable: process.execPath, args: [resolve(import.meta.dirname, '../../../packages/core/dist/agentmux.js')] }, cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Tailcat fixture cleanup failed')
})
const key = (n: string) => 'nodekey:' + n.repeat(64)
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'atc-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin'); await mkdir(bin)
  const cli = join(bin, 'tailcat')
  await writeFile(cli, '#!' + process.execPath + '\n' + await readFile(join(root, 'apps/host/test/fixtures/tailcat-cli.mjs'), 'utf8').then(value => value.split('\n').slice(1).join('\n')))
  await chmod(cli, 0o700)
  const keyFile = join(directory, 'server.private.json')
  const keyValue = { Private: 'privkey:' + '1'.repeat(64), Public: { PresharedKey: 'psk:' + '2'.repeat(64), RegionID: 7 } }
  await writeFile(keyFile, JSON.stringify(keyValue), { mode: 0o600 })
  const trace = join(directory, 'trace.jsonl'), port = join(directory, 'port'), socketPath = join(directory, 'core.sock')
  const environment = { ...process.env, PATH: bin, TAILCAT_FIXTURE_TRACE: trace, TAILCAT_FIXTURE_PORT: port,
    TAILCAT_ADDR_FILE: join(directory, 'must-not-publish'), AGENTMUX_AGENT_SESSION_ID: 'must-not-inherit', AGENTMUX_AGENT_CAPABILITY: 'must-not-inherit' }
  const configuration = { enabled: true, keyFile, allowedClients: [key('3')] }
  const listener = new HostTailcatListener({ socketPath, environment, command }); cleanups.push(() => listener.close())
  const traces = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) } catch { return [] } }
  return { directory, listener, environment, socketPath, configuration, keyFile, keyValue, traces, port }
}

it('does not start Tailcat while disabled and retains the saved identity and allowlist', async () => {
  const f = await fixture(), disabled = { ...f.configuration, enabled: false }
  await f.listener.update(disabled)
  expect(f.listener.inspect()).toEqual({ state: 'disabled' })
  expect(await f.traces()).toEqual([])
  expect(JSON.parse(await readFile(f.keyFile, 'utf8'))).toEqual(f.keyValue)
})

it('uses the saved key and exact allowlist, then bridges a real installed amux stdio to the existing endpoint', async () => {
  const f = await fixture(), sockets = new Set<Socket>(), requests: unknown[] = []
  const core = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let pending = ''; socket.setEncoding('utf8')
    socket.on('data', chunk => {
      pending += chunk
      for (let newline; (newline = pending.indexOf('\n')) >= 0;) {
        const request = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); requests.push(request)
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { original: 'already-running-core' } }) + '\n')
      }
    })
  })
  await new Promise<void>(done => core.listen(f.socketPath, done))
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => core.close(() => done())) })
  await f.listener.update(f.configuration)
  await expect.poll(() => f.listener.inspect().state).toBe('listening')
  expect(f.listener.inspect()).toEqual({ state: 'listening', address: 'tcPrivateFixtureAddress' })
  const traces = await f.traces()
  expect(traces).toHaveLength(1)
  expect(traces[0]).toMatchObject({ addressExport: null, managedCaller: null })
  expect(traces[0].args.slice(0, 7)).toEqual(['serve', '--key=' + f.keyFile, '--allow=' + key('3'), '--json', '--psk', 'exec', '--'])
  const peer = createConnection({ host: '127.0.0.1', port: Number(await readFile(f.port, 'utf8')) })
  cleanups.push(() => peer.destroy())
  const response = new Promise<string>((done, reject) => {
    peer.once('data', chunk => done(String(chunk))); peer.once('error', reject)
    peer.once('close', () => reject(Error('The original stdio response did not arrive')))
  })
  peer.write(JSON.stringify({ jsonrpc: '2.0', id: 'original-operation', method: 'system.endpoint', params: {} }) + '\n')
  expect(JSON.parse(await response)).toEqual({ jsonrpc: '2.0', id: 'original-operation', result: { original: 'already-running-core' } })
  expect(requests).toEqual([{ jsonrpc: '2.0', id: 'original-operation', method: 'system.endpoint', params: {} }])
  peer.destroy()
  await f.listener.update({ ...f.configuration, enabled: false })
  expect(f.listener.inspect()).toEqual({ state: 'disabled' })
  expect(core.listening).toBe(true)
  expect(JSON.parse(await readFile(f.keyFile, 'utf8'))).toEqual(f.keyValue)
})

it('reports a missing official CLI without claiming a connection or publishing process details', async () => {
  const f = await fixture(), listener = new HostTailcatListener({ socketPath: f.socketPath, command, environment: { PATH: join(f.directory, 'absent') } })
  cleanups.push(() => listener.close())
  await listener.update(f.configuration)
  await expect.poll(() => listener.inspect().state).toBe('failed')
  expect(listener.inspect()).toMatchObject({ detail: expect.stringContaining('CLI could not start') })
  expect(listener.inspect()).not.toHaveProperty('address')
  expect(JSON.stringify(listener.inspect())).not.toContain(f.keyFile)
})

it('loads a saved official key name from the platform configuration directory without creating another identity', async () => {
  const f = await fixture(), config = process.platform === 'darwin' ? join(f.directory, 'Library', 'Application Support') : join(f.directory, '.config')
  const directory = join(config, 'tailcat', 'keys'); await mkdir(directory, { recursive: true })
  const path = join(directory, 'agentmux-server.private.json'); await writeFile(path, JSON.stringify(f.keyValue))
  const listener = new HostTailcatListener({ socketPath: f.socketPath, command,
    environment: { ...f.environment, HOME: f.directory, XDG_CONFIG_HOME: config, APPDATA: config } })
  cleanups.push(() => listener.close())
  await listener.update({ ...f.configuration, keyFile: 'agentmux-server' })
  await expect.poll(() => listener.inspect().state).toBe('listening')
  expect((await f.traces())[0].args[1]).toBe('--key=agentmux-server')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(f.keyValue)
})

it('requires the official machine readiness receipt rather than a displayed address', async () => {
  const f = await fixture(), listener = new HostTailcatListener({ socketPath: f.socketPath, command, environment: { ...f.environment, TAILCAT_FIXTURE_READY: 'invalid' } })
  cleanups.push(() => listener.close())
  await listener.update(f.configuration)
  await expect.poll(() => listener.inspect().state).toBe('failed')
  expect(listener.inspect()).not.toHaveProperty('address')
})

it('rejects automatic regions, zero PSKs and empty allowlists before spawning, and stops a revoked listener', async () => {
  const f = await fixture()
  await writeFile(f.keyFile, JSON.stringify({ ...f.keyValue, Public: { ...f.keyValue.Public, RegionID: -1 } }))
  await f.listener.update(f.configuration)
  expect(f.listener.inspect().state).toBe('failed'); expect(await f.traces()).toEqual([])
  await writeFile(f.keyFile, JSON.stringify({ ...f.keyValue, Public: { ...f.keyValue.Public, PresharedKey: 'psk:' + '0'.repeat(64) } }))
  await f.listener.update(f.configuration)
  expect(f.listener.inspect().state).toBe('failed'); expect(await f.traces()).toEqual([])
  await writeFile(f.keyFile, JSON.stringify(f.keyValue))
  await f.listener.update(f.configuration)
  await expect.poll(() => f.listener.inspect().state).toBe('listening')
  await f.listener.update({ ...f.configuration, allowedClients: [] })
  expect(f.listener.inspect().state).toBe('failed')
  expect(f.listener.inspect()).not.toHaveProperty('address')
  expect(await f.traces()).toHaveLength(1)
})

it('consumes atomic local Host configuration saves while unrelated Host records and the Core stay intact', async () => {
  const f = await fixture(), path = join(f.directory, 'config.json')
  const ssh = { id: 'remote', kind: 'ssh', label: 'Retained SSH', hostname: 'unrelated.invalid' }
  const save = async (enabled: boolean) => {
    await writeFile(path + '.next', JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'This Mac', tailcat: { ...f.configuration, enabled } }, ssh] }))
    await rename(path + '.next', path)
  }
  await save(false)
  const owner = configuredTailcatListener(path, { socketPath: f.socketPath, environment: f.environment, command })
  cleanups.push(() => owner.close()); await owner.start()
  expect(owner.inspect().state).toBe('disabled'); expect(await f.traces()).toEqual([])
  await save(true)
  await expect.poll(() => owner.inspect().state).toBe('listening')
  await writeFile(path + '.next', '{unreadable'); await rename(path + '.next', path)
  await expect.poll(() => owner.inspect().detail).toContain('unconfirmed')
  expect(owner.inspect().state).toBe('listening')
  await save(false)
  await expect.poll(() => owner.inspect().state).toBe('disabled')
  expect(JSON.parse(await readFile(path, 'utf8')).hosts[1]).toEqual(ssh)
  expect(await f.traces()).toHaveLength(1)
})

it('exposes only validated listener facts through real Host settings RPC and CLI without losing healthy Runtime facts', async () => {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  let state: unknown = { state: 'listening', address: 'tcPrivateFixtureAddress' }
  const owner = { runtimeId: 'original-core', ownerInstanceId: 'original-instance', protocolVersion: 2, processId: process.pid, availability: 'connected' as const, ctxmux: f.client.runtimeIdentity() }
  Object.assign(f.client, { runtimeOwnerIdentity: () => owner })
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, hostTailcat: () => state as never })
  cleanups.push(() => service.dispose())
  const result = await service.call('settings.hosts.inspect', { hostId: 'local' }, { transport: 'unix', principal: { kind: 'user', id: 'local-user' } })
  expect(result.tailcat).toEqual(state); expect(result.owner).toMatchObject({ state: 'available', value: owner })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'tailcat-status.sock'), coreClients: f.coreClients, hostTailcat: () => state as never })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  expect((await rpc.call('settings.hosts.inspect', { hostId: 'local' })).tailcat).toEqual(state)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'hosts', 'inspect', '--host', 'local'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.tailcat).toEqual(state)
  state = { state: 'listening' }
  const unknown = await service.call('settings.hosts.inspect', { hostId: 'local' }, { transport: 'unix', principal: { kind: 'user', id: 'local-user' } })
  expect(unknown.tailcat).toMatchObject({ state: 'unknown' }); expect(unknown.owner.state).toBe('available')
  for (const malformed of [{ state: 'disabled', address: 'tcSecret' }, { state: 'listening', address: 'ssh://wrong' }, { state: 'listening', address: 'tcSecret', extra: true }]) {
    expect(() => parseTailcatListenerObservation(malformed)).toThrow()
  }
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
