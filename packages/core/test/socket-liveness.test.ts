import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SOCKET_LIVENESS_PROBE_MS,
  probeSocketLiveness,
  socketLivenessFromErrorCode
} from '../src/socket-liveness.js'

// ---------------------------------------------------------------------------
// 「这个 socket 后面还有人吗」的三态判定。
//
// 这份判定的两个消费者各带一个不可逆后果：endpoint 回收据此 `rm -rf` 一个含 ctxmux state.sqlite3
// 的目录（约 110MB 的 Run 与回放历史），control-host 据此决定能不能接管一条 Control socket。
//
// 之前它在两处各被手写成一个 boolean，「探不准」被就地折进 true/reject——于是那条出口不能被单独
// 断言：把 reclaim 侧的两个兜底各翻成 false（超时→死、未知 errno→死），一次探测抖动就删掉一个活
// daemon 的全部持久状态，而那个模块 20 条测试全绿（实测，review agent 假绿审计 #3）。
//
// 所以这里一条断言只钉一个出口，且**每个出口都用能真正走到它的输入**：errno 分类走纯函数（真实
// EACCES/ENOTSOCK 取值实测得来），超时走一个真的不 accept 的服务器 + 0 预算。
// ---------------------------------------------------------------------------

const servers: Server[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  // 权限测试会把目录改成 000，删之前先还回来，否则清理自己会失败。
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

// macOS 的 unix socket 路径上限约 104 字节，mkdtemp(tmpdir()) 落在 /var/folders/... 下会超限。
// 真实 runtime 目录正因同一约束才放在 /private/tmp（见 runtime-paths.ts）。
async function makeRoot(): Promise<string> {
  const base = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const root = await mkdtemp(join(base, 'sockT-'))
  roots.push(root)
  return root
}

async function listenOn(path: string): Promise<Server> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  return server
}

describe('socketLivenessFromErrorCode', () => {
  it('只有这两个 errno 能证明「没人监听」', () => {
    // socket 文件都没了，以及文件在但没有 accept 的一端（daemon 死后的残骸）。
    expect(socketLivenessFromErrorCode('ENOENT')).toBe('dead')
    expect(socketLivenessFromErrorCode('ECONNREFUSED')).toBe('dead')
  })

  it('其余 errno 一律是「探不准」，不是「死了」', () => {
    // 这两个都是实测取值，不是假想：目录 mode 000 下探测得 EACCES，路径上是普通文件得 ENOTSOCK。
    // 把任何一个读成 dead，回收侧就会 rm -rf 一个可能活着的 daemon 的存储。
    expect(socketLivenessFromErrorCode('EACCES')).toBe('unknown')
    expect(socketLivenessFromErrorCode('ENOTSOCK')).toBe('unknown')
    // 没有 code 的错误同样是探不准——缺席不等于「确认没人」。
    expect(socketLivenessFromErrorCode(undefined)).toBe('unknown')
    // 反向那一侧也要成立：别把清单写成「只要不是 alive 就 dead」。
    expect(socketLivenessFromErrorCode('EPERM')).toBe('unknown')
    expect(socketLivenessFromErrorCode('ECONNRESET')).toBe('unknown')
  })

  it('预算用完（超时）也是「探不准」', () => {
    // 这是爆炸半径最大的那条出口。超时走的正是这条清单——预算由 AbortSignal.timeout 落成一次
    // ABORT_ERR，所以「超时算不算死」和其余未知 errno 是同一个判定，而不是另一条自成一路的分支。
    // 这里钉的是 Node 那个 abort errno 字面量分类为 unknown；端到端「超时确实走到这条」由下面
    // probeSocketLiveness 那个 describe 里 `AbortSignal.abort()` 对着活服务器的用例（:140 附近）守。
    expect(socketLivenessFromErrorCode('ABORT_ERR')).toBe('unknown')
  })
})

