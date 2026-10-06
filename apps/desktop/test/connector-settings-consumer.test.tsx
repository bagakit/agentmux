// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { ConnectionHost } from '../../../packages/connectors/src/connection-host.js'
import { DesktopConnectorSecrets, type CredentialEncryption } from '../src/main/connector-secrets.js'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { connectionsSettingsModule } from '../src/renderer/src/components/settings/modules/connections'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), secret = 'credential-value-held-only-by-host', key = randomBytes(32)
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]) },
  decryptString: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8') }
}
let directory: string, database: DatabaseSync, owner: ConnectionHost, secrets: DesktopConnectorSecrets, server: AgentMuxControlServer
let completedLists = 0, completedChecks = 0
let handlers: Map<string, (...args: any[]) => Promise<any>>, trusted: ReturnType<typeof vi.fn>, originalCall: typeof api.connections.call
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'connector-settings-'))
  database = new DatabaseSync(join(directory, 'connections.sqlite')); secrets = new DesktopConnectorSecrets(database, encryption)
  owner = new ConnectionHost({ database, secrets }); server = new AgentMuxControlServer({ socketPath: join(directory, 'public.sock'), connections: owner, coreClients: () => [] }); await server.start()
  handlers = new Map(); trusted = vi.fn()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted, socketPath: join(directory, 'public.sock'), secrets })
  completedLists = 0; completedChecks = 0
  originalCall = async (method, params) => { const result = await handlers.get('connections:call')!({}, method, params); if (method === 'connection.ls') completedLists++; if (method === 'connection.test') completedChecks++; return result }
  vi.spyOn(api.connections, 'call').mockImplementation(originalCall)
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(async input => handlers.get('connections:storeCredential')!({}, input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(async operationId => handlers.get('connections:inspectCredential')!({}, operationId))
})
afterEach(async () => { await server.stop(); owner.close(); database.close(); await rm(directory, { recursive: true, force: true }) })
async function fill(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function open() { const Pane = connectionsSettingsModule.Pane; await dom.render(<Pane active config={composerConfig} onClose={() => {}} onNavigate={() => {}} />) }
async function draft() { await fill('Connection name', 'Shared team'); await fill('Connection app ID', 'app-a'); await fill('Connection app secret', secret) }

describe('Settings uses the original connection owner through public service', () => {
  it('contributes to Connections and stores encrypted credentials before the real configure/list path', async () => {
    expect(settingsNavGroups('').find(group => group.id === 'connections')!.items.map(item => item.id)).toContain('chat-connections')
    await open(); await draft(); await dom.click('[data-connection-editor] .primary-button')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    const [saved] = (await owner.list()).connections
    expect(saved?.config.label).toBe('Shared team'); expect(saved?.config.application).toEqual({ domain: 'open.feishu.cn', appId: 'app-a' })
    expect(await secrets.resolve(saved!.config.credentialRef)).toBe(secret)
    expect(saved?.observation.authentication.state).toBe('unknown')
    expect(dom.container.querySelector('[data-connection]')?.textContent).toContain('Not confirmed')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('')
    expect(JSON.stringify(await owner.list())).not.toContain(secret)
    database.exec('PRAGMA wal_checkpoint(FULL)')
    expect((await readFile(join(directory, 'connections.sqlite'))).includes(Buffer.from(secret))).toBe(false)
    expect(trusted.mock.calls.map(call => call[0])).toContain('connections:storeCredential')
    const editor = dom.container.querySelector<HTMLElement>('[data-connection-editor]')!
    expect(editor.querySelector('[aria-label="Saved application identity"]')?.textContent).toContain('app-a')
    expect(editor.querySelector('[aria-label="Connection platform"]')).toBeNull()
    expect(editor.querySelector('[aria-label="Connection app ID"]')).toBeNull()
    expect(editor.querySelector('.primary-button')?.textContent).toBe('Check connection')
    expect(editor.querySelector('[data-connection-save]')?.classList.contains('primary-button')).toBe(false)
    await fill('Connection name', 'Updated team')
    expect(editor.querySelector('[data-connection-save]')?.classList.contains('primary-button')).toBe(true)
    expect(editor.textContent).toContain('Check saved connection')

  })
  it('reconciles a lost save response with the original operation without resending or creating a new connection', async () => {
    let configured = 0, operationId = ''
    vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
      const result = await originalCall(method, params)
      if (method === 'connection.configure') { configured++; operationId = (params as ConnectionParamsMap['connection.configure']).operationId; throw new Error('Response interrupted') }
      return result
    })
    await open(); await draft(); await dom.click('[data-connection-editor] .primary-button')
    await act(async () => { await vi.waitFor(() => expect(configured).toBe(1)) })
    expect(dom.container.textContent).toContain('Check pending save')
    expect((await owner.inspect({ operationId })).operation).not.toBeNull()
    await dom.click('[data-connection-editor] .primary-button')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    expect(configured).toBe(1); expect((await owner.list()).connections).toHaveLength(1)
    expect(dom.container.textContent).toContain('Connection saved')
  })
  it('keeps check outcomes with the exact connection and reports each unconfirmed service fact', async () => {
    const application = { adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-a' }, enabled: true, credentialRef: 'credential-a' }
    await owner.configure({ operationId: 'seed-a', expectedRevision: null, connection: { ...application, connectionId: 'connection-a', label: 'Application A' } })
    await owner.configure({ operationId: 'seed-b', expectedRevision: null, connection: { ...application, connectionId: 'connection-b', label: 'Application B' } })
    await open()
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(1)) })
    await dom.click('[data-connection="connection-b"] button:last-child')
    await act(async () => { await vi.waitFor(() => expect(completedChecks).toBe(1)) })
    const first = dom.container.querySelector('[data-connection="connection-a"]')!, checked = dom.container.querySelector('[data-connection="connection-b"]')!
    expect(first.querySelector('[role="status"]')).toBeNull()
    expect(checked.querySelector('[role="status"]')?.textContent).toContain('Not confirmed: authentication, durable receiving, group delivery')
    expect(checked.querySelector('[role="status"]')?.textContent).toContain('Unavailable: connection')
    expect(checked.querySelector('.connector-stage-list')?.textContent).toContain('Durable receiving')
    expect(dom.container.querySelector('[data-connector-settings] > [role="status"]')).toBeNull()
    expect(dom.container.textContent).not.toContain('reported separately below')
  })
  it('rejects foreign IPC methods and untrusted credential entry before contacting the owner', async () => {
    await expect(handlers.get('connections:call')!({}, 'agent.send', {})).rejects.toThrow('Unsupported connection operation')
    trusted.mockImplementation(() => { throw new Error('Untrusted sender') })
    await expect(handlers.get('connections:storeCredential')!({}, { operationId: 'foreign', secret })).rejects.toThrow('Untrusted sender')
    expect(database.prepare('SELECT COUNT(*) AS count FROM connection_credential').get()?.count).toBe(0)
  })
})

