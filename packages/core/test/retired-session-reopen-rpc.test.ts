import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
async function endpoint(transport: 'unix' | 'http') {
  const f = await retiredReopenFixture(); close.push(f.close)
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-reopen-runtime', ownerInstanceId: 'private-reopen-owner',
    protocolVersion: 1, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => identity); close.push(() => hosted.dispose())
  const owner = new AgentMuxControlServer({ socketPath: join(f.root, 'public.sock'),
    coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted,
    ...(transport === 'http' ? { http: { host: '127.0.0.1', port: 0, token: 'private-reopen' } } : {}) })
  close.push(() => owner.stop()); await owner.start()
  const rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix'
    ? { transport, path: join(f.root, 'public.sock') }
    : { transport, url: `http://127.0.0.1:${owner.httpAddress!.port}/`, token: 'private-reopen' } })
  close.push(() => rpc.dispose()); return { ...f, owner, rpc }
}
it.each(['unix', 'http'] as const)('typed agent.reopen over real %s returns the same native identity and original retirement facts', async transport => {
  const f = await endpoint(transport), result = await f.rpc.call('agent.reopen', f.input)
  expect(result.session.agentSessionId).toBe(f.old.agentSessionId)
  expect(result.session.nativeHandle).toEqual(f.old.nativeHandle)
  expect(result.session.reopenedFrom).toEqual({ run: f.old.run, source: 'user', observedAt: f.retired.observedAt })
  expect(result.session.retiredRuns).toEqual([f.old.run]); expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it.each(['unix', 'http'] as const)('the actual Hosted %s consumer delegates explicit reopen to the one Core', async transport => {
  const f = await endpoint(transport), sdk = await connectHostedAgentMux({ rpc: f.rpc }); close.push(() => sdk.dispose())
  const result = await sdk.reopenAgent(f.input)
  expect(result.agentSessionId).toBe(f.old.agentSessionId); expect(result.run).toEqual({ runId: 'new-run-1' })
  expect(sdk.agentSession(f.old.agentSessionId).nativeHandle).toEqual(f.old.nativeHandle)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('the real CLI parser and execution use the same public RPC owner without a second control route', async () => {
  const f = await endpoint('unix')
  const { stdout } = await promisify(execFile)(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', `unix:${join(f.root, 'public.sock')}`,
    'agent', 'reopen', '--session', f.old.agentSessionId, '--retired-at', String(f.retired.observedAt), '--operation-id', 'cli-explicit-continue'],
    { env: { ...process.env }, timeout: 10_000 })
  const response = JSON.parse(stdout)
  expect(response).toMatchObject({ ok: true, result: { session: { agentSessionId: f.old.agentSessionId, run: { runId: 'new-run-1' } } } })
  expect(f.starts).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('managed Agent and unapproved calls cannot mint user reopen authority', async () => {
  const f = await retiredReopenFixture(); close.push(f.close)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); close.push(() => service.dispose())
  for (const context of [{ transport: 'unix' as const }, { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'private-user' },
    caller: { agentSessionId: 'unrelated-agent', capability: 'no-user-authority' } }]) {
    await expect(service.call('agent.reopen', f.input, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(f.starts).toEqual([]); expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})
it('strict public route rejects a hidden prompt and another retirement epoch without dispatching a launch', async () => {
  const f = await endpoint('unix')
  await expect(f.rpc.call('agent.reopen', { ...f.input, prompt: 'never send' } as any)).rejects.toBeInstanceOf(Error)
  await expect(f.rpc.call('agent.reopen', { ...f.input, expectedRetiredAt: f.retired.observedAt + 1 })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(f.starts).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['unix', 'http'] as const)('real %s Hosted and typed confirmation complete the original prepared lost-ACK Run with no resend', async transport => {
  const f = await endpoint(transport), sdk = await connectHostedAgentMux({ rpc: f.rpc }); close.push(() => sdk.dispose())
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private native start ACK lost') })
  await expect(sdk.reopenAgent(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  expect(await f.client.readAgentSessions()).toEqual([])
  const before = await readFile(f.storePath)
  const sources = await sdk.sessionHistorySources()
  const original = sources.find(source => source.agentSessionId === f.old.agentSessionId && source.hostId === 'local')!
  expect(original.pendingReopen).toEqual({ operationId: f.input.operationId })
  expect(original).not.toHaveProperty('run'); expect(original).not.toHaveProperty('hookToken')
  expect(await readFile(f.storePath)).toEqual(before)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([])
  const recoveredInput = { agentSessionId: original.agentSessionId, expectedRetiredAt: original.retiredAt!, operationId: original.pendingReopen!.operationId! }
  const result = (await f.rpc.call('agent.reopen.check', recoveredInput)).session
  expect(result.run).toEqual({ runId: 'new-run-1' }); expect(result.nativeHandle).toEqual(f.old.nativeHandle)
  const typed = await f.rpc.call('agent.reopen.check', f.input)
  expect(typed.session.run).toEqual(result.run); expect(sdk.agentSession(f.old.agentSessionId).nativeHandle).toEqual(f.old.nativeHandle)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('confirmation keeps the original user authority and strict exact-operation fields', async () => {
  const f = await endpoint('unix'), service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); close.push(() => service.dispose())
  await expect(service.call('agent.reopen.check', f.input, { transport: 'unix', principal: { kind: 'user', id: 'private-user' },
    caller: { agentSessionId: 'unrelated-agent', capability: 'no-user-authority' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.rpc.call('agent.reopen.check', { ...f.input, commandOverride: 'forbidden-new-launch' } as any)).rejects.toBeInstanceOf(Error)
  expect(f.starts).toEqual([]); expect(f.stops).toEqual([])
})
