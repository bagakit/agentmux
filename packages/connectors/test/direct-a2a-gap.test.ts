import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { RoomBinding } from '@agentmux/core/connections'
import { createNativeInputCorrelation } from '../../core/src/native-input-correlation.js'
import { PublicationStore } from '../src/publication-store.js'
import type { PublicationA2A } from '../src/publication-a2a.js'
import { publicationPage } from './fixtures/publication-page.js'

it('direct text-wire qualification closes its exact gap before MID dedup while independent resource gaps remain', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new PublicationStore(db), source = { providerId: 'codex', nativeSessionId: 'original-native' }
    const key = { kind: 'message' as const, agentSessionId: 'recipient', messageId: 'original-mid', expectedRun: { runId: 'original-run' } }
    const checkpoint = { agentSessionId: 'recipient', source, cursor: 'before-original' }
    const boundary = { bindingId: 'original-binding', revision: 1, connectionId: 'original-connection', application: { domain: 'chat.example', appId: 'original-app' },
      executionHostId: 'local', agentSessionId: 'recipient', externalConversationId: 'original-room', sourceCheckpoints: [checkpoint], scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } } as RoomBinding
    for (const id of ['first-source', 'later-source-alias']) {
      const page = publicationPage(boundary, { ...checkpoint, cursor: id }, [{ id, kind: 'user-message', turnId: 'original-turn', conversation: {
        nativeInput: { source, semanticItemId: id, turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(key) }, adoptedInput: { key }
      }, contentParts: [{ kind: 'text', text: 'Raw original input wire', contentEligibility: 'unconfirmed' },
        { kind: 'resource', resourceType: 'file', reference: 'independent-resource', contentEligibility: 'unconfirmed' }] }])
      const unit = page.units[0]!, record = unit.records[0]!
      const original: PublicationA2A = { key, record: record.reference!, revision: record.revision, unavailable: true, messages: [] }
      store.commitPage(boundary, store.checkpoint(boundary, 'local'), page.page, () => true, { ...page, originals: new Map([[unit.event.id, [original]]]) })
      const gap = store.coverage(boundary).gaps.find(gap => gap.code === 'PUBLICATION_A2A_ORIGINAL_UNAVAILABLE' && gap.anchor?.revision === record.revision)!
      expect(gap).toBeTruthy()
      const inspected = { ...unit, event: { ...unit.event, revision: unit.event.revision + ':canonical-update' } }
      store.recoverOriginalMessages(boundary, gap, inspected, [{ ...original, unavailable: false, originalAgentInput: true,
        messages: [{ messageId: key.messageId, senderSessionId: 'original-peer', body: 'Opaque original body', createdAt: 1 }] }], () => true, 4096)
      const remaining = store.coverage(boundary).gaps.filter(gap => gap.reason === 'public-content-unconfirmed' && gap.part?.recordRevision === record.revision)
      expect(remaining).toHaveLength(1); expect(remaining[0]!.part?.selector).toEqual({ kind: 'native-part', partIndex: 1 })
      expect(store.list(boundary).filter(operation => operation.originalMessage)).toHaveLength(1)
    }
  } finally { db.close() }
})
