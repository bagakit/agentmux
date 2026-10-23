import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConnectionIngressReadPort } from '@agentmux/core/connections'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { createRpcExternalInputAuthority } from '../../../packages/connectors/test/helpers/rpc-external-input-authority.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const witness = (fact: unknown) => { if (process.env.HOST_BRIDGE_FACTS) appendFileSync(process.env.HOST_BRIDGE_FACTS, JSON.stringify(fact) + '\n') }

async function fixture(explicitAuthority = false) {
  const original = await rpcOwnerFixture(['original-agent'], core)
  cleanup.push(original.close)
  const services = await createConnectionServices({ directory: join(original.root, 'client-connections'), adapters: [] })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'client-secret', secret: 'synthetic-client-secret' })
  const configured = await services.connections.configure({ operationId: 'client-configure', expectedRevision: null,
    connection: { connectionId: 'client-bot', adapterId: 'fixture', application: { domain: 'chat.example', appId: 'client-app' }, label: 'Original client bot', enabled: false, credentialRef: credential.credentialRef } })
  const configure = vi.spyOn(services.connections, 'configure')
  const list = vi.spyOn(services.connections, 'list')
  const recordAuthority = vi.fn<ConnectionIngressReadPort['recordAuthority']>(async input => ({ authority: 'current', message: { ...input, hostId: 'local', body: 'Original observed group record', author: {
    kind: 'external', connectionId: 'client-bot', actor: { application: { domain: 'chat.example', appId: 'client-app' }, idType: 'email', userId: 'member@example.test' }, externalConversationId: 'client-room', externalMessageId: 'client-message', bindingId: 'client-binding', bindingRevision: 1
  } } }))
  const unavailable = async (): Promise<never> => { throw new core.AgentMuxError('This sentinel only exposes its original record lookup.', 'CONTROL_UNAVAILABLE') }
  services.connections.ingress = { recordAuthority, authority: unavailable, inspect: unavailable, list: unavailable }
  const catalog = core.spatialCatalog({ spaces: [{ spaceId: 'client-space', name: 'Original client space', kind: 'topic' as const, hostId: 'local', directoryPath: original.root, projectId: 'project' }], zones: [], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} })
  const execute = vi.fn(async () => ({ catalog }))
  const mote = vi.fn<NonNullable<core.AgentMuxControlServerOptions['forwardControl']>>(async method => {
    if (method === 'space.mote.chat.inspect') return { configuration: null, operation: null } as never
    if (method === 'space.mote.connection.inspect') return { operation: null } as never
    throw new core.AgentMuxError('Only the exact controlled Mote receipt is available.', 'CONTROL_UNAVAILABLE')
  })
  const desktop = new core.AgentMuxControlServer({ socketPath: join(original.root, 'client.sock'), coreClients: () => [], connections: services.connections, forwardControl: async (method, params, context) => method === 'space.ls' ? await execute() as never : await mote(method, params, context) })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const desktopRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); cleanup.push(() => desktopRpc.dispose())
  expect((await desktopRpc.call('connection.ls', {})).connections).toEqual([configured.connection])
  expect(await desktopRpc.call('space.mote.chat.inspect', { operationId: 'client-chat' })).toEqual({ configuration: null, operation: null })
  expect(await desktopRpc.call('space.mote.connection.inspect', { operationId: 'client-mote' })).toEqual({ operation: null })
  expect((await desktopRpc.call('connection.ingress.record-authority', { agentSessionId: 'original-agent', ingressId: 'client-ingress' })).message?.body).toBe('Original observed group record')
  const watch = await desktopRpc.subscribe('connection.metadata.watch', {}, {}); await watch.dispose()
  list.mockClear(); recordAuthority.mockClear(); mote.mockClear()
  const native = original.inner.kernel
  await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    this.providers.get('codex').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'host.sock'), desktopSocketPath: desktop.path,
      mobileBuildDirectory: join(original.root, 'absent-mobile'), ...(explicitAuthority ? { externalInputAuthority: createRpcExternalInputAuthority({ socketPath: desktop.path, executionHostId: 'local' }) } : {}) })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } }); cleanup.push(() => rpc.dispose())
  return { original, services, configured, desktopRpc, host, rpc, configure, list, recordAuthority, mote, execute, catalog, native }
}

