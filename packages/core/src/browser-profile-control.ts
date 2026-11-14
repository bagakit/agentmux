import { isBrowserProfileCreationOperation, browserProfileCreationOperationId, parseBrowserProfileCreationInspection, type BrowserProfileCreationOperation, type BrowserProfileCreationInspection } from './browser-profile-creation.js'
import { BROWSER_PROFILE_COOKIE_FILE_OPERATIONS, isBrowserProfileCookieFileOperation, parseBrowserProfileCookieFilePayload, parseBrowserProfileCookieFileResult, assertBrowserProfileCookieFileTarget, type BrowserProfileCookieFileOperation, type BrowserProfileCookieFilePayload, type BrowserProfileCookieFileResult } from './browser-profile-cookie-files.js'
import { BROWSER_PROFILE_BOOKMARK_OPERATIONS, isBrowserProfileBookmarkOperation, parseBrowserProfileBookmarkPayload, parseBrowserProfileBookmarkResult, assertBrowserProfileBookmarkTarget, type BrowserProfileBookmarkOperation, type BrowserProfileBookmarkPayload, type BrowserProfileBookmarkResult } from './browser-profile-bookmarks.js'
import { parseBrowserProxyProbe, type BrowserProxyProbeReceipt, type BrowserProxyProbeHistory } from './browser-proxy-probe.js'
import { BROWSER_PROFILE_EXTENSION_OPERATIONS, isBrowserProfileExtensionOperation, parseBrowserProfileExtensionPayload, parseBrowserProfileExtensionResult, assertBrowserProfileExtensionTarget, type BrowserProfileExtensionOperation, type BrowserProfileExtensionPayload, type BrowserProfileExtensionResult } from './browser-profile-extensions.js'
import { parseBrowserProxyEdit, parseBrowserProxyAsset, parseBrowserProxyBinding, parseBrowserProfileNetworkApplication, type BrowserProxyEdit, type BrowserProxyAsset, type BrowserProxyBinding, type BrowserProfileNetworkApplication } from './browser-proxy-library.js'
import type { BrowserProfileTrashEntry, BrowserProfileNativeUse, BrowserProfileRecycleReceipt, BrowserProfileRestoreReceipt, BrowserProfilePurgeReceipt, BrowserProfilePurgeResult } from './browser-profile-trash.js'
import { AgentMuxError } from './errors.js'
import { parseBrowserProfileQuery, parseBrowserProfileView, parseBrowserProfileSelection, parseBrowserProfileBulkAction, type BrowserProfileQuery, type BrowserProfileView, type BrowserProfileSelectionItem, type BrowserProfileBulkAction, type BrowserProfileBulkItemResult } from './browser-profile-library.js'

/**
 * Public Browser Profile control. The Desktop Main Profile owner holds every fact; Core only carries
 * typed requests and checks the shape of the owner's answers. No partition, cookie path or
 * credential is returned by this contract. A proxy sign-in write carries a password only to Main.
 */
export const BROWSER_PROFILE_CONTROL_OPERATIONS = [...BROWSER_PROFILE_COOKIE_FILE_OPERATIONS, ...BROWSER_PROFILE_BOOKMARK_OPERATIONS, ...BROWSER_PROFILE_EXTENSION_OPERATIONS, 'browser.profile.creation.inspect', 'browser.profile.proxy.ls', 'browser.profile.proxy.create', 'browser.profile.proxy.update', 'browser.profile.proxy.delete', 'browser.profile.proxy.assign', 'browser.profile.ls', 'browser.profile.inspect', 'browser.profile.create',
  'browser.profile.folder.create', 'browser.profile.folder.rename', 'browser.profile.folder.delete',
  'browser.profile.view.create', 'browser.profile.view.update', 'browser.profile.view.delete', 'browser.profile.bulk-update',
  'browser.profile.trash.ls', 'browser.profile.trash.restore', 'browser.profile.trash.retention', 'browser.profile.trash.purge', 'browser.profile.trash.inspect',
  'browser.profile.copy', 'browser.profile.update', 'browser.profile.set-default', 'browser.profile.delete',
  'browser.profile.proxy-sign-in.set', 'browser.profile.proxy-sign-in.clear', 'browser.profile.network.check', 'browser.profile.network.probe', 'browser.profile.network.history'] as const
export type BrowserProfileControlOperation = typeof BROWSER_PROFILE_CONTROL_OPERATIONS[number]

/**
 * Fields a person can change; null clears the chosen hue, an empty notes string clears the notes.
 * network is the route as one line Main parses (`system`, `direct`, or a proxy such as
 * `socks5://proxy.example:1080`), with optional Don't proxy entries; Main owns what a valid route is.
 */
export type BrowserProfileControlEdit = { label?: string; hue?: number | null; notes?: string;
  network?: { mode: 'system' } | { mode: 'direct' } | { mode: 'proxy'; server: string; bypass?: string[] };
  /** Replaces the environment bundle; null restores native defaults. */
  environment?: BrowserProfileEnvironment | null; tags?: string[]; folderId?: string | null; pinned?: boolean }

export type BrowserProfileControlPayload = BrowserProfileCookieFilePayload | BrowserProfileBookmarkPayload | BrowserProfileExtensionPayload
  | { operation: 'browser.profile.creation.inspect'; operationId: string }
  | { operation: 'browser.profile.proxy.ls' }
  | { operation: 'browser.profile.proxy.create'; operationId: string; edit: BrowserProxyEdit }
  | { operation: 'browser.profile.proxy.update'; proxyId: string; expectedRevision: string; edit: BrowserProxyEdit }
  | { operation: 'browser.profile.proxy.delete'; proxyId: string; expectedRevision: string }
  | { operation: 'browser.profile.proxy.assign'; proxyId: string; expectedRevision: string; items: BrowserProfileSelectionItem[] }
  | { operation: 'browser.profile.ls'; query?: BrowserProfileQuery; viewId?: string }
  | { operation: 'browser.profile.view.create'; operationId: string; label: string; query: BrowserProfileQuery; expectedRevision: number }
  | { operation: 'browser.profile.view.update'; viewId: string; label: string; query: BrowserProfileQuery; expectedRevision: number }
  | { operation: 'browser.profile.view.delete'; viewId: string; expectedRevision: number }
  | { operation: 'browser.profile.bulk-update'; items: BrowserProfileSelectionItem[]; action: BrowserProfileBulkAction }
  | { operation: 'browser.profile.folder.rename'; folderId: string; label: string; expectedRevision: number }
  | { operation: 'browser.profile.folder.delete'; folderId: string; expectedRevision: number }
  | { operation: 'browser.profile.folder.create'; operationId: string; label: string; expectedRevision: number }
  | { operation: 'browser.profile.create'; operationId: string; label: string }
  | { operation: 'browser.profile.copy'; operationId: string; profileId: string; expectedRevision: string; label: string }
  | { operation: 'browser.profile.inspect'; profileId: string }
  | { operation: 'browser.profile.update'; profileId: string; expectedRevision: string; edit: BrowserProfileControlEdit }
  | { operation: 'browser.profile.set-default'; profileId: string }
  | { operation: 'browser.profile.delete'; profileId: string; expectedRevision: string }
  | { operation: 'browser.profile.trash.ls' }
  | { operation: 'browser.profile.trash.restore'; archiveId: string; expectedRevision: string; folderId?: string | null }
  | { operation: 'browser.profile.trash.retention'; archiveId: string; expectedRevision: string; purgeId: string; deleteAfter: number | null }
  | { operation: 'browser.profile.trash.purge'; archiveId: string; expectedRevision: string; purgeId: string }
  | { operation: 'browser.profile.trash.inspect'; purgeId: string }
  | { operation: 'browser.profile.proxy-sign-in.set'; profileId: string; signIn: BrowserProfileProxySignIn }
  | { operation: 'browser.profile.proxy-sign-in.clear'; profileId: string }
  | { operation: 'browser.profile.network.check'; profileId: string }
  | { operation: 'browser.profile.network.probe'; profileId: string; operationId: string }
  | { operation: 'browser.profile.network.history'; profileId: string; operationId?: string; before?: string }

/** Canonical tag names, shared by input parsing and Main persistence validation. */
export function normalizeBrowserProfileTags(value: unknown): string[] { return tags(value, 'INVALID_CONTROL_REQUEST') }
function tags(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) fail(code, 'Profile tags must be a list of names.')
  return [...new Set(value.map(item => {
    const name = text(item, code, 'Profile tag', 512).trim().normalize('NFC')
    if (!name || name.length > 128 || /[\r\n]/u.test(name)) fail(code, 'A Profile tag needs one name of at most 128 characters.')
    return name
  }))]
}

