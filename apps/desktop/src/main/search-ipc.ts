import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxSearchInput, AgentMuxSearchPage } from '@agentmux/core/search'
import { SessionHistoryReadOwners } from './session-history-read'
import { sessionInputOperationResult } from '../shared/session-input-result'

type SearchIpcPorts = {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  trust(channel: 'search:query' | 'search:cancel', event: IpcMainInvokeEvent): void
  query(input: AgentMuxSearchInput, signal: AbortSignal): Promise<AgentMuxSearchPage>
}
/** Desktop owns only sender trust and read lifetime; the original public Core service owns the query. */
export function registerSearchIpc(ports: SearchIpcPorts) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('search:query', (event, token: string, input: AgentMuxSearchInput) => {
    ports.trust('search:query', event)
    return sessionInputOperationResult(() => reads.read(event.sender, token, signal => ports.query(input, signal)))
  })
  ports.handle('search:cancel', (event, token: string) => {
    ports.trust('search:cancel', event)
    reads.cancel(event.sender.id, token)
  })
  return { dispose: () => reads.dispose() }
}
