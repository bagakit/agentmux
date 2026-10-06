import type { WebContentsDidStartNavigationEventParams } from 'electron'

type Sender = {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
}

/** Only live read lifetimes. Records and queries stay in the original Core history owner. */
export class SessionHistoryReadOwners {
  private readonly reads = new Map<string, () => void>()

  async read<T>(sender: Sender, token: string, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !token || token.length > 128) throw new Error('History read requires its request token.')
    const key = `${sender.id}:${token}`
    if (this.reads.has(key)) throw new Error('This history read is already active.')
    const controller = new AbortController()
    const release = () => controller.abort(new Error('The history reader closed.'))
    const navigation = (details: WebContentsDidStartNavigationEventParams) => {
      if (details.isMainFrame && !details.isSameDocument) release()
    }
    this.reads.set(key, release)
    sender.once('destroyed', release)
    sender.on('did-start-navigation', navigation)
    try {
      if (sender.isDestroyed()) release()
      controller.signal.throwIfAborted()
      const value = await read(controller.signal)
      controller.signal.throwIfAborted()
      return value
    } finally {
      sender.removeListener('destroyed', release)
      sender.removeListener('did-start-navigation', navigation)
      if (this.reads.get(key) === release) this.reads.delete(key)
    }
  }

  cancel(senderId: number, token: string): void { this.reads.get(`${senderId}:${token}`)?.() }
  dispose(): void { for (const cancel of this.reads.values()) cancel() }
}