/** Profile-owned native environment. It is not a complete or independent fingerprint engine. */
export type BrowserProfileUserAgentMetadata = {
  brands?: { brand: string; version: string }[]
  fullVersionList?: { brand: string; version: string }[]
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness?: string
  wow64?: boolean
}
export type BrowserProfileEnvironment = {
  userAgent?: string
  acceptLanguages?: string[]
  timeZone?: string
  locale?: string
  geolocation?: { latitude: number; longitude: number; accuracy: number }
  userAgentMetadata?: BrowserProfileUserAgentMetadata
  screen?: { width: number; height: number }
  hardwareConcurrency?: number
}
export const BROWSER_PROFILE_ENVIRONMENT_FIELDS = [
  'userAgent',
  'acceptLanguages',
  'timeZone',
  'locale',
  'geolocation',
  'userAgentMetadata',
  'screen',
  'hardwareConcurrency'
] as const satisfies readonly (keyof BrowserProfileEnvironment)[]
export type BrowserProfileEnvironmentField = (typeof BROWSER_PROFILE_ENVIRONMENT_FIELDS)[number]
export type BrowserProfileEnvironmentPageApplication = {
  browserId: string
  status: 'applied' | 'pending' | 'unknown'
  fields: Partial<
    Record<BrowserProfileEnvironmentField, { status: 'applied' | 'unknown'; scope: 'page-target'; reason?: string }>
  >
  /** Native page-target ACK is not a claim about another target or its first script. */
  scope: {
    currentDocument: 'applied' | 'unknown'
    futureNavigation: 'applied' | 'unknown'
    subdocuments: 'unknown'
    workers: 'unknown'
    initialScripts: 'unknown'
  }
  reason?: string
}
/** Session-default receipt plus exact native page-target applications; no retained application is persisted. */
export type BrowserProfileEnvironmentApplication = {
  status: 'not-applied' | 'applied' | 'unknown'
  scope: 'session-defaults'
  userAgent?: string
  acceptLanguages?: string[]
  unsupported: string[]
  reason?: string
  pages?: BrowserProfileEnvironmentPageApplication[]
}

export function parseBrowserProfileEnvironment(value: unknown): BrowserProfileEnvironment {
  const code = 'INVALID_CONTROL_REQUEST',
    row = record(value, [...BROWSER_PROFILE_ENVIRONMENT_FIELDS], code, 'Browser Profile environment')
  if (!Object.keys(row).length) fail(code, 'An environment needs a native setting; use null to restore defaults.')
  const userAgent = row.userAgent === undefined ? undefined : text(row.userAgent, code, 'User agent')
  if (userAgent !== undefined && (!userAgent.trim() || /[^\x20-\x7e]/u.test(userAgent)))
    fail(code, 'User agent must be nonempty printable HTTP header text.')
  let acceptLanguages: string[] | undefined
  if (row.acceptLanguages !== undefined) {
    if (
      !Array.isArray(row.acceptLanguages) ||
      !row.acceptLanguages.length ||
      row.acceptLanguages.some((item) => typeof item !== 'string')
    )
      fail(code, 'Request languages must be a nonempty list of language tags.')
    try {
      acceptLanguages = Intl.getCanonicalLocales(row.acceptLanguages as string[])
    } catch {
      fail(code, 'Request languages must be valid language tags, without HTTP quality weights.')
    }
  }
  let timeZone: string | undefined, locale: string | undefined
  if (row.timeZone !== undefined) {
    timeZone = text(row.timeZone, code, 'Time zone', 256)
    try {
      new Intl.DateTimeFormat('en', { timeZone })
    } catch {
      fail(code, 'Time zone must be a supported IANA time-zone identity.')
    }
  }
  if (row.locale !== undefined) {
    try {
      locale = Intl.getCanonicalLocales(text(row.locale, code, 'Locale', 256))[0]
    } catch {
      fail(code, 'Locale must be a valid language tag.')
    }
    if (!locale) fail(code, 'Locale must be a valid language tag.')
  }
  let geolocation: BrowserProfileEnvironment['geolocation'], screen: BrowserProfileEnvironment['screen']
  if (row.geolocation !== undefined) {
    const point = record(row.geolocation, ['latitude', 'longitude', 'accuracy'], code, 'Geolocation')
    const latitude = environmentNumber(point.latitude, -90, 90, code, 'Latitude'),
      longitude = environmentNumber(point.longitude, -180, 180, code, 'Longitude'),
      accuracy = environmentNumber(point.accuracy, 0, Number.MAX_VALUE, code, 'Accuracy')
    geolocation = { latitude, longitude, accuracy }
  }
  if (row.screen !== undefined) {
    const size = record(row.screen, ['width', 'height'], code, 'Screen')
    screen = {
      width: environmentInteger(size.width, code, 'Screen width'),
      height: environmentInteger(size.height, code, 'Screen height')
    }
  }
  const hardwareConcurrency =
    row.hardwareConcurrency === undefined
      ? undefined
      : environmentInteger(row.hardwareConcurrency, code, 'Hardware concurrency')
  let userAgentMetadata: BrowserProfileUserAgentMetadata | undefined
  if (row.userAgentMetadata !== undefined) {
    const meta = record(
      row.userAgentMetadata,
      [
        'brands',
        'fullVersionList',
        'platform',
        'platformVersion',
        'architecture',
        'model',
        'mobile',
        'bitness',
        'wow64'
      ],
      code,
      'User agent metadata'
    )
    const scalar = (key: string) => {
      if (typeof meta[key] !== 'string' || meta[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(meta[key] as string))
        fail(code, `User agent metadata ${key} is invalid.`)
      return meta[key] as string
    }
    if (typeof meta.mobile !== 'boolean' || (meta.wow64 !== undefined && typeof meta.wow64 !== 'boolean'))
      fail(code, 'User agent metadata mobile/wow64 must be boolean.')
    const brands = (value: unknown) => {
      if (!Array.isArray(value)) fail(code, 'User agent brands must be a list.')
      return value.map((value) => {
        const brand = record(value, ['brand', 'version'], code, 'User agent brand')
        return {
          brand: text(brand.brand, code, 'Brand', 512),
          version: text(brand.version, code, 'Brand version', 512)
        }
      })
    }
    userAgentMetadata = {
      platform: scalar('platform'),
      platformVersion: scalar('platformVersion'),
      architecture: scalar('architecture'),
      model: scalar('model'),
      mobile: meta.mobile as boolean,
      ...(meta.brands === undefined ? {} : { brands: brands(meta.brands) }),
      ...(meta.fullVersionList === undefined ? {} : { fullVersionList: brands(meta.fullVersionList) }),
      ...(meta.bitness === undefined ? {} : { bitness: scalar('bitness') }),
      ...(meta.wow64 === undefined ? {} : { wow64: meta.wow64 as boolean })
    }
  }
  return {
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(acceptLanguages === undefined ? {} : { acceptLanguages }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
    ...(geolocation ? { geolocation } : {}),
    ...(userAgentMetadata ? { userAgentMetadata } : {}),
    ...(screen ? { screen } : {}),
    ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency })
  }
}
function environmentNumber(value: unknown, min: number, max: number, code: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(code, `${label} is invalid.`)
  return value as number
}
function environmentInteger(value: unknown, code: string, label: string): number {
  const number = environmentNumber(value, 1, 2 ** 31 - 1, code, label)
  if (!Number.isInteger(number)) fail(code, `${label} must be an integer.`)
  return number
}

function environmentPage(value: unknown, code: string): BrowserProfileEnvironmentPageApplication {
  const row = record(value, ['browserId', 'status', 'fields', 'scope', 'reason'], code, 'Page environment application')
  if (!['applied', 'pending', 'unknown'].includes(String(row.status))) fail(code, 'Page environment status is invalid.')
  const fields = record(row.fields, [...BROWSER_PROFILE_ENVIRONMENT_FIELDS], code, 'Page environment fields'),
    scope = record(
      row.scope,
      ['currentDocument', 'futureNavigation', 'subdocuments', 'workers', 'initialScripts'],
      code,
      'Page environment scope'
    )
  if (
    !['applied', 'unknown'].includes(String(scope.currentDocument)) ||
    !['applied', 'unknown'].includes(String(scope.futureNavigation)) ||
    scope.subdocuments !== 'unknown' ||
    scope.workers !== 'unknown' ||
    scope.initialScripts !== 'unknown'
  )
    fail(code, 'Page environment scope is invalid.')
  const parsed: BrowserProfileEnvironmentPageApplication['fields'] = {}
  for (const field of BROWSER_PROFILE_ENVIRONMENT_FIELDS)
    if (fields[field] !== undefined) {
      const fact = record(fields[field], ['status', 'scope', 'reason'], code, 'Native field application')
      if (!['applied', 'unknown'].includes(String(fact.status)) || fact.scope !== 'page-target')
        fail(code, 'Native field application is invalid.')
      parsed[field] = {
        status: fact.status as 'applied' | 'unknown',
        scope: 'page-target',
        ...(fact.reason === undefined ? {} : { reason: text(fact.reason, code, 'Native field reason') })
      }
    }
  return {
    browserId: identity(row.browserId, code, 'Browser ID'),
    status: row.status as BrowserProfileEnvironmentPageApplication['status'],
    fields: parsed,
    scope: scope as BrowserProfileEnvironmentPageApplication['scope'],
    ...(row.reason === undefined ? {} : { reason: text(row.reason, code, 'Page environment reason') })
  }
}
function environmentApplication(value: unknown, code: string): BrowserProfileEnvironmentApplication {
  const row = record(
    value,
    ['status', 'scope', 'userAgent', 'acceptLanguages', 'unsupported', 'reason', 'pages'],
    code,
    'Environment application'
  )
  if (
    !['not-applied', 'applied', 'unknown'].includes(row.status as string) ||
    row.scope !== 'session-defaults' ||
    !Array.isArray(row.unsupported)
  )
    fail(code, 'Environment application is invalid.')
  const settings =
    row.userAgent === undefined && row.acceptLanguages === undefined
      ? {}
      : parseBrowserProfileEnvironment({
          ...(row.userAgent === undefined ? {} : { userAgent: row.userAgent }),
          ...(row.acceptLanguages === undefined ? {} : { acceptLanguages: row.acceptLanguages })
        })
  let pages: BrowserProfileEnvironmentPageApplication[] | undefined
  if (row.pages !== undefined) {
    if (!Array.isArray(row.pages)) fail(code, 'Page environment applications must be a list.')
    pages = row.pages.map((page) => environmentPage(page, code))
    if (new Set(pages.map((page) => page.browserId)).size !== pages.length)
      fail(code, 'Page environment applications duplicate a Browser.')
  }
  return {
    status: row.status as BrowserProfileEnvironmentApplication['status'],
    scope: 'session-defaults',
    ...settings,
    unsupported: row.unsupported.map((item) => text(item, code, 'Unsupported environment field')),
    ...(row.reason === undefined ? {} : { reason: text(row.reason, code, 'Environment application reason') }),
    ...(pages ? { pages } : {})
  }
}
/** Password input is transient; no read operation or receipt returns it. */
export type BrowserProfileProxySignIn = { username: string; password: string }
/** One observation through the original Profile session; failure is unknown and changes no page. */
export type BrowserProfileNetworkCheck =
  | { status: 'reachable'; httpStatus: number; latencyMs: number; ip?: string }
  | { status: 'unknown'; reason: string; latencyMs: number }

