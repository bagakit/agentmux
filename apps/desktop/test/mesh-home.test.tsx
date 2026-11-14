// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { MeshSettingsPane } from '../src/renderer/src/components/settings/MeshSettingsPane'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AppConfig } from '../src/shared/contracts'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
const dom = composerDOM()
const configuration: MeshNetworkSettings['configuration'] = { role: 'disabled', networkId: 'my-devices', members: [], peers: [{ peerId: 'saved-gateway-peer', endpoints: [{ endpoint: 'saved-gateway.internal:8444', useTls: true }] }], publishers: [], advertisedIngress: [], endpointAccess: { allowedClientKeys: [] } }
const saved: MeshNetworkSettings = { owner: { runtimeId: 'original-home-runtime', ownerInstanceId: 'original-home-instance' }, identity: null, revision: 'r1', configuration, operation: null }
const observed: MeshNetworkInspection = { owner: saved.owner, identity: null, source: 'managed', activeRevision: 'r1', desiredRevision: 'r1', apply: { state: 'disabled' }, gateway: { state: 'disabled' }, endpoint: { state: 'not-provided' }, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true }, network: null, observedAt: 1000 }
let config: AppConfig
const save = vi.fn(async () => {})
beforeEach(() => {
  config = { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, { id: 'selected-farm', kind: 'ssh', label: 'Farm same label', hostname: 'farm-original.internal' }, { id: 'neighbor-farm', kind: 'ssh', label: 'Farm same label', hostname: 'neighbor.internal', runtimeId: 'neighbor-original-runtime', transport: 'ssh-tailcat', tailcat: { address: 'fixture-private-credential', keyFile: 'fixture-client-key-path' } }] }
  useAppStore.setState({ config, sessions: [], hostChecks: {}, hostTransports: {}, tailcatConnectionDrafts: {}, meshSettingsDrafts: {} })
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observed : saved) as never)
  save.mockClear()
})
async function input(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
function pane() { return <MeshSettingsPane config={config} active onSave={save} /> }
function editor() { return dom.container.querySelector<HTMLInputElement>('[data-mesh-view="connections"] [data-host-name]')! }
async function ready() { await vi.waitFor(() => expect(dom.container.querySelector('[data-cluster-host="selected-farm"]')).not.toBeNull()) }

it('the actual SettingsPanel opens a continuous Mesh homepage with saved connection nodes, gateways and machines when Mesh is disabled', async () => {
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />); await ready()
  expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe('paths')
  expect([...dom.container.querySelectorAll('.settings-nav-children button')].map(button => button.textContent)).toEqual(['Gateways', 'Machines', 'Device connections'])
  const map = dom.container.querySelector('[aria-label="Network relationship canvas"]')!
  expect(map).not.toBeNull()
  expect(map.closest('[hidden]')).toBeNull()
  expect([...map.querySelectorAll('[data-host-node]')].map(node => node.getAttribute('data-host-node'))).toEqual(['selected-farm', 'neighbor-farm'])
  expect(dom.container.querySelector('.mesh-explorer__legend')?.textContent).toContain('Saved connection')
  expect(map.textContent).toContain('not confirmed')
  expect(dom.container.querySelector('[aria-label="Map source"]')).toBeNull()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Saved gateway targets"]')?.textContent).toContain('saved-gateway.internal:8444'))
  expect(dom.container.querySelector('[aria-label="Saved gateway targets"]')?.textContent).toContain('Not observed')
  expect(dom.container.querySelector('[data-cluster-host="selected-farm"]')?.textContent).toContain('farm-original.internal')
  expect(dom.container.querySelector('[data-cluster-host="neighbor-farm"]')?.textContent).toContain('neighbor.internal')
  expect(dom.container.querySelector('[aria-label="Cluster machine resources"]')?.textContent).toContain('Saved connections')
  expect(dom.container.querySelector('[aria-label="Selected network object"]')).toBeNull()
  expect(dom.container.querySelector('[data-mesh-view="network"]')?.hasAttribute('hidden')).toBe(true)
  const filter = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter saved devices"]')!, reads = vi.mocked(api.mesh.call).mock.calls.length
  for (const value of ['NEIGHBOR.INTERNAL', 'neighbor-farm', 'neighbor-original-runtime']) {
    await input(filter, value)
    expect([...dom.container.querySelectorAll('[data-cluster-host]')].map(node => node.getAttribute('data-cluster-host'))).toEqual(['neighbor-farm'])
  }
  await input(filter, 'Farm same label'); expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(2)
  for (const value of ['fixture-private-credential', 'fixture-client-key-path', 'not-saved-here']) {
    await input(filter, value)
    expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(0)
    expect(dom.container.querySelector('.cluster-machines-empty')?.textContent).toContain('No saved devices match this filter. 3 saved connections remain available.')
    expect(dom.container.querySelector('.cluster-machines-empty')?.textContent).not.toContain('No device connections have been saved')
  }
  await dom.click('.cluster-machines-empty button'); expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(3)
  expect(dom.container.querySelector('[aria-label="Find a device"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Network scope"]')).toBeNull()
  expect(vi.mocked(api.mesh.call).mock.calls).toHaveLength(reads)
  expect(save).not.toHaveBeenCalled()
})

