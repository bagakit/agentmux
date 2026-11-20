import type { WebContents } from 'electron'
import { BrowserCdpSession } from './browser-cdp-session.js'

/** Touch emulation ends when its native debugger lease ends. Only that Browser owns this lease. */
export class BrowserViewportTouch {
  private readonly pages = new WeakMap<WebContents, { lease: BrowserCdpSession; release(): void }>()
  private readonly changes = new WeakMap<WebContents, Promise<void>>()

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
    let original = this.pages.get(contents)
    if (original && original.lease.endedReason !== null) {
      original.release()
      original = undefined
    }
    if (!enabled) {
      if (!original) return
      await original.lease.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
      original.release()
      return
    }
    if (original) return
    const lease = BrowserCdpSession.attach(contents, { background: true })
    const release = () => {
      this.pages.delete(contents)
      if (!contents.isDestroyed()) contents.removeListener('destroyed', release)
      lease.detach()
    }
    try {
      await lease.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      if (lease.endedReason !== null || contents.isDestroyed()) throw new Error('The original touch viewport connection ended.')
      this.pages.set(contents, { lease, release })
      contents.once('destroyed', release)
    } catch (error) {
      release()
      throw error
    }
  }
}