/**
 * skippedByReason counts skipped cookies per reason; never cookie names or values. Reason names belong
 * to the Desktop import owner, so Core carries them as opaque keys instead of a copied list. Older
 * imports have no breakdown.
 */
export type BrowserProfileControlSource = { browserLabel: string; profileLabel: string; importedAt: number; importedCookies: number; skippedCookies: number;
  skippedByReason?: Record<string, number> }
/**
 * How a Profile's pages reach the network. Absent follows the system settings. Main parses and
 * applies the route; Core only carries it, and it never holds a password.
 */
export type BrowserProfileControlNetwork =
  | { mode: 'direct' }
  | { mode: 'proxy'; server: { scheme: string; host: string; port: number }; bypass?: string[] }
/** Confirmed native observations only; partial history never means zero unobserved use. */
export type BrowserProfileActivity = { observedRunMs: number; lastUsedAt: number; observedAt: number;
  state: 'running' | 'idle' | 'unknown'; history: 'partial'; interruptions: number }

function activity(value: unknown, code: string): BrowserProfileActivity {
  const row = record(value, ['observedRunMs', 'lastUsedAt', 'observedAt', 'state', 'history', 'interruptions'], code, 'Profile activity')
  if (!['running', 'idle', 'unknown'].includes(row.state as string) || row.history !== 'partial') fail(code, 'Profile activity observation is invalid.')
  return { observedRunMs: count(row.observedRunMs, code, 'Observed Browser time'), lastUsedAt: count(row.lastUsedAt, code, 'Last observed use'),
    observedAt: count(row.observedAt, code, 'Activity observation time'), state: row.state as BrowserProfileActivity['state'], history: 'partial',
    interruptions: count(row.interruptions, code, 'Activity interruptions') }
}

export type BrowserProfileFolder = { id: string; label: string }

/** One Profile as Main lists it. hue is absent when the person chose none. */
export type BrowserProfileControlProfile = {
  id: string; label: string; revision: string; createdAt: number; isDefault: boolean; source: BrowserProfileControlSource | null; hue?: number; notes?: string
  activity?: BrowserProfileActivity
  tags?: string[]
  folderId?: string
  pinned?: true
  network?: BrowserProfileControlNetwork
  proxyBinding?: BrowserProxyBinding
  networkApplication?: BrowserProfileNetworkApplication
  environment?: BrowserProfileEnvironment
  environmentApplication?: BrowserProfileEnvironmentApplication
  /** false when the person turned Agents off for this Profile; absent means Agents may use it. */
  agentAccess?: false
}
/** One Browser that holds the Profile: open has a native owner now, saved restores into it later. */
export type BrowserProfileControlUse = { browserId: string; workspaceId?: string; title: string; url: string; state: 'open' | 'saved' }
/** complete is false when saved Tabs could not be read; browsers then names only open Browsers. */
export type BrowserProfileControlUsage = { browsers: BrowserProfileControlUse[]; complete: boolean; native?: BrowserProfileNativeUse }

export type BrowserProfileControlResult = BrowserProfileCookieFileResult | BrowserProfileBookmarkResult | BrowserProfileExtensionResult
  | { operation: BrowserProfileCreationOperation | 'browser.profile.creation.inspect'; revision: number; creation: BrowserProfileCreationInspection }
  | { operation: 'browser.profile.proxy.ls'; revision: number; proxies: BrowserProxyAsset[] }
  | { operation: 'browser.profile.proxy.update'; revision: number; proxy: BrowserProxyAsset }
  | { operation: 'browser.profile.proxy.delete'; revision: number; proxyId: string; deleted: true }
  | { operation: 'browser.profile.proxy.assign'; revision: number; proxyId: string; proxyRevision: string; results: BrowserProfileBulkItemResult[] }
  | { operation: 'browser.profile.ls'; revision: number; sequence: number; profiles: BrowserProfileControlProfile[]; folders: BrowserProfileFolder[]; views: BrowserProfileView[]; filter?: { query: BrowserProfileQuery; evaluatedAt: number; viewId?: string } }
  | { operation: 'browser.profile.view.update'; revision: number; view: BrowserProfileView }
  | { operation: 'browser.profile.view.delete'; revision: number; viewId: string; deleted: true }
  | { operation: 'browser.profile.bulk-update'; revision: number; results: BrowserProfileBulkItemResult[] }
  | { operation: 'browser.profile.folder.rename'; revision: number; folder: BrowserProfileFolder }
  | { operation: 'browser.profile.folder.delete'; revision: number; folderId: string; deleted: true; unassignedProfileIds: string[] }
  | { operation: 'browser.profile.inspect'; revision: number; sequence: number; profile: BrowserProfileControlProfile; usage: BrowserProfileControlUsage }
  | { operation: 'browser.profile.update'; revision: number; profile: BrowserProfileControlProfile }
  | { operation: 'browser.profile.set-default'; revision: number; profileId: string }
  | ({ operation: 'browser.profile.delete' } & BrowserProfileRecycleReceipt)
  | { operation: 'browser.profile.trash.ls'; revision: number; sequence: number; entries: BrowserProfileTrashEntry[]; legacyPendingDeletes: string[] }
  | ({ operation: 'browser.profile.trash.restore' } & BrowserProfileRestoreReceipt)
  | ({ operation: 'browser.profile.trash.retention' } & BrowserProfileRecycleReceipt)
  | ({ operation: 'browser.profile.trash.purge' } & BrowserProfilePurgeResult)
  | { operation: 'browser.profile.trash.inspect'; revision: number; purge: BrowserProfilePurgeReceipt | null }
  | { operation: 'browser.profile.proxy-sign-in.set'; profileId: string; saved: true; reconnected: boolean }
  | { operation: 'browser.profile.proxy-sign-in.clear'; profileId: string; cleared: true; reconnected: boolean }
  | { operation: 'browser.profile.network.check'; profileId: string; check: BrowserProfileNetworkCheck }
  | ({ operation: 'browser.profile.network.probe'; profileId: string } & BrowserProxyProbeReceipt)
  | ({ operation: 'browser.profile.network.history'; profileId: string } & BrowserProxyProbeHistory)

/** A hue a person can pick: an integer degree on the color wheel. Main also keeps it clear of status colors. */
export const BROWSER_PROFILE_HUE_MAX = 359

export function isBrowserProfileControlOperation(value: unknown): value is BrowserProfileControlOperation {
  return typeof value === 'string' && (BROWSER_PROFILE_CONTROL_OPERATIONS as readonly string[]).includes(value)
}

/** Classifies the request union only; it neither validates data nor grants authority. */
export function isBrowserProfileControlRequest<T extends { operation: string }>(request: T): request is Extract<T, { operation: BrowserProfileControlOperation }> {
  return isBrowserProfileControlOperation(request.operation)
}

export function isBrowserProfileProxySignInWrite(value: string): boolean {
  return value === 'browser.profile.proxy-sign-in.set' || value === 'browser.profile.proxy-sign-in.clear'
}

