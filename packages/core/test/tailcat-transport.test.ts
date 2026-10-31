import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentMuxRpcEndpoint as SourceEndpoint, connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import { agentMuxSshEndpoint, connectSshAgentMux as SourceConnectSsh } from '../src/runtime-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const closes: (() => Promise<unknown>)[] = []
const { agentMuxRpcEndpoint, connectAgentMuxRpc }: { agentMuxRpcEndpoint: typeof SourceEndpoint; connectAgentMuxRpc: typeof SourceConnect } = process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY
  ? await import(process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY) : { agentMuxRpcEndpoint: SourceEndpoint, connectAgentMuxRpc: SourceConnect }
const connectSshAgentMux: typeof SourceConnectSsh = process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY)).connectSshAgentMux : SourceConnectSsh
const target = { hostId: 'same-host', hostname: 'literal-ssh-alias', tailcat: { address: 'tcSynthetic_Credential-A', keyFile: 'agentmux-client' } }
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-tailcat-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('PATH', `${directory}:${process.env.PATH}`)
  await writeFile(join(directory, 'calls'), '')
  await writeFile(join(directory, 'requests'), '')
})
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Tailcat test cleanup failed.')
})
async function carrier(name: 'ssh' | 'tailcat', socket: string, mode: 'forward' | 'fail' | 'invalid' | 'lost' = 'forward') {
  // Controlled executables model the official CLI's stdio boundary, never its
  // WireGuard implementation. The forward path reaches the real RPC server.
  const forward = pathToFileURL(resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  const source = `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {forwardAgentMuxRpcStdio} from ${JSON.stringify(forward)};
appendFileSync(${JSON.stringify(join(directory, 'calls'))}, ${JSON.stringify(name + '\n')});
const mode=${JSON.stringify(mode)};
if(${JSON.stringify(name)}==='tailcat' && JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(['--key', target.tailcat.keyFile, target.tailcat.address]))})process.exit(2);
if(mode==='fail'){process.stderr.write('private diagnostics must not escape');process.exit(255);}
if(mode==='forward') await forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(socket)}},input:process.stdin,output:process.stdout});
else for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);appendFileSync(${JSON.stringify(join(directory, 'requests'))},JSON.stringify(r)+'\\n');
 if(r.method!=='system.endpoint')process.exit(1);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:mode==='invalid'?{invalid:true}:{protocol:'jsonrpc-2.0',framing:'json-lines',endpoint:{transport:'unix',path:${JSON.stringify(socket)}},connection:'responded',publication:null}})+'\\n');
}
`
  await writeFile(join(directory, name), source, { mode: 0o700 })
}
async function owner() {
  const fixture = await rpcOwnerFixture()
  closes.push(fixture.close)
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'owner.sock'), coreClients: fixture.coreClients,
    execute: async () => ({ operation: 'space.ls', catalog }) })
  await server.start(); closes.push(() => server.stop())
  return { ...fixture, server, catalog }
}
async function connect(transport?: 'ssh' | 'ssh-tailcat' | 'tailcat') {
  const rpc = await connectAgentMuxRpc({ endpoint: agentMuxSshEndpoint({ ...target, ...(transport ? { transport } : {}) }) })
  closes.push(() => rpc.dispose())
  return rpc
}
const calls = async () => (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').filter(Boolean)

it.each([undefined, 'ssh', 'ssh-tailcat'] as const)('uses healthy SSH for %s without starting Tailcat', async transport => {
  const fixture = await owner()
  await carrier('ssh', fixture.server.path); await carrier('tailcat', fixture.server.path, 'fail')
  const rpc = await connect(transport)
  expect(await rpc.call('space.ls', { target: {} })).toEqual({ catalog: fixture.catalog })
  expect(await rpc.call('system.endpoint', {})).toMatchObject({ connection: 'responded' })
  expect(await calls()).toEqual(['ssh'])
  expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
})
it('selects Tailcat only after SSH establishment fails and shares it across consumers', async () => {
  const fixture = await owner()
  await carrier('ssh', fixture.server.path, 'fail'); await carrier('tailcat', fixture.server.path)
  const rpc = await connect('ssh-tailcat')
  const results = await Promise.all([rpc.call('space.ls', { target: {} }), rpc.call('system.endpoint', {})])
  expect(results).toEqual([{ catalog: fixture.catalog }, expect.objectContaining({ connection: 'responded' })])
  expect(await calls()).toEqual(['ssh', 'tailcat'])
  expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
})
it('uses Tailcat only through the real Hosted connector, preserving original owner and live Run across reconnect', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  await carrier('ssh', scope.socketPath, 'fail'); await carrier('tailcat', scope.socketPath)
  const options = { expectedRuntimeId: scope.owner.runtimeId, target: { ...target, hostname: '', transport: 'tailcat' as const } }
  const client = await connectSshAgentMux(options); closes.push(() => client.dispose())
  const run = await client.createTerminal({ createOperationId: 'tailcat-preserved-run', workspacePath: scope.root,
    command: process.execPath, args: ['-e', "process.stdout.write('tailcat-original');setInterval(()=>{},1000)"] })
  await until(() => client.listRuns(), rows => rows.some(row => row.runId === run.runId && row.latestOutputBytes > 0), 'original Run emits output')
  const replay = await client.readRunReplay({ runId: run.runId }, 0, 'raw')
  expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toBe('tailcat-original')
  expect(await calls()).toEqual(['tailcat'])
  await client.dispose()
  const next = await connectSshAgentMux(options); closes.push(() => next.dispose())
  expect((await next.listRuns()).find(row => row.runId === run.runId)).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running' })
  expect(next.runtimeOwnerIdentity()?.runtimeId).toBe(scope.owner.runtimeId)
  expect(await calls()).toEqual(['tailcat', 'tailcat'])
  await next.dispose()
  const originalOwner = scope.owner
  const restarted = await scope.restart()
  expect(restarted.owner.runtimeId).toBe(originalOwner.runtimeId)
  expect(restarted.owner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
  const restored = await connectSshAgentMux(options); closes.push(() => restored.dispose())
  expect((await restored.listRuns()).find(row => row.runId === run.runId)).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running' })
  expect(await calls()).toEqual(['tailcat', 'tailcat', 'tailcat'])
  await restored.stopTerminal({ runId: run.runId })
}, 60_000)
it('does not switch or replay a business operation when its SSH reply is lost after dispatch', async () => {
  const fixture = await owner()
  await carrier('ssh', fixture.server.path, 'lost'); await carrier('tailcat', fixture.server.path)
  const rpc = await connect('ssh-tailcat')
  const input = { operationId: 'original-tailcat-test-operation', expectedRevision: 'original', service: { enabled: true } }
  const result = await rpc.call('connection.service.configure', input).then(value => ({ value }), error => ({ error }))
  expect(result).toHaveProperty('error')
  const requests = (await readFile(join(directory, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(requests).toHaveLength(2)
  expect(requests[1]).toMatchObject({ method: 'connection.service.configure', params: input, id: expect.any(String) })
  expect(await calls()).toEqual(['ssh'])
  expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
})
it('keeps a malformed SSH protocol receipt visible instead of bypassing it through backup', async () => {
  const fixture = await owner()
  await carrier('ssh', fixture.server.path, 'invalid'); await carrier('tailcat', fixture.server.path)
  const rpc = await connect('ssh-tailcat')
  await expect(rpc.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR', controlFailure: { disposition: 'not_applied' } })
  expect(await calls()).toEqual(['ssh'])
})
it('reports absent Tailcat CLI without echoing its secret address or claiming connection', async () => {
  vi.stubEnv('PATH', directory)
  const rpc = await connect('tailcat')
  const result = await rpc.call('system.endpoint', {}).catch(error => error)
  expect(result).toMatchObject({ code: 'CONTROL_UNAVAILABLE', controlFailure: { disposition: 'not_applied' }, message: expect.stringContaining('Install') })
  expect(result.message).not.toContain(target.tailcat.address)
  expect(await calls()).toEqual([])
})
it('parses explicit Tailcat endpoints and refuses ephemeral keys without leaking an address', () => {
  expect(agentMuxRpcEndpoint('tailcat:tcSynthetic_Credential-A?key=agentmux-client')).toEqual({ transport: 'tailcat', ...target.tailcat })
  expect(() => agentMuxRpcEndpoint('tailcat://tcSynthetic_Credential-A?key=agentmux-client')).toThrow('Invalid Tailcat RPC endpoint')
  expect(() => agentMuxRpcEndpoint('tailcat:tcsyntheticcredential?key=new')).toThrow('saved client key')
  expect(() => agentMuxRpcEndpoint('tailcat:tcsyntheticcredential?key=client&key=other')).toThrow('Invalid Tailcat RPC endpoint')
  expect(agentMuxSshEndpoint({ ...target, tailcat: { address: '', keyFile: 'new' } })).toEqual({ transport: 'ssh', host: target.hostname })
})
