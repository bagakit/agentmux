import { AgentMuxError } from './errors.js'

/**
 * Public Browser Profile control. The Desktop Main Profile owner holds every fact; Core only carries
 * typed requests and checks the shape of the owner's answers. No partition, cookie path or
 * credential is returned by this contract. A proxy sign-in write carries a password only to Main.
 */
export const BROWSER_PROFILE_CONTROL_OPERATIONS = ['browser.profile.ls', 'browser.profile.inspect', 'browser.profile.create',
  'browser.profile.update', 'browser.profile.set-default', 'browser.profile.delete',
  'browser.profile.proxy-sign-in.set', 'browser.profile.proxy-sign-in.clear', 'browser.profile.network.check'] as const
export type BrowserProfileControlOperation = typeof BROWSER_PROFILE_CONTROL_OPERATIONS[number]

/**
 * Fields a person can change; null clears the chosen hue, an empty notes string clears the notes.
 * network is the route as one line Main parses (`system`, `direct`, or a proxy such as
 * `socks5://proxy.example:1080`), with optional Don't proxy entries; Main owns what a valid route is.
 */
export type BrowserProfileControlEdit = { label?: string; hue?: number | null; notes?: string;
  network?: { mode: 'system' } | { mode: 'direct' } | { mode: 'proxy'; server: string; bypass?: string[] } }

export type BrowserProfileControlPayload =
  | { operation: 'browser.profile.ls' }
  | { operation: 'browser.profile.inspect'; profileId: string }
  | { operation: 'browser.profile.create'; label: string }
  | { operation: 'browser.profile.update'; profileId: string; expectedRevision: number; edit: BrowserProfileControlEdit }
  | { operation: 'browser.profile.set-default'; profileId: string }
  | { operation: 'browser.profile.delete'; profileId: string }
  | { operation: 'browser.profile.proxy-sign-in.set'; profileId: string; signIn: BrowserProfileProxySignIn }
  | { operation: 'browser.profile.proxy-sign-in.clear'; profileId: string }
  | { operation: 'browser.profile.network.check'; profileId: string }

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
/** One Profile as Main lists it. hue is absent when the person chose none. */
export type BrowserProfileControlProfile = {
  id: string; label: string; createdAt: number; isDefault: boolean; source: BrowserProfileControlSource | null; hue?: number; notes?: string
  network?: BrowserProfileControlNetwork
  /** false when the person turned Agents off for this Profile; absent means Agents may use it. */
  agentAccess?: false
}
/** One Browser that holds the Profile: open has a native owner now, saved restores into it later. */
export type BrowserProfileControlUse = { browserId: string; workspaceId?: string; title: string; url: string; state: 'open' | 'saved' }
/** complete is false when saved Tabs could not be read; browsers then names only open Browsers. */
export type BrowserProfileControlUsage = { browsers: BrowserProfileControlUse[]; complete: boolean }

