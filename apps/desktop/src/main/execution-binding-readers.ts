import type { AgentExecutionInspection, AgentExecutionBindingService, AgentExecutionBindingWatch } from '@agentmux/core'
import type { WebContentsDidStartNavigationEventParams } from 'electron'

export type ExecutionBindingSender = {
  isDestroyed(): boolean
  send(channel: string, value: unknown): void
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
type Watch = { id: string; bindingId: string; sender: ExecutionBindingSender; observed: boolean }
type SenderWatches = { watches: Map<string, Watch>; close(): void; navigate(details: WebContentsDidStartNavigationEventParams): void }

/** Ephemeral transport subscriptions only. The existing Core service owns every binding fact. */
export class ExecutionBindingReaders {
  private readonly bindings = new Map<string, Set<Watch>>()
  private readonly senders = new Map<ExecutionBindingSender, SenderWatches>()
  private readonly sources = new Map<string, { controller: AbortController; opening: Promise<AgentExecutionBindingWatch>; latest?: AgentExecutionInspection | null }>()
  constructor(private readonly original: Pick<AgentExecutionBindingService, 'watch'>) {}
  async observe(sender: ExecutionBindingSender, id: string, bindingId: string): Promise<void> {
    this.release(sender, id)
    if (sender.isDestroyed()) return
    let group = this.senders.get(sender)
    if (!group) {
      group = { watches: new Map(), close: () => this.releaseSender(sender), navigate: details => {
        if (details.isMainFrame && !details.isSameDocument) this.releaseSender(sender)
      } }
      this.senders.set(sender, group)
      sender.once('destroyed', group.close); sender.once('render-process-gone', group.close); sender.on('did-start-navigation', group.navigate)
    }
    const watch = { id, bindingId, sender, observed: false }
    group.watches.set(id, watch)
    const readers = this.bindings.get(bindingId) ?? new Set<Watch>()
    readers.add(watch); this.bindings.set(bindingId, readers)
    let source = this.sources.get(bindingId)
    if (!source) {
      const controller = new AbortController()
      const created: { controller: AbortController; opening: Promise<AgentExecutionBindingWatch>; latest?: AgentExecutionInspection | null } = { controller, opening: undefined as unknown as Promise<AgentExecutionBindingWatch> }
      this.sources.set(bindingId, created)
      created.opening = Promise.resolve().then(() => this.original.watch(bindingId, inspection => {
        if (this.sources.get(bindingId) === created) { created.latest = inspection; this.publishSnapshot(bindingId, inspection) }
      }, { signal: controller.signal, onError: error => {
        if (this.sources.get(bindingId) === created) { this.sources.delete(bindingId); controller.abort(); this.publishError(bindingId, error) }
      } })).then(async reader => {
        if (this.sources.get(bindingId) !== created || controller.signal.aborted) { await reader.dispose(); return reader }
        if (reader.initial.bindingId !== bindingId) { await reader.dispose(); throw Error('The Core returned another binding reader.') }
        if (created.latest === undefined) { created.latest = reader.initial.inspection; this.publishSnapshot(bindingId, created.latest) }
        reader.start(); return reader
      })
      source = created
    }
    try {
      await source.opening
      const inspection = source.latest ?? null
      if (this.senders.get(sender)?.watches.get(id) === watch && !watch.observed && !sender.isDestroyed()) sender.send('sessions:executionBindingChanged', { watchId: id, inspection })
    } catch (error) { if (this.senders.get(sender)?.watches.get(id) === watch) this.release(sender, id); throw error }
  }
  private publishSnapshot(bindingId: string, inspection: AgentExecutionInspection | null): void {
    if (inspection && inspection.bindingId !== bindingId) { this.publishError(bindingId, Error('The Core observation identifies another binding.')); return }
    const readers = this.bindings.get(bindingId)
    if (!readers) return
    for (const watch of readers) {
      if (watch.sender.isDestroyed()) { this.release(watch.sender, watch.id); continue }
      watch.observed = true
      try { watch.sender.send('sessions:executionBindingChanged', { watchId: watch.id, inspection }) }
      catch { this.release(watch.sender, watch.id) }
    }
  }
  private publishError(bindingId: string, error: unknown): void {
    for (const watch of [...this.bindings.get(bindingId) ?? []]) {
      try { if (!watch.sender.isDestroyed()) watch.sender.send('sessions:executionBindingChanged', { watchId: watch.id, error: error instanceof Error ? error.message : String(error) }) } catch { this.release(watch.sender, watch.id) }
    }
  }
  release(sender: ExecutionBindingSender, id: string): void {
    const group = this.senders.get(sender), watch = group?.watches.get(id)
    if (!group || !watch) return
    group.watches.delete(id)
    const readers = this.bindings.get(watch.bindingId)
    readers?.delete(watch)
    if (!readers?.size) {
      this.bindings.delete(watch.bindingId)
      const source = this.sources.get(watch.bindingId); this.sources.delete(watch.bindingId)
      source?.controller.abort(); void source?.opening.then(reader => reader.dispose()).catch(() => {})
    }
    if (!group.watches.size) {
      sender.removeListener('destroyed', group.close); sender.removeListener('render-process-gone', group.close); sender.removeListener('did-start-navigation', group.navigate)
      this.senders.delete(sender)
    }
  }
  private releaseSender(sender: ExecutionBindingSender): void {
    for (const id of this.senders.get(sender)?.watches.keys() ?? []) this.release(sender, id)
  }
  dispose(): void { for (const sender of this.senders.keys()) this.releaseSender(sender) }
}
