import { parseConnectionParams, type ConnectionServiceConfigure } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'

/** Submitted input only. The current service and its receipts belong to ConnectionHost. */
export type ConnectorServiceIntent = {
  input: ConnectionServiceConfigure
  /** Absent on retained older requests; it never authorizes discovery or replay. */
  hostingTarget?: ConnectionHostingTarget
  phase: 'not-dispatched' | 'may-have-dispatched'
}

export function restoredConnectorServiceIntents(value: unknown): Record<string, ConnectorServiceIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, ConnectorServiceIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const entry = raw as ConnectorServiceIntent
      const input = parseConnectionParams('connection.service.configure', entry.input)
      if (key !== input.operationId) continue
      const hostingTarget = readConnectionHostingTarget(entry.hostingTarget)
      result[key] = { input, ...(hostingTarget ? { hostingTarget } : {}), phase: entry.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched' }
    } catch { /* Invalid saved correlation cannot dispatch or change the service. */ }
  }
  return result
}
