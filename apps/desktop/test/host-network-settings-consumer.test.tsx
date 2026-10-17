// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostNetworkObservation } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
const host: HostConfig = { id: 'network-target', kind: 'ssh', label: 'Network target', hostname: 'compute.internal', runtimeId: 'network-runtime' }
const second: HostConfig = { ...host, id: 'other-network', label: 'Other network', hostname: 'other.internal', runtimeId: 'other-runtime' }
let config: AppConfig
beforeEach(() => { config = { ...composerConfig, hosts: [...composerConfig.hosts, host, second] }; useAppStore.setState({ config, sessions: [], hostChecks: {} }) })
function sample(input = host): HostNetworkObservation {
  const readAt = fixtureEpoch(0, 2, 0), interfaces = [{ name: 'eth0', address: '2001:db8:1234:5678:abcd:ef01:2345:6789', cidr: '2001:db8:1234:5678:abcd:ef01:2345:6789/64', family: 'IPv6' as const, internal: false, scopeid: 0 }]
  return { routeHostId: input.id, configuration: input, requestedAt: readAt - 20, completedAt: readAt,
    observer: { state: 'available', readAt, value: { processId: 123, observedAt: readAt, interfaces: [] } },
    target: { state: 'available', readAt, value: { requestDurationMs: 18, sample: { owner: { runtimeId: input.kind === 'ssh' ? input.runtimeId! : 'local-runtime', ownerInstanceId: 'original-owner', processId: 456, protocolVersion: 2, ctxmux: null, availability: 'connected' }, observedAt: readAt - 3, interfaces } } },
    ssh: { state: 'available', readAt, value: { hostname: input.kind === 'ssh' ? input.hostname : 'local', user: 'worker', port: 2222, serverAliveInterval: 17, serverAliveCountMax: 4, tcpKeepAlive: 'yes', proxy: 'jump', jumps: [{ host: 'bastion.internal', user: null, port: null }] } } }
}
async function open(input = host, active = true) {
  const Pane = hostsSettingsModule.Pane
  await dom.render(<Pane config={config} active={active} onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={{ section: 'hosts', hostId: input.id }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="overview"]')!.click())
}
function read() { return dom.container.querySelector<HTMLButtonElement>('[aria-label="Read network details"]')! }
it('network-target: the real workbench reads only its selected saved Host on explicit demand', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockResolvedValue(sample())
  await open(); expect(network).not.toHaveBeenCalled()
  await act(async () => read().click())
  expect(network, 'Network target stays on its selected saved Host').toHaveBeenCalledOnce(); expect(network.mock.calls[0]![0]).toEqual(host)
  expect(dom.container.querySelector('[data-host-network]')?.getAttribute('data-host-network')).toBe(host.id)
  expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('18 ms')
  expect(dom.container.textContent).toContain('17s idle interval'); expect(dom.container.textContent).toContain('bastion.internal')
  expect(dom.container.textContent).toContain('not the physical network route')
  expect(dom.container.textContent).toContain('2001:db8:1234:5678:abcd:ef01:2345:6789/64')
  expect(dom.container.querySelector('[data-host-node="network-target"] [data-route-network]')?.textContent).toContain('Owner request 18 ms')
})
it('network-late: cancelled navigation cannot publish a late result and returning can read again', async () => {
  let resolve!: (value: HostNetworkObservation) => void
  const network = vi.spyOn(api.hosts, 'network').mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(sample())
  await open(); await act(async () => read().click())
  const signal = network.mock.calls[0]![1]!.signal!
  await open(second); expect(signal.aborted).toBe(true)
  await act(async () => resolve(sample()))
  await open(host)
  expect(dom.container.querySelector('[data-network-request]')).toBeNull()
  expect(read().disabled).toBe(false)
  await act(async () => read().click())
  expect(network).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('18 ms')
})
it('network-partial: later failures retain successful source time and refresh remains available', async () => {
  const original = sample(), unavailable = { state: 'unavailable' as const, code: 'SOURCE_UNCONFIRMED', message: 'Original target reply could not be read', readAt: original.completedAt + 1000 }
  vi.spyOn(api.hosts, 'network').mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, target: unavailable, ssh: unavailable, completedAt: unavailable.readAt })
  await open(); await act(async () => read().click()); await act(async () => read().click())
  expect(dom.container.textContent).toContain('Some network sources could not be read')
  expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('Last confirmed')
  expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('18 ms')
  expect(read().disabled).toBe(false)
})
it('network-hidden: hiding stops the exact pending read without leaving the original Host busy', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(sample())
  await open(); await act(async () => read().click())
  const signal = network.mock.calls[0]![1]!.signal!
  await open(host, false); expect(signal.aborted).toBe(true)
  await open(host, true); expect(read().disabled).toBe(false)
  await act(async () => read().click()); expect(network).toHaveBeenCalledTimes(2)
})

it('network-rejected: a whole-call failure releases reading, marks retained values and can retry', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockRejectedValueOnce(new Error('Owner read failed')).mockResolvedValueOnce(sample()).mockRejectedValueOnce(new Error('Refresh failed')).mockResolvedValueOnce(sample())
  await open(); await act(async () => read().click())
  expect(dom.container.textContent).toContain('Owner read failed'); expect(read().disabled).toBe(false)
  await act(async () => read().click()); expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('18 ms')
  await act(async () => read().click()); expect(read().disabled).toBe(false)
  expect(dom.container.textContent).toContain('Refresh failed')
  expect(dom.container.querySelector('[data-network-request]')?.textContent).toContain('Last confirmed')
  expect(dom.container.querySelector('[aria-label="SSH configuration"]')?.textContent).toContain('Last confirmed')
  expect(dom.container.textContent).not.toContain('Evaluated now')
  await act(async () => read().click()); expect(network).toHaveBeenCalledTimes(4)
  expect(dom.container.querySelector('[data-network-request]')?.textContent).not.toContain('Last confirmed')
})