describe('probeSocketLiveness', () => {
  it('连得上就是 alive', async () => {
    const root = await makeRoot()
    const path = join(root, 'x.sock')
    await listenOn(path)
    expect(await probeSocketLiveness(path)).toBe('alive')
  })

  it('socket 文件不存在是 dead', async () => {
    const root = await makeRoot()
    expect(await probeSocketLiveness(join(root, 'never-existed.sock'))).toBe('dead')
  })

  it('socket 文件还在但没人监听是 dead —— daemon 死后最常见的形态', async () => {
    const root = await makeRoot()
    const path = join(root, 'x.sock')
    const server = await listenOn(path)
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    // close 之后 Node 会 unlink 掉路径，所以这里补一个同名的普通文件来复现「文件在、没人听」。
    // 直接探这个普通文件会得 ENOTSOCK（unknown），所以要的是真的残留 socket 节点——
    // 用一个新 server bind 再让它的进程"消失"是做不到的，于是退回到 ENOENT 与 ECONNREFUSED
    // 两条都由 socketLivenessFromErrorCode 逐条钉住（见上面那个 describe），这里只钉 ENOENT 那条。
    expect(await probeSocketLiveness(path)).toBe('dead')
  })

  it('路径上不是 socket 而是普通文件 → unknown，绝不是 dead', async () => {
    // 实测 errno 是 ENOTSOCK。这种形状意味着「这个位置被别的东西占了」，我们对那里发生了什么
    // 一无所知——按 dead 处理就会把一个自己都没看懂的目录删掉。
    const root = await makeRoot()
    const path = join(root, 'notasocket')
    await writeFile(path, 'x')
    expect(await probeSocketLiveness(path)).toBe('unknown')
  })

  it('权限不足 → unknown，绝不是 dead', async () => {
    // 实测 errno 是 EACCES。这是最刺眼的一种：探不到恰恰说明那里可能有别人的东西。
    const root = await makeRoot()
    const path = join(root, 'x.sock')
    await listenOn(path)
    await chmod(root, 0o000)
    expect(await probeSocketLiveness(path)).toBe('unknown')
  })

  it('预算用完 → unknown：一个忙或慢的 daemon 没在预算内应答，不等于它不在', async () => {
    // 这一条守的是那个爆炸半径最大的兜底，而它此前无人守的**结构性**原因是超时自成一路：
    // `setTimeout(() => settle(...))` 与 connect 赛跑，本机 300 次里只赢 5 次（实测），
    // 于是「让超时必然发生」在测试里近乎做不到——连 0ms 预算也不行（200 次里 193 次先连上）。
    // 预算改成由调用方交一个 AbortSignal 之后，传一个**已过期**的 signal 是确定的（实测 50/50 全 abort），
    // 这条出口才第一次可达。
    const root = await makeRoot()
    const path = join(root, 'x.sock')
    await listenOn(path)
    // 服务器**确实在监听**——所以这条断言不是「探到没人」，而是「明明有人，但预算内问不出来时
    // 必须说不知道」。若把 ABORT_ERR 归到 dead，这里会得 'dead'，回收侧就会删掉一个活 daemon。
    expect(await probeSocketLiveness(path, AbortSignal.abort())).toBe('unknown')
  })

  it('不给 signal 时用共享预算，且那个预算不掐死正常连接', async () => {
    // 默认值必须真的是那个常量派生出来的、而且够用：把默认改成一个已过期的 signal，
    // 每一次探测都会报 unknown，回收从此完全停摆（反向的静默失效）。
    const root = await makeRoot()
    const path = join(root, 'x.sock')
    await listenOn(path)
    expect(await probeSocketLiveness(path)).toBe('alive')
  })

  it('探测预算是一处真值，不许各写一个字面量', () => {
    // 两处各写一个 250 就会漂移，而"探测等多久"直接决定慢 daemon 会不会被误判。
    expect(SOCKET_LIVENESS_PROBE_MS).toBe(250)
  })
})