function fail(code: string, message: string): never { throw new AgentMuxError(message, code) }
function record(value: unknown, keys: readonly string[], code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code, `${label} is invalid.`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !('value' in descriptor)) fail(code, `${label} fields are invalid.`)
  }
  return value as Record<string, unknown>
}
function text(value: unknown, code: string, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.includes('\0') || new TextEncoder().encode(value).byteLength > max) fail(code, `${label} is invalid.`)
  return value
}
function identity(value: unknown, code: string, label: string): string {
  const result = text(value, code, label)
  if (!result.trim() || result === 'self' || /[\r\n]/u.test(result)) fail(code, `${label} is invalid.`)
  return result
}
function count(value: unknown, code: string, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code, `${label} is invalid.`)
  return value as number
}
function hue(value: unknown, code: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > BROWSER_PROFILE_HUE_MAX) fail(code, `Browser Profile hue must be an integer from 0 to ${BROWSER_PROFILE_HUE_MAX}.`)
  return value as number
}

/** Fixed validation messages never echo secret input, including unknown field names. */
export function parseBrowserProfileProxySignIn(value: unknown): BrowserProfileProxySignIn {
  const code = 'INVALID_CONTROL_REQUEST'
  const row = record(value, ['username', 'password'], code, 'Proxy sign-in')
  if (typeof row.username !== 'string' || !row.username.trim() || row.username.length > 256 || row.username.includes('\0') ||
      typeof row.password !== 'string' || !row.password || row.password.length > 1024 || row.password.includes('\0')) {
    fail(code, 'Proxy sign-in requires a user name and password within the supported lengths.')
  }
  return { username: row.username, password: row.password }
}

/** Request payload after the Control envelope fields; one owner for both the CLI params and the wire request. */
export function parseBrowserProfileControlPayload(source: Record<string, unknown>, envelope: readonly string[]): BrowserProfileControlPayload {
  if (isBrowserProfileCookieFileOperation(source.operation)) return parseBrowserProfileCookieFilePayload(source)
  if (isBrowserProfileBookmarkOperation(source.operation)) return parseBrowserProfileBookmarkPayload(source)
  if (isBrowserProfileExtensionOperation(source.operation)) return parseBrowserProfileExtensionPayload(source)
  const code = 'INVALID_CONTROL_REQUEST'
  if (!isBrowserProfileControlOperation(source.operation)) fail(code, 'Browser Profile operation is invalid.')
  const operation = source.operation as Exclude<BrowserProfileControlOperation, BrowserProfileExtensionOperation | BrowserProfileBookmarkOperation | BrowserProfileCookieFileOperation>
  const fields: Record<Exclude<BrowserProfileControlOperation, BrowserProfileExtensionOperation | BrowserProfileBookmarkOperation | BrowserProfileCookieFileOperation>, readonly string[]> = {
    'browser.profile.creation.inspect': ['operationId'], 'browser.profile.proxy.ls': [], 'browser.profile.proxy.create': ['operationId', 'edit'], 'browser.profile.proxy.update': ['proxyId', 'expectedRevision', 'edit'],
    'browser.profile.proxy.delete': ['proxyId', 'expectedRevision'], 'browser.profile.proxy.assign': ['proxyId', 'expectedRevision', 'items'],
    'browser.profile.ls': ['query', 'viewId'],
    'browser.profile.view.create': ['operationId', 'label', 'query', 'expectedRevision'], 'browser.profile.view.update': ['viewId', 'label', 'query', 'expectedRevision'], 'browser.profile.view.delete': ['viewId', 'expectedRevision'], 'browser.profile.bulk-update': ['items', 'action'], 'browser.profile.folder.create': ['operationId', 'label', 'expectedRevision'],
    'browser.profile.folder.rename': ['folderId', 'label', 'expectedRevision'], 'browser.profile.folder.delete': ['folderId', 'expectedRevision'], 'browser.profile.inspect': ['profileId'], 'browser.profile.create': ['operationId', 'label'], 'browser.profile.copy': ['operationId', 'profileId', 'expectedRevision', 'label'],
    'browser.profile.update': ['profileId', 'expectedRevision', 'edit'], 'browser.profile.set-default': ['profileId'], 'browser.profile.delete': ['profileId', 'expectedRevision'], 'browser.profile.trash.ls': [], 'browser.profile.trash.restore': ['archiveId', 'expectedRevision', 'folderId'],
    'browser.profile.trash.retention': ['archiveId', 'expectedRevision', 'purgeId', 'deleteAfter'], 'browser.profile.trash.purge': ['archiveId', 'expectedRevision', 'purgeId'], 'browser.profile.trash.inspect': ['purgeId'],
    'browser.profile.proxy-sign-in.set': ['profileId', 'signIn'], 'browser.profile.proxy-sign-in.clear': ['profileId'], 'browser.profile.network.check': ['profileId'], 'browser.profile.network.probe': ['profileId', 'operationId'], 'browser.profile.network.history': ['profileId', 'operationId', 'before']
  }
  record(source, [...envelope, ...fields[operation]], code, 'Browser Profile request')
  for (const key of fields[operation]) if (operation !== 'browser.profile.ls' && !(operation === 'browser.profile.trash.restore' && key === 'folderId') && !(operation === 'browser.profile.network.history' && key !== 'profileId') && !Object.hasOwn(source, key)) fail(code, `Browser Profile ${key} is required.`)
  const creationOperationId = isBrowserProfileCreationOperation(operation) || operation === 'browser.profile.creation.inspect' ? browserProfileCreationOperationId(source.operationId) : undefined
  switch (operation) {
    case 'browser.profile.creation.inspect': return { operation, operationId: creationOperationId! }
    case 'browser.profile.network.probe': return { operation, profileId: identity(source.profileId, code, 'Profile ID'), operationId: identity(source.operationId, code, 'Diagnostic operation ID') }
    case 'browser.profile.network.history':
      if (source.operationId !== undefined && source.before !== undefined) fail(code, 'Read an exact diagnostic or a history cursor, not both.')
      return { operation, profileId: identity(source.profileId, code, 'Profile ID'), ...(source.operationId === undefined ? {} : { operationId: identity(source.operationId, code, 'Diagnostic operation ID') }), ...(source.before === undefined ? {} : { before: identity(source.before, code, 'Diagnostic history cursor') }) }
    case 'browser.profile.proxy.ls': return { operation }
    case 'browser.profile.proxy.create': return { operation, operationId: creationOperationId!, edit: parseBrowserProxyEdit(source.edit) }
    case 'browser.profile.proxy.update': return { operation, proxyId: identity(source.proxyId, code, 'Proxy ID'), expectedRevision: identity(source.expectedRevision, code, 'Proxy configuration token'), edit: parseBrowserProxyEdit(source.edit) }
    case 'browser.profile.proxy.delete': return { operation, proxyId: identity(source.proxyId, code, 'Proxy ID'), expectedRevision: identity(source.expectedRevision, code, 'Proxy configuration token') }
    case 'browser.profile.proxy.assign': return { operation, proxyId: identity(source.proxyId, code, 'Proxy ID'), expectedRevision: identity(source.expectedRevision, code, 'Proxy configuration token'), items: parseBrowserProfileSelection(source.items) }
    case 'browser.profile.delete': return { operation, profileId: identity(source.profileId, code, 'Profile ID'), expectedRevision: identity(source.expectedRevision, code, 'Expected Profile configuration revision') }
    case 'browser.profile.trash.ls': return { operation }
    case 'browser.profile.trash.inspect': return { operation, purgeId: identity(source.purgeId, code, 'Original purge ID') }
    case 'browser.profile.trash.purge': case 'browser.profile.trash.retention': {
      const target = { archiveId: identity(source.archiveId, code, 'Archive ID'), expectedRevision: identity(source.expectedRevision, code, 'Archive revision'), purgeId: identity(source.purgeId, code, 'Original purge ID') }
      return operation === 'browser.profile.trash.purge' ? { operation, ...target } : { operation, ...target, deleteAfter: source.deleteAfter === null ? null : count(source.deleteAfter, code, 'Retention deadline') }
    }
    case 'browser.profile.trash.restore': return { operation, archiveId: identity(source.archiveId, code, 'Archived entry ID'), expectedRevision: identity(source.expectedRevision, code, 'Expected archive revision'),
      ...(source.folderId === undefined ? {} : { folderId: source.folderId === null ? null : identity(source.folderId, code, 'Restored folder ID') }) }
    case 'browser.profile.proxy-sign-in.set': return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), signIn: parseBrowserProfileProxySignIn(source.signIn) }
    case 'browser.profile.folder.create': case 'browser.profile.folder.rename': {
      const label = text(source.label, code, 'Folder name', 512)
      if (!label.trim()) fail(code, 'A folder name is required.')
      const expectedRevision = count(source.expectedRevision, code, 'Expected Browser Profile list revision')
      return operation === 'browser.profile.folder.rename' ? { operation, label, expectedRevision, folderId: identity(source.folderId, code, 'Folder ID') }
        : { operation, label, expectedRevision, operationId: creationOperationId! }
    }
    case 'browser.profile.folder.delete': return { operation, folderId: identity(source.folderId, code, 'Folder ID'), expectedRevision: count(source.expectedRevision, code, 'Expected Browser Profile list revision') }
    case 'browser.profile.ls':
      if (source.query !== undefined && source.viewId !== undefined) fail(code, 'Choose an exact saved view or a query, not both.')
      return { operation, ...(source.query === undefined ? {} : { query: parseBrowserProfileQuery(source.query) }), ...(source.viewId === undefined ? {} : { viewId: identity(source.viewId, code, 'Saved view ID') }) }
    case 'browser.profile.view.create': case 'browser.profile.view.update': {
      const label = text(source.label, code, 'View name', 128)
      if (!label.trim() || label !== label.trim()) fail(code, 'A view needs a name without surrounding whitespace.')
      return { operation, label, query: parseBrowserProfileQuery(source.query), expectedRevision: count(source.expectedRevision, code, 'Expected configuration collection revision'),
        ...(operation === 'browser.profile.view.create' ? { operationId: creationOperationId! } : {}),
        ...(operation === 'browser.profile.view.update' ? { viewId: identity(source.viewId, code, 'Saved view ID') } : {}) } as BrowserProfileControlPayload
    }
    case 'browser.profile.view.delete': return { operation, viewId: identity(source.viewId, code, 'Saved view ID'), expectedRevision: count(source.expectedRevision, code, 'Expected configuration collection revision') }
    case 'browser.profile.bulk-update': return { operation, items: parseBrowserProfileSelection(source.items), action: parseBrowserProfileBulkAction(source.action) }
    case 'browser.profile.copy': {
      const label = text(source.label, code, 'Browser Profile label', 512)
      if (!label.trim()) fail(code, 'Browser Profile label is required.')
      return { operation, operationId: creationOperationId!, profileId: identity(source.profileId, code, 'Browser Profile ID'), expectedRevision: identity(source.expectedRevision, code, 'Expected Profile configuration revision'), label }
    }
    case 'browser.profile.create': {
      const label = text(source.label, code, 'Browser Profile label', 512)
      if (!label.trim()) fail(code, 'Browser Profile label is required.')
      return { operation, operationId: creationOperationId!, label }
    }
    case 'browser.profile.update': {
      const edit = record(source.edit, ['label', 'hue', 'notes', 'network', 'environment', 'tags', 'folderId', 'pinned'], code, 'Browser Profile edit')
      if (edit.pinned !== undefined && typeof edit.pinned !== 'boolean') fail(code, 'Profile pinned must be on or off.')
      if (!Object.keys(edit).length) fail(code, 'Browser Profile edit names no field.')
      return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), expectedRevision: identity(source.expectedRevision, code, 'Expected Profile configuration revision'),
        edit: { ...(edit.label === undefined ? {} : { label: text(edit.label, code, 'Browser Profile label', 512) }),
          ...(edit.hue === undefined ? {} : { hue: edit.hue === null ? null : hue(edit.hue, code) }),
          ...(edit.notes === undefined ? {} : { notes: text(edit.notes, code, 'Browser Profile notes', 8192) }),
          ...(edit.tags === undefined ? {} : { tags: tags(edit.tags, code) }),
          ...(edit.folderId === undefined ? {} : { folderId: edit.folderId === null ? null : identity(edit.folderId, code, 'Folder ID') }),
          ...(edit.pinned === undefined ? {} : { pinned: edit.pinned as boolean }),
          ...(edit.network === undefined ? {} : { network: networkEdit(edit.network, code) }),
          ...(edit.environment === undefined ? {} : { environment: edit.environment === null ? null : parseBrowserProfileEnvironment(edit.environment) }) } }
    }
    default: return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID') }
  }
}

