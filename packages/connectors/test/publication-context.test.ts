import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { parseIngressResult } from '../../core/src/ingress-codec.js'
import { projectConversationTimeline, type ConversationChangesPage, type ConversationCheckpoint } from '@agentmux/core/conversation'
import { PublicationStore, type PublicationBoundary, type PublicationOperation } from '../src/publication-store.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database)
  const owner = new PublicationStore(database)
  const source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const boundary: PublicationBoundary = { bindingId: 'original-binding', revision: 1, connectionId: 'original-connection', application: { domain: 'chat.example', appId: 'original-app' }, executionHostId: 'local', agentSessionId: 'original-session', externalConversationId: 'original-room', sourceCheckpoints: [{ agentSessionId: 'original-session', source, cursor: 'cut' }], scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } }
  const checkpoint = owner.checkpoint(boundary, 'local')
  const timeline = projectConversationTimeline({ agentSessionId: boundary.agentSessionId, executionHostId: 'local', historyPage: { agentSessionId: boundary.agentSessionId, source, items: [{ id: 'original-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original public reply', contentEligibility: 'public' }] }], nextCursor: null } })
  const after = { ...checkpoint, frontier: { ...checkpoint.frontier, cuts: [{ kind: 'native' as const, checkpoint: { agentSessionId: boundary.agentSessionId, source, cursor: 'after' } }] } } as ConversationCheckpoint
  const page: ConversationChangesPage = { hostId: 'local', sourceHostId: 'local', agentSessionId: boundary.agentSessionId, scope: timeline.scope, coverage: timeline.coverage, order: { ...timeline.order, direction: 'newest-first' }, items: [...timeline.events].reverse().map(event => ({ kind: 'item', item: { event, records: timeline.records.filter(record => event.recordIds.includes(record.id)) } })), nextCursor: null, budgetBytes: 4 * 1024 * 1024, checkpoint: after, more: false, window: { id: 'original-window', revision: 1, itemCount: timeline.events.length, complete: true, view: 'original-view', replay: 'original-replay', checkpoint: after, outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }
  owner.commitPage(boundary, checkpoint, page, () => true, { units: [...page.items].reverse().flatMap(item => item.kind === 'item' ? [item.item] : []), resolvedText: new Map() })
  const preparer = { adapterId: 'fixture', renderVersion: 'original-v1', supportedRenderVersions: ['original-v1'], prepare: (operation: PublicationOperation) => ({ adapterId: 'fixture', renderVersion: 'original-v1', requestKey: operation.operationId, request: { method: 'POST' as const, path: '/original', body: '{}' } }) }
  const claimed = owner.claimNext(boundary, owner.next(boundary)!.operationId, () => true, preparer)!
  owner.settle(claimed.operationId, claimed.attempt!, { state: 'confirmed', mapping: { messageId: 'known-native-message' } })
  const original = owner.inspect(claimed.operationId)!
  const recipient = { application: boundary.application, externalConversationId: boundary.externalConversationId, hostId: 'local', agentSessionId: boundary.agentSessionId, source }
  const clone = (id: string, change: (operation: PublicationOperation) => void) => {
    const value = structuredClone(original); value.operationId = id; value.projectionId = id; value.mapping = { messageId: id }; change(value)
    database.prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)').run(id, id, value.sourceRevision, 0, value.bindingId, value.bindingRevision, JSON.stringify(value), value.state)
    return value
  }
  return { database, owner, original, recipient, clone }
}
it('quote selection exact mapping keeps other recipients, native conversations, unknown effects and captured relays', () => {
  const f = fixture(), candidates = ['known-native-message']
  const cases: Array<[string, (operation: PublicationOperation) => void]> = [
    ['other-app', op => { op.target.application.appId = 'other-app' }],
    ['other-domain', op => { op.target.application.domain = 'other.example' }],
    ['other-room', op => { op.target.externalConversationId = 'other-room' }],
    ['other-host', op => { op.reference.hostId = 'other-host' }],
    ['other-session', op => { op.reference.agentSessionId = 'other-session' }],
    ['other-native', op => { if (op.reference.source.kind === 'native') op.reference.source.nativeSessionId = 'other-native'; for (const ref of op.sourceRecords!) if (ref.source.kind === 'native') ref.source.nativeSessionId = 'other-native' }],
    ['mixed-native', op => { if (op.sourceRecords![0]!.source.kind === 'native') op.sourceRecords![0]!.source.nativeSessionId = 'other-native' }],
    ['unknown-effect', op => { op.state = 'unknown' }],
    ['not-applied-effect', op => { op.state = 'not-applied' }],
    ['missing-mapping', op => { delete op.mapping }],
    ['missing-source', op => { delete op.sourceRecords }],
    ['empty-source', op => { op.sourceRecords = [] }],
    ['captured-source', op => { op.sourceRecords![0]!.source = { kind: 'captured', recordId: 'original-input' } }],
    ['waiting-relay', op => { if (op.payload.kind === 'speech') { op.payload.relay = { sender: 'application', sources: [{ part: { record: op.sourceRecords![0]!, recordRevision: 'original-revision', selector: { kind: 'captured-field', field: 'content' } }, author: { kind: 'human' } }] }; op.payload.inputSubmission = { status: 'waiting', observation: 'owned' } } }],
    ['stopped-relay', op => { if (op.payload.kind === 'speech') { op.payload.relay = { sender: 'application', sources: [{ part: { record: op.sourceRecords![0]!, recordRevision: 'original-revision', selector: { kind: 'captured-field', field: 'content' } }, author: { kind: 'human' } }] }; op.payload.inputSubmission = { status: 'stopped', observation: 'closed' } } }],
  ]
  for (const [id, change] of cases) { f.clone(id, change); candidates.push(id) }
  f.clone('old-binding-same-native', op => { op.bindingId = 'previous-binding'; op.bindingRevision = 7; op.target.connectionId = 'previous-alias' }); candidates.push('old-binding-same-native')
  expect([...f.owner.knownContextMessages(f.recipient, candidates)]).toEqual(['known-native-message', 'old-binding-same-native'])
  expect(f.owner.inspect(f.original.operationId)).toEqual(f.original)
})
it('quote selection indexed candidate work does not scan unrelated Session outboxes or mutate the original receipt', () => {
  const f = fixture()
  f.database.exec('BEGIN')
  for (let index = 0; index < 2000; index++) f.clone('unrelated-' + index, op => { op.target.externalConversationId = 'unrelated-room-' + index; op.reference.agentSessionId = 'unrelated-session-' + index })
  f.database.exec('COMMIT')
  const prepare = f.database.prepare.bind(f.database), plans: string[] = [], batches: number[] = []
  f.database.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (!sql.startsWith('SELECT candidate.value')) return statement
    const all = statement.all.bind(statement)
    statement.all = ((...parameters: Parameters<typeof statement.all>) => {
      batches.push(JSON.parse(String(parameters[0])).length)
      plans.push(...prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => String(row.detail)))
      return all(...parameters)
    }) as typeof statement.all
    return statement
  }) as typeof f.database.prepare
  expect([...f.owner.knownContextMessages(f.recipient, ['known-native-message', ...Array.from({ length: 204 }, (_, index) => 'external-' + index)])]).toEqual(['known-native-message'])
  expect(batches).toEqual([100, 100, 5])
  expect(plans.some(plan => /SEARCH original(?: EXISTS)? USING (?:COVERING )?INDEX connector_publication_context_message/u.test(plan)), JSON.stringify(plans)).toBe(true)
  expect(plans.some(plan => /SCAN original/u.test(plan))).toBe(false)
  expect(f.owner.inspect(f.original.operationId)).toEqual(f.original)
})

it('quote selection leaves original ingress authority refusal and unavailability codes intact', () => {
  for (const [authority, code] of [['refused', 'INGRESS_AUTHORITY_REVISED'], ['unavailable', 'INGRESS_STORAGE_UNCONFIRMED']] as const) {
    expect(parseIngressResult('connection.ingress.authority', { ingress: null, authority, code }, { operationId: 'original-operation' })).toEqual({ ingress: null, authority, code })
  }
})
