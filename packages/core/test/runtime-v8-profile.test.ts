import { Session } from 'node:inspector/promises'
import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseRuntimeV8ProfileInput, parseRuntimeV8ProfileResult, type RuntimeV8ProfileResult } from '../src/runtime-v8-profile.js'
import { analyseV8Profile, parseV8ProfileBytes } from '../src/v8-profile-analysis.js'
import { AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const core = await rpcOwnerFixture(); cleanup.push(core.close)
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'profile-runtime', ownerInstanceId: 'profile-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: null, availability: 'unverified' }
  const input = { hostId: 'local', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, processId: process.pid, durationMs: 1000 }
  const hosted = new AgentMuxHostedRuntimeService(core.client, null, () => owner); cleanup.push(() => hosted.dispose())
  const connect = vi.spyOn(core.client, 'connect'), connectRuntime = vi.spyOn(core.client, 'connectRuntime'), sessions = vi.spyOn(core.client, 'readAgentSessions')
  const server = new AgentMuxControlServer({ socketPath: join(core.root, 'control.sock'), coreClients: core.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { ...core, owner, input, hosted, rpc, connect, connectRuntime, sessions }
}
function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.connect).not.toHaveBeenCalled(); expect(f.connectRuntime).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  expect(f.inner.kernel.attach).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}
it('captures the real Node owner through the Unix public aggregate, retaining another Inspector connection and the original profile', async () => {
  const f = await fixture(), other = new Session(); other.connect(); cleanup.push(() => other.disconnect())
  const disconnect = vi.spyOn(Session.prototype, 'disconnect')
  const result = await f.rpc.call('system.metrics.host-profile.capture', f.input)
  expect(result.status).toBe('completed'); expect(result.owner).toEqual(f.owner)
  expect(result.cleanup).toEqual({ stopped: true, disabled: true, disconnected: true })
  expect(disconnect).toHaveBeenCalledOnce()
  expect(result.sourceVerified).toEqual({ before: true, after: true })
  expect(result.timing.elapsedMs).toBeGreaterThanOrEqual(1000)
  expect(result.profile!.nodes.length).toBeGreaterThan(0); expect(result.profile!.samples!.length).toBeGreaterThan(0)
  const bytes = Buffer.from(JSON.stringify(result.profile))
  expect(bytes.byteLength).toBe(result.profileBytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.profileSha256)
  expect(analyseV8Profile(parseV8ProfileBytes(bytes)).reason).toBeNull()
  expect((await other.post('Runtime.evaluate', { expression: '2 + 3', returnByValue: true })).result.value).toBe(5)
  expect(() => parseRuntimeV8ProfileResult({ ...result, profileBytes: 1 }, f.input)).toThrow()
  const oversized = structuredClone(result)
  oversized.profile!.nodes[0]!.callFrame.functionName = 'x'.repeat(8 * 1024 * 1024)
  expect(() => parseRuntimeV8ProfileResult(oversized, f.input)).toThrow()
  unchanged(f)
})
it('rejects stale process and owner targets before Inspector starts, and keeps Runtime management permission separate', async () => {
  const f = await fixture(), connect = vi.spyOn(Session.prototype, 'connect')
  const { hostId: _hostId, ...input } = f.input
  await expect(f.rpc.call('system.metrics.host-profile.capture', { ...f.input, processId: process.pid + 1 })).rejects.toMatchObject({ code: 'RUNTIME_PROFILE_TARGET_CHANGED' })
  await expect(f.rpc.call('system.metrics.host-profile.capture', { ...f.input, fence: { ...input.fence, ownerInstanceId: 'foreign' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, hostedRuntime: () => f.hosted }); cleanup.push(() => service.dispose())
  await expect(service.call('runtime.profile.capture', input, { caller: f.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(service.call('system.metrics.host-profile.capture', f.input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const history = vi.spyOn(f.client, 'sessionHistorySources')
  await expect(service.call('system.metrics.host-profile.capture', f.input, { caller: { ...f.credentials, agentSessionId: 'absent' } })).rejects.toBeDefined()
  expect(history).not.toHaveBeenCalled()
  const unavailable = new AgentMuxRpcService(); cleanup.push(() => unavailable.dispose())
  await expect(unavailable.call('system.metrics.host-profile.capture', f.input, { principal: { kind: 'user', id: 'user' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(connect).not.toHaveBeenCalled()
  const ack = await f.client.writeTerminal({ runId: 'run-caller' }, { ownerInstanceId: 'fixture-runtime', operationId: 'profile-refusal-healthy-input', expectedByte: 0, data: 'still usable' })
  expect(ack.appliedByteRange?.endByte).toBe(12); unchanged(f)
})
it('serializes captures across consumers, cancels and disconnects its own session, then accepts an explicit new capture', async () => {
  const f = await fixture(), controller = new AbortController()
  const { hostId: _hostId, ...input } = f.input
  const post = vi.spyOn(Session.prototype, 'post'), disconnect = vi.spyOn(Session.prototype, 'disconnect')
  const pending = f.hosted.call('runtime.profile.capture', input, { signal: controller.signal })
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('Profiler.start'))
  await expect(f.rpc.call('system.metrics.host-profile.capture', f.input)).rejects.toMatchObject({ code: 'RUNTIME_PROFILE_BUSY' })
  controller.abort()
  const stopped = await pending as RuntimeV8ProfileResult
  expect(stopped.status).toBe('cancelled'); expect(stopped.cleanup).toEqual({ stopped: true, disabled: true, disconnected: true })
  expect(disconnect).toHaveBeenCalledOnce()
  const admitted = vi.spyOn(f.hosted, 'call')
  const publicCancellation = new AbortController()
  const publicPending = f.rpc.call('system.metrics.host-profile.capture', f.input, { signal: publicCancellation.signal })
  const cancelledReply = expect(publicPending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  await vi.waitFor(() => expect(post.mock.calls.filter(([method]) => method === 'Profiler.start')).toHaveLength(2))
  publicCancellation.abort(); await cancelledReply
  // A shared RPC reader detaches; it cannot cancel an already admitted intent.
  // Join the actual original producer promise, not a guessed cleanup deadline.
  const original = await admitted.mock.results[0]!.value as RuntimeV8ProfileResult
  expect(original.status).toBe('completed')
  expect(original.cleanup).toEqual({ stopped: true, disabled: true, disconnected: true })
  expect(disconnect).toHaveBeenCalledTimes(2)
  expect((await f.rpc.call('system.metrics.host-profile.capture', f.input)).status).toBe('completed')
  unchanged(f)
})
it('retains original captured evidence after the routing list changes, without borrowing a later owner', async () => {
  const f = await fixture(), routes = [{ hostId: 'local', client: f.client }]
  const service = new AgentMuxRpcService({ coreClients: () => routes, hostedRuntime: () => f.hosted }); cleanup.push(() => service.dispose())
  const post = vi.spyOn(Session.prototype, 'post')
  const pending = service.call('system.metrics.host-profile.capture', f.input, { caller: f.credentials })
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('Profiler.start')); routes.splice(0)
  const result = await pending
  expect(result.status).toBe('completed'); expect(result.owner).toEqual(f.owner); unchanged(f)
})
it('publishes exact discovery and the real compiled CLI export into the existing profile analysis consumer', async () => {
  const f = await fixture(), root = resolve(import.meta.dirname, '../../..'), candidate = await mkdtemp(join(tmpdir(), 'amx-profile-cli-'))
  cleanup.push(() => rm(candidate, { recursive: true, force: true }))
  await mkdir(join(candidate, 'bin')); await mkdir(join(candidate, 'dist'))
  await writeFile(join(candidate, 'package.json'), '{"type":"module"}')
  await writeFile(join(candidate, 'bin/amux'), "import '../dist/agentmux.js'\n")
  await symlink(join(root, 'packages/core/node_modules'), join(candidate, 'node_modules'), 'dir')
  await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(candidate, 'dist/agentmux.js'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(candidate, 'bin/amux'))
  const output = join(candidate, 'original.cpuprofile'), env = objectCliEnvironment(f.root)
  const args = ['system', 'metrics', 'host-profile', 'capture', '--host', 'local', '--runtime', f.owner.runtimeId,
    '--owner', f.owner.ownerInstanceId, '--pid', String(process.pid), '--duration-ms', '1000', '--output', output]
  expect(AGENTMUX_RPC_NATIVE_METHODS['system.metrics.host-profile.capture']).toBe('long')
  expect(agentMuxCommandHelp('system.metrics.host-profile.capture')).toContain('--host ID --runtime ID --owner ID --pid PID')
  const cli = await runCompiledObjectCli(args, env)
  expect(cli.code, cli.stderr + cli.stdout).toBe(0)
  const envelope = JSON.parse(cli.stdout), result = parseRuntimeV8ProfileResult(envelope.result, f.input)
  expect(envelope.output.sha256).toBe(result.profileSha256)
  const bytes = await readFile(output); expect(bytes.byteLength).toBe(result.profileBytes)
  expect(analyseV8Profile(parseV8ProfileBytes(bytes)).reason).toBeNull()
  const local = await runCompiledObjectCli(['system', 'metrics', 'profile', 'analyze', '--input', output], env)
  expect(local.code, local.stderr).toBe(0)
  unchanged(f)
})
it('rejects incomplete or unbounded requests at the original public contract', () => {
  const input = { fence: { runtimeId: 'runtime', ownerInstanceId: 'owner' }, processId: 1, durationMs: 1000 }
  for (const value of [{ ...input, durationMs: 0 }, { ...input, durationMs: 5001 }, { ...input, processId: 0 },
    { ...input, fence: { runtimeId: 'runtime' } }, { ...input, guessed: true }]) expect(() => parseRuntimeV8ProfileInput(value)).toThrow()
})