function skipCounts(value: unknown, code: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code, 'Skipped cookie reasons are invalid.')
  const keys = Reflect.ownKeys(value)
  if (keys.length > 64) fail(code, 'Skipped cookie reasons are invalid.')
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) fail(code, 'Skipped cookie reasons are invalid.')
    return [identity(key, code, 'Skipped cookie reason'), count(descriptor.value, code, 'Skipped cookie count')]
  }))
}

/** The route a request asks for; only its shape is checked here, and Main parses the server line. */
function networkEdit(value: unknown, code: string): NonNullable<BrowserProfileControlEdit['network']> {
  const route = record(value, ['mode', 'server', 'bypass'], code, 'Browser Profile network')
  if ((route.mode === 'system' || route.mode === 'direct') && route.server === undefined && route.bypass === undefined) return { mode: route.mode }
  if (route.mode !== 'proxy') fail(code, 'Browser Profile network mode is system, direct or proxy.')
  const server = text(route.server, code, 'Proxy server', 512)
  if (!server.trim()) fail(code, 'A proxy route needs a server, for example proxy.example.com:8080.')
  const bypass = route.bypass === undefined ? undefined : Array.isArray(route.bypass) && route.bypass.length <= 64
    ? route.bypass.map(rule => text(rule, code, 'Don’t proxy entry', 253))
    : fail(code, 'Don’t proxy entries are invalid.')
  return { mode: 'proxy', server, ...(bypass ? { bypass } : {}) }
}

function network(value: unknown, code: string): BrowserProfileControlNetwork {
  const route = record(value, ['mode', 'server', 'bypass'], code, 'Browser Profile network')
  if (route.mode === 'direct' && route.server === undefined && route.bypass === undefined) return { mode: 'direct' }
  if (route.mode !== 'proxy') fail(code, 'Browser Profile network mode is invalid.')
  const server = record(route.server, ['scheme', 'host', 'port'], code, 'Browser Profile proxy server')
  const port = count(server.port, code, 'Proxy port')
  if (port < 1 || port > 65535) fail(code, 'Proxy port is invalid.')
  const bypass = route.bypass === undefined ? undefined : Array.isArray(route.bypass) && route.bypass.length <= 64
    ? route.bypass.map(rule => text(rule, code, 'Don’t proxy entry', 253))
    : fail(code, 'Don’t proxy entries are invalid.')
  return { mode: 'proxy', server: { scheme: text(server.scheme, code, 'Proxy scheme', 16), host: text(server.host, code, 'Proxy host', 255), port },
    ...(bypass ? { bypass } : {}) }
}

function profile(value: unknown, code: string): BrowserProfileControlProfile {
  const row = record(value, ['id', 'label', 'revision', 'createdAt', 'isDefault', 'source', 'hue', 'notes', 'network', 'agentAccess', 'environment', 'environmentApplication', 'tags', 'folderId', 'pinned', 'activity', 'proxyBinding', 'networkApplication'], code, 'Browser Profile')
  const canonicalTags = row.tags === undefined ? undefined : tags(row.tags, code)
  if (canonicalTags && JSON.stringify(canonicalTags) !== JSON.stringify(row.tags)) fail(code, 'Stored Profile tags are not canonical.')
  if (row.pinned !== undefined && row.pinned !== true) fail(code, 'Stored Profile pinned flag is invalid.')
  if (row.agentAccess !== undefined && row.agentAccess !== false) fail(code, 'Browser Profile Agent access is invalid.')
  if (typeof row.isDefault !== 'boolean') fail(code, 'Browser Profile default flag is invalid.')
  const source = row.source === null ? null : (() => {
    const imported = record(row.source, ['browserLabel', 'profileLabel', 'importedAt', 'importedCookies', 'skippedCookies', 'skippedByReason'], code, 'Browser Profile source')
    return { browserLabel: text(imported.browserLabel, code, 'Imported browser'), profileLabel: text(imported.profileLabel, code, 'Imported profile'),
      importedAt: count(imported.importedAt, code, 'Import time'), importedCookies: count(imported.importedCookies, code, 'Imported cookies'), skippedCookies: count(imported.skippedCookies, code, 'Skipped cookies'),
      ...(imported.skippedByReason === undefined ? {} : { skippedByReason: skipCounts(imported.skippedByReason, code) }) }
  })()
  return { id: identity(row.id, code, 'Browser Profile ID'), revision: identity(row.revision, code, 'Profile configuration revision'), label: text(row.label, code, 'Browser Profile label'), createdAt: count(row.createdAt, code, 'Browser Profile creation time'),
    isDefault: row.isDefault, source, ...(row.activity === undefined ? {} : { activity: activity(row.activity, code) }), ...(canonicalTags === undefined ? {} : { tags: canonicalTags }),
    ...(row.folderId === undefined ? {} : { folderId: identity(row.folderId, code, 'Folder ID') }),
    ...(row.pinned === true ? { pinned: true as const } : {}), ...(row.hue === undefined ? {} : { hue: hue(row.hue, code) }),
    ...(row.notes === undefined ? {} : { notes: text(row.notes, code, 'Browser Profile notes', 8192) }),
    ...(row.network === undefined ? {} : { network: network(row.network, code) }),
    ...(row.proxyBinding === undefined ? {} : { proxyBinding: parseBrowserProxyBinding(row.proxyBinding, code) }),
    ...(row.networkApplication === undefined ? {} : { networkApplication: parseBrowserProfileNetworkApplication(row.networkApplication, code) }),
    ...(row.environment === undefined ? {} : { environment: parseBrowserProfileEnvironment(row.environment) }),
    ...(row.environmentApplication === undefined ? {} : { environmentApplication: environmentApplication(row.environmentApplication, code) }),
    ...(row.agentAccess === false ? { agentAccess: false as const } : {}) }
}
function usage(value: unknown, code: string): BrowserProfileControlUsage {
  const row = record(value, ['browsers', 'complete', 'native'], code, 'Browser Profile usage')
  if (typeof row.complete !== 'boolean' || !Array.isArray(row.browsers)) fail(code, 'Browser Profile usage is invalid.')
  return { complete: row.complete, ...(row.native === undefined ? {} : { native: nativeUse(row.native, code) }), browsers: row.browsers.map(item => {
    const use = record(item, ['browserId', 'workspaceId', 'title', 'url', 'state'], code, 'Browser Profile use')
    if (use.state !== 'open' && use.state !== 'saved') fail(code, 'Browser Profile use state is invalid.')
    return { browserId: identity(use.browserId, code, 'Browser ID'), ...(use.workspaceId === undefined ? {} : { workspaceId: identity(use.workspaceId, code, 'Workspace ID') }),
      title: text(use.title, code, 'Browser title'), url: text(use.url, code, 'Browser URL', 64 * 1024), state: use.state }
  }) }
}

