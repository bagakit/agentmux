// @vitest-environment happy-dom
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostAgentResourceObservation } from '@agentmux/core'
import type { HostConfig, HostExecutorInventory } from '../src/shared/contracts'
import { ProviderObservations, useProviderObservations } from '../src/renderer/src/components/settings/ProviderObservations'

const { agentResources, discover } = vi.hoisted(() => ({ agentResources: vi.fn(), discover: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { hosts: { agentResources }, executors: { discover } } }))

const primary = { id: 'primary', label: 'Primary', kind: 'ssh', hostname: 'primary.invalid', runtimeId: 'runtime-primary' } as const
const secondary = { id: 'secondary', label: 'Secondary', kind: 'ssh', hostname: 'secondary.invalid', runtimeId: 'runtime-secondary' } as const
const sampleAt = fixtureEpoch(2)

function executorInventory(host: typeof primary | typeof secondary, providers: string[]): HostExecutorInventory {
  return { routeHostId: host.id, runtimeId: host.runtimeId, executors: providers.map((providerId, index) => ({
    executorId: `executor-${index}`, label: providerId, providerId, command: 'provider',
    source: index === 0 ? 'provider-default' : 'registered', configRevision: 'original', availability: 'unknown'
  })) }
}

function measure(host: HostConfig, kind: HostAgentResourceObservation['kind'], count: number, observedAt = sampleAt): HostAgentResourceObservation {
  const base = { routeHostId: host.id, requestedAt: sampleAt, completedAt: sampleAt,
    owner: { state: 'available' as const, readAt: sampleAt, value: {
      runtimeId: host.kind === 'ssh' ? host.runtimeId ?? 'runtime-unpinned' : 'runtime-local',
      ownerInstanceId: 'owner-instance', protocolVersion: 2 as const, processId: 100, availability: 'connected' as const,
      ctxmux: { hostId: 'local', processId: 101, instanceId: 'original-native', buildIdentity: 'fixture', protocolVersion: 18 }
    } } }
  return kind === 'records' ? { ...base, kind, measurement: { state: 'available', readAt: sampleAt,
    value: { saved: count, retired: 0, observedAt } } } :
    { ...base, kind, measurement: { state: 'available', readAt: sampleAt,
      value: { count, nativeInstanceId: 'original-native', observedAt, nativeObservedAt: observedAt - 1 } } }
}

