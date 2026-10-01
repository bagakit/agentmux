import { AgentMuxError } from './errors.js'

export function rpcTransportError(error: unknown): Error {
  if (error instanceof AgentMuxError) return error
  const errno = (error as { code?: string })?.code
  return new AgentMuxError(errno === 'ENOENT' || errno === 'ECONNREFUSED' ? 'RPC owner is unavailable.' : 'RPC connection failed; its business outcome is unconfirmed.',
    errno === 'ENOENT' || errno === 'ECONNREFUSED' ? 'CONTROL_UNAVAILABLE' : 'CONTROL_PROTOCOL_ERROR')
}
