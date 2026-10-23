// @vitest-environment happy-dom
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { act } from 'react'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxHostedRuntimeService, connectAgentMuxRpc } from '@agentmux/core'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { createCredentialAdministration } from '../../host/src/credential-administration.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import type { ConnectionHostIpc } from '../src/main/connection-host-ipc.js'
import type { ConnectionHostingTarget } from '../src/shared/contracts.js'
import { ExternalConnectionsSettings } from '../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { api } from '../src/renderer/src/lib/api'
import { connectionSettingsPort } from '../src/renderer/src/lib/connection-settings-port'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { feishuConfig, feishuPayload, defaultFeishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'

const dom = composerDOM(), cleanup: Array<() => Promise<void> | void> = []
const hostingTarget: ConnectionHostingTarget = { hostId: 'local', runtimeId: 'settings-adapter-runtime' }, connections = connectionSettingsPort(hostingTarget)
let services: Awaited<ReturnType<typeof createConnectionServices>>, sdk: ReturnType<typeof defaultFeishuSdkTransport>
beforeEach(async () => {
  const config = useAppStore.getState().config!
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  window.localStorage.clear(); await useAppStore.persist.rehydrate()
  const stop = await useAppStore.getState().initialize(); stop()
  const original = await ingressFixture(true, feishuConfig); cleanup.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  // The original private Store and default registry are real; only native I/O and owner identity are controlled.
  services = await createConnectionServices({ directory: join(original.root, 'settings-feishu'),
    bindings: { spatial: original.spatial, checkpoint: async ref => await original.client.conversationCheckpoint(ref) },
    ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const owner = { runtimeId: hostingTarget.runtimeId, ownerInstanceId: 'settings-adapter-owner', protocolVersion: 2, processId: process.pid, availability: 'connected' as const, ctxmux: original.client.runtimeIdentity() }
  const hosted = new AgentMuxHostedRuntimeService(original.client, original.store.path, () => owner)
  cleanup.push(() => hosted.dispose())
  services.connections.credential = createCredentialAdministration({ target: owner, secrets: services.secrets })
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'settings.sock'), connections: services.connections, coreClients: original.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  cleanup.push(() => rpc.dispose())
  await expect(rpc.call('connection.credential.store', { operationId: 'wrong-instance-entry', secret: 'controlled-not-stored' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: 'previous-owner' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(await services.secrets.inspect('wrong-instance-entry')).toBeNull()
  const runtime: ConnectionHostIpc = {
    connectionHostingTarget: async () => hostingTarget,
    callConnectionHost: (target, method, params) => { expect(target).toEqual(hostingTarget); return rpc.call(method, params) },
    watchConnectionMetadata: (target, handlers) => { expect(target).toEqual(hostingTarget); return rpc.subscribe('connection.metadata.watch', {}, handlers) }
  }
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const sender = {}, ipc = registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: (_channel, event) => expect(event.sender).toBe(sender), runtime, metadata: { publish() {}, observation() {} } })
  cleanup.push(ipc.dispose)
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, params, target) => unwrapSessionInputOperationResult(await handlers.get('connections:call')!({ sender }, method, params, target)))
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(async (input, target) => handlers.get('connections:storeCredential')!({ sender }, input, target))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(async (operationId, target) => handlers.get('connections:inspectCredential')!({ sender }, operationId, target))
})
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close() })
async function fill(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function saved() {
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Application saved.') })
  return (await services.connections.list()).connections[0]!
}

describe('Mounted Settings preserves the registered adapter identity', () => {
  it.each(['open.feishu.cn', 'open.larksuite.com'])('starts the original default SDK receiver after saving %s', async domain => {
    await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-enrollment-existing]')).not.toBeNull() })
    await dom.click('[data-enrollment-existing]')
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[aria-label="Connection app ID"]')).not.toBeNull() })
    await act(async () => { dom.container.querySelector<HTMLDetailsElement>('.connector-optional')!.open = true }); await fill('Connection name', 'Original team application'); await fill('Connection app ID', feishuConfig.application.appId); await fill('Connection app secret', 'fixture-credential')
    const platform = dom.container.querySelector<HTMLSelectElement>('[aria-label="Connection platform"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(platform, domain); platform.dispatchEvent(new Event('change', { bubbles: true })) })
    await dom.click('[data-connection-save]')
    const record = await saved()
    const [entered, target] = vi.mocked(api.connections.storeCredential).mock.calls[0]!
    expect(entered.secret).toBe('fixture-credential'); expect(target).toEqual(hostingTarget)
    expect(await api.connections.inspectCredential(entered.operationId, hostingTarget)).toEqual({ credentialRef: record.config.credentialRef })
    await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
    expect(record.config).toMatchObject({ adapterId: 'feishu', application: { domain, appId: feishuConfig.application.appId } })
    await sdk.receive(feishuPayload())
    expect(sdk.ack()).toEqual([{ code: 200 }])
    const retained = await services.ingress!.list({ connectionId: record.config.connectionId })
    expect(retained.ingresses).toHaveLength(1)
    expect(retained.ingresses[0]).toMatchObject({ externalMessageId: 'platform-message', externalConversationId: 'original-room', body: JSON.parse(feishuPayload().event.message.content).text })
    const raw = services.database!.prepare('SELECT raw_payload FROM connection_ingress_event').get()!
    expect(JSON.parse(String(raw.raw_payload))).toEqual(feishuPayload())
    const evidence = resolve('.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/settings-adapter-consumer')
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, domain === 'open.feishu.cn' ? 'feishu.json' : 'lark.json'), JSON.stringify({
      scope: 'Mounted production Settings through trusted IPC, original Core Unix RPC/Hosted runtime fence and Host credential administration on one private SQLite Store; default adapter registry and controlled SDK network I/O/owner identity. No default RuntimeController, live platform or Native qualification.',
      saved: { connectionId: record.config.connectionId, revision: record.revision, adapterId: record.config.adapterId, application: record.config.application },
      sdkReceivers: sdk.sockets.length, sdkAck: sdk.ack(), durableEvent: { ingressId: retained.ingresses[0]!.ingressId, externalMessageId: retained.ingresses[0]!.externalMessageId, body: retained.ingresses[0]!.body }
    }, null, 2) + '\n')
  })
  it.each(['feishu', 'lark'])('edits an existing %s identity without replacing or aliasing it', async adapterId => {
    const credential = await services.secrets.store({ operationId: 'seed-credential', secret: 'fixture-credential' })
    await services.connections.configure({ operationId: 'seed-application', expectedRevision: null, connection: { ...feishuConfig, adapterId, credentialRef: credential.credentialRef, enabled: false } })
    await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection]')).not.toBeNull() })
    await dom.click('[data-connection] button:first-of-type'); await dom.click('[data-connection-editor] .connector-editor-actions .small-button'); await fill('Connection name', 'Renamed original application')
    await dom.click('[data-connection-save]')
    const record = await saved()
    expect(record.revision).toBe(2)
    expect(record.config).toMatchObject({ connectionId: feishuConfig.connectionId, adapterId, label: 'Renamed original application', enabled: false, credentialRef: credential.credentialRef })
    expect(sdk.sockets).toHaveLength(0)
    expect(sdk.request).not.toHaveBeenCalled()
  })
})
