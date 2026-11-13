import type { BrowserProfileEnvironment } from '@agentmux/core/control'
import type { BrowserProfilePageEnvironmentPorts } from './browser-profile-page-environment.js'
import { createBrowserProfileEnvironment } from './browser-profile-environment.js'
import type { Session, WebContents } from 'electron'
import { browserProfileProxyConfig, type BrowserProfileNetwork } from '../shared/browser-profile-network.js'

/**
 * Applies each Profile's network route to its own session before any page of that Profile loads.
 *
 * One owner, so a route is applied once per change instead of by every place that creates a view:
 * create, restore, a Profile switch and native children all await `prepare` for the Profile, and
 * child windows inherit the same session. A route that cannot be applied is a typed refusal that
 * only stops opening pages of that Profile; it never falls back to a direct connection, and pages
 * already open keep their current route.
 */
export type BrowserProfileSessionPorts = {
  session(profileId: string): Session
  network(profileId: string): BrowserProfileNetwork | undefined
  environment?(profileId: string): BrowserProfileEnvironment | undefined
  defaultLanguage?(): string
  /** Pages already open, so a route change also moves their WebRTC policy. */
  openContents(): readonly WebContents[]
}

export class BrowserProfileNetworkUnavailable extends Error {
  readonly code = 'BROWSER_PROFILE_NETWORK_UNAVAILABLE'
  constructor(readonly profileId: string, cause: unknown) {
    super('This Profile’s network route could not be applied, so its pages were not opened. Nothing was sent directly. Retry, or edit the Profile’s network.', { cause })
  }
}

function routeKey(network: BrowserProfileNetwork | undefined): string {
  return JSON.stringify(network ?? { mode: 'system' })
}

export function createBrowserProfileSessions(ports: BrowserProfileSessionPorts) {
  const environment = ports.environment && ports.defaultLanguage ? createBrowserProfileEnvironment({
    session: ports.session, settings: ports.environment, defaultLanguage: ports.defaultLanguage
  }) : undefined
  // What each session currently uses, and the one application in flight for it.
  const applied = new WeakMap<Session, string>()
  const pending = new WeakMap<Session, { key: string; done: Promise<void> }>()
  // Sessions whose route is a proxy: their pages must not send WebRTC around it.
  const proxied = new WeakSet<Session>()

  async function apply(target: Session, network: BrowserProfileNetwork | undefined, profileId: string): Promise<void> {
    const key = routeKey(network)
    if (applied.get(target) === key) return
    const running = pending.get(target)
    if (running?.key === key) return await running.done
    const done = (async () => {
      // One route at a time per session: a newer route waits for the one in flight, then wins.
      await running?.done.catch(() => {})
      try {
        await target.setProxy(browserProfileProxyConfig(network ?? { mode: 'system' }))
        // Connections opened under the old route would keep using it.
        await target.closeAllConnections()
      } catch (cause) { throw new BrowserProfileNetworkUnavailable(profileId, cause) }
      applied.set(target, key)
      if (network?.mode === 'proxy') proxied.add(target)
      else proxied.delete(target)
      const policy = network?.mode === 'proxy' ? 'disable_non_proxied_udp' : 'default'
      for (const contents of ports.openContents()) {
        if (!contents.isDestroyed() && contents.session === target) contents.setWebRTCIPHandlingPolicy(policy)
      }
    })()
    pending.set(target, { key, done })
    try { await done } finally { if (pending.get(target)?.done === done) pending.delete(target) }
  }

  return {
    /**
     * Await before creating or restoring any page of this Profile. Returns nothing when there is
     * nothing to apply: a session that was never given a route already follows the system settings,
     * so a Profile without a route opens its page in the same turn, exactly as before routes existed.
     */
    prepare(profileId: string): Promise<void> | undefined {
      environment?.prepare(profileId)
      const target = ports.session(profileId), network = ports.network(profileId)
      const key = routeKey(network)
      if (applied.get(target) === key) return undefined
      if (!applied.has(target) && !pending.has(target) && network === undefined) { applied.set(target, key); return undefined }
      return apply(target, network, profileId)
    },

    applyEnvironment(profileId: string): void { environment?.prepare(profileId); environment?.applyPages(profileId) },
    preparePageEnvironment(profileId: string, browserId: string, contents: WebContents, port: BrowserProfilePageEnvironmentPorts): Promise<void> { return environment?.preparePage(profileId, browserId, contents, port) ?? Promise.resolve() },
    environmentApplication(profileId: string) { return environment?.inspect(profileId) },
    hasOnlyEnvironmentDebugger(profileId: string, contents: WebContents): boolean { return environment?.hasOnlyEnvironmentDebugger(profileId,contents) === true },
    publishEnvironmentBindings(profileIds:readonly string[]):void { environment?.publishBindings(profileIds) },
    onEnvironmentApplicationChange(listener: (profileId: string) => void): () => void { return environment?.subscribe(listener) ?? (() => {}) },

    /** A saved route change: apply it now, so open pages reconnect through the new route. */
    async apply(profileId: string, network: BrowserProfileNetwork | undefined): Promise<void> {
      await apply(ports.session(profileId), network, profileId)
    },

    /**
     * Every WebContents is passed here once, from app 'web-contents-created'. A page of a proxied
     * Profile, including a child window, keeps WebRTC on the proxy instead of a direct UDP path.
     */
    observe(contents: WebContents): void {
      if (proxied.has(contents.session)) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    }
  }
}
export type BrowserProfileSessions = ReturnType<typeof createBrowserProfileSessions>