function nativeUse(value: unknown, code: string): BrowserProfileNativeUse {
  const row = record(value, ['status', 'pages', 'workers', 'requests', 'downloads', 'reason'], code, 'Native Profile usage')
  if (!['idle', 'in-use', 'unknown'].includes(row.status as string)) fail(code, 'Native Profile usage status is invalid.')
  const pages = row.pages === null ? null : count(row.pages, code, 'Native pages')
  const workers = row.workers === null ? null : count(row.workers, code, 'Native workers'), requests = row.requests === null ? null : count(row.requests, code, 'Native requests'), downloads = row.downloads === null ? null : count(row.downloads, code, 'Native downloads')
  if (row.status === 'idle' && (pages !== 0 || workers !== 0 || requests !== 0 || downloads !== 0)) fail(code, 'Unknown or occupied native Profile cannot be idle.')
  return { status: row.status as BrowserProfileNativeUse['status'], pages, workers, requests, downloads,
    ...(row.reason === undefined ? {} : { reason: text(row.reason, code, 'Native usage reason') }) }
}
function retention(value: unknown, code: string): NonNullable<BrowserProfileTrashEntry['retention']> {
  const row = record(value, ['purgeId', 'deleteAfter', 'approvedAt'], code, 'Approved retention')
  const approvedAt = count(row.approvedAt, code, 'Retention approval time'), deleteAfter = count(row.deleteAfter, code, 'Retention deadline')
  if (deleteAfter <= approvedAt) fail(code, 'Retention deadline must follow its approval.')
  return { purgeId: identity(row.purgeId, code, 'Retention purge ID'), approvedAt, deleteAfter }
}
function purgeReceipt(value: unknown, code: string): BrowserProfilePurgeReceipt {
  const row = record(value, ['purgeId', 'archiveId', 'profileId', 'status', 'requestedAt', 'updatedAt', 'warning', 'credentialCleanup', 'permissionCleanup'], code, 'Original purge receipt')
  if (!['waiting-for-restart', 'preparing', 'deleting-data', 'erasing-backup', 'failed', 'unknown', 'deleted', 'restored'].includes(row.status as string)) fail(code, 'Purge stage is invalid.')
  for (const key of ['credentialCleanup', 'permissionCleanup'] as const) if (row[key] !== undefined && !['pending', 'confirmed', 'unknown'].includes(row[key] as string)) fail(code, 'Independent cleanup receipt is invalid.')
  return { purgeId: identity(row.purgeId, code, 'Original purge ID'), archiveId: identity(row.archiveId, code, 'Archive ID'), profileId: identity(row.profileId, code, 'Profile ID'), status: row.status as BrowserProfilePurgeReceipt['status'],
    requestedAt: count(row.requestedAt, code, 'Purge request time'), updatedAt: count(row.updatedAt, code, 'Purge observation time'), ...(row.warning === undefined ? {} : { warning: text(row.warning, code, 'Purge warning') }), ...(row.credentialCleanup === undefined ? {} : { credentialCleanup: row.credentialCleanup as NonNullable<BrowserProfilePurgeReceipt['credentialCleanup']> }), ...(row.permissionCleanup === undefined ? {} : { permissionCleanup: row.permissionCleanup as NonNullable<BrowserProfilePurgeReceipt['permissionCleanup']> }) }
}

function archived(value: unknown, code: string): BrowserProfileTrashEntry {
  const row = record(value, ['id', 'revision', 'archivedAt', 'profile', 'dataOwner', 'retention', 'purge'], code, 'Archived Profile')
  const original = profile(row.profile, code)
  if (row.dataOwner !== 'original-partition' || original.isDefault || row.id === original.id) fail(code, 'Archived Profile data owner or identity is invalid.')
  const purge = row.purge === undefined ? undefined : purgeReceipt(row.purge, code)
  if (purge && (purge.archiveId !== row.id || purge.profileId !== original.id || purge.status === 'deleted' || purge.status === 'restored')) fail(code, 'Purge belongs to another archived identity or a completed action.')
  return { id: identity(row.id, code, 'Archive entry ID'), revision: identity(row.revision, code, 'Archive revision'), archivedAt: count(row.archivedAt, code, 'Archive time'), profile: original, dataOwner: 'original-partition',
    ...(row.retention === undefined ? {} : { retention: retention(row.retention, code) }), ...(purge === undefined ? {} : { purge }) }
}

function folder(value: unknown, code: string): BrowserProfileFolder {
  const row = record(value, ['id', 'label'], code, 'Profile folder'), label = text(row.label, code, 'Folder name', 512)
  if (!label.trim() || label !== label.trim() || label.length > 128) fail(code, 'Folder name is invalid.')
  return { id: identity(row.id, code, 'Folder ID'), label }
}

