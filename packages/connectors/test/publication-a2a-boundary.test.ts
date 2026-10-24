import { expect, it } from 'vitest'
import { projectConversationTimeline, type ConversationCheckpoint, type ConversationUnit } from '@agentmux/core/conversation'
import { createNativeInputCorrelation } from '../../core/src/native-input-correlation.js'
import { publicationNotifications } from '../src/publication-a2a.js'

const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-notice' }
const source = { providerId: 'codex', nativeSessionId: 'original-native' }
const start: ConversationCheckpoint = { hostId: 'local', agentSessionId: 'recipient', sourceHostId: 'local', frontier: {
  hostId: 'local', agentSessionId: 'recipient', scope: { sources: [{ kind: 'captured' }, { kind: 'native', ...source }] },
  cuts: [{ kind: 'captured', epoch: 'original-epoch', sequence: 10, inputJournal: { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 10 } },
    { kind: 'native', checkpoint: { agentSessionId: 'recipient', source, cursor: 'original-cut' } }]
} }
function unit(withNative = true): ConversationUnit {
  const timeline = projectConversationTimeline({ agentSessionId: 'recipient', executionHostId: 'local',
    timeline: { agentSessionId: 'recipient', revision: 1, items: [{ id: 'captured-notice', agentSessionId: 'recipient', kind: 'system_message', source: 'agentmux', title: 'Original notice',
      status: 'complete', createdAt: 1, updatedAt: 1, content: 'Original notification wire', a2aNotificationId: key.submissionId, inputRef: key }] },
    ...(withNative ? { historyPage: { agentSessionId: 'recipient', source, nextCursor: null, items: [{ id: 'native-notice', kind: 'user-message' as const, contentParts: [],
      conversation: { nativeInput: { source, semanticItemId: 'original-native-item', turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(key) }, adoptedInput: { key, purpose: 'a2a-notification' as const } } }] } } : {}) })
  for (const record of timeline.records) if (record.original.kind === 'captured') record.order = { kind: 'captured-stream', epoch: 'original-epoch', firstSequence: 11 }
  return { event: timeline.events[0]!, records: timeline.records }
}

it('keeps a before-start captured notification and its canonical native alias outside the shared boundary', () => {
  const original = unit(), captured = original.records.find(record => record.original.kind === 'captured')!
  captured.order = { kind: 'captured-stream', epoch: 'original-epoch', firstSequence: 10 }
  expect(publicationNotifications(original, start)).toEqual([])
  captured.order = { kind: 'captured-stream', epoch: 'other-epoch', firstSequence: 11 }
  expect(publicationNotifications(original, start)).toEqual([])
  captured.order = { kind: 'captured-stream', epoch: 'original-epoch', firstSequence: 11 }
  expect(publicationNotifications(original, start)).toHaveLength(2)
})

it('uses the exact captured input-journal origin without letting a native alias reopen an earlier input', () => {
  const original = unit(), captured = original.records.find(record => record.original.kind === 'captured')!
  if (captured.original.kind !== 'captured') throw Error('Original captured notification required')
  for (const origin of [
    { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 10 },
    { queueId: 'other-queue', incarnation: 'original-incarnation', sequence: 11 },
    { queueId: 'original-queue', incarnation: 'other-incarnation', sequence: 11 }
  ]) {
    captured.original.item.inputOrigin = origin
    expect(publicationNotifications(original, start)).toEqual([])
  }
  captured.original.item.inputOrigin = { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 11 }
  expect(publicationNotifications(original, start)).toHaveLength(2)
})

it('retains a qualified empty native notification by its real record, without inventing a content selector', () => {
  const original = unit(), native = original.records.filter(record => record.original.kind === 'native')
  const targets = publicationNotifications({ ...original, records: native }, start)
  expect(targets).toHaveLength(1)
  expect(targets[0]).toMatchObject({ notificationId: key.submissionId, key, record: native[0]!.reference, revision: native[0]!.revision })
  expect(targets[0]!.part).toBeUndefined()
})
