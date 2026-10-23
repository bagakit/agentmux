import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, readdir, lstat, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export class CapsuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CapsuleError'
  }
}
export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IO_UNCONFIRMED'
}
export function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
export async function readOptional(path: string): Promise<unknown | null> {
  try {
    return await readJson(path)
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return null
    throw e
  }
}
/** Atomic replace with file and containing directory sync; failure never destroys the previous file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await durableMkdir(dirname(path))
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await unlink(temporary).catch((e) => {
      if (errorCode(e) !== 'ENOENT') throw e
    })
  }
}
/** Read-back alone cannot confirm a rename survived a storage failure. */
export async function confirmDurable(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDirectory(dirname(path))
}
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
/** Sync every newly introduced directory entry, including parents created recursively. */
export async function durableMkdir(path: string): Promise<void> {
  try {
    const existing = await lstat(path)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new CapsuleError(
        'CAPSULE_SOURCE_UNSAFE',
        'The exact directory boundary is not a regular directory.',
      )
    }
    return
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  await durableMkdir(dirname(path))
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
  await syncDirectory(dirname(path))
}
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}
export async function directory(path: string): Promise<string> {
  const absolute = resolve(path),
    info = await lstat(absolute)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new CapsuleError(
      'CAPSULE_SOURCE_UNSAFE',
      'The exact content root must be a real directory, not a symbolic link.',
    )
  return realpath(absolute)
}
/** Resolve a not-yet-created path through its nearest existing ancestor. */
export async function futurePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await futurePath(parent), basename(path))
  }
}
/** Check before mkdir: importing an ancestor of the destination would copy itself forever. */
export async function prepareImport(source: string, destination: string): Promise<string> {
  const target = await futurePath(resolve(destination))
  if (within(source, target)) {
    throw new CapsuleError(
      'CAPSULE_SOURCE_CONTAINS_DESTINATION',
      'The import source contains the managed destination. Choose a separate build directory or managed root.',
    )
  }
  return target
}
/** Refuse links and special files during import. Copy each opened regular file, then sync it. */
export async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  await syncDirectory(dirname(destination))
  for (const name of await readdir(source)) {
    const from = join(source, name),
      to = join(destination, name),
      stat = await lstat(from)
    if (stat.isSymbolicLink())
      throw new CapsuleError(
        'CAPSULE_SOURCE_UNSAFE',
        'Managed import does not follow symbolic links. Publish a build directory with regular files.',
      )
    if (stat.isDirectory()) {
      await copyTree(from, to)
      continue
    }
    if (!stat.isFile())
      throw new CapsuleError(
        'CAPSULE_SOURCE_UNSAFE',
        'Managed import accepts regular files and directories only.',
      )
    const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
    let output: Awaited<ReturnType<typeof open>> | undefined
    try {
      output = await open(to, 'wx', 0o600)
      const opened = await input.stat()
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
        throw new CapsuleError(
          'CAPSULE_SOURCE_CHANGED',
          'The source changed during import. Original published content is preserved.',
        )
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        let offset = 0
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
          offset += bytesWritten
        }
      }
      const after = await input.stat()
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      ) {
        throw new CapsuleError(
          'CAPSULE_SOURCE_CHANGED',
          'The source changed during import. The prepared copy was not published.',
        )
      }
      await output.sync()
    } finally {
      try {
        await input.close()
      } finally {
        await output?.close()
      }
    }
  }
  const dir = await open(destination, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
/** Resolve only a regular file inside the pinned real root. Links are never served. */
export async function safeFile(
  root: string,
  relativePath: string,
): Promise<import('node:fs/promises').FileHandle> {
  if (
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((p) => p === '..')
  )
    throw new CapsuleError('CAPSULE_PATH_REJECTED', 'The requested path is outside the content boundary.')
  const canonicalRoot = await directory(root),
    candidate = resolve(canonicalRoot, relativePath)
  if (!within(canonicalRoot, candidate))
    throw new CapsuleError('CAPSULE_PATH_REJECTED', 'The requested path is outside the content boundary.')
  const parts = relative(canonicalRoot, candidate).split(/[\\/]/u).filter(Boolean)
  let current = canonicalRoot
  for (const part of parts) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink())
      throw new CapsuleError('CAPSULE_PATH_REJECTED', 'Symbolic links are not served.')
  }
  const canonical = await realpath(candidate)
  if (!within(canonicalRoot, canonical))
    throw new CapsuleError('CAPSULE_PATH_REJECTED', 'The requested path is outside the content boundary.')
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile())
      throw new CapsuleError('CAPSULE_NOT_FILE', 'The requested path is not a regular file.')
    return file
  } catch (e) {
    await file.close()
    throw e
  }
}
