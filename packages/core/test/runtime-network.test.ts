import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { parseNetworkInterfaces, parseRuntimeNetworkSnapshot, readNetworkInterfaces } from '../src/runtime-network.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) }
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const core = await rpcOwnerFixture()
  cleanup.push(core.close)
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'network-runtime', ownerInstanceId: 'network-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: null, availability: 'unverified' }
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const hosted = new AgentMuxHostedRuntimeService(core.client, null, () => owner)
  cleanup.push(() => hosted.dispose())
  const connect = vi.spyOn(core.client, 'connect'), connectRuntime = vi.spyOn(core.client, 'connectRuntime')
  const sessions = vi.spyOn(core.client, 'readAgentSessions')
  const server = new AgentMuxControlServer({ socketPath: join(core.root, 'control.sock'), coreClients: core.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  return { ...core, owner, fence, hosted, rpc, server, connect, connectRuntime, sessions }
}
it('reads actual producer OS addresses through the public service without Native, Session discovery or consumer bootstrap', async () => {
  const f = await fixture(), before = Date.now()
  const sample = await f.rpc.call('runtime.network.inspect', { fence: f.fence })
  expect(sample.owner).toEqual(f.owner)
  expect(sample.owner.ctxmux).toBeNull()
  expect(sample.observedAt).toBeGreaterThanOrEqual(before); expect(sample.observedAt).toBeLessThanOrEqual(Date.now())
  expect(sample.interfaces.length).toBeGreaterThan(0)
  expect(sample.interfaces).toEqual(readNetworkInterfaces())
  for (const entry of sample.interfaces) {
    expect(Object.keys(entry).sort()).toEqual(['address', 'cidr', 'family', 'internal', 'name', 'scopeid'])
    expect(networkInterfaces()[entry.name]).toEqual(expect.arrayContaining([expect.objectContaining({ address: entry.address, family: entry.family, cidr: entry.cidr, internal: entry.internal })]))
  }
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  expect(f.inner.kernel.attach).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('refuses both wrong original fences and managed caller escalation while preserving unrelated healthy input', async () => {
  const f = await fixture()
  for (const [fence, code] of [
    [{ ...f.fence, runtimeId: 'another-runtime' }, 'RUNTIME_OWNER_MISMATCH'],
    [{ ...f.fence, ownerInstanceId: 'another-owner' }, 'RUNTIME_OWNER_CHANGED']
  ] as const) {
    await expect(f.hosted.call('runtime.network.inspect', { fence })).rejects.toMatchObject({ code })
    await expect(f.rpc.call('runtime.network.inspect', { fence })).rejects.toMatchObject({ code })
  }
  for (const params of [{ fence: f.fence, consumerId: 'not-required' }, { fence: { ...f.fence, guessed: true } }, { fence: { runtimeId: f.owner.runtimeId } }]) {
    await expect(f.rpc.call('runtime.network.inspect', params as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, hostedRuntime: () => f.hosted })
  cleanup.push(() => service.dispose())
  await expect(service.call('runtime.network.inspect', { fence: f.fence }, { caller: f.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const ack = await f.client.writeTerminal({ runId: 'run-caller' }, { ownerInstanceId: 'fixture-runtime', operationId: 'healthy-original-input', expectedByte: 0, data: 'still usable' })
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('still usable') })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})
it('cancels only the original public read and allows a later explicit read of the same owner', async () => {
  const f = await fixture(), controller = new AbortController()
  let release!: (value: AgentMuxHostedRuntimeService) => void, entered = false
  const waiting = new AgentMuxControlServer({ socketPath: join(f.root, 'waiting.sock'), coreClients: f.coreClients, hostedRuntime: () => {
    entered = true; return new Promise(resolve => { release = resolve })
  } })
  await waiting.start(); cleanup.push(() => waiting.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: waiting.path } }); cleanup.push(() => rpc.dispose())
  const reading = rpc.call('runtime.network.inspect', { fence: f.fence }, { signal: controller.signal })
  const rejected = expect(reading).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  await vi.waitFor(() => expect(entered).toBe(true))
  controller.abort(); await rejected; release(f.hosted)
  const cancelled = new AbortController(); cancelled.abort(new AgentMuxError('Original read cancelled.', 'CONTROL_CANCELLED'))
  await expect(f.hosted.call('runtime.network.inspect', { fence: f.fence }, { signal: cancelled.signal })).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect((await f.rpc.call('runtime.network.inspect', { fence: f.fence })).owner).toEqual(f.owner)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('keeps missing CIDR and IPv6 scope facts literal and rejects malformed or foreign responses over the actual public client', async () => {
  const f = await fixture(), sample = await f.rpc.call('runtime.network.inspect', { fence: f.fence })
  const addresses = [
    { name: 'test-v4', address: '192.0.2.8', family: 'IPv4', cidr: null, internal: false, scopeid: null },
    { name: 'test-v6', address: 'fe80::8', family: 'IPv6', cidr: 'fe80::8/64', internal: false, scopeid: 7 },
    { name: 'test-loopback', address: '::1', family: 'IPv6', cidr: '::1/128', internal: true, scopeid: 0 }
  ]
  expect(parseNetworkInterfaces(addresses)).toEqual(addresses)
  expect(parseRuntimeNetworkSnapshot({ ...sample, interfaces: [] }, f.fence).interfaces).toEqual([])
  for (const change of [
    (p: any) => { p.owner.ownerInstanceId = 'foreign' },
    (p: any) => { p.owner.runtimeId = 'foreign' },
    (p: any) => { delete p.observedAt },
    (p: any) => { p.observedAt = -1 },
    (p: any) => { p.interfaces = null },
    (p: any) => { p.interfaces[0].mac = 'unexpected-secret-field' },
    (p: any) => { p.interfaces[0].family = 'IPv9' },
    (p: any) => { p.interfaces[0].address = 'not-an-address' },
    (p: any) => { p.interfaces[0].cidr = '192.0.2.9/24' },
    (p: any) => { p.interfaces[0].scopeid = 3 }
  ]) {
    const malformed = structuredClone({ ...sample, interfaces: addresses }); change(malformed)
    vi.spyOn(f.hosted, 'call').mockResolvedValueOnce(malformed)
    await expect(f.rpc.call('runtime.network.inspect', { fence: f.fence })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
})
it('reports an OS inspection failure as failure and recovers on the next explicit read without lifecycle work', async () => {
  const f = await fixture()
  vi.mocked(networkInterfaces).mockImplementationOnce(() => { throw Object.assign(new Error('Private interface inspection failed.'), { code: 'EIO' }) })
  await expect(f.rpc.call('runtime.network.inspect', { fence: f.fence })).rejects.toMatchObject({ message: 'Private interface inspection failed.' })
  expect((await f.rpc.call('runtime.network.inspect', { fence: f.fence })).interfaces.length).toBeGreaterThan(0)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('exposes exact discovery/help and the same original snapshot through the real compiled CLI', async () => {
  const f = await fixture()
  expect(AGENTMUX_RPC_NATIVE_METHODS['runtime.network.inspect']).toBe('short')
  expect(agentMuxCommandHelp('runtime.network.inspect')).toContain('--runtime ID --owner ID')
  expect(agentMuxModuleSkill('runtime')).toContain('network namespace')
  const env = objectCliEnvironment(f.root)
  const cli = await runCompiledObjectCli(['runtime', 'network', 'inspect', '--runtime', f.owner.runtimeId, '--owner', f.owner.ownerInstanceId], env)
  expect(cli.code, cli.stderr).toBe(0)
  const sample = parseRuntimeNetworkSnapshot(JSON.parse(cli.stdout).result, f.fence)
  expect(sample.owner).toEqual(f.owner); expect(sample.interfaces).toEqual(readNetworkInterfaces())
  for (const args of [[], ['--runtime', f.owner.runtimeId], ['--runtime', 'self', '--owner', f.owner.ownerInstanceId]]) {
    const refused = await runCompiledObjectCli(['runtime', 'network', 'inspect', ...args], env)
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain('INVALID_CLI_ARGUMENT')
  }
  const wrong = await runCompiledObjectCli(['runtime', 'network', 'inspect', '--runtime', f.owner.runtimeId, '--owner', 'wrong-owner'], env)
  expect(wrong.code).not.toBe(0); expect(wrong.stderr).toContain('RUNTIME_OWNER_CHANGED')
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})
