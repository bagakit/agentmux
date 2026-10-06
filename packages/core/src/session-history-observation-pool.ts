import { AgentMuxError } from './errors.js'
import type { AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from './types.js'

type Subscriber = { notify(value: AgentSessionHistoryObservation): void; release(reason: unknown): void }
type Entry = {
  controller: AbortController
  subscribers: Set<Subscriber>
  pending?: Promise<AgentSessionHistoryObservationHandle>
  close(reason: unknown): void
}
type Acquire = (
  signal: AbortSignal,
  notify: (value: AgentSessionHistoryObservation) => void,
  released: (reason: unknown) => void
) => Promise<AgentSessionHistoryObservationHandle>

const cancelled = () => new AgentMuxError('The history observation Consumer released its handle.', 'AGENT_SESSION_HISTORY_CANCELLED')

/** Shares only a live observation resource, never source facts, pages or Run authority. */
export class SessionHistoryObservationPool {
  private readonly entries = new Map<string, Entry>()

  async observe(key: string, listener: Subscriber['notify'], signal: AbortSignal | undefined, acquire: Acquire): Promise<AgentSessionHistoryObservationHandle> {
    signal?.throwIfAborted()
    let entry = this.entries.get(key)
    if (!entry) {
      let closed = false
      const created: Entry = { controller: new AbortController(), subscribers: new Set(), close: reason => {
        if (closed) return
        closed = true
        if (this.entries.get(key) === created) this.entries.delete(key)
        created.controller.abort(reason)
        for (const subscriber of [...created.subscribers]) subscriber.release(reason)
      } }
      this.entries.set(key, created)
      entry = created
    }
    const shared = entry
    let rejectCancelled!: (reason: unknown) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
    let released = false
    const closed = new AbortController()
    const abort = () => subscriber.release(signal?.reason ?? cancelled())
    const subscriber: Subscriber = {
      notify: value => {
        if (released) return
        try { listener(value) } catch {
          // A Consumer cannot interrupt another Consumer or the original observation owner.
        }
      },
      release: reason => {
        if (released) return
        released = true
        closed.abort(reason)
        signal?.removeEventListener('abort', abort)
        shared.subscribers.delete(subscriber)
        rejectCancelled(reason)
        if (!shared.subscribers.size) shared.close(reason)
      }
    }
    shared.subscribers.add(subscriber)
    signal?.addEventListener('abort', abort, { once: true })
    if (!shared.pending) {
      shared.pending = acquire(shared.controller.signal, value => {
        if (value.kind === 'unavailable' && value.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' && this.entries.get(key) === shared) {
          // A Consumer may synchronously acquire the replacement from this notification.
          this.entries.delete(key)
        }
        for (const consumer of [...shared.subscribers]) consumer.notify(value)
      }, reason => shared.close(reason)).catch(error => {
        shared.close(error)
        throw error
      })
    }
    try {
      const handle = await Promise.race([shared.pending, cancellation])
      signal?.throwIfAborted()
      shared.controller.signal.throwIfAborted()
      return { source: handle.source, closed: closed.signal, dispose: () => subscriber.release(cancelled()) }
    } catch (error) {
      subscriber.release(error)
      throw error
    }
  }

  dispose(): void {
    const reason = new AgentMuxError('History observer client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    for (const entry of [...this.entries.values()]) entry.close(reason)
  }
}
