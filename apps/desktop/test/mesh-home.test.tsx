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
const configuration: MeshNetworkSettings['configuration'] = { role: 'disabled', networkId: 'my-devices', members: [], peers: [], publishers: [], advertisedIngress: [], endpointAccess: { allowedClientKeys: [] } }
const saved: MeshNetworkSettings = { owner: { runtimeId: 'original-home-runtime', ownerInstanceId: 'original-home-instance' }, identity: null, revision: 'r1', configuration, operation: null }
const observed: MeshNetworkInspection = { owner: saved.owner, identity: null, source: 'managed', activeRevision: 'r1', desiredRevision: 'r1', apply: { state: 'disabled' }, gateway: { state: 'disabled' }, endpoint: { state: 'not-provided' }, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true }, network: null, observedAt: 1000 }
let config: AppConfig
const save = vi.fn(async () => {})
beforeEach(() => {
  config = { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, { id: 'selected-farm', kind: 'ssh', label: 'Farm same label', hostname: 'farm-original.internal' }, { id: 'neighbor-farm', kind: 'ssh', label: 'Farm same label', hostname: 'neighbor.internal', runtimeId: 'neighbor-original-runtime', transport: 'ssh-tailcat', tailcat: { address: 'fixture-private-credential', keyFile: 'fixture-client-key-path' } }] }
  useAppStore.setState({ config, sessions: [], hostChecks: {}, tailcatConnectionDrafts: {}, meshSettingsDrafts: {} })
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observed : saved) as never)
  save.mockClear()
})
async function input(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
function pane() { return <MeshSettingsPane config={config} active onSave={save} /> }
function editor() { return dom.container.querySelector<HTMLInputElement>('[data-mesh-view="connections"] [data-host-name]')! }
async function ready() { await vi.waitFor(() => expect(dom.container.querySelector('[data-mesh-saved-host="selected-farm"]')).not.toBeNull()) }

it('the actual SettingsPanel opens a continuous Mesh homepage with the saved device directory and only Overview/Machines observation tasks', async () => {
  await dom.render(<SettingsPanel initialSection="hosts" onClose={vi.fn()} />); await ready()
  expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe('paths')
  expect([...dom.container.querySelectorAll('[aria-label="Mesh views"] button')].map(button => button.textContent)).toEqual(['Overview', 'Machines'])
  expect(dom.container.querySelector('[data-mesh-saved-host="selected-farm"]')?.textContent).toContain('farm-original.internal')
  expect(dom.container.querySelector('[data-mesh-saved-host="neighbor-farm"]')?.textContent).toContain('neighbor.internal')
  expect(dom.container.querySelector('[aria-label="Saved devices"]')?.textContent).toContain('separate from observed Mesh peers')
  expect(dom.container.querySelector('[aria-label="Selected network object"]')).toBeNull()
  expect(dom.container.querySelector('[data-mesh-view="network"]')?.hasAttribute('hidden')).toBe(true)
  const filter = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter saved devices"]')!, reads = vi.mocked(api.mesh.call).mock.calls.length
  for (const value of ['NEIGHBOR.INTERNAL', 'neighbor-farm', 'neighbor-original-runtime']) {
    await input(filter, value)
    expect([...dom.container.querySelectorAll('[data-mesh-saved-host]')].map(node => node.getAttribute('data-mesh-saved-host'))).toEqual(['neighbor-farm'])
  }
  await input(filter, 'Farm same label'); expect(dom.container.querySelectorAll('[data-mesh-saved-host]')).toHaveLength(2)
  for (const value of ['fixture-private-credential', 'fixture-client-key-path', 'not-saved-here']) {
    await input(filter, value)
    expect(dom.container.querySelectorAll('[data-mesh-saved-host]')).toHaveLength(0)
    expect(dom.container.querySelector('.mesh-saved-devices-empty')?.textContent).toContain('No saved devices match this filter. 3 saved connections remain available.')
    expect(dom.container.querySelector('.mesh-saved-devices-empty')?.textContent).not.toContain('No device connections have been saved')
  }
  await dom.click('.mesh-saved-devices-empty button'); expect(dom.container.querySelectorAll('[data-mesh-saved-host]')).toHaveLength(3)
  expect(dom.container.querySelector('[aria-label="Find a peer, endpoint or circuit"]')).toBeNull()
  expect(vi.mocked(api.mesh.call).mock.calls).toHaveLength(reads)
  expect(save).not.toHaveBeenCalled()
})

it('a saved-device action reaches its exact original Host despite duplicate labels and neighboring reordering', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-mesh-saved-host="selected-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  expect(editor().value).toBe('Farm same label')
  config = { ...config, hosts: [config.hosts[2]!,config.hosts[0]!,config.hosts[1]!] }
  await dom.render(pane())
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  await dom.click('.mesh-editor-navigation button'); await dom.click('[data-mesh-saved-host="neighbor-farm"] button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('neighbor-farm')
  expect(save).not.toHaveBeenCalled()
})

it('a visited editor remains mounted and consumes a late authored input after returning home without losing its exact draft', async () => {
  await dom.render(pane()); await ready(); await dom.click('[data-mesh-saved-host="selected-farm"] button')
  const original = editor(); await input(original, 'early-authored')
  await dom.click('.mesh-editor-navigation button')
  expect(original.isConnected).toBe(true)
  expect(dom.container.querySelector('[data-mesh-view="connections"]')?.hasAttribute('hidden')).toBe(true)
  await input(original, 'late original draft  ')
  await dom.click('[data-mesh-saved-host="selected-farm"] button')
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
  await dom.render(pane()); await ready(); await dom.click('.mesh-overview-actions .primary-button')
  const first = dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')
  expect(first).toBeTruthy(); expect(config.hosts.some(host => host.id === first)).toBe(false)
  await input(editor(), 'new original device draft  ')
  await dom.click('.mesh-editor-navigation button')
  expect(dom.container.querySelectorAll('[data-mesh-saved-host]')).toHaveLength(3)
  await dom.click('.mesh-overview-actions button:nth-child(2)')
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
  await render(); await ready(); await dom.click('[data-mesh-saved-host="selected-farm"] button')
  await input(editor(), 'submitted original label')
  expect(dom.container.querySelector<HTMLButtonElement>(saveButton)?.disabled).toBe(false)
  await dom.click(saveButton)
  expect(heldSave).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector(saveButton)?.getAttribute('aria-busy')).toBe('true')
  await input(editor(), 'late original draft  ')
  await dom.click('.mesh-editor-navigation button'); await dom.click('.mesh-overview-actions .primary-button')
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('selected-farm')
  if (route === 'saved-device') {
    await dom.click('.mesh-editor-navigation button'); await dom.click('[data-mesh-saved-host="neighbor-farm"] button')
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
  await dom.click('.mesh-editor-navigation button'); await dom.click('[data-mesh-saved-host="selected-farm"] button')
  expect(editor().value).toBe('late original draft  ')
  expect(heldSave).toHaveBeenCalledTimes(1)
})
