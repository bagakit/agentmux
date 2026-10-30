import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { deliveryFact } from '../../core/test/fixtures/connection-delivery.js'
import { PublicationStore, type PublicationOperation } from '../src/publication-store.js'

it('actual rate-limit Store cursors seek scalar keys across a dense cooling pair', async () => {
  const measurements: unknown[] = []
  for (const size of [500, 5_000]) {
    const database = new DatabaseSync(':memory:'), store = new PublicationStore(database)
    const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), d = 'd'.repeat(64), e = 'e'.repeat(64)
    const now = Date.now(), original = deliveryFact(), boundary = { bindingId: original.bindingId, revision: original.bindingRevision }
    const operation = (id: string, request: string, conversation: string, state: 'pending' | 'not-applied' | 'cancelled', until = now - 1): PublicationOperation => ({
      ...original, operationId: id, state, reason: 'rate-limited', receipt: { state: 'not-applied', reason: 'rate-limited' },
      payload: { kind: 'speech', text: 'Synthetic original-owner index load; no Host or platform effect.' }, attempt: 1,
      prepared: { adapterId: 'feishu', renderVersion: 'fixture', requestKey: id, request: { method: 'POST', path: '/open-apis/im/v1/messages' } },
      rateLimitScopes: { request, conversation }, rateLimit: { source: { kind: 'message', attempt: 1 }, scopeKey: request, notBefore: until, basis: 'native', reason: 'rate-limit' }
    })
    const insert = database.prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES(?,?,?,?,?,?,?,?)')
    const put = (value: PublicationOperation) => insert.run(value.operationId, value.projectionId, value.sourceRevision, value.fragment.ordinal,
      value.bindingId, value.bindingRevision, JSON.stringify(value), value.state)
    database.exec('BEGIN')
    for (let n = 0; n < size; n++) { put(operation('dense-source-' + n, a, b, 'not-applied')); put(operation('dense-pending-' + n, a, b, 'pending')) }
    for (const [id, request, conversation] of [['next-same-scope', a, c], ['next-scope', d, e]]) {
      put(operation(id!, request!, conversation!, 'not-applied'))
      database.prepare('INSERT INTO connector_publication_attempt(operation_id,attempt,receipt_json) VALUES(?,1,?)')
        .run(id!, JSON.stringify({ state: 'not-applied', reason: 'rate-limited' }))
    }
    put(operation('pending-next-pair', a, c, 'pending'))
    // Dense suffixes in both selected and subsequent pairs expose hidden ORDER BY sorting.
    for (let n = 0; n < size; n++) { put(operation('suffix-same-' + n, a, c, 'pending')); put(operation('suffix-other-' + n, d, e, 'pending')) }
    // An observed window remains physical scope evidence after business cancellation.
    put(operation('cooling-b', b, e, 'cancelled', now + 60_000))
    database.exec('COMMIT')
    const middle = database.prepare('SELECT ordinal FROM connector_publication_operation WHERE operation_id=?').get('dense-source-' + Math.floor(size / 2))!
    const prepare = database.prepare.bind(database), calls: Array<{ sql: string; parameters: SQLInputValue[] }> = []
    const spy = vi.spyOn(database, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql)
      return new Proxy(statement, { get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (property === 'get') return (...parameters: SQLInputValue[]) => { calls.push({ sql, parameters }); return value.apply(target, parameters) }
        return value.bind(target)
      } }) as StatementSync
    })
    try {
      const started = performance.now()
      const sources = store.rateLimitSources(boundary, { scopeKey: a, otherKey: b, ordinal: Number(middle.ordinal) }, 25)
      expect(sources.operations.map(value => value.operationId)).toEqual(['next-same-scope', 'next-scope'])
      expect(store.rateLimitPending(boundary, { request: a, conversation: b }, 25)).toEqual({ due: true })
      const elapsed = performance.now() - started
      spy.mockRestore()
      const cursorCalls = calls.filter(call => /INDEXED BY connector_publication_rate_(?:source|pending)/u.test(call.sql))
      expect(cursorCalls.length).toBeGreaterThan(0)
      expect(cursorCalls.length, 'background work is bounded by scope/key branches, not dense-pair rows').toBeLessThan(15)
      const plans = cursorCalls.map(call => {
        const plan = prepare('EXPLAIN QUERY PLAN ' + call.sql).all(...call.parameters)
        const program = prepare('EXPLAIN ' + call.sql).all(...call.parameters)
        const seek = program.filter(row => ['SeekGE', 'SeekGT', 'SeekLE', 'SeekLT'].includes(String(row.opcode)))
        expect(program.some(row => row.opcode === 'SorterOpen' || row.opcode === 'Sort' || row.opcode === 'SorterSort')).toBe(false)
        const stop = program.find(row => row.opcode === 'DecrJumpZero')
        expect(stop, 'native LIMIT must branch out before advancing into the dense suffix').toBeDefined()
        expect(program.some(row => row.opcode === 'Next' && Number(row.addr) > Number(stop!.addr))).toBe(true)
        expect(plan.some(row => /USING INDEX connector_publication_rate_/u.test(String(row.detail)))).toBe(true)
        expect(plan.some(row => /TEMP B-TREE/u.test(String(row.detail))), 'LIMIT 1 must stop in the index, never sort a dense suffix').toBe(false)
        expect(seek.some(row => Number(row.p4) >= call.parameters.length), 'the actual cursor values must participate in the native SQLite seek').toBe(true)
        return { sql: call.sql, parameters: call.parameters, plan, seek, program }
      })
      measurements.push({ size, elapsed, selected: sources.operations.map(value => value.operationId), statements: cursorCalls.length, plans })
    } finally { spy.mockRestore(); database.close() }
  }
  if (process.env.PUBLICATION_RATE_LIMIT_SEEK_REPORT) await writeFile(process.env.PUBLICATION_RATE_LIMIT_SEEK_REPORT,
    JSON.stringify({ sqlite: process.versions.sqlite, consumer: 'Actual PublicationStore with original schema and captured executed query parameters; no copied SELECT/DDL.', measurements }, null, 2) + '\n')
})
