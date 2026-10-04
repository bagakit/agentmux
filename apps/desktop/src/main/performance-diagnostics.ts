import { statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ClientPerformanceDiagnostics } from '@agentmux/core'
import type { PerformanceDiagnostics } from '@agentmux/core/control'

type HostClient = { clientPerformanceDiagnostics(options: { signal: AbortSignal }): Promise<ClientPerformanceDiagnostics> }
type Storage = NonNullable<PerformanceDiagnostics['storage']>
type Result<T> = { data: T | null; unavailable: string | null }
type Reading<T> = { result: Promise<Result<T>>; cancel(): void }

/** Only observation is cancelled. A timed-out underlying read stays single-flight until it settles. */
function reading<T>(source: () => Promise<T>, cancelSource: () => void, actualSettled: () => void, timeoutMs: number): Reading<T> {
  let finish!: (value: Result<T>) => void
  const result = new Promise<Result<T>>(resolve => { finish = value => { clearTimeout(timer); resolve(value) } })
  const cancel = () => { cancelSource(); finish({ data: null, unavailable: 'Performance observation cancelled' }) }
  const timer = setTimeout(() => { cancelSource(); finish({ data: null, unavailable: 'Performance observation timed out' }) }, timeoutMs)
  // Exactly one reaction on the actual I/O. Subsequent samples use this bounded,
  // settled result rather than accumulating reactions on a stalled source promise.
  let promise: Promise<T>
  try { promise = source() } catch (error) { promise = Promise.reject(error) }
  void promise.then(value => { actualSettled(); finish({ data: value, unavailable: null }) },
    error => { actualSettled(); finish({ data: null, unavailable: String(error).slice(0, 4096) }) })
  return { result, cancel }
}

/** Independent host/volume fault domains; no Runtime probe, reconnect or private storage read. */
export class MainPerformanceDiagnostics {
  private readonly hosts = new WeakMap<HostClient, Reading<ClientPerformanceDiagnostics>>()
  private storage: Reading<Storage> | undefined
  constructor(private readonly readStorage: () => Promise<Storage> = async () => {
    const value = await statfs(homedir())
    return { location: 'main-user-home-volume', availableBytes: Math.max(0, value.bavail * value.bsize), totalBytes: value.blocks * value.bsize }
  }, private readonly timeoutMs = 1000) {}

  async observe(entries: readonly { client: HostClient; executionHost: { id: string } }[],
    readMain: () => ClientPerformanceDiagnostics, signal: AbortSignal): Promise<Omit<PerformanceDiagnostics, 'eventLoop'>> {
    signal.throwIfAborted()
    const reads: Reading<unknown>[] = []
    const hosts = Promise.all(entries.slice(0, 64).map(async ({ client, executionHost }) => {
      let current = this.hosts.get(client)
      if (!current) {
        const controller = new AbortController()
        current = reading(() => client.clientPerformanceDiagnostics({ signal: controller.signal }), () => controller.abort(), () => this.hosts.delete(client), this.timeoutMs)
        this.hosts.set(client, current)
      }
      reads.push(current)
      return { hostId: executionHost.id, ...await current.result }
    }))
    if (!this.storage) {
      this.storage = reading(this.readStorage, () => {}, () => { this.storage = undefined }, this.timeoutMs)
    }
    reads.push(this.storage)
    const abort = () => reads.forEach(value => value.cancel())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      const [hostFacts, storageFacts] = await Promise.all([hosts, this.storage.result])
      signal.throwIfAborted()
      return { main: readMain(), hosts: hostFacts, omittedHosts: Math.max(0, entries.length - 64),
        storage: storageFacts.data, storageUnavailable: storageFacts.unavailable }
    } finally { signal.removeEventListener('abort', abort) }
  }
}
