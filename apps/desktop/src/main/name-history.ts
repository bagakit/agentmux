import { displayLabelDocument, type AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { AgentMuxNameChangeRecord, AgentMuxNameHistoryQuery, AgentMuxNameHistoryPage } from '@agentmux/core/control'
import type { openDemandStore } from '@agentmux/demand'

/** Host-specific owners are joined here; Core never interprets a Goal or a Desktop object. */
export async function desktopNameHistory(spatial: AgentMuxSpatialStateStore,
  demands: ReturnType<typeof openDemandStore>, query: AgentMuxNameHistoryQuery): Promise<AgentMuxNameHistoryPage> {
  const limit = query.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Name history limit must be between 1 and 100.')
  const records: AgentMuxNameChangeRecord[] = []
  if (query.target?.kind !== 'demand') {
    const state = await spatial.read()
    if (!state) throw new Error('The original spatial name history has not been confirmed. Restore its document and retry.')
    records.push(...displayLabelDocument(state.graph).records)
  }
  if (!query.target || query.target.kind === 'demand') {
    // One owner snapshot retains names of deleted targets and avoids rereading every page.
    const snapshot = await demands.snapshot()
    records.push(...snapshot.nameHistory)
  }
  const sorted = records.filter(record => !query.target || record.target.kind === query.target.kind && record.target.id === query.target.id)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const index = query.afterId === undefined ? -1 : sorted.findIndex(record => record.id === query.afterId)
  if (query.afterId !== undefined && index < 0) throw new Error('Name history cursor is not in this target history. Read its first page again.')
  const page = sorted.slice(index + 1, index + 1 + limit)
  return { records: page, nextCursor: index + 1 + page.length < sorted.length ? page.at(-1)!.id : null,
    coverage: 'host', diskAcknowledgement: 'not-observed' }
}
