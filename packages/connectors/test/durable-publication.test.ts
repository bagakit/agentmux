import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import type { ConversationChangesPage, ConversationCheckpoint } from '@agentmux/core/conversation'
import type { PublicationPreparer } from '../src/publication-wire.js'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'

const adapter: PublicationPreparer = { adapterId: 'fixture', renderVersion: 'speech-v1', supportedRenderVersions: ['speech-v1'],
  prepare: operation => ({ adapterId: 'fixture', renderVersion: 'speech-v1', requestKey: operation.operationId,
    request: { method: operation.effect === 'withdraw' ? 'DELETE' : operation.mapping ? 'PATCH' : 'POST', path: '/messages',
      body: JSON.stringify({ audience: operation.target.externalConversationId, mapping: operation.mapping, payload: operation.payload }) } }) }
const databases: DatabaseSync[] = [], directories: string[] = []
afterEach(async () => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const checkpoint = (cursor = 'original-cut'): ConversationCheckpoint => ({ agentSessionId: 'session-a', source: { providerId: 'claude', nativeSessionId: 'native-a' }, cursor })
const boundary: PublicationBoundary = { bindingId: 'binding-a', revision: 1, connectionId: 'connection-a', application: { domain: 'chat.example', appId: 'app-a' },
  executionHostId: 'host-a', agentSessionId: 'session-a', externalConversationId: 'room-a', sourceCheckpoints: [checkpoint()] }
const speech = (id: string, text = 'Same original speech'): AgentSessionHistoryItem => ({ id, kind: 'assistant-message', contentParts: [{ kind: 'text', text }] })
const page = (items: AgentSessionHistoryItem[], cursor = 'next-cut'): ConversationChangesPage => ({ hostId: boundary.executionHostId, agentSessionId: boundary.agentSessionId,
  source: checkpoint().source, items, checkpoint: checkpoint(cursor), more: false })
function store() { const database = new DatabaseSync(':memory:'); databases.push(database); const owner = new PublicationStore(database); owner.checkpoint(boundary, checkpoint()); return owner }

it('commits every required original speech and explicit skip with the same source frontier, excluding internal parts', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([
    { id: 'input-a', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Private original input' }] },
    { ...speech('reply-a'), contentParts: [{ kind: 'reasoning', text: 'Private reasoning' }, { kind: 'tool-call', name: 'internal', input: 'Private arguments' },
      { kind: 'text', text: 'Shared speech' }, { kind: 'resource', resourceType: 'file', reference: 'private-resource-reference' }, { kind: 'tool-result', output: 'Private result' }], title: 'Private metadata' },
    speech('reply-b', 'Shared speech'), { id: 'activity-a', kind: 'activity', contentParts: [] }
  ]), () => true)
  const operations = owner.list(boundary)
  expect(operations).toHaveLength(2)
  expect(new Set(operations.map(value => value.operationId)).size).toBe(2)
  expect(operations.map(value => value.reference.source.recordId)).toEqual(['reply-a', 'reply-b'])
  expect(owner.list(boundary, 1, operations[0]!.operationId)).toEqual([operations[1]])
  expect(() => owner.list(boundary, 1, 'foreign-operation')).toThrowError(/another audience/)
  expect(operations.map(value => value.payload)).toEqual([{ kind: 'speech', text: 'Shared speech' }, { kind: 'speech', text: 'Shared speech' }])
  expect(JSON.stringify(operations)).not.toMatch(/Private|private-resource-reference/)
  expect(owner.database.prepare('SELECT record_id, reason FROM connector_publication_decision ORDER BY record_id').all()).toEqual([
    { record_id: 'activity-a', reason: 'not-assistant-speech' }, { record_id: 'input-a', reason: 'not-assistant-speech' }
  ])
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint('next-cut'))
  expect(() => owner.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)).toThrowError(/different saved frontier/)
  expect(owner.list(boundary)).toHaveLength(2)
})

