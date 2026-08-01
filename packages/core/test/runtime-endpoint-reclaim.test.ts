import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  endpointDirectoryUsage,
  isOwnEndpointDirectoryName,
  orphanEndpointDirectoryNames,
  reclaimOrphanEndpointDirectories,
  socketIsDirectChildOfEndpoint
} from '../src/runtime-endpoint-reclaim.js'
import { defaultAgentMuxRuntimeDirectory, defaultCtxmuxSocketPath } from '../src/runtime-paths.js'

const UID = typeof process.getuid === 'function' ? process.getuid() : 0
const CURRENT = `amx-${UID}-${'a'.repeat(24)}`
const ORPHAN = `amx-${UID}-${'b'.repeat(24)}`
// 静默期闸门用 mtime 判定。测试里的目录都是刚建的，所以除非专门验证「太新不删」，
// 一律把"现在"推到很远的将来，让静默期已满，从而单独考察其余几道闸。
const FAR_FUTURE = Date.now() + 365 * 24 * 3600_000

const servers: Server[] = []
const roots: string[] = []
// chmod 000 过的目录：删之前必须先还回权限，否则清理自己会失败并把根目录留在盘上。
const lockedDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  for (const locked of lockedDirectories.splice(0)) await chmod(locked, 0o700).catch(() => {})
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// macOS 的 unix socket 路径上限约 104 字节，而 `mkdtemp(tmpdir())` 落在 /var/folders/... 下，
// 加上 endpoint 目录名与 ctxmux.sock 之后必然超限（EINVAL）。真实 runtime 目录正因为同一个约束
// 才放在 /private/tmp（见 runtime-paths.ts），测试根目录也必须短。
async function makeRoot(): Promise<string> {
  const base = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const root = await mkdtemp(join(base, 'amxT-'))
  roots.push(root)
  return root
}

async function listenOn(path: string): Promise<void> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
}

describe('isOwnEndpointDirectoryName', () => {
  it('accepts the shape our own deriver produces', () => {
    expect(isOwnEndpointDirectoryName(`amx-${UID}-${'0'.repeat(24)}`, UID)).toBe(true)
    expect(isOwnEndpointDirectoryName(`amx-${UID}-139e4b745e85ea4ced20f99e`, UID)).toBe(true)
  })

  // 回收动作是 rm -rf，而 /private/tmp 是公共地界。这一组是「别删别人东西」的直接断言。
  // amx-npm-cache-4127wQ 不是假想：本机 /private/tmp 下真实存在这样一个目录。
  it('rejects same-prefix directories that are not ours', () => {
    expect(isOwnEndpointDirectoryName('amx-npm-cache-4127wQ', UID)).toBe(false)
    expect(isOwnEndpointDirectoryName('amx-', UID)).toBe(false)
    expect(isOwnEndpointDirectoryName(`amx-${UID}`, UID)).toBe(false)
    expect(isOwnEndpointDirectoryName(`amx-${UID}-`, UID)).toBe(false)
    // id 段必须恰好 24 位十六进制：短一位、长一位、含非十六进制字符都不算。
    expect(isOwnEndpointDirectoryName(`amx-${UID}-${'a'.repeat(23)}`, UID)).toBe(false)
    expect(isOwnEndpointDirectoryName(`amx-${UID}-${'a'.repeat(25)}`, UID)).toBe(false)
    expect(isOwnEndpointDirectoryName(`amx-${UID}-${'g'.repeat(24)}`, UID)).toBe(false)
    // 前后缀不能有多余内容，否则 `amx-<uid>-<id>.bak` 之类也会被当成 endpoint。
    expect(isOwnEndpointDirectoryName(`x-amx-${UID}-${'a'.repeat(24)}`, UID)).toBe(false)
    expect(isOwnEndpointDirectoryName(`amx-${UID}-${'a'.repeat(24)}.bak`, UID)).toBe(false)
  })

  it("rejects another user's endpoint directory", () => {
    expect(isOwnEndpointDirectoryName(`amx-${UID + 1}-${'a'.repeat(24)}`, UID)).toBe(false)
  })
})

