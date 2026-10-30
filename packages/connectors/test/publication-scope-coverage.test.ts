import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'
import { fixture, append, native, contentOperations } from './fixtures/publication-source-owner.js'

// Original persisted identity format, including the pre-correction derived gap.
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('base64url')
function oldGap(db: DatabaseSync, boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>) {
  const gap = { gapId: 'gap-' + digest([boundary.bindingId, boundary.revision, 'captured-start']), reason: 'start-cut-unconfirmed', code: 'PUBLICATION_CAPTURED_START_UNCONFIRMED' }
  const value = { kind: 'gap', gap, state: 'unresolved' }
  db.prepare('INSERT INTO connector_publication_decision(binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES (?,?,?,?,?,?,?)')
    .run(boundary.bindingId, boundary.revision, 'unified', gap.gapId, digest(gap), 'content-accounted', encode(value))
  return value
}

it.each(['future-native-user-facing', 'future-shared-conversation'] as const)('default Host restores original %s scope without inventing captured coverage or replaying speech', async scope => {
  const f = await fixture()
  await f.services.close()
  const db = new DatabaseSync(join(f.root, 'image-host', 'connections.sqlite'))
  const row = db.prepare('SELECT snapshot_json FROM room_binding_revision WHERE binding_id=? AND revision=?').get(f.binding.bindingId, f.binding.revision)!
  const original = JSON.parse(String(row.snapshot_json)); delete original.sourceFrontier; original.scope.publication = scope
  db.prepare('UPDATE room_binding_revision SET snapshot_json=? WHERE binding_id=? AND revision=?').run(JSON.stringify(original), f.binding.bindingId, f.binding.revision)
  db.prepare('DELETE FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=?').run(f.binding.bindingId, f.binding.revision)
  const historical = oldGap(db, f.binding)
  db.close()
  await f.restart()
  expect((await f.rpc.call('connection.binding.inspect', { bindingId: f.binding.bindingId, revision: f.binding.revision })).binding).toEqual(original)
  await append(f, native('scoped-original-speech', [{ type: 'text', text: 'Original scope still delivers this reply' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding)).toEqual([
    expect.objectContaining({ state: 'confirmed', reference: expect.objectContaining({ source: expect.objectContaining({ recordId: 'scoped-original-speech' }) }) })
  ]), { timeout: 10_000 })
  const delivered = contentOperations(f.services.publication!.store, f.binding)[0]!
  const input = { connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision }
  const read = await f.rpc.call('connection.delivery.ls', input)
  expect(read.coverage).toMatchObject(scope === 'future-native-user-facing'
    ? { state: 'complete', gaps: [] } : { state: 'incomplete', gaps: [historical.gap] })
  expect(read.deliveries).toContainEqual(expect.objectContaining({ operationId: delivered.operationId, state: 'confirmed', mapping: delivered.mapping }))
  const requestCount = f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages').length
  expect(requestCount).toBe(scope === 'future-native-user-facing' ? 1 : 2) // Narrow history does not adopt the earlier broad notice.
  expect(JSON.stringify(f.remote.messages.get(delivered.mapping!.messageId))).toContain('Original scope still delivers this reply')
  await f.restart()
  await append(f, native('scoped-after-reopen', [{ type: 'text', text: 'Independent reply after reopening the same Host' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => { const operations = contentOperations(f.services.publication!.store, f.binding); expect(operations).toHaveLength(2); expect(operations.every(operation => operation.state === 'confirmed')).toBe(true) }, { timeout: 10_000 })
  await vi.waitFor(async () => expect((await f.rpc.call('connection.delivery.ls', input)).deliveries).toContainEqual(expect.objectContaining({ operationId: delivered.operationId, state: 'confirmed' })))
  expect(contentOperations(f.services.publication!.store, f.binding).find(operation => operation.operationId === delivered.operationId)).toEqual(delivered)
  expect(f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages')).toHaveLength(requestCount + 1)
  expect((await f.rpc.call('connection.binding.inspect', { bindingId: f.binding.bindingId, revision: f.binding.revision })).binding).toEqual(original)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close() })
it('resolves only the exact historical out-of-scope obligation and preserves genuine gaps and original cuts', () => {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const owner = new PublicationStore(db)
  const boundary: PublicationBoundary = { bindingId: 'historical-binding', revision: 2, connectionId: 'original-connection', application: { domain: 'chat.example', appId: 'original-app' },
    executionHostId: 'original-host', agentSessionId: 'original-session', externalConversationId: 'original-room', sourceCheckpoints: [{ agentSessionId: 'original-session', source: { providerId: 'claude', nativeSessionId: 'original-native' }, cursor: 'original-cut' }],
    scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } }
  const historical = oldGap(db, boundary), otherRevision = { ...boundary, revision: 3 }, other = oldGap(db, otherRevision)
  const genuine = { kind: 'gap', state: 'unresolved', gap: { gapId: 'original-resource-gap', reason: 'resource-unavailable', code: 'ORIGINAL_RESOURCE_UNAVAILABLE' } }
  db.prepare('INSERT INTO connector_publication_decision(binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES (?,?,?,?,?,?,?)')
    .run(boundary.bindingId, boundary.revision, 'unified', genuine.gap.gapId, 'original-resource-version', 'content-accounted', JSON.stringify(genuine))
  const before = db.prepare('SELECT * FROM connector_publication_decision ORDER BY rowid').all()
  const checkpoint = owner.checkpoint(boundary, boundary.executionHostId)
  expect(checkpoint.frontier.cuts).toEqual([{ kind: 'native', checkpoint: boundary.sourceCheckpoints[0] }])
  const after = db.prepare('SELECT * FROM connector_publication_decision ORDER BY rowid').all()
  expect(after).toHaveLength(3)
  expect(after[0]).toEqual({ ...before[0], decision_json: encode({ ...historical, state: 'resolved' }) })
  expect(after.slice(1)).toEqual(before.slice(1))
  expect(owner.coverage(boundary)).toMatchObject({ state: 'incomplete', gaps: [genuine.gap] })
  expect(owner.coverage(otherRevision)).toMatchObject({ state: 'incomplete', gaps: [other.gap] })
  expect(owner.checkpoint(boundary, boundary.executionHostId)).toEqual(checkpoint)
  expect(owner.list(boundary)).toEqual([])
})
