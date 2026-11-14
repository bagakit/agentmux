// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { HostRuntimeObservation } from '@agentmux/core'
import type { NodeResources, NodeResourceSample } from '@agentmux/core/node-publishing'
import { HostRuntimePanel } from '../src/renderer/src/components/settings/HostRuntimePanel'
import { HostNodeResources } from '../src/renderer/src/components/settings/HostNodeResources'
import { nodeTrendPoints } from '../src/renderer/src/components/settings/node-resource-view'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { HostConfig } from '../src/shared/contracts'
const engine = vi.hoisted(() => ({ replaceData: vi.fn(), dispose: vi.fn(), resize: vi.fn(), create: vi.fn() }))
vi.mock('@agentmux/editor-extensions/engines/vega-worker', () => ({ createVegaPreview: (...args: unknown[]) => { engine.create(...args); return engine } }))
const dom = composerDOM(), host: HostConfig = { id: 'farm', kind: 'ssh', label: 'Original service', hostname: 'private.invalid', runtimeId: 'farm-runtime' }
const node = { runtimeId: 'farm-runtime', ownerInstanceId: 'original-core', alias: 'farm' }, available = <T,>(value: T) => ({ state: 'available' as const, value })
function sample(at = 1000): NodeResourceSample { return { node, processId: 123, policyRevision: 'share-false', observedAt: at,
  cpu: available({ logicalCpus: 4, userMs: at, niceMs: 0, systemMs: 0, idleMs: at * 3, irqMs: 0, loadAverage: [0, 0, 0] }),
  memory: available({ totalBytes: 8 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 }), system: available({ platform: 'linux', architecture: 'x64', uptimeSeconds: 3600 }),
  filesystem: available({ root: null, totalBytes: 10 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }),
  process: available({ cpuUserMicros: at * 200, cpuSystemMicros: 0, rssBytes: 128 * 1024 ** 2, heapUsedBytes: 16 * 1024 ** 2, heapTotalBytes: 32 * 1024 ** 2, externalBytes: 0, uptimeSeconds: at / 1000 }) } }
