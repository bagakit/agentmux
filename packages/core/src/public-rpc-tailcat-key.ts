import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-business-codec.js'

/** Prepares a saved key on the answering Host itself; there is no route Host to address. */
export const AGENTMUX_RPC_TAILCAT_KEY_METHODS = { 'settings.hosts.tailcat-key': 'long' } as const
export type TailcatKeyMethod = keyof typeof AGENTMUX_RPC_TAILCAT_KEY_METHODS
export type TailcatKeyRole = 'server' | 'client'
export const AGENTMUX_TAILCAT_DEFAULT_KEYS = { server: 'agentmux-server', client: 'agentmux-client' } as const satisfies Record<TailcatKeyRole, string>
export type TailcatKeyPreparation = { role: TailcatKeyRole; key: string; created: boolean; publicKey?: string }
export type TailcatKeyParamsMap = { 'settings.hosts.tailcat-key': { role: TailcatKeyRole; key?: string } }
export type TailcatKeyResultMap = { 'settings.hosts.tailcat-key': TailcatKeyPreparation }

/** A name the official CLI resolves inside its own key directory; paths and its magic `new` are excluded. */
export const isTailcatKeyName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value) && value !== 'new'
export const isTailcatNodePublicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^nodekey:[0-9a-f]{64}$/u.test(value) && !value.endsWith('0'.repeat(64))

export function isTailcatKeyMethod(method: unknown): method is TailcatKeyMethod {
  return typeof method === 'string' && Object.hasOwn(AGENTMUX_RPC_TAILCAT_KEY_METHODS, method)
}
export function parseTailcatKeyParams(value: unknown): TailcatKeyParamsMap['settings.hosts.tailcat-key'] {
  const p = rpcRecord(value, ['role', 'key'])
  if (p.role !== 'server' && p.role !== 'client') throw new AgentMuxError('Choose the Tailcat server or client key role.', 'INVALID_CONTROL_REQUEST')
  if (p.key !== undefined && !isTailcatKeyName(p.key)) {
    throw new AgentMuxError('Name a saved Tailcat key with letters, digits, dot, dash or underscore; paths are not accepted.', 'INVALID_CONTROL_REQUEST')
  }
  return { role: p.role, ...(p.key === undefined ? {} : { key: p.key }) }
}
export function parseTailcatKeyResult(value: unknown, input: TailcatKeyParamsMap['settings.hosts.tailcat-key']): TailcatKeyPreparation {
  const p = rpcRecord(value, ['role', 'key', 'created', 'publicKey'], 'CONTROL_PROTOCOL_ERROR')
  // Only a client key has a connection code; a server address is a credential that stays with its listener.
  if (p.role !== input.role || p.key !== (input.key ?? AGENTMUX_TAILCAT_DEFAULT_KEYS[input.role]) || typeof p.created !== 'boolean' ||
      (input.role === 'client' ? !isTailcatNodePublicKey(p.publicKey) : p.publicKey !== undefined)) {
    throw new AgentMuxError('The Tailcat key result belongs to another role or key.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { role: input.role, key: p.key, created: p.created, ...(input.role === 'client' ? { publicKey: p.publicKey as string } : {}) }
}