describe('orphanEndpointDirectoryNames', () => {
  it('keeps the current endpoint out of the orphan set', () => {
    expect(orphanEndpointDirectoryNames([CURRENT, ORPHAN], CURRENT, UID)).toEqual([ORPHAN])
  })

  it('ignores foreign and malformed names', () => {
    const names = [CURRENT, ORPHAN, 'amx-npm-cache-4127wQ', `amx-${UID + 1}-${'c'.repeat(24)}`, 'unrelated']
    expect(orphanEndpointDirectoryNames(names, CURRENT, UID)).toEqual([ORPHAN])
  })

  it('returns nothing when only the current endpoint exists', () => {
    expect(orphanEndpointDirectoryNames([CURRENT], CURRENT, UID)).toEqual([])
  })
})

describe('reclaimOrphanEndpointDirectories', () => {
  it('reclaims a dead orphan, spares the current endpoint and same-prefix strangers', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN, 'state'), { recursive: true })
    await writeFile(join(root, ORPHAN, 'state', 'state.sqlite3'), 'x'.repeat(1024))
    await mkdir(join(root, 'amx-npm-cache-4127wQ'), { recursive: true })

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([join(root, ORPHAN)])
    expect(outcome.failed).toEqual([])
    const survivors = (await readdir(root)).sort()
    expect(survivors).toEqual(['amx-npm-cache-4127wQ', CURRENT].sort())
  })

  it('spares an orphan whose daemon is still listening', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN), { recursive: true })
    await listenOn(join(root, ORPHAN, 'ctxmux.sock'))

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.skippedLive).toEqual([join(root, ORPHAN)])
    expect(outcome.reclaimed).toEqual([])
    expect(await readdir(root)).toContain(ORPHAN)
  })

  // 一个 daemon 死掉后会留下 socket 文件本身（ECONNREFUSED），这正是最常见的孤儿形态。
  it('reclaims an orphan whose socket file survives with no listener', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN), { recursive: true })
    const socketPath = join(root, ORPHAN, 'ctxmux.sock')
    await listenOn(socketPath)
    await new Promise<void>((resolve) => { servers.pop()!.close(() => resolve()) })

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([join(root, ORPHAN)])
    expect(await readdir(root)).not.toContain(ORPHAN)
  })

  // 静默期闸用的是**顶层目录**的 mtime，这个选择依赖一条容易被想当然推翻的文件系统事实：往 state/
  // 里写数据不更新顶层 mtime，但创建/删除 ctxmux.sock 会。两道闸因此互补——启动/重启这两个危险窗口里
  // socket 刚动过、mtime 必新鲜；长命 daemon 的 mtime 虽陈旧，却由存活闸挡着。
  //
  // 前半段断言那条文件系统事实本身（换了平台或文件系统若不成立，设计前提就塌了，得先知道）；后半段
  // 把顶层 mtime 倒推一小时、同时让 state/ 里的文件是刚写的，然后真跑一次回收：时钟若被"优化"成
  // state/ 的 mtime 或递归最新 mtime，这个孤儿会被判成新鲜而豁免，reclaimed 变空——这一条会红。
  it('clocks the quiet period on the top-level directory, not on writes inside state/', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    const endpoint = join(root, ORPHAN)
    await mkdir(join(endpoint, 'state'), { recursive: true })

    const beforeDeepWrite = (await stat(endpoint)).mtimeMs
    await writeFile(join(endpoint, 'state', 'state.sqlite3'), 'x'.repeat(1024))
    expect((await stat(endpoint)).mtimeMs).toBe(beforeDeepWrite)
    await listenOn(join(endpoint, 'ctxmux.sock'))
    expect((await stat(endpoint)).mtimeMs).toBeGreaterThan(beforeDeepWrite)
    await rm(join(endpoint, 'ctxmux.sock'), { force: true })

    // 顶层已安静一小时，而 state/ 里那个文件是几毫秒前刚写的。这正是长命 daemon 死后的样子。
    const anHourAgo = new Date(Date.now() - 3600_000)
    await utimes(endpoint, anHourAgo, anHourAgo)

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT))

    expect(outcome.reclaimed).toEqual([endpoint])
    expect(outcome.failed).toEqual([])
  })

  // 「回收失败不阻断启动，只留可诊断信息」这条，之前所有用例都只断言 `failed: []`——也就是说把
  // catch 块整个换成 `catch {}` 测试照样全绿，那条分支等于没被证明过。这里用只读父目录造一次真实的
  // rm 失败（readdir/lstat 仍可用，只有删除会 EACCES），逼着走进 catch：既要不抛，也要真的把原因
  // 记下来。接线在 connect() 上，抛出去会一路变成启动失败，所以这条分支必须有断言看着。
  it('records a real reclaim failure as a diagnosable reason instead of throwing', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN, 'state'), { recursive: true })
    // 父目录只读 → 删不掉里面的条目，但目录本身仍可枚举、可 lstat。
    await chmod(root, 0o500)
    try {
      const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

      expect(outcome.reclaimed).toEqual([])
      expect(outcome.failed.map((entry) => entry.path)).toEqual([join(root, ORPHAN)])
      expect(outcome.failed[0]?.reason).toMatch(/EACCES|permission denied/)
      // 目录还在——失败就是失败，不能是「删了一半还报成功」。
      expect(await readdir(root)).toContain(ORPHAN)
    } finally {
      // 不还原权限的话 afterEach 的 rm 也删不掉，会把临时目录漏在 /private/tmp。
      await chmod(root, 0o700)
    }
  })

  it('never throws when the runtime root does not exist', async () => {
    const outcome = await reclaimOrphanEndpointDirectories(
      join(tmpdir(), 'amx-reclaim-missing-root', CURRENT)
    )
    expect(outcome).toEqual({ reclaimed: [], skippedLive: [], failed: [] })
  })

  // 另一个不同版本的实例可能刚 mkdir 完、daemon 还没 listen，或正在重启、socket 刚被 unlink。
  // 这两个窗口里 socket 上都没有监听者，可目录并没有被放弃——删下去就是删活人的持久状态。
  it('spares a freshly created orphan even with no listener', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN), { recursive: true })

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT))

    expect(outcome.skippedLive).toEqual([join(root, ORPHAN)])
    expect(outcome.reclaimed).toEqual([])
    expect(await readdir(root)).toContain(ORPHAN)
  })

  // 名字判定只看字符串，而 /private/tmp 谁都能创建新条目——攻击者可以用 endpoint 的名字放一个
  // 指向别人真实目录的符号链接。lstat 那道闸必须把它挡在 rm 之前，且目标必须毫发无伤。
  it('refuses to reclaim a symlink wearing an endpoint name, and never follows it', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    const victim = join(root, 'victim')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'precious.txt'), 'do not delete me')
    await symlink(victim, join(root, ORPHAN))

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([])
    expect(outcome.skippedLive).toEqual([join(root, ORPHAN)])
    expect(await readdir(root)).toContain(ORPHAN)
    expect(await readFile(join(victim, 'precious.txt'), 'utf8')).toBe('do not delete me')
  })

  // -------------------------------------------------------------------------
  // 「探不准」这一侧。合同是**判不出活着就当活着，绝不删**，而它此前无人守：把存活闸的两个兜底
  // （未知 errno、超时）各翻成「死了」，本文件 20 条全绿（实测，review agent 假绿审计 #3）。
  //
  // 三态判定本身在 socket-liveness.test.ts 里逐条钉住；这里要证的是**另一半**——那个 `unknown`
  // 真的走到了「保留」这一侧，而不是在本模块被折进「删」。所以判据落在文件系统上：目录还在。
  // -------------------------------------------------------------------------
  it('spares an orphan whose socket cannot be probed at all', async () => {
    // 用一个探不动的 socket 复现「探不准」：把 endpoint 目录 chmod 000，探测得 EACCES（实测）。
    // 这不是假想场景——权限异常、SIP/沙箱限制、目录属主被改都会走到这里，而它与「daemon 死了」
    // 毫无关系。若这一侧被当成死，用户会因为一次权限抖动丢掉整个 state.sqlite3。
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN, 'state'), { recursive: true })
    await writeFile(join(root, ORPHAN, 'state', 'state.sqlite3'), 'precious run history')
    await listenOn(join(root, ORPHAN, 'ctxmux.sock'))
    await chmod(join(root, ORPHAN), 0o000)
    lockedDirectories.push(join(root, ORPHAN))

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([])
    expect(outcome.skippedLive).toEqual([join(root, ORPHAN)])
    // 判据落在盘上：存储必须还在。
    expect(await readdir(root)).toContain(ORPHAN)
    await chmod(join(root, ORPHAN), 0o700)
    expect(await readFile(join(root, ORPHAN, 'state', 'state.sqlite3'), 'utf8'))
      .toBe('precious run history')
  })

  it('spares an orphan whose probe path is not a socket at all', async () => {
    // 另一种探不准：`ctxmux.sock` 那个位置上是个普通文件（实测 errno 是 ENOTSOCK）。
    // 这意味着我们对那个目录里发生了什么根本没看懂——看不懂的东西不能删。
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN), { recursive: true })
    await writeFile(join(root, ORPHAN, 'ctxmux.sock'), 'not a socket')

    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([])
    expect(outcome.skippedLive).toEqual([join(root, ORPHAN)])
    expect(await readdir(root)).toContain(ORPHAN)
  })
})

