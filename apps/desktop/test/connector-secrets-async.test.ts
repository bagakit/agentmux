import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
const databases: DatabaseSync[] = []
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close() })
function fixture() { const database = new DatabaseSync(':memory:'); databases.push(database); return { database, secrets: new ConnectionSecrets(database) } }
it('freezes original input before asynchronous permission observation while inspection and SQLite remain usable', async () => {
  const f = fixture(); let release!: () => void
  vi.spyOn(f.secrets, 'assertAvailable').mockImplementationOnce(() => new Promise(done => { release = done }))
  const input = { operationId: 'original-operation', secret: 'original-private-value' }, work = f.secrets.store(input)
  input.operationId = 'caller-replaced-operation'; input.secret = 'caller-replaced-value'
  expect(await f.secrets.inspect('original-operation')).toBeNull(); f.database.exec('BEGIN IMMEDIATE; ROLLBACK')
  release(); const receipt = await work
  expect(await f.secrets.inspect('original-operation')).toEqual(receipt)
  expect(await f.secrets.inspect(input.operationId)).toBeNull(); expect(await f.secrets.resolve(receipt.credentialRef)).toBe('original-private-value')
})
it('keeps original rows and inspection after a closed owner without pretending its missing read is success', async () => {
  const f = fixture(), receipt = await f.secrets.store({ operationId: 'original-operation', secret: 'original' })
  expect(await f.secrets.resolve(receipt.credentialRef)).toBe('original')
  f.database.close(); databases.splice(databases.indexOf(f.database), 1)
  await expect(f.secrets.resolve(receipt.credentialRef)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  await expect(f.secrets.inspect('original-operation')).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNCONFIRMED' })
})
