import { constants, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, lstat, open, opendir, rename, rm, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { pack, extract } from 'tar-stream'
import { inspectRetainedPartition, retainedPartitionPath, BrowserProfileDataUnavailable } from './browser-profile-retained-data.js'
import type { BrowserProfileTrashRecord, BrowserProfileRetainedPartition } from './browser-profile-store.js'

type SafetyCopy = NonNullable<BrowserProfileTrashRecord['safetyCopy']>
type Entry = { type: 'file' | 'directory'; size: number; sha256?: string }
function ownedPath(root: string, path: string): string {
  const result = resolve(root, path), name = relative(resolve(root), result)
  if (!name || isAbsolute(name) || name.split(/[\\/]/u).some(part => part === '..' || part === '.')) throw new BrowserProfileDataUnavailable()
  return result
}
async function assertNoLinks(root: string, path: string, allowMissing = false): Promise<void> {
  const target = ownedPath(root, path), base = resolve(root), parts = relative(base, target).split(sep)
  for (let index = 0; index <= parts.length; index++) {
    const current = resolve(base, ...parts.slice(0, index))
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || index < parts.length && !info.isDirectory()) throw new BrowserProfileDataUnavailable()
    } catch (cause) {
      if (allowMissing && (cause as NodeJS.ErrnoException).code === 'ENOENT') return
      throw cause
    }
  }
}
async function readOriginal(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  return handle.createReadStream()
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of await readOriginal(path)) hash.update(bytes)
  return hash.digest('hex')
}
async function syncFileAndParents(path: string, root: string): Promise<void> {
  const parents = [path]
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    parents.push(parent)
    if (parent === resolve(root)) break
    ownedPath(root, parent)
  }
  for (const target of parents) {
    const descriptor = await open(target, 'r')
    try { await descriptor.sync() } finally { await descriptor.close() }
  }
}
function entryName(name: string): string {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name
  if (!clean || clean.includes('\\') || isAbsolute(clean) || clean.split('/').some(part => !part || part === '..' || part === '.')) throw new BrowserProfileDataUnavailable()
  return clean
}

/** Mature TAR parsing owns headers/checksums; links, duplicate paths and unsupported records are refused. */
async function readCopy(path: string, target?: string): Promise<Map<string, Entry>> {
  const archive = extract(), entries = new Map<string, Entry>()
  archive.on('entry', (header, stream, next) => {
    void (async () => {
      const name = entryName(header.name)
      if (entries.has(name) || (header.type !== 'file' && header.type !== 'directory') || !Number.isSafeInteger(header.size) || header.size! < 0) throw new BrowserProfileDataUnavailable()
      const type = header.type, item: Entry = { type, size: header.size! }, hash = createHash('sha256')
      entries.set(name, item)
      let bytes = 0
      const destination = target ? ownedPath(target, name) : undefined
      if (destination) await mkdir(type === 'directory' ? destination : dirname(destination), { recursive: true, mode: 0o700 })
      if (type === 'directory') {
        for await (const data of stream) { if (!(data instanceof Uint8Array)) throw new BrowserProfileDataUnavailable(); bytes += data.length }
        if (bytes !== 0) throw new BrowserProfileDataUnavailable()
      } else {
        const observe = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk) } })
        if (destination) await pipeline(stream, observe, createWriteStream(destination, { flags: 'wx', mode: (header.mode ?? 0o600) & 0o777 }))
        else for await (const chunk of stream) { if (!(chunk instanceof Uint8Array)) throw new BrowserProfileDataUnavailable(); bytes += chunk.length; hash.update(chunk) }
        if (bytes !== header.size) throw new BrowserProfileDataUnavailable()
        item.sha256 = hash.digest('hex')
      }
      next()
    })().catch(cause => archive.destroy(cause instanceof Error ? cause : new BrowserProfileDataUnavailable(cause)))
  })
  await pipeline(await readOriginal(path), archive)
  return entries
}