it('a bare Host refuses the available client connection owner while its Core and generic client bridge stay usable', async () => {
  const f = await fixture(), outcomes: unknown[] = []
  const calls = [
    ['connection.ls', {}],
    ['connection.configure', { operationId: 'wrong-owner-configure', expectedRevision: 1, connection: { ...f.configured.connection.config, label: 'Must not reach the client' } }],
    ['space.mote.chat.inspect', { operationId: 'client-chat' }],
    ['space.mote.connection.inspect', { operationId: 'client-mote' }],
    ['space.mote.preferences.read', { kind: 'connection', target: { spaceId: 'client-space', zoneId: 'client-zone', expectedResource: { hostId: 'local', workspaceId: 'client-workspace', workspacePath: f.original.root } } }]
  ] as const
  for (const [method, params] of calls) outcomes.push({ method, ...await f.rpc.call(method, params as never).then(value => ({ value }), error => ({ error: error.code })) })
  const watch = await f.rpc.subscribe('connection.metadata.watch', {}, {}).then(async value => { await value.dispose(); return 'subscribed' }, error => error.code)
  const record = await f.rpc.call('agent.conversation.record', { hostId: 'local', agentSessionId: 'original-agent', ingressId: 'client-ingress' }).then(value => ({ value }), error => ({ error: error.code }))
  const captured = (await f.original.store.readCapturedHistory('original-agent')).records
  const clientConfig = await f.services.connections.inspect({ connectionId: 'client-bot' })
  // Exercise real original byte input, independently of the absent connection owner.
  await f.host.client.submitAgentPrompt({ agentSessionId: 'original-agent', ...core.agentPromptCondition((await f.host.client.readAgentSession('original-agent'))!), operationId: 'healthy-local-input', prompt: 'Healthy original local input', authorHuman: true, allowUncertainTurn: true })
  const forwarded = await f.rpc.call('space.ls', { target: {} })
  witness({ case: 'bare-host-no-client-owner', configured: f.configured, outcomes, watch, record, capturedCount: captured.length, clientConfig,
    clientConnectionLists: f.list.mock.calls.length, clientConfigurationWrites: f.configure.mock.calls.length, clientRecordAuthorityReads: f.recordAuthority.mock.calls.length,
    clientMoteReads: f.mote.mock.calls.length, genericBridgeCalls: f.execute.mock.calls.length, originalInputWrites: (f.native.input as ReturnType<typeof vi.fn>).mock.calls.length })
  expect(outcomes).toEqual(calls.map(([method]) => ({ method, error: 'CONTROL_UNAVAILABLE' })))
  expect(watch).toBe('CONTROL_UNAVAILABLE'); expect(record).toEqual({ error: 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE' })
  expect(captured).toEqual([]); expect(clientConfig.connection).toEqual(f.configured.connection)
  expect(f.list).not.toHaveBeenCalled(); expect(f.configure).not.toHaveBeenCalled(); expect(f.recordAuthority).not.toHaveBeenCalled(); expect(f.mote).not.toHaveBeenCalled()
  expect(forwarded.catalog).toEqual(f.catalog); expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.native.input).toHaveBeenCalledTimes(1); expect(f.native.stop).not.toHaveBeenCalled(); expect(f.native.attach).not.toHaveBeenCalled()
})

it('an explicitly supplied RPC authority still records the original source without making it a default Host owner', async () => {
  const f = await fixture(true), input = { hostId: 'local', agentSessionId: 'original-agent', ingressId: 'client-ingress' }
  const result = await f.rpc.call('agent.conversation.record', input)
  const again = await f.rpc.call('agent.conversation.record', input)
  const records = (await f.original.store.readCapturedHistory('original-agent')).records
  witness({ case: 'explicit-rpc-authority', result, again, originalRecords: records.map(row => ({ id: row.item.id, body: row.item.content })), authorityReads: f.recordAuthority.mock.calls.length })
  expect(result).toEqual(again); expect(records).toHaveLength(1); expect(records[0]!.item.content).toBe('Original observed group record')
  expect(f.recordAuthority.mock.calls.length).toBeGreaterThan(1); expect(f.native.input).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
  await expect(f.rpc.call('connection.ls', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.list).not.toHaveBeenCalled()
})