describe('Host credential and availability boundary', () => {
  it('rejects plaintext fallback, preserves original credential operations and redacts encryption exceptions', async () => {
    const unavailable = new DesktopConnectorSecrets(database, { ...encryption, isEncryptionAvailable: () => false })
    await expect(unavailable.store({ operationId: 'unavailable', secret })).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
    const basicText = new DesktopConnectorSecrets(database, { ...encryption, getSelectedStorageBackend: () => 'basic_text' })
    await expect(basicText.store({ operationId: 'basic-text', secret })).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM connection_credential').get()?.count).toBe(0)
    const saved = await secrets.store({ operationId: 'credential-store', secret })
    expect(await secrets.store({ operationId: 'credential-store', secret })).toEqual(saved)
    expect(await secrets.inspect('credential-store')).toEqual(saved)
    await expect(secrets.store({ operationId: 'credential-store', secret: 'different' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
    const faulty = new DesktopConnectorSecrets(database, { ...encryption, encryptString: () => { throw new Error(secret) } })
    const error = await faulty.store({ operationId: 'encryption-failure', secret }).catch(error => error)
    expect(error.code).toBe('CONNECTION_CREDENTIAL_UNCONFIRMED'); expect(JSON.stringify(error)).not.toContain(secret); expect(error.message).not.toContain(secret)
    expect(await secrets.resolve(saved.credentialRef)).toBe(secret)
  })
  it('reports optional connection storage failure without rejecting Host initialization', async () => {
    const file = join(directory, 'occupied'); await writeFile(file, 'keep-original')
    const services = await createDesktopConnections({ directory: join(file, 'child'), encryption })
    expect(services.database).toBeNull()
    await expect(services.connections.list()).rejects.toMatchObject({ code: 'CONNECTION_STORAGE_UNAVAILABLE' })
    expect(await readFile(file, 'utf8')).toBe('keep-original')
    await rm(file)
    expect(await services.connections.list()).toEqual({ connections: [] })
    expect(services.database).not.toBeNull(); services.close()
  })
})
