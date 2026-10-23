import { constants, createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { AgentMuxError, mintObjectId } from '@agentmux/core'

/** Internal artifact reference; it never grants a public arbitrary-path export. */
export type ConnectionBackupReceipt = { artifactId: string; pages: number; sha256: string }

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid())
    throw new Error('Private backup directory is unconfirmed.')
}
async function sync(path: string, directory = false): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0))
  try { await file.sync() } finally { await file.close() }
}

/** Copy all original SQLite bytes consistently, without resolving or reencoding any credential. */
export async function backupConnections(database: DatabaseSync, directory: string): Promise<ConnectionBackupReceipt> {
  let artifact: string | undefined
  try {
    await privateDirectory(directory)
    const parent = join(directory, 'backups')
    try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await privateDirectory(parent)
    const artifactId = mintObjectId()
    const candidate = join(parent, artifactId)
    await mkdir(candidate, { mode: 0o700 }); artifact = candidate
    const path = join(candidate, 'connections.sqlite')
    const reserved = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const original = await reserved.stat().finally(() => reserved.close())
    const pages = await backup(database, path)
    const actual = await lstat(path)
    if (!actual.isFile() || actual.dev !== original.dev || actual.ino !== original.ino) throw new Error('Backup artifact changed.')
    const snapshot = new DatabaseSync(path, { readOnly: true })
    try {
      const checked = snapshot.prepare('PRAGMA integrity_check').get()
      if (checked?.integrity_check !== 'ok') throw new Error('Backup integrity is unconfirmed.')
    } finally { snapshot.close() }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const owned = path + suffix
      let info
      try { info = await lstat(owned) } catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (!info.isFile() || process.getuid && info.uid !== process.getuid()) throw new Error('Backup file owner is unconfirmed.')
      await chmod(owned, 0o600)
    }
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(path)) digest.update(bytes)
    const sha256 = digest.digest('hex')
    await sync(path); await sync(candidate, true); await sync(parent, true); await sync(directory, true)
    return { artifactId, pages, sha256 }
  } catch {
    if (artifact) await rm(artifact, { recursive: true, force: true }).catch(() => {})
    throw new AgentMuxError('The original connection backup is unconfirmed. Its source database, credentials and operations are retained; retry through the original owner.', 'CONNECTION_BACKUP_UNCONFIRMED')
  }
}
