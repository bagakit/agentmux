import type { AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from '@agentmux/core'
import type { WebContentsDidStartNavigationEventParams } from 'electron'
import type { SessionHistoryReference, SessionHistoryObservationReady } from '../shared/contracts.js'

type Sender = {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
}
type Owner = { sender: Sender; controller: AbortController; handle?: AgentSessionHistoryObservationHandle; dispose(): void }

/** Pending and live observation resources only. Native records remain in the Core reader and shared page. */
export class SessionHistoryObservationOwners {
  private readonly owners = new Map<string, Owner>()

  constructor(private readonly observe: (reference: SessionHistoryReference,
    listener: (observation: AgentSessionHistoryObservation) => void, signal: AbortSignal
  ) => Promise<AgentSessionHistoryObservationHandle>) {}

  async acquire(sender: Sender, token: string, reference: SessionHistoryReference,
    notify: (observation: AgentSessionHistoryObservation) => void
  ): Promise<SessionHistoryObservationReady> {
    if (typeof token !== 'string' || !token || token.length > 128) throw new Error('History observation requires its owner token.')
    const key = `${sender.id}:${token}`
    if (this.owners.has(key)) throw new Error('History observation token already belongs to an active owner.')
    const controller = new AbortController()
    let disposed = false
    const navigation = (details: WebContentsDidStartNavigationEventParams): void => {
      if (details.isMainFrame && !details.isSameDocument) owner.dispose()
    }
    const owner: Owner = { sender, controller, dispose: () => {
      if (disposed) return
      disposed = true
      controller.abort(new Error('The history observation owner left.'))
      owner.handle?.dispose()
      sender.removeListener('destroyed', owner.dispose)
      sender.removeListener('did-start-navigation', navigation)
      if (this.owners.get(key) === owner) this.owners.delete(key)
    } }
    this.owners.set(key, owner)
    sender.once('destroyed', owner.dispose)
    sender.on('did-start-navigation', navigation)
    if (sender.isDestroyed()) owner.dispose()
    try {
      const handle = await this.observe(reference, observation => {
        if (disposed || sender.isDestroyed()) return
        notify(observation)
        if (observation.kind === 'unavailable') owner.dispose()
      }, controller.signal)
      if (disposed || sender.isDestroyed()) {
        handle.dispose()
        throw new Error('The history observation owner disappeared before ready.')
      }
      owner.handle = handle
      return { source: handle.source }
    } catch (error) {
      owner.dispose()
      return { error: { code: typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error) } }
    }
  }

  release(senderId: number, token: string): void { this.owners.get(`${senderId}:${token}`)?.dispose() }
  dispose(): void { for (const owner of this.owners.values()) owner.dispose() }
}