const resources = (at = 1000): NodeResources => ({ node, policyRevision: 'share-false', status: 'available', sample: sample(at) })
function observed(input = host): HostRuntimeObservation { const missing = { state: 'unavailable' as const, code: 'INDEPENDENT_SOURCE', message: 'Independent diagnostics unavailable', readAt: 1000 }; return { routeHostId: input.id, configuration: input, requestedAt: 1000, completedAt: 1000, owner: missing, nativeIdentity: missing, diagnostics: missing, resources: { state: 'available', readAt: 1000, value: { observedAt: 1000, runCount: 7, runningRuns: 2, terminatedRuns: 5, terminatedUnattachedRuns: 3, attachments: 4, retainedOutputBytes: 2048 } } } }
beforeEach(() => { vi.useFakeTimers(); for (const mock of Object.values(engine)) mock.mockClear() })
afterEach(() => vi.useRealTimers())
it('exact private service measurements render before optional diagnostics answer and update one inline chart without changing Share', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(() => new Promise(() => {}))
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockResolvedValueOnce(resources()).mockResolvedValue(resources(6000)), published = vi.spyOn(api.nodePublishing, 'call')
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(owner).toHaveBeenCalledExactlyOnceWith({ hostId: 'farm', expectedRuntimeId: 'farm-runtime' }, 'settings.node.resources', {}, expect.any(AbortSignal))
  expect(published).not.toHaveBeenCalled(); expect(dom.container.textContent).toContain('128 MiB')
  expect(dom.container.textContent).toContain('Private owner view'); expect(dom.container.textContent).toContain('Waiting for the next compatible sample')
  expect(engine.create).toHaveBeenCalledOnce(); expect(engine.replaceData.mock.calls.at(-1)?.[1][0]).toMatchObject({ coreCpu: null, coreMiB: 128 })
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) }); expect(owner).toHaveBeenCalledTimes(3)
  expect(api.hosts.inspect).toHaveBeenCalledOnce(); expect(dom.container.textContent).toContain('20.0%')
  expect(owner.mock.calls.every(call => call[1] === 'settings.node.resources')).toBe(true)
})
it('serving Core and Native sources stay distinct while compatible CPU samples reach the actual chart dataset', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockResolvedValueOnce(resources()).mockResolvedValue(resources(6000))
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(dom.container.textContent).toContain('20.0%'); expect(dom.container.textContent).toContain('One logical core = 100%')
  expect(dom.container.querySelector('[aria-label="Native workload measurements"]')?.textContent).toContain('7 retained in total')
  expect(dom.container.querySelector('[aria-label="Native workload measurements"]')?.textContent).toContain('2 KiB')
  expect(engine.create).toHaveBeenCalledOnce(); expect(engine.replaceData.mock.calls.at(-1)?.[1][1]).toMatchObject({ coreCpu: 20, coreMiB: 128 })
  await dom.render(<HostRuntimePanel host={host} committed={host} active={false} />)
  const count = owner.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(owner).toHaveBeenCalledTimes(count); expect(engine.dispose).toHaveBeenCalledOnce()
})
it('a late previous target sample is aborted and cannot enter the replacement Host chart', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  let finish!: (value: NodeResources) => void
  const other: HostConfig = { ...host, id: 'other', runtimeId: 'other-runtime' }
  const next = { ...resources(), node: { ...node, runtimeId: 'other-runtime' }, sample: { ...sample(), node: { ...node, runtimeId: 'other-runtime' }, process: available({ cpuUserMicros: 0, cpuSystemMicros: 0, rssBytes: 160 * 1024 ** 2, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, uptimeSeconds: 1 }) } } as NodeResources
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockImplementationOnce(() => new Promise(done => { finish = done })).mockResolvedValue(next)
  await dom.render(<HostRuntimePanel host={host} committed={host} active />); const signal = owner.mock.calls[0]![3]!
  await dom.render(<HostRuntimePanel host={other} committed={other} active />); expect(signal.aborted).toBe(true)
  await act(async () => finish(resources())); expect(dom.container.textContent).toContain('160 MiB'); expect(dom.container.textContent).not.toContain('128 MiB')
  expect(owner.mock.calls[1]![0]).toEqual({ hostId: 'other', expectedRuntimeId: 'other-runtime' })
})
it('public withheld resources never render retained private numbers or a zero/old chart', async () => {
  await dom.render(<HostNodeResources reply={{ node, policyRevision: 'withdrawn', status: 'withheld' }} frames={[{ at: 1000, sample: sample() }]} busy={false} active />)
  expect(dom.container.textContent).toContain('not shared'); expect(dom.container.textContent).not.toContain('128 MiB')
  expect(dom.container.querySelector('[aria-label="Core process measurements"]')).toBeNull(); expect(engine.create).not.toHaveBeenCalled()
})
it('process generations and missing sample boundaries cannot produce CPU from unrelated counters', () => {
  const first = sample(), next = sample(6000); next.node = { ...node, ownerInstanceId: 'replacement-core' }
  expect(nodeTrendPoints([{ at: 1000, sample: first }, { at: 6000, sample: next }]).map(point => point.coreCpu)).toEqual([null, null])
  expect(nodeTrendPoints([{ at: 1000, sample: first }, { at: 2000, sample: null }, { at: 6000, sample: sample(6000) }]).map(point => point.coreCpu)).toEqual([null, null, null])
})
it('an unavailable private source preserves the same original published measurements without promoting the caller', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockRejectedValue(new Error('Original owner permission unavailable'))
  const published = vi.spyOn(api.nodePublishing, 'call').mockResolvedValue(resources())
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(owner).toHaveBeenCalledOnce(); expect(published).toHaveBeenCalledExactlyOnceWith('node.resources', { hostId: 'farm', expectedRuntimeId: 'farm-runtime' }, expect.any(AbortSignal))
  expect(dom.container.textContent).toContain('Private service read unavailable')
  expect(dom.container.textContent).toContain('Published by this node'); expect(dom.container.textContent).toContain('128 MiB')
  expect(dom.container.textContent).not.toContain('Last confirmed')
})
it('a pending Node read does not queue duplicates or stop the original Native workload source', async () => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockImplementation(() => new Promise(() => {}))
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(owner).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledTimes(3)
  expect(dom.container.querySelector('[aria-label="Native workload measurements"]')?.textContent).toContain('7 retained in total')
})