it('a saved-device action reaches its exact original Host despite duplicate labels and neighboring reordering', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  expect(editor().value).toBe('Farm same label')
  config = { ...config, hosts: [config.hosts[2]!,config.hosts[0]!,config.hosts[1]!] }
  await dom.render(pane())
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  await dom.click('.mesh-editor-navigation button'); await dom.click('[data-cluster-host="neighbor-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  expect(save).not.toHaveBeenCalled()
})

it('a visited editor remains mounted and consumes a late authored input after returning home without losing its exact draft', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  const original = editor(); await input(original, 'early-authored')
  await dom.click('.mesh-editor-navigation button')
  expect(original.isConnected).toBe(true)
  expect(dom.container.querySelector('[data-mesh-view="connections"]')?.hasAttribute('hidden')).toBe(true)
  await input(original, 'late original draft  ')
  await dom.click('[data-cluster-host="selected-farm"] button')
  expect(editor()).toBe(original)
  expect(editor().value).toBe('late original draft  ')
  expect(save).not.toHaveBeenCalled()
})

it('one original add intent creates one unsaved Host through the original editor even when the same intent is rendered again', async () => {
  const intent = { intentId: 'one-original-presentation-intent' }
  await dom.render(<HostSettingsPane config={config} active addHostRequest={intent} onSave={save} />)
  const first = dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')
  expect(first).toBeTruthy();expect(config.hosts.some(host => host.id === first)).toBe(false)
  const original = dom.container.querySelector<HTMLInputElement>('[data-host-name]')!; await input(original, 'authored new device  ')
  await dom.render(<HostSettingsPane config={config} active addHostRequest={{ ...intent }} onSave={save} />)
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(first)
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('authored new device  ')
  await dom.render(<HostSettingsPane config={config} active={false} addHostRequest={intent} onSave={save} />)
  await dom.render(<HostSettingsPane config={config} active addHostRequest={intent} onSave={save} />)
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(first)
  expect(save).not.toHaveBeenCalled()
})

it('the homepage Add device action opens the original unsaved editor and returning does not replay creation', async () => {
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />); await ready(); await dom.click('.cluster-add-device')
  const first = dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')
  expect(first).toBeTruthy(); expect(config.hosts.some(host => host.id === first)).toBe(false)
  await input(editor(), 'new original device draft  ')
  await dom.click('.mesh-editor-navigation button')
  expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(3)
  await dom.click('.settings-nav-children [data-settings-target="hosts:mesh-devices"]')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(first)
  expect(editor().value).toBe('new original device draft  ')
  expect(save).not.toHaveBeenCalled()
})

