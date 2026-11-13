import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { copyFile, open, rm, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { AgentMuxError } from './errors.js'

type CloneCall = { async(sourceFd: number, directoryFd: number, name: string, flags: number, done: (error: Error | null, result: number) => void): void }
let darwinClone: CloneCall | undefined
type GenerationCall = (fd: number, attributes: Buffer, result: Buffer, size: number, options: number) => number
let darwinGeneration: GenerationCall | undefined
function darwinLibrary() {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  return koffi.load('/usr/lib/libSystem.B.dylib')
}
/** Darwin getattrlist(2): a nonzero ATTR_CMN_GEN_COUNT is a monotonic data
 * generation, unchanged iff data is unchanged. Zero (including mmap writers)
 * means unknown. mtime/ctime and matching samples cannot substitute for it. */
export function nativeDataGeneration(source: FileHandle): number | undefined {
  if (process.platform !== 'darwin') return undefined
  darwinGeneration ??= darwinLibrary().func('int fgetattrlist(int fd, const void *attributes, void *result, size_t size, unsigned long options)') as GenerationCall
  const attributes = Buffer.alloc(24), result = Buffer.alloc(128)
  attributes.writeUInt16LE(5, 0); attributes.writeUInt32LE(0x80080000, 4)
  const status = darwinGeneration!(source.fd, attributes, result, result.length, 0x20)
  if (status !== 0 || result.readUInt32LE(0) !== 28 || (result.readUInt32LE(4) & 0x80000) === 0 || result.readUInt32LE(24) === 0)
    throw new AgentMuxError('The filesystem cannot confirm the original data generation. Ordinary reading and input remain available.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
  return result.readUInt32LE(24)
}

/** The file owner supplies the already-open source FD. No source pathname race,
 * generic-copy fallback, compiler, subprocess or UI dependency is admitted here.
 * The private destination is not published until its caller commits a manifest. */
export async function cloneNativeFile(source: FileHandle, directory: string, name: string, signal: AbortSignal): Promise<{ origin: BigIntStats; dataGeneration?: number }> {
  signal.throwIfAborted()
  if (!/^[a-zA-Z0-9_-]+[.]jsonl$/u.test(name)) throw new AgentMuxError('Invalid private snapshot basename.', 'INVALID_CONTROL_REQUEST')
  const destination = join(directory, name)
  let created = false
  try {
    const generation = nativeDataGeneration(source)
    const origin = await source.stat({ bigint: true })
    if (!origin.isFile() || origin.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentMuxError('The original source is not a readable bounded-offset file.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
    if (process.platform === 'darwin') {
      if (!darwinClone) {
        // Lazy loading keeps ordinary readers usable when optional native evidence
        // is unavailable. Koffi ships maintained Node-API platform prebuilds.
        darwinClone = darwinLibrary().func('int fclonefileat(int srcfd, int dst_dirfd, const char *dst, int flags)') as CloneCall
      }
      const target = await open(directory, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        await new Promise<void>((resolve, reject) => darwinClone!.async(source.fd, target.fd, name, 0, (error, result) => {
          if (error) reject(error)
          else if (result !== 0) reject(new AgentMuxError('The filesystem did not confirm an FD-bound copy-on-write clone.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE'))
          else { created = true; resolve() }
        }))
      } finally { await target.close() }
      // The native clone's all-or-nothing destination contract alone does not
      // promise a concurrent-write image. The held object's data generation must
      // cover the entire clone, including its asynchronous physical completion.
      if (nativeDataGeneration(source) !== generation) throw new AgentMuxError('The original source changed while its snapshot was acquired.', 'AGENT_SESSION_HISTORY_BUSY')
    } else if (process.platform === 'linux') {
      // /proc/self/fd resolves this held descriptor, not a mutable source locator.
      // FORCE forbids libuv falling back from FICLONE to a copying loop.
      await copyFile(`/proc/self/fd/${source.fd}`, destination, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
      created = true
    } else throw new AgentMuxError('This platform has no qualified FD-bound native snapshot primitive.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
    signal.throwIfAborted()
    return { origin, ...(generation === undefined ? {} : { dataGeneration: generation }) }
  } catch (error) {
    // Native calls settle physically before their FDs or owned candidate are closed.
    if (created) await rm(destination).catch(() => undefined)
    signal.throwIfAborted()
    if (error instanceof AgentMuxError) throw error
    throw new AgentMuxError('The filesystem could not confirm the original native snapshot. Ordinary reads and input remain available.', 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE')
  }
}
