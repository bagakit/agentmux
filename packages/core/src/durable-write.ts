import { mintObjectId } from './object-id.js'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { directoryRenameAt, directoryUnlinkAt, syncDirectoryWriteParent, writeDirectoryFile, type DirectoryWriteParent } from './directory-write.js'

export interface DurableWriteOptions {
  /** 新文件的权限位。默认 0o600——状态文件只给属主读写。 */
  readonly mode?: number
  readonly signal?: AbortSignal
  /** Require an acknowledged parent-directory fsync; failure leaves the write unconfirmed. */
  readonly requireDirectorySync?: boolean
  /** Re-prove the exact destination parent immediately before each publication effect. */
  readonly assertDirectory?: () => Promise<void>
  /** Hold the proven parent descriptor for openat/renameat/unlinkat publication. */
  readonly directory?: DirectoryWriteParent
}

/** Replacement is a producer fact; a failed directory ACK cannot undo it. */
export class DurableWriteError extends Error {
  readonly code?: string
  private readonly cleanupFailures: { operation: string; code: string | null; message: string }[] = []
  /** Original owner cleanup receipts; callers need not parse human-facing error detail. */
  get cleanupIncomplete(): boolean { return this.cleanupFailures.length > 0 }
  get detail(): string { return JSON.stringify({ path: this.path.slice(0, 1024), phase: this.phase, cleanupFailures: this.cleanupFailures }) }
  addCleanupFailure(operation: string, error: unknown): void {
    if (this.cleanupFailures.length >= 2) return
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    this.cleanupFailures.push({ operation, code: typeof code === 'string' ? code.slice(0, 128) : null,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 512) })
  }
  constructor(readonly path: string, readonly phase: 'before-replace' | 'after-replace', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DurableWriteError'
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    if (typeof code === 'string') this.code = code
  }
}

/**
 * 原子且持久地写一个文件：临时文件 → fsync(文件) → rename → fsync(父目录)。
 *
 * rename 本身是原子的，但**不是持久的**：崩溃或断电若落在 rename 与内核把数据刷盘之间，
 * 目标文件可能回退到旧内容，或者变成 0 字节。所以三步顺序缺一不可，且**不可交换**——
 * 必须先把新内容刷进磁盘，再 rename，最后刷父目录让这条目录项本身落地。把 fsync 挪到
 * rename 之后、或者干脆不 fsync，就等于回到「原子但会丢」的老问题。
 *
 * 要求持久确认的调用者收到分阶段错误：rename 后目录 flush 失败不能冒充未写入，
 * 也不能把当前读得到字节冒充断电后的保证。
 */
export async function durableWriteFile(
  path: string,
  // 用 Uint8Array 而不是 Buffer：Buffer 是 Node 全局，写进导出面就等于要求每个消费者装 @types/node。
  // Buffer 本身就是 Uint8Array 的子类，调用方传 Buffer 照样通过（见 durable-write.test.ts 的二进制用例）。
  content: string | Uint8Array,
  options: DurableWriteOptions = {}
): Promise<void> {
  const { mode = 0o600, signal } = options
  signal?.throwIfAborted()
  await options.assertDirectory?.()
  // 独立 ID 后缀让并发写各自拿到独立临时文件，wx（O_EXCL）保证不会误踩已存在的临时残留。
  const temporaryPath = `${path}.${process.pid}.${mintObjectId()}.tmp`
  const temporaryName = basename(temporaryPath), targetName = basename(path)
  let committed = false
  let directoryTemporaryCreated = false
  let failure: DurableWriteError | undefined
  const primary = (error: unknown) => failure ??= new DurableWriteError(path, committed ? 'after-replace' : 'before-replace', error)
  try {
    if (options.directory) {
      await writeDirectoryFile(options.directory, temporaryName, content, mode, {
        opened: () => { directoryTemporaryCreated = true },
        closeFailed: (error, closeError) => { primary(error).addCleanupFailure('close', closeError) }
      })
    } else {
      const handle = await open(temporaryPath, 'wx', mode)
      try {
        await handle.writeFile(content)
        // rename 之前先把这份新内容刷进磁盘，否则原子 rename 换上来的是一个可能还在页缓存里的空壳。
        await handle.sync()
      } catch (error) { throw primary(error) } finally {
        try { await handle.close() } catch (error) {
          if (failure) failure.addCleanupFailure('close', error)
          else throw error
        }
      }
    }
    signal?.throwIfAborted()
    await options.assertDirectory?.()
    if (options.directory) directoryRenameAt(options.directory, temporaryName, targetName)
    else await rename(temporaryPath, path)
    committed = true
    await options.assertDirectory?.()
    const directory = options.directory?.handle ?? await open(dirname(path), 'r').catch(error => {
      if (options.requireDirectorySync) throw error
      return undefined
    })
    try {
      await options.assertDirectory?.()
      if (options.directory) await syncDirectoryWriteParent(options.directory)
      else await directory?.sync()
    } catch (error) { if (options.assertDirectory || options.requireDirectorySync) throw primary(error) } finally {
      try { if (!options.directory) await directory?.close() } catch (error) {
        if (failure) failure.addCleanupFailure('directory-close', error)
        else if (options.requireDirectorySync) throw error
      }
    }
  } catch (error) {
    throw primary(error)
  } finally {
    if (!committed) {
      if (options.directory) {
        if (directoryTemporaryCreated) try { directoryUnlinkAt(options.directory, temporaryName) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') primary(error).addCleanupFailure('unlinkat', error)
        }
      } else {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') primary(error).addCleanupFailure('unlink', error)
        })
      }
    }
  }
}
