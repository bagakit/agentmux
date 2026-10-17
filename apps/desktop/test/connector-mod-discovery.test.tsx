// @vitest-environment happy-dom
import { act, useState } from 'react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
let asset: Buffer
let directory: string, services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
let calls: Array<{ method: ConnectionMethod; input: unknown; result: unknown }>, network: string[]
const trusted = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', fileURLToPath(new NodeURL('../../../packages/core/bin/amux', import.meta.url)))
  asset = await readFile(join(import.meta.dirname, '../resources/icon-512.png'))
  directory = await mkdtemp(join(tmpdir(), 'lark-settings-'))
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
    if (String(url) === '/apps/desktop/resources/icon-512.png') return new Response(new Uint8Array(asset))
    network.push(String(url))
    expect(new URL(String(url)).pathname).toBe('/accounts/qrlogin/init')
    expect(new URL(String(url)).origin).toBe('https://accounts.feishu.cn')
    expect(JSON.parse(String(init?.body)).biz_type).toBeNull()
    return Response.json({ code: 0, data: { step_info: { token: privateDevice } } }, { headers: { 'x-flow-key': 'private-discovery-flow' } })
  }))
})
afterEach(async () => { await server.stop(); services.close(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const currentPane = () => dom.container.querySelector<HTMLElement>('[data-settings-pane="lark"]')!
async function settled() {
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(currentPane()).not.toBeNull()
    expect(currentPane().querySelector('[data-bot-enrollment], [data-enrollment-new], [data-connection]')).not.toBeNull()
  })
}
async function input(label: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(element).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('discovers Lark from Conversation Channels, Overview and search and opens its actual public consumer', async () => {
  await dom.render(<SettingsPanel initialSection="overview" onClose={() => {}} />)
  const overview = dom.container.querySelector('[data-settings-overview]')!
  const row = overview.querySelector<HTMLElement>('[data-settings-section="lark"]')!
  expect(row.closest('[data-settings-group]')?.getAttribute('data-settings-group')).toBe('conversation-channels')
  expect(row.textContent).toContain('Lark')
  expect(overview.querySelector('[data-settings-group="toolkit"] [data-settings-section="lark"]')).toBeNull()
  expect(dom.container.querySelectorAll('nav [data-settings-target="lark"]')).toHaveLength(1)
  const nav = dom.container.querySelector<HTMLElement>('nav [data-settings-target="lark"]')!
  let group = nav.previousElementSibling
  while (group && !group.hasAttribute('data-settings-group')) group = group.previousElementSibling
  expect(group?.getAttribute('data-settings-group')).toBe('conversation-channels')
  expect(calls).toEqual([]); expect(network).toEqual([])
  await act(async () => row.click()); await settled()
  expect(dom.container.querySelector('.settings-content__breadcrumb')?.textContent).toBe('Conversation Channels')
  expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Lark')
  expect(dom.container.querySelector('.settings-content__header p')?.textContent).toContain('Feishu or Lark')
  await dom.click('[data-enrollment-new]')
  await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.enrollment.ls')).toBe(true))
  expect(calls.some(call => call.method === 'connection.ls')).toBe(true)
  await vi.waitFor(() => expect(calls.some(call => call.method === 'connection.service.get')).toBe(true))
  expect(trusted.mock.calls.some(call => call[0] === 'connections:call')).toBe(true)
  for (const query of ['Agent 对话', 'Connector', '飞书', 'Lark']) {
    await input('Search settings', query)
    const choices = dom.container.querySelectorAll('nav [data-settings-target="lark"]')
    expect(choices, query).toHaveLength(1)
    expect(choices[0]!.textContent).toContain('Lark')
    expect(currentPane().hidden).toBe(true)
    const result = dom.container.querySelector<HTMLButtonElement>('[aria-label="Settings search results"] [data-settings-search-section="lark"]')
    expect(result, query).not.toBeNull()
    await act(async () => result!.click())
    expect(currentPane().hidden).toBe(false)
  }
  expect(network).toEqual([])
  expect(calls.every(call => call.method === 'connection.ls' || call.method === 'connection.enrollment.ls' || call.method === 'connection.service.get')).toBe(true)
})

it('uses the exact discovered Feishu implementation through the original QR leaf and compiled receipt reader', async () => {
  await dom.render(<SettingsPanel initialSection="lark" onClose={() => {}} />); await settled()
  await dom.click('[data-enrollment-new]')
  await vi.waitFor(() => expect(currentPane().querySelector('[data-enrollment-create]')).not.toBeNull())
  expect(currentPane().querySelector('[aria-label="Bot creation platform"]')).toBeNull()
  const discovery = calls.find(call => call.method === 'connection.enrollment.ls')!.result as { capabilities: Array<{ domain: string; availability: string }> }
  expect(discovery.capabilities.filter(capability => capability.availability === 'available').map(capability => capability.domain)).toEqual(['open.feishu.cn'])
  await dom.click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect(currentPane().querySelector('[data-enrollment-code] svg')).not.toBeNull() })
  await dom.click('[data-settings-overview-nav]')
  const begin = calls.find(call => call.method === 'connection.enrollment.begin')!
  expect(begin.input).toMatchObject({ adapterId: 'feishu', domain: 'open.feishu.cn' })
  const operationId = (begin.input as { operationId: string }).operationId
  const operation = (await api.connections.call('connection.enrollment.inspect', { operationId })).operation!
  expect(operation).toMatchObject({ operationId, adapterId: 'feishu', domain: 'open.feishu.cn', authorization: 'not-started', authentication: { stage: 'waiting' } })
  expect(network).toHaveLength(1); expect(new URL(network[0]!).pathname).toBe('/accounts/qrlogin/init')
  expect(dom.container.textContent).not.toContain(privateDevice)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'enrollment', 'inspect', '--operation-id', operationId], objectCliEnvironment(directory))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { operation: { operationId, domain: 'open.feishu.cn', authorization: 'not-started', authentication: { stage: 'waiting' } } } })
  const result = JSON.parse(cli.stdout).result
  expect(result.challenge?.qrPayload).toBe(JSON.stringify({ qrlogin: { token: privateDevice } }))
  expect(JSON.stringify(result.operation)).not.toContain(privateDevice)
  expect(JSON.stringify(result.actions)).not.toContain(privateDevice)
  expect(network).toHaveLength(1)
})

it('retains manual platform-specific drafts through the stable settings route', async () => {
  let navigate: (section: 'overview' | 'lark') => void = () => {}
  function RoutedSettings() {
    const [section, setSection] = useState<'overview' | 'lark'>('lark')
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
  await dom.click('[data-settings-overview] [data-settings-section="lark"]')
  expect(currentPane().querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.value).toBe('cli_manual_original')
  expect(currentPane().querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-unsaved-manual-credential')
  expect(network).toEqual([])
  expect((await services.connections.list()).connections).toEqual([])
  expect(calls.some(call => call.method === 'connection.configure' || call.method === 'connection.enrollment.begin')).toBe(false)
})
