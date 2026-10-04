import { constants, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AVATAR_OUTPUT_MAX_BYTES, isObjectAvatarRef, type ObjectAvatarRef } from '../shared/object-avatars.js'

async function regularDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('The avatar directory is not its original regular directory.')
}

/** Only an original object owner can supply this confirmed physical directory. */
async function avatarDirectory(original: string, create = false): Promise<string> {
  await regularDirectory(original, false)
  const metadata = join(original, '.agentmux'), assets = join(metadata, 'avatars')
  await regularDirectory(metadata, create); await regularDirectory(assets, create)
  return assets
}

export async function readObjectAvatarFile(original: string, ref: ObjectAvatarRef): Promise<Buffer> {
  if (!isObjectAvatarRef(ref)) throw new Error('The avatar reference is invalid.')
  const path = join(await avatarDirectory(original), ref.fileName)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let png: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > AVATAR_OUTPUT_MAX_BYTES) throw new Error('The avatar is not a bounded regular file.')
    const buffer = Buffer.alloc(AVATAR_OUTPUT_MAX_BYTES + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    if (count > AVATAR_OUTPUT_MAX_BYTES) throw new Error('The avatar exceeds its read limit.')
    png = buffer.subarray(0, count)
  } finally { await handle.close() }
  if (createHash('sha256').update(png).digest('hex') + '.png' !== ref.fileName) throw new Error('The avatar bytes do not match their reference.')
  return png
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Immutable assets never replace an unknown existing file; the original preference chooses them. */
export async function saveObjectAvatarFile(original: string, png: Buffer): Promise<ObjectAvatarRef> {
  if (!png.length || png.length > AVATAR_OUTPUT_MAX_BYTES) throw new Error('Save a bounded avatar crop.')
  const ref: ObjectAvatarRef = { kind: 'image', fileName: createHash('sha256').update(png).digest('hex') + '.png' }
  const directory = await avatarDirectory(original, true), path = join(directory, ref.fileName)
  let handle
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await readObjectAvatarFile(original, ref)
    // A prior save may have reached disk without its parent-sync acknowledgement.
    const saved = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try { await saved.sync() } finally { await saved.close() }
    await syncDirectory(directory); await syncDirectory(join(original, '.agentmux')); await syncDirectory(original)
    return ref
  }
  try { await handle.writeFile(png); await handle.sync() }
  catch (error) { await unlink(path).catch(() => {}); throw error }
  finally { await handle.close() }
  // Keep completed bytes if a durability observation fails; retry can inspect the exact hash.
  await syncDirectory(directory); await syncDirectory(join(original, '.agentmux')); await syncDirectory(original)
  return ref
}
