import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
/** Source custody outlives Run Hook credentials. A missing retained key is never
 * replaced when original evidence exists. The kernel lease serializes creators. */
export async function nativeSnapshotSigningKey(directory: string, create: boolean): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
  const lock = await open(join(directory, 'owner-key.lease'), 'a+', 0o600)
  try {
    if (!native.tryLock(lock.fd)) throw new AgentMuxError('The original source custody key is being committed. Retry this read.', 'AGENT_SESSION_HISTORY_BUSY')
    const path = join(directory, 'owner-key')
    try {
      const value = await readFile(path, 'utf8')
      if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new AgentMuxError('The retained source custody key is invalid; its artifacts and Agent are preserved.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
      const keyFile = await open(path, 'r'); try { await keyFile.sync() } finally { await keyFile.close() }
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!create || (await readdir(directory)).some(name => /^[a-f0-9]{64}$/u.test(name))) throw new AgentMuxError('The original source custody key is unavailable; retained evidence is not re-signed under a replacement identity.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
    const ancestor = await open(dirname(directory), 'r'); try { await ancestor.sync() } finally { await ancestor.close() }
    const value = randomBytes(32).toString('base64url')
    await durableWriteFile(path, value, { requireDirectorySync: true })
    return value
  } finally { await lock.close() }
}
