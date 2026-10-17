import { afterEach, expect, it, vi } from 'vitest'
import { parseConnectionProfileOperation } from '@agentmux/core/connections'
import { profileFixture } from './fixtures/connection-profile.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture() {
  const f = await profileFixture()
  cleanup.push(f.close)
  return f
}
const result = (r: { code: number | null; stdout: string; stderr: string }) => {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return JSON.parse(r.stdout).result
}
it('retains genuine online SDK observations through public SDK and actual compiled CLI with no profile writes', async () => {
  const f = await fixture()
  const online = await f.sdk.call('connection.profile.get', {
    connectionId: f.config.connectionId,
    expectedConnectionRevision: 1
  })
  expect(online).toMatchObject({
    profile: { name: 'Online name', description: 'Exact online description' },
    metadata: { description: 'Draft metadata description' },
    onlineVersionId: 'online-original'
  })
  expect(
    result(
      await f.cli([
        'get',
        '--connection',
        f.config.connectionId,
        '--revision',
        '1'
      ])
    )
  ).toEqual(online)
  expect(f.calls.length).toBeGreaterThan(0)
  expect(f.calls.every((r) => r.method === 'GET')).toBe(true)
  expect(
    f.services
      .database!.prepare(
        "SELECT name FROM sqlite_master WHERE name='connection_profile_operation'"
      )
      .get()
  ).toBeUndefined()
  const before = f.calls.length
  expect(
    result(await f.cli(['ls', '--connection', f.config.connectionId]))
  ).toEqual({ operations: [], next: null })
  expect(
    (
      await f.sdk.call('connection.profile.inspect', {
        operationId: 'no-old-operation'
      })
    ).operation
  ).toBeNull()
  expect(f.calls).toHaveLength(before)
}, 30000)
it('retains unknown historical receipts and original identity across restart, with zero native reads or writes', async () => {
  const f = await fixture(),
    db = f.services.database!
  db.exec(
    'CREATE TABLE connection_profile_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,input_json TEXT NOT NULL,config_json TEXT NOT NULL,actor_json TEXT NOT NULL,record_json TEXT NOT NULL,upload_wire TEXT,patch_wire TEXT,avatar_url TEXT)'
  )
  const operation = parseConnectionProfileOperation({
    operationId: 'original-history',
    connectionId: f.config.connectionId,
    connectionRevision: 1,
    application: f.config.application,
    language: 'zh_cn',
    fields: ['name'],
    desired: { name: 'Saved original' },
    upload: { state: 'not-required' },
    patch: {
      state: 'unknown',
      diagnostic: { stage: 'patch', httpStatus: 502 }
    },
    publication: 'not-requested',
    online: null,
    reason: 'effect-unconfirmed'
  })
  db.prepare(
    'INSERT INTO connection_profile_operation(operation_id,connection_id,input_json,config_json,actor_json,record_json) VALUES(?,?,?,?,?,?)'
  ).run(
    operation.operationId,
    operation.connectionId,
    '{}',
    JSON.stringify(f.config),
    JSON.stringify({ kind: 'user', id: 'local-user' }),
    JSON.stringify(operation)
  )
  expect(
    (
      await f.sdk.call('connection.profile.inspect', {
        operationId: operation.operationId
      })
    ).operation
  ).toEqual(operation)
  await f.closeOwner()
  await f.reopen()
  expect(
    result(await f.cli(['inspect', '--operation-id', operation.operationId]))
      .operation
  ).toEqual(operation)
  expect(
    result(await f.cli(['ls', '--connection', f.config.connectionId]))
      .operations
  ).toEqual([operation])
  expect(f.calls).toHaveLength(0)
}, 30000)
it('retires old write RPCs and CLI commands while keeping independent saved connections available', async () => {
  const f = await fixture()
  await expect(
    (f.sdk as any).call('connection.profile.sync', {
      operationId: 'retired',
      connectionId: f.config.connectionId,
      expectedConnectionRevision: 1,
      desired: { name: 'Do not send' }
    })
  ).rejects.toBeDefined()
  await expect(
    (f.sdk as any).call('connection.profile.advance', {
      operationId: 'retired'
    })
  ).rejects.toBeDefined()
  expect(
    (await f.cli(['sync', '--input', '-'], { operationId: 'retired' })).code
  ).not.toBe(0)
  expect((await f.cli(['advance', '--operation-id', 'retired'])).code).not.toBe(
    0
  )
  expect((await f.sdk.call('connection.ls', {})).connections).toHaveLength(1)
  expect(f.calls).toHaveLength(0)
}, 30000)
