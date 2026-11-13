import { AgentMuxError } from './errors.js'

/**
 * Public Browser Profile control. The Desktop Main Profile owner holds every fact; Core only carries
 * typed requests and checks the shape of the owner's answers. No partition, cookie path or
 * credential is returned by this contract. A proxy sign-in write carries a password only to Main.
 */
export const BROWSER_PROFILE_CONTROL_OPERATIONS = ['browser.profile.ls', 'browser.profile.inspect', 'browser.profile.create',
  'browser.profile.folder.create', 'browser.profile.folder.rename', 'browser.profile.folder.delete',
  'browser.profile.copy', 'browser.profile.update', 'browser.profile.set-default', 'browser.profile.delete',
  'browser.profile.proxy-sign-in.set', 'browser.profile.proxy-sign-in.clear', 'browser.profile.network.check'] as const
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

export type BrowserProfileControlPayload =
  | { operation: 'browser.profile.ls' }
  | { operation: 'browser.profile.folder.create'; label: string; expectedRevision: number }
  | { operation: 'browser.profile.folder.rename'; folderId: string; label: string; expectedRevision: number }
  | { operation: 'browser.profile.folder.delete'; folderId: string; expectedRevision: number }
  | { operation: 'browser.profile.inspect'; profileId: string }
  | { operation: 'browser.profile.create'; label: string }
  | { operation: 'browser.profile.copy'; profileId: string; expectedRevision: string; label: string }
  | { operation: 'browser.profile.update'; profileId: string; expectedRevision: string; edit: BrowserProfileControlEdit }
  | { operation: 'browser.profile.set-default'; profileId: string }
  | { operation: 'browser.profile.delete'; profileId: string }
  | { operation: 'browser.profile.proxy-sign-in.set'; profileId: string; signIn: BrowserProfileProxySignIn }
  | { operation: 'browser.profile.proxy-sign-in.clear'; profileId: string }
  | { operation: 'browser.profile.network.check'; profileId: string }

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

/** Native session defaults, not a complete device identity or webpage language override. */
export type BrowserProfileEnvironment = { userAgent?: string; acceptLanguages?: string[] }
/** Native setter receipt. UA covers new pages; request language covers subsequent requests. */
export type BrowserProfileEnvironmentApplication = { status: 'not-applied' | 'applied' | 'unknown'; scope: 'session-defaults';
  userAgent?: string; acceptLanguages?: string[]; unsupported: string[]; reason?: string }

export function parseBrowserProfileEnvironment(value: unknown): BrowserProfileEnvironment {
  const code = 'INVALID_CONTROL_REQUEST', row = record(value, ['userAgent', 'acceptLanguages'], code, 'Browser Profile environment')
  if (!Object.keys(row).length) fail(code, 'An environment needs a userAgent or acceptLanguages; use null to restore defaults.')
  const userAgent = row.userAgent === undefined ? undefined : text(row.userAgent, code, 'User agent')
  if (userAgent !== undefined && (!userAgent.trim() || /[^\x20-\x7e]/u.test(userAgent))) fail(code, 'User agent must be nonempty printable HTTP header text.')
  let acceptLanguages: string[] | undefined
  if (row.acceptLanguages !== undefined) {
    if (!Array.isArray(row.acceptLanguages) || !row.acceptLanguages.length || row.acceptLanguages.some(item => typeof item !== 'string')) fail(code, 'Request languages must be a nonempty list of language tags.')
    try { acceptLanguages = Intl.getCanonicalLocales(row.acceptLanguages as string[]) }
    catch { fail(code, 'Request languages must be valid language tags, without HTTP quality weights.') }
  }
  return { ...(userAgent === undefined ? {} : { userAgent }), ...(acceptLanguages === undefined ? {} : { acceptLanguages }) }
}