it.each(['saved-device', 'deep-link'] as const)('later %s navigation supersedes a deferred Add during the original save and retains both late drafts', async route => {
  config = { ...config, hosts: config.hosts.map(host => host.kind === 'ssh' && host.transport === 'ssh-tailcat' ? { ...host, tailcat: { ...host.tailcat!, address: 'tcfixture-private-credential' } } : host) }
  let release!: () => void, navigationRequest: SettingsNavigationRequest | undefined
  const heldSave = vi.fn(async () => { await new Promise<void>(done => { release = done }) })
  const render = () => dom.render(<MeshSettingsPane config={config} active navigationRequest={navigationRequest} onSave={heldSave} />)
  const saveButton = '[data-mesh-view="connections"] .remote-management > [data-settings-save-bar] > button'
  await render(); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  await input(editor(), 'submitted original label')
  expect(dom.container.querySelector<HTMLButtonElement>(saveButton)?.disabled).toBe(false)
  await dom.click(saveButton)
  expect(heldSave).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector(saveButton)?.getAttribute('aria-busy')).toBe('true')
  await input(editor(), 'late original draft  ')
  await dom.click('.mesh-editor-navigation button'); await dom.click('.cluster-add-device')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  if (route === 'saved-device') {
    await dom.click('.mesh-editor-navigation button'); await dom.click('[data-cluster-host="neighbor-farm"] button')
  } else {
    navigationRequest = { section: 'hosts', hostId: 'neighbor-farm', field: 'connection' }
    await render()
  }
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  await input(editor(), 'new target late draft  ')
  await act(async () => release())
  expect(dom.container.querySelector(saveButton)?.getAttribute('aria-busy')).toBe('false')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  expect(editor().value).toBe('new target late draft  ')
  expect([...dom.container.querySelectorAll('[data-host-disclosure]')].map(node => node.getAttribute('data-host-disclosure'))).toEqual(config.hosts.map(host => host.id))
  await dom.click('.mesh-editor-navigation button'); await dom.click('[data-cluster-host="selected-farm"] button')
  expect(editor().value).toBe('late original draft  ')
  expect(heldSave).toHaveBeenCalledTimes(1)
})

it('left navigation opens each real Mesh subpage and Mesh restores the same overview controls', async () => {
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await ready()
  const filter = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter saved devices"]')!
  await input(filter, 'neighbor')
  for (const [field, view] of [['mesh-machines', 'machines'], ['mesh-configuration', 'network'], ['mesh-devices', 'connections']] as const) {
    const selector = `.settings-sidebar [data-settings-target="hosts:${field}"]`
    await dom.click(selector)
    expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe(view)
    expect(dom.container.querySelector(selector)?.getAttribute('aria-current')).toBe('page')
  }
  await dom.click('.settings-sidebar [data-settings-target="hosts"]')
  expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe('paths')
  expect(dom.container.querySelector('[aria-label="Filter saved devices"]')).toBe(filter)
  expect(filter.value).toBe('neighbor')
  expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(1)
})

