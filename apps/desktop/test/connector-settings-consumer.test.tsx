// @vitest-environment happy-dom
import { act } from 'react'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { ConnectionHost } from '../../../packages/connectors/src/connection-host.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { larkSettingsModule } from '../src/renderer/src/components/settings/modules/lark'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), secret = 'credential-value-held-only-by-host'
let directory: string, database: DatabaseSync, owner: ConnectionHost, secrets: ConnectionSecrets, server: AgentMuxControlServer
let completedLists = 0, completedChecks = 0
let handlers: Map<string, (...args: any[]) => Promise<any>>, trusted: ReturnType<typeof vi.fn>, originalCall: typeof api.connections.call
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'connector-settings-'))
  database = new DatabaseSync(join(directory, 'connections.sqlite')); secrets = new ConnectionSecrets(database)
  owner = new ConnectionHost({ database, secrets }); server = new AgentMuxControlServer({ socketPath: join(directory, 'public.sock'), connections: owner, coreClients: () => [] }); await server.start()
  handlers = new Map(); trusted = vi.fn()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted, socketPath: join(directory, 'public.sock'), secrets })
  completedLists = 0; completedChecks = 0
  originalCall = async (method, params) => { const result = unwrapSessionInputOperationResult<ConnectionResultMap[typeof method]>(await handlers.get('connections:call')!({}, method, params)); if (method === 'connection.ls') completedLists++; if (method === 'connection.test') completedChecks++; return result }
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
async function open() { const Pane = larkSettingsModule.Pane; await dom.render(<Pane active config={composerConfig} onClose={() => {}} onNavigate={() => {}} />); await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(1)) }); if (!dom.container.querySelector('[data-connection]')) await dom.click('[data-enrollment-existing]') }
async function draft() { await act(async () => { dom.container.querySelector<HTMLDetailsElement>('.connector-optional')!.open = true }); await fill('Connection name', 'Shared team'); await fill('Connection app ID', 'app-a'); await fill('Connection app secret', secret) }