const agentOwner = { runtimeId: node.runtimeId, ownerInstanceId: node.ownerInstanceId, processId: 123, protocolVersion: 2, ctxmux: null, availability: 'connected' as const }
function agents(kind: 'records' | 'running', saved = 14): import('@agentmux/core').HostAgentResourceObservation {
  const base = { routeHostId: host.id, requestedAt: 1000, completedAt: 1000, owner: { state: 'available' as const, readAt: 1000, value: agentOwner } }
  return kind === 'records' ? { ...base, kind, measurement: { state: 'available', readAt: 1000, value: { observedAt: 1000, saved, retired: 4 } } }
    : { ...base, kind, measurement: { state: 'available', readAt: 2000, value: { observedAt: 2000, count: 3, nativeObservedAt: 1500, nativeInstanceId: 'original-native' } } }
}
it.each(['records', 'running'] as const)('pending %s remains one request while the other Agent source, Native and Node continue on the original clock', async pending => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  const owner = vi.spyOn(api.nodePublishing, 'owner').mockResolvedValue(resources())
  const counts = vi.spyOn(api.hosts, 'agentResources').mockImplementation(async (_host, kind) => kind === pending ? new Promise(() => {}) : agents(kind))
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(counts.mock.calls.filter(call => call[1] === pending)).toHaveLength(1)
  expect(counts.mock.calls.filter(call => call[1] !== pending)).toHaveLength(3)
  expect(counts.mock.calls.every(call => call[0] === host && call[2] === 'farm-runtime' && call[3]?.signal instanceof AbortSignal)).toBe(true)
  expect(inspect).toHaveBeenCalledTimes(3); expect(owner).toHaveBeenCalledTimes(3)
  const values = [...dom.container.querySelectorAll('[aria-label="Agent record measurements"] strong')].map(n => n.textContent)
  expect(values).toEqual(pending === 'records' ? ['Agent records', '—', '3', '—'] : ['Agent records', '14', '—', '4'])
  expect(dom.container.querySelector('[aria-label="Native workload measurements"]')?.textContent).toContain('7 retained in total')
  await dom.render(<HostRuntimePanel host={host} committed={host} active={false} />)
  expect(counts.mock.calls[0]![3]!.signal!.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) }); expect(counts).toHaveBeenCalledTimes(4)
})
it('Agent counts retain their own confirmed time on an old/missing source, clear a known changed owner and never borrow Native Run counts', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  vi.spyOn(api.nodePublishing, 'owner').mockResolvedValue(resources())
  let generation = 0
  vi.spyOn(api.hosts, 'agentResources').mockImplementation(async (_host, kind) => {
    const result = agents(kind)
    if (kind === 'records' && generation === 1) throw Error('Old Core Agent record leaf unavailable')
    if (kind === 'records' && generation === 2) return { ...result, owner: { ...result.owner, state: 'available', value: { ...agentOwner, ownerInstanceId: 'new-core' } }, measurement: { state: 'unavailable', readAt: 3000, code: 'STORE_UNKNOWN', message: 'New Core Store not observed' } } as import('@agentmux/core').HostAgentResourceObservation
    return result
  })
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  generation = 1; await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  const section = dom.container.querySelector('[aria-label="Agent record measurements"]')!
  expect(section.textContent).toContain('14'); expect(section.querySelector('[data-agent-source="records"]')?.textContent).toContain('Last confirmed')
  expect(section.textContent).not.toContain('7'); expect(section.textContent).toContain('Old Core Agent record leaf unavailable')
  expect([...section.querySelectorAll('.host-runtime__resources small')].map(n => n.textContent)).toEqual(['Last confirmed', 'Running bindings', 'Last confirmed'])
  expect(section.querySelector('details')?.open).toBe(false)
  generation = 2; await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect([...section.querySelectorAll('strong')].map(n => n.textContent)).toEqual(['Agent records', '—', '3', '—'])
  expect(section.textContent).toContain('New Core Store not observed')
})
it('changed Host aborts a deferred Agent response and cannot replace the new selected Host counts', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  vi.spyOn(api.nodePublishing, 'owner').mockImplementation(() => new Promise(() => {}))
  let finish!: (reply: import('@agentmux/core').HostAgentResourceObservation) => void
  const other: HostConfig = { ...host, id: 'other', runtimeId: 'other-runtime' }
  const counts = vi.spyOn(api.hosts, 'agentResources').mockImplementation(async (input, kind) => {
    if (input.id === host.id) return new Promise(done => { if (kind === 'records') finish = done })
    const reply = agents(kind, 99)
    return { ...reply, routeHostId: input.id, owner: { state: 'available', readAt: 2000, value: { ...agentOwner, runtimeId: 'other-runtime' } } } as import('@agentmux/core').HostAgentResourceObservation
  })
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  const signal = counts.mock.calls[0]![3]!.signal!
  await dom.render(<HostRuntimePanel host={other} committed={other} active />)
  await act(async () => finish(agents('records')))
  expect(signal.aborted).toBe(true)
  expect(dom.container.querySelector('[aria-label="Agent record measurements"]')?.textContent).toContain('99')
  expect(dom.container.querySelector('[aria-label="Agent record measurements"]')?.textContent).not.toContain('14')
})
it('actual chart dataset and accessible table use elapsed Core I/O operations with independent missing/scope/restart gaps', async () => {
  const first = sample(), second = sample(6000)
  first.filesystemIo = available({ scope: 'filesystem', readOperations: 100, writeOperations: 200 })
  second.filesystemIo = available({ scope: 'filesystem', readOperations: 120, writeOperations: 235 })
  const frames = [{ at: first.observedAt, sample: first }, { at: second.observedAt, sample: second }]
  await dom.render(<HostNodeResources reply={{ ...resources(), sample: second }} frames={frames} busy={false} active />)
  expect(engine.create).toHaveBeenCalledOnce()
  const dataset = engine.replaceData.mock.calls.at(-1)![1]
  expect(dataset[0]).toMatchObject({ ioRead: null, ioWrite: null, ioReadTotal: 100, ioWriteTotal: 200 })
  expect(dataset[1]).toMatchObject({ ioRead: 4, ioWrite: 7, ioReadTotal: 120, ioWriteTotal: 235 })
  expect(dom.container.querySelector('[aria-label="Core I/O operations"]')?.textContent).toContain('4.0 /s')
  expect(dom.container.querySelector('table')?.textContent).toContain('Read total ops')
  const oldCore = structuredClone(second); delete oldCore.filesystemIo
  for (const altered of [oldCore, { ...second, node: { ...node, ownerInstanceId: 'new' } }, { ...second, processId: 999 }, { ...second, filesystemIo: available({ scope: 'process-io' as const, readOperations: 120, writeOperations: 235 }) } ]) {
    expect(nodeTrendPoints([{ at: 1000, sample: first }, { at: 6000, sample: altered }]).at(-1)).toMatchObject({ ioRead: null, ioWrite: null })
  }
  expect(nodeTrendPoints([{ at: 1000, sample: first }, { at: 2000, sample: null }, { at: 6000, sample: second }]).at(-1)).toMatchObject({ ioRead: null, ioWrite: null })
  const regressed = { ...second, filesystemIo: available({ scope: 'filesystem' as const, readOperations: 99, writeOperations: 235 }) }
  expect(nodeTrendPoints([{ at: 1000, sample: first }, { at: 6000, sample: regressed }]).at(-1)).toMatchObject({ ioRead: null, ioWrite: null })
})
it('shared resources withheld leaves exact independently available Agent records visible with no invented I/O zero', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  vi.spyOn(api.hosts, 'agentResources').mockImplementation(async (_host, kind) => agents(kind))
  vi.spyOn(api.nodePublishing, 'owner').mockRejectedValue(Error('Original private owner denied'))
  vi.spyOn(api.nodePublishing, 'call').mockResolvedValue({ node, policyRevision: 'not-shared', status: 'withheld' })
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(dom.container.querySelector('[aria-label="Agent record measurements"]')?.textContent).toContain('14')
  expect(dom.container.textContent).toContain('not shared'); expect(dom.container.querySelector('[aria-label="Core I/O operations"]')).toBeNull()
})
it('unchanged Node samples do not resend chart data for unrelated renders or independently completed Agent counts', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async input => observed(input))
  vi.spyOn(api.nodePublishing, 'owner').mockResolvedValueOnce(resources()).mockImplementation(() => new Promise(() => {}))
  let saved = 14
  vi.spyOn(api.hosts, 'agentResources').mockImplementation(async (_host, kind) => agents(kind, saved))
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  const updates = engine.replaceData.mock.calls.length
  expect(updates).toBeGreaterThan(0)
  await dom.render(<HostRuntimePanel host={{ ...host }} committed={{ ...host }} active />)
  expect(engine.replaceData).toHaveBeenCalledTimes(updates)
  saved = 15; await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(dom.container.querySelector('[aria-label="Agent record measurements"]')?.textContent).toContain('15')
  expect(engine.replaceData).toHaveBeenCalledTimes(updates)
  expect(engine.create).toHaveBeenCalledOnce()
})
