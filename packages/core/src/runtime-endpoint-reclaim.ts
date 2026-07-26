import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'

// 每次 artifact 升级都会派生一个新的 endpoint 目录（runtime-paths.ts 按 pinned manifest SHA 派生），
// 旧的那个连同它的 state.sqlite3 永久留在盘上——实测一个旧目录 110.2MB，且里面的 Run 全部已终止。
// 这里回收的粒度是【整个已废弃的目录】，绝不是 SQLite 里的行：那个库是 ctxmux 的私有存储，跨进程
// 写它会与活着的 daemon 抢写、随时踩坏 stop/attach/replay 语义。库【内部】怎么回收属于上游能力。

/** 我方派生的 endpoint 目录名形如 `amx-<uid>-<24 位十六进制>`。 */
const ENDPOINT_DIRECTORY_PATTERN = /^amx-(\d+)-([0-9a-f]{24})$/

/**
 * 这个目录名是不是我方 endpoint 派生器产出的、且属于给定 uid。
 *
 * 必须严格到这个程度，是因为回收动作要 `rm -rf`。`/private/tmp` 是公共地界，同前缀的无关目录真实
 * 存在——本机就躺着一个 `amx-npm-cache-4127wQ`。只按 `amx-` 前缀匹配就会删掉别人的东西。所以判定
 * 要求完整形状：uid 段必须等于本进程 uid（别人的目录一律不碰，也不会有权限），id 段必须是 24 位
 * 十六进制（正是 sha256 摘要切片的形状）。
 */
export function isOwnEndpointDirectoryName(name: string, uid: number): boolean {
  const match = ENDPOINT_DIRECTORY_PATTERN.exec(name)
  return match !== null && match[1] === String(uid)
}

/**
 * 在候选目录名里挑出「孤儿」：属于本 uid 的 endpoint 目录，且不是当前 artifact 派生的那一个。
 *
 * 纯函数、可直接断言——不碰文件系统，也不判定存活。存活是带副作用的第二道闸（见
 * {@link reclaimOrphanEndpointDirectories}）：判定「形状上是废弃版本」和判定「此刻真的没人在用」
 * 是两件事，混在一起就没法单独断言前者。
 *
 * 当前 endpoint 永远不在结果里，哪怕它没有 daemon 存活——它是本次运行马上要用的那个。
 */
export function orphanEndpointDirectoryNames(
  names: readonly string[],
  currentDirectoryName: string,
  uid: number
): string[] {
  return names.filter(
    (name) => name !== currentDirectoryName && isOwnEndpointDirectoryName(name, uid)
  )
}

/**
 * 一个孤儿目录至少要「安静」这么久，才允许回收。
 *
 * socket 上没有监听者，并不等于那个目录已被放弃：另一个**不同版本**的实例可能刚 mkdir 完、daemon
 * 还没 listen；也可能正在重启、socket 刚被 unlink 掉。这两个窗口里去删，会把一个活着的 daemon 的
 * 持久状态删掉（POSIX 下它靠已打开的 fd 继续写，直到下次重启才发现 Run 全没了）。
 * 存活探测无法覆盖这种竞态——它只能看「此刻」。
 *
 * **这里的 mtime 不是「daemon 有多久没干活」，别按那个含义去读或去改。**（下列均已实测）
 * 目录 mtime 只在其**直接子项**增删改名时变化：往 `state/state.sqlite3` 里写数据不更新顶层 mtime，
 * 所以一个跑了几小时的健康 daemon，顶层 mtime 冻结在很早以前。它是「最后一次直接子项变动」的时刻。
 *
 * 靠得住是因为两道闸各管一段，而不是因为这个时钟测得准：
 *
 *   - 活着的 daemon 由**存活闸**挡住，mtime 陈不陈旧都无所谓；
 *   - mtime 只在存活闸说「没人监听」时才需要发言，也就是那两个竞态窗口。而这两个窗口都伴随**直接
 *     子项**的变动：窗口一是目录刚被 mkdir 出来；窗口二是 `ctxmux.sock` 刚被 unlink（创建与 unlink
 *     都会更新顶层 mtime，实测 true/true）。所以恰在需要它的时候，mtime 一定是新鲜的。
 *
 * 两个已被实测否掉的「改进」，别再走回头路：
 *   - **换成 `state/` 的 mtime 或递归最新 mtime**：健康 daemon 一直在写 state/，目录会永远「新鲜」，
 *     时间闸退化成永不回收，孤儿再也清不掉。
 *   - **换成 `ctxmux.sock` 自己的 mtime**：socket 的 mtime 冻结在 bind 那一刻，之后再多连接也不动
 *     （实测：3 次客户端连接后 mtime 纹丝不动）；何况窗口一里 socket 文件还不存在，根本无从取值。
 *
 * 真正的脆弱点在于：这条正确性依赖「启动/重启会动到直接子项」这个**附带**性质。若哪天 socket 挪进
 * 子目录（`<dir>/run/ctxmux.sock`），或重启改成复用 inode 而不 unlink，这道闸会**静默**失去对重启
 * 窗口的保护。socket 路径是直接子项这一点由 runtime-paths.ts 决定，改那里时必须回头看这里。
 */