it('native failure at frontier persistence rolls back all selected effects and skips, preserving the original cut', () => {
  const owner = store()
  owner.database.exec("CREATE TRIGGER reject_frontier BEFORE UPDATE ON connector_publication_frontier BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END")
  expect(() => owner.commitPage(boundary, checkpoint(), page([speech('reply-a'), { id: 'input-a', kind: 'user-message', contentParts: [] }]), () => true))
    .toThrowError(/could not confirm the original page/)
  expect(owner.list(boundary)).toEqual([])
  expect(owner.database.prepare('SELECT * FROM connector_publication_decision').all()).toEqual([])
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint())
  owner.database.exec('DROP TRIGGER reject_frontier')
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  expect(owner.list(boundary)).toHaveLength(1)
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint('next-cut'))
})

it('wrong Host, Session, source, saved cut and revoked audience cannot advance publication or alter the healthy Agent', () => {
  const owner = store()
  for (const foreign of [{ ...page([speech('a')]), hostId: 'other-host' }, { ...page([speech('a')]), agentSessionId: 'other-session' },
    { ...page([speech('a')]), source: { ...checkpoint().source, nativeSessionId: 'other-source' } }]) {
    expect(() => owner.commitPage(boundary, checkpoint(), foreign, () => true)).toThrow()
  }
  expect(() => owner.commitPage(boundary, checkpoint(), page([speech('a')]), () => false)).toThrowError(/no longer authorizes/)
  expect(() => owner.checkpoint(boundary, checkpoint('foreign-cut'))).toThrowError(/original Binding source/)
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint())
  expect(owner.list(boundary)).toEqual([])
})

it('coalesces only undispatched revisions and never overtakes unknown original effects or changes their recipient', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'First')], 'cut-1'), () => true)
  const first = owner.list(boundary)[0]!
  owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'Second')], 'cut-2'), () => true)
  const second = owner.list(boundary)[1]!
  expect(owner.inspect(first.operationId)?.state).toBe('superseded')
  expect(second.predecessorOperationId).toBeUndefined()
  const claimed = owner.claimNext(boundary, () => true, adapter)!
  expect(claimed.operationId).toBe(second.operationId); expect(claimed.state).toBe('dispatching')
  expect(owner.inspect(second.operationId)?.state).toBe('dispatching')
  owner.settle(second.operationId, owner.inspect(second.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  owner.commitPage(boundary, checkpoint('cut-2'), page([speech('reply-a', 'Third'), speech('reply-b')], 'cut-3'), () => true)
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  expect(() => owner.retry(second.operationId, () => true)).toThrowError(/not confirmed non-application/)
  expect(owner.inspect(second.operationId)).toMatchObject({ target: { externalConversationId: 'room-a' }, payload: { text: 'Second' } })
  const mapping = { messageId: 'platform-a', threadId: 'original-thread' }
  owner.settle(second.operationId, owner.inspect(second.operationId)!.attempt!, { state: 'confirmed', mapping })
  const third = owner.claimNext(boundary, () => true, adapter)!
  expect(third).toMatchObject({ predecessorOperationId: second.operationId, mapping, payload: { text: 'Third' }, target: { externalConversationId: 'room-a' } })
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  owner.settle(third.operationId, owner.inspect(third.operationId)!.attempt!, { state: 'confirmed', mapping })
  expect(owner.claimNext(boundary, () => true, adapter)?.reference.source.recordId).toBe('reply-b')
  expect(() => owner.settle(second.operationId, owner.inspect(second.operationId)!.attempt!, { state: 'confirmed', mapping: { messageId: 'replacement' } })).toThrowError(/cannot be replaced/)
})

it('restarts with the same unresolved effect, original audience and payload; only authoritative non-application admits explicit same-ID retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-')); directories.push(directory)
  const path = join(directory, 'connections.sqlite'), firstDb = new DatabaseSync(path); databases.push(firstDb)
  const first = new PublicationStore(firstDb); first.checkpoint(boundary, checkpoint())
  first.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  const dispatched = first.claimNext(boundary, () => true, adapter)!
  firstDb.close()
  const secondDb = new DatabaseSync(path); databases.push(secondDb)
  const restored = new PublicationStore(secondDb)
  expect(restored.inspect(dispatched.operationId)).toEqual(dispatched)
  expect(restored.checkpoint(boundary, checkpoint())).toEqual(checkpoint('next-cut'))
  expect(restored.claimNext(boundary, () => true, adapter)).toBeNull()
  expect(() => restored.retry(dispatched.operationId, () => true)).toThrowError(/not confirmed non-application/)
  restored.settle(dispatched.operationId, restored.inspect(dispatched.operationId)!.attempt!, { state: 'not-applied', reason: 'platform-rejected' })
  expect(() => restored.retry(dispatched.operationId, () => false)).toThrowError(/no longer authorizes/)
  const pending = restored.retry(dispatched.operationId, () => true)
  const receipt = { state: 'not-applied', reason: 'platform-rejected' }
  expect(pending).toEqual({ ...dispatched, state: 'pending', receipt })
  expect(restored.claimNext(boundary, () => true, adapter)).toEqual({ ...dispatched, attempt: dispatched.attempt! + 1, receipt })
})

