import { AgentMuxError } from './errors.js'

/** Non-secret proxy configuration. Sign-in stays with each original Profile credential owner. */
export type BrowserProxyEdit = { label: string; server: string; bypass?: string[]; notes?: string }
export type BrowserProxyAsset = BrowserProxyEdit & { id: string; revision: string }
export type BrowserProxyBinding = { proxyId: string; revision: string }
/** ACK of native session configuration; this never proves an exit address or protocol traffic. */
export type BrowserProfileNetworkApplication = {
  status: 'applied' | 'pending' | 'unknown'
  scope: 'session-proxy-config'
}

function object(value: unknown, keys: string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new AgentMuxError('Proxy configuration must be a plain object.', code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]!)))
    throw new AgentMuxError('Proxy configuration has unsupported fields.', code)
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AgentMuxError('Proxy text is invalid.', code)
  return value
}
export function parseBrowserProxyEdit(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProxyEdit {
  const row = object(value, ['label', 'server', 'bypass', 'notes'], code), label = text(row.label, 128, code), server = text(row.server, 2048, code)
  if (!label.trim() || label !== label.trim() || !server.trim() || server.includes('@') || /[\r\n]/u.test(server))
    throw new AgentMuxError('A proxy needs a name and server without embedded sign-in credentials.', code)
  let bypass: string[] | undefined
  if (row.bypass !== undefined) {
    if (!Array.isArray(row.bypass) || row.bypass.length > 64) throw new AgentMuxError('Proxy bypass entries are invalid.', code)
    bypass = row.bypass.map(item => text(item, 253, code))
  }
  return { label, server, ...(bypass ? { bypass } : {}), ...(row.notes === undefined ? {} : { notes: text(row.notes, 2000, code) }) }
}
export function parseBrowserProxyBinding(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProxyBinding {
  const row = object(value, ['proxyId', 'revision'], code), proxyId = text(row.proxyId, 256, code), revision = text(row.revision, 256, code)
  if (!proxyId || !revision) throw new AgentMuxError('The exact proxy identity and revision are required.', code)
  return { proxyId, revision }
}
export function parseBrowserProxyAsset(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): BrowserProxyAsset {
  const row = object(value, ['id', 'revision', 'label', 'server', 'bypass', 'notes'], code), id = text(row.id, 256, code), revision = text(row.revision, 256, code)
  if (!id || !revision) throw new AgentMuxError('Proxy asset identity and revision are required.', code)
  const { id: _id, revision: _revision, ...edit } = row
  return { id, revision, ...parseBrowserProxyEdit(edit, code) }
}
export function parseBrowserProfileNetworkApplication(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): BrowserProfileNetworkApplication {
  const row = object(value, ['status', 'scope'], code)
  if (!['applied', 'pending', 'unknown'].includes(row.status as string) || row.scope !== 'session-proxy-config')
    throw new AgentMuxError('Native proxy application receipt is invalid.', code)
  return { status: row.status as BrowserProfileNetworkApplication['status'], scope: 'session-proxy-config' }
}
