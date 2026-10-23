import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import type { CpuInfo } from 'node:os'
import type { HostMetric, HostNetworkInterface, HostResourceSnapshot } from '@agentmux/core/control'

const NATIVE_INTERVAL_MS = 5_000
type Counters = Pick<HostNetworkInterface, 'name' | 'linkId' | 'receivedBytes' | 'sentBytes'>
type Command = (file: string, args: string[], signal: AbortSignal) => Promise<string>
export type HostResourceSources = {
  cpu(): CpuInfo[]; memory(): { totalBytes: number; freeBytes: number }
  command: Command; platform: NodeJS.Platform; now(): number; monotonic(): number
}
const unavailable = <T>(reason: string): HostMetric<T> => ({ observedAt: null, data: null, unavailable: reason })
const available = <T>(observedAt: number, data: T): HostMetric<T> => ({ observedAt, data, unavailable: null })
const integer = (value: string): number => {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid interface counter')
  return Number(value)
}

/** Link rows are unique interfaces; address rows repeat the same counters. Never retain addresses. */
export function parseDarwinNetworkCounters(output: string): Counters[] {
  const [header, ...lines] = output.trim().split('\n'), columns = header?.trim().split(/\s+/u) ?? []
  const first = columns.indexOf('Ipkts'), received = columns.indexOf('Ibytes') - first, sent = columns.indexOf('Obytes') - first
  if (first < 3 || received < 0 || sent < 0) throw new Error('Network counter columns are unavailable')
  const count = columns.length - first, result: Counters[] = [], names = new Set<string>(), links = new Set<number>()
  for (const line of lines) {
    const fields = line.trim().split(/\s+/u), link = /^<Link#(\d+)>$/u.exec(fields[2] ?? '')
    if (!link) continue
    const name = fields[0]!.replace(/\*$/u, ''), linkId = integer(link[1]!), counters = fields.slice(-count)
    if (!name || names.has(name) || links.has(linkId) || fields.length < count + 3) throw new Error('Interface identity is ambiguous')
    names.add(name); links.add(linkId)
    result.push({ name, linkId, receivedBytes: integer(counters[received]!), sentBytes: integer(counters[sent]!) })
  }
  if (!result.length) throw new Error('No link counters are available')
  return result
}

/** The sysctl exports dispatch pressure flags (1/2/4), not XNU's internal pressure enum. */
export function parseDarwinMemory(output: string): Pick<HostResourceSnapshot, 'swap' | 'pressure'> {
  const swap = /^vm\.swapusage:\s+total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/mu.exec(output)
  const bytes = (value: string, unit: string) => {
    const amount = Math.round(Number(value) * 1024 ** ({ K: 1, M: 2, G: 3 }[unit]!))
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid swap counter')
    return amount
  }
  let swapData: HostResourceSnapshot['swap'] = unavailable('Swap counter is unavailable')
  try {
    if (swap) {
      const totalBytes = bytes(swap[1]!, swap[2]!), usedBytes = bytes(swap[3]!, swap[4]!)
      if (usedBytes > totalBytes) throw new Error('Swap counters are inconsistent')
      swapData = available(0, { source: 'darwin-sysctl', totalBytes, usedBytes })
    }
  } catch { /* The independent pressure value can remain usable. */ }
  const value = /^kern\.memorystatus_vm_pressure_level:\s+(\d+)\s*$/mu.exec(output)?.[1]
  const level = ({ '1': 'normal', '2': 'warning', '4': 'critical' } as const)[value as '1' | '2' | '4']
  return { swap: swapData, pressure: level ? available(0, { source: 'darwin-sysctl', level }) : unavailable('Memory pressure level is unavailable') }
}

const command: Command = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { signal, timeout: 750, maxBuffer: 256 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => error && (error.killed || signal.aborted || !stdout.trim())
      ? reject(new Error(`Host ${file.endsWith('netstat') ? 'network' : 'memory'} observation failed${error.killed ? ' or timed out' : ''}`)) : resolve(stdout))
})
const sources: HostResourceSources = { cpu: cpus, memory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
  command, platform: process.platform, now: Date.now, monotonic: () => performance.now() }

/** No timer or background work: the original shared metrics consumer supplies every observation. */
export class HostResourceObserver {
  private epoch: number | null = null
  private previousCpu: { counters: CpuInfo[]; at: number } | null = null
  private previousNetwork: { counters: Counters[]; at: number } | null = null
  private nativeAt: number | null = null
  private native: Pick<HostResourceSnapshot, 'swap' | 'pressure' | 'network'> | null = null
  private flight: { epoch: number; controller: AbortController; result: Promise<void> } | null = null
  constructor(private readonly source: HostResourceSources = sources) {}