it('retains old exact operations after relinking and bounds inspection without allowing the new audience to claim them', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  const original = owner.claimNext(boundary, () => true, adapter)!
  const next = { ...boundary, revision: 2, externalConversationId: 'room-b', sourceCheckpoints: [checkpoint('new-authorized-cut')] }
  owner.checkpoint(next, checkpoint('new-authorized-cut'))
  owner.commitPage(next, checkpoint('new-authorized-cut'), page([speech('reply-a')], 'next-room-cut'), () => true)
  const nextOperation = owner.claimNext(next, () => true, adapter)!
  expect(nextOperation.operationId).not.toBe(original.operationId)
  expect(nextOperation.target.externalConversationId).toBe('room-b')
  expect(owner.inspect(original.operationId)).toEqual(original)
  expect(owner.claimNext(boundary, () => false, adapter)).toBeNull()
  expect(() => owner.list(boundary, 0)).toThrowError(/limit from 1 to 100/)
})

it('publishes a genuine content reversion and retains an exact confirmed update mapping', () => {
  const owner = store(), mapping = { messageId: 'original-message', threadId: 'original-thread' }
  for (const [index, text] of ['First', 'Second', 'First'].entries()) {
    owner.commitPage(boundary, checkpoint(index ? `cut-${index}` : 'original-cut'), page([speech('reply-a', text)], `cut-${index + 1}`), () => true)
    const operation = owner.claimNext(boundary, () => true, adapter)!
    expect(operation.payload.text).toBe(text)
    if (index) expect(() => owner.settle(operation.operationId, owner.inspect(operation.operationId)!.attempt!, { state: 'confirmed', mapping: { messageId: 'other-message' } })).toThrowError(/original exact message/)
    owner.settle(operation.operationId, owner.inspect(operation.operationId)!.attempt!, { state: 'confirmed', mapping })
  }
  const operations = owner.list(boundary)
  expect(new Set(operations.map(operation => operation.operationId)).size).toBe(3)
  expect(operations[0]!.sourceRevision).toBe(operations[2]!.sourceRevision)
  owner.commitPage(boundary, checkpoint('cut-3'), page([speech('reply-a', 'First')], 'cut-4'), () => true)
  expect(owner.list(boundary)).toHaveLength(3)
  expect(owner.settle(operations[2]!.operationId, owner.inspect(operations[2]!.operationId)!.attempt!, { state: 'confirmed', mapping: { threadId: 'original-thread', messageId: 'original-message' } }).mapping).toEqual(mapping)
})

it('a later non-public revision cancels only undispatched speech and can explicitly return to genuine speech', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')], 'cut-1'), () => true)
  const original = owner.list(boundary)[0]!
  owner.commitPage(boundary, checkpoint('cut-1'), page([{ id: 'reply-a', kind: 'activity', contentParts: [] }], 'cut-2'), () => true)
  expect(owner.inspect(original.operationId)).toMatchObject({ state: 'cancelled', reason: 'original-speech-withdrawn' })
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  owner.commitPage(boundary, checkpoint('cut-2'), page([speech('reply-a')], 'cut-3'), () => true)
  const returned = owner.claimNext(boundary, () => true, adapter)!
  expect(returned.operationId).not.toBe(original.operationId)
  expect(returned.predecessorOperationId).toBeUndefined()
  owner.commitPage(boundary, checkpoint('cut-3'), page([{ id: 'reply-a', kind: 'activity', contentParts: [] }], 'cut-4'), () => true)
  expect(owner.inspect(returned.operationId)?.state).toBe('dispatching')
})

