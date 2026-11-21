// @vitest-environment happy-dom
import { act } from 'react'
import { connectionLinkUrl } from '@agentmux/relay/offer'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AppConfig } from '../src/shared/contracts'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import type { MacMapLocationResult } from '../src/shared/mesh-map-locations'
const dom = composerDOM()
const configuration: MeshNetworkSettings['configuration'] = { role: 'disabled', networkId: 'my-devices', members: [], peers: [{ peerId: 'saved-gateway-peer', endpoints: [{ endpoint: 'saved-gateway.internal:8444', useTls: true }] }], publishers: [], advertisedIngress: [], endpointAccess: { allowedClientKeys: [] } }
const saved: MeshNetworkSettings = { owner: { runtimeId: 'original-home-runtime', ownerInstanceId: 'original-home-instance' }, identity: null, revision: 'r1', configuration, operation: null }
const observed: MeshNetworkInspection = { owner: saved.owner, identity: null, source: 'managed', activeRevision: 'r1', desiredRevision: 'r1', apply: { state: 'disabled' }, gateway: { state: 'disabled' }, endpoint: { state: 'not-provided' }, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true }, network: null, observedAt: 1000 }
let config: AppConfig
const save = vi.fn(async () => {})
beforeEach(() => {
  config = { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, { id: 'selected-farm', kind: 'ssh', label: 'Farm same label', hostname: 'farm-original.internal' }, { id: 'neighbor-farm', kind: 'ssh', label: 'Farm same label', hostname: 'neighbor.internal', runtimeId: 'neighbor-original-runtime', transport: 'ssh-tailcat', tailcat: { address: 'fixture-private-credential', keyFile: 'fixture-client-key-path' } }] }
  useAppStore.setState({ config, meshDeviceLinks: { draft: '', saved: [] }, sessions: [], hostChecks: {}, hostTransports: {}, tailcatConnectionDrafts: {}, meshSettingsDrafts: {} })
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observed : saved) as never)
  save.mockClear()
})
async function input(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
const meshNav = '.settings-sidebar [data-settings-target="hosts"]'
const quickNav = '.settings-sidebar [data-settings-target="remote-execution"]'
const nodeNav = '.settings-sidebar [data-settings-target="network-node"]'
const join = '.cluster-overview-header .primary-button'
function tab(field: string) { return `.cluster-node-tabs [role="tab"][aria-controls$="-${field}"]` }
function pane(navigationRequest?: SettingsNavigationRequest) { return <SettingsPanel initialSection="hosts" onClose={vi.fn()} navigationRequest={navigationRequest} /> }
function editor() { return dom.container.querySelector<HTMLInputElement>('[data-cluster-node-panel="mesh-devices"] [data-host-name]')! }
async function ready() { await vi.waitFor(() => expect(dom.container.querySelector('[data-cluster-host="selected-farm"]')).not.toBeNull()) }

it('the actual SettingsPanel opens a continuous Mesh homepage with saved connection nodes, gateways and machines when Mesh is disabled', async () => {
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />); await ready()
  expect(dom.container.querySelector('[data-cluster-page="mesh"]')).not.toBeNull()
  expect([...dom.container.querySelectorAll('.settings-nav-section[data-settings-group="cluster"] .settings-nav-items > button')].map(button => button.textContent)).toEqual(['Mesh', 'Node', 'Quick'])
  expect([...dom.container.querySelectorAll('.settings-nav-children[aria-label="Mesh"] button')].map(button => button.textContent)).toEqual([])
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
  expect(dom.container.querySelector('[data-cluster-page="node"]')).toBeNull()
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

it('opens Quick from Mesh and keeps the map and original gateway input on return', async () => {
  useAppStore.setState({ meshGatewayCode: '' })
  await dom.render(pane()); await ready()
  await dom.click(join)
  expect(dom.container.querySelector(quickNav)?.getAttribute('aria-current')).toBe('page')
  expect(dom.container.querySelector('[data-quick-view="mesh-join"]')).not.toBeNull()
  const draft = dom.container.querySelector<HTMLInputElement>('[aria-label="Gateway connection code"]')!
  await input(draft, 'original partially entered gateway code')
  await dom.click(meshNav)
  expect(dom.container.querySelector(meshNav)?.getAttribute('aria-current')).toBe('page')
  expect(dom.container.querySelector('[aria-label="Network relationship canvas"]')?.closest('[hidden]')).toBeNull()
  await dom.click(join)
  expect(dom.container.querySelector(quickNav)?.getAttribute('aria-current')).toBe('page')
  expect(dom.container.querySelector('[aria-label="Gateway connection code"]')).toBe(draft)
  expect(draft.value).toBe('original partially entered gateway code')
  expect(vi.mocked(api.mesh.call).mock.calls.some(([method]) => method === 'settings.mesh.configure')).toBe(false)
})

it('a saved-device action reaches its exact original Host despite duplicate labels and neighboring reordering', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  expect(editor().value).toBe('Farm same label')
  config = { ...config, hosts: [config.hosts[2]!,config.hosts[0]!,config.hosts[1]!] }
  await act(async () => useAppStore.setState({ config }))
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  await dom.click(meshNav); await dom.click('[data-cluster-host="neighbor-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  expect(save).not.toHaveBeenCalled()
})

it('a visited editor remains mounted and consumes a late authored input after returning home without losing its exact draft', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  const original = editor(); await input(original, 'early-authored')
  await dom.click(meshNav)
  expect(original.isConnected).toBe(true)
  expect(original.closest('[data-settings-pane]')?.hasAttribute('hidden')).toBe(true)
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
  await dom.click(meshNav)
  expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(3)
  await dom.click(nodeNav); await dom.click(tab('mesh-devices'))
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(first)
  expect(editor().value).toBe('new original device draft  ')
  expect(save).not.toHaveBeenCalled()
})

it.each(['saved-device', 'deep-link'] as const)('later %s navigation supersedes a deferred Add during the original save and retains both late drafts', async route => {
  config = { ...config, hosts: config.hosts.map(host => host.kind === 'ssh' && host.transport === 'ssh-tailcat' ? { ...host, tailcat: { ...host.tailcat!, address: 'tcfixture-private-credential' } } : host) }
  let release!: () => void, navigationRequest: SettingsNavigationRequest | undefined
  useAppStore.setState({ config })
  const heldSave = vi.spyOn(api.config, 'save').mockImplementation(async next => {
    await new Promise<void>(done => { release = done })
    return next
  })
  const render = () => dom.render(pane(navigationRequest))
  const saveButton = '[data-cluster-node-panel="mesh-devices"] .remote-management > [data-settings-save-bar] > button'
  await render(); await ready(); await dom.click('[data-cluster-host="selected-farm"] button')
  await input(editor(), 'submitted original label')
  expect(dom.container.querySelector<HTMLButtonElement>(saveButton)?.disabled).toBe(false)
  await dom.click(saveButton)
  expect(heldSave).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector(saveButton)?.getAttribute('aria-busy')).toBe('true')
  await input(editor(), 'late original draft  ')
  await dom.click(meshNav); await dom.click('.cluster-add-device')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  if (route === 'saved-device') {
    await dom.click(meshNav); await dom.click('[data-cluster-host="neighbor-farm"] button')
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
  await dom.click(meshNav); await dom.click('[data-cluster-host="selected-farm"] button')
  expect(editor().value).toBe('late original draft  ')
  expect(heldSave).toHaveBeenCalledTimes(1)
})

it('Node groups the three transports and Mesh restores its original filter and status', async () => {
  await dom.render(pane()); await ready()
  const filter = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter saved devices"]')!
  await input(filter, 'neighbor')
  await dom.click(nodeNav)
  const tabs = dom.container.querySelector('[aria-label="Node settings"][role="tablist"]')
  expect([...tabs!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Identity & access', 'Gateway', 'Tailcat', 'SSH'])
  for (const field of ['mesh-configuration', 'incoming', 'mesh-devices']) {
    await dom.click(tab(field))
    expect(dom.container.querySelector(`[data-cluster-node-panel="${field}"]`)?.closest('[hidden]')).toBeNull()
    expect(dom.container.querySelector(tab(field))?.getAttribute('aria-selected')).toBe('true')
  }
  await dom.click(meshNav)
  expect(dom.container.querySelector('[data-settings-field="mesh-machines"]')?.closest('[hidden]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Filter saved devices"]')).toBe(filter)
  expect(filter.value).toBe('neighbor')
  expect(dom.container.querySelectorAll('[data-cluster-host]')).toHaveLength(1)
})

it('never substitutes the local Tailcat listener for another explicit Host', async () => {
  await dom.render(pane({ section: 'hosts', field: 'incoming', hostId: 'neighbor-farm' }))
  expect(dom.container.querySelector('.host-local-incoming')).toBeNull()
  expect(dom.container.querySelector('[data-cluster-node-panel="incoming"]')?.textContent).toContain('The requested local Host is unavailable')
  await dom.click('[data-cluster-node-panel="incoming"] > button')
  expect(dom.container.querySelector('.host-local-incoming')?.closest('[hidden]')).toBeNull()
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
  await dom.click('[aria-label="Selected saved connection"] .mesh-explorer__detail-actions button:last-child')
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
  expect(canvas()?.querySelector('.mesh-geography__atlas')).not.toBeNull()
  expect(canvas()?.querySelectorAll('[data-geographic-point], .mesh-explorer-edge')).toHaveLength(0)
  expect(dom.container.querySelector('.mesh-explorer__map-key')?.textContent).toContain('0 located')
  await dom.click('[aria-label="Network view"] button:nth-child(2)')
  expect(dom.container.querySelector('.mesh-explorer__map-key')?.textContent).toContain('Connection diagram')
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

it('fills only the local Mac map draft after an explicit OS location read and saves only the client annotation', async () => {
  const locate = vi.fn(async (): Promise<MacMapLocationResult> => ({ state: 'located', latitude: 0, longitude: 45 }))
  const saveConfig = vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  const publish = vi.spyOn(api.nodePublishing, 'owner')
  api.ui.requestMacMapLocation = locate
  try {
    await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
    await dom.click('.mesh-explorer__header > button:first-of-type')
    const action = '.mesh-locations-panel__position button'
    const field = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!
    expect(locate).not.toHaveBeenCalled()
    await dom.click(action)
    expect(locate).toHaveBeenCalledTimes(1)
    expect(field().value).toBe('0.0000, 45.0000')
    expect(dom.container.querySelector('.mesh-location-picker .mesh-geography__pin')?.getAttribute('cx')).toBe('625')
    expect(dom.container.querySelector('[data-geographic-point="saved:client"]')).toBeNull()
    expect(saveConfig).not.toHaveBeenCalled()
    await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
    await vi.waitFor(() => expect(dom.container.querySelector('[data-geographic-point="saved:client"] circle')?.getAttribute('cx')).toBe('625'))
    expect(useAppStore.getState().config?.meshMapLocations).toEqual({ local: '0.0000, 45.0000' })
    expect(publish).not.toHaveBeenCalled()
  } finally { delete api.ui.requestMacMapLocation }
})

it('automatically plots the local public egress estimate and lets a manual pin take precedence', async () => {
  const estimate = vi.fn(async () => ({ source: 'public-egress' as const, label: 'Example region', latitude: 31, longitude: 121, accuracyKm: 120 }))
  const locate = vi.fn()
  const locations = vi.spyOn(api.nodePublishing, 'call')
  const remoteReads = () => locations.mock.calls.filter(([method, params]) => method === 'node.location' && 'hostId' in params && params.hostId === 'selected-farm')
  api.ui.estimateLocalMapLocation = estimate
  api.ui.requestMacMapLocation = locate
  vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  try {
    await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
    const localPin = () => dom.container.querySelector('[data-geographic-point="saved:client"]')
    await vi.waitFor(() => expect(localPin()?.hasAttribute('data-approximate')).toBe(true))
    expect(dom.container.querySelector('[data-id="saved:client"]')?.textContent).toContain('IP · ±120 km')
    expect(dom.container.querySelectorAll('[data-geographic-point]')).toHaveLength(1)
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(locate).not.toHaveBeenCalled()
    expect(useAppStore.getState().config?.meshMapLocations).toBeUndefined()
    await dom.click('.mesh-explorer__header > button:first-of-type')
    await input(dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!, '45, -90')
    await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
    await vi.waitFor(() => expect(localPin()?.querySelector('circle')?.getAttribute('cx')).toBe('250'))
    expect(localPin()?.hasAttribute('data-approximate')).toBe(false)
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(remoteReads(), 'remote location reads after saving this device').toHaveLength(1)
    await input(dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!, '')
    await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
    await vi.waitFor(() => expect(localPin()?.hasAttribute('data-approximate')).toBe(true))
    expect(remoteReads(), 'remote location reads after clearing this device').toHaveLength(1)
  } finally {
    delete api.ui.estimateLocalMapLocation
    delete api.ui.requestMacMapLocation
  }
})

it('uses a published local location without asking for an IP estimate', async () => {
  const estimate = vi.fn(async () => null)
  api.ui.estimateLocalMapLocation = estimate
  const node = { runtimeId: 'local-original', ownerInstanceId: 'local-owner', alias: 'desktop' }
  const publishing = vi.spyOn(api.nodePublishing, 'call').mockResolvedValue({ node, location: { source: 'node', label: 'Office', latitude: 0, longitude: 45 } } as never)
  try {
    await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-geographic-point="saved:client"] circle')?.getAttribute('cx')).toBe('625'))
    expect(estimate).not.toHaveBeenCalled()
  } finally {
    publishing.mockRestore()
    delete api.ui.estimateLocalMapLocation
  }
})

it('keeps the confirmed local position until its own refresh replies', async () => {
  const node = { runtimeId: 'local-original', ownerInstanceId: 'local-owner', alias: 'desktop' }
  const position = { source: 'node', label: 'Office', latitude: 0, longitude: 45 }
  const pending = Promise.withResolvers<{ node: typeof node; location: typeof position }>()
  let refresh = false
  let remoteReads = 0
  const publishing = vi.spyOn(api.nodePublishing, 'call').mockImplementation(async (method, params) => {
    if (method === 'node.location' && 'hostId' in params && params.hostId === 'local') {
      return (refresh ? await pending.promise : { node, location: position }) as never
    }
    if (method === 'node.location' && 'hostId' in params && params.hostId === 'selected-farm') remoteReads++
    return { node, location: null } as never
  })
  const pin = () => dom.container.querySelector('[data-geographic-point="saved:client"] circle')
  try {
    await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
    await vi.waitFor(() => expect(pin()?.getAttribute('cx')).toBe('625'))
    refresh = true
    await dom.click('.mesh-explorer__header > button:last-of-type')
    await vi.waitFor(() => expect(remoteReads).toBe(2))
    expect(pin()?.getAttribute('cx'), 'last local point while its own read is pending').toBe('625')
    await act(async () => pending.resolve({ node, location: { ...position, longitude: 90 } }))
    await vi.waitFor(() => expect(pin()?.getAttribute('cx')).toBe('750'))
  } finally {
    publishing.mockRestore()
  }
})

it('a Mac location result after switching devices leaves the original and remote drafts untouched', async () => {
  let complete!: (result: MacMapLocationResult) => void
  const locate = vi.fn(() => new Promise<MacMapLocationResult>(resolve => { complete = resolve }))
  api.ui.requestMacMapLocation = locate
  try {
    await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
    await dom.click('.mesh-explorer__header > button:first-of-type')
    await dom.click('.mesh-locations-panel__position button')
    await dom.click('[data-host-node="neighbor-farm"]')
    await dom.click('[aria-label="Selected saved connection"] .mesh-explorer__detail-actions button:first-child')
    expect(dom.container.querySelector('.mesh-locations-panel__position button')).toBeNull()
    await act(async () => complete({ state: 'located', latitude: 40, longitude: 35 }))
    const field = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!
    expect(field().value).toBe('')
    await dom.click('.mesh-explorer__header > button:first-of-type')
    expect(field().value).toBe('')
    locate.mockResolvedValueOnce({ state: 'denied' })
    await input(field(), '12, 34')
    await dom.click('.mesh-locations-panel__position button')
    expect(field().value).toBe('12, 34')
    expect(dom.container.querySelector('.mesh-locations-panel__position [role=status]')?.textContent).toContain('allow AgentMux')
    await dom.click('.mesh-locations-panel__position button')
    await input(field(), '56, 78')
    await act(async () => complete({ state: 'located', latitude: 40, longitude: 35 }))
    expect(field().value).toBe('56, 78')
  } finally { delete api.ui.requestMacMapLocation }
})

it('saves the exact selected device map location, projects it alongside zero and leaves unplaced devices visible', async () => {
  const original = config.hosts
  vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await ready()
  await dom.click('[data-host-node="neighbor-farm"]')
  await dom.click('[aria-label="Selected saved connection"] .mesh-explorer__detail-actions button:first-child')
  const field = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!
  const saveButton = () => dom.container.querySelector<HTMLButtonElement>('.mesh-locations-panel [data-settings-save-bar] button')!
  const pin = (id: string) => dom.container.querySelector(`[data-geographic-point="${id}"] circle`)
  await input(field(), '100, 0')
  expect(saveButton().disabled).toBe(true)
  await input(field(), '45, -90')
  expect(pin('saved:host:neighbor-farm')).toBeNull()
  await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
  await vi.waitFor(() => expect(pin('saved:host:neighbor-farm')?.getAttribute('cy')).toBe('125'))
  expect(pin('saved:host:neighbor-farm')?.getAttribute('cx')).toBe('250')
  expect(dom.container.querySelector('.mesh-explorer__canvas .mesh-geography__grid [data-equator]')?.getAttribute('y1')).toBe('250')
  expect(pin('saved:host:selected-farm')).toBeNull()
  expect(dom.container.querySelector('.mesh-geography__tray')?.textContent).toContain('Location unknown')
  expect(dom.container.querySelector('[data-host-node="selected-farm"]')).not.toBeNull()
  expect(useAppStore.getState().config?.hosts).toEqual(original)
  await dom.click('.mesh-explorer__header > button:first-of-type')
  const picker = dom.container.querySelector<HTMLButtonElement>('[aria-label="Pick device location on the map"]')!
  vi.spyOn(picker, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 400, 200))
  await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 320, clientY: 90 })))
  expect(field().value).toBe('45.0000, 90.0000')
  expect(pin('saved:client')).toBeNull()
  await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 220, clientY: 140 })))
  expect(field().value).toBe('0.0000, 0.0000')
  await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
  await vi.waitFor(() => expect(pin('saved:client')?.getAttribute('cx')).toBe('500'))
  expect(pin('saved:client')?.getAttribute('cy')).toBe('250')
  await input(field(), '')
  await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
  await vi.waitFor(() => expect(pin('saved:client')).toBeNull())
  await dom.click('[data-host-node="neighbor-farm"]')
  await dom.click('[aria-label="Selected saved connection"] .mesh-explorer__detail-actions button:first-child')
  await input(field(), '')
  await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.mesh-explorer__canvas [data-geographic-point]')).toHaveLength(0))
  expect(dom.container.querySelector('.mesh-explorer__canvas .mesh-geography__atlas')).not.toBeNull()
  expect(useAppStore.getState().config?.meshMapLocations).toEqual({})
})

