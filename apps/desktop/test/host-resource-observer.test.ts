import { afterEach, expect, it, vi } from 'vitest'
import type { CpuInfo } from 'node:os'
import { parseHostResourceSnapshot, parseMetricsObservation } from '@agentmux/core/control'
import { HostResourceObserver, parseDarwinMemory, parseDarwinNetworkCounters, type HostResourceSources } from '../src/main/host-resource-observer.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { MainPerformanceDiagnostics } from '../src/main/performance-diagnostics.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '@agentmux/core'
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))

const header = 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll'
const network = (rx = 100, tx = 200, id = 4) => `${header}\nen0 1500 <Link#${id}> aa:bb:cc:dd:ee:ff 1 0 ${rx} 2 0 ${tx} 0\nen0 1500 10/8 10.0.0.1 1 - ${rx} 2 - ${tx} -\nutun0 1500 <Link#9> 1 0 500 2 0 800 0\nlo0 16384 <Link#1> 1 0 900 2 0 900 0`
const memory = 'vm.swapusage: total = 1024.00M  used = 512.00M  free = 512.00M (encrypted)\nkern.memorystatus_vm_pressure_level: 2'
const cpu = (user = 100, idle = 900, model = 'cpu'): CpuInfo => ({ model, speed: 0, times: { user, idle, sys: 0, nice: 0, irq: 0 } })
function fixture() {
  let at = 0, cpus = [cpu()], net = network()
  const command = vi.fn(async (file: string, _args: string[], _signal: AbortSignal) => file.endsWith('netstat') ? net : memory)
  const source: HostResourceSources = { cpu: () => cpus, memory: () => ({ totalBytes: 8192, freeBytes: 1024 }), command,
    platform: 'darwin', now: () => 1000 + at, monotonic: () => at }
  return { observer: new HostResourceObserver(source), source, command,
    at: (value: number) => { at = value }, cpu: (value: CpuInfo[]) => { cpus = value }, network: (value: string) => { net = value } }
}
const signal = () => new AbortController().signal
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('uses only unique link identities, excluding repeated address counters and addresses', () => {
  const parsed = parseDarwinNetworkCounters(network())
  expect(parsed).toEqual([{ name: 'en0', linkId: 4, receivedBytes: 100, sentBytes: 200 },
    { name: 'utun0', linkId: 9, receivedBytes: 500, sentBytes: 800 }, { name: 'lo0', linkId: 1, receivedBytes: 900, sentBytes: 900 }])
  expect(JSON.stringify(parsed)).not.toContain('aa:bb'); expect(JSON.stringify(parsed)).not.toContain('10.0.0.1')
  expect(() => parseDarwinNetworkCounters(network() + '\nen0 1500 <Link#4> 1 0 100 2 0 200 0')).toThrow('ambiguous')
  expect(() => parseDarwinNetworkCounters(header + '\nen0 1500 <Link#4> 1 0 bad 2 0 200 0')).toThrow()
})
it.each([['1', 'normal'], ['2', 'warning'], ['4', 'critical']] as const)('maps exported pressure flag %s to %s', (raw, expected) => {
  expect(parseDarwinMemory(memory.replace('level: 2', 'level: ' + raw))).toMatchObject({
    pressure: { data: { source: 'darwin-sysctl', level: expected } }, swap: { data: { usedBytes: 512 * 1024 ** 2, totalBytes: 1024 ** 3 } } })
})
it('keeps pressure independent of missing or invalid swap, without interpreting unknown flags', () => {
  expect(parseDarwinMemory(memory.replace('1024.00M', '1.00M'))).toMatchObject({ swap: { data: null }, pressure: { data: { level: 'warning' } } })
  expect(parseDarwinMemory(memory.replace('level: 2', 'level: 3'))).toMatchObject({ pressure: { data: null }, swap: { data: { totalBytes: 1024 ** 3 } } })
})
it('measures whole-Host capacity from matching counters, distinct from one-core App CPU', async () => {
  const f = fixture()
  f.cpu([cpu(), cpu()])
  const first = await f.observer.observe(0, signal())
  expect(first.cpu.data).toMatchObject({ percent: null, intervalMs: null, logicalCpuCount: 2, basis: 'whole-host-capacity', unavailable: expect.any(String) })
  f.at(1000); f.cpu([cpu(300, 1700), cpu(100, 1900)])
  const second = await f.observer.observe(0, signal())
  expect(second.cpu.data).toMatchObject({ percent: 10, intervalMs: 1000 })
  expect(second.network).toBe(first.network); expect(f.command).toHaveBeenCalledTimes(2)
  expect(parseHostResourceSnapshot(second)).toBe(second)
  for (const counters of [[cpu(1, 2)], [cpu(3, 4), cpu(5, 6)], [cpu(7, 8, 'replacement')]]) {
    f.at(2000); f.cpu(counters)
    expect((await f.observer.observe(0, signal())).cpu.data?.percent).toBeNull()
  }
})
it('measures each exact interface over its actual interval and resets changed, missing or decreased counters', async () => {
  const f = fixture(), first = await f.observer.observe(0, signal())
  expect(first.network.data?.interfaces.every(value => value.intervalMs === null && value.unavailable)).toBe(true)
  f.at(5000); f.network(network(5100, 10200))
  const second = await f.observer.observe(0, signal())
  expect(second.network.data?.interfaces[0]).toMatchObject({ receiveBytesPerSecond: 1000, sendBytesPerSecond: 2000, intervalMs: 5000 })
  expect(second.network.data?.interfaces[1]).toMatchObject({ receiveBytesPerSecond: 0, sendBytesPerSecond: 0 })
  f.at(10000); f.network(network(10, 20))
  expect((await f.observer.observe(0, signal())).network.data?.interfaces[0]?.intervalMs).toBeNull()
  f.at(15000); f.network(network(100, 200, 44))
  expect((await f.observer.observe(0, signal())).network.data?.interfaces[0]?.intervalMs).toBeNull()
  f.at(20000); f.network(`${header}\nutun0 1500 <Link#9> 1 0 500 2 0 800 0`)
  expect((await f.observer.observe(0, signal())).network.data?.interfaces).toHaveLength(1)
  f.at(25000); f.network(network(1000, 2000, 44))
  expect((await f.observer.observe(0, signal())).network.data?.interfaces[0]?.intervalMs).toBeNull()
})
it('isolates failed native or physical-memory sources and unsupported platforms', async () => {
  const f = fixture()
  f.source.memory = () => { throw new Error('private detail must not escape') }
  f.command.mockImplementation(async file => { if (file.endsWith('netstat')) throw new Error('network failed'); return memory })
  const first = await f.observer.observe(0, signal())
  expect(first.memory.data).toBeNull(); expect(first.network.data).toBeNull()
  expect(first.swap.data?.usedBytes).toBe(512 * 1024 ** 2); expect(first.cpu.data).not.toBeNull()
  expect(JSON.stringify(first)).not.toContain('private detail')
  f.source.platform = 'linux'
  const unsupported = await f.observer.observe(1, signal())
  expect(unsupported.network).toMatchObject({ data: null, unavailable: expect.stringContaining('not supported') })
  expect(f.command).toHaveBeenCalledTimes(2)
})
it('has one native flight, cancels it with exact demand and excludes late replies from a reopened epoch', async () => {
  const f = fixture(), initial = new AbortController(), held: ((value: string) => void)[] = [], signals: AbortSignal[] = []
  f.command.mockImplementation((_file, _args, sourceSignal) => { signals.push(sourceSignal); return new Promise(resolve => held.push(resolve)) })
  const a = f.observer.observe(0, initial.signal), aRejected = expect(a).rejects.toThrow()
  const same = f.observer.observe(0, initial.signal), sameRejected = expect(same).rejects.toThrow()
  await flush(); expect(f.command).toHaveBeenCalledTimes(2)
  initial.abort()
  expect(signals.every(value => value.aborted)).toBe(true)
  const reopened = f.observer.observe(1, signal())
  held[0]!(memory); held[1]!(network(999999, 999999)); await aRejected; await sameRejected; await flush()
  expect(f.command).toHaveBeenCalledTimes(4)
  held[2]!(memory); held[3]!(network(1, 2)); const fresh = await reopened
  expect(fresh.cpu.data?.percent).toBeNull()
  expect(fresh.network.data?.interfaces[0]).toMatchObject({ receivedBytes: 1, sentBytes: 2, intervalMs: null })
})
it('strictly rejects extra fields, getters, negative or out-of-range public Host values', async () => {
  const valid = await fixture().observer.observe(0, signal())
  for (const change of [(v: any) => { v.cpu.data.percent = 101 }, (v: any) => { v.network.data.interfaces[0].sentBytes = -1 },
    (v: any) => { v.pressure.data.level = 'guessed' }, (v: any) => { v.unexpected = true }]) {
    const current = structuredClone(valid); change(current)
    expect(() => parseHostResourceSnapshot(current)).toThrow()
  }
  const getter = vi.fn(() => 100)
  Object.defineProperty(valid.memory.data!, 'totalBytes', { enumerable: true, get: getter })
  expect(() => parseHostResourceSnapshot(valid)).toThrow(); expect(getter).not.toHaveBeenCalled()
})
it('passes the sampler observation epoch into the original Main diagnostic owner and releases all demand', async () => {
  vi.useFakeTimers()
  const f = fixture(), observer = vi.spyOn(f.observer, 'observe'), diagnostics = new MainPerformanceDiagnostics(async () => ({ location: 'main-user-home-volume', totalBytes: 10, availableBytes: 1 }), 1000, f.observer)
  const sampler = new ProcessResourceSampler(async () => '', () => 1000, () => [], () => 1000)
  const readMain = () => ({ processId: 1, observedAt: 1000, input: createInputPerformanceRecorder().snapshot(), carrier: hostedCarrierPerformance.snapshot() })
  sampler.setObservationSources({ observeRuntime: async () => [], processOwners: () => ({ rendererPids: [], browserPids: [] }), mainOwners: () => ({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }),
    observeDiagnostics: (sourceSignal, generation) => diagnostics.observe([], readMain, sourceSignal, generation) })
  const port = createResourceMetricsPort({ sampler, currentWindow: () => null }), seen: unknown[] = []
  expect(observer).not.toHaveBeenCalled()
  const a = await port.subscribe(value => seen.push(parseMetricsObservation(value)), () => {}, signal())
  const b = await port.subscribe(() => {}, () => {}, signal()); await flush()
  expect(observer).toHaveBeenCalledTimes(1); expect(observer.mock.calls[0]![0]).toBe(0)
  expect(seen.at(-1)).toMatchObject({ diagnostics: { data: { host: { memory: { data: { freeBytes: 1024 } } } } } })
  a.dispose(); b.dispose(); const count = f.command.mock.calls.length
  f.at(10000); await vi.advanceTimersByTimeAsync(10000); expect(f.command).toHaveBeenCalledTimes(count)
  const next = await port.subscribe(value => seen.push(parseMetricsObservation(value)), () => {}, signal()); await flush()
  expect(observer.mock.calls.at(-1)![0]).toBe(1)
  expect(seen.at(-1)).toMatchObject({ diagnostics: { data: { host: { cpu: { data: { percent: null } }, network: { data: { interfaces: [{ intervalMs: null }, { intervalMs: null }, { intervalMs: null }] } } } } } })
  next.dispose(); port.dispose(); sampler.dispose()
})