it('source and mapping object property order cannot change an accepted identity', () => {
  const owner = store()
  const reordered = { cursor: 'original-cut', source: { nativeSessionId: 'native-a', providerId: 'claude' }, agentSessionId: 'session-a' }
  expect(owner.checkpoint(boundary, reordered)).toEqual(checkpoint())
  owner.commitPage(boundary, reordered, page([speech('reply-a')]), () => true)
  expect(owner.list(boundary)).toHaveLength(1)
})

it('a materialized original text resource cannot be silently skipped or published as incomplete speech', () => {
  const owner = store()
  expect(() => owner.commitPage(boundary, checkpoint(), page([{ ...speech('large'), contentParts: [
    { kind: 'text', text: 'Only one part of the original speech' },
    { kind: 'resource', resourceType: 'text', reference: 'original-resource', content: { kind: 'text', encoding: 'json-utf8', byteLength: 300_000, sha256: 'a'.repeat(64) } }
  ] }]), () => true)).toThrowError(/complete original speech resource/)
  expect(owner.list(boundary)).toEqual([])
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint())
})

it('fragments complete original Unicode speech exactly and records each original platform effect independently', () => {
  const owner = store(), text = '准确原文🙂\n'.repeat(12)
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', text)]), () => true, { fragmentBytes: 16 })
  const operations = owner.list(boundary, 100)
  expect(operations.length).toBeGreaterThan(2)
  expect(operations.map(operation => operation.payload.text).join('')).toBe(text)
  expect(new Set(operations.map(operation => operation.operationId)).size).toBe(operations.length)
  expect(new Set(operations.map(operation => operation.projectionId)).size).toBe(1)
  for (const [ordinal, operation] of operations.entries()) {
    expect(operation.fragment).toEqual({ ordinal, count: operations.length })
    expect(Buffer.byteLength(operation.payload.text)).toBeLessThanOrEqual(16)
    expect(owner.claimNext(boundary, () => true, adapter)?.operationId).toBe(operation.operationId)
    owner.settle(operation.operationId, owner.inspect(operation.operationId)!.attempt!, { state: 'confirmed', mapping: { messageId: `original-fragment-${ordinal}` } })
  }
})

it('a shorter revision updates the exact first fragment and withdraws confirmed surplus mappings without substituting a group send', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'Original full speech')], 'cut-1'), () => true, { fragmentBytes: 8 })
  const originals = owner.list(boundary)
  for (const [ordinal, original] of originals.entries()) {
    expect(owner.claimNext(boundary, () => true, adapter)?.operationId).toBe(original.operationId)
    owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'confirmed', mapping: { messageId: `fragment-${ordinal}`, threadId: 'original-thread' } })
  }
  owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'Short')], 'cut-2'), () => true, { fragmentBytes: 8 })
  const updated = owner.claimNext(boundary, () => true, adapter)!
  expect(updated).toMatchObject({ effect: 'upsert', payload: { text: 'Short' }, mapping: { messageId: 'fragment-0', threadId: 'original-thread' } })
  owner.settle(updated.operationId, owner.inspect(updated.operationId)!.attempt!, { state: 'confirmed', mapping: updated.mapping! })
  for (let ordinal = 1; ordinal < originals.length; ordinal++) {
    const withdrawn = owner.claimNext(boundary, () => true, adapter)!
    expect(withdrawn).toMatchObject({ effect: 'withdraw', fragment: { ordinal, count: 1 }, mapping: { messageId: `fragment-${ordinal}`, threadId: 'original-thread' } })
    owner.settle(withdrawn.operationId, owner.inspect(withdrawn.operationId)!.attempt!, { state: 'confirmed', mapping: withdrawn.mapping! })
  }
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
})