/** Only the Manager's exclusive, never-admitted partition can reach this function. */
export async function createProfileSafetyCopy(root: string, archiveId: string, purgeId: string, data: BrowserProfileRetainedPartition): Promise<SafetyCopy> {
  await inspectRetainedPartition(root, data)
  const source = retainedPartitionPath(root, data)
  const operation = ownedPath(root, `.agentmux-profile-purge/${archiveId}/${purgeId}`)
  await assertNoLinks(root, source)
  await assertNoLinks(root, operation, true)
  await mkdir(operation, { recursive: true, mode: 0o700 })
  await assertNoLinks(root, operation)
  const path = resolve(operation, 'profile.tar'), archive = pack(), originals = new Map<string, Entry>()
  const output = pipeline(archive, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
  void output.catch(() => {})
  try {
    async function add(directory: string): Promise<void> {
      const listing = await opendir(directory)
      for await (const entry of listing) {
        const file = resolve(directory, entry.name), info = await lstat(file), name = entryName(relative(source, file).split(sep).join('/'))
        if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new BrowserProfileDataUnavailable()
        const type = info.isDirectory() ? 'directory' : 'file', size = type === 'file' ? info.size : 0
        const header = { name, type, size, mode: info.mode & 0o777, mtime: info.mtime } as const
        if (type === 'directory') {
          await new Promise<void>((done, reject) => archive.entry(header, cause => cause ? reject(cause) : done()))
          originals.set(name, { type, size }); await add(file)
        } else {
          const hash = createHash('sha256'), observe = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } })
          await pipeline(await readOriginal(file), observe, archive.entry(header))
          const after = await lstat(file)
          if (after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new BrowserProfileDataUnavailable()
          originals.set(name, { type, size, sha256: hash.digest('hex') })
        }
      }
    }
    await add(source); archive.finalize(); await output
    const copied = await readCopy(path)
    if (copied.size !== originals.size || [...originals].some(([name, value]) => JSON.stringify(copied.get(name)) !== JSON.stringify(value))) throw new BrowserProfileDataUnavailable()
    await syncFileAndParents(path, root)
    return { relativePath: relative(resolve(root), path), sha256: await digest(path) }
  } catch (cause) {
    archive.destroy(cause instanceof Error ? cause : new BrowserProfileDataUnavailable(cause)); await output.catch(() => {})
    throw cause
  }
}

export async function verifyProfileSafetyCopy(root: string, copy: SafetyCopy): Promise<void> {
  const path = ownedPath(root, copy.relativePath)
  await assertNoLinks(root, path)
  if (await digest(path) !== copy.sha256) throw new BrowserProfileDataUnavailable()
  await readCopy(path)
}

/** A partial directory deletion is recoverable from the confirmed whole single-file safety copy. */
export async function restoreProfileSafetyCopy(root: string, data: BrowserProfileRetainedPartition, copy: SafetyCopy): Promise<void> {
  await verifyProfileSafetyCopy(root, copy)
  const path = ownedPath(root, copy.relativePath), target = retainedPartitionPath(root, data)
  await assertNoLinks(root, target, true)
  const operation = dirname(path), staging = await mkdtemp(resolve(operation, 'restore-'))
  const restored = await readCopy(path, staging)
  for (const name of restored.keys()) await syncFileAndParents(ownedPath(staging, name), root)
  await syncFileAndParents(staging, root)
  const partial = resolve(operation, 'partial-' + staging.slice(staging.lastIndexOf('-') + 1))
  let moved = false
  try { await rename(target, partial); moved = true }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
  try { await rename(staging, target) }
  catch (cause) { if (moved) await rename(partial, target).catch(() => {}); throw cause }
  await inspectRetainedPartition(root, data)
  await syncFileAndParents(target, root)
}

export async function removeOriginalProfileData(root: string, data: BrowserProfileRetainedPartition): Promise<void> {
  const path = retainedPartitionPath(root, data)
  await assertNoLinks(root, path)
  await rm(path, { recursive: true })
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

/** Discard partial restores first. The last complete copy is removed by one atomic unlink. */
export async function eraseProfileSafetyCopy(root: string, copy: SafetyCopy): Promise<void> {
  await verifyProfileSafetyCopy(root, copy)
  const path = ownedPath(root, copy.relativePath), operation = dirname(path), entries = await opendir(operation)
  for await (const entry of entries) if (resolve(operation, entry.name) !== path) await rm(resolve(operation, entry.name), { recursive: true })
  await unlink(path)
  const parent = await open(operation, 'r')
  try { await parent.sync() } finally { await parent.close() }
}

/** Older failed/restored copies are still owned by the same Profile; keep the current full copy until these are gone. */
export async function eraseHistoricalProfilePurge(root: string, receipt: { archiveId: string; purgeId: string }): Promise<void> {
  const path = ownedPath(root, `.agentmux-profile-purge/${receipt.archiveId}/${receipt.purgeId}`)
  await assertNoLinks(root, path, true)
  try { await rm(path, { recursive: true }) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
}