it('keeps annotations on the selected Relay peer within its network, independent of a saved Host with the same ID', async () => {
  const id = 'neighbor-farm'
  let networkId = 'first-network'
  const identity = { peerId: 'local-peer', publicKey: 'fixture', epoch: 1 }
  vi.mocked(api.mesh.call).mockImplementation(async method => (method === 'mesh.inspect' ? {
    ...observed, identity, network: { protocol: 1, networkId, state: 'active', identity,
      peers: [{ peerId: id, state: 'connected', connectionId: 'link', rttMs: 3 }], records: [], routes: [], circuits: [] },
  } : saved) as never)
  vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  const peer = '[data-id="relay:neighbor-farm"] button'
  await vi.waitFor(() => expect(dom.container.querySelector(peer)).not.toBeNull())
  await dom.click(peer)
  await dom.click('[aria-label="Selected network object"] > div button')
  await input(dom.container.querySelector<HTMLInputElement>('[aria-label="Latitude, longitude"]')!, '0, -90')
  await dom.click('.mesh-locations-panel [data-settings-save-bar] button')
  const marker = () => dom.container.querySelector('[data-geographic-point="relay:neighbor-farm"] circle')
  await vi.waitFor(() => expect(marker()?.getAttribute('cx')).toBe('250'))
  expect(useAppStore.getState().config?.meshNetworkMapLocations).toEqual({ [JSON.stringify([networkId, id])]: '0, -90' })
  expect(dom.container.querySelector('[data-geographic-point="saved:host:neighbor-farm"]')).toBeNull()
  await dom.click('[aria-label="Network view"] button:last-child')
  expect(dom.container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('Marked on this device')
  await dom.click('[aria-label="Network view"] button:first-child')
  expect(marker()).not.toBeNull()
  networkId = 'other-network'
  await dom.click('.mesh-explorer__header > button:last-child')
  await vi.waitFor(() => expect(marker()).toBeNull())
  expect(dom.container.querySelector(peer)).not.toBeNull()
})

it('places an approved device at its own published location and opens the selected gateway route', async () => {
  const offer = { v: 2 as const, serverId: 'outbound-workstation', daemonPublicKeyB64: 'Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=', relay: { endpoint: 'gateway.example', useTls: true } }
  const second = { ...offer, relay: { ...offer.relay, endpoint: 'second.example' } }
  const urls = [offer, second].map(item => connectionLinkUrl('https://' + item.relay.endpoint, item))
  useAppStore.setState({ meshDeviceLinks: { draft: '', saved: urls } })
  const reads = vi.spyOn(api.nodePublishing, 'deviceLocation').mockResolvedValue({
    node: { runtimeId: 'endpoint-runtime', ownerInstanceId: 'endpoint-instance', alias: 'workstation' },
    location: { source: 'node', label: 'Workshop', latitude: 0, longitude: 90 },
  })
  const open = vi.spyOn(api.ui, 'openMeshDevice').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-geographic-point^="device:"] circle')?.getAttribute('cx')).toBe('750'))
  expect(dom.container.querySelectorAll('[data-mesh-device="outbound-workstation"]')).toHaveLength(1)
  expect(open).not.toHaveBeenCalled()
  expect(reads).toHaveBeenCalledTimes(1)
  await dom.click('[data-mesh-device="outbound-workstation"]')
  await dom.click('[aria-label="Network view"] button:last-child')
  const inspector = '[aria-label="Selected device endpoint"]'
  expect(dom.container.querySelector(inspector)?.textContent).toContain('Workshop · Reported by node')
  await dom.click(inspector + ' .mesh-explorer__detail-actions button:last-child')
  expect(open).toHaveBeenCalledExactlyOnceWith(urls[1])
})