async function linkScope() { await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Selected link"]')!.click()) }
function link() { return dom.container.querySelector<HTMLElement>('[data-network-map]')! }
function linkRead() { return link().querySelector<HTMLButtonElement>('[aria-label="Read selected link"]')! }
function consoleSample(): HostNetworkObservation {
  const value = sample()
  if (value.observer.state === 'available') value.observer.value.interfaces = [
    { name: 'en0', address: '198.51.100.10', cidr: '198.51.100.10/24', family: 'IPv4', internal: false, scopeid: null },
    { name: 'utun3', address: 'fe80::3', cidr: 'fe80::3/64', family: 'IPv6', internal: false, scopeid: 3 }
  ]
  if (value.ssh?.state === 'available') value.ssh.value.jumps.push({ host: '2001:db8::7', user: 'ops', port: 2222 })
  return value
}
it('console-order: the original workbench projects the exact configured intermediaries without a scope-switch probe', async () => {
  const network = vi.spyOn(api.hosts, 'network').mockResolvedValue(consoleSample())
  await open(); await linkScope(); expect(network).not.toHaveBeenCalled()
  expect(link().querySelector('[data-network-map-step="unknown"]')).not.toBeNull()
  await act(async () => linkRead().click())
  expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0]![0]).toEqual(host)
  expect([...link().querySelectorAll('[data-network-map-step="jump"] strong')].map(node => node.textContent), 'Configured transit order stays on its source').toEqual(['bastion.internal', '2001:db8::7'])
  expect(link().textContent).toContain('Port SSH config'); expect(link().textContent).toContain('Port 2222')
  expect(link().querySelector('[data-network-map-step="unknown"]')).toBeNull()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Fleet map"]')!.click())
  expect(dom.container.querySelector('[data-host-node="network-target"]')?.getAttribute('aria-pressed')).toBe('true')
  await linkScope(); expect(network).toHaveBeenCalledOnce()
})
it('console-source: endpoint inventories retain their actual source and exact interface names', async () => {
  vi.spyOn(api.hosts, 'network').mockResolvedValue(consoleSample())
  await open(); await linkScope(); await act(async () => linkRead().click())
  const origin = link().querySelector('[data-interface-rack="observer"]')!, target = link().querySelector('[data-interface-rack="target"]')!
  expect(origin.textContent, 'Origin interfaces retain their exact source').toContain('utun3')
  expect(origin.textContent).toContain('198.51.100.10/24'); expect(origin.textContent).not.toContain('2001:db8:1234:5678')
  expect(target.textContent).toContain('eth0'); expect(target.textContent).not.toContain('utun3')
  expect(target.textContent).toContain('2001:db8:1234:5678:abcd:ef01:2345:6789/64')
  expect(link().textContent).toContain('presence does not confirm a VPN'); expect(origin.textContent).toContain('Observation process 123')
})
it('console-opaque: a custom proxy stays opaque and direct configuration has no invented intermediate', async () => {
  const opaque = consoleSample(), direct = consoleSample()
  if (opaque.ssh?.state === 'available') { opaque.ssh.value.proxy = 'command'; opaque.ssh.value.jumps = [] }
  if (direct.ssh?.state === 'available') { direct.ssh.value.proxy = 'direct'; direct.ssh.value.jumps = [] }
  vi.spyOn(api.hosts, 'network').mockResolvedValueOnce(opaque).mockResolvedValueOnce(direct)
  await open(); await linkScope(); await act(async () => linkRead().click())
  expect(link().querySelectorAll('[data-network-map-step="proxy"]')).toHaveLength(1)
  expect(link().textContent).toContain('Internal path unknown'); expect(link().querySelector('[data-network-map-step="jump"]')).toBeNull()
  await act(async () => linkRead().click())
  expect(link().querySelectorAll('[data-network-map-step]')).toHaveLength(2)
  expect(link().querySelector('[data-network-map-step="proxy"]')).toBeNull()
})
it('console-partial: stale configured intermediaries and inventories keep their original source time', async () => {
  const original = consoleSample(), missing = { state: 'unavailable' as const, readAt: original.completedAt + 1000, code: 'UNCONFIRMED', message: 'Source read unconfirmed' }
  vi.spyOn(api.hosts, 'network').mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, target: missing, ssh: missing, observer: missing })
  await open(); await linkScope(); await act(async () => linkRead().click()); await act(async () => linkRead().click())
  expect(link().textContent).toContain('Last confirmed'); expect(link().textContent).toContain('Source read unconfirmed')
  expect(link().querySelectorAll('[data-network-map-step="jump"]')).toHaveLength(2)
  expect(link().querySelector('[data-interface-rack="observer"]')?.textContent).toContain('utun3')
  expect(link().querySelector('time')?.getAttribute('datetime')).toBe(new Date(original.completedAt).toISOString())
  expect(linkRead().disabled).toBe(false)
})
