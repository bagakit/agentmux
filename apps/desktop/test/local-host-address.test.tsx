// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostNetworkObservation, NetworkInterfaceAddress } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
let config: AppConfig
const iface = (name: string, address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceAddress => ({ name, address, family, internal, cidr: null, scopeid: null })
const interfaces = [iface('utun2', '10.5.0.2'), iface('lo0', '127.0.0.1', 'IPv4', true), iface('en4', '169.254.4.2'), iface('en0', '192.168.40.12'), iface('en0', '2001:db8::12', 'IPv6')]
function sample(host = config.hosts[0]!, addresses = interfaces): HostNetworkObservation {
  const readAt = fixtureEpoch(0, 2, 0)
  return { routeHostId: host.id, configuration: host, requestedAt: readAt - 20, completedAt: readAt,
    observer: { state: 'available', readAt, value: { processId: 123, observedAt: readAt, interfaces: [iface('observer-only', '192.168.99.1')] } },
    target: { state: 'available', readAt, value: { requestDurationMs: 1, sample: { owner: { runtimeId: 'local-runtime', ownerInstanceId: 'original-owner', processId: 456, protocolVersion: 2, ctxmux: null, availability: 'connected' }, observedAt: readAt, interfaces: addresses } } }, ssh: null }
}
beforeEach(() => {
  installNoteCanvasGeometry()
  config = { ...structuredClone(composerConfig), hosts: [structuredClone(composerConfig.hosts[0]!), { id: 'other', kind: 'ssh', label: 'Other Mac', hostname: 'remote.invalid' }] }
  useAppStore.setState({ config, sessions: [], hostChecks: {} })
})
const show = (active = true) => dom.render(<HostSettingsPane config={config} active={active} onSave={vi.fn()} />)
const localNode = () => dom.container.querySelector<HTMLElement>('[data-host-node="local"]')!

it('reads this local Owner once and renders its preferred LAN address without probing other Hosts', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockImplementation(async host => sample(host))
  await show()
  expect(network).toHaveBeenCalledOnce()
  expect(network.mock.calls[0]![0]).toEqual(config.hosts[0])
  expect(localNode().querySelector('.remote-host-node__address')?.textContent).toBe('192.168.40.12')
  expect(localNode().querySelector('.remote-host-node__context')?.textContent).toContain('en0')
  expect(localNode().textContent).not.toContain('192.168.99.1')
  await show()
  const zoom = dom.container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
  await act(async () => zoom.click())
  expect(network).toHaveBeenCalledOnce()
  await act(async () => localNode().dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  const detail = document.querySelector('[role="tooltip"]')!
  expect(detail.textContent).toContain('2001:db8::12')
  expect(detail.textContent).toContain('utun2')
  expect(detail.textContent).toContain('Local Owner')
  expect(detail.textContent).not.toContain('127.0.0.1')
  expect(network).toHaveBeenCalledOnce()
})

it('shares the automatic local observation with the original network detail and reads again only for a changed saved local record', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockImplementation(async host => sample(host))
  await show()
  await act(async () => localNode().click())
  expect(dom.container.querySelector('[data-host-network="local"]')?.textContent).toContain('192.168.40.12')
  expect(network).toHaveBeenCalledOnce()
  config = { ...config, hosts: config.hosts.map(host => host.kind === 'local' ? { ...host, label: 'Renamed Mac' } : host) }
  await show()
  expect(network).toHaveBeenCalledTimes(2)
  expect(network.mock.calls[1]![0].label).toBe('Renamed Mac')
})

it('keeps reading, unknown and no-address separate and cancels the exact read when the page hides', async () => {
  let finish!: (value: HostNetworkObservation) => void
  const network = vi.spyOn(api.hosts, 'network').mockImplementationOnce(() => new Promise(done => { finish = done })).mockImplementation(async host => sample(host, []))
  await show()
  expect(localNode().textContent).toContain('Reading local address…')
  const signal = network.mock.calls[0]![1]!.signal!
  await show(false)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(sample()))
  await show()
  expect(network).toHaveBeenCalledTimes(2)
  expect(localNode().textContent).toContain('No LAN IPv4 address')
  network.mockRejectedValueOnce(new Error('Local Owner unavailable'))
  config = { ...config, hosts: config.hosts.map(host => host.kind === 'local' ? { ...host, label: 'Changed local record' } : host) }
  await show()
  expect(localNode().textContent).toContain('Local address unknown')
  expect(localNode().textContent).not.toContain('192.168.40.12')
})

it('the equal list projection preserves the same sourced local address', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockImplementation(async host => sample(host))
  await show()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="List"]')!.click())
  expect(dom.container.textContent).toContain('192.168.40.12')
  expect(network).toHaveBeenCalledOnce()
})

it('editing the local listener draft preserves the confirmed address without another network read', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockImplementation(async host => sample(host))
  await show()
  await act(async () => localNode().click())
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="connection"]')!.click())
  const key = dom.container.querySelector<HTMLInputElement>('[aria-label="Tailcat server key"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'draft-server')
    key.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(localNode().querySelector('.remote-host-node__address')?.textContent).toBe('192.168.40.12')
  expect(key.value).toBe('draft-server')
  expect(network).toHaveBeenCalledOnce()
})

it('keeps measured ReactFlow nodes visible when their source data and parent presentation update', async () => {
  vi.spyOn(api.hosts, 'network').mockImplementation(async host => sample(host))
  await show()
  const wrapper = () => localNode().closest<HTMLElement>('.react-flow__node')!
  expect(getComputedStyle(wrapper()).visibility).toBe('visible')
  expect(wrapper().offsetWidth).toBeGreaterThan(0)
  const mutations: MutationRecord[] = []
  const observer = new MutationObserver(records => mutations.push(...records))
  observer.observe(wrapper(), { attributes: true, attributeFilter: ['style'], attributeOldValue: true })
  config = { ...config, hosts: config.hosts.map(host => host.kind === 'ssh' ? { ...host, label: 'Renamed remote Mac' } : host) }
  await show()
  mutations.push(...observer.takeRecords()); observer.disconnect()
  // vacuous-ok: unchanged healthy geometry may emit no style mutations; updated data and visible nodes are asserted below.
  expect(mutations.some(change => /visibility:\s*hidden/u.test(change.oldValue ?? '')), 'Measured nodes remain visible throughout the data update').toBe(false)
  expect(dom.container.querySelector('[data-host-node="other"]')?.textContent).toContain('Renamed remote Mac')
  expect(getComputedStyle(wrapper()).visibility).toBe('visible')
})
