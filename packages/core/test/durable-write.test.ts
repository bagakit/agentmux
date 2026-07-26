import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * durable-write 的关键契约是**顺序**：write → fsync(文件) → rename → fsync(目录)。
 * 只断言「sync 被调过」是假绿——把 handle.sync() 挪到 rename 之后必须让某条断言变红。
 *
 * 这个 mock 把 node:fs/promises 整体保留（委托给真实实现，所以真·文件系统行为照常发生），
 * 只在 open/rename 上挂钩：
 *  - open：真开文件/目录，但把返回 handle 的 sync/writeFile 包一层，往 seq 记录调用次序；
 *    目录 sync 记 'dir:sync'，文件 sync 记 'file:sync'，文件写记 'file:write'。
 *  - rename：记录 'rename'，可按开关抛错以驱动「失败清理」路径。
 * recording 默认关，只有顺序测试打开它，避免污染其它用例。
 */
const ctl = vi.hoisted(() => ({
  seq: [] as string[],
  recording: false,
  openCount: 0,
  renameError: null as Error | null,
  dirSyncError: null as Error | null,
  onFileWrite: null as (() => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = vi.fn(async (path: string, flags?: string, mode?: number) => {
    ctl.openCount += 1
    const handle = await actual.open(path, flags as never, mode as never)
    const isDirectory = flags === 'r'
    const originalSync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (isDirectory) {
        if (ctl.recording) ctl.seq.push('dir:sync')
        if (ctl.dirSyncError) throw ctl.dirSyncError
        return originalSync()
      }
      if (ctl.recording) ctl.seq.push('file:sync')
      return originalSync()
    }
    if (!isDirectory) {
      const originalWriteFile = handle.writeFile.bind(handle)
      handle.writeFile = (async (content: never, options: never) => {
        if (ctl.recording) ctl.seq.push('file:write')
        const result = await originalWriteFile(content, options)
        ctl.onFileWrite?.()
        return result
      }) as typeof handle.writeFile
    }
    return handle
  })
  const rename = vi.fn(async (from: string, to: string) => {
    if (ctl.recording) ctl.seq.push('rename')
    if (ctl.renameError) throw ctl.renameError
    return actual.rename(from, to)
  })
  return { ...actual, open, rename }
})

import { durableWriteFile } from '../src/durable-write.js'

const roots: string[] = []

afterEach(async () => {
  ctl.seq = []
  ctl.recording = false
  ctl.openCount = 0
  ctl.renameError = null
  ctl.dirSyncError = null
  ctl.onFileWrite = null
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-durable-write-'))
  roots.push(root)
  return root
}

function permissionBits(mode: number): number {
  // open(mode) 落盘时会被 umask 削一刀，断言要跟着 umask 走才不会在别的机器上 flake。
  return mode & ~process.umask()
}

describe('durableWriteFile 行为', () => {
  it('把内容原子落到目标路径，默认权限 0o600，且不留临时文件', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')

    await durableWriteFile(path, '{"ok":true}\n')

    expect(await readFile(path, 'utf8')).toBe('{"ok":true}\n')
    const meta = await stat(path)
    expect(meta.mode & 0o777).toBe(permissionBits(0o600))
    const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('尊重传入的 mode', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')

    await durableWriteFile(path, 'x', { mode: 0o640 })

    const meta = await stat(path)
    expect(meta.mode & 0o777).toBe(permissionBits(0o640))
  })

  it('接受 Buffer，并原子覆盖已存在的文件', async () => {
    const root = await tempDir()
    const path = join(root, 'state.bin')
    await durableWriteFile(path, 'old-content')

    await durableWriteFile(path, Buffer.from('new-binary'))

    expect(await readFile(path, 'utf8')).toBe('new-binary')
    const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('durableWriteFile 顺序（本任务的核心）', () => {
  it('按 write → fsync(文件) → rename → fsync(目录) 的次序执行，不可交换', async () => {
    const root = await tempDir()
    const path = join(root, 'ordered.json')

    ctl.recording = true
    await durableWriteFile(path, 'payload')
    ctl.recording = false

    // 整条次序钉死：把 handle.sync() 挪到 rename 之后，或删掉任一步，这个 deep-equal 立刻变红。
    expect(ctl.seq).toEqual(['file:write', 'file:sync', 'rename', 'dir:sync'])
    // 冗余但报错更直白：文件 fsync 必须早于 rename（否则 rename 换上来的是页缓存里的空壳）。
    expect(ctl.seq.indexOf('file:sync')).toBeLessThan(ctl.seq.indexOf('rename'))
    // 目录 fsync 必须晚于 rename（先有新目录项，再把这条目录项刷盘）。
    expect(ctl.seq.indexOf('rename')).toBeLessThan(ctl.seq.indexOf('dir:sync'))
  })
})

describe('durableWriteFile 失败与边界', () => {
  it('rename 失败时清理临时文件，且不留下半写的目标文件', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')
    ctl.renameError = new Error('boom-rename')

    await expect(durableWriteFile(path, 'data')).rejects.toThrow('boom-rename')

    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('目录 fsync 不被支持（抛错）时吞掉错误，写入仍然成功', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')
    const dirSyncError = Object.assign(new Error('EINVAL dir fsync'), { code: 'EINVAL' })
    ctl.dirSyncError = dirSyncError

    await expect(durableWriteFile(path, 'best-effort')).resolves.toBeUndefined()

    expect(await readFile(path, 'utf8')).toBe('best-effort')
  })

  it('入口处已 abort 的 signal 直接抛出，不碰文件系统', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')
    const controller = new AbortController()
    controller.abort()

    await expect(durableWriteFile(path, 'data', { signal: controller.signal })).rejects.toThrow()

    // 入口的 throwIfAborted 若被删，这里会去 open 临时文件——openCount 会 > 0。
    expect(ctl.openCount).toBe(0)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('写完文件后、rename 前发生 abort：不 rename，且清理临时文件', async () => {
    const root = await tempDir()
    const path = join(root, 'state.json')
    const controller = new AbortController()
    ctl.onFileWrite = () => controller.abort()

    await expect(durableWriteFile(path, 'data', { signal: controller.signal })).rejects.toThrow()

    // rename 前的 throwIfAborted 若被删，abort 会被无视，目标文件会被写出来。
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

/**
 * 覆盖性契约：会话存储、时间轴快照、三个桌面侧存储这五个 sink 必须都走 durableWriteFile，
 * 且不能残留 rename()/裸 writeFile() 的老原子写代码。
 * 事实从源码反推（grep 真实文件），并自证扫描非空——扫到空集是这类测试的典型假绿。
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

const REQUIRED_DURABLE_SINKS = [
  // 一个文件里两个 sink：会话文档 + 时间轴快照。
  { file: 'packages/core/src/agent-session-store.ts', minCalls: 2 },
  { file: 'apps/desktop/src/main/config-store.ts', minCalls: 1 },
  { file: 'apps/desktop/src/main/window-geometry-store.ts', minCalls: 1 },
  { file: 'apps/desktop/src/main/browser-profile-store.ts', minCalls: 1 }
] as const

async function readSource(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), 'utf8')
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0
}

describe('持久化写入的覆盖性与不遗漏', () => {
  it('五个 sink 都调用 durableWriteFile（自证扫描非空）', async () => {
    expect(REQUIRED_DURABLE_SINKS.length).toBeGreaterThan(0)
    let totalCalls = 0
    for (const sink of REQUIRED_DURABLE_SINKS) {
      const source = await readSource(sink.file)
      const calls = countMatches(source, /durableWriteFile\s*\(/g)
      expect(calls, `${sink.file} 应至少有 ${sink.minCalls} 处 durableWriteFile 调用`).toBeGreaterThanOrEqual(
        sink.minCalls
      )
      totalCalls += calls
    }
    // 自证：确实扫到了写入点，而不是扫了个空集骗过去。
    expect(totalCalls).toBeGreaterThan(0)
  })

  it('这些 sink 不再残留 rename() 或裸 writeFile() 的老原子写', async () => {
    let scanned = 0
    for (const sink of REQUIRED_DURABLE_SINKS) {
      const source = await readSource(sink.file)
      scanned += 1
      // durableWriteFile 内部自己 rename，sink 里不该再出现手写 rename()。
      expect(countMatches(source, /\brename\s*\(/g), `${sink.file} 不应再手写 rename()`).toBe(0)
      // 模块级 writeFile() 提交写；handle.writeFile()（锁文件那种）不算，用负向前瞻排除掉。
      expect(
        countMatches(source, /(?<![.\w])writeFile\s*\(/g),
        `${sink.file} 不应再用裸 writeFile() 提交`
      ).toBe(0)
    }
    expect(scanned).toBe(REQUIRED_DURABLE_SINKS.length)
  })
})
