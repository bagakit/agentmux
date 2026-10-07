// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL, fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { enrollmentEncryption } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const dom = composerDOM(), privateDevice = 'private-mod-discovery-challenge'
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>, network: string[]
const trusted = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', fileURLToPath(new NodeURL('../../../packages/core/bin/amux', import.meta.url)))
  directory = await mkdtemp(join(tmpdir(), 'connector-mod-'))
  services = await createDesktopConnections({ directory, encryption: enrollmentEncryption() })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'public.sock'), connections: services.connections,
    coreClients: () => { throw new Error('Discovering a Mod cannot borrow an Agent Runtime') } })
  await server.start()
  calls = []; network = []; trusted.mockClear()
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: trusted,
    socketPath: server.path, secrets: services.secrets })
  vi.spyOn(api.connections, 'call').mockImplementation(async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await handlers.get('connections:call')!({}, method, input)
    calls.push({ method, input: structuredClone(input), result: structuredClone(result) }); return result
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    network.push(String(url))
    expect(String(url)).toBe('https://accounts.larksuite.com/oauth/v1/app/registration')
    expect(new URLSearchParams(String(init?.body)).get('action')).toBe('begin')
    return Response.json({ device_code: privateDevice, user_code: 'MOD-CODE',
      verification_uri_complete: 'https://open.larksuite.com/page/cli?user_code=MOD-CODE', interval: 1, expires_in: 600 })
  }))
})
afterEach(async () => { await server.stop(); services.close(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const currentPane = () => dom.container.querySelector<HTMLElement>('[data-settings-pane="chat-connections"]')!
async function settled() {
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(currentPane()).not.toBeNull()
    expect(currentPane().querySelector('[data-bot-enrollment], [data-connection]')).not.toBeNull()
  })
}
async function input(label: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(element).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function openPlatformMenu() {
  const trigger = currentPane().querySelector<HTMLButtonElement>('[aria-label="Bot creation platform"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false, pointerType: 'mouse' })))
  await vi.waitFor(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull())
}

it('discovers the one generic Connector from Mods, Overview and search and opens its actual public consumer', async () => {
  await dom.render(<SettingsPanel initialSection="overview" onClose={() => {}} />)
  const overview = dom.container.querySelector('[data-settings-overview]')!
  const row = overview.querySelector<HTMLElement>('[data-settings-section="chat-connections"]')!
  expect(row.closest('[data-settings-group]')?.getAttribute('data-settings-group')).toBe('toolkit')
  expect(row.textContent).toContain('Agent Conversation Connector')
  expect(overview.querySelector('[data-settings-group="connections"] [data-settings-section="chat-connections"]')).toBeNull()
  expect(dom.container.querySelectorAll('nav [data-settings-target="chat-connections"]')).toHaveLength(1)
  const nav = dom.container.querySelector<HTMLElement>('nav [data-settings-target="chat-connections"]')!
  let group = nav.previousElementSibling
  while (group && !group.hasAttribute('data-settings-group')) group = group.previousElementSibling
  expect(group?.getAttribute('data-settings-group')).toBe('toolkit')
  expect(calls).toEqual([]); expect(network).toEqual([])
  await act(async () => row.click()); await settled()
  expect(dom.container.querySelector('.settings-content__breadcrumb')?.textContent).toBe('Mods')
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Agent Conversation Connector')
  expect(dom.container.querySelector('.settings-content__header p')?.textContent).toContain('Feishu and Lark are included')
  expect(calls.some(call => call.method === 'connection.enrollment.ls')).toBe(true)
  expect(calls.some(call => call.method === 'connection.ls')).toBe(true)
  expect(trusted.mock.calls.some(call => call[0] === 'connections:call')).toBe(true)
  for (const query of ['Agent 对话', 'Connector', '飞书', 'Lark']) {
    await input('Search settings', query)
    const choices = dom.container.querySelectorAll('nav [data-settings-target="chat-connections"]')
    expect(choices, query).toHaveLength(1)
    expect(choices[0]!.textContent).toContain('Agent Conversation Connector')
    expect(currentPane().hidden).toBe(false)
  }
  expect(network).toEqual([])
  expect(calls.every(call => call.method === 'connection.ls' || call.method === 'connection.enrollment.ls')).toBe(true)
})

it('uses the exact discovered Lark implementation through the original registration leaf and compiled receipt reader', async () => {
  await dom.render(<SettingsPanel initialSection="chat-connections" onClose={() => {}} />); await settled()
  await openPlatformMenu()
  const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  expect(options.map(option => option.textContent?.trim())).toEqual(['Feishu', 'Lark'])
  await act(async () => options.find(option => option.textContent?.trim() === 'Lark')!.click())
  expect(currentPane().querySelector('[aria-label="Bot creation platform"]')?.getAttribute('data-value')).toBe(JSON.stringify(['feishu', 'open.larksuite.com']))
  await dom.click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(currentPane().querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  const begin = calls.find(call => call.method === 'connection.enrollment.begin')!
  expect(begin.input).toMatchObject({ adapterId: 'feishu', domain: 'open.larksuite.com' })
  const operationId = (begin.input as { operationId: string }).operationId
  const operation = (await services.connections.enrollment!.inspect({ operationId })).operation!
  expect(operation).toMatchObject({ operationId, adapterId: 'feishu', domain: 'open.larksuite.com', authorization: 'pending' })
  expect(network).toEqual(['https://accounts.larksuite.com/oauth/v1/app/registration'])
  expect(dom.container.textContent).not.toContain(privateDevice)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'enrollment', 'inspect', '--operation-id', operationId], objectCliEnvironment(directory))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { operation: { operationId, domain: 'open.larksuite.com', authorization: 'pending' } } })
  expect(cli.stdout).not.toContain(privateDevice)
  expect(network).toHaveLength(1)
})

it('retains manual platform-specific drafts through the stable settings route', async () => {
  let navigate: (section: 'overview' | 'chat-connections') => void = () => {}
  function RoutedSettings() {
    const [section, setSection] = useState<'overview' | 'chat-connections'>('chat-connections')
    navigate = setSection
    return <SettingsPanel initialSection={section} onClose={() => {}} />
  }
  await dom.render(<RoutedSettings />); await settled()
  await dom.click('[data-enrollment-existing]')
  await input('Connection app ID', 'cli_manual_original')
  await input('Connection app secret', 'private-unsaved-manual-credential')
  expect(currentPane().textContent).toContain('Feishu or Lark')
  expect([...currentPane().querySelectorAll<HTMLSelectElement>('[aria-label="Connection platform"] option')].map(option => option.value)).toEqual(['open.feishu.cn', 'open.larksuite.com'])
  await act(async () => navigate('overview'))
  await dom.click('[data-settings-overview] [data-settings-section="chat-connections"]')
  expect(currentPane().querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.value).toBe('cli_manual_original')
  expect(currentPane().querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-unsaved-manual-credential')
  expect(network).toEqual([])
  expect((await services.connections.list()).connections).toEqual([])
  expect(calls.some(call => call.method === 'connection.configure' || call.method === 'connection.enrollment.begin')).toBe(false)
})