  async observe(epoch: number, signal: AbortSignal): Promise<HostResourceSnapshot> {
    signal.throwIfAborted()
    if (epoch !== this.epoch) {
      this.epoch = epoch; this.previousCpu = null; this.previousNetwork = null; this.nativeAt = null; this.native = null
      this.flight?.controller.abort()
    }
    if (this.flight && this.flight.epoch !== epoch) await this.flight.result
    signal.throwIfAborted()
    if (this.epoch !== epoch) throw new Error('Host observation belongs to a released consumer')
    const cpu = this.readCpu(), memory = this.readMemory()
    if (this.source.platform !== 'darwin') return { cpu, memory,
      swap: unavailable('Swap observation is not supported on this platform'), pressure: unavailable('Memory pressure observation is not supported on this platform'),
      network: unavailable('Interface throughput observation is not supported on this platform') }
    // One read shared by all consumers. A closing epoch cancels the original child processes.
    if (!this.flight && (this.nativeAt === null || this.source.monotonic() - this.nativeAt >= NATIVE_INTERVAL_MS)) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const flight = { epoch, controller, result: Promise.resolve() }
      this.flight = flight
      flight.result = this.readNative(epoch, controller.signal).finally(() => {
        signal.removeEventListener('abort', abort)
        if (this.flight === flight) this.flight = null
      })
    }
    if (this.flight) await this.flight.result
    signal.throwIfAborted()
    if (this.epoch !== epoch) throw new Error('Host observation belongs to a released consumer')
    return { cpu, memory, ...this.native! }
  }

  private readCpu(): HostResourceSnapshot['cpu'] {
    try {
      const counters = this.source.cpu(), at = this.source.monotonic(), previous = this.previousCpu
      if (!counters.length || counters.some(cpu => Object.values(cpu.times).some(value => !Number.isFinite(value) || value < 0))) throw new Error('CPU counters are unavailable')
      this.previousCpu = { counters, at }
      let idle = 0, total = 0
      const valid = previous && at > previous.at && previous.counters.length === counters.length && counters.every((cpu, index) => {
        const before = previous.counters[index]!
        if (cpu.model !== before.model) return false
        for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) {
          const delta = cpu.times[key] - before.times[key]
          if (delta < 0) return false
          total += delta
          if (key === 'idle') idle += delta
        }
        return true
      })
      return available(this.source.now(), { basis: 'whole-host-capacity', logicalCpuCount: counters.length,
        percent: valid && total > 0 ? 100 * (total - idle) / total : null,
        intervalMs: valid && total > 0 ? at - previous.at : null,
        unavailable: valid && total > 0 ? null : 'A matching CPU counter interval is not available yet' })
    } catch { this.previousCpu = null; return unavailable('CPU counters are unavailable') }
  }

  private readMemory(): HostResourceSnapshot['memory'] {
    try {
      const memory = this.source.memory()
      if (![memory.totalBytes, memory.freeBytes].every(value => Number.isSafeInteger(value) && value >= 0) || memory.freeBytes > memory.totalBytes) throw new Error('Invalid physical memory counters')
      return available(this.source.now(), { source: 'node-os', ...memory })
    } catch { return unavailable('Physical memory counters are unavailable') }
  }

  private async readNative(epoch: number, signal: AbortSignal): Promise<void> {
    const read = (file: string, args: string[]) => Promise.resolve().then(() => this.source.command(file, args, signal)).then(output => ({ output, observedAt: this.source.now(), at: this.source.monotonic() }))
    const [memory, network] = await Promise.allSettled([
      read('/usr/sbin/sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
      read('/usr/sbin/netstat', ['-ibn'])
    ])
    if (signal.aborted || this.epoch !== epoch) return
    const at = this.source.monotonic()
    let swap: HostResourceSnapshot['swap'] = unavailable('Swap observation failed'), pressure: HostResourceSnapshot['pressure'] = unavailable('Memory pressure observation failed')
    if (memory.status === 'fulfilled') {
      try {
        const parsed = parseDarwinMemory(memory.value.output)
        swap = { ...parsed.swap, observedAt: parsed.swap.data ? memory.value.observedAt : null }
        pressure = { ...parsed.pressure, observedAt: parsed.pressure.data ? memory.value.observedAt : null }
      } catch { /* An invalid native memory result cannot erase CPU, physical memory or network. */ }
    }
    let traffic: HostResourceSnapshot['network'] = unavailable('Interface counters are unavailable')
    if (network.status === 'fulfilled') {
      try {
        const counters = parseDarwinNetworkCounters(network.value.output), previous = this.previousNetwork, networkAt = network.value.at
        const interfaces = counters.map(current => {
          const before = previous?.counters.find(value => value.name === current.name && value.linkId === current.linkId)
          const intervalMs = before && networkAt > previous!.at && current.receivedBytes >= before.receivedBytes && current.sentBytes >= before.sentBytes ? networkAt - previous!.at : null
          return { ...current, intervalMs, receiveBytesPerSecond: intervalMs === null ? null : 1000 * (current.receivedBytes - before!.receivedBytes) / intervalMs,
            sendBytesPerSecond: intervalMs === null ? null : 1000 * (current.sentBytes - before!.sentBytes) / intervalMs,
            unavailable: intervalMs === null ? 'A matching interface counter interval is not available yet' : null }
        })
        this.previousNetwork = { counters, at: networkAt }
        traffic = available(network.value.observedAt, { source: 'darwin-netstat-link', interfaces })
      } catch { this.previousNetwork = null }
    } else this.previousNetwork = null
    this.nativeAt = at; this.native = { swap, pressure, network: traffic }
  }
}
