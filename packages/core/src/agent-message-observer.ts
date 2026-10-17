import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import type { AgentMuxClientEvent } from './types.js'

type Event = Extract<AgentMuxClientEvent, { type: 'agent-message-changed' | 'agent-message-observation' }>
type Listener = (event: Event) => void
const resources = new Map<string, MessageJournalObserver>()

/** One OS resource per original path; its cursor is observation, never Inbox consumption. */
class MessageJournalObserver {
  readonly listeners = new Set<Listener>()
  readonly ready: Promise<void>
  private cursor?: { incarnation: string; throughSequence: number }
  private directory: FSWatcher | undefined
  private readonly files = new Map<string, { watch: FSWatcher; dev: bigint; ino: bigint }>()
  private state?: Extract<Event, { type: 'agent-message-observation' }>
  private queued = false
  private checking = false
  private disposed = false
  private readonly cancellation = new AbortController()
  private opening: Promise<void> | undefined
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly queue: DurableAgentMuxMessageQueue) {
    this.ready = this.open().catch(error => this.unavailable(error))
  }
  private emit(event: Event) {
    for (const listener of this.listeners) { try { listener(event) } catch { /* One consumer cannot close another reader's observation. */ } }
  }
  private available() {
    if (this.disposed || this.state?.state === 'available') return
    this.state = { type: 'agent-message-observation', state: 'available' }; this.emit(this.state)
  }
  private unavailable(error: unknown) {
    if (this.disposed) return
    const cause = error as { code?: string; message?: string }
    this.state = { type: 'agent-message-observation', state: 'unavailable', code: cause.code ?? 'AGENT_MESSAGE_OBSERVATION_UNAVAILABLE',
      message: `${cause.message ?? 'Original message observation is unavailable.'} The existing window is retained; explicitly refresh the original Host.` }
    this.emit(this.state)
  }
  private async attachFiles() {
    const name = basename(this.queue.path)
    for (const file of [name, `${name}-journal`, `${name}-wal`]) {
      const path = join(dirname(this.queue.path), file)
      const current = await stat(path, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (this.disposed) return
      const previous = this.files.get(file)
      if (previous && current?.dev === previous.dev && current.ino === previous.ino) continue
      previous?.watch.close(); this.files.delete(file)
      if (!current) continue
      const watcher = watch(path, { persistent: false }, () => { void this.check() })
      watcher.on('error', error => { this.files.get(file)?.watch.close(); this.files.delete(file); this.unavailable(error) })
      this.files.set(file, { watch: watcher, dev: current.dev, ino: current.ino })
    }
  }
  private open(): Promise<void> {
    if (this.opening) return this.opening
    const opening = this.establish(); this.opening = opening
    const settled = () => { if (this.opening === opening) this.opening = undefined }
    void opening.then(settled, settled)
    return opening
  }
  private async establish() {
    this.cursor ??= (await this.queue.messageChanges(undefined, this.cancellation.signal)).cut
    if (this.disposed) return
    if (!this.directory) {
      const name = basename(this.queue.path), names = new Set([name, `${name}-journal`, `${name}-wal`])
      this.directory = watch(dirname(this.queue.path), { persistent: false }, (_event, file) => {
        if (file === null || names.has(file.toString())) void this.check()
      })
      this.directory.on('error', error => { this.directory?.close(); this.directory = undefined; this.unavailable(error) })
    }
    await this.check() // Read the initial cut → OS subscription gap from the original journal.
  }
  private check(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.queued = true
    if (this.checking) return this.pending
    this.checking = true
    this.pending = (async () => {
      try {
        while (this.queued && !this.disposed) {
          this.queued = false
          try {
            if (!this.directory) throw new Error('Original journal directory observation is unavailable.')
            await this.attachFiles()
            if (this.disposed) return
            const next = await this.queue.messageChanges(this.cursor, this.cancellation.signal)
            if (this.disposed) return
            this.cursor = next.cut
            // Catch-up repairs a reader's projection; it must not replay banners.
            const live = this.state?.state === 'available'
            for (const event of next.changes) this.emit({ ...event, live })
            if (next.hasMore) this.queued = true
            else this.available()
          } catch (error) { this.unavailable(error) }
        }
      } finally { this.checking = false }
    })()
    return this.pending
  }
  async refresh() {
    await this.ready
    if (!this.disposed) { try { await this.open() } catch (error) { this.unavailable(error) } }
  }
  report(listener: Listener) { if (this.state && this.listeners.has(listener)) listener(this.state) }
  subscribe(listener: Listener) {
    this.listeners.add(listener)
    if (this.state) queueMicrotask(() => { if (this.listeners.has(listener) && this.state) listener(this.state) })
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      this.disposed = true; this.queued = false; this.cancellation.abort(); this.directory?.close()
      for (const file of this.files.values()) file.watch.close()
      this.files.clear()
      if (resources.get(this.queue.path) === this) resources.delete(this.queue.path)
    }
  }
}

export function observeMessageJournal(queue: DurableAgentMuxMessageQueue, listener: Listener) {
  let resource = resources.get(queue.path)
  if (!resource) { resource = new MessageJournalObserver(queue); resources.set(queue.path, resource) }
  const release = resource.subscribe(listener)
  return { ready: resource.ready, refresh: async () => { await resource.refresh(); resource.report(listener) }, dispose: release }
}
