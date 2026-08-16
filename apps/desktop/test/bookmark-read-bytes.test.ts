import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'

/**
 * `readBookmarkBytes` 的**远端**分支：远端 host 的 `run` 只给 utf8 解码后的 string
 * （`process-runner.ts:16/78`），二进制 plist 经它往返必坏。所以远端只支持文本形态的书签，
 * 二进制（含 NUL）**显式返回 null**——诚实地说「取不回」，而不是交出一份类型合法、内容已坏的
 * `Uint8Array`（那会让下游白跑一次 `plutil`，并把通路缺陷伪装成坏文件）。
 *
 * 两条一起才守得住：
 *  - 负例：远端 stdout 含 NUL → null（删掉 `isBinaryContent` 那行会让这条翻红——变异判据）。
 *  - 正例：远端 `.url`（纯文本）→ 返回可解析的字节。没有正例的话「一律 null」也能骗过负例。
 */

function remoteHostReturning(stdout: string): { host: ExecutionHost; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
    if (command === 'realpath') return { stdout: `${String(args.at(-1))}\n`, stderr: '', exitCode: 0 }
    if (command === 'sh') return { stdout, stderr: '', exitCode: 0 }
    throw new Error(`Unexpected command: ${command}`)
  })
  return {
    run,
    host: { id: 'remote', kind: 'ssh', label: 'Remote', run, exposeLoopbackPort: async (p) => p, dispose: async () => {} }
  }
}

const workspace: WorkspaceRecord = {
  id: 'remote-workspace',
  name: 'project',
  hostId: 'remote',
  path: '/srv/project',
  kind: 'folder'
}

const NUL = String.fromCharCode(0)

describe('readBookmarkBytes remote branch never hands out corrupted bytes', () => {
  it('remote stdout containing NUL (a decoded binary plist) resolves to null, not a broken Uint8Array', async () => {
    // 远端 cat 一个二进制 .webloc：host 把它 utf8 解码成 string，NUL 存活在串里。
    const { host, run } = remoteHostReturning(`bplist00${NUL}corrupted`)
    const files = new WorkspaceFiles(() => host)
    await expect(files.readBookmarkBytes(workspace, 'links/Binary.webloc')).resolves.toBeNull()
    // 它确实走到了远端读一步（不是路径判定就短路了），否则这条与被测通路无关。
    expect(run).toHaveBeenCalled()
  })

  it('remote text bookmark (.url) returns bytes that decode back to the exact content', async () => {
    const text = '[InternetShortcut]\nURL=https://example.com/\n'
    const { host } = remoteHostReturning(text)
    const files = new WorkspaceFiles(() => host)
    const bytes = await files.readBookmarkBytes(workspace, 'links/Site.url')
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes!)).toBe(text)
  })
})

/**
 * `readBookmarkBytes` 的**本地**分支（常态）：本地经 `runLocalWorker` 拿真 `Buffer`，二进制**保真**——
 * 这正是它存在的全部理由（远端只能拿 utf8 往返、二进制必坏，见上面那组）。本地分支之前零直接覆盖。
 *
 * 承重的两条：
 *  - 二进制 `.webloc`（真 bplist00，含 NUL）**原样返回字节**——远端那侧会 null，本地必须逐字节相等，
 *    否则「本地/远端两条路径」就白分了。变异判据：把本地分支换成远端那套（含 `isBinaryContent` → null）
 *    会让这条翻红。
 *  - 目录 → null（`if (isDirectory) return null` 那道守卫）：删掉它会去 spawn worker 读一个目录，抛错
 *    被 catch 也照样 null，所以单看返回值分不出——故第二条断言 worker 从未被 spawn（`spawn` mock 计数）。
 *
 * 走真 filesystem + 真 worker 子进程（同 `workspace-files.test.ts` 的本地 fixture 形状）。
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      if (args[0] === process.execPath) localWorkerSpawns.count += 1
      return (actual.spawn as (...values: unknown[]) => ReturnType<typeof actual.spawn>)(...args)
    }
  }
})

const localWorkerSpawns = vi.hoisted(() => ({ count: 0 }))
const temporaryRoots: string[] = []

async function localFixture(label: string): Promise<{ root: string; workspace: WorkspaceRecord; host: ExecutionHost }> {
  const fixture = await mkdtemp(join(tmpdir(), `agentmux-${label}-`))
  temporaryRoots.push(fixture)
  const root = join(fixture, 'workspace')
  await mkdir(root)
  return {
    root,
    workspace: { id: `${label}-workspace`, name: label, hostId: 'local', path: root, kind: 'folder' },
    host: { id: 'local', kind: 'local', label: 'Local', run: vi.fn(), exposeLoopbackPort: async (p) => p, dispose: async () => {} }
  }
}

afterEach(async () => {
  localWorkerSpawns.count = 0
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const runLocalIf = it.runIf(process.platform === 'darwin' || process.platform === 'linux')

describe('readBookmarkBytes local branch preserves raw bytes (binary fidelity)', () => {
  runLocalIf('a binary .webloc (real bplist00 with NUL) comes back byte-for-byte, unlike remote', async () => {
    const { root, workspace: ws, host } = await localFixture('bookmark-local-binary')
    await mkdir(join(root, 'links'))
    // 一份真的二进制 plist：起头 bplist00，含 NUL。本地路径不经 utf8 往返，字节必须逐一保真。
    const raw = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0x00, 0xd1, 0x01, 0x02]), Buffer.from('URL')])
    expect(raw.includes(0)).toBe(true) // 坐实含 NUL —— 这正是远端会 null、本地不该 null 的那种字节
    await writeFile(join(root, 'links', 'Binary.webloc'), raw)
    const files = new WorkspaceFiles(() => host)

    const bytes = await files.readBookmarkBytes(ws, 'links/Binary.webloc')
    expect(bytes).not.toBeNull()
    expect(Buffer.from(bytes!).equals(raw)).toBe(true) // 逐字节相等（不是「非空就行」）
    expect(localWorkerSpawns.count).toBeGreaterThan(0) // 确实走了本地 worker 这条路
  })

  runLocalIf('a directory resolves to null WITHOUT spawning a worker (the isDirectory guard)', async () => {
    const { root, workspace: ws, host } = await localFixture('bookmark-local-dir')
    // 一个扩展名像书签的目录：`Weird.webloc/` 真存在但是目录。
    await mkdir(join(root, 'Weird.webloc'))
    const files = new WorkspaceFiles(() => host)

    await expect(files.readBookmarkBytes(ws, 'Weird.webloc')).resolves.toBeNull()
    // 关键判据：目录守卫在 spawn 之前短路。删掉 `if (isDirectory) return null` 会让它去 spawn worker
    // 读目录（worker 抛错、被 catch 成 null），返回值一样是 null 分辨不出——所以钉住「根本没 spawn」。
    expect(localWorkerSpawns.count).toBe(0)
  })

  runLocalIf('a missing local file resolves to null (the try/catch), not a throw', async () => {
    const { workspace: ws, host } = await localFixture('bookmark-local-missing')
    const files = new WorkspaceFiles(() => host)
    // 文件不存在：stat 抛 ENOENT，被 catch 成 null（调用方退回把它当文本打开，不崩）。
    await expect(files.readBookmarkBytes(ws, 'links/Gone.webloc')).resolves.toBeNull()
  })
})
