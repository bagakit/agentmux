import type { AgentSessionUserMessage } from '@agentmux/core'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import type { SessionInputGroup } from '@agentmux/core/conversation'
import { inputMailboxItemKey, inputMailboxKey } from '@agentmux/client-ui/use-agent-input-mailbox'
import type { ComposerQueuedMessage } from '../components/ComposerOutbox'
import { mailboxMessageKey } from './session-mailbox-messages'

export type MailboxInputRow =
  | { kind: 'journal'; key: string; time: number; item: AgentInputMailboxItem; group: SessionInputGroup; local: readonly ComposerQueuedMessage[] }
  | { kind: 'history'; key: string; time: number | undefined; group: SessionInputGroup }
  | { kind: 'local'; key: string; time: number | undefined; item: ComposerQueuedMessage; history?: AgentSessionUserMessage }

/** Presentation only: Core supplies membership; the queue owner supplies delivery and actions. */
export function projectMailboxInputs({ hostId, sourceHostId, groups, queued, retainedLocal }: {
  hostId: string; sourceHostId?: string | undefined; groups: readonly SessionInputGroup[]; queued: readonly ComposerQueuedMessage[]; retainedLocal?: ComposerQueuedMessage | undefined
}) {
  const originalKey = (item: ComposerQueuedMessage) => item.inputOrigin ? inputMailboxKey(item.inputOrigin.hostId, item.inputOrigin.key) : undefined
  const localByInput = new Map<string, ComposerQueuedMessage[]>()
  for (const item of queued) {
    const key = originalKey(item)
    if (key === undefined) continue
    const originals = localByInput.get(key) ?? []
    originals.push(item); localByInput.set(key, originals)
  }
  const originalHistory = new Map<string, AgentSessionUserMessage | null>()
  for (const group of groups) for (const message of group.messages) {
    if (!group.primary || !sourceHostId || message.source.kind !== 'captured' || message.publicContent !== 'confirmed' ||
      !message.inputRef || message.sourceRecord?.record.hostId !== sourceHostId ||
      message.sourceRecord.record.agentSessionId !== message.inputRef.agentSessionId) continue
    const key = inputMailboxKey(hostId, message.inputRef)
    const previous = originalHistory.get(key)
    originalHistory.set(key, previous === undefined || previous === group.primary ? group.primary : null)
  }
  const journalKeys = new Set<string>()
  const rows: MailboxInputRow[] = []
  const journalRows: Extract<MailboxInputRow, { kind: 'journal' }>[] = []
  for (const group of groups) {
    for (const item of group.mailbox) {
      const key = inputMailboxItemKey(hostId, item)
      journalKeys.add(key)
      const row: Extract<MailboxInputRow, { kind: 'journal' }> = { kind: 'journal', key, time: item.recordedAt, item, group, local: localByInput.get(key) ?? [] }
      journalRows.push(row)
      if (!retainedLocal || !row.local.includes(retainedLocal)) rows.push(row)
    }
    if (!group.mailbox.length && group.primary) rows.push({ kind: 'history',
      key: mailboxMessageKey({ message: group.primary }), time: group.primary.recordedAt, group })
  }
  const pendingIntents: ComposerQueuedMessage[] = [], pending: ComposerQueuedMessage[] = []
  for (const item of queued) {
    const key = originalKey(item)
    const journaled = key !== undefined && journalKeys.has(key)
    if (item.archived) {
      if (!journaled || item === retainedLocal) {
        const history = key === undefined ? undefined : originalHistory.get(key)
        rows.push({ kind: 'local', key: `queue:${item.id}`, time: item.enqueuedAt, item, ...(history ? { history } : {}) })
      }
    } else if (item.inputControlled || !item.confirmed) {
      pendingIntents.push(item)
      if (!journaled || item === retainedLocal) pending.push(item)
    }
  }
  rows.sort((a, b) => a.time === undefined ? b.time === undefined ? 0 : 1 : b.time === undefined ? -1 : b.time - a.time)
  return { rows, journalRows, pending, pendingIntents }
}
