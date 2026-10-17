import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'

type Ports = {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  trust(channel: 'hosts:inspect' | 'hosts:network' | 'hosts:cancelInspect', event: IpcMainInvokeEvent): void
  call<M extends 'settings.hosts.inspect' | 'settings.hosts.network'>(method: M, params: AgentMuxRpcParams<M>, context: { signal: AbortSignal }): Promise<AgentMuxRpcResult<M>>
}
/** Sender trust and cancellable read lifetimes only. Public Core owns all observed facts. */
export function registerHostRuntimeObservationIpc(ports: Ports) {
  const reads = new SessionHistoryReadOwners()
  const methods = { 'hosts:inspect': 'settings.hosts.inspect', 'hosts:network': 'settings.hosts.network' } as const
  for (const channel of Object.keys(methods) as Array<keyof typeof methods>) ports.handle(channel, (event, token: string, host: HostConfig) => {
    ports.trust(channel, event)
    return sessionInputOperationResult(() => reads.read(event.sender, token, signal => ports.call(methods[channel], { hostId: host.id, expected: host }, { signal })))
  })
  ports.handle('hosts:cancelInspect', (event, token: string) => {
    ports.trust('hosts:cancelInspect', event)
    reads.cancel(event.sender.id, token)
  })
  return { dispose: () => reads.dispose() }
}
