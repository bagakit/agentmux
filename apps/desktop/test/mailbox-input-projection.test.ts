import { expect, it } from 'vitest'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import type { SessionInputGroup } from '@agentmux/core/conversation'
import type { ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'
import { projectMailboxInputs } from '../src/renderer/src/lib/mailbox-input-projection'

const key = { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, submissionId: 'original-input' }
const journal: AgentInputMailboxItem = { kind: 'submission', key, sequence: 1, recordedAt: 2, record: null }
const group: SessionInputGroup = { id: 'original-group', primary: null, messages: [], mailbox: [journal], author: { kind: 'unknown' } }
const original: ComposerQueuedMessage = { id: key.submissionId, inputOrigin: { hostId: 'original-host', key },
  text: 'Same original body', status: 'deferred', inputControlled: true, unconfirmed: true, deliverable: true }

it('moves a journaled unknown intent behind its original row without dropping its operation or changing owner facts', () => {
  const result = projectMailboxInputs({ hostId: 'original-host', groups: [group], queued: [original] })
  expect(result.pending).toEqual([])
  expect(result.pendingIntents).toEqual([original])
  expect(result.rows).toHaveLength(1)
  const row = result.rows[0]!
  expect(row.kind).toBe('journal')
  if (row.kind !== 'journal') throw new Error('Expected the original journal row')
  expect(row.local).toEqual([original])
  expect(row.local[0]).toBe(original)
  expect(row.item).toBe(journal)
  expect(original.unconfirmed).toBe(true)
  expect(original.confirmed).toBeUndefined()
})

it('retains equal bodies and equal bare IDs from other original scopes as separate local operations', () => {
  const { inputOrigin: _origin, ...unbound } = original
  const originals: ComposerQueuedMessage[] = [
    original,
    { ...original, inputOrigin: { hostId: 'other-host', key } },
    { ...original, inputOrigin: { hostId: 'original-host', key: { ...key, expectedRun: { runId: 'other-run' } } } },
    { ...original, inputOrigin: { hostId: 'original-host', key: { kind: 'message', agentSessionId: key.agentSessionId,
      expectedRun: key.expectedRun, messageId: key.submissionId } } },
    { ...unbound, id: 'unbound-input' }
  ]
  const result = projectMailboxInputs({ hostId: 'original-host', groups: [group], queued: originals })
  expect(result.pending).toEqual(originals.slice(1))
  expect(result.pendingIntents).toEqual(originals)
  const row = result.rows[0]!
  expect(row.kind === 'journal' && row.local).toEqual([original])
})

it('uses the queue owner confirmation and preserves independent archived bodies in display order', () => {
  const { inputOrigin: _origin, ...unbound } = original
  const first = { ...unbound, id: 'first', archived: true as const, enqueuedAt: 1 }
  const second = { ...first, id: 'second', enqueuedAt: 3 }
  const confirmed = { ...unbound, id: 'confirmed', inputControlled: false, confirmed: true }
  const result = projectMailboxInputs({ hostId: 'original-host', groups: [group], queued: [first, second, confirmed] })
  expect(result.pending).toEqual([])
  expect(result.rows.map(row => row.kind)).toEqual(['local', 'journal', 'local'])
  expect(result.rows.filter(row => row.kind === 'local').map(row => row.item)).toEqual([second, first])
})

it('offers archived history navigation only through an original input key in the confirmed source scope', () => {
  const message: AgentSessionUserMessage = { id: 'original-record', rawId: 'original-record', agentSessionId: key.agentSessionId,
    source: { kind: 'captured', submissionId: 'original-record' }, inputRef: key, publicContent: 'confirmed',
    sourceRecord: { revision: 'original-version', record: { hostId: 'source-host', agentSessionId: key.agentSessionId,
      source: { kind: 'captured', recordId: 'original-record' } } },
    author: { kind: 'human' }, content: original.text, contentParts: [] }
  const historyGroup: SessionInputGroup = { id: 'original-history', primary: message, messages: [message], mailbox: [], author: message.author }
  const archived = { ...original, archived: true as const }
  const read = (sourceHostId?: string, entry = archived) => projectMailboxInputs({ hostId: 'original-host', sourceHostId,
    groups: [historyGroup], queued: [entry] }).rows.find(row => row.kind === 'local')
  const row = read('source-host')
  expect(row?.kind === 'local' && row.history).toBe(message)
  for (const other of [read(), read('other-source'), read('source-host', {
    ...archived, inputOrigin: { hostId: 'other-host', key }
  })]) expect(other?.kind === 'local' && other.history).toBeUndefined()
})