const RECLAIM_MIN_QUIET_MS = 10 * 60_000

/** 一个 endpoint 目录当前占了多少字节，以及它是不是当前这一个。 */
export interface EndpointDirectoryUsage {
  readonly path: string
  readonly bytes: number
  readonly current: boolean
}

/** 回收尝试的结果：回收掉了哪些、因为存活而豁免了哪些、以及失败了但没有阻断启动的那些。 */
export interface EndpointReclaimOutcome {
  readonly reclaimed: readonly string[]
  readonly skippedLive: readonly string[]
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
}

/**
 * 这个 socket 路径后面有没有活着的监听者。
 *
 * 判据与 control-host 的 `socketIsActive` 同源：连得上就是活的；`ENOENT`（socket 文件都没了）与
 * `ECONNREFUSED`（文件还在但没人监听，即 daemon 已死留下的残骸）都算不活。其余错误（权限等）一律
 * 当作「说不准」→ 按活的处理，宁可漏收也不误删。超时同理。
 */
async function socketHasListener(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    const settle = (alive: boolean): void => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(alive)
    }
    const timeout = setTimeout(() => settle(true), 250)
    socket.once('connect', () => settle(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED')
    })
  })
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    // 只跟目录递归，不跟 symlink——symlink 会把统计（以及任何据此做的判断）引到目录树之外。
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += await stat(child).then((s) => s.size).catch(() => 0)
  }
  return total
}

/**
 * 报出本 uid 名下每个 endpoint 目录的体积，当前那个标 `current: true`。
 *
 * 存在的理由是「让增长可被发现」：不然占用只有在磁盘告警时才浮出水面。按体积降序，最肥的排最前。
 */
export async function endpointDirectoryUsage(
  runtimeDirectory = defaultAgentMuxRuntimeDirectory()
): Promise<EndpointDirectoryUsage[]> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const root = dirname(runtimeDirectory)
  const currentName = basename(runtimeDirectory)
  const names = await readdir(root).catch(() => [] as string[])
  const own = names.filter((name) => isOwnEndpointDirectoryName(name, uid))
  const usage = await Promise.all(
    own.map(async (name) => ({
      path: join(root, name),
      bytes: await directoryBytes(join(root, name)),
      current: name === currentName
    }))
  )
  return usage.sort((left, right) => right.bytes - left.bytes)
}

/**
 * 回收孤儿 endpoint 目录：形状上是废弃版本、已经安静足够久、且此刻确实没有 daemon 在监听的，整个删掉。
 *
 * 四道闸，任何一道不过就不删：目录名必须是我方 uid 的 endpoint 形状（纯函数判定）；不能是当前
 * endpoint；必须是**真目录**而不是符号链接；必须安静超过 {@link RECLAIM_MIN_QUIET_MS} 且 socket
 * 上没有监听者。判不准一律算「有人在用」。
 *
 * **绝不抛异常。** 调用点在启动路径上，回收失败（权限、目录正被占用、竞态删除）不该拖垮启动——
 * 失败的条目落在 `failed` 里供诊断，启动照常继续。
 */
export async function reclaimOrphanEndpointDirectories(
  runtimeDirectory = defaultAgentMuxRuntimeDirectory(),
  now = Date.now()
): Promise<EndpointReclaimOutcome> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const root = dirname(runtimeDirectory)
  const names = await readdir(root).catch(() => [] as string[])
  const orphans = orphanEndpointDirectoryNames(names, basename(runtimeDirectory), uid)

  const reclaimed: string[] = []
  const skippedLive: string[] = []
  const failed: { path: string; reason: string }[] = []

  for (const name of orphans) {
    const path = join(root, name)
    try {
      // 名字判定只看字符串，符号链接同样能顶着 endpoint 的名字混进来（/private/tmp 谁都能创建新条目）。
      // 当前 Node 的 fs.rm 对「路径本身是 symlink」只删链接、不跟进去，所以即便删了也伤不到目标；
      // 但那是 rm 的实现细节，不该是这段代码的安全基础。这里显式用 lstat 挡掉，让「不跟符号链接」
      // 成为写明的判定，而不是依赖一个将来可能被 realpath 之类「优化」掉的隐含前提。
      const entry = await lstat(path)
      if (!entry.isDirectory()) {
        skippedLive.push(path)
        continue
      }
      // 安静得还不够久 → 可能是另一个版本正在启动或重启，别碰。
      if (now - entry.mtimeMs < RECLAIM_MIN_QUIET_MS) {
        skippedLive.push(path)
        continue
      }
      if (await socketHasListener(join(path, 'ctxmux.sock'))) {
        skippedLive.push(path)
        continue
      }
      await rm(path, { recursive: true, force: true })
      reclaimed.push(path)
    } catch (error) {
      failed.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { reclaimed, skippedLive, failed }
}
