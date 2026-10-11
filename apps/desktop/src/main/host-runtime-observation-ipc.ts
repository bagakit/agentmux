import type { IpcMainInvokeEvent } from 'electron'
import type { HostRuntimeObservation } from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'

type Ports = {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  trust(channel: 'hosts:inspect' | 'hosts:cancelInspect', event: IpcMainInvokeEvent): void
  inspect(host: HostConfig, signal: AbortSignal): Promise<HostRuntimeObservation>
}
/** Sender trust and cancellable read lifetimes only. Public Core owns all observed facts. */
export function registerHostRuntimeObservationIpc(ports: Ports) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('hosts:inspect', (event, token: string, host: HostConfig) => {
    ports.trust('hosts:inspect', event)
    return sessionInputOperationResult(() => reads.read(event.sender, token, signal => ports.inspect(host, signal)))
  })
  ports.handle('hosts:cancelInspect', (event, token: string) => {
    ports.trust('hosts:cancelInspect', event)
    reads.cancel(event.sender.id, token)
  })
  return { dispose: () => reads.dispose() }
}
