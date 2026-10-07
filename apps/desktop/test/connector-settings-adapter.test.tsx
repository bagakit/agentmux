// @vitest-environment happy-dom
import { act } from 'react'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/dist/index.js'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { ExternalConnectionsSettings } from '../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { feishuConfig, feishuPayload, defaultFeishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'

const dom = composerDOM(), cleanup: Array<() => Promise<void> | void> = []
let services: Awaited<ReturnType<typeof createDesktopConnections>>, sdk: ReturnType<typeof defaultFeishuSdkTransport>
beforeEach(async () => {
  const original = await ingressFixture(true, feishuConfig); cleanup.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  // Only encryption and platform network I/O are controlled. The original default registry is used.
  services = await createDesktopConnections({ directory: join(original.root, 'settings-feishu'),
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    bindings: { spatial: original.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await original.client.conversationCheckpoint(ref.agentSessionId) }) },
    ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'settings.sock'), connections: services.connections, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: () => {}, socketPath: server.path, secrets: services.secrets })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, params) => handlers.get('connections:call')!({}, method, params))
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(async input => handlers.get('connections:storeCredential')!({}, input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(async operationId => handlers.get('connections:inspectCredential')!({}, operationId))
})
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close() })
async function fill(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function saved() {
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Connection saved.') })
  return (await services.connections.list()).connections[0]!
}

describe('Mounted Settings preserves the registered adapter identity', () => {
  it.each(['open.feishu.cn', 'open.larksuite.com'])('starts the original default SDK receiver after saving %s', async domain => {
    await dom.render(<ExternalConnectionsSettings active />)
    await fill('Connection name', 'Original team application'); await fill('Connection app ID', feishuConfig.application.appId); await fill('Connection app secret', 'fixture-credential')
    const platform = dom.container.querySelector<HTMLSelectElement>('[aria-label="Connection platform"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(platform, domain); platform.dispatchEvent(new Event('change', { bubbles: true })) })
    await dom.click('[data-connection-save]')
    const record = await saved()
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
      scope: 'Mounted production Settings through trusted IPC, public Core and default Desktop Host; controlled encryption and pinned SDK network I/O. No live platform or Native qualification.',
      saved: { connectionId: record.config.connectionId, revision: record.revision, adapterId: record.config.adapterId, application: record.config.application },
      sdkReceivers: sdk.sockets.length, sdkAck: sdk.ack(), durableEvent: { ingressId: retained.ingresses[0]!.ingressId, externalMessageId: retained.ingresses[0]!.externalMessageId, body: retained.ingresses[0]!.body }
    }, null, 2) + '\n')
  })
  it.each(['feishu', 'lark'])('edits an existing %s identity without replacing or aliasing it', async adapterId => {
    const credential = await services.secrets.store({ operationId: 'seed-credential', secret: 'fixture-credential' })
    await services.connections.configure({ operationId: 'seed-application', expectedRevision: null, connection: { ...feishuConfig, adapterId, credentialRef: credential.credentialRef, enabled: false } })
    await dom.render(<ExternalConnectionsSettings active />)
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection]')).not.toBeNull() })
    await dom.click('[data-connection] button:first-of-type'); await fill('Connection name', 'Renamed original application')
    await dom.click('[data-connection-save]')
    const record = await saved()
    expect(record.revision).toBe(2)
    expect(record.config).toMatchObject({ connectionId: feishuConfig.connectionId, adapterId, label: 'Renamed original application', enabled: false, credentialRef: credential.credentialRef })
    expect(sdk.sockets).toHaveLength(0)
    expect(sdk.request).not.toHaveBeenCalled()
  })
})
