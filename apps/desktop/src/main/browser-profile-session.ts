import { createBrowserProfileSocksTransport, type BrowserProfileSocksTransportPorts } from './browser-profile-socks-transport.js'
import type { BrowserProfileNetworkApplication, BrowserProfileEnvironment, BrowserProfileNativeUse } from '@agentmux/core/control'
import type { BrowserProfilePageEnvironmentPorts } from './browser-profile-page-environment.js'
import { createBrowserProfileEnvironment } from './browser-profile-environment.js'
import type { Session, WebContents, DownloadItem } from 'electron'
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
  retainedSession?(profileId: string): Session
  network(profileId: string): BrowserProfileNetwork | undefined
  environment?(profileId: string): BrowserProfileEnvironment | undefined
  defaultLanguage?(): string
  /** Pages already open, so a route change also moves their WebRTC policy. */
  openContents(): readonly WebContents[]
}

export class BrowserProfileNetworkUnavailable extends Error {
  readonly code = 'BROWSER_PROFILE_NETWORK_UNAVAILABLE'
  constructor(readonly profileId: string, cause: unknown) {
    super('The Profile’s requested network configuration could not be confirmed. Its saved settings and Browser controls remain available. Inspect the original route before retrying.', { cause })
  }
}

function routeKey(network: BrowserProfileNetwork | undefined): string {
  return JSON.stringify(network ?? { mode: 'system' })
}

type NativeSessionObservation = { profileId: string; requests: Set<number>; downloads: Set<DownloadItem>; issue: string | null }
// One original native Session owns these event facts, shared by any client of the same Session.
const nativeSessionObservations = new WeakMap<Session, NativeSessionObservation>()
const nativeProfileSessions = new Map<string, Session>()
function observeNativeSession(target: Session, profileId: string): NativeSessionObservation {
  const existing = nativeSessionObservations.get(target)
  if (existing) { if (existing.profileId !== profileId) throw new Error('Native Session ownership differs from this Profile'); return existing }
  const observation: NativeSessionObservation = { profileId, requests: new Set(), downloads: new Set(), issue: null }
  nativeSessionObservations.set(target, observation)
  try {
    // Normal Profile sessions only. Capsule response listeners own their separate Capsule partitions.
    target.webRequest.onBeforeRequest((details, callback) => {
      try { observation.requests.add(details.id) }
      catch { observation.issue = 'Request observation is unavailable; original native work remains available.' }
      finally { callback({}) }
    })
    target.webRequest.onCompleted(details => { observation.requests.delete(details.id) })
    target.webRequest.onErrorOccurred(details => { observation.requests.delete(details.id) })
    target.on('will-download', (_event, item) => {
      observation.downloads.add(item)
      item.on('done', () => {
        try { if (item.getState() === 'completed' || item.getState() === 'cancelled' || item.getState() === 'interrupted' && !item.canResume()) observation.downloads.delete(item) }
        catch { /* Keep the exact unknown native item; a failed observation cannot prove it ended. */ }
      })
    })
  } catch { observation.issue = 'Native use observation could not be established. The original Profile remains available.' }
  return observation
}

