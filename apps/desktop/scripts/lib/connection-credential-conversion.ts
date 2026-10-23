import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConnectionSecrets, encodeConnectionCredential } from '../../../../packages/connectors/src/connection-secrets.js'
import type { ConnectionBackupReceipt } from '../../../../packages/connectors/src/connection-backup.js'

type Row = { ref: string; operation: string; bytes: Buffer }
export type ConnectionCredentialConversionResult = {
  scanned: number; alreadyCurrent: number; converted: number; verified: number; backupConfirmed: true; committed: true
}
const rows = (database: DatabaseSync): Row[] => database.prepare('SELECT credential_ref, operation_id, ciphertext FROM connection_credential ORDER BY credential_ref').all().map(row => {
  if (typeof row.credential_ref !== 'string' || typeof row.operation_id !== 'string' || !(row.ciphertext instanceof Uint8Array)) throw new Error('Unconfirmed credential row.')
  return { ref: row.credential_ref, operation: row.operation_id, bytes: Buffer.from(row.ciphertext) }
})
const same = (a: Row, b: Row | undefined) => !!b && a.ref === b.ref && a.operation === b.operation && a.bytes.equals(b.bytes)
async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path)
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error('Unconfirmed private backup.')
}
async function confirmBackup(database: DatabaseSync, receipt: ConnectionBackupReceipt, originals: readonly Row[]) {
  const location = database.location()
  if (!location || !receipt || typeof receipt.artifactId !== 'string' || !receipt.artifactId || receipt.artifactId === '.' || receipt.artifactId === '..' || /[/\\\0]/u.test(receipt.artifactId) || !Number.isSafeInteger(receipt.pages) || receipt.pages <= 0 || !/^[a-f0-9]{64}$/u.test(receipt.sha256)) throw new Error('Unconfirmed backup receipt.')
  const directory = dirname(location), parent = join(directory, 'backups'), artifact = join(parent, receipt.artifactId), path = join(artifact, 'connections.sqlite')
  for (const folder of [directory, parent, artifact]) await privatePath(folder, true)
  await privatePath(path, false)
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  if (digest.digest('hex') !== receipt.sha256) throw new Error('Unconfirmed backup bytes.')
  const snapshot = new DatabaseSync(path, { readOnly: true })
  try {
    const saved = new Map(rows(snapshot).map(row => [row.ref, row]))
    if (originals.some(row => !same(row, saved.get(row.ref)))) throw new Error('Backup does not cover original credentials.')
  } finally { snapshot.close() }
}

/** Explicit private maintenance only: no normal decoder, public transport or automatic invocation. */
export async function convertConnectionCredentials(input: {
  database: DatabaseSync
  backup: ConnectionBackupReceipt
  decryptLegacy(ciphertext: Buffer): string | Promise<string>
}): Promise<ConnectionCredentialConversionResult> {
  const { database } = input
  let stage = 'original snapshot', transaction = false
  try {
    if (database.isTransaction) throw new Error('The original handle already has a transaction.')
    const originals = rows(database), secrets = new ConnectionSecrets(database)
    const legacy: Row[] = []
    for (const row of originals) {
      try { if (await secrets.resolve(row.ref) === null) throw new Error('Missing original credential.') }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED' || row.bytes.subarray(0, 3).toString('ascii') !== 'v10') throw error
        legacy.push(row)
      }
    }
    stage = 'backup confirmation'
    await confirmBackup(database, input.backup, legacy)
    stage = 'native decryption'
    const converted = new Map<string, { secret: string; bytes: Buffer }>()
    // OS authorization and every decrypt finish before SQLite acquires its write lock.
    for (const row of legacy) {
      const secret = await input.decryptLegacy(Buffer.from(row.bytes))
      converted.set(row.ref, { secret, bytes: encodeConnectionCredential(secret) })
    }
    stage = 'original credential comparison'
    database.exec('BEGIN IMMEDIATE'); transaction = true
    const current = rows(database), byRef = new Map(current.map(row => [row.ref, row]))
    if (originals.some(row => !same(row, byRef.get(row.ref)))) throw new Error('Original credential collection changed.')
    const originalRefs = new Set(originals.map(row => row.ref))
    for (const row of current) if (!originalRefs.has(row.ref) && await secrets.resolve(row.ref) === null) throw new Error('New credential is not confirmed raw storage.')
    stage = 'atomic credential conversion'
    const update = database.prepare('UPDATE connection_credential SET ciphertext = ? WHERE credential_ref = ? AND operation_id = ? AND ciphertext = ?')
    for (const row of legacy) {
      if (update.run(converted.get(row.ref)!.bytes, row.ref, row.operation, row.bytes).changes !== 1) throw new Error('Original credential comparison failed.')
    }
    stage = 'original Store verification'
    for (const row of legacy) if (await secrets.resolve(row.ref) !== converted.get(row.ref)!.secret) throw new Error('Converted credential readback differs.')
    const after = new Map(rows(database).map(row => [row.ref, row]))
    if (after.size !== current.length || current.some(row => !same({ ...row, bytes: converted.get(row.ref)?.bytes ?? row.bytes }, after.get(row.ref)))) throw new Error('Original credential identities or untouched bytes changed.')
    database.exec('COMMIT'); transaction = false
    return { scanned: originals.length, alreadyCurrent: originals.length - legacy.length, converted: legacy.length, verified: legacy.length, backupConfirmed: true, committed: true }
  } catch {
    if (transaction) try { database.exec('ROLLBACK') } catch { /* Preserve the original failure without exposing native values. */ }
    throw new Error(`Connection credential conversion was not confirmed during ${stage}. Original identities are retained; inspect the original database and backup before retrying.`)
  }
}
