import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli, ObjectCliProbe } from './helpers/object-cli-rpc.js'
import type * as Source from '../src/index.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_REFRESH_CORE_ENTRY
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_REFRESH_CORE_ENTRY).href)
  : { ...await import('../src/index.js'), ...await import('../src/public-rpc-server.js'), ...await import('../src/public-rpc-service.js'), ...await import('../src/hosted-runtime-service.js') }
const compiledCli = process.env.AGENTMUX_TEST_OBJECT_CLI
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const h = await rpcOwnerFixture(['refresh-original'], core as any)
  cleanups.push(() => h.close())
  if (compiledCli) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', compiledCli)
  const inner = h.client as any
  inner.kernel.start = vi.fn(); inner.kernel.list = vi.fn(async () => [h.run('canonical-run')])
  const read = () => h.store.readMetadata('refresh-original')
  const rebind = async (patch: Partial<AgentMuxStoredAgentSession> = {}) => {
    const previous = (await read())!
    const next = { ...previous, run: { runId: 'canonical-run' }, updatedAt: previous.updatedAt + 1, ...patch }
    await h.store.compareAndSwapMetadata(previous, next); return next
  }
  const unchanged = () => { expect(inner.kernel.start).not.toHaveBeenCalled(); expect(inner.kernel.stop).not.toHaveBeenCalled(); expect(inner.kernel.input).not.toHaveBeenCalled(); expect(inner.kernel.attach).not.toHaveBeenCalled() }
  return { ...h, inner, rebind, read, unchanged }
}

it('canonical SDK refresh reads one exact SID after rebind while explicit Run and input fences remain strict', async () => {
  const h = await fixture(), previous = h.client.agentSession('refresh-original').run
  await h.rebind()
  const scan = vi.spyOn(h.store, 'loadMetadata').mockRejectedValue(new Error('A canonical SID read must not scan all Sessions'))
  await expect(h.client.refreshAgentSession('refresh-original')).resolves.toMatchObject({ agentSessionId: 'refresh-original', hostId: 'local', run: { runId: 'canonical-run' } })
  expect(scan).not.toHaveBeenCalled()
  await expect(h.client.refreshAgentSession('refresh-original', previous)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await expect(h.client.writeAgent({ agentSessionId: 'refresh-original', expectedRun: previous, source: 'user', data: 'kept original input' })).rejects.toBeInstanceOf(Error)
  h.unchanged()
})

it('canonical SDK refresh rejects a changed original Host without adopting it', async () => {
  const h = await fixture(); await h.rebind({ hostId: 'foreign-host' })
  await expect(h.client.refreshAgentSession('refresh-original')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(h.client.agentSession('refresh-original').hostId).toBe('local'); h.unchanged()
})

it.each(['missing', 'retired'] as const)('canonical SDK refresh does not reopen a %s original target', async state => {
  const h = await fixture(), previous = (await h.read())!
  if (state === 'retired') {
    const reservation = { reservationId: 'refresh-retire', ownerId: 'refresh-owner', ownerPid: process.pid,
      kind: 'stop' as const, agentSessionId: previous.agentSessionId, operationId: 'refresh-stop',
      expiresAt: Date.now() + 60_000, expectedRun: previous.run,
      stopOperation: { daemonInstance: 'refresh-runtime', operationKey: 'refresh-stop', runId: previous.run.runId } }
    await h.store.reserveLifecycle(reservation); await h.store.commitLifecycle(reservation, null)
    expect(await h.store.loadRetiredAgentSessions()).toEqual([expect.objectContaining({ agentSessionId: 'refresh-original', source: 'user' })])
  }
  else await h.store.compareAndSwapMetadata(previous, null)
  await expect(h.client.refreshAgentSession('refresh-original')).rejects.toBeInstanceOf(Error)
  expect(await h.read()).toBeNull(); h.unchanged()
})

it('refresh re-observes late native identity on the returned canonical Run without lifecycle or input', async () => {
  const h = await fixture(); await h.rebind()
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 12345 }))
  const provider = h.client.providers.get('codex'), witness = vi.fn(async () => {})
  const discover = vi.spyOn(provider, 'discoverNativeSession').mockResolvedValue({ handle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original' }, assertCurrent: witness })
  const result = await h.client.refreshAgentSession('refresh-original')
  expect(result.run.runId).toBe('canonical-run')
  const observed = (async () => {
    await expect.poll(() => h.client.agentSession('refresh-original').nativeHandle?.sessionId).toBe('native-original')
  })()
  await expect(observed).resolves.toBeUndefined()
  expect(h.client.agentSession('refresh-original').nativeHandle?.sessionId).toBe('native-original')
  expect(discover).toHaveBeenCalledWith(expect.objectContaining({ processId: 12345, workspacePath: h.root }))
  expect(witness).toHaveBeenCalled(); expect((await h.read())!.nativeHandle?.sessionId).toBe('native-original')
  expect(h.inner.kernel.status.mock.calls.every(([id]: [string]) => id === 'canonical-run')).toBe(true); h.unchanged()
})

it('native observation failure keeps canonical refresh usable and preserves ordinary input', async () => {
  const h = await fixture(); await h.rebind()
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 12345 }))
  const discover = vi.spyOn(h.client.providers.get('codex'), 'discoverNativeSession').mockRejectedValue(new Error('Private native observation failed'))
  const errors: any[] = []; h.client.onEvent(event => { if (event.type === 'agent-error') errors.push(event) })
  expect((await h.client.refreshAgentSession('refresh-original')).run.runId).toBe('canonical-run')
  await expect.poll(() => discover.mock.calls.length).toBeGreaterThan(0)
  h.inner.nativeIdentityCaptures.get('refresh-original').controller.abort(new Error('End this private observation'))
  await expect.poll(() => errors.some(event => event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toBe(true)
  h.unchanged()
  await h.client.writeAgent({ agentSessionId: 'refresh-original', expectedRun: { runId: 'canonical-run' }, source: 'user', data: 'ordinary explicit input' })
  expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

async function endpoint(h: Awaited<ReturnType<typeof fixture>>, hosted?: any) {
  const server = new core.AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients,
    ...(hosted ? { hostedRuntime: () => hosted } : {}) })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'control.sock') } })
  cleanups.push(() => rpc.dispose()); return rpc
}