describe('endpointDirectoryUsage', () => {
  it('reports own endpoints by size, flags the current one, and ignores strangers', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await writeFile(join(root, CURRENT, 'small.bin'), 'x'.repeat(10))
    await mkdir(join(root, ORPHAN, 'state'), { recursive: true })
    await writeFile(join(root, ORPHAN, 'state', 'state.sqlite3'), 'x'.repeat(4096))
    await mkdir(join(root, 'amx-npm-cache-4127wQ'), { recursive: true })
    await writeFile(join(root, 'amx-npm-cache-4127wQ', 'huge.bin'), 'x'.repeat(99999))

    const usage = await endpointDirectoryUsage(join(root, CURRENT))

    expect(usage.map((entry) => entry.path)).toEqual([join(root, ORPHAN), join(root, CURRENT)])
    expect(usage[0]).toMatchObject({ bytes: 4096, current: false })
    expect(usage[1]).toMatchObject({ bytes: 10, current: true })
  })

  // doctor 那条 endpointStorage 断言用的是 mock client，证不到「当前那个被标出来了」。
  // 这里文件系统由本用例掌控，把 current 标记单独钉死。
  it('flags exactly one entry as current', async () => {
    const root = await makeRoot()
    await mkdir(join(root, CURRENT), { recursive: true })
    await mkdir(join(root, ORPHAN), { recursive: true })

    const usage = await endpointDirectoryUsage(join(root, CURRENT))

    expect(usage.filter((entry) => entry.current).map((entry) => entry.path))
      .toEqual([join(root, CURRENT)])
  })
})

