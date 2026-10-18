import { afterEach, expect, it, vi } from 'vitest'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ingressFixture } from './fixtures/ingress.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

it('the actual recovery query searches unfinished intake indexes instead of settled connection history', async () => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const owner = new DurableIngressHost(f.options)
  const original = await f.receive()
  const db = f.connections.database
  const raw = db.prepare('SELECT * FROM connection_ingress_message WHERE ingress_id=?').get(original.ingress.ingressId)!
  const insert = db.prepare('INSERT INTO connection_ingress_message (sequence,ingress_id,domain,app_id,message_id,connection_id,event_json,record_json) VALUES (?,?,?,?,?,?,?,?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let index = 0; index < 1000; index++) {
      const key = 'settled-' + index
      insert.run(index + 2, key, raw.domain, raw.app_id, key, raw.connection_id, raw.event_json, JSON.stringify({ ...original.ingress, ingressId: key, externalMessageId: key, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  const prepare = db.prepare.bind(db), queries: string[] = []
  vi.spyOn(db, 'prepare').mockImplementation(sql => { queries.push(sql); return prepare(sql) })
  expect(owner.received(String(raw.connection_id))).toEqual({ ingressIds: [original.ingress.ingressId], nextAfterIngressId: null })
  const query = queries.find(sql => sql.startsWith('SELECT ingress_id FROM ('))!
  expect(query).toBeDefined()
  const details = prepare('EXPLAIN QUERY PLAN ' + query).all(String(raw.connection_id), 0, 26).map(row => String(row.detail))
  expect(details.some(detail => detail.includes('connection_ingress_unfinished_message'))).toBe(true)
  expect(details.some(detail => detail.includes('connection_ingress_unfinished_action'))).toBe(true)
  expect(details.some(detail => /USING INDEX connection_ingress_(message_connection|action_connection) /u.test(detail))).toBe(false)
})
