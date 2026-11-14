import { api } from './api'
import { workbenchInputArchiveEligible } from '../../../shared/workbench-user-state'
import type { AgentSteerQueueEntry } from '../store'

export type WorkbenchInputArchiveEntry = { ownerKey: string; entry: AgentSteerQueueEntry }
type ArchiveQuery = Parameters<typeof api.ui.readWorkbenchInputArchive>[0]

export async function readWorkbenchInputArchive(query: ArchiveQuery) {
  const page = await api.ui.readWorkbenchInputArchive(query)
  const entries = page.entries.map(({ ownerKey, entry }): WorkbenchInputArchiveEntry => {
    if (query.ownerKey !== undefined && ownerKey !== query.ownerKey ||
        query.operationId !== undefined && entry.operationId !== query.operationId ||
        !workbenchInputArchiveEligible(entry) || typeof entry.text !== 'string') {
      throw new Error('Reading the saved input archive returned a different or invalid original record. Refresh the original archive.')
    }
    return { ownerKey, entry: entry as AgentSteerQueueEntry }
  })
  return { entries, nextCursor: page.nextCursor }
}

export function archivedInputMatchesSession(entry: AgentSteerQueueEntry, hostId: string, agentSessionId: string): boolean {
  return entry.directInputControl?.hostId === hostId && entry.directInputControl.agentSessionId === agentSessionId
}

export async function readArchivedInputForSession(ownerKey: string, target: { hostId: string; agentSessionId: string }, operationId: string) {
  const page = await readWorkbenchInputArchive({ ownerKey, operationId, limit: 2 })
  const entries = page.entries.filter(item => archivedInputMatchesSession(item.entry, target.hostId, target.agentSessionId))
  if (entries.length > 1 || page.nextCursor !== null) {
    throw new Error('More than one saved input shares this original operation. Review its archived records before choosing an action.')
  }
  return entries[0]?.entry
}
