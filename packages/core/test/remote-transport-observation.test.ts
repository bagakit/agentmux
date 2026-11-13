import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { parseHostedRuntimeOwnerIdentity as SourceOwnerParser } from '../src/hosted-value.js'
import { headlessFixture } from './helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const core: typeof Source = process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY
  ? await import(process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY) : Source
const AgentMuxControlServer: typeof SourceServer = process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY
  ? (await import(new URL('./public-rpc-server.js', process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY).href)).AgentMuxControlServer : SourceServer
const parseOwner: typeof SourceOwnerParser = process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY
  ? (await import(new URL('./hosted-value.js', process.env.AGENTMUX_TEST_REMOTE_LINK_ENTRY).href)).parseHostedRuntimeOwnerIdentity : SourceOwnerParser
const cleanup: Array<() => Promise<unknown>> = []
let directory: string
const target = { hostId: 'original-host', hostname: 'private.fixture', tailcat: { address: 'tcSynthetic_LinkCredential-A', keyFile: 'saved-link-client' } }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-link-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('PATH', `${directory}:${process.env.PATH}`)
  await writeFile(join(directory, 'calls'), '')
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Private link proof cleanup failed.')
})
const calls = async () => (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').filter(Boolean)

async function carrier(name: 'ssh' | 'tailcat', socket: string, mode: 'forward' | 'old-owner' | 'hold' = 'forward') {
  const forward = pathToFileURL(resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  await writeFile(join(directory, name), `#!${process.execPath}
import {appendFileSync,existsSync,watch,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {forwardAgentMuxRpcStdio} from ${JSON.stringify(forward)};
appendFileSync(${JSON.stringify(join(directory, 'calls'))},${JSON.stringify(name + '\n')});
const mode=${JSON.stringify(mode)};
if(mode==='forward') await forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(socket)}},input:process.stdin,output:process.stdout});
else for await(const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(mode==='hold' && request.method==='system.endpoint') {
  writeFileSync(${JSON.stringify(join(directory, 'holding'))},'probe received');
  await new Promise(resolve=>{const w=watch(${JSON.stringify(directory)},()=>{if(existsSync(${JSON.stringify(join(directory, 'release'))})){w.close();resolve();}});});
 }
 const result=request.method==='system.endpoint'?{protocol:'jsonrpc-2.0',framing:'json-lines',connection:'responded',publication:null,endpoint:{transport:'unix',path:${JSON.stringify(socket)}}}
 :{owner:{runtimeId:'original-runtime',ownerInstanceId:'original-owner',processId:123,protocolVersion:1,ctxmux:null,availability:'connected'}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}
`, { mode: 0o700 })
}
async function rpc(transport: 'ssh' | 'tailcat' = 'ssh') {
  const connection = await core.connectAgentMuxRpc({ endpoint: core.agentMuxSshEndpoint({ ...target, transport }) })
  cleanup.push(() => connection.dispose())
  return connection
}

it('keeps local and unopened/disposed remote getters passive, and rejects secret or contradictory DTOs', async () => {
  const local = new core.AgentMuxClient({ providers: [] }); cleanup.push(() => local.dispose())
  const connect = vi.spyOn(local, 'connect'), runtime = vi.spyOn(local, 'connectRuntime')
  expect(local.remoteTransportObservation()).toBeNull()
  const nonremote = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'unopened.sock') } })
  cleanup.push(() => nonremote.dispose()); expect(nonremote.remoteTransportObservation()).toBeNull()
  const connection = await rpc()
  for (let i = 0; i < 20; i++) expect(connection.remoteTransportObservation()).toMatchObject({ state: 'unopened', transport: null, fallback: false, establishedAt: null })
  await connection.dispose()
  expect(connection.remoteTransportObservation()?.state).not.toBe('connected')
  expect(connection.remoteTransportObservation()?.transport).toBeNull()
  expect(await calls()).toEqual([]); expect(connect).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
  const valid = { state: 'connected', transport: 'ssh', fallback: false, establishedAt: 123, observedAt: 456 }
  expect(core.parseRemoteTransportObservation(valid)).toEqual(valid)
  for (const value of [{ ...valid, address: target.tailcat.address }, { ...valid, state: 'connecting' },
    { ...valid, fallback: true }, { ...valid, establishedAt: null }, { ...valid, observedAt: NaN }]) {
    expect(() => core.parseRemoteTransportObservation(value)).toThrow()
  }
})