/** Owner result body, without the operation key. Exactly one Profile is default in every list. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type BrowserProfileControlResultBody = OmitEach<BrowserProfileControlResult, 'operation'>
export function parseBrowserProfileControlResult(operation: BrowserProfileControlOperation, value: unknown): BrowserProfileControlResultBody {
  if (isBrowserProfileCookieFileOperation(operation)) { const { operation: _operation, ...body } = parseBrowserProfileCookieFileResult(operation, value); return body }
  if (isBrowserProfileBookmarkOperation(operation)) { const { operation: _operation, ...body } = parseBrowserProfileBookmarkResult(operation, value); return body }
  if (isBrowserProfileExtensionOperation(operation)) { const { operation: _operation, ...body } = parseBrowserProfileExtensionResult(operation, value); return body }
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (isBrowserProfileCreationOperation(operation) || operation === 'browser.profile.creation.inspect') {
    const p = record(value, ['revision','creation'], code, 'Profile creation result')
    return { revision: count(p.revision, code, 'Profile collection revision'), creation: parseBrowserProfileCreationInspection(p.creation, code) }
  }
  const keys: Record<Exclude<BrowserProfileControlOperation, BrowserProfileExtensionOperation | BrowserProfileBookmarkOperation | BrowserProfileCookieFileOperation>, readonly string[]> = {
    'browser.profile.creation.inspect': ['revision','creation'], 'browser.profile.proxy.ls': ['revision', 'proxies'], 'browser.profile.proxy.create': ['revision', 'proxy'], 'browser.profile.proxy.update': ['revision', 'proxy'],
    'browser.profile.proxy.delete': ['revision', 'proxyId', 'deleted'], 'browser.profile.proxy.assign': ['revision', 'proxyId', 'proxyRevision', 'results'],
    'browser.profile.ls': ['revision', 'sequence', 'profiles', 'folders', 'views', 'filter'],
    'browser.profile.view.create': ['revision', 'view'], 'browser.profile.view.update': ['revision', 'view'], 'browser.profile.view.delete': ['revision', 'viewId', 'deleted'], 'browser.profile.bulk-update': ['revision', 'results'],
    'browser.profile.folder.create': ['revision', 'folder'], 'browser.profile.folder.rename': ['revision', 'folder'],
    'browser.profile.folder.delete': ['revision', 'folderId', 'deleted', 'unassignedProfileIds'], 'browser.profile.inspect': ['revision', 'sequence', 'profile', 'usage'],
    'browser.profile.create': ['revision', 'profile'], 'browser.profile.copy': ['revision', 'sourceProfileId', 'profile'], 'browser.profile.update': ['revision', 'profile'],
    'browser.profile.set-default': ['revision', 'profileId'], 'browser.profile.delete': ['revision', 'archive'], 'browser.profile.trash.ls': ['revision', 'sequence', 'entries', 'legacyPendingDeletes'], 'browser.profile.trash.restore': ['revision', 'archiveId', 'profile'],
    'browser.profile.trash.retention': ['revision', 'archive'], 'browser.profile.trash.purge': ['revision', 'purge'], 'browser.profile.trash.inspect': ['revision', 'purge'],
    'browser.profile.proxy-sign-in.set': ['profileId', 'saved', 'reconnected'], 'browser.profile.proxy-sign-in.clear': ['profileId', 'cleared', 'reconnected'],
    'browser.profile.network.check': ['profileId', 'check'], 'browser.profile.network.probe': ['profileId', 'diagnostic', 'historySaved'], 'browser.profile.network.history': ['profileId', 'diagnostics', 'nextCursor']
  }
  const row = record(value, keys[operation], code, 'Browser Profile result')
  for (const key of keys[operation]) if (key !== 'filter' && !Object.hasOwn(row, key)) fail(code, `Browser Profile result ${key} is required.`)
  if (operation === 'browser.profile.proxy-sign-in.set') {
    if (row.saved !== true || typeof row.reconnected !== 'boolean') fail(code, 'Proxy sign-in save receipt is invalid.')
    return { profileId: identity(row.profileId, code, 'Browser Profile ID'), saved: true, reconnected: row.reconnected }
  }
  if (operation === 'browser.profile.proxy-sign-in.clear') {
    if (row.cleared !== true || typeof row.reconnected !== 'boolean') fail(code, 'Proxy sign-in clear receipt is invalid.')
    return { profileId: identity(row.profileId, code, 'Browser Profile ID'), cleared: true, reconnected: row.reconnected }
  }
  if (operation === 'browser.profile.network.probe') {
    const profileId = identity(row.profileId, code, 'Profile ID'), diagnostic = parseBrowserProxyProbe(row.diagnostic, code)
    if (typeof row.historySaved !== 'boolean' || diagnostic.profileId !== profileId) fail(code, 'Diagnostic Profile binding is invalid.')
    return { profileId, diagnostic, historySaved: row.historySaved }
  }
  if (operation === 'browser.profile.network.history') {
    const profileId = identity(row.profileId, code, 'Profile ID')
    if (!Array.isArray(row.diagnostics) || row.diagnostics.length > 20) fail(code, 'Diagnostic history page is invalid.')
    const diagnostics = row.diagnostics.map(item => parseBrowserProxyProbe(item, code))
    if (diagnostics.some(item => item.profileId !== profileId) || new Set(diagnostics.map(item => item.id)).size !== diagnostics.length) fail(code, 'Diagnostic history bindings are invalid.')
    const nextCursor = row.nextCursor === null ? null : identity(row.nextCursor, code, 'Diagnostic history cursor')
    if (nextCursor !== null && nextCursor !== diagnostics.at(-1)?.id) fail(code, 'Diagnostic cursor must name the last original item in this page.')
    return { profileId, diagnostics, nextCursor }
  }
  if (operation === 'browser.profile.network.check') {
    const check = record(row.check, ['status', 'httpStatus', 'latencyMs', 'ip', 'reason'], code, 'Profile network check')
    if (typeof check.latencyMs !== 'number' || !Number.isFinite(check.latencyMs) || check.latencyMs < 0) fail(code, 'Profile network check latency is invalid.')
    const profileId = identity(row.profileId, code, 'Browser Profile ID')
    if (check.status === 'reachable' && check.reason === undefined) {
      const httpStatus = count(check.httpStatus, code, 'Network check HTTP status')
      if (httpStatus < 100 || httpStatus > 599) fail(code, 'Network check HTTP status is invalid.')
      return { profileId, check: { status: 'reachable', httpStatus, latencyMs: check.latencyMs,
        ...(check.ip === undefined ? {} : { ip: text(check.ip, code, 'Network check address', 256) }) } }
    }
    if (check.status === 'unknown' && check.httpStatus === undefined && check.ip === undefined) {
      return { profileId, check: { status: 'unknown', reason: text(check.reason, code, 'Network check reason'), latencyMs: check.latencyMs } }
    }
    fail(code, 'Profile network check is invalid.')
  }
  const revision = count(row.revision, code, 'Browser Profile revision')
  if (operation === 'browser.profile.proxy.ls') {
    if (!Array.isArray(row.proxies)) fail(code, 'Proxy library is invalid.')
    const proxies = row.proxies.map(value => parseBrowserProxyAsset(value, code))
    if (new Set(proxies.map(proxy => proxy.id)).size !== proxies.length) fail(code, 'Proxy identities are duplicated.')
    return { revision, proxies }
  }
  if (operation === 'browser.profile.proxy.update') return { revision, proxy: parseBrowserProxyAsset(row.proxy, code) }
  if (operation === 'browser.profile.proxy.delete') {
    if (row.deleted !== true) fail(code, 'Proxy removal is unconfirmed.')
    return { revision, proxyId: identity(row.proxyId, code, 'Proxy ID'), deleted: true }
  }
  if (operation === 'browser.profile.proxy.assign') {
    const parsed = parseBrowserProfileControlResult('browser.profile.bulk-update', { revision, results: row.results })
    if (!('results' in parsed)) fail(code, 'Proxy assignment results are invalid.')
    return { revision, proxyId: identity(row.proxyId, code, 'Proxy ID'), proxyRevision: identity(row.proxyRevision, code, 'Assigned proxy configuration token'), results: parsed.results }
  }
  switch (operation) {
    case 'browser.profile.ls': {
      if (!Array.isArray(row.profiles)) fail(code, 'Browser Profile list is invalid.')
      const profiles = row.profiles.map(item => profile(item, code))
      if (new Set(profiles.map(item => item.id)).size !== profiles.length || (row.filter ? profiles.filter(item => item.isDefault).length > 1 : profiles.filter(item => item.isDefault).length !== 1)) fail(code, 'Browser Profile list is inconsistent.')
      if (!Array.isArray(row.folders)) fail(code, 'Profile folders are invalid.')
      const folders = row.folders.map(item => folder(item, code)), folderIds = new Set(folders.map(item => item.id))
      if (folderIds.size !== folders.length || profiles.some(item => item.folderId !== undefined && !folderIds.has(item.folderId))) fail(code, 'Profile folder references are inconsistent.')
      if (!Array.isArray(row.views)) fail(code, 'Saved Profile views are invalid.')
      const views = row.views.map(item => parseBrowserProfileView(item, code))
      if (new Set(views.map(view => view.id)).size !== views.length) fail(code, 'Saved view identities are duplicated.')
      let filter: { query: BrowserProfileQuery; evaluatedAt: number; viewId?: string } | undefined
      if (row.filter !== undefined) {
        const selected = record(row.filter, ['query', 'evaluatedAt', 'viewId'], code, 'Profile query scope')
        filter = { query: parseBrowserProfileQuery(selected.query, code), evaluatedAt: count(selected.evaluatedAt, code, 'Profile query time'),
          ...(selected.viewId === undefined ? {} : { viewId: identity(selected.viewId, code, 'Saved view ID') }) }
      }
      return { revision, sequence: count(row.sequence, code, 'Profile snapshot sequence'), profiles, folders, views, ...(filter ? { filter } : {}) }
    }
    case 'browser.profile.view.update': return { revision, view: parseBrowserProfileView(row.view, code) }
    case 'browser.profile.view.delete':
      if (row.deleted !== true) fail(code, 'Saved view deletion is unconfirmed.')
      return { revision, viewId: identity(row.viewId, code, 'Saved view ID'), deleted: true }
    case 'browser.profile.bulk-update': {
      if (!Array.isArray(row.results) || !row.results.length) fail(code, 'Bulk Profile results are missing.')
      const results: BrowserProfileBulkItemResult[] = row.results.map(value => {
        const item = record(value, ['profileId', 'expectedRevision', 'outcome', 'profile', 'code', 'message'], code, 'Bulk Profile result')
        const target = { profileId: identity(item.profileId, code, 'Profile ID'), expectedRevision: identity(item.expectedRevision, code, 'Input configuration token') }
        if (item.outcome === 'updated' && item.code === undefined && item.message === undefined) {
          const updated = profile(item.profile, code)
          if (updated.id !== target.profileId) fail(code, 'Bulk item returned a different Profile.')
          return { ...target, outcome: 'updated', profile: updated }
        }
        if (item.outcome === 'failed' && item.profile === undefined) return { ...target, outcome: 'failed', code: identity(item.code, code, 'Failure code'), message: text(item.message, code, 'Failure reason') }
        return fail(code, 'Bulk Profile result outcome is invalid.')
      })
      if (new Set(results.map(item => item.profileId)).size !== results.length) fail(code, 'Bulk Profile result identities are duplicated.')
      return { revision, results }
    }
    case 'browser.profile.folder.rename': return { revision, folder: folder(row.folder, code) }
    case 'browser.profile.folder.delete': {
      if (row.deleted !== true || !Array.isArray(row.unassignedProfileIds)) fail(code, 'Folder deletion receipt is invalid.')
      const ids = row.unassignedProfileIds.map(item => identity(item, code, 'Unassigned Profile ID'))
      if (new Set(ids).size !== ids.length) fail(code, 'Unassigned Profile identities are duplicated.')
      return { revision, folderId: identity(row.folderId, code, 'Folder ID'), deleted: true, unassignedProfileIds: ids }
    }
    case 'browser.profile.inspect': return { revision, sequence: count(row.sequence, code, 'Profile snapshot sequence'), profile: profile(row.profile, code), usage: usage(row.usage, code) }
    case 'browser.profile.update': return { revision, profile: profile(row.profile, code) }
    case 'browser.profile.set-default': return { revision, profileId: identity(row.profileId, code, 'Browser Profile ID') }
    case 'browser.profile.delete': return { revision, archive: archived(row.archive, code) }
    case 'browser.profile.trash.retention': return { revision, archive: archived(row.archive, code) }
    case 'browser.profile.trash.purge': return { revision, purge: purgeReceipt(row.purge, code) }
    case 'browser.profile.trash.inspect': return { revision, purge: row.purge === null ? null : purgeReceipt(row.purge, code) }
    case 'browser.profile.trash.restore': return { revision, archiveId: identity(row.archiveId, code, 'Archive entry ID'), profile: profile(row.profile, code) }
    case 'browser.profile.trash.ls': {
      if (!Array.isArray(row.entries)) fail(code, 'Archived Profile list is invalid.')
      const entries = row.entries.map(value => archived(value, code))
      if (new Set(entries.map(entry => entry.id)).size !== entries.length || new Set(entries.map(entry => entry.profile.id)).size !== entries.length) fail(code, 'Archived Profile list duplicates an identity.')
      if (!Array.isArray(row.legacyPendingDeletes)) fail(code, 'Legacy cleanup identities are invalid.')
      const legacyPendingDeletes = row.legacyPendingDeletes.map(value => identity(value, code, 'Legacy cleanup Profile ID'))
      if (new Set(legacyPendingDeletes).size !== legacyPendingDeletes.length || legacyPendingDeletes.some(id => entries.some(entry => entry.profile.id === id))) fail(code, 'Legacy cleanup identities conflict.')
      return { revision, sequence: count(row.sequence, code, 'Profile snapshot sequence'), entries, legacyPendingDeletes }
    }
  }
}

/** The answer must be about the Profile this request named. */
export function assertBrowserProfileControlTarget(request: BrowserProfileControlPayload, result: BrowserProfileControlResult): void {
  if (isBrowserProfileCreationOperation(request.operation) || request.operation === 'browser.profile.creation.inspect') {
    if (result.operation !== request.operation || !('creation' in result) || !('operationId' in request) || result.creation.operationId !== request.operationId ||
      (isBrowserProfileCreationOperation(request.operation) && result.creation.receipt?.action !== request.operation))
      fail('CONTROL_PROTOCOL_ERROR', 'Profile creation receipt belongs to another original operation.')
    if (request.operation === 'browser.profile.copy' && 'creation' in result &&
      (result.creation.receipt?.source?.profileId !== request.profileId || result.creation.receipt.source.expectedRevision !== request.expectedRevision || result.creation.receipt.createdId === request.profileId))
      fail('CONTROL_PROTOCOL_ERROR', 'Profile copy receipt names another original source or configuration.')
    if ((request.operation === 'browser.profile.folder.create' || request.operation === 'browser.profile.view.create') && 'creation' in result &&
      result.creation.receipt?.expectedCollectionRevision !== request.expectedRevision)
      fail('CONTROL_PROTOCOL_ERROR', 'Profile creation receipt names another original collection revision.')
    return
  }
  if (request.operation === 'browser.profile.network.probe') {
    if (result.operation !== request.operation || result.profileId !== request.profileId || result.diagnostic.id !== request.operationId || result.diagnostic.profileId !== request.profileId) fail('CONTROL_PROTOCOL_ERROR', 'Diagnostic receipt belongs to another original operation or Profile.')
    return
  }
  if (request.operation === 'browser.profile.network.history' && request.operationId !== undefined) {
    if (result.operation !== request.operation || result.profileId !== request.profileId || result.diagnostics.length > 1 || result.diagnostics.some(item => item.id !== request.operationId)) fail('CONTROL_PROTOCOL_ERROR', 'Diagnostic history does not name the original requested operation.')
    return
  }
  if (isBrowserProfileCookieFileOperation(request.operation)) { assertBrowserProfileCookieFileTarget(request as BrowserProfileCookieFilePayload, result as BrowserProfileCookieFileResult); return }
  if (isBrowserProfileBookmarkOperation(request.operation)) { assertBrowserProfileBookmarkTarget(request as BrowserProfileBookmarkPayload, result as BrowserProfileBookmarkResult); return }
  if (isBrowserProfileExtensionOperation(request.operation)) { assertBrowserProfileExtensionTarget(request as BrowserProfileExtensionPayload, result as BrowserProfileExtensionResult); return }
  if (request.operation === 'browser.profile.proxy.ls') return
  if (request.operation === 'browser.profile.proxy.update') {
    if (result.operation !== request.operation || !('proxy' in result) || result.proxy.label !== request.edit.label || (request.operation === 'browser.profile.proxy.update' && result.proxy.id !== request.proxyId)) fail('CONTROL_PROTOCOL_ERROR', 'Proxy receipt belongs to another asset.')
    return
  }
  if (request.operation === 'browser.profile.proxy.delete') {
    if (result.operation !== request.operation || result.proxyId !== request.proxyId) fail('CONTROL_PROTOCOL_ERROR', 'Proxy removal belongs to another asset.')
    return
  }
  if (request.operation === 'browser.profile.proxy.assign') {
    if (result.operation !== request.operation || result.proxyId !== request.proxyId || result.proxyRevision !== request.expectedRevision || result.results.length !== request.items.length || result.results.some((item, index) => item.profileId !== request.items[index]!.profileId || item.expectedRevision !== request.items[index]!.expectedRevision || (item.outcome === 'updated' && (item.profile.proxyBinding?.proxyId !== request.proxyId || item.profile.proxyBinding.revision !== request.expectedRevision)))) fail('CONTROL_PROTOCOL_ERROR', 'Proxy assignment does not preserve the exact asset, selection and tokens.')
    return
  }
  if (request.operation === 'browser.profile.delete') {
    if (result.operation !== request.operation || result.archive.profile.id !== request.profileId || result.archive.profile.revision !== request.expectedRevision) fail('CONTROL_PROTOCOL_ERROR', 'Recycle receipt does not retain this exact original Profile configuration.')
    return
  }
  if (request.operation === 'browser.profile.trash.purge' || request.operation === 'browser.profile.trash.inspect') {
    if (result.operation !== request.operation || !('purge' in result) || result.purge && (result.purge.purgeId !== request.purgeId || request.operation === 'browser.profile.trash.purge' && result.purge.archiveId !== request.archiveId)) fail('CONTROL_PROTOCOL_ERROR', 'Purge receipt belongs to another original action.')
    return
  }
  if (request.operation === 'browser.profile.trash.retention') {
    if (result.operation !== request.operation || !('archive' in result) || result.archive.id !== request.archiveId || (request.deleteAfter === null ? result.archive.retention !== undefined : result.archive.retention?.deleteAfter !== request.deleteAfter || result.archive.retention.purgeId !== request.purgeId)) fail('CONTROL_PROTOCOL_ERROR', 'Retention receipt belongs to another entry or deadline.')
    return
  }
  if (request.operation === 'browser.profile.trash.restore') {
    if (result.operation !== request.operation || result.archiveId !== request.archiveId) fail('CONTROL_PROTOCOL_ERROR', 'Restore receipt belongs to another archive.')
    return
  }
  if (request.operation === 'browser.profile.bulk-update') {
    if (result.operation !== request.operation || result.results.length !== request.items.length || result.results.some((item, index) => item.profileId !== request.items[index]!.profileId || item.expectedRevision !== request.items[index]!.expectedRevision)) fail('CONTROL_PROTOCOL_ERROR', 'Bulk result does not preserve the exact requested selection and tokens.')
    return
  }
  if (request.operation === 'browser.profile.view.update') {
    if (result.operation !== request.operation || !('view' in result) || result.view.label !== request.label || JSON.stringify(result.view.query) !== JSON.stringify(request.query) || (request.operation === 'browser.profile.view.update' && result.view.id !== request.viewId)) fail('CONTROL_PROTOCOL_ERROR', 'Saved view receipt belongs to another view or query.')
    return
  }
  if (request.operation === 'browser.profile.view.delete') {
    if (result.operation !== request.operation || result.viewId !== request.viewId) fail('CONTROL_PROTOCOL_ERROR', 'Saved view deletion belongs to another view.')
    return
  }
  if (request.operation === 'browser.profile.ls') {
    if (result.operation !== request.operation || (request.query !== undefined && JSON.stringify(result.filter?.query) !== JSON.stringify(request.query)) || (request.viewId !== undefined && result.filter?.viewId !== request.viewId) || (request.query === undefined && request.viewId === undefined && result.filter !== undefined)) fail('CONTROL_PROTOCOL_ERROR', 'Profile list scope differs from the requested query.')
    return
  }
  if (request.operation === 'browser.profile.folder.rename') {
    if (result.operation !== request.operation || !('folder' in result) || result.folder.label !== request.label ||
      (request.operation === 'browser.profile.folder.rename' && result.folder.id !== request.folderId)) fail('CONTROL_PROTOCOL_ERROR', 'Folder result belongs to another folder or name.')
    return
  }
  if (request.operation === 'browser.profile.folder.delete') {
    if (result.operation !== request.operation || result.folderId !== request.folderId) fail('CONTROL_PROTOCOL_ERROR', 'Folder deletion belongs to another folder.')
    return
  }
  const named = 'profileId' in request ? request.profileId : null
  const answered = 'profile' in result ? result.profile.id : 'profileId' in result ? result.profileId : null
  if (named !== null && answered !== named) fail('CONTROL_PROTOCOL_ERROR', 'Browser Profile result belongs to another Profile.')
}
