// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import { composerDOM } from './helpers/composer-dom-fixture'

// A navigation request names one section. Only that section's editor receives it; every other
// visited editor keeps its own state, and channel editors stay mounted while another section is shown.
const dom = composerDOM()
const origin = { hostingTarget: { hostId: 'studio', runtimeId: 'runtime-studio' }, target: null, topicId: 'topic-1', moteName: 'Atlas' } as never
const hostingCalls: unknown[] = []
beforeEach(async () => {
  hostingCalls.length = 0
  useAppStore.setState({ config: await api.config.get() })
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation(async (hostId?: string) => {
    hostingCalls.push(hostId)
    return { hostId: hostId ?? 'local', runtimeId: `runtime-${hostId ?? 'local'}` } as never
  })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method: string) => {
    if (method === 'connection.ls') return { connections: [] } as never
    throw new Error(`unexpected ${method}`)
  })
})
const pane = (id: string) => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${id}"]`)
const hostChoice = (id: string) => pane(id)?.querySelector<HTMLSelectElement>('[aria-label="Connector hosting Host"]')
const choose = async (id: string) => { await act(async () => dom.container.querySelector<HTMLElement>(`.settings-sidebar [data-settings-target="${id}"]`)!.click()) }
async function settle() { for (let n = 0; n < 20; n++) await act(async () => { await new Promise(done => setTimeout(done, 5)) }) }

it('delivers a Mote Lark request to Lark only, so Discord keeps its own Host', async () => {
  const request: SettingsNavigationRequest = { section: 'lark', moteConnectionOrigin: origin }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="lark" navigationRequest={request} />)
  await settle()
  expect(hostChoice('lark')!.selectedOptions[0]!.textContent).not.toBe('Background Host on this device')
  await choose('discord')
  await settle()
  // Discord reads its own Host; the Lark origin's Host never appears there.
  expect(hostChoice('discord')!.selectedOptions[0]!.textContent).toBe('Background Host on this device')
  expect(hostingCalls).toContain('local')
})

it('keeps a visited channel editor mounted with its draft while another section is shown', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="lark" />)
  await settle()
  const lark = pane('lark')!
  const before = lark.querySelector('[data-connection-hosting]')
  expect(before).not.toBeNull()
  await choose('discord')
  await settle()
  // The hidden Lark editor is the same DOM instance, not an emptied or remounted one.
  expect(lark.hidden).toBe(true)
  expect(lark.querySelector('[data-connection-hosting]')).toBe(before)
  await choose('lark')
  expect(pane('lark')!.querySelector('[data-connection-hosting]')).toBe(before)
})

it('states a requested field that the section does not show, outside search too', async () => {
  const request: SettingsNavigationRequest = { section: 'general', field: 'not-a-general-field' }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="general" navigationRequest={request} />)
  await settle()
  expect(pane('general')!.querySelector('[data-settings-target-issue]')?.textContent).toContain('not shown in the current view')
})

it('lands the Host executors request on its real anchor without an issue', async () => {
  const request: SettingsNavigationRequest = { section: 'agents', field: 'host-executors', hostId: 'local' }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="agents" navigationRequest={request} />)
  await settle()
  const target = pane('agents')!.querySelector<HTMLElement>('[data-settings-field="host-executors"]')
  expect(target).not.toBeNull()
  expect(target!.hidden).toBe(false)
  expect(pane('agents')!.querySelector('[data-settings-target-issue]')).toBeNull()
})

