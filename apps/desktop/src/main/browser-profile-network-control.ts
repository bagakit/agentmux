import { parseBrowserProfileProxySignIn, type BrowserProfileProxySignIn } from '@agentmux/core/control'
import type { BrowserProfileManager } from './browser-profile-manager.js'
import type { BrowserProfileProxyAuth } from './browser-profile-proxy-auth.js'
import type { BrowserProfileExitChecker } from './browser-profile-exit-check.js'
import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserProxyProbe, BrowserProxyProbeReceipt, BrowserProxyProbeRoute } from '@agentmux/core/control'
import { probeBrowserProxyProtocol } from './browser-proxy-probe.js'

/** Shared Main operations consumed by the trusted Settings IPC and the public Profile dispatcher. */
export function createBrowserProfileNetworkControl(ports: {
  profiles: Pick<BrowserProfileManager, 'initialize' | 'resolvePartition' | 'proxyOf'> & Partial<Pick<BrowserProfileManager, 'refreshProxyTransport' | 'sessions' | 'listProfiles' | 'configurationRevision' | 'networkHistory' | 'recordNetworkDiagnostic'>>
  proxyAuth: Pick<BrowserProfileProxyAuth, 'set' | 'clear'> & Partial<Pick<BrowserProfileProxyAuth, 'withProbeCredentials' | 'transportIssue' | 'hasTransportCredentials'>>
  checkExit: BrowserProfileExitChecker
  checkAddress(): string
  reconnect(profileId: string): Promise<void>
}) {
  if (ports.proxyAuth.withProbeCredentials && ports.proxyAuth.hasTransportCredentials) ports.profiles.sessions?.bindSocksTransport?.({
    revision: id => ports.profiles.configurationRevision?.(id) ?? null,
    credentials: { hasTransportCredentials: (id, expected) => ports.proxyAuth.hasTransportCredentials!(id, expected), withProbeCredentials: (id, expected, use) => ports.proxyAuth.withProbeCredentials!(id, expected, use),
      ...(ports.proxyAuth.transportIssue ? { transportIssue: (id, expected, reason) => ports.proxyAuth.transportIssue!(id, expected, reason) } : {}) }
  })
  const active = new Map<string, { id: string; result: Promise<BrowserProxyProbeReceipt> }>()
  return {
    async probe(profileId: string, operationId = mintObjectId()): Promise<BrowserProxyProbeReceipt> {
      await ports.profiles.initialize(); ports.profiles.resolvePartition(profileId)
      const { networkHistory, recordNetworkDiagnostic, configurationRevision } = ports.profiles
      if (!networkHistory || !recordNetworkDiagnostic || !configurationRevision) throw new Error('Tracked network diagnostics are unavailable; the original exit check and Browser remain available.')
      const running = active.get(profileId)
      if (running?.id === operationId) return await running.result
      const prior = await networkHistory.call(ports.profiles, profileId, operationId)
      const currentActive = active.get(profileId)
      if (currentActive?.id === operationId) return await currentActive.result
      if (prior.diagnostics[0]) return { diagnostic: prior.diagnostics[0], historySaved: true }
      if (active.has(profileId)) throw new Error('A diagnostic is already using this Profile; inspect its original history. Browser traffic remains available.')
      const profile = ports.profiles.listProfiles?.().find(item => item.id === profileId)
      if (!profile) throw new Error('The original Profile configuration is unavailable; no diagnostic was dispatched.')
      const network = profile.network ?? { mode: 'system' as const }
      const route: BrowserProxyProbeRoute = network.mode === 'proxy' ? { mode: 'proxy', ...network.server } : { mode: network.mode }
      const address = ports.checkAddress()
      let exitOrigin: string | null = null
      try { const url = new URL(address); if (url.protocol === 'https:' && !url.username && !url.password) exitOrigin = url.origin } catch { /* Address remains unconfirmed. */ }
      const diagnostic: BrowserProxyProbe = { id: operationId, profileId, configurationRevision: profile.revision, route, exitOrigin, startedAt: Date.now(), phase: 'pending',
        tcp: { status: 'unknown', reason: 'not-started', latencyMs: 0 }, authentication: { status: 'unknown', reason: 'not-started', latencyMs: 0 },
        exit: { status: 'unknown', reason: 'not-started', latencyMs: 0 } }
      const current = () => configurationRevision.call(ports.profiles, profileId) === profile.revision
      const execute = async (): Promise<BrowserProxyProbeReceipt> => {
        // Register the original immutable target before protocol side effects. A lost write ACK
        // can be inspected by this id; it never starts an unrecorded credential transmission.
        await recordNetworkDiagnostic.call(ports.profiles, diagnostic)
        let historySaved = true
        const save = async () => { try { await recordNetworkDiagnostic.call(ports.profiles, diagnostic); historySaved = true } catch { historySaved = false } }
        const protocol = await probeBrowserProxyProtocol(route, { current, observed: async tcp => { diagnostic.tcp = tcp; await save() },
          credentials: use => {
            if (route.mode !== 'proxy' || !ports.proxyAuth.withProbeCredentials) throw new Error('Original proxy credential owner is unavailable.')
            return ports.proxyAuth.withProbeCredentials(profileId, { host: route.host, port: route.port, configurationRevision: profile.revision }, use)
          } })
        Object.assign(diagnostic, protocol); await save()
        if (!current()) diagnostic.exit = { status: 'unknown', reason: 'route-changed', latencyMs: 0 }
        else if (!address) diagnostic.exit = { status: 'unknown', reason: 'check-address-missing', latencyMs: 0 }
        else {
          const started = performance.now()
          try {
            const exit = await ports.checkExit(profileId, address)
            diagnostic.exit = !current() ? { status: 'unknown', reason: 'route-changed', latencyMs: performance.now() - started }
              : exit.status === 'reachable' ? exit : { status: 'unknown', reason: 'exit-unavailable', latencyMs: exit.latencyMs }
          } catch { diagnostic.exit = { status: 'unknown', reason: current() ? 'exit-unavailable' : 'route-changed', latencyMs: performance.now() - started } }
        }
        diagnostic.webrtc = !current()
          ? { status: 'unknown', reason: 'route-changed', observedPages: 0 }
          : ports.profiles.sessions?.observeWebRtc?.(profileId) ?? { status: 'unknown', reason: 'native-unavailable', observedPages: 0 }
        diagnostic.phase = 'observed'; diagnostic.finishedAt = Date.now(); await save()
        return { diagnostic: structuredClone(diagnostic), historySaved }
      }
      const result = execute(); active.set(profileId, { id: operationId, result })
      try { return await result } finally { if (active.get(profileId)?.id === operationId) active.delete(profileId) }
    },
    async setProxySignIn(profileId: string, signIn: BrowserProfileProxySignIn | null): Promise<{ reconnected: boolean }> {
      await ports.profiles.initialize()
      ports.profiles.resolvePartition(profileId)
      if (signIn === null) await ports.proxyAuth.clear(profileId)
      else if (!ports.profiles.proxyOf(profileId)) {
        throw Object.assign(new Error('Set this Profile’s network to a proxy first; a sign-in is kept only for its own proxy.'), { code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' })
      } else {
        await ports.proxyAuth.set(profileId, parseBrowserProfileProxySignIn(signIn))
      }
      // A saved credential is committed even if reconnecting a page fails; never report that as an
      // unapplied secret write and invite a blind retry. The next request uses the saved sign-in.
      try { if (await ports.profiles.refreshProxyTransport?.(profileId)) return { reconnected: true }; await ports.reconnect(profileId); return { reconnected: true } }
      catch { return { reconnected: false } }
    },
    async checkExit(profileId: string) {
      await ports.profiles.initialize()
      return await ports.checkExit(profileId, ports.checkAddress())
    }
  }
}
export type BrowserProfileNetworkControl = ReturnType<typeof createBrowserProfileNetworkControl>
