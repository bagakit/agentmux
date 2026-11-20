import type { WebContents } from 'electron'
import {
  type BrowserProfileEnvironment,
  type BrowserProfileEnvironmentPageApplication
} from '@agentmux/core/control'
import { BrowserCdpSession } from './browser-cdp-session.js'
import { browserProfileFingerprintScript } from './browser-profile-fingerprint.js'

export type BrowserProfilePageEnvironmentPorts = {
  applyScreen(): void
  /** The original BVM entry/view/Profile binding, independent of presentation or preparation. */
  isCurrent(): boolean
}
/** Native page application belonging to the original Profile environment owner; no persisted projection. */
export function createBrowserProfilePageEnvironment(ports: {
  settings(profileId: string): BrowserProfileEnvironment | undefined
  userAgent(profileId: string): string
  changed(profileId: string): void
}) {
  type Page = {
    profileId: string
    browserId: string
    contents: WebContents
    port: BrowserProfilePageEnvironmentPorts
    key: string
    requested: string
    pending: boolean
    revision: number
    tail: Promise<void>
    lease: BrowserCdpSession | null
    baselineHardware?: number
    fingerprintScript?: string
    touched: Set<keyof BrowserProfileEnvironment>
    receipt: BrowserProfileEnvironmentPageApplication
    disposed: boolean
    clearing: boolean
    releases: (() => void)[]
  }
  const profiles = new Map<string, Map<WebContents, Page>>()
  const keyOf = (value: BrowserProfileEnvironment | undefined) => JSON.stringify(value ?? null)
  const scope = (applied: boolean): BrowserProfileEnvironmentPageApplication['scope'] => ({
    currentDocument: applied ? 'applied' : 'unknown',
    futureNavigation: applied ? 'applied' : 'unknown',
    subdocuments: 'unknown',
    workers: 'unknown',
    initialScripts: 'unknown'
  })
  const publish = (page: Page, receipt: BrowserProfileEnvironmentPageApplication) => {
    page.receipt = receipt
    ports.changed(page.profileId)
  }
  const current = (page: Page, key: string) =>
    !page.disposed && !page.contents.isDestroyed() && key === keyOf(ports.settings(page.profileId))
  const unknown = (page: Page, reason: string) =>
    publish(page, {
      ...page.receipt,
      status: 'unknown',
      scope: scope(false),
      reason,
      fields: Object.fromEntries(
        Object.keys(page.receipt.fields).map((field) => [
          field,
          { status: 'unknown', scope: 'page-target', reason }
        ])
      )
    })
  function release(page: Page): void {
    if (page.disposed) return
    page.disposed = true
    profiles.get(page.profileId)?.delete(page.contents)
    for (const remove of page.releases.splice(0)) {
      try {
        remove()
      } catch {
        /* A destroyed native wrapper has already ended this exact subscription. */
      }
    }
    page.clearing = true
    page.lease?.detach()
    page.lease = null
    ports.changed(page.profileId)
  }
  async function apply(
    page: Page,
    settings: BrowserProfileEnvironment | undefined,
    key: string
  ): Promise<void> {
    if (!current(page, key)) return
    const fields = new Set<keyof BrowserProfileEnvironment>([
      ...page.touched,
      ...(Object.keys(settings ?? {}) as (keyof BrowserProfileEnvironment)[])
    ])
    for (const field of fields) page.touched.add(field)
    if (!fields.size && !page.lease) {
      page.key = key
      return
    }
    try {
      // An open DevTools surface can coexist with a healthy native lease. Only an
      // actual ended lease pauses reacquisition until that surface closes.
      if (page.lease && page.lease.endedReason !== null && page.contents.isDevToolsOpened())
        throw new Error(
          'DevTools currently owns this page’s debugger. Close DevTools to reapply the saved environment; its page and input remain.'
        )
      if (!page.lease || page.lease.endedReason !== null) {
        if (page.lease) {
          page.clearing = true
          page.lease.detach()
          page.clearing = false
        }
        page.lease = BrowserCdpSession.attach(page.contents)
        delete page.fingerprintScript
      }
      const lease = page.lease
      const ensure = () => {
        if (!current(page, key) || page.lease !== lease || lease.endedReason !== null)
          throw new Error(
            'The original environment version or native debugger changed. The newest saved version remains pending; no page action is replayed.'
          )
      }
      const send = async (method: string, params: Record<string, unknown>) => {
        ensure()
        const value = await lease.sendCommand(method, params)
        ensure()
        return value
      }
      let hardwareBaselineError: string | undefined
      if (
        page.baselineHardware === undefined &&
        (settings?.hardwareConcurrency !== undefined || page.touched.has('hardwareConcurrency'))
      ) {
        try {
          const tree = (await send('Page.getFrameTree', {})) as { frameTree?: { frame?: { id?: string } } }
          const frameId = tree.frameTree?.frame?.id
          if (typeof frameId !== 'string' || !frameId)
            throw new Error(
              'The original native main frame is unconfirmed; its hardware override was not sent.'
            )
          const realm = (await send('Page.createIsolatedWorld', {
            frameId,
            worldName: 'agentmux-profile-environment-baseline',
            grantUniveralAccess: false
          })) as { executionContextId?: number }
          if (!Number.isInteger(realm.executionContextId) || realm.executionContextId! <= 0)
            throw new Error(
              'The original isolated hardware baseline context is unconfirmed; its override was not sent.'
            )
          const result = (await send('Runtime.evaluate', {
            expression: 'navigator.hardwareConcurrency',
            contextId: realm.executionContextId,
            returnByValue: true
          })) as { result?: { value?: unknown } }
          const value = result.result?.value
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
            throw new Error(
              'The original native hardware concurrency baseline could not be observed; its override was not sent.'
            )
          page.baselineHardware = value
        } catch (cause) {
          hardwareBaselineError = cause instanceof Error ? cause.message : String(cause)
        }
      }
      const receipt: BrowserProfileEnvironmentPageApplication = {
        browserId: page.browserId,
        status: 'applied',
        fields: {},
        scope: scope(true)
      }
      const one = async (
        names: (keyof BrowserProfileEnvironment)[],
        method: string,
        params: Record<string, unknown>
      ) => {
        const relevant = names.filter((name) => fields.has(name))
        if (!relevant.length) return
        try {
          await send(method, params)
          for (const name of relevant) receipt.fields[name] = { status: 'applied', scope: 'page-target' }
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause)
          for (const name of relevant)
            receipt.fields[name] = { status: 'unknown', scope: 'page-target', reason }
          receipt.status = 'unknown'
          receipt.scope = scope(false)
        }
      }
      await one(['timeZone'], 'Emulation.setTimezoneOverride', { timezoneId: settings?.timeZone ?? '' })
      await one(['locale'], 'Emulation.setLocaleOverride', { locale: settings?.locale ?? '' })
      await one(
        ['geolocation'],
        settings?.geolocation ? 'Emulation.setGeolocationOverride' : 'Emulation.clearGeolocationOverride',
        settings?.geolocation ? { ...settings.geolocation } : {}
      )
      await one(
        ['userAgent', 'acceptLanguages', 'userAgentMetadata'],
        'Emulation.setUserAgentOverride',
        settings && (settings.userAgent || settings.acceptLanguages || settings.userAgentMetadata)
          ? {
              userAgent: settings.userAgent ?? ports.userAgent(page.profileId),
              acceptLanguage: settings.acceptLanguages?.join(',') ?? '',
              ...(settings.userAgentMetadata ? { userAgentMetadata: settings.userAgentMetadata } : {})
            }
          : { userAgent: '', acceptLanguage: '' }
      )
      if (page.baselineHardware !== undefined)
        await one(['hardwareConcurrency'], 'Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: settings?.hardwareConcurrency ?? page.baselineHardware
        })
      else if (hardwareBaselineError) {
        receipt.fields.hardwareConcurrency = {
          status: 'unknown',
          scope: 'page-target',
          reason: hardwareBaselineError
        }
        receipt.status = 'unknown'
        receipt.scope = scope(false)
      }
      if (fields.has('fingerprint')) {
        try {
          const previous = page.fingerprintScript
          if (previous) {
            ensure()
            await lease.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous })
            delete page.fingerprintScript
          }
          const source = browserProfileFingerprintScript(settings?.fingerprint)
          ensure()
          const { identifier } = await lease.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source, runImmediately: true
          }) as { identifier: string }
          page.fingerprintScript = identifier
          ensure()
          if (!settings?.fingerprint?.surfaces.length) {
            await lease.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
            delete page.fingerprintScript
            ensure()
          }
          receipt.fields.fingerprint = {
            status: 'applied',
            scope: 'page-target',
            reason: settings?.fingerprint?.surfaces.length
              ? 'Document-start script registered on this native page target. Frame coverage is unconfirmed. Workers retain their native behavior.'
              : 'Document overrides cleared.'
          }
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause)
          receipt.fields.fingerprint = { status: 'unknown', scope: 'page-target', reason }
          receipt.status = 'unknown'
          receipt.scope = scope(false)
        }
      }
      if (fields.has('screen')) {
        try {
          ensure()
          page.port.applyScreen()
          ensure()
          receipt.fields.screen = { status: 'applied', scope: 'page-target' }
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause)
          receipt.fields.screen = { status: 'unknown', scope: 'page-target', reason }
          receipt.status = 'unknown'
          receipt.scope = scope(false)
        }
      }
      if (!current(page, key)) return
      page.key = key
      for (const field of fields)
        if (settings?.[field] === undefined && receipt.fields[field]?.status === 'applied')
          page.touched.delete(field)
      if (receipt.status === 'unknown')
        receipt.reason =
          'One or more native environment fields could not be confirmed. The original page remains available; inspect each field and close DevTools if it owns the connection.'
      publish(page, receipt)
      if (!settings && receipt.status === 'applied') {
        page.clearing = true
        lease.detach()
        page.lease = null
        page.clearing = false
      }
    } catch (cause) {
      if (current(page, key)) unknown(page, cause instanceof Error ? cause.message : String(cause))
    }
  }
  function schedule(page: Page, force = false): Promise<void> {
    const settings = ports.settings(page.profileId),
      key = keyOf(settings)
    if (
      !force &&
      page.requested === key &&
      ((page.key === key && page.receipt.status === 'applied') || page.pending)
    )
      return page.tail
    page.requested = key
    if (!settings && !page.touched.size && !page.lease) {
      page.key = key
      return Promise.resolve()
    }
    page.pending = true
    const revision = ++page.revision
    publish(page, {
      browserId: page.browserId,
      status: page.receipt.status === 'unknown' ? 'unknown' : 'pending',
      fields: {},
      scope: scope(false),
      reason:
        page.receipt.status === 'unknown'
          ? `${page.receipt.reason ?? 'The earlier native application is unconfirmed.'} The saved version is waiting for its native application.`
          : 'The saved environment is waiting for its original native page application.'
    })
    const work = page.tail
      .catch(() => {})
      .then(() => apply(page, settings && structuredClone(settings), key))
      .finally(() => {
        if (page.revision === revision) page.pending = false
      })
    page.tail = work
    return work
  }
  return {
    /** Preparation waits for observation, not forever for a native ACK; the original work continues. */
    async preparePage(
      profileId: string,
      browserId: string,
      contents: WebContents,
      port: BrowserProfilePageEnvironmentPorts
    ): Promise<void> {
      const pages = profiles.get(profileId) ?? new Map<WebContents, Page>()
      profiles.set(profileId, pages)
      let page = pages.get(contents)
      if (page && page.browserId !== browserId)
        throw new Error('This native page already belongs to another original Browser environment.')
      if (!page) {
        page = {
          profileId,
          browserId,
          contents,
          port,
          key: '',
          requested: '',
          pending: false,
          revision: 0,
          tail: Promise.resolve(),
          lease: null,
          touched: new Set(),
          disposed: false,
          clearing: false,
          releases: [],
          receipt: { browserId, status: 'pending', fields: {}, scope: scope(false) }
        }
        pages.set(contents, page)
        const original = page
        const detached = () => {
          if (!original.disposed && !original.clearing)
            unknown(
              original,
              'The original native debugger detached. Its environment scope is unknown; the page and input remain. Close DevTools to reapply the saved version without reloading.'
            )
        }
        const closed = () => {
          if (!original.disposed) void schedule(original, true)
        }
        const documentReady = () => {
          // A fresh target can reject Runtime.evaluate while its first native document is
          // being initialized. Observe the baseline after that exact document becomes ready;
          // this applies saved native configuration and never navigates or replays page actions.
          if (
            !original.disposed &&
            original.baselineHardware === undefined &&
            ports.settings(profileId)?.hardwareConcurrency !== undefined
          )
            void schedule(original, true)
        }
        const destroyed = () => release(original)
        contents.debugger.on('detach', detached)
        contents.on('devtools-closed', closed)
        contents.on('dom-ready', documentReady)
        contents.once('destroyed', destroyed)
        page.releases.push(
          () => contents.debugger.off('detach', detached),
          () => contents.off('devtools-closed', closed),
          () => contents.off('dom-ready', documentReady),
          () => contents.off('destroyed', destroyed)
        )
      } else page.port = port
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        schedule(page),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!page!.disposed && page!.receipt.status === 'pending')
              unknown(
                page!,
                'The original native environment acknowledgement is still unconfirmed. The page remains available; read this Profile again for its later result.'
              )
            resolve()
          }, 3_000)
        })
      ])
      clearTimeout(timer)
    },
    apply(profileId: string): void {
      for (const page of profiles.get(profileId)?.values() ?? []) void schedule(page)
    },
    inspect(profileId: string): BrowserProfileEnvironmentPageApplication[] {
      const key = keyOf(ports.settings(profileId))
      return [...(profiles.get(profileId)?.values() ?? [])]
        .filter((page) => !page.disposed && page.port.isCurrent())
        .map((page) =>
          page.requested === key
            ? structuredClone(page.receipt)
            : {
                browserId: page.browserId,
                status: 'pending',
                fields: {},
                scope: scope(false),
                reason: 'The saved environment is waiting for its original native page application.'
              }
        )
    },
    /** BVM has atomically changed its original binding; this republishes projection, not native commands. */
    publishBindings(profileIds: readonly string[]): void {
      for (const profileId of new Set(profileIds)) ports.changed(profileId)
    },
    hasOnlyEnvironmentDebugger(profileId: string, contents: WebContents): boolean {
      const page = profiles.get(profileId)?.get(contents)
      return !!page && !page.disposed && page.lease?.isSoleConsumer === true
    }
  }
}