it('unknown original fragments block shortening, then return to a fresh create only after confirmed withdrawal', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'Old')], 'cut-1'), () => true)
  const original = owner.claimNext(boundary, () => true, adapter)!
  owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  owner.commitPage(boundary, checkpoint('cut-1'), page([{ id: 'reply-a', kind: 'activity', contentParts: [] }], 'cut-2'), () => true)
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  expect(owner.inspect(original.operationId)).toMatchObject({ state: 'unknown', payload: { text: 'Old' } })
  const mapping = { messageId: 'original-message' }
  owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'confirmed', mapping })
  const withdrawal = owner.claimNext(boundary, () => true, adapter)!
  expect(withdrawal).toMatchObject({ effect: 'withdraw', mapping })
  owner.settle(withdrawal.operationId, owner.inspect(withdrawal.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  owner.commitPage(boundary, checkpoint('cut-2'), page([speech('reply-a', 'New genuine speech')], 'cut-3'), () => true)
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  owner.settle(withdrawal.operationId, owner.inspect(withdrawal.operationId)!.attempt!, { state: 'confirmed', mapping })
  const returned = owner.claimNext(boundary, () => true, adapter)!
  expect(returned).toMatchObject({ effect: 'upsert', payload: { text: 'New genuine speech' } })
  expect(returned.mapping).toBeUndefined()
  expect(returned.operationId).not.toBe(original.operationId)
})

it('superseding a known non-applied fragment retains that receipt while admitting only the newer source version', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'Old')], 'cut-1'), () => true)
  const original = owner.claimNext(boundary, () => true, adapter)!
  const receipt = { state: 'not-applied' as const, reason: 'platform-rejected' }
  owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, receipt)
  owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'New')], 'cut-2'), () => true)
  expect(owner.inspect(original.operationId)).toMatchObject({ state: 'superseded', receipt, payload: { text: 'Old' } })
  expect(owner.claimNext(boundary, () => true, adapter)).toMatchObject({ payload: { text: 'New' } })
  expect(() => owner.retry(original.operationId, () => true)).toThrowError(/not confirmed non-application/)
})

it('a late authoritative non-application advances an already pending newer source without replaying the old body', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'Old')], 'cut-1'), () => true)
  const original = owner.claimNext(boundary, () => true, adapter)!
  owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'New')], 'cut-2'), () => true)
  expect(owner.claimNext(boundary, () => true, adapter)).toBeNull()
  const receipt = { state: 'not-applied' as const, reason: 'platform-rejected' as const }
  expect(owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, receipt)).toMatchObject({ state: 'superseded', receipt, payload: { text: 'Old' } })
  const next = owner.claimNext(boundary, () => true, adapter)!
  expect(next).toMatchObject({ payload: { text: 'New' }, effect: 'upsert' })
  expect(next.predecessorOperationId).toBeUndefined(); expect(next.mapping).toBeUndefined()
  expect(() => owner.retry(original.operationId, () => true)).toThrowError(/not confirmed non-application/)
})

it('a late non-applied create cancels its redundant withdrawal; a late non-applied update retains the earlier exact mapping', () => {
  for (const exists of [false, true]) {
    const owner = store(), mapping = { messageId: 'original-message', threadId: 'original-thread' }
    owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'Original')], 'cut-1'), () => true)
    let attempt = owner.claimNext(boundary, () => true, adapter)!
    if (exists) {
      owner.settle(attempt.operationId, owner.inspect(attempt.operationId)!.attempt!, { state: 'confirmed', mapping })
      owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'Update')], 'cut-2'), () => true)
      attempt = owner.claimNext(boundary, () => true, adapter)!
    }
    owner.settle(attempt.operationId, owner.inspect(attempt.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
    owner.commitPage(boundary, checkpoint(exists ? 'cut-2' : 'cut-1'), page([{ id: 'reply-a', kind: 'activity', contentParts: [] }], 'withdraw-cut'), () => true)
    owner.settle(attempt.operationId, owner.inspect(attempt.operationId)!.attempt!, { state: 'not-applied', reason: 'platform-rejected' })
    const next = owner.claimNext(boundary, () => true, adapter)
    if (exists) expect(next).toMatchObject({ effect: 'withdraw', mapping })
    else expect(next).toBeNull()
  }
})