it.each([
  { name: 'original Mesh incoming without a Host ID', request: { section: 'hosts', field: 'incoming' } },
  { name: 'canonical local Node incoming', request: { section: 'network-node', hostId: 'local', field: 'incoming' } }
] as const)('reveals the exact local Tailcat editor before focusing $name', async ({ request }) => {
  const configured = useAppStore.getState().config!
  useAppStore.setState({ config: { ...configured, hosts: [
    { id: 'remote-first', kind: 'ssh', label: 'Remote first', hostname: 'remote.invalid' },
    { id: 'local', kind: 'local', label: 'This device' }
  ] } })
  await dom.render(<SettingsPanel onClose={() => {}} initialSection={request.section} navigationRequest={request} />)
  await vi.waitFor(() => expect(pane('network-node')?.querySelector('[data-settings-field="incoming"]')).toBeTruthy(), { timeout: 6000 })
  await settle()
  const mesh = pane('network-node')
  expect(mesh, 'the request must normalize to the real Node module').not.toBeNull()
  expect(mesh!.hidden).toBe(false)
  const connections = mesh!.querySelector<HTMLElement>('[data-cluster-node-panel="incoming"]')
  expect(connections, 'incoming selects the Tailcat panel').not.toBeNull()
  expect(connections!.hidden).toBe(false)
  const visible = [...connections!.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
    .filter(target => target.isConnected && !target.closest('[hidden], [inert]'))
  expect(visible, 'exactly one revealed local incoming editor').toHaveLength(1)
  expect(connections!.querySelector('[data-resource-editor="remote-first"] [data-settings-field="incoming"]')).toBeNull()
  expect(document.activeElement).toBe(visible[0])
  expect(visible[0]!.hasAttribute('data-settings-search-highlight')).toBe(true)
  expect(mesh!.querySelector('[data-settings-target-issue]')).toBeNull()
})

it('reports an explicit remote listener target without opening the local editor', async () => {
  const configured = useAppStore.getState().config!
  useAppStore.setState({ config: { ...configured, hosts: [
    { id: 'remote-first', kind: 'ssh', label: 'Remote first', hostname: 'remote.invalid' },
    { id: 'local', kind: 'local', label: 'This device' }
  ] } })
  await dom.render(<SettingsPanel onClose={() => {}} navigationRequest={{ section: 'hosts', field: 'incoming', hostId: 'remote-first' }} />)
  expect(pane('network-node')?.querySelector('[data-settings-field="incoming"]')?.textContent).toContain('requested local Host is unavailable')
  expect(pane('network-node')?.querySelector('.host-local-incoming')).toBeNull()
})

it.each([{ start: 'fresh' }, { start: 'gateway' }] as const)('search reveals and focuses the only local incoming editor from a $start SettingsPanel without clearing its draft', async ({ start }) => {
  const configured = useAppStore.getState().config!
  useAppStore.setState({ config: { ...configured, hosts: [
    { id: 'remote-first', kind: 'ssh', label: 'Remote first', hostname: 'remote.invalid' },
    { id: 'local', kind: 'local', label: 'This device' }
  ] } })
  const initial = start === 'gateway' ? { section: 'hosts', field: 'mesh-configuration' } as const : undefined
  await dom.render(<SettingsPanel onClose={() => {}} initialSection={initial?.section ?? 'overview'} navigationRequest={initial} />)
  await settle()
  if (start === 'gateway') await vi.waitFor(() => expect(pane('network-node')?.querySelector('[data-cluster-node-panel="mesh-configuration"]')?.closest('[hidden]')).toBeNull(), { timeout: 6000 })
  await act(async () => {
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Incoming connections and client keys')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(dom.container.querySelector('[data-settings-search-result="hosts:incoming"]')).toBeNull()
  expect(dom.container.querySelector('[data-settings-search-result="network-node:incoming"]')).not.toBeNull()
  await dom.click('[data-settings-search-result="network-node:incoming"]')
  await vi.waitFor(() => expect(pane('network-node')?.querySelector('[data-settings-field="incoming"]')).toBeTruthy(), { timeout: 6000 })
  await settle()
  const mesh = pane('network-node')!
  expect(mesh.hidden).toBe(false)
  const connections = mesh.querySelector<HTMLElement>('[data-cluster-node-panel="incoming"]')!
  expect(connections.hidden).toBe(false)
  const visible = [...connections.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
    .filter(target => target.isConnected && !target.closest('[hidden], [inert]'))
  expect(visible).toHaveLength(1)
  expect(document.activeElement).toBe(visible[0])
  expect(visible[0]!.hasAttribute('data-settings-search-highlight')).toBe(true)
  expect(mesh.querySelector('[data-settings-target-issue]')).toBeNull()
  const allowed = visible[0]!.querySelector<HTMLTextAreaElement>('[aria-label="Tailcat allowed clients"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(allowed, 'nodekey:authored-draft\n  ')
    allowed.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('.cluster-node-tabs button:first-child')
  expect(connections.hidden).toBe(true)
  await act(async () => {
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await choose('network-node'); await dom.click('.cluster-node-tabs button[aria-controls$="-incoming"]')
  expect(connections.querySelector('[data-settings-field="incoming"]')).toBe(visible[0])
  expect(allowed.value).toBe('nodekey:authored-draft\n  ')
})

it('keeps query, manual section and external focus stable when saved Hosts are refreshed with the same local identity', async () => {
  const configured = useAppStore.getState().config!
  useAppStore.setState({ config: { ...configured, hosts: [
    { id: 'remote-first', kind: 'ssh', label: 'Remote first', hostname: 'remote.invalid' },
    { id: 'local', kind: 'local', label: 'This device' }
  ] } })
  const request = { section: 'hosts', field: 'incoming' } as const
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="hosts" navigationRequest={request} />)
  await settle()
  expect(document.activeElement).toBe(pane('network-node')!.querySelector('[data-settings-field="incoming"]'))
  await act(async () => {
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Appearance')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('.settings-sidebar [data-settings-target="appearance"]')
  const outside = document.createElement('textarea')
  document.body.append(outside)
  try {
    outside.focus()
    expect(document.activeElement).toBe(outside)
    const previousHosts = useAppStore.getState().config!.hosts
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(host => ({ ...host })) } })))
    expect(useAppStore.getState().config!.hosts).not.toBe(previousHosts)
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!.value).toBe('Appearance')
    expect(pane('appearance')!.hidden).toBe(false)
    expect(pane('network-node')!.hidden).toBe(true)
    expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
})

it('reveals a requested Remote task when Settings becomes visible before focusing it', async () => {
  const routes = { section: 'remote-execution', field: 'routes' } as const
  const prepare = { section: 'remote-execution', field: 'prepare' } as const
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="remote-execution" navigationRequest={routes} />)
  await settle()
  await dom.render(<SettingsPanel onClose={() => {}} visible={false} initialSection="remote-execution" navigationRequest={prepare} />)
  await settle()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="remote-execution" navigationRequest={prepare} />)
  await settle()
  const target = pane('remote-execution')!.querySelector<HTMLElement>('[data-settings-field="prepare"]')!
  expect(target.hidden).toBe(false)
  expect(target.closest('[hidden], [inert]')).toBeNull()
  expect(document.activeElement).toBe(target)
  expect(pane('remote-execution')!.querySelector('[data-settings-target-issue]')).toBeNull()
})

it('says on Overview that no section manages an unrecognized channel application', async () => {
  const channelOrigin = { sessionId: 's', hostId: 'local', agentSessionId: 'a', connection: { connectionId: 'c', adapterId: 'matrix', application: { domain: 'matrix.example', appId: 'app' } } }
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="overview" navigationRequest={{ section: 'overview', channelOrigin }} />)
  await settle()
  expect(dom.container.querySelector('[data-settings-overview] [data-settings-target-issue]')?.textContent).toContain('matrix.example')
})
