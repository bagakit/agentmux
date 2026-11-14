import { close, constants, fsync, fstat, readFile, readlinkSync, writeFile } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxError } from './errors.js'

export type DirectoryIdentity = { dev: string; ino: string }
export type DirectoryWriteParent = { handle: FileHandle; identity: DirectoryIdentity; realpath: string }
type NativeDirectoryCalls = {
  openat(fd: number, name: string, flags: number, modeType: string, mode: number): number
  mkdirat(fd: number, name: string, mode: number): number
  renameat(oldFd: number, oldName: string, newFd: number, newName: string): number
  unlinkat(fd: number, name: string, flags: number): number
  fcntl(fd: number, command: number, argumentType: string, argument: Buffer): number
}

const writeFileAsync = promisify(writeFile)
const readFileAsync = promisify(readFile)
const fstatAsync = promisify(fstat)
const fsyncAsync = promisify(fsync)
const closeAsync = promisify(close)
const closeOnExec = process.platform === 'darwin' ? 0x1000000 : 0x80000 // O_CLOEXEC is not exported by Node on every supported platform.
let calls: NativeDirectoryCalls | undefined

function nativeDirectoryCalls(): NativeDirectoryCalls {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new AgentMuxError('This platform has no qualified descriptor-relative directory primitives.', 'DIRECTORY_DESCRIPTOR_UNSUPPORTED')
  }
  if (calls) return calls
  try {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
    const library = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6')
    calls = {
      openat: library.func('int openat(int fd, const char *path, int flags, ...)'),
      mkdirat: library.func('int mkdirat(int fd, const char *path, unsigned int mode)'),
      renameat: library.func('int renameat(int oldfd, const char *oldpath, int newfd, const char *newpath)'),
      unlinkat: library.func('int unlinkat(int fd, const char *path, int flags)'),
      fcntl: library.func('int fcntl(int fd, int cmd, ...)')
    }
    return calls
  } catch (cause) {
    throw new AgentMuxError('The required descriptor-relative directory primitives are unavailable.', 'DIRECTORY_DESCRIPTOR_UNSUPPORTED', String(cause))
  }
}

export function assertDirectoryWriteSupport(): void {
  nativeDirectoryCalls()
}

function nativeError(operation: string, result: number): NodeJS.ErrnoException {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const value = koffi.errno()
  const entry = Object.entries(koffi.os.errno).find(([, code]) => code === value)
  return Object.assign(new Error(`${operation} failed with native errno ${value} (result ${result})`), { code: entry?.[0] ?? `ERRNO_${value}`, errno: value })
}

function validName(name: string): void {
  if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('\0')) {
    throw new AgentMuxError('A descriptor-relative write needs one exact basename.', 'DIRECTORY_DESCRIPTOR_INVALID_NAME')
  }
}

/** Open after the caller's proof and bind the descriptor itself to that same identity. */
export async function openDirectoryWriteParent(path: string, expected: (DirectoryIdentity & { realpath: string }) | { identity: DirectoryIdentity; realpath: string }): Promise<DirectoryWriteParent> {
  assertDirectoryWriteSupport()
  const identity = 'identity' in expected ? expected.identity : expected
  const handle = await open(path, 'r')
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isDirectory() || stats.dev.toString(10) !== identity.dev || stats.ino.toString(10) !== identity.ino ||
        nativeDirectoryLocation(handle) !== expected.realpath) {
      throw new AgentMuxError('The opened parent differs from the proven directory identity or location.', 'DIRECTORY_DESCRIPTOR_IDENTITY_MISMATCH')
    }
    return { handle, identity: { dev: identity.dev, ino: identity.ino }, realpath: expected.realpath }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function nativeDirectoryLocation(handle: FileHandle): string {
  if (process.platform === 'darwin') {
    const path = Buffer.alloc(4096)
    const result = nativeDirectoryCalls().fcntl(handle.fd, 50, 'void *', path) // F_GETPATH
    if (result !== 0) throw nativeError('fcntl(F_GETPATH)', result)
    const nul = path.indexOf(0)
    return path.toString('utf8', 0, nul < 0 ? path.length : nul)
  }
  return readlinkSync(`/proc/self/fd/${handle.fd}`)
}

function assertDirectoryLocation(parent: DirectoryWriteParent): void {
  if (nativeDirectoryLocation(parent.handle) !== parent.realpath) {
    throw new AgentMuxError('The proven parent moved before a descriptor-relative write.', 'DIRECTORY_DESCRIPTOR_LOCATION_CHANGED')
  }
}

export async function syncDirectoryWriteParent(parent: DirectoryWriteParent): Promise<void> {
  assertDirectoryLocation(parent)
  await parent.handle.sync()
}

export function directoryOpenAt(parent: DirectoryWriteParent, name: string, flags: number, mode: number): number {
  validName(name)
  assertDirectoryLocation(parent)
  const result = nativeDirectoryCalls().openat(parent.handle.fd, name, flags, 'unsigned int', mode)
  if (result < 0) throw nativeError('openat', result)
  return result
}

export async function readDirectoryFile(parent: DirectoryWriteParent, name: string): Promise<string> {
  const fd = directoryOpenAt(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec | constants.O_NONBLOCK, 0)
  try {
    const stats = await fstatAsync(fd)
    if (!stats.isFile()) throw new AgentMuxError('The descriptor-relative entry is not an ordinary file.', 'DIRECTORY_DESCRIPTOR_NOT_FILE')
    return await readFileAsync(fd, 'utf8') as string
  } finally {
    await closeAsync(fd)
  }
}

export async function writeDirectoryFile(
  parent: DirectoryWriteParent,
  name: string,
  content: string | Uint8Array,
  mode: number,
  observer?: { opened(): void; closeFailed(primary: unknown, close: unknown): void }
): Promise<void> {
  const fd = directoryOpenAt(parent, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec, mode)
  let failure: unknown
  let failed = false
  try {
    observer?.opened()
    await writeFileAsync(fd, content)
    await fsyncAsync(fd)
  } catch (error) {
    failure = error
    failed = true
    throw error
  } finally {
    try { await closeAsync(fd) } catch (closeError) {
      if (!failed) throw closeError
      if (observer) observer.closeFailed(failure, closeError)
      else throw new AggregateError([failure, closeError], failure instanceof Error ? failure.message : String(failure), { cause: failure })
    }
  }
}

export function directoryMkdirAt(parent: DirectoryWriteParent, name: string, mode: number): void {
  validName(name)
  assertDirectoryLocation(parent)
  const result = nativeDirectoryCalls().mkdirat(parent.handle.fd, name, mode)
  if (result !== 0) throw nativeError('mkdirat', result)
}

export function directoryRenameAt(parent: DirectoryWriteParent, oldName: string, newName: string): void {
  validName(oldName); validName(newName)
  assertDirectoryLocation(parent)
  const result = nativeDirectoryCalls().renameat(parent.handle.fd, oldName, parent.handle.fd, newName)
  if (result !== 0) throw nativeError('renameat', result)
}

export function directoryUnlinkAt(parent: DirectoryWriteParent, name: string): void {
  validName(name)
  assertDirectoryLocation(parent)
  const result = nativeDirectoryCalls().unlinkat(parent.handle.fd, name, 0)
  if (result !== 0) throw nativeError('unlinkat', result)
}