it('reports connecting until its original endpoint probe confirms, with zero getter I/O and safe disconnect history', async () => {
  await carrier('ssh', join(directory, 'controlled.sock'), 'hold')
  const connection = await rpc(), pending = connection.call('system.endpoint', {})
  await vi.waitFor(async () => expect(await readFile(join(directory, 'holding'), 'utf8')).toBe('probe received'))
  for (let i = 0; i < 20; i++) expect(connection.remoteTransportObservation()).toMatchObject({ state: 'connecting', transport: null, establishedAt: null })
  expect(await calls()).toEqual(['ssh'])
  await writeFile(join(directory, 'release'), 'release original probe')
  await pending
  const established = connection.remoteTransportObservation()!
  expect(established).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false, establishedAt: expect.any(Number) })
  expect(JSON.stringify(established)).not.toContain(target.tailcat.address)
  await connection.dispose()
  expect(connection.remoteTransportObservation()).toMatchObject({ ...established, state: 'disconnected', observedAt: expect.any(Number) })
  expect(await calls()).toEqual(['ssh'])
})

it('keeps an established candidate private until activation and isolates retired route closure', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  await carrier('ssh', scope.socketPath); await carrier('tailcat', scope.socketPath)
  const connection = await rpc()
  await connection.call('runtime.owner.identity', { expectedRuntimeId: scope.owner.runtimeId })
  const before = connection.remoteTransportObservation()!
  const candidate = await connection.prepareSshRoute(core.agentMuxSshEndpoint({ ...target, transport: 'tailcat' }), scope.owner.runtimeId)
  expect(connection.remoteTransportObservation()).toMatchObject({ ...before, observedAt: expect.any(Number) })
  expect(await calls()).toEqual(['ssh', 'tailcat'])
  candidate.assertCurrent(); candidate.activate()
  await new Promise(resolve => setImmediate(resolve))
  expect(connection.remoteTransportObservation()).toMatchObject({ state: 'connected', transport: 'tailcat', fallback: false })
  await connection.call('system.endpoint', {})
  expect(await calls()).toEqual(['ssh', 'tailcat'])
}, 30_000)

it('exposes confirmed SSH despite an old owner contract through Hosted, original inspect RPC and actual compiled CLI', async () => {
  await carrier('ssh', join(directory, 'old-core.sock'), 'old-owner')
  const client = await core.connectSshAgentMux({ waitForReady: false, expectedRuntimeId: 'original-runtime', target })
  cleanup.push(() => client.dispose())
  await expect(client.hostEnvironment()).rejects.toMatchObject({ code: 'REMOTE_CORE_UPGRADE_REQUIRED' })
  expect(client.remoteTransportObservation()).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false })
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [{ hostId: target.hostId, client }] })
  await server.start(); cleanup.push(() => server.stop())
  const local = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => local.dispose())
  const observation = await local.call('settings.hosts.inspect', { hostId: target.hostId })
  expect(observation.remoteTransport).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false })
  expect(observation.diagnostics).toMatchObject({ state: 'unavailable', code: 'REMOTE_CORE_UPGRADE_REQUIRED' })
  expect(() => core.parseHostRuntimeObservation({ ...observation, remoteTransport: { ...observation.remoteTransport, keyFile: 'private' } }, target.hostId)).toThrow()
  const cli = await runCompiledObjectCli(['settings', 'hosts', 'inspect', '--host', target.hostId], objectCliEnvironment(directory))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.remoteTransport).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false })
  expect(JSON.stringify(observation)).not.toContain(target.tailcat.address)
  expect(await calls()).toEqual(['ssh'])
})

it('diagnoses only recognized valid old owner protocol and never accepts or downgrades it', async () => {
  const parse = parseOwner
  const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 123, protocolVersion: 1, ctxmux: null, availability: 'connected' }
  expect(() => parse(owner)).toThrowError(expect.objectContaining({ code: 'REMOTE_CORE_UPGRADE_REQUIRED' }))
  for (const value of [{ ...owner, protocolVersion: 99 }, { ...owner, processId: null }, { ...owner, availability: 'dead' }, { ...owner, ctxmux: { invalid: true } }]) {
    expect(() => parse(value)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
})
