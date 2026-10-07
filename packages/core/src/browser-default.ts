import { AgentMuxError } from './errors.js'

export type BrowserDefaultProtocolFact =
  | { state: 'known'; isCurrentApplication: boolean; application: { name: string; path: string } }
  | { state: 'unknown'; cause: { code: string; message: string } }
export type BrowserDefaultInspection =
  | { platform: string; outcome: 'default' | 'not-default' | 'partial' | 'unknown'; protocols: { http: BrowserDefaultProtocolFact; https: BrowserDefaultProtocolFact } }
  | { platform: string; outcome: 'unsupported'; protocols: null }
export type BrowserDefaultSettingsRequest = { requested: true; target: 'default-web-browser'; platform: string }
export type BrowserDefaultPayload =
  | { operation: 'settings.browser.default.inspect' }
  | { operation: 'settings.browser.default.open-settings' }
export type BrowserDefaultResult =
  | ({ operation: 'settings.browser.default.inspect' } & BrowserDefaultInspection)
  | ({ operation: 'settings.browser.default.open-settings' } & BrowserDefaultSettingsRequest)

function invalid(): never { throw new AgentMuxError('Default browser owner facts are invalid.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) invalid(); return value }
function protocol(value: unknown): BrowserDefaultProtocolFact {
  const row = record(value, ['state', 'isCurrentApplication', 'application', 'cause'])
  if (row.state === 'known') {
    if (Object.hasOwn(row, 'cause') || typeof row.isCurrentApplication !== 'boolean') invalid()
    const app = record(row.application, ['name', 'path'])
    return { state: 'known', isCurrentApplication: row.isCurrentApplication, application: { name: string(app.name), path: string(app.path) } }
  }
  if (row.state !== 'unknown' || Object.hasOwn(row, 'isCurrentApplication') || Object.hasOwn(row, 'application')) invalid()
  const cause = record(row.cause, ['code', 'message'])
  return { state: 'unknown', cause: { code: string(cause.code), message: string(cause.message) } }
}

/** Computed from owner facts, never a saved preference or a handler display name. */
export function browserDefaultOutcome(protocols: { http: BrowserDefaultProtocolFact; https: BrowserDefaultProtocolFact }): Exclude<BrowserDefaultInspection['outcome'], 'unsupported'> {
  const facts = [protocols.http, protocols.https]
  if (facts.some(fact => fact.state === 'unknown')) return 'unknown'
  const matches = facts.filter(fact => fact.state === 'known' && fact.isCurrentApplication).length
  return matches === 2 ? 'default' : matches === 1 ? 'partial' : 'not-default'
}

export function parseBrowserDefaultInspection(value: unknown): BrowserDefaultInspection {
  const row = record(value, ['platform', 'outcome', 'protocols']), platform = string(row.platform)
  if (row.outcome === 'unsupported') { if (row.protocols !== null) invalid(); return { platform, outcome: 'unsupported', protocols: null } }
  const input = record(row.protocols, ['http', 'https'])
  const protocols = { http: protocol(input.http), https: protocol(input.https) }
  if (row.outcome !== browserDefaultOutcome(protocols)) invalid()
  return { platform, outcome: browserDefaultOutcome(protocols), protocols }
}

export function parseBrowserDefaultSettingsRequest(value: unknown): BrowserDefaultSettingsRequest {
  const row = record(value, ['requested', 'target', 'platform'])
  if (row.requested !== true || row.target !== 'default-web-browser') invalid()
  return { requested: true, target: 'default-web-browser', platform: string(row.platform) }
}