function environmentApplication(value: unknown, code: string): BrowserProfileEnvironmentApplication {
  const row = record(value, ['status', 'scope', 'userAgent', 'acceptLanguages', 'unsupported', 'reason'], code, 'Environment application')
  if (!['not-applied', 'applied', 'unknown'].includes(row.status as string) || row.scope !== 'session-defaults' || !Array.isArray(row.unsupported)) fail(code, 'Environment application is invalid.')
  const settings = row.userAgent === undefined && row.acceptLanguages === undefined ? {} : parseBrowserProfileEnvironment({
    ...(row.userAgent === undefined ? {} : { userAgent: row.userAgent }), ...(row.acceptLanguages === undefined ? {} : { acceptLanguages: row.acceptLanguages }) })
  return { status: row.status as BrowserProfileEnvironmentApplication['status'], scope: 'session-defaults', ...settings,
    unsupported: row.unsupported.map(item => text(item, code, 'Unsupported environment field')),
    ...(row.reason === undefined ? {} : { reason: text(row.reason, code, 'Environment application reason') }) }
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
  environment?: BrowserProfileEnvironment
  environmentApplication?: BrowserProfileEnvironmentApplication
  /** false when the person turned Agents off for this Profile; absent means Agents may use it. */
  agentAccess?: false
}
/** One Browser that holds the Profile: open has a native owner now, saved restores into it later. */
export type BrowserProfileControlUse = { browserId: string; workspaceId?: string; title: string; url: string; state: 'open' | 'saved' }
/** complete is false when saved Tabs could not be read; browsers then names only open Browsers. */
export type BrowserProfileControlUsage = { browsers: BrowserProfileControlUse[]; complete: boolean }

