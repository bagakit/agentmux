import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { projectConversationTimeline, type ConversationCheckpoint, type ConversationUnit } from '@agentmux/core/conversation'
import type { AgentSessionHistoryItem, AgentTimelineItem } from '@agentmux/core'
import type { RoomBinding } from '@agentmux/core/connections'
import { publicationContent } from '../src/publication-content.js'
import { PublicationStore } from '../src/publication-store.js'
import { publicationPage } from './fixtures/publication-page.js'

const source = { providerId: 'claude', nativeSessionId: 'native' }
const checkpoint = { agentSessionId: 'agent', source, cursor: 'original-cut' }
const frontier: ConversationCheckpoint = { hostId: 'local', agentSessionId: 'agent', sourceHostId: 'local', frontier: {
  hostId: 'local', agentSessionId: 'agent', scope: { sources: [{ kind: 'native', ...source }, { kind: 'captured' }] },
  cuts: [{ kind: 'native', checkpoint }, { kind: 'captured', epoch: 'captured-epoch', sequence: 0 }]
} }
const binding = { bindingId: 'binding', revision: 1, connectionId: 'connection', application: { domain: 'chat.example', appId: 'application' },
  executionHostId: 'local', agentSessionId: 'agent', externalConversationId: 'room', sourceCheckpoints: [checkpoint], sourceFrontier: frontier,
  scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } } as RoomBinding
const close: Array<() => void> = []
afterEach(() => { for (const fn of close.splice(0)) fn() })
const native = (items: AgentSessionHistoryItem[]) => publicationPage(binding, checkpoint, items).units
const plan = (unit: ConversationUnit) => publicationContent(unit, binding, frontier, { resolved: new Map(), origin: () => undefined })

it('shares ordinary parts and structured questions without exposing tool, reasoning, activity or internal collaboration', () => {
  const items: AgentSessionHistoryItem[] = [
    { id: 'reply', kind: 'assistant-message', messagePhase: 'progress', contentParts: [
      { kind: 'text', text: 'Public progress', contentEligibility: 'public' },
      { kind: 'reasoning', text: 'Internal reasoning', contentEligibility: 'public' },
      { kind: 'text', text: 'Internal projected metadata', contentRole: 'tool', contentEligibility: 'public' },
      { kind: 'tool-call', name: 'shell', input: 'Internal command', contentEligibility: 'public' },
      { kind: 'tool-result', output: 'Internal output', contentEligibility: 'public' },
      { kind: 'resource', resourceType: 'text', reference: 'tool-resource', content: { kind: 'tool-result', encoding: 'json-utf8', byteLength: 10, sha256: 'a'.repeat(64) }, contentEligibility: 'public' }
    ] },
    { id: 'activity', kind: 'activity', contentParts: [{ kind: 'text', text: 'Public tool status', contentEligibility: 'public' }] },
    { id: 'system', kind: 'system-message', contentParts: [{ kind: 'text', text: 'System context', contentEligibility: 'public' }] },
    { id: 'peer', kind: 'assistant-message', collaboration: { kind: 'message', source, sender: 'peer' }, contentParts: [{ kind: 'text', text: 'Internal peer message', contentEligibility: 'public' }] },
    { id: 'question', kind: 'assistant-message', questionRequest: { delivery: 'async', questions: [{ id: 'question', prompt: 'Choose a color', options: [{ id: 'blue', label: 'Blue' }], acceptsText: true }] },
      contentParts: [{ kind: 'tool-call', name: 'question', input: 'Private raw question envelope', contentEligibility: 'public' }] },
    { id: 'answer', kind: 'user-message', questionAnswers: [{ questionId: 'question', answer: 'Blue' }],
      contentParts: [{ kind: 'tool-result', output: 'Private raw answer envelope', contentEligibility: 'public' }] }
  ]
  const plans = native(items).map(plan), text = plans.map(value => value.text).join('\n')
  for (const value of ['Public progress', 'Choose a color', '- Blue', 'Recorded answer (question): Blue']) expect(text).toContain(value)
  for (const value of ['Internal', 'System context', 'Public tool status', 'Private raw']) expect(text).not.toContain(value)
  expect(plans.flatMap(value => value.pieces).every(piece => piece.purpose === 'conversation')).toBe(true)
  expect(plans.flatMap(value => value.gaps)).toEqual([])
})

