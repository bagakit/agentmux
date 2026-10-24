import { mintObjectId } from '@agentmux/core/object-id'
import { constants, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AVATAR_OUTPUT_MAX_BYTES, AVATAR_MAX_DIMENSION, AVATAR_MAX_PIXELS, isObjectAvatarRef, type ObjectAvatarRef, type ObjectAvatarInput } from './object-avatars.js'

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
  const temporaryPath = join(directory, ref.fileName + '.' + mintObjectId() + '.tmp')
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await handle.writeFile(png); await handle.sync() }
    finally { await handle.close() }
    // Publish complete acknowledged bytes without replacing an existing immutable image.
    try { await link(temporaryPath, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await readObjectAvatarFile(original, ref)
      // A prior save may have reached disk without its parent-sync acknowledgement.
      const saved = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try { await saved.sync() } finally { await saved.close() }
    }
  } catch (error) {
    // Another saver may already have acknowledged the formal hash path. It is never ours to delete.
    await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Avatar write and its temporary-file cleanup both failed.')
    })
    throw error
  }
  await unlink(temporaryPath)
  // Keep completed bytes if a durability observation fails; retry can inspect the exact hash.
  await syncDirectory(directory); await syncDirectory(join(original, '.agentmux')); await syncDirectory(original)
  return ref
}

type ImageSize = { width: number; height: number }
export function assertObjectAvatarSize({ width, height }: ImageSize): void {
  if (width < 1 || height < 1 || width > AVATAR_MAX_DIMENSION || height > AVATAR_MAX_DIMENSION || width * height > AVATAR_MAX_PIXELS)
    throw new Error('Choose an image at most 4096 pixels per side and 16 megapixels.')
}
/** Inspect encoded dimensions before native decoding can allocate the image. */
export function objectAvatarImageSize(bytes: Buffer, mime: ObjectAvatarInput['mimeType']): ImageSize {
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break
      if (bytes[offset + 1] === 255) { offset++; continue }
      const marker = bytes[offset + 1]!, length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ([192, 193, 194].includes(marker) && length >= 8)
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      offset += 2 + length
    }
  } else if (mime === 'image/png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') throw new Error('Choose a static PNG or JPEG image.')
      if (offset + length + 12 > bytes.length) throw new Error('The PNG is incomplete.')
      offset += length + 12
      if (type === 'IEND' && length === 0 && offset === bytes.length) return size
    }
  }
  throw new Error('Choose a valid static PNG or JPEG image.')
}

