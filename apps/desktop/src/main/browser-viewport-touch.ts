import type { WebContents } from 'electron'
import { BrowserCdpSession } from './browser-cdp-session.js'

/** Touch emulation ends when its native debugger lease ends. Only that Browser owns this lease. */
export class BrowserViewportTouch {
  // No record means native touch is off or has not been requested on this renderer.
  // null remembers an unconfirmed attempt on the original page.
  private readonly pages = new WeakMap<WebContents, { lease: BrowserCdpSession; release(): void } | null>()
  private readonly changes = new WeakMap<WebContents, Promise<void>>()

  constructor(private readonly onLost: (contents: WebContents) => void) {}

  isUnconfirmed(contents: WebContents): boolean {
    const original = this.pages.get(contents)
    return original === null || !!original && original.lease.endedReason !== null
  }

  hasWork(contents: WebContents): boolean {
    return this.pages.has(contents) || this.changes.has(contents)
  }

  run<T>(contents: WebContents, apply: () => Promise<T>): Promise<T> {
    const result = (this.changes.get(contents) ?? Promise.resolve()).then(apply)
    const tail = result.then(() => {}, () => {})
    this.changes.set(contents, tail)
    void tail.then(() => { if (this.changes.get(contents) === tail) this.changes.delete(contents) })
    return result
  }

  async set(contents: WebContents, enabled: boolean): Promise<void> {
    const original = this.pages.get(contents)
    const active = original && original.lease.endedReason === null
    if (!enabled) {
      if (active) await original.lease.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
      original?.release()
      this.pages.delete(contents)
      return
    }
    if (active) return
    original?.release()
    try {
      await this.enable(contents)
    } catch (error) {
      if (!contents.isDestroyed()) this.pages.set(contents, null)
      throw error
    }
  }

  private async enable(contents: WebContents): Promise<void> {
    const lease = BrowserCdpSession.attach(contents, { background: true })
    const release = () => {
      this.pages.delete(contents)
      if (!contents.isDestroyed()) contents.off('destroyed', release)
      lease.detach()
    }
    try {
      await lease.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      if (lease.endedReason !== null || contents.isDestroyed()) throw new Error('The original touch viewport connection ended.')
      this.pages.set(contents, { lease, release })
      contents.once('destroyed', release)
      lease.observeEnd(() => {
        if (this.pages.get(contents)?.lease !== lease) return
        release()
        if (contents.isDestroyed()) return
        this.pages.set(contents, null)
        this.onLost(contents)
      })
    } catch (error) {
      release()
      throw error
    }
  }
}