it('real public RPC and compiled CLI explicitly refresh the canonical original Session while inspect stays diagnostic', async () => {
  const h = await fixture(); await h.rebind()
  const refresh = vi.spyOn(h.client, 'refreshAgentSession'), rpc = await endpoint(h)
  await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'refresh-original' } })
  expect(refresh).not.toHaveBeenCalled()
  expect(await rpc.call('agent.refresh', { agentSessionId: 'refresh-original' })).toMatchObject({ session: { agentSessionId: 'refresh-original', hostId: 'local', run: { runId: 'canonical-run' } } })
  const cli = await runCompiledObjectCli(['agent', 'refresh', '--session', 'refresh-original'], objectCliEnvironment(h.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'agent.refresh', result: { session: { agentSessionId: 'refresh-original', run: { runId: 'canonical-run' } } } })
  expect(refresh).toHaveBeenCalledTimes(2); h.unchanged()
  const help = await runCompiledObjectCli(['agent', 'refresh', '--help'], objectCliEnvironment(h.root))
  expect(help.stdout).toContain('complete Session ID'); expect(help.stdout).toContain('asynchronously')
  const skill = await runCompiledObjectCli(['agent', '--skill'], objectCliEnvironment(h.root))
  expect(skill.stdout).toContain('agent refresh --session ID'); expect(skill.stdout).toContain('neither promises a native identity nor reopens')
})

it('public refresh keeps complete target and ambiguity boundaries rather than choosing a prefix owner', async () => {
  const h = await fixture()
  const original = new core.AgentMuxRpcService({ coreClients: h.coreClients }); cleanups.push(() => original.dispose())
  await expect(original.call('agent.refresh', { agentSessionId: 'refresh' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const foreign = Object.assign(Object.create(h.client), { readAgentSessions: async () => h.client.agentSessions(), agentSessions: () => h.client.agentSessions() })
  const service = new core.AgentMuxRpcService({ coreClients: () => [...h.coreClients(), { hostId: 'local', client: foreign }] })
  cleanups.push(() => service.dispose())
  await expect(service.call('agent.refresh', { agentSessionId: 'refresh-original' })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  h.unchanged()
})

it('compiled CLI rejects a refresh owner returning a foreign Host', async () => {
  const h = await fixture(); await endpoint(h)
  vi.spyOn(h.client, 'refreshAgentSession').mockResolvedValue({ ...h.client.agentSession('refresh-original'), hostId: 'foreign-host' })
  const result = await runCompiledObjectCli(['agent', 'refresh', '--session', 'refresh-original'], objectCliEnvironment(h.root))
  expect(result.code).toBe(1); expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } }); h.unchanged()
})

it('the public wire reader refuses another Session in a refresh response', async () => {
  const h = await fixture(), probe = new ObjectCliProbe(() => ({ session: { ...h.client.agentSession('refresh-original'), agentSessionId: 'foreign-original' } }))
  await probe.start(); cleanups.push(() => probe.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } }); cleanups.push(() => rpc.dispose())
  await expect(rpc.call('agent.refresh', { agentSessionId: 'refresh-original' })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }); h.unchanged()
})

it('the existing Hosted refresh method carries an omitted fence and retains explicit fences', async () => {
  const h = await fixture(); vi.spyOn(h.client, 'connect').mockResolvedValue(undefined)
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'refresh-owner', protocolVersion: 1, buildIdentity: 'refresh-build' })
  const hosted = new core.AgentMuxHostedRuntimeService(h.client, h.store.path, () => ({ runtimeId: 'refresh-runtime', ownerInstanceId: 'refresh-owner', protocolVersion: 2, processId: process.pid, ctxmux: h.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose()); const rpc = await endpoint(h, hosted)
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  const previous = h.client.agentSession('refresh-original').run; await h.rebind()
  expect((await reader.refreshAgentSession('refresh-original')).run.runId).toBe('canonical-run')
  await expect(reader.refreshAgentSession('refresh-original', previous)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' }); h.unchanged()
})
