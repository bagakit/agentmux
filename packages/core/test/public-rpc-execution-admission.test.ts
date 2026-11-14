import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionBindingService, type AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { createCoreExecutionBindingClient } from '../../../apps/desktop/src/main/execution-binding-client.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close() })
const input: AgentExecutionOpenInput = { bindingId: 'original-binding', agentHostId: 'agent-host', agentRuntimeId: 'agent-core',
  resourceHostId: 'local', resourceRuntimeId: 'source-core', resourceWorkspacePath: '/original/project', sourceRequestDigest: 'd'.repeat(64),
  resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-session', createOperationId: 'original-creation',
    executorId: 'selected', executorRevision: 'original-revision', workspacePath: '/original/agent', prompt: 'PRIVATE ORIGINAL PROMPT', sourceAgentMuxNote: 'PRIVATE ORIGINAL SOURCE NOTE' } }
const reference = { bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-admit-public-')); releases.push(() => rm(root, { recursive: true, force: true }))
  const resolveHost = vi.fn(async () => { throw Error('Admission must not resolve or prepare an endpoint') })
  let service = new AgentExecutionBindingService(join(root, 'execution-bindings'), { resolveHost })
  let core = new AgentMuxControlServer({ socketPath: join(root, 'core.sock'), executionBindings: service, forwardingPeer: { authoritySocketPath: join(root, 'main.sock') } }); await core.start()
  releases.push(async () => { await core.stop(); await service.dispose() })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: core.path } }); releases.push(() => rpc.dispose())
  // Only the Runtime routing port is controlled. Main's facade, both Unix
  // services, strict SDK/CLI codecs, journal and binding owner are production.
  const client = createCoreExecutionBindingClient({ callOriginalCore: async (_host, method, params, context) => rpc.call(method, params, {
    ...(context.caller ? { credentials: context.caller } : {}), ...(context.signal ? { signal: context.signal } : {}),
    ...(context.forwarding ? { forwarding: context.forwarding } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {})
  }), subscribeOriginalCore: async () => { throw Error('No watch belongs to an admission') } })
  const main = new AgentMuxControlServer({ socketPath: join(root, 'main.sock'), executionBindings: client, forwardingPeer: { authoritySocketPath: core.path } }); await main.start(); releases.push(() => main.stop())
  const mainRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: main.path } }); releases.push(() => mainRpc.dispose())
  const reopen = async () => {
    await core.stop(); await service.dispose()
    service = new AgentExecutionBindingService(join(root, 'execution-bindings'), { resolveHost })
    core = new AgentMuxControlServer({ socketPath: join(root, 'core.sock'), executionBindings: service, forwardingPeer: { authoritySocketPath: join(root, 'main.sock') } }); await core.start()
  }
  return { root, resolveHost, main, mainRpc, reopen }
}
it('actual admit CLI and Main/Core SDK acknowledge only the original durable reference, with zero endpoint effects across reopen', async () => {
  const f = await fixture()
  const cli = await runSourceObjectCli(['agent', 'execution', 'admit', '--input', '-'], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + f.main.path }), JSON.stringify(input))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'agent.execution.admit', result: reference })
  expect(cli.stdout).not.toContain('PRIVATE ORIGINAL')
  expect(await f.mainRpc.call('agent.execution.admit', input)).toEqual(reference)
  await f.reopen()
  const retained = await f.mainRpc.call('agent.execution.binding', { bindingId: input.bindingId, view: 'association' })
  expect(retained).toMatchObject({ continuation: reference, association: { state: 'confirmed', reference, sourceRequestDigest: input.sourceRequestDigest,
    agent: { executorId: input.agent.executorId, executorRevision: input.agent.executorRevision, workspacePath: input.agent.workspacePath } } })
  expect(JSON.stringify(retained)).not.toContain('PRIVATE ORIGINAL')
  await expect(f.mainRpc.call('agent.execution.admit', { ...input, agent: { ...input.agent, sourceAgentMuxNote: 'CURRENT REPLACEMENT' } })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
  expect(await f.mainRpc.call('agent.execution.admit', input)).toEqual(reference)
  expect(f.resolveHost).not.toHaveBeenCalled()
})
it('admission keeps managed caller denial, exact receipts and malformed intent independent of healthy original work', async () => {
  const f = await fixture()
  await expect(f.mainRpc.call('agent.execution.admit', input, { credentials: { agentSessionId: 'managed', capability: 'original-capability' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await f.mainRpc.call('agent.execution.binding', { bindingId: input.bindingId })).toBeNull()
  expect(await f.mainRpc.call('agent.execution.admit', input)).toEqual(reference)
  for (const sourceRequestDigest of ['', 'bad', [input.sourceRequestDigest]]) {
    await expect(f.mainRpc.call('agent.execution.admit', { ...input, sourceRequestDigest } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  for (const result of [{ ...reference, createOperationId: 'other' }, { ...reference, agentSessionId: 'other' }, { ...reference, prompt: input.agent.prompt }]) {
    expect(() => parseRpcNativeResult('agent.execution.admit', result, input)).toThrow()
  }
  expect(await f.mainRpc.call('agent.execution.admit', input)).toEqual(reference)
  expect(f.resolveHost).not.toHaveBeenCalled()
})
