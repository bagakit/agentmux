import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { AgentMuxError } from '../src/errors.js'
import type { ConnectionApiCallContext, ConnectionApiOperation, ConnectionPort } from '../src/connections.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { apiIdentity, apiInput, apiOperation } from './fixtures/connection-api.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const facts = (value: unknown) => { if (process.env.CONNECTION_API_FACTS) appendFileSync(process.env.CONNECTION_API_FACTS, JSON.stringify(value) + '\n') }
async function fixture() {
  const core = await rpcOwnerFixture(['original-agent']); cleanup.push(core.close)
  const calls: Array<{ kind: string; context: ConnectionApiCallContext }> = [], saved = new Map<string, ConnectionApiOperation>()
  const owner: ConnectionPort = { list: async () => ({ connections: [] }), inspect: async () => ({ connection: null, operation: null }),
    configure: async () => { throw Error('Native API does not grant configuration') }, test: async () => { throw Error('Not used') },
    api: {
      identities: vi.fn(async (input, context) => { await context.assertCurrent?.(); calls.push({ kind: 'identities', context }); return { identities: [{ ...apiIdentity, agentSessionId: input.agentSessionId }] } }),
      request: vi.fn(async (input, context) => { await context.assertCurrent?.(); calls.push({ kind: 'request', context }); const result = apiOperation(input); saved.set(input.operationId, result); return result }),
      inspect: vi.fn(async (input, context) => { calls.push({ kind: 'inspect', context }); return { operation: saved.get(input.operationId) ?? null } })
    } }
  const server = new AgentMuxControlServer({ socketPath: join(core.root, 'api.sock'), coreClients: core.coreClients, connections: owner })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: core.credentials }); cleanup.push(() => sdk.dispose())
  return { ...core, calls, owner, server, sdk }
}

