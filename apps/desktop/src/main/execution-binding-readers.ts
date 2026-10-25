import type { AgentExecutionInspection } from '@agentmux/core'
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
  constructor(private readonly inspect: (bindingId: string) => Promise<AgentExecutionInspection | null>) {}
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
    try {
      const inspection = await this.inspect(bindingId)
      if (this.senders.get(sender)?.watches.get(id) === watch && !watch.observed && !sender.isDestroyed()) sender.send('sessions:executionBindingChanged', { watchId: id, inspection })
    } catch (error) { if (this.senders.get(sender)?.watches.get(id) === watch) this.release(sender, id); throw error }
  }
  publish(inspection: AgentExecutionInspection): void {
    const readers = this.bindings.get(inspection.bindingId)
    if (!readers) return
    for (const watch of readers) {
      if (watch.sender.isDestroyed()) { this.release(watch.sender, watch.id); continue }
      watch.observed = true
      try { watch.sender.send('sessions:executionBindingChanged', { watchId: watch.id, inspection }) }
      catch { this.release(watch.sender, watch.id) }
    }
  }
  release(sender: ExecutionBindingSender, id: string): void {
    const group = this.senders.get(sender), watch = group?.watches.get(id)
    if (!group || !watch) return
    group.watches.delete(id)
    const readers = this.bindings.get(watch.bindingId)
    readers?.delete(watch)
    if (!readers?.size) this.bindings.delete(watch.bindingId)
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
