import { createBrowserProfilePageEnvironment, type BrowserProfilePageEnvironmentPorts } from './browser-profile-page-environment.js'
import type { WebContents } from 'electron'
import type { Session } from 'electron'
import type { BrowserProfileEnvironment, BrowserProfileEnvironmentApplication } from '@agentmux/core/control'

/** Session defaults only. This owner never reloads, replaces or injects into an existing page. */
export function createBrowserProfileEnvironment(ports: {
  session(profileId: string): Session
  settings(profileId: string): BrowserProfileEnvironment | undefined
  defaultLanguage(): string
}) {
  const defaults = new WeakMap<Session, { userAgent: string; acceptLanguages: string[] }>()
  const outcomes = new Map<string, { session?: Session; key: string; application: BrowserProfileEnvironmentApplication }>()
  const listeners = new Set<(profileId: string) => void>()
  const unsupported = ['navigator.language', 'navigator.languages', 'userAgentMetadata']
  const pageEnvironment = createBrowserProfilePageEnvironment({ settings: ports.settings, userAgent: profileId => ports.session(profileId).getUserAgent(),
    changed: profileId => { for (const listener of [...listeners]) { try { listener(profileId) } catch { console.warn('Browser Profile native application feedback is unavailable; its page remains usable.') } } } })
  const keyOf = (settings: BrowserProfileEnvironment | undefined) => JSON.stringify(settings ?? null)
  const publish = (profileId: string, outcome: NonNullable<ReturnType<typeof outcomes.get>>) => {
    const previous = outcomes.get(profileId)
    outcomes.set(profileId, outcome)
    if (JSON.stringify(previous?.application) === JSON.stringify(outcome.application)) return
    for (const listener of [...listeners]) {
      try { listener(profileId) }
      catch { console.warn('Browser Profile environment feedback could not be published. The original application outcome is retained.') }
    }
  }

  return {
    prepare(profileId: string): void {
      const settings = ports.settings(profileId), previous = outcomes.get(profileId)
      if (!settings && !previous) return
      const key = keyOf(settings)
      let target: Session | undefined
      try {
        target = ports.session(profileId)
        if (previous?.session === target && previous.key === key && previous.application.status === 'applied') return
        let original = defaults.get(target)
        if (!original) {
          // Chromium's initial request language follows the application locale. Capture it before
          // this owner changes the session; omitting the setter's second argument retains an edit.
          original = { userAgent: target.getUserAgent(), acceptLanguages: [ports.defaultLanguage()] }
          defaults.set(target, original)
        }
        const userAgent = settings?.userAgent ?? original.userAgent
        const acceptLanguages = settings?.acceptLanguages ?? original.acceptLanguages
        target.setUserAgent(userAgent, acceptLanguages.join(','))
        const appliedUserAgent = target.getUserAgent()
        if (appliedUserAgent !== userAgent) throw new Error('Native user agent application is unconfirmed')
        publish(profileId, { session: target, key, application: { status: 'applied', scope: 'session-defaults',
          userAgent: appliedUserAgent, acceptLanguages: [...acceptLanguages], unsupported: [...unsupported] } })
      } catch {
        publish(profileId, { ...(target ? { session: target } : {}), key, application: { status: 'unknown', scope: 'session-defaults', unsupported: [...unsupported],
          reason: 'The saved environment could not be confirmed in the original session. Existing pages remain available; retry by opening a new page in this Profile.' } })
        console.warn('The Browser Profile environment application is unconfirmed. Original pages remain available; inspect the Profile for its saved settings and application scope.')
      }
    },
    preparePage(profileId: string, browserId: string, contents: WebContents, port: BrowserProfilePageEnvironmentPorts): Promise<void> { return pageEnvironment.preparePage(profileId, browserId, contents, port) },
    applyPages(profileId: string): void { pageEnvironment.apply(profileId) },
    publishBindings(profileIds:readonly string[]):void { pageEnvironment.publishBindings(profileIds) },
    hasOnlyEnvironmentDebugger(profileId: string, contents: WebContents): boolean { return pageEnvironment.hasOnlyEnvironmentDebugger(profileId,contents) },
    inspect(profileId: string): BrowserProfileEnvironmentApplication | undefined {
      const settings = ports.settings(profileId), outcome = outcomes.get(profileId)
      const pages = pageEnvironment.inspect(profileId)
      if (outcome?.key === keyOf(settings)) {
        const application = structuredClone(outcome.application)
        if (pages.length) { application.pages = pages; application.unsupported = ['native-canvas','native-webgl','native-fonts','tls','deviceMemory','complete-fingerprint']; if (pages.some(page => page.status === 'unknown')) application.status = 'unknown'; else if (application.status !== 'unknown' && pages.some(page => page.status === 'pending')) application.status = 'not-applied' }
        else if (settings && Object.keys(settings).some(key => !['userAgent','acceptLanguages'].includes(key))) { application.status = 'not-applied'; application.unsupported = ['native-canvas','native-webgl','native-fonts','tls','deviceMemory','complete-fingerprint']; application.reason = 'The saved native page settings have no current Browser target application yet. Open a Browser in this Profile to apply them.' }
        return application
      }
      return settings ? { status: 'not-applied', scope: 'session-defaults', unsupported: [...unsupported] } : undefined
    },
    subscribe(listener: (profileId: string) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
