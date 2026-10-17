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
