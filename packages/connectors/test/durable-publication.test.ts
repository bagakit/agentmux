import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import type { ConversationChangesPage, ConversationCheckpoint } from '@agentmux/core/conversation'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'

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
  const claimed = owner.claimNext(boundary, () => true)!
  expect(claimed.operationId).toBe(second.operationId); expect(claimed.state).toBe('dispatching')
  expect(owner.inspect(second.operationId)?.state).toBe('dispatching')
  owner.settle(second.operationId, { state: 'unknown', reason: 'effect-unconfirmed' })
  owner.commitPage(boundary, checkpoint('cut-2'), page([speech('reply-a', 'Third'), speech('reply-b')], 'cut-3'), () => true)
  expect(owner.claimNext(boundary, () => true)).toBeNull()
  expect(() => owner.retry(second.operationId, () => true)).toThrowError(/not confirmed non-application/)
  expect(owner.inspect(second.operationId)).toMatchObject({ target: { externalConversationId: 'room-a' }, payload: { text: 'Second' } })
  const mapping = { messageId: 'platform-a', threadId: 'original-thread' }
  owner.settle(second.operationId, { state: 'confirmed', mapping })
  const third = owner.claimNext(boundary, () => true)!
  expect(third).toMatchObject({ predecessorOperationId: second.operationId, mapping, payload: { text: 'Third' }, target: { externalConversationId: 'room-a' } })
  expect(owner.claimNext(boundary, () => true)).toBeNull()
  owner.settle(third.operationId, { state: 'confirmed', mapping })
  expect(owner.claimNext(boundary, () => true)?.reference.source.recordId).toBe('reply-b')
  expect(() => owner.settle(second.operationId, { state: 'confirmed', mapping: { messageId: 'replacement' } })).toThrowError(/cannot be replaced/)
})

it('restarts with the same unresolved effect, original audience and payload; only authoritative non-application admits explicit same-ID retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-')); directories.push(directory)
  const path = join(directory, 'connections.sqlite'), firstDb = new DatabaseSync(path); databases.push(firstDb)
  const first = new PublicationStore(firstDb); first.checkpoint(boundary, checkpoint())
  first.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  const dispatched = first.claimNext(boundary, () => true)!
  firstDb.close()
  const secondDb = new DatabaseSync(path); databases.push(secondDb)
  const restored = new PublicationStore(secondDb)
  expect(restored.inspect(dispatched.operationId)).toEqual(dispatched)
  expect(restored.checkpoint(boundary, checkpoint())).toEqual(checkpoint('next-cut'))
  expect(restored.claimNext(boundary, () => true)).toBeNull()
  expect(() => restored.retry(dispatched.operationId, () => true)).toThrowError(/not confirmed non-application/)
  restored.settle(dispatched.operationId, { state: 'not-applied', reason: 'platform-rejected' })
  expect(() => restored.retry(dispatched.operationId, () => false)).toThrowError(/no longer authorizes/)
  const pending = restored.retry(dispatched.operationId, () => true)
  expect(pending).toEqual({ ...dispatched, state: 'pending' })
  expect(restored.claimNext(boundary, () => true)).toEqual(dispatched)
})

it('retains old exact operations after relinking and bounds inspection without allowing the new audience to claim them', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')]), () => true)
  const original = owner.claimNext(boundary, () => true)!
  const next = { ...boundary, revision: 2, externalConversationId: 'room-b', sourceCheckpoints: [checkpoint('new-authorized-cut')] }
  owner.checkpoint(next, checkpoint('new-authorized-cut'))
  owner.commitPage(next, checkpoint('new-authorized-cut'), page([speech('reply-a')], 'next-room-cut'), () => true)
  const nextOperation = owner.claimNext(next, () => true)!
  expect(nextOperation.operationId).not.toBe(original.operationId)
  expect(nextOperation.target.externalConversationId).toBe('room-b')
  expect(owner.inspect(original.operationId)).toEqual(original)
  expect(owner.claimNext(boundary, () => false)).toBeNull()
  expect(() => owner.list(boundary, 0)).toThrowError(/limit from 1 to 100/)
})

it('publishes a genuine content reversion and retains an exact confirmed update mapping', () => {
  const owner = store(), mapping = { messageId: 'original-message', threadId: 'original-thread' }
  for (const [index, text] of ['First', 'Second', 'First'].entries()) {
    owner.commitPage(boundary, checkpoint(index ? `cut-${index}` : 'original-cut'), page([speech('reply-a', text)], `cut-${index + 1}`), () => true)
    const operation = owner.claimNext(boundary, () => true)!
    expect(operation.payload.text).toBe(text)
    if (index) expect(() => owner.settle(operation.operationId, { state: 'confirmed', mapping: { messageId: 'other-message' } })).toThrowError(/original exact message/)
    owner.settle(operation.operationId, { state: 'confirmed', mapping })
  }
  const operations = owner.list(boundary)
  expect(new Set(operations.map(operation => operation.operationId)).size).toBe(3)
  expect(operations[0]!.sourceRevision).toBe(operations[2]!.sourceRevision)
  owner.commitPage(boundary, checkpoint('cut-3'), page([speech('reply-a', 'First')], 'cut-4'), () => true)
  expect(owner.list(boundary)).toHaveLength(3)
  expect(owner.settle(operations[2]!.operationId, { state: 'confirmed', mapping: { threadId: 'original-thread', messageId: 'original-message' } }).mapping).toEqual(mapping)
})

it('a later non-public revision cancels only undispatched speech and can explicitly return to genuine speech', () => {
  const owner = store()
  owner.commitPage(boundary, checkpoint(), page([speech('reply-a')], 'cut-1'), () => true)
  const original = owner.list(boundary)[0]!
  owner.commitPage(boundary, checkpoint('cut-1'), page([{ id: 'reply-a', kind: 'activity', contentParts: [] }], 'cut-2'), () => true)
  expect(owner.inspect(original.operationId)).toMatchObject({ state: 'cancelled', reason: 'original-speech-withdrawn' })
  expect(owner.claimNext(boundary, () => true)).toBeNull()
  owner.commitPage(boundary, checkpoint('cut-2'), page([speech('reply-a')], 'cut-3'), () => true)
  const returned = owner.claimNext(boundary, () => true)!
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