it('selects an exact saved Host from the diagram and shows its channel independently of a stale connection test', async () => {
  const host = config.hosts.find(item => item.id === 'neighbor-farm')!
  const stale = { ...host, label: 'Previous host form' }
  useAppStore.setState({
    hostTransports: { [host.id]: { state: 'connected', transport: 'tailcat', fallback: true, observedAt: 2000, establishedAt: 1000 } },
    hostChecks: { [host.id]: { state: 'ready', input: stale, observedAt: 850 } },
  })
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await ready()
  await dom.click('[aria-label="Network relationship canvas"] [data-host-node="neighbor-farm"]')
  const detail = dom.container.querySelector('[aria-label="Selected saved connection"]')!
  expect(detail.textContent).toContain('neighbor.internal')
  expect(detail.textContent).toContain('Tailcat · Channel connected')
  expect(detail.textContent).not.toContain('Connection test')
  await dom.click('[aria-label="Selected saved connection"] > button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  expect(save).not.toHaveBeenCalled()
})

it('shares the local map anchor and keeps saved Hosts during path focus, failed reads and Relay shutdown', async () => {
  const identity = { peerId: 'this-core', publicKey: 'fixture', epoch: 1 }
  let next = { ...observed, identity, apply: { state: 'active' }, network: {
    protocol: 1, networkId: 'fixture-network', state: 'active', identity,
    peers: [{ peerId: 'distant-gateway', state: 'connected', connectionId: 'mesh-fixture-link', rttMs: 11 }],
    records: [], routes: [], circuits: [],
  } } as MeshNetworkInspection
  let rejectObservation = false
  vi.mocked(api.mesh.call).mockImplementation(async method => {
    if (method === 'mesh.inspect' && rejectObservation) throw Error('Original Relay temporarily unavailable')
    return structuredClone(method === 'mesh.inspect' ? next : saved) as never
  })
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  const canvas = () => dom.container.querySelector('[aria-label="Network relationship canvas"]')
  await vi.waitFor(() => {
    expect(canvas()?.querySelector('[data-host-node="selected-farm"]')).not.toBeNull()
    expect(canvas()?.querySelector('[data-id="relay:distant-gateway"]')).not.toBeNull()
    expect(canvas()?.querySelectorAll('.react-flow')).toHaveLength(1)
    expect(canvas()?.querySelector('[data-id="saved:client"] [data-shared-local]')).not.toBeNull()
    expect(canvas()?.querySelector('[data-id="relay:this-core"]')).toBeNull()
  })
  expect(canvas()?.querySelector('.mesh-explorer__map-outline')).not.toBeNull()
  expect(dom.container.querySelector('.mesh-explorer__map-key')?.textContent).toContain('Device locations unknown')
  expect(dom.container.querySelector('[aria-label="Map source"]')).toBeNull()
  await dom.click('[data-id="relay:distant-gateway"] button')
  await dom.click('[aria-label="Network scope"] button:last-of-type')
  expect(canvas()?.querySelector('[data-host-node="selected-farm"][data-dimmed]')).not.toBeNull()
  await dom.click('[aria-label="Network scope"] button:first-of-type')
  expect(canvas()?.querySelector('[data-host-node="selected-farm"]:not([data-dimmed])')).not.toBeNull()
  const refresh = '.mesh-explorer__header > button:last-child'
  rejectObservation = true
  await dom.click(refresh)
  expect(canvas()?.querySelector('[data-id="relay:distant-gateway"]')).not.toBeNull()
  expect(dom.container.querySelector('.mesh-explorer__heading')?.textContent).toContain('Last confirmed')
  await dom.click('[data-host-node="neighbor-farm"]')
  rejectObservation = false
  next = observed
  await dom.click(refresh)
  expect(canvas()?.querySelector('[data-id="relay:distant-gateway"]')).toBeNull()
  expect(canvas()?.querySelector('[data-host-node="selected-farm"]')).not.toBeNull()
  expect(canvas()?.querySelector('[data-id="saved:client"] .mesh-saved-client')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Selected saved connection"]')?.textContent).toContain('neighbor.internal')
  expect(dom.container.querySelector('.mesh-explorer__heading')?.textContent).toContain('Mesh Relay is off on this Core')
})

it('keeps observed Relay peers separate when the local peer identity is unavailable', async () => {
  const unconfirmed: MeshNetworkInspection = { ...observed, apply: { state: 'active' }, network: {
    protocol: 1, networkId: 'fixture-network', state: 'active', identity: null,
    peers: [{ peerId: 'selected-farm', state: 'connected', connectionId: 'mesh-fixture-link', rttMs: 11 }],
    records: [], routes: [], circuits: [],
  } }
  vi.mocked(api.mesh.call).mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? unconfirmed : saved) as never)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await vi.waitFor(() => {
    expect(dom.container.querySelector('[data-id="relay:selected-farm"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-id="saved:host:selected-farm"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-id="saved:client"] .mesh-saved-client')).not.toBeNull()
    expect(dom.container.querySelector('[data-shared-local]')).toBeNull()
  })
})

it('continues to show saved routes when Mesh has only a local peer', async () => {
  const identity = { peerId: 'this-core', publicKey: 'fixture', epoch: 1 }
  const own: MeshNetworkInspection = { ...observed, identity, apply: { state: 'active' }, network: {
    protocol: 1, networkId: 'fixture-network', state: 'active', identity, peers: [], records: [], routes: [], circuits: [],
  } }
  vi.mocked(api.mesh.call).mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? own : saved) as never)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('.mesh-explorer__heading')?.textContent).toContain('No Relay peers observed'))
  expect(dom.container.querySelector('[aria-label="Network relationship canvas"] [data-host-node="selected-farm"]')).not.toBeNull()
})