function defer<T>() {
  let resolve!: (value: T) => void
  const pending = new Promise<T>(finish => { resolve = finish })
  return { pending, resolve }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function Surface({ host, active, refresh }: { host: HostConfig; active: boolean; refresh: number }) {
  const observations = useProviderObservations(host, active, refresh)
  return <><ProviderObservations observations={observations} />
    <output>{observations.executors?.countsByProvider.get('shared-provider') ?? 'Unknown'}</output></>
}

async function render(host: HostConfig, refresh = 0, active = true) {
  await act(async () => root.render(<Surface host={host} active={active} refresh={refresh} />))
}

const values = () => [...container.querySelectorAll('.provider-observation__count')].map(node => node.textContent)
const executorTotal = () => container.querySelector('.provider-observation__total')?.textContent

it('reads all three sources for the selected visible Host and keeps exact independent values through a partial refresh', async () => {
  discover.mockResolvedValueOnce(executorInventory(primary, ['shared-provider', 'shared-provider', 'other-provider']))
  agentResources.mockImplementation((host, kind) => Promise.resolve(measure(host, kind, kind === 'records' ? 7 : 2)))
  await render(primary, 0, false)
  expect(discover).not.toHaveBeenCalled()
  expect(agentResources).not.toHaveBeenCalled()

  await render(primary)
  expect(values()).toEqual(['7', '2', '0'])
  expect(executorTotal()).toBe('3')
  expect(container.querySelector('output')?.textContent).toBe('2')
  expect(container.querySelector('[aria-label="Executor entries"] dl')?.textContent).toBe('Provider defaults1Configured or registered2')
  expect(discover.mock.calls).toEqual([[primary.id, { refresh: false }]])
  expect(agentResources.mock.calls.map(([host, kind, runtimeId]) => [host, kind, runtimeId])).toEqual([
    [primary, 'records', primary.runtimeId], [primary, 'running', primary.runtimeId]
  ])

  discover.mockResolvedValueOnce({ ...executorInventory(primary, []), runtimeId: secondary.runtimeId })
  agentResources.mockImplementation((host, kind) => kind === 'records' ? Promise.resolve(measure(host, kind, 9))
    : Promise.resolve({ ...measure(host, kind, 0), measurement: { state: 'unavailable', code: 'NO_NATIVE_SAMPLE', message: 'Original Running measurement unavailable', readAt: sampleAt } }))
  await render(primary, 1)
  expect(values()).toEqual(['9', '2', '0'])
  expect(executorTotal()).toBe('3')
  expect(container.querySelector('[aria-label="Executor entries"] header')?.textContent).toContain('Last confirmed')
  expect(container.querySelector('[aria-label="Session states"] [data-reading="stale"]')?.textContent).toContain('Running saved2Last confirmed')
  expect([...container.querySelectorAll('[role="status"]')].map(node => node.textContent)).toEqual([
    'Executor inventory: The Executor inventory belongs to another Host or Runtime.',
    'Running saved bindings: Original Running measurement unavailable'
  ])
})

it('drops old replies even after changing Host and returning to the same saved route', async () => {
  const oldExecutor = defer<HostExecutorInventory>()
  const oldRecords = defer<HostAgentResourceObservation>()
  discover.mockReturnValueOnce(oldExecutor.pending)
    .mockResolvedValueOnce(executorInventory(secondary, []))
    .mockResolvedValueOnce(executorInventory(primary, ['shared-provider']))
  agentResources.mockImplementationOnce(() => oldRecords.pending)
    .mockImplementation((host, kind) => Promise.resolve(measure(host, kind, host === secondary ? 0 : 1)))
  await render(primary)
  expect(values()).toEqual(['—', '1', '—'])
  expect(executorTotal()).toBe('—')
  await render(secondary)
  expect(agentResources.mock.calls[0]?.[3].signal.aborted).toBe(true)
  expect(values()).toEqual(['0', '0', '0'])
  expect(executorTotal()).toBe('0')
  await render(primary)
  expect(values()).toEqual(['1', '1', '0'])
  expect(executorTotal()).toBe('1')
  await act(async () => {
    oldExecutor.resolve(executorInventory(primary, ['shared-provider', 'shared-provider']))
    oldRecords.resolve(measure(primary, 'records', 99))
  })
  expect(values()).toEqual(['1', '1', '0'])
  expect(executorTotal()).toBe('1')
  expect(container.querySelector('output')?.textContent).toBe('1')
})

it('keeps missing observations distinct from a confirmed zero', async () => {
  discover.mockRejectedValue(new Error('Original inventory unavailable'))
  agentResources.mockImplementation((host, kind) => kind === 'records' ? Promise.reject(new Error('Original Store unavailable'))
    : Promise.resolve(measure(host, kind, 0)))
  await render(primary)
  expect(values()).toEqual(['—', '0', '—'])
  expect(executorTotal()).toBe('—')
  expect(container.querySelector('[aria-label="Executor entries"]')?.getAttribute('data-reading')).toBe('unavailable')
  const sessionBars = [...container.querySelectorAll<HTMLElement>('[aria-label="Session states"] .provider-observation__bar > span')]
  expect(sessionBars.map(bar => bar.style.width)).toEqual(['0%'])
})

it('retains confirmed counts when a source time falls outside the renderer date range', async () => {
  discover.mockResolvedValue(executorInventory(primary, ['shared-provider']))
  agentResources.mockImplementation((host, kind) => Promise.resolve(measure(host, kind, 1, Number.MAX_SAFE_INTEGER)))
  await render(primary)
  expect(values()).toEqual(['1', '1', '0'])
  expect(executorTotal()).toBe('1')
  expect(container.querySelector('[aria-label="Session states"]')?.textContent).toContain('Unknown time')
})
