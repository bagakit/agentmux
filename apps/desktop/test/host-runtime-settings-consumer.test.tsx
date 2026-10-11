// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostRuntimeObservation } from '@agentmux/core'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import type { AppConfig, HostConfig } from '../src/shared/contracts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
const host: HostConfig = { id: 'observed-remote', kind: 'ssh', label: 'Observed environment', hostname: 'private.invalid', runtimeId: 'original-semantic' }
let config: AppConfig
beforeEach(() => { config = { ...composerConfig, hosts: [...composerConfig.hosts, host] }; useAppStore.setState({ config, sessions: [], hostChecks: {} }) })
function observation(): HostRuntimeObservation {
  const missing = { state: 'unavailable' as const, code: 'NATIVE_SOURCE_UNAVAILABLE', message: 'Original Native observation remains unconfirmed.', readAt: _historyFixtureEpoch(0, 5, 0) }
  return { routeHostId: host.id, configuration: host, requestedAt: _historyFixtureEpoch(0, 4, 999), completedAt: _historyFixtureEpoch(0, 5, 0), owner: missing, nativeIdentity: missing, diagnostics: missing,
    resources: { state: 'available', readAt: _historyFixtureEpoch(0, 5, 0), value: { observedAt: _historyFixtureEpoch(0, 4, 0), runCount: 3, runningRuns: 2, terminatedRuns: 1, terminatedUnattachedRuns: 1, attachments: 4, retainedOutputBytes: 2048 } } }
}
it('actual Settings module selects the original saved Host and mounts its real public observation consumer', async () => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValue(observation())
  const Pane = hostsSettingsModule.Pane
  const navigation = { section: 'hosts', hostId: host.id } as const
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={navigation} />)
  // The original name-edit deep link opens Connection, which must not observe.
  expect(inspect).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="overview"]')!.click())
  expect(inspect).toHaveBeenCalledOnce()
  expect(inspect.mock.calls[0]![0]).toEqual(host)
  expect(dom.container.querySelector('[data-host-runtime]')?.getAttribute('data-host-runtime')).toBe(host.id)
  expect(dom.container.textContent).toContain('2 KiB')
  expect(dom.container.textContent).toContain('Some observations unavailable')
  const originalSignal = inspect.mock.calls[0]![1]!.signal!
  await dom.render(<Pane config={config} active={false} onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={navigation} />)
  expect(originalSignal.aborted).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([])
  // Opening the original editing subpage is not another observation consumer.
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={navigation} />)
  expect(inspect).toHaveBeenCalledTimes(2)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="connection"]')!.click())
  expect(inspect.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true)
})
it('does not read the old overview when activation brings a new exact Host navigation intent', async () => {
  const second: HostConfig = { ...host, id: 'another-remote', label: 'Another environment', hostname: 'another.invalid' }
  config = { ...config, hosts: [...config.hosts, second] }
  useAppStore.setState({ config })
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => ({ ...observation(), routeHostId: input.id, configuration: input }))
  const Pane = hostsSettingsModule.Pane, originalNavigation = { section: 'hosts', hostId: host.id } as const
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={originalNavigation} />)
  expect(inspect).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="overview"]')!.click())
  expect(inspect).toHaveBeenCalledOnce()
  expect(inspect.mock.calls[0]![0]).toEqual(host)
  const signal = inspect.mock.calls[0]![1]!.signal!
  await dom.render(<Pane config={config} active={false} onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={originalNavigation} />)
  expect(signal.aborted).toBe(true)
  const nextNavigation = { section: 'hosts', hostId: second.id } as const
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={nextNavigation} />)
  expect(inspect).toHaveBeenCalledOnce()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-host-panel="overview"]')!.click())
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(inspect.mock.calls[1]![0]).toEqual(second)
  expect(dom.container.querySelector('[data-host-runtime]')?.getAttribute('data-host-runtime')).toBe(second.id)
})

it('keeps an unknown initial Host intent unknown without observing the first configured Host', async () => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValue(observation())
  const Pane = hostsSettingsModule.Pane
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={{ section: 'hosts', hostId: 'not-configured' }} />)
  expect(inspect).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-host-runtime]')).toBeNull()
})

it('does not observe a hidden default overview while the initial narrow layout is being measured', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 640, 800))
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => ({ ...observation(), routeHostId: input.id, configuration: input }))
  const Pane = hostsSettingsModule.Pane
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} />)
  expect(inspect).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-host-disclosure="${host.id}"] [data-host-panel="overview"]`)!.click())
  expect(inspect).toHaveBeenCalledOnce()
  expect(inspect.mock.calls[0]![0]).toEqual(host)
})
