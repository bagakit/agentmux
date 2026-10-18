import { AgentMuxError } from './errors.js'

export function rpcTransportError(error: unknown, boundary: 'protocol' | 'connection' = 'protocol'): Error {
  if (error instanceof AgentMuxError) return error
  const errno = (error as { code?: string })?.code
  const unavailable = boundary === 'connection' && (errno === 'ENOENT' || errno === 'ECONNREFUSED')
  return new AgentMuxError(unavailable ? 'RPC owner is unavailable.' : 'RPC connection failed; its business outcome is unconfirmed.',
    unavailable ? 'CONTROL_UNAVAILABLE'
      : boundary === 'connection' ? 'CONTROL_CONNECTION_FAILED' : 'CONTROL_PROTOCOL_ERROR')
}
