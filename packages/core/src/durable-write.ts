import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DurableWriteOptions {
  /** 新文件的权限位。默认 0o600——状态文件只给属主读写。 */
  readonly mode?: number
  readonly signal?: AbortSignal
}

/**
 * 原子且持久地写一个文件：临时文件 → fsync(文件) → rename → fsync(父目录)。
 *
 * rename 本身是原子的，但**不是持久的**：崩溃或断电若落在 rename 与内核把数据刷盘之间，
 * 目标文件可能回退到旧内容，或者变成 0 字节。所以三步顺序缺一不可，且**不可交换**——
 * 必须先把新内容刷进磁盘，再 rename，最后刷父目录让这条目录项本身落地。把 fsync 挪到
 * rename 之后、或者干脆不 fsync，就等于回到「原子但会丢」的老问题。
 *
 * 父目录 fsync 尽力而为：部分文件系统对目录句柄的 fsync 返回 EINVAL/EISDIR/EACCES，
 * 那不代表数据没落盘，吞掉即可，不阻断这次写入。
 */
export async function durableWriteFile(
  path: string,
  content: string | Buffer,
  options: DurableWriteOptions = {}
): Promise<void> {
  const { mode = 0o600, signal } = options
  signal?.throwIfAborted()
  // UUID 后缀让并发写各自拿到独立临时文件，wx（O_EXCL）保证不会误踩已存在的临时残留。
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let committed = false
  try {
    const handle = await open(temporaryPath, 'wx', mode)
    try {
      await handle.writeFile(content)
      // rename 之前先把这份新内容刷进磁盘，否则原子 rename 换上来的是一个可能还在页缓存里的空壳。
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    await rename(temporaryPath, path)
    committed = true
    await syncDirectory(dirname(path))
  } finally {
    if (!committed) {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}

/**
 * fsync 父目录，让「新文件名指向新 inode」这条目录项本身落盘——否则断电后文件内容在盘上，
 * 但目录还指向旧的或没有这一项。尽力而为：目录 fsync 在部分平台/文件系统不被支持。
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // 目录 fsync 不被支持不代表数据没落盘，忽略。
  } finally {
    await handle?.close().catch(() => {})
  }
}