describe('Settings uses the original connection owner through public service', () => {
  it('keeps the confirmed saved revision when an earlier library list arrives late', async () => {
    await owner.configure({ operationId: 'seed-before-late-list', expectedRevision: null, connection: { connectionId: 'original-application', adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-a' }, label: 'Original application', enabled: true, credentialRef: 'credential-a' } })
    await open()
    let holdNextList = true, release: (() => void) | undefined
    const delayed = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
      const result = await originalCall(method, params)
      if (method === 'connection.ls' && holdNextList) { holdNextList = false; await delayed }
      return result
    })
    try {
      await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.connector-saved-identities button')].find(button => button.textContent === 'Refresh')!.click())
      await vi.waitFor(() => expect(completedLists).toBe(2))
      await dom.click('[data-connection] button')
      await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
      await fill('Connection name', 'Updated application')
      await dom.click('[data-connection-save]')
      await vi.waitFor(async () => { await act(async () => {}); expect(completedLists).toBe(3); expect(dom.container.querySelector('.connector-editor-title')?.textContent).toBe('Updated application') })
      await act(async () => { release!(); await delayed })
      const confirmed = (await owner.inspect({ connectionId: 'original-application' })).connection!
      expect(confirmed.revision).toBe(2)
      expect(confirmed.config.label).toBe('Updated application')
      expect(dom.container.querySelector('.connector-editor-title')?.textContent).toBe('Updated application')
    } finally { release!() }
  })

  it('retains the confirmed saved revision when the followup list refresh is unavailable', async () => {
    await owner.configure({ operationId: 'seed-before-edit', expectedRevision: null, connection: { connectionId: 'original-application', adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-a' }, label: 'Original application', enabled: true, credentialRef: 'credential-a' } })
    await open()
    await dom.click('[data-connection] button')
    await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
    await fill('Connection name', 'Updated application')
    let edited = false
    vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
      if (method === 'connection.ls' && edited) throw new Error('List refresh unavailable')
      const result = await originalCall(method, params)
      if (method === 'connection.configure') edited = true
      return result
    })
    await dom.click('[data-connection-save]')
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-list-issue]')?.textContent).toContain('List refresh unavailable') })
    const confirmed = (await owner.inspect({ connectionId: 'original-application' })).connection!
    expect(confirmed.revision).toBe(2)
    expect(confirmed.config.label).toBe('Updated application')
    expect(dom.container.querySelector('.connector-editor-title')?.textContent).toBe('Updated application')
    await dom.click('.connector-back')
    expect(dom.container.querySelector('[data-connection]')?.textContent).toContain('Updated application')
    await dom.click('[data-connection] button')
    await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
    await fill('Connection name', 'Updated again')
    await dom.click('[data-connection-save]')
    await vi.waitFor(async () => { await act(async () => {}); expect((await owner.inspect({ connectionId: 'original-application' })).connection?.revision).toBe(3) })
  })

  it('contributes to Conversation Channels and stores encrypted credentials before the real configure/list path', async () => {
    expect(settingsNavGroups('').find(group => group.id === 'conversation-channels')!.items.map(item => item.id)).toContain('lark')
    expect(settingsNavGroups('扫码').flatMap(group => group.items).map(item => item.id)).toContain('lark')
    await open(); await draft(); await dom.click('[data-connection-editor] .primary-button')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    const [saved] = (await owner.list()).connections
    expect(saved?.config.label).toBe('Shared team'); expect(saved?.config.application).toEqual({ domain: 'open.feishu.cn', appId: 'app-a' })
    expect(await secrets.resolve(saved!.config.credentialRef)).toBe(secret)
    expect(saved?.observation.authentication.state).toBe('unknown')
    await vi.waitFor(() => expect(dom.container.querySelector('.connector-connection-state')?.textContent).toContain('Saved · connection not yet confirmed'))
    expect(dom.container.querySelector('[aria-label="Connection app secret"]')).toBeNull()
    expect(JSON.stringify(await owner.list())).not.toContain(secret)
    database.exec('PRAGMA wal_checkpoint(FULL)')
    expect((await readFile(join(directory, 'connections.sqlite'))).includes(Buffer.from(secret))).toBe(false)
    expect(trusted.mock.calls.map(call => call[0])).toContain('connections:storeCredential')
    const editor = dom.container.querySelector<HTMLElement>('[data-connection-editor]')!
    expect(editor.querySelector('[aria-label="Saved application identity"]')?.textContent).toContain('app-a')
    expect(editor.querySelector('[aria-label="Connection platform"]')).toBeNull()
    expect(editor.querySelector('[aria-label="Connection app ID"]')).toBeNull()
    expect(editor.querySelector('.primary-button')?.textContent).toBe('Check connection')
    expect(editor.querySelector('[data-connection-save]')).toBeNull()
    await dom.click('[data-connection-editor] .connector-editor-actions .small-button')
    await fill('Connection name', 'Updated team')
    expect(editor.querySelector('[data-connection-save]')?.classList.contains('primary-button')).toBe(true)
    expect(editor.textContent).toContain('Save changes')
    expect(editor.textContent).not.toContain('Check saved connection')

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
    expect(dom.container.textContent).toContain('Check this save')
    expect((await owner.inspect({ operationId })).operation).not.toBeNull()
    await dom.click('[data-connection-editor] .primary-button')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    expect(configured).toBe(1); expect((await owner.list()).connections).toHaveLength(1)
    expect(dom.container.textContent).toContain('The original application save is confirmed')
  })
  it('keeps check outcomes with the exact connection and reports each unconfirmed service fact', async () => {
    const application = { adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-a' }, enabled: true, credentialRef: 'credential-a' }
    await owner.configure({ operationId: 'seed-a', expectedRevision: null, connection: { ...application, connectionId: 'connection-a', label: 'Application A' } })
    await owner.configure({ operationId: 'seed-b', expectedRevision: null, connection: { ...application, connectionId: 'connection-b', label: 'Application B' } })
    await open()
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(1)) })
    await dom.click('[data-connection="connection-b"] button')
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-check]')?.disabled).toBe(false))
    await dom.click('[data-connection-check]')
    await act(async () => { await vi.waitFor(() => expect(completedChecks).toBe(1)) })
    const editor = dom.container.querySelector('[data-connection-editor]')!
    expect(editor.querySelector('[data-connection-stage="authentication"]')?.getAttribute('data-state')).toBe('unknown')
    expect(editor.querySelector('[data-connection-stage="intake"]')?.getAttribute('data-state')).toBe('unknown')
    expect(editor.querySelector('[data-connection-stage="delivery"]')?.getAttribute('data-state')).toBe('unknown')
    expect(editor.querySelector('[data-connection-stage="transport"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(editor.querySelector('.connector-stage-list')?.textContent).toContain('Receiving messages')
    expect(dom.container.querySelector('[data-connector-settings] > [role="status"]')).toBeNull()
    await dom.click('.connector-back')
    await dom.click('[data-connection="connection-a"] button')
    expect(dom.container.querySelector('.connector-check-feedback')).toBeNull()
    expect(dom.container.querySelector('.connector-editor-title')?.textContent).toBe('Application A')
  })
  it('explains the credential source and next group step without making a group or claiming connection readiness', async () => {
    const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
    await open()
    expect(dom.container.textContent).toContain('Credentials & Basic Info')
    expect(dom.container.querySelector('.connector-stage-list')).toBeNull()
    expect(dom.container.querySelector('.connector-editor-title')?.textContent).toBe('Connect an existing bot')
    expect(dom.container.querySelector('[aria-label="Connection app ID"]')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="Connection app secret"]')).not.toBeNull()
    await dom.click('.connector-credentials-source button')
    expect(external).toHaveBeenCalledExactlyOnceWith('https://open.feishu.cn/app')
    await dom.click('[data-connection-save]')
    expect(dom.container.querySelector('[aria-label="Connection app ID"]')?.hasAttribute('disabled')).toBe(false)
    expect((await owner.list()).connections).toHaveLength(0)
    await fill('Connection app ID', 'app-a'); await fill('Connection app secret', secret)
    await dom.click('[data-connection-save]')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    const record = (await owner.list()).connections[0]!
    expect(record.config.label).toBe('Feishu bot')
    expect(dom.container.querySelector('.connector-setup-help')?.textContent).toContain('persistent connection')
    await vi.waitFor(() => expect(dom.container.querySelector('.connector-connection-state')?.textContent).toContain('connection not yet confirmed'))
    expect(dom.container.querySelectorAll('[data-connection-editor] .primary-button')).toHaveLength(1)
    expect(database.prepare('SELECT COUNT(*) AS count FROM connection_configuration_operation').get()?.count).toBe(1)
    expect(vi.mocked(api.connections.call).mock.calls.map(call => call[0])).not.toContain('connection.test')
    expect(vi.mocked(api.connections.call).mock.calls.map(call => call[0])).not.toContain('connection.room.create')
  })
  it('only inspects an unknown save and explicitly continues its same frozen input when no receipt is recorded', async () => {
    const attempts: ConnectionParamsMap['connection.configure'][] = []
    vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
      if (method === 'connection.configure') {
        attempts.push(structuredClone(params as ConnectionParamsMap['connection.configure']))
        if (attempts.length === 1) throw new Error('Request transport interrupted before dispatch')
      }
      return await originalCall(method, params)
    })
    await open(); await fill('Connection app ID', 'app-a'); await fill('Connection app secret', secret)
    await dom.click('[data-connection-save]')
    await act(async () => { await vi.waitFor(() => expect(attempts).toHaveLength(1)) })
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.disabled).toBe(true)
    expect(dom.container.querySelector('[data-connection-save]')?.textContent).toBe('Check this save')
    await dom.click('[data-connection-save]')
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-connection-save]')?.textContent).toBe('Continue this save') })
    expect(attempts).toHaveLength(1)
    expect((await owner.inspect({ operationId: attempts[0]!.operationId })).operation).toBeNull()
    await dom.click('.connector-editor-actions .small-button')
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector<HTMLButtonElement>('[data-connection-save]')?.disabled).toBe(false) })
    expect(attempts).toHaveLength(1)
    await dom.click('[data-connection-save]')
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect((await owner.inspect({ operationId: attempts[0]!.operationId })).operation?.connection.config.label).toBe('Feishu bot')
    expect((await owner.list()).connections).toHaveLength(1)
    expect(vi.mocked(api.connections.storeCredential)).toHaveBeenCalledTimes(1)
  })
  it('keeps the original credential draft through hidden settings and refresh without saving it', async () => {
    await open(); await draft()
    const Pane = larkSettingsModule.Pane
    await dom.render(<Pane active={false} config={composerConfig} onClose={() => {}} onNavigate={() => {}} />)
    expect(dom.container.textContent).toBe('')
    await dom.render(<Pane active config={composerConfig} onClose={() => {}} onNavigate={() => {}} />)
    await act(async () => { await vi.waitFor(() => expect(completedLists).toBe(2)) })
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection name"]')?.value).toBe('Shared team')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.value).toBe('app-a')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe(secret)
    expect((await owner.list()).connections).toHaveLength(0)
    expect(vi.mocked(api.connections.storeCredential)).not.toHaveBeenCalled()
  })
  it('rejects foreign IPC methods and untrusted credential entry before contacting the owner', async () => {
    await expect(handlers.get('connections:call')!({}, 'agent.send', {})).rejects.toThrow('Unsupported connection operation')
    trusted.mockImplementation(() => { throw new Error('Untrusted sender') })
    await expect(handlers.get('connections:storeCredential')!({}, { operationId: 'foreign', secret })).rejects.toThrow('Untrusted sender')
    expect(database.prepare('SELECT COUNT(*) AS count FROM connection_credential').get()?.count).toBe(0)
  })
})

