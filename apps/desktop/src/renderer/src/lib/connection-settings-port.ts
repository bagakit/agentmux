import type { AgentMuxDesktopApi, ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from './api'

export type ConnectionSettingsPort = Pick<AgentMuxDesktopApi['connections'], 'call' | 'storeCredential' | 'inspectCredential'>
export function connectionSettingsPort(target: ConnectionHostingTarget | null): ConnectionSettingsPort {
  if (!target) {
    const unavailable = async () => { throw new Error('The original bot hosting Host is not recorded. The original request is kept; it cannot be checked against another Host.') }
    return { call: unavailable, storeCredential: unavailable, inspectCredential: unavailable }
  }
  const original = { ...target }
  return {
    call: (method, params) => api.connections.call(method, params, original),
    storeCredential: input => api.connections.storeCredential(input, original),
    inspectCredential: operationId => api.connections.inspectCredential(operationId, original)
  }
}