export type BrowserProfileControlResult =
  | { operation: 'browser.profile.ls'; revision: number; profiles: BrowserProfileControlProfile[] }
  | { operation: 'browser.profile.inspect'; revision: number; profile: BrowserProfileControlProfile; usage: BrowserProfileControlUsage }
  | { operation: 'browser.profile.create'; revision: number; profile: BrowserProfileControlProfile }
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
    'browser.profile.ls': [], 'browser.profile.inspect': ['profileId'], 'browser.profile.create': ['label'],
    'browser.profile.update': ['profileId', 'expectedRevision', 'edit'], 'browser.profile.set-default': ['profileId'], 'browser.profile.delete': ['profileId'],
    'browser.profile.proxy-sign-in.set': ['profileId', 'signIn'], 'browser.profile.proxy-sign-in.clear': ['profileId'], 'browser.profile.network.check': ['profileId']
  }
  record(source, [...envelope, ...fields[operation]], code, 'Browser Profile request')
  for (const key of fields[operation]) if (!Object.hasOwn(source, key)) fail(code, `Browser Profile ${key} is required.`)
  switch (operation) {
    case 'browser.profile.proxy-sign-in.set': return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), signIn: parseBrowserProfileProxySignIn(source.signIn) }
    case 'browser.profile.ls': return { operation }
    case 'browser.profile.create': {
      const label = text(source.label, code, 'Browser Profile label', 512)
      if (!label.trim()) fail(code, 'Browser Profile label is required.')
      return { operation, label }
    }
    case 'browser.profile.update': {
      const edit = record(source.edit, ['label', 'hue', 'notes', 'network'], code, 'Browser Profile edit')
      if (!Object.keys(edit).length) fail(code, 'Browser Profile edit names no field.')
      return { operation, profileId: identity(source.profileId, code, 'Browser Profile ID'), expectedRevision: count(source.expectedRevision, code, 'Expected Browser Profile revision'),
        edit: { ...(edit.label === undefined ? {} : { label: text(edit.label, code, 'Browser Profile label', 512) }),
          ...(edit.hue === undefined ? {} : { hue: edit.hue === null ? null : hue(edit.hue, code) }),
          ...(edit.notes === undefined ? {} : { notes: text(edit.notes, code, 'Browser Profile notes', 8192) }),
          ...(edit.network === undefined ? {} : { network: networkEdit(edit.network, code) }) } }
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
  const row = record(value, ['id', 'label', 'createdAt', 'isDefault', 'source', 'hue', 'notes', 'network', 'agentAccess'], code, 'Browser Profile')
  if (row.agentAccess !== undefined && row.agentAccess !== false) fail(code, 'Browser Profile Agent access is invalid.')
  if (typeof row.isDefault !== 'boolean') fail(code, 'Browser Profile default flag is invalid.')
  const source = row.source === null ? null : (() => {
    const imported = record(row.source, ['browserLabel', 'profileLabel', 'importedAt', 'importedCookies', 'skippedCookies', 'skippedByReason'], code, 'Browser Profile source')
    return { browserLabel: text(imported.browserLabel, code, 'Imported browser'), profileLabel: text(imported.profileLabel, code, 'Imported profile'),
      importedAt: count(imported.importedAt, code, 'Import time'), importedCookies: count(imported.importedCookies, code, 'Imported cookies'), skippedCookies: count(imported.skippedCookies, code, 'Skipped cookies'),
      ...(imported.skippedByReason === undefined ? {} : { skippedByReason: skipCounts(imported.skippedByReason, code) }) }
  })()
  return { id: identity(row.id, code, 'Browser Profile ID'), label: text(row.label, code, 'Browser Profile label'), createdAt: count(row.createdAt, code, 'Browser Profile creation time'),
    isDefault: row.isDefault, source, ...(row.hue === undefined ? {} : { hue: hue(row.hue, code) }),
    ...(row.notes === undefined ? {} : { notes: text(row.notes, code, 'Browser Profile notes', 8192) }),
    ...(row.network === undefined ? {} : { network: network(row.network, code) }),
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

/** Owner result body, without the operation key. Exactly one Profile is default in every list. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type BrowserProfileControlResultBody = OmitEach<BrowserProfileControlResult, 'operation'>
export function parseBrowserProfileControlResult(operation: BrowserProfileControlOperation, value: unknown): BrowserProfileControlResultBody {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const keys: Record<BrowserProfileControlOperation, readonly string[]> = {
    'browser.profile.ls': ['revision', 'profiles'], 'browser.profile.inspect': ['revision', 'profile', 'usage'],
    'browser.profile.create': ['revision', 'profile'], 'browser.profile.update': ['revision', 'profile'],
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
      return { revision, profiles }
    }
    case 'browser.profile.inspect': return { revision, profile: profile(row.profile, code), usage: usage(row.usage, code) }
    case 'browser.profile.create': case 'browser.profile.update': return { revision, profile: profile(row.profile, code) }
    case 'browser.profile.set-default': return { revision, profileId: identity(row.profileId, code, 'Browser Profile ID') }
    case 'browser.profile.delete':
      if (row.deleted !== true) fail(code, 'Browser Profile deletion receipt is invalid.')
      return { revision, profileId: identity(row.profileId, code, 'Browser Profile ID'), deleted: true }
  }
}

/** The answer must be about the Profile this request named. */
export function assertBrowserProfileControlTarget(request: BrowserProfileControlPayload, result: BrowserProfileControlResult): void {
  const named = 'profileId' in request ? request.profileId : null
  const answered = 'profile' in result ? result.profile.id : 'profileId' in result ? result.profileId : null
  if (named !== null && answered !== named) fail('CONTROL_PROTOCOL_ERROR', 'Browser Profile result belongs to another Profile.')
  if (request.operation === 'browser.profile.create' && result.operation === 'browser.profile.create' && result.profile.label !== request.label) {
    fail('CONTROL_PROTOCOL_ERROR', 'Created Browser Profile has another label.')
  }
}