describe('Host credential and availability boundary', () => {
  it('retains original private credential operations, refuses exposed storage and redacts uncertain write errors', async () => {
    await chmod(directory, 0o755)
    await expect(secrets.store({ operationId: 'private-storage-unavailable', secret })).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM connection_credential').get()?.count).toBe(0)
    await chmod(directory, 0o700)
    const saved = await secrets.store({ operationId: 'credential-store', secret })
    expect(await secrets.store({ operationId: 'credential-store', secret })).toEqual(saved)
    expect(await secrets.inspect('credential-store')).toEqual(saved)
    await expect(secrets.store({ operationId: 'credential-store', secret: 'different' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
    const exec = database.exec.bind(database); let uncertain = true
    vi.spyOn(database, 'exec').mockImplementation(sql => { const value = exec(sql); if (sql === 'COMMIT' && uncertain) { uncertain = false; throw Error(secret) }; return value })
    const error = await secrets.store({ operationId: 'private-write-uncertain', secret }).catch(error => error)
    expect(error.code).toBe('CONNECTION_CREDENTIAL_UNCONFIRMED'); expect(JSON.stringify(error)).not.toContain(secret); expect(error.message).not.toContain(secret)
    const receipt = await secrets.inspect('private-write-uncertain'); expect(receipt).not.toBeNull()
    expect(await secrets.store({ operationId: 'private-write-uncertain', secret })).toEqual(receipt)
    expect(await secrets.resolve(saved.credentialRef)).toBe(secret)
  })
  it('reports optional connection storage failure without rejecting Host initialization', async () => {
    const file = join(directory, 'occupied'); await writeFile(file, 'keep-original')
    const services = await createConnectionServices({ directory: join(file, 'child') })
    expect(services.database).toBeNull()
    await expect(services.connections.list()).rejects.toMatchObject({ code: 'CONNECTION_STORAGE_UNAVAILABLE' })
    expect(await readFile(file, 'utf8')).toBe('keep-original')
    await rm(file)
    expect(await services.connections.list()).toEqual({ connections: [] })
    expect(services.database).not.toBeNull(); services.close()
  })
})