it('adapter receipt fields cannot rewrite another operation, its audience or the original immutable payload', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a'), speech('reply-b')]), () => true)
  const original = owner.claimNext(boundary, () => true, adapter)!, other = owner.list(boundary)[1]!
  for (const extra of [{ operationId: other.operationId }, { target: { externalConversationId: 'other-room' } }, { diagnostic: 'private platform payload' }]) {
    expect(() => owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'unknown', reason: 'effect-unconfirmed', ...extra } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
  }
  expect(() => owner.settle(original.operationId, owner.inspect(original.operationId)!.attempt!, { state: 'unknown', reason: 'private raw SDK error' } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
  expect(owner.inspect(original.operationId)).toEqual(original)
  expect(owner.inspect(other.operationId)).toEqual(other)
})

it('freezes the complete prepared request with the original effect before dispatch and retains it through same-ID retry', () => {
  const owner = store(), mapping = { messageId: 'original-message', threadId: 'original-thread' }
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a', 'First')], 'cut-1'), () => true)
  const first = owner.claimNext(boundary, () => true, adapter)!
  expect(first.prepared).toEqual(adapter.prepare(first))
  expect(owner.inspect(first.operationId)?.prepared).toEqual(first.prepared)
  owner.settle(first.operationId, owner.inspect(first.operationId)!.attempt!, { state: 'confirmed', mapping })
  owner.commitPage(boundary, checkpoint('cut-1'), page([speech('reply-a', 'Updated')], 'cut-2'), () => true)
  let prepared = 0
  const originalAdapter: PublicationPreparer = { ...adapter, prepare: operation => {
    prepared++
    expect(operation.mapping).toEqual(mapping)
    return { ...adapter.prepare(operation), request: { method: 'PATCH', path: '/messages/original-message', query: { scope: 'original' },
      contentType: 'application/json', body: JSON.stringify({ text: operation.payload.text, thread: operation.mapping?.threadId }) } }
  } }
  const update = owner.claimNext(boundary, () => true, originalAdapter)!
  expect(prepared).toBe(1)
  expect(owner.inspect(update.operationId)?.prepared).toEqual(update.prepared)
  owner.settle(update.operationId, owner.inspect(update.operationId)!.attempt!, { state: 'not-applied', reason: 'platform-rejected' })
  owner.retry(update.operationId, () => true)
  expect(() => owner.claimNext(boundary, () => true, { ...adapter, renderVersion: 'speech-v2', supportedRenderVersions: ['speech-v2'] }))
    .toThrowError(/compatible adapter version/)
  expect(owner.inspect(update.operationId)?.state).toBe('pending')
  const retried = owner.claimNext(boundary, () => true, { ...adapter, renderVersion: 'speech-v2', supportedRenderVersions: ['speech-v1', 'speech-v2'],
    prepare: () => { throw new Error('Original wire must never be rendered twice.') } })!
  expect(retried.prepared).toEqual(update.prepared)
  expect(retried.operationId).toBe(update.operationId)
  expect(retried.target).toEqual(update.target)
})

it('preparation and claim persistence fail before any effect, keeping the original pending work and accepted frontier', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  const original = owner.list(boundary)[0]!
  for (const bad of [
    { ...adapter, prepare: () => { throw new Error('private adapter details') } },
    { ...adapter, prepare: operation => ({ ...adapter.prepare(operation), secret: 'must-not-be-persisted' }) },
    { ...adapter, prepare: operation => ({ ...adapter.prepare(operation), request: { ...adapter.prepare(operation).request, body: 'x'.repeat(4 * 1024 * 1024 + 1) } }) }
  ] satisfies PublicationPreparer[]) {
    expect(() => owner.claimNext(boundary, () => true, bad)).toThrow()
    expect(owner.inspect(original.operationId)).toEqual(original)
  }
  owner.database.exec("CREATE TRIGGER reject_claim BEFORE UPDATE ON connector_publication_operation WHEN NEW.state='dispatching' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  expect(() => owner.claimNext(boundary, () => true, adapter)).toThrowError(/could not confirm/)
  expect(owner.inspect(original.operationId)).toEqual(original)
  expect(owner.checkpoint(boundary, checkpoint())).toEqual(checkpoint('next-cut'))
  owner.database.exec('DROP TRIGGER reject_claim')
  let current = true
  expect(owner.claimNext(boundary, () => current, { ...adapter, prepare: operation => { current = false; return adapter.prepare(operation) } })).toBeNull()
  expect(owner.inspect(original.operationId)).toEqual(original)
})

