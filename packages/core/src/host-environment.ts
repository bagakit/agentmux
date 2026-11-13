import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type AgentMuxHostEnvironment = { homeDirectory: string }

/** A remote absolute path retains its executing platform's spelling and trailing spaces. */
export function parseHostEnvironment(value: unknown): AgentMuxHostEnvironment {
  const p = rpcRecord(value, ['homeDirectory'], 'CONTROL_PROTOCOL_ERROR')
  if (typeof p.homeDirectory !== 'string' || !p.homeDirectory || /[\0\r\n]/u.test(p.homeDirectory) ||
      !(p.homeDirectory.startsWith('/') || /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(p.homeDirectory))) {
    throw new AgentMuxError('The original Host home directory is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { homeDirectory: p.homeDirectory }
}

