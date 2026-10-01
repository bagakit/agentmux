import type { BrowserPageTransport } from './browser-page-transport.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'
import { ExternalBrowserRequestFailure, type ExternalBrowserBridge, type ExternalBrowserBinding,
  type ExternalBrowserConnection, type ExternalBrowserOperationOwner, type ExternalBrowserEvent } from './browser-external-bridge.js'
import { EXTERNAL_AUTO_ATTACH } from '../../browser-extension/protocol.js'

/** A single operation's transport, tied to the original shared binding and connection. */
export class ExternalBrowserTargetSession implements BrowserPageTransport {
  readonly frames = new Map<string, BrowserCdpSender>()
  private readonly parents = new Map<string, string | null>()
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private readonly connection: ExternalBrowserConnection
  private readonly releaseEvents: () => void
  private readonly releaseAvailability: () => void
  private closed = false
  private gone: string | null = null
  private missing: string | null = null
  constructor(private readonly bridge: ExternalBrowserBridge, readonly binding: ExternalBrowserBinding,
    private readonly owner: ExternalBrowserOperationOwner) {
    if (!binding.connection || binding.status !== 'ready') throw new Error(binding.warning ?? 'Reconnect the original shared tab before running a program.')
    this.connection = binding.connection
    this.releaseEvents = bridge.observe(binding.id, event => this.event(event))
    this.releaseAvailability = bridge.observeAvailability(binding.id, () => {
      if (binding.status !== 'ready' || binding.connection?.id !== this.connection.id) {
        this.gone = binding.warning ?? 'The original shared-tab connection changed. Actions are not replayed.'
        this.frames.clear(); this.parents.clear()
      }
    })
  }
  get endedReason(): string | null {
    return this.gone ?? (this.closed ? 'Shared-tab operation ended.' : null)
  }
  get frameDiscoveryFailure(): string | null { return this.missing }
  readonly sendCommand: BrowserCdpSender = (method, params) => this.command(undefined, method, params)
  observe(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async attach(): Promise<void> {
    await this.connection.request(this.binding, this.owner, 'attach')
    try { await this.sendCommand('Target.setAutoAttach', EXTERNAL_AUTO_ATTACH) }
    catch (error) { this.missing = `Shared-tab frame discovery is unavailable (${error instanceof Error ? error.message : String(error)}). Retry snapshot to inspect available documents.` }
  }
  private async command(sessionId: string | undefined, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.endedReason || this.binding.connection?.id !== this.connection.id || this.binding.status !== 'ready' ||
      (sessionId && !this.frames.has(sessionId))) throw new ExternalBrowserRequestFailure(this.endedReason ?? 'This frame no longer belongs to the original shared tab.', false)
    const frame = sessionId ? this.frames.get(sessionId) : undefined
    try {
      const result = await this.connection.request(this.binding, this.owner, 'command', method, params, sessionId)
      if (sessionId && this.frames.get(sessionId) !== frame) throw new ExternalBrowserRequestFailure(
        'The original child frame changed before its result was confirmed. Inspect the original page; do not replay the action.', true)
      return result
    }
    catch (error) {
      const failure = sessionId && this.frames.get(sessionId) !== frame &&
        (!(error instanceof ExternalBrowserRequestFailure) || error.sent) ? new ExternalBrowserRequestFailure(
          'The original child frame changed before its error was confirmed. Inspect the original page; do not replay the action.', true) : error
      if (failure instanceof ExternalBrowserRequestFailure && failure.uncertain) this.gone = failure.message
      throw failure
    }
  }
  private event(event: ExternalBrowserEvent): void {
    if (this.closed || this.gone || event.navigationId !== this.binding.navigationId ||
      (event.sessionId && !this.frames.has(event.sessionId))) return
    if (event.mainDocumentNavigation) {
      this.frames.clear(); this.parents.clear()
    } else if (event.method === 'Target.attachedToTarget') {
      const params = event.params as { sessionId?: string; targetInfo?: { type?: string } }
      if (!params.sessionId || params.targetInfo?.type !== 'iframe') return
      const id = params.sessionId
      const sender: BrowserCdpSender = (method, params) => this.command(id, method, params)
      this.frames.set(id, sender); this.parents.set(id, event.sessionId ?? null)
      void sender('Target.setAutoAttach', EXTERNAL_AUTO_ATTACH).catch(error => {
        if (this.frames.get(id) === sender && !this.endedReason) this.missing = `Nested shared-tab frame discovery failed (${error instanceof Error ? error.message : String(error)}). Retry snapshot.`
      })
    } else if (event.method === 'Target.detachedFromTarget') {
      const id = (event.params as { sessionId?: string }).sessionId
      if (id) {
        const removed = new Set([id])
        for (const [child, parent] of this.parents) if (parent && removed.has(parent)) removed.add(child)
        for (const child of removed) { this.frames.delete(child); this.parents.delete(child) }
      }
    }
    for (const listener of this.listeners) listener(event.method, event.params)
  }
  async detach(): Promise<string | null> {
    if (this.closed) return null
    this.closed = true; this.releaseEvents(); this.releaseAvailability()
    this.frames.clear(); this.parents.clear(); this.listeners.clear()
    if (this.binding.connection?.id !== this.connection.id || this.binding.status !== 'ready') return null
    try { await this.connection.request(this.binding, this.owner, 'detach'); return null }
    catch { return 'Shared-tab debugger cleanup was not confirmed. The result is retained; inspect the original tab before another operation.' }
  }
}

/** Called by the real external Browser owner; it cannot pick or replace a Chrome tab. */
export async function attachExternalBrowserTarget(bridge: ExternalBrowserBridge, binding: ExternalBrowserBinding,
  owner: ExternalBrowserOperationOwner): Promise<ExternalBrowserTargetSession> {
  const session = new ExternalBrowserTargetSession(bridge, binding, owner)
  try { await session.attach(); return session }
  catch (error) { await session.detach(); throw error }
}
