import { AgentMuxError } from './errors.js'
import type { ConnectionConfig, ConnectionObservation, ConnectionRecord } from './connections-contract.js'

const fail = (): never => { throw new AgentMuxError('Connection data is malformed or belongs to another original object.', 'INVALID_CONNECTION_DATA') }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !fields.includes(key))) fail()
  return result
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) fail(); return value as string }
function identity(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(); return result }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail(); return value as number }
export function parseConnectionConfig(value: unknown): ConnectionConfig {
  const p = object(value, ['connectionId', 'adapterId', 'application', 'label', 'enabled', 'credentialRef'])
  const app = object(p.application, ['domain', 'appId']), domain = text(app.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain) || typeof p.enabled !== 'boolean') fail()
  return { connectionId: identity(p.connectionId), adapterId: identity(p.adapterId), application: { domain, appId: identity(app.appId) }, label: text(p.label), enabled: p.enabled as boolean, credentialRef: identity(p.credentialRef) }
}
export function parseConnectionObservation(value: unknown): ConnectionObservation {
  const p = object(value, ['authentication', 'transport', 'intake', 'delivery'])
  const stage = (value: unknown) => {
    const s = object(value, ['state', 'reason'])
    if (!['unknown', 'ready', 'unavailable', 'disabled'].includes(s.state as string) || s.reason !== undefined && !['not-tested', 'credential-missing', 'credential-format-unsupported', 'credential-unavailable', 'adapter-unavailable', 'check-failed', 'not-started'].includes(s.reason as string)) fail()
    return { state: s.state, ...(s.reason === undefined ? {} : { reason: s.reason }) } as ConnectionObservation['authentication']
  }
  return { authentication: stage(p.authentication), transport: stage(p.transport), intake: stage(p.intake), delivery: stage(p.delivery) }
}
export function parseConnectionRecord(value: unknown): ConnectionRecord {
  const p = object(value, ['config', 'revision', 'observation', 'initialSetup', 'capabilities'])
  const initial = p.initialSetup === undefined ? undefined : object(p.initialSetup, ['state'])
  if (initial && !['incomplete', 'complete', 'unconfirmed'].includes(initial.state as string)) fail()
  const support = p.capabilities === undefined ? undefined : object(p.capabilities, ['roomDiscovery', 'roomCreation', 'roomLink'])
  if (support && [support.roomDiscovery, support.roomCreation, support.roomLink].some(value => typeof value !== 'boolean')) fail()
  return { config: parseConnectionConfig(p.config), revision: revision(p.revision), observation: parseConnectionObservation(p.observation),
    ...(support ? { capabilities: { roomDiscovery: support.roomDiscovery as boolean, roomCreation: support.roomCreation as boolean, roomLink: support.roomLink as boolean } } : {}),
    ...(initial ? { initialSetup: { state: initial.state as NonNullable<ConnectionRecord['initialSetup']>['state'] } } : {}) }
}