it('a shared event cannot give its detail tool record or tool fields ordinary-message purpose', () => {
  const items: AgentTimelineItem[] = [
    { id: 'user', agentSessionId: 'agent', kind: 'user_message', source: 'user', status: 'complete', title: 'Input', createdAt: 1, updatedAt: 1,
      authorHuman: true, publicContent: 'confirmed', content: 'Human terminal input', toolInput: 'Hidden attached tool input' },
    { id: 'tool', agentSessionId: 'agent', kind: 'tool_call', source: 'native-hook', status: 'complete', title: 'Tool', createdAt: 2, updatedAt: 2,
      contentEligibility: 'public', content: 'Public tool prose', toolOutput: 'Public tool output',
      conversation: { sameEvent: { hostId: 'local', agentSessionId: 'agent', source: { kind: 'captured', recordId: 'user' } } } }
  ]
  const projected = projectConversationTimeline({ agentSessionId: 'agent', executionHostId: 'local', timeline: { agentSessionId: 'agent', items } })
  for (const record of projected.records) record.order = { kind: 'captured-stream', epoch: 'captured-epoch', firstSequence: 1, sequence: 1 }
  const plans = projected.events.map(event => plan({ event, records: projected.records.filter(record => event.recordIds.includes(record.id)) }))
  expect(plans.map(value => value.text).join('\n')).toContain('Human terminal input')
  expect(plans.map(value => value.text).join('\n')).not.toMatch(/tool input|tool prose|tool output/u)
})

it('uses exact adopted input attribution without silencing the Agent reply or guessing an unknown author', () => {
  const units = native([{ id: 'adopted-input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Internal adopted input', contentEligibility: 'public' }] },
    { id: 'public-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Public independent reply', contentEligibility: 'public' }] }])
  const input = units.find(unit => unit.records[0]!.original.item.id === 'adopted-input')!
  input.event = { ...input.event, author: { kind: 'agent', agentSessionId: 'peer-agent' } }
  expect(plan(input).text).toBe('')
  expect(units.map(plan).map(value => value.text).join('')).toContain('Public independent reply')
  const original = input.records[0]!.original
  if (original.kind !== 'native') throw Error('Expected native original')
  original.item.conversation = { adoptedInput: { key: { kind: 'message', agentSessionId: 'agent', messageId: 'original-message', expectedRun: { runId: 'original-run' } } } }
  input.event = { ...input.event, author: { kind: 'unknown' } }
  expect(plan(input)).toMatchObject({ text: '', gaps: [expect.objectContaining({ reason: 'public-content-unconfirmed' })] })
})

it('rechecks old public pending purpose, cancels an unsent tool and preserves its original payload', () => {
  const db = new DatabaseSync(':memory:'); close.push(() => db.close())
  const store = new PublicationStore(db)
  const original = publicationPage(binding, checkpoint, [{ id: 'old', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Old public bytes', contentEligibility: 'public' }] }])
  const boundary = { ...binding, sourceFrontier: original.page.checkpoint }
  store.commitPage(boundary, store.checkpoint(boundary, 'local'), original.page, () => true, original)
  const operation = store.list(binding)[0]!
  for (const row of db.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation'").all()) {
    const intent = JSON.parse(String(row.decision_json)); delete intent.purpose
    db.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(intent), Number(row.rowid))
  }
  expect(store.pendingRecords(operation)).toHaveLength(1)
  const actual = native([{ id: 'old', kind: 'activity', contentParts: [{ kind: 'tool-result', output: 'Old public bytes', contentEligibility: 'public' }] }])[0]!
  const originals = new Map([[actual.records[0]!.id, { unit: actual, frontier, resolved: new Map() }]])
  expect(store.qualifyPending(binding, operation, originals, frontier)).toBe('cancelled')
  expect(store.inspect(operation.operationId)).toMatchObject({ state: 'cancelled', reason: 'outside-conversation-scope', payload: operation.payload })
  expect(store.coverage(binding).gaps).toEqual([])
  expect(store.next(binding)).toBeNull()
})