it('actual public SDK reaches only the new bound-identity port with authenticated original actor/Session; old administration stays restricted', async () => {
  const f = await fixture()
  expect(await f.sdk.call('connection.api.identities', { agentSessionId: 'original-agent' })).toEqual({ identities: [apiIdentity] })
  expect(await f.sdk.call('connection.api.request', apiInput)).toEqual(apiOperation())
  expect(await f.sdk.call('connection.api.inspect', { operationId: apiInput.operationId })).toEqual({ operation: apiOperation() })
  expect(f.calls.map(c => c.kind)).toEqual(['identities', 'request', 'inspect'])
  for (const call of f.calls) expect(call.context).toMatchObject({ actor: { kind: 'agent', id: 'original-agent' }, session: { hostId: 'local', agentSessionId: 'original-agent' } })
  await expect(f.sdk.call('connection.api.identities', { agentSessionId: 'foreign-agent' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.calls).toHaveLength(3)
  await expect(f.sdk.call('connection.configure', { operationId: 'forged-admin', expectedRevision: null,
    connection: { connectionId: 'foreign', adapterId: 'native-protocol', application: apiIdentity.application, label: 'No grant', enabled: true, credentialRef: 'no-access' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  facts({ phase: 'bound-public-core', methods: f.calls.map(c => c.kind), actor: f.calls[0]!.context.actor, session: f.calls[0]!.context.session, oldAdministrationDenied: true })
})

it('forwarding retains original context and authenticated semantic Session instead of a remote routing alias', async () => {
  const f = await fixture()
  // A forwarded semantic client authenticates the real stored local Session;
  // its outer routing alias is not that Session's execution identity.
  Object.defineProperty(f.client, 'forwardRpc', { configurable: true, value: vi.fn() })
  const scopes = () => [{ hostId: 'remote-display-alias', client: f.client }]
  const downstream = new AgentMuxRpcService({ coreClients: scopes, connections: f.owner }); cleanup.push(() => downstream.dispose())
  const forward = vi.fn(async (method, input, context) => downstream.call(method, input, context))
  const service = new AgentMuxRpcService({ coreClients: scopes, forwardControl: forward as never }); cleanup.push(() => service.dispose())
  const context = { caller: f.credentials, transport: 'unix' as const }
  expect(await service.call('connection.api.request', apiInput, context)).toEqual(apiOperation())
  expect(forward).toHaveBeenCalledOnce(); expect(forward.mock.calls[0]![2]).toBe(context)
  expect(f.calls[0]!.context.session).toEqual({ hostId: 'local', agentSessionId: 'original-agent' })
  expect(f.calls[0]!.context.actor).toEqual({ kind: 'agent', id: 'original-agent' })
})

it('no-actor and unsupported-owner failures are precise and do not control or revoke healthy local input', async () => {
  const f = await fixture(), service = new AgentMuxRpcService({ coreClients: f.coreClients, connections: { ...f.owner, api: undefined } as never })
  cleanup.push(() => service.dispose())
  await expect(service.call('connection.api.request', apiInput)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('connection.api.request', apiInput, { caller: f.credentials })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.calls).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.client.readAgentSession('original-agent'))!.run.runId).toBe('run-original-agent')
})

it('strict public result association refuses a wrong original operation before returning it to an authenticated caller', async () => {
  const f = await fixture()
  vi.mocked(f.owner.api!.request).mockResolvedValue({ ...apiOperation(), operationId: 'foreign-op' })
  await expect(f.sdk.call('connection.api.request', apiInput)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_API_DATA' })
  vi.mocked(f.owner.api!.request).mockImplementation(async (_input, context) => { await context.assertCurrent?.(); throw new AgentMuxError('Original actor changed.', 'CONTROL_PERMISSION_DENIED') })
  await expect(f.sdk.call('connection.api.request', apiInput)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
})

it('checks a supplied original Runtime fence before the call and again at the Host pre-effect assertion, without requiring one for ordinary calls', async () => {
  const f = await fixture()
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => identity); cleanup.push(() => hosted.dispose())
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, connections: f.owner, hostedRuntime: () => hosted }); cleanup.push(() => service.dispose())
  const context = { caller: f.credentials, runtimeFence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId } }
  expect(await service.call('connection.api.request', apiInput, context)).toEqual(apiOperation())
  f.calls.length = 0
  await expect(service.call('connection.api.request', apiInput, { ...context, runtimeFence: { ...context.runtimeFence, runtimeId: 'foreign-runtime' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.calls).toEqual([])
  vi.mocked(f.owner.api!.request).mockImplementation(async (_input, original) => {
    identity.ownerInstanceId = 'replacement-instance'
    await original.assertCurrent?.()
    throw Error('A changed Runtime must refuse before any effect')
  })
  await expect(service.call('connection.api.request', apiInput, context)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(f.calls).toEqual([])
})

it('actual compiled CLI discovers identities, consumes literal stdin/file request JSON and inspects the same operation', async () => {
  const f = await fixture()
  const env = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability })
  const cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', 'unix:' + f.server.path, 'connection', 'api', ...args], env, stdin)
  const identity = await cli(['identities', '--session', 'original-agent'])
  expect(identity.code, identity.stdout + identity.stderr).toBe(0); expect(JSON.parse(identity.stdout).result.identities).toEqual([apiIdentity])
  const input = { ...apiInput, request: { ...apiInput.request, body: { text: 'literal $HOME `not executed` $(not-executed)' } } }
  const requested = await cli(['request', '--input', '-'], JSON.stringify(input))
  expect(requested.code, requested.stdout + requested.stderr).toBe(0); expect(JSON.parse(requested.stdout).result).toEqual(apiOperation(input))
  const path = join(f.root, 'original-request.json'), second = { ...input, operationId: 'second-original' }
  await writeFile(path, JSON.stringify(second)); const file = await cli(['request', '--input', path])
  expect(file.code, file.stdout + file.stderr).toBe(0); expect(JSON.parse(file.stdout).result).toEqual(apiOperation(second))
  const inspected = await cli(['inspect', '--operation-id', input.operationId])
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result).toEqual({ operation: apiOperation(input) })
  const help = await runCompiledObjectCli(['connection', 'api', 'request', '--help'], env)
  expect(help.code, help.stdout + help.stderr).toBe(0); expect(help.stdout).toContain('256 KiB'); expect(help.stdout).toContain('4 MiB'); expect(help.stdout).toContain('operationId')
  facts({ phase: 'compiled-cli-core', methods: f.calls.map(c => c.kind), stdinLiteral: true, fileRequest: true, originalInspect: true })
})