export type BrowserProfileControlResult =
  | { operation: 'browser.profile.ls'; revision: number; sequence: number; profiles: BrowserProfileControlProfile[]; folders: BrowserProfileFolder[] }
  | { operation: 'browser.profile.folder.create'; revision: number; folder: BrowserProfileFolder }
  | { operation: 'browser.profile.folder.rename'; revision: number; folder: BrowserProfileFolder }
  | { operation: 'browser.profile.folder.delete'; revision: number; folderId: string; deleted: true; unassignedProfileIds: string[] }
  | { operation: 'browser.profile.inspect'; revision: number; sequence: number; profile: BrowserProfileControlProfile; usage: BrowserProfileControlUsage }
  | { operation: 'browser.profile.create'; revision: number; profile: BrowserProfileControlProfile }
  | { operation: 'browser.profile.copy'; revision: number; sourceProfileId: string; profile: BrowserProfileControlProfile }
  | { operation: 'browser.profile.update'; revision: number; profile: BrowserProfileControlProfile }
  | { operation: 'browser.profile.set-default'; revision: number; profileId: string }
  | { operation: 'browser.profile.delete'; revision: number; profileId: string; deleted: true }
  | { operation: 'browser.profile.proxy-sign-in.set'; profileId: string; saved: true; reconnected: boolean }
  | { operation: 'browser.profile.proxy-sign-in.clear'; profileId: string; cleared: true; reconnected: boolean }
  | { operation: 'browser.profile.network.check'; profileId: string; check: BrowserProfileNetworkCheck }

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
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) fail(code, `${label} is invalid.`)
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
  const code = 'INVALID_CONTROL_REQUEST'
  const operation = source.operation
  if (!isBrowserProfileControlOperation(operation)) fail(code, 'Browser Profile operation is invalid.')
  const fields: Record<BrowserProfileControlOperation, readonly string[]> = {
    'browser.profile.ls': [], 'browser.profile.folder.create': ['label', 'expectedRevision'],
    'browser.profile.folder.rename': ['folderId', 'label', 'expectedRevision'], 'browser.profile.folder.delete': ['folderId', 'expectedRevision'], 'browser.profile.inspect': ['profileId'], 'browser.profile.create': ['label'], 'browser.profile.copy': ['profileId', 'expectedRevision', 'label'],
    'browser.profile.update': ['profileId', 'expectedRevision', 'edit'], 'browser.profile.set-default': ['profileId'], 'browser.profile.delete': ['profileId'],
    'browser.profile.proxy-sign-in.set': ['profileId', 'signIn'], 'browser.profile.proxy-sign-in.clear': ['profileId'], 'browser.profile.network.check': ['profileId']
  }
  record(source, [...envelope, ...fields[operation]], code, 'Browser Profile request')
  for (const key of fields[operation]) if (!Object.hasOwn(source, key)) fail(code, `Browser Profile ${key} is required.`)
  switch (operation) {
    case 'browser.profile.proxy-sign-in.set': return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), signIn: parseBrowserProfileProxySignIn(source.signIn) }
    case 'browser.profile.folder.create': case 'browser.profile.folder.rename': {
      const label = text(source.label, code, 'Folder name', 512)
      if (!label.trim()) fail(code, 'A folder name is required.')
      const expectedRevision = count(source.expectedRevision, code, 'Expected Browser Profile list revision')
      return operation === 'browser.profile.folder.rename' ? { operation, label, expectedRevision, folderId: identity(source.folderId, code, 'Folder ID') }
        : { operation, label, expectedRevision }
    }
    case 'browser.profile.folder.delete': return { operation, folderId: identity(source.folderId, code, 'Folder ID'), expectedRevision: count(source.expectedRevision, code, 'Expected Browser Profile list revision') }
    case 'browser.profile.ls': return { operation }
    case 'browser.profile.copy': {
      const label = text(source.label, code, 'Browser Profile label', 512)
      if (!label.trim()) fail(code, 'Browser Profile label is required.')
      return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), expectedRevision: identity(source.expectedRevision, code, 'Expected Profile configuration revision'), label }
    }
    case 'browser.profile.create': {
      const label = text(source.label, code, 'Browser Profile label', 512)
      if (!label.trim()) fail(code, 'Browser Profile label is required.')
      return { operation, label }
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
  const row = record(value, ['id', 'label', 'revision', 'createdAt', 'isDefault', 'source', 'hue', 'notes', 'network', 'agentAccess', 'environment', 'environmentApplication', 'tags', 'folderId', 'pinned', 'activity'], code, 'Browser Profile')
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
    ...(row.environment === undefined ? {} : { environment: parseBrowserProfileEnvironment(row.environment) }),
    ...(row.environmentApplication === undefined ? {} : { environmentApplication: environmentApplication(row.environmentApplication, code) }),
    ...(row.agentAccess === false ? { agentAccess: false as const } : {}) }
}
function usage(value: unknown, code: string): BrowserProfileControlUsage {
  const row = record(value, ['browsers', 'complete'], code, 'Browser Profile usage')
  if (typeof row.complete !== 'boolean' || !Array.isArray(row.browsers)) fail(code, 'Browser Profile usage is invalid.')
  return { complete: row.complete, browsers: row.browsers.map(item => {
    const use = record(item, ['browserId', 'workspaceId', 'title', 'url', 'state'], code, 'Browser Profile use')
    if (use.state !== 'open' && use.state !== 'saved') fail(code, 'Browser Profile use state is invalid.')
    return { browserId: identity(use.browserId, code, 'Browser ID'), ...(use.workspaceId === undefined ? {} : { workspaceId: identity(use.workspaceId, code, 'Workspace ID') }),
      title: text(use.title, code, 'Browser title'), url: text(use.url, code, 'Browser URL', 64 * 1024), state: use.state }
  }) }
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
  const code = 'CONTROL_PROTOCOL_ERROR'
  const keys: Record<BrowserProfileControlOperation, readonly string[]> = {
    'browser.profile.ls': ['revision', 'sequence', 'profiles', 'folders'],
    'browser.profile.folder.create': ['revision', 'folder'], 'browser.profile.folder.rename': ['revision', 'folder'],
    'browser.profile.folder.delete': ['revision', 'folderId', 'deleted', 'unassignedProfileIds'], 'browser.profile.inspect': ['revision', 'sequence', 'profile', 'usage'],
    'browser.profile.create': ['revision', 'profile'], 'browser.profile.copy': ['revision', 'sourceProfileId', 'profile'], 'browser.profile.update': ['revision', 'profile'],
    'browser.profile.set-default': ['revision', 'profileId'], 'browser.profile.delete': ['revision', 'profileId', 'deleted'],
    'browser.profile.proxy-sign-in.set': ['profileId', 'saved', 'reconnected'], 'browser.profile.proxy-sign-in.clear': ['profileId', 'cleared', 'reconnected'],
    'browser.profile.network.check': ['profileId', 'check']
  }
  const row = record(value, keys[operation], code, 'Browser Profile result')
  for (const key of keys[operation]) if (!Object.hasOwn(row, key)) fail(code, `Browser Profile result ${key} is required.`)
  if (operation === 'browser.profile.proxy-sign-in.set') {
    if (row.saved !== true || typeof row.reconnected !== 'boolean') fail(code, 'Proxy sign-in save receipt is invalid.')
    return { profileId: identity(row.profileId, code, 'Browser Profile ID'), saved: true, reconnected: row.reconnected }
  }
  if (operation === 'browser.profile.proxy-sign-in.clear') {
    if (row.cleared !== true || typeof row.reconnected !== 'boolean') fail(code, 'Proxy sign-in clear receipt is invalid.')
    return { profileId: identity(row.profileId, code, 'Browser Profile ID'), cleared: true, reconnected: row.reconnected }
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
  switch (operation) {
    case 'browser.profile.ls': {
      if (!Array.isArray(row.profiles)) fail(code, 'Browser Profile list is invalid.')
      const profiles = row.profiles.map(item => profile(item, code))
      if (new Set(profiles.map(item => item.id)).size !== profiles.length || profiles.filter(item => item.isDefault).length !== 1) fail(code, 'Browser Profile list is inconsistent.')
      if (!Array.isArray(row.folders)) fail(code, 'Profile folders are invalid.')
      const folders = row.folders.map(item => folder(item, code)), folderIds = new Set(folders.map(item => item.id))
      if (folderIds.size !== folders.length || profiles.some(item => item.folderId !== undefined && !folderIds.has(item.folderId))) fail(code, 'Profile folder references are inconsistent.')
      return { revision, sequence: count(row.sequence, code, 'Profile snapshot sequence'), profiles, folders }
    }
    case 'browser.profile.folder.create': case 'browser.profile.folder.rename': return { revision, folder: folder(row.folder, code) }
    case 'browser.profile.folder.delete': {
      if (row.deleted !== true || !Array.isArray(row.unassignedProfileIds)) fail(code, 'Folder deletion receipt is invalid.')
      const ids = row.unassignedProfileIds.map(item => identity(item, code, 'Unassigned Profile ID'))
      if (new Set(ids).size !== ids.length) fail(code, 'Unassigned Profile identities are duplicated.')
      return { revision, folderId: identity(row.folderId, code, 'Folder ID'), deleted: true, unassignedProfileIds: ids }
    }
    case 'browser.profile.inspect': return { revision, sequence: count(row.sequence, code, 'Profile snapshot sequence'), profile: profile(row.profile, code), usage: usage(row.usage, code) }
    case 'browser.profile.copy': return { revision, sourceProfileId: identity(row.sourceProfileId, code, 'Source Browser Profile ID'), profile: profile(row.profile, code) }
    case 'browser.profile.create': case 'browser.profile.update': return { revision, profile: profile(row.profile, code) }
    case 'browser.profile.set-default': return { revision, profileId: identity(row.profileId, code, 'Browser Profile ID') }
    case 'browser.profile.delete':
      if (row.deleted !== true) fail(code, 'Browser Profile deletion receipt is invalid.')
      return { revision, profileId: identity(row.profileId, code, 'Browser Profile ID'), deleted: true }
  }
}

/** The answer must be about the Profile this request named. */
export function assertBrowserProfileControlTarget(request: BrowserProfileControlPayload, result: BrowserProfileControlResult): void {
  if (request.operation === 'browser.profile.folder.create' || request.operation === 'browser.profile.folder.rename') {
    if (result.operation !== request.operation || !('folder' in result) || result.folder.label !== request.label ||
      (request.operation === 'browser.profile.folder.rename' && result.folder.id !== request.folderId)) fail('CONTROL_PROTOCOL_ERROR', 'Folder result belongs to another folder or name.')
    return
  }
  if (request.operation === 'browser.profile.folder.delete') {
    if (result.operation !== request.operation || result.folderId !== request.folderId) fail('CONTROL_PROTOCOL_ERROR', 'Folder deletion belongs to another folder.')
    return
  }
  if (request.operation === 'browser.profile.copy') {
    if (result.operation !== 'browser.profile.copy' || result.sourceProfileId !== request.profileId || result.profile.id === request.profileId ||
      result.profile.label !== request.label || result.profile.source !== null || result.profile.isDefault || result.profile.pinned === true) {
      fail('CONTROL_PROTOCOL_ERROR', 'Copied Browser Profile result does not identify the original source and a new settings-only Profile.')
    }
    return
  }
  const named = 'profileId' in request ? request.profileId : null
  const answered = 'profile' in result ? result.profile.id : 'profileId' in result ? result.profileId : null
  if (named !== null && answered !== named) fail('CONTROL_PROTOCOL_ERROR', 'Browser Profile result belongs to another Profile.')
  if (request.operation === 'browser.profile.create' && result.operation === 'browser.profile.create' && result.profile.label !== request.label) {
    fail('CONTROL_PROTOCOL_ERROR', 'Created Browser Profile has another label.')
  }
}
