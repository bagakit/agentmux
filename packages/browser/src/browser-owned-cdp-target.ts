import type { CDPSession } from 'puppeteer-core'
import type { BrowserCdpSender } from './browser-page-snapshot.js'
import type { BrowserProgramSession, BrowserProgramTarget } from './browser-program-port.js'
import type { BrowserNetworkSession } from './browser-page-transport.js'
import { BrowserRequestFailure } from './browser-program-port.js'

const EVENTS = ['Page.frameNavigated','Page.navigatedWithinDocument','Page.loadEventFired','Page.javascriptDialogOpening',
  'Page.javascriptDialogClosed','Page.fileChooserOpened','Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Input.dragIntercepted','Fetch.requestPaused'] as const
/** Puppeteer's original flattened CDP sessions supply page and OOPIF senders. No target is reselected. */
export class OwnedBrowserTargetSession implements BrowserProgramSession {
  readonly frames = new Map<string, BrowserCdpSender>()
  private readonly listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>()
  private readonly cleanup: (() => void)[] = []
  private readonly children = new Map<string, CDPSession>()
  private closed = false
  private missing: string | null = null
  constructor(private readonly root: CDPSession, private readonly binding: BrowserProgramTarget,
    private readonly current: () => boolean) {}
  get endedReason(): string | null { return this.closed || !this.current() || this.root.detached ? 'The original native Browser connection ended. Inspect its retained identity; actions are not replayed.' : null }
  get frameDiscoveryFailure(): string | null { return this.missing }
  readonly sendCommand: BrowserCdpSender = (method, params) => this.command(this.root, method, params)
  observe(listener: (method: string, params: unknown, sessionId?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async openNetworkSession(): Promise<BrowserNetworkSession> {
    const { targetInfo } = await this.root.send('Target.getTargetInfo')
    if (this.endedReason) throw new Error(this.endedReason)
    const { sessionId } = await this.root.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true })
    const native = this.root.connection()?.session(sessionId)
    if (!native) throw new Error('The original network session acknowledgement is unavailable. No replacement target is selected.')
    const listeners = new Set<(method: string, params: unknown) => void>()
    const removals = [...EVENTS, 'Network.dataReceived' as const].map(method => {
      const fn = (params: unknown) => { for (const listener of listeners) listener(method, params) }
      native.on(method, fn); return () => native.off(method, fn)
    })
    const close = async () => { try { if (!native.detached) await this.root.send('Target.detachFromTarget', { sessionId }) } finally { if (native.detached) { for (const remove of removals) remove(); listeners.clear() } } }
    if (this.endedReason) { await close(); throw new Error(this.endedReason) }
    try { await native.send('Page.enable') } catch (error) { await close(); throw error }
    return {
      get endedReason() { return native.detached ? 'The original native network session ended.' : null },
      sendCommand: (method, params) => (native.send as (method: string, params?: Record<string, unknown>) => Promise<unknown>)(method, params),
      observe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }, close
    }
  }
  private async command(session: CDPSession, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.endedReason || session.detached || session !== this.root && this.children.get(session.id()) !== session) throw new BrowserRequestFailure('The original Browser/frame is unavailable. Nothing was sent to a substitute.', false)
    const navigationId = this.binding.navigationId
    try {
      const result = await (session.send as (method: string, params?: Record<string, unknown>) => Promise<unknown>)(method, params)
      if (this.endedReason || session !== this.root && this.children.get(session.id()) !== session ||
          this.binding.navigationId !== navigationId && !['Page.navigate','Runtime.evaluate','Runtime.callFunctionOn'].includes(method)) {
        throw new BrowserRequestFailure('The original Browser document/frame changed before its command result was confirmed. Inspect it; do not repeat the action.', true)
      }
      return result
    } catch (cause) {
      if (cause instanceof BrowserRequestFailure) throw cause
      // CDP rejection does not establish non-dispatch. Its original command may have changed the page.
      throw new BrowserRequestFailure(cause instanceof Error ? cause.message : String(cause), true)
    }
  }
  private watch(session: CDPSession, childId?: string): void {
    for (const method of EVENTS) {
      const listener = (params: unknown) => { for (const fn of this.listeners) fn(method, params, childId) }
      session.on(method, listener); this.cleanup.push(() => session.off(method, listener))
    }
    const attached = (params: { sessionId: string; targetInfo: { type: string } }) => {
      // Workers are not DOM documents and must not enter the page's ref frame map.
      if (params.targetInfo.type !== 'iframe') return
      const child = session.connection()?.session(params.sessionId)
      if (!child) { this.missing = 'An original child document session was not observed. Snapshot reports available documents only.'; return }
      this.children.set(params.sessionId, child)
      this.frames.set(params.sessionId, (method, args) => this.command(child, method, args))
      this.watch(child, params.sessionId)
      void child.send('Page.enable').catch(() => { this.missing = 'An original child document could not enable observation.' })
      void child.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => { this.missing = 'Nested document discovery is unavailable.' })
    }
    const detached = (params: { sessionId: string }) => { this.frames.delete(params.sessionId); this.children.delete(params.sessionId) }
    session.on('Target.attachedToTarget', attached); session.on('Target.detachedFromTarget', detached)
    this.cleanup.push(() => { session.off('Target.attachedToTarget', attached); session.off('Target.detachedFromTarget', detached) })
  }
  async attach(): Promise<void> {
    this.watch(this.root)
    await this.root.send('Page.enable')
    try { await this.root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }) }
    catch { this.missing = 'Native child document discovery is unavailable. Snapshot reports available documents only.' }
  }
  async detach(): Promise<string | undefined> {
    if (this.closed) return
    this.closed = true
    for (const release of this.cleanup.splice(0)) release()
    this.frames.clear(); this.children.clear(); this.listeners.clear()
    try { await this.root.detach() } catch { return 'The original debugger detach was not confirmed. Browser and operation identity remain available; inspect them before another operation.' }
  }
}
