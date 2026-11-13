import { parseBrowserProfileProxySignIn, type BrowserProfileProxySignIn } from '@agentmux/core/control'
import type { BrowserProfileManager } from './browser-profile-manager.js'
import type { BrowserProfileProxyAuth } from './browser-profile-proxy-auth.js'
import type { BrowserProfileExitChecker } from './browser-profile-exit-check.js'

/** Shared Main operations consumed by the trusted Settings IPC and the public Profile dispatcher. */
export function createBrowserProfileNetworkControl(ports: {
  profiles: Pick<BrowserProfileManager, 'initialize' | 'resolvePartition' | 'proxyOf'>
  proxyAuth: Pick<BrowserProfileProxyAuth, 'set' | 'clear'>
  checkExit: BrowserProfileExitChecker
  checkAddress(): string
  reconnect(profileId: string): Promise<void>
}) {
  return {
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
      try { await ports.reconnect(profileId); return { reconnected: true } }
      catch { return { reconnected: false } }
    },
    async checkExit(profileId: string) {
      await ports.profiles.initialize()
      return await ports.checkExit(profileId, ports.checkAddress())
    }
  }
}
export type BrowserProfileNetworkControl = ReturnType<typeof createBrowserProfileNetworkControl>