// 上面证明了判定与回收本身是对的，但「对」和「真的被调用」是两件事——本仓库反复踩过这个坑：
// 逻辑被证明了，却没有任何东西证明它接上了。回收若无人调用，孤儿目录照样一直堆积。
// 适配器的 connect() 无法在单测里真跑（要 spawn 真 daemon），所以这一截由源码扫描来证明。
describe('reclamation is wired into the adapter connect path', () => {
  it('calls reclaimOrphanEndpointDirectories inside connect()', async () => {
    const source = (await readFile(new URL('../src/ctxmux-run-adapter.ts', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

    expect(source).toContain("from './runtime-endpoint-reclaim.js'")

    const connectStart = source.indexOf('async connect(')
    expect(connectStart).toBeGreaterThan(0)
    // 截到 connect() 之后的下一个方法为止再断言，否则"在 connect 里"会退化成"在文件某处"。
    // 这个下界必须自己也被断言：indexOf 找不到时返回 -1，slice(0, -1) 会留下几乎整个文件，
    // 断言就从「在 connect 里」悄悄变成「在 connect 之后的任何地方」——评审正是揪的这一点。
    const connectEnd = source.indexOf('\n  disconnect(', connectStart)
    expect(connectEnd).toBeGreaterThan(connectStart)
    const connectBody = source.slice(connectStart, connectEnd)
    expect(connectBody).toContain('reclaimOrphanEndpointDirectories(')
  })
})

// ---------------------------------------------------------------------------
// 那两道闸互补的**前提**：socket 是 endpoint 目录的直接子项。
//
// 上面的时间闸靠「顶层 mtime 在启动/重启窗口里必然新鲜」成立，而那只在 socket 是直接子项时为真——
// 往 `state/state.sqlite3` 里写数据不动顶层 mtime，只有直接子项的创建与 unlink 会。此前这条前提
// 只写在 RECLAIM_MIN_QUIET_MS 的注释里，末尾还留了一句「改 runtime-paths 时必须回头看这里」——
// 一条常驻规则若只靠人记，就等于没有规则（同源判据见本仓「清理不留检测器等于没清」）。
//
// 而且 socket 名此前在两处各写一遍字面量（runtime-paths 的派生器 + reclaim 的存活闸），一旦漂移，
// 存活闸会去探一个不存在的路径→恒判「没人监听」，时间闸同时失去新鲜度：**两道闸一起静默失效**，
// 于是一个活着的 daemon 的持久状态会被删掉。现在位置只有一处真值，前提本身也被下面这条质询。
describe('两道闸互补的前提：socket 是 endpoint 目录的直接子项', () => {
  it('socketIsDirectChildOfEndpoint 为真，否则时间闸对重启窗口的保护已静默失效', () => {
    expect(socketIsDirectChildOfEndpoint()).toBe(true)
  })

  it('派生器现取而非各写一份：runtime 目录一改，socket 路径跟着改且仍是直接子项', () => {
    // 期望值不手抄 'ctxmux.sock'：从那一份派生器现取，两侧因此不可能漂。
    const override = process.platform === 'darwin' ? '/private/tmp/amxT-premise' : join(tmpdir(), 'amxT-premise')
    const previous = process.env.AGENTMUX_RUNTIME_DIRECTORY
    process.env.AGENTMUX_RUNTIME_DIRECTORY = override
    try {
      // 派生器换了根，socket 必须跟着换到新根之下——说明它是现取的，不是模块加载时冻住的常量。
      expect(defaultCtxmuxSocketPath().startsWith(override)).toBe(true)
      expect(relative(defaultAgentMuxRuntimeDirectory(), defaultCtxmuxSocketPath())).not.toContain('/')
      // 而前提在新根下同样成立——挪进子目录才会让它为假。
      expect(socketIsDirectChildOfEndpoint()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
      else process.env.AGENTMUX_RUNTIME_DIRECTORY = previous
    }
  })

  it('存活闸探的就是派生器给的那个位置——否则它会恒判「没人监听」', async () => {
    // 这条守存活闸与派生器的**同源**：在派生器说的位置起监听，回收必须放过这个目录。
    // 把闸里的路径改成别的名字（漂移），监听探不到 → 目录被删 → 这条红。
    const root = await makeRoot()
    const endpoint = join(root, ORPHAN)
    await mkdir(endpoint, { recursive: true, mode: 0o700 })
    const socketPath = join(endpoint, relative(defaultAgentMuxRuntimeDirectory(), defaultCtxmuxSocketPath()))
    await listenOn(socketPath)
    // 静默期推满，单独考察存活闸这一道。
    const outcome = await reclaimOrphanEndpointDirectories(join(root, CURRENT), FAR_FUTURE)

    expect(outcome.reclaimed).toEqual([])
    expect(outcome.skippedLive).toEqual([endpoint])
  })
})