export function createBrowserProfileSessions(ports: BrowserProfileSessionPorts) {
  const ownedSession = (profileId: string, retained = false): Session => {
    const target = retained && ports.retainedSession ? ports.retainedSession(profileId) : ports.session(profileId)
    observeNativeSession(target, profileId); nativeProfileSessions.set(profileId, target)
    return target
  }
  const environment = ports.environment && ports.defaultLanguage ? createBrowserProfileEnvironment({
    session: ownedSession, settings: ports.environment, defaultLanguage: ports.defaultLanguage
  }) : undefined
  // What each session currently uses, and the one application in flight for it.
  const applied = new WeakMap<Session, { key: string; confirmed: boolean }>()
  const pending = new WeakMap<Session, { key: string; done: Promise<void> }>()
  // Sessions whose route is a proxy: their pages must not send WebRTC around it.
  const proxied = new WeakSet<Session>()
  const portsNetwork = ports.network
  let socks: ReturnType<typeof createBrowserProfileSocksTransport> | undefined

  async function apply(target: Session, network: BrowserProfileNetwork | undefined, profileId: string, refresh = false): Promise<void> {
    const key = routeKey(network)
    if (!refresh && applied.get(target)?.key === key && applied.get(target)!.confirmed) return
    const running = pending.get(target)
    if (running?.key === key) return await running.done
    const done = (async () => {
      // One route at a time per session: a newer route waits for the one in flight, then wins.
      await running?.done.catch(() => {})
      const previous = applied.get(target)
      const transport = await socks?.route(profileId, target, network) ?? null
      if (transport?.retainExisting && previous?.key === key && previous.confirmed) return
      applied.delete(target)
      try {
        await target.setProxy({ ...browserProfileProxyConfig(network ?? { mode: 'system' }), ...(transport ? { proxyRules: transport.proxyRules } : {}) })
        // Connections opened under the old route would keep using it.
        await target.closeAllConnections()
      } catch (cause) { socks?.discard(target, transport); throw new BrowserProfileNetworkUnavailable(profileId, cause) }
      socks?.applied(target, transport)
      applied.set(target, { key, confirmed: true })
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
    /** Session has no destroy API. Idle counts cannot replace this process-lifetime admission fact. */
    nativeSessionAdmitted(profileId: string): boolean { return nativeProfileSessions.has(profileId) },
    observedSession(profileId: string): Session | undefined { return nativeProfileSessions.get(profileId) },
    bindSocksTransport(ports: Omit<BrowserProfileSocksTransportPorts, 'network'>): void { if (!socks) socks = createBrowserProfileSocksTransport({ ...ports, network: id => portsNetwork(id) }) },
    async refreshTransport(profileId: string): Promise<boolean> { const network = ports.network(profileId); if (!socks || network?.mode !== 'proxy' || network.server.scheme !== 'socks5') return false; const target = ownedSession(profileId); await apply(target, network, profileId, true); return true },
    answerProxyTransport(target: Session, auth: { isProxy: boolean; host: string; port: number }, callback: (username?: string, password?: string) => void): boolean { return socks?.answer(target, auth, callback) ?? false },
    async fetch(profileId: string, address: string, signal?: AbortSignal): Promise<Response> { const target = ownedSession(profileId); return socks ? socks.fetch(target, address, signal) : target.fetch(address, { method: 'GET', cache: 'no-store', redirect: 'follow', ...(signal ? { signal } : {}) }) },
    dispose(): void { socks?.dispose() },
    nativeSession(profileId: string): Session { return ownedSession(profileId) },
    retainedSession(profileId: string): Session { return ownedSession(profileId, true) },
    profileOfSession(target: Session): string | null { return nativeSessionObservations.get(target)?.profileId ?? null },
    nativeUse(profileId: string): BrowserProfileNativeUse {
      const target = nativeProfileSessions.get(profileId)
      // This factory has never admitted that Profile's native Session in this process.
      if (!target) return { status: 'idle', pages: 0, workers: 0, requests: 0, downloads: 0 }
      const observed = nativeSessionObservations.get(target)
      if (!observed || observed.issue) return { status: 'unknown', pages: null, workers: null, requests: null, downloads: null, reason: observed?.issue ?? 'Native Profile use has not been observed.' }
      try {
        for (const item of observed.downloads) if (item.getState() === 'completed' || item.getState() === 'cancelled' || item.getState() === 'interrupted' && !item.canResume()) observed.downloads.delete(item)
        const pages = ports.openContents().filter(contents => !contents.isDestroyed() && contents.session === target).length
        const workers = Object.keys(target.serviceWorkers.getAllRunning()).length, requests = observed.requests.size, downloads = observed.downloads.size
        return { status: pages || workers || requests || downloads ? 'in-use' : 'idle', pages, workers, requests, downloads }
      } catch { return { status: 'unknown', pages: null, workers: null, requests: observed.requests.size, downloads: null, reason: 'Native workers or downloads could not be observed. The original Profile and work are kept.' } }
    },
    /**
     * Await before creating or restoring any page of this Profile. Returns nothing when there is
     * nothing to apply: a session that was never given a route already follows the system settings,
     * so a Profile without a route opens its page in the same turn, exactly as before routes existed.
     */
    prepare(profileId: string): Promise<void> | undefined {
      environment?.prepare(profileId)
      const target = ownedSession(profileId), network = ports.network(profileId)
      const key = routeKey(network)
      if (applied.get(target)?.key === key) return undefined
      if (!applied.has(target) && !pending.has(target) && network === undefined) { applied.set(target, { key, confirmed: false }); return undefined }
      return apply(target, network, profileId)
    },

    networkApplication(profileId: string, configured: BrowserProfileNetwork | undefined): BrowserProfileNetworkApplication | undefined {
      const target = nativeProfileSessions.get(profileId), key = routeKey(configured)
      if (!target && configured === undefined) return undefined
      return { scope: 'session-proxy-config', status: !target ? 'unknown' : pending.get(target)?.key === key ? 'pending' : applied.get(target)?.key === key && applied.get(target)!.confirmed ? 'applied' : 'unknown' }
    },

    applyEnvironment(profileId: string): void { environment?.prepare(profileId); environment?.applyPages(profileId) },
    preparePageEnvironment(profileId: string, browserId: string, contents: WebContents, port: BrowserProfilePageEnvironmentPorts): Promise<void> { return environment?.preparePage(profileId, browserId, contents, port) ?? Promise.resolve() },
    environmentApplication(profileId: string) { return environment?.inspect(profileId) },
    hasOnlyEnvironmentDebugger(profileId: string, contents: WebContents): boolean { return environment?.hasOnlyEnvironmentDebugger(profileId,contents) === true },
    publishEnvironmentBindings(profileIds:readonly string[]):void { environment?.publishBindings(profileIds) },
    onEnvironmentApplicationChange(listener: (profileId: string) => void): () => void { return environment?.subscribe(listener) ?? (() => {}) },

    /** A saved route change: apply it now, so open pages reconnect through the new route. */
    async apply(profileId: string, network: BrowserProfileNetwork | undefined): Promise<void> {
      await apply(ownedSession(profileId), network, profileId)
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
export type BrowserProfileSessions = Omit<ReturnType<typeof createBrowserProfileSessions>, 'observedSession'> & { observedSession?(profileId: string): Session | undefined }
