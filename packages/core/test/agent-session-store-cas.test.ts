import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

/**
 * store 层的 compare-and-swap 冲突检测。
 *
 * 为什么单独一族：这道门是 Agent Session 落盘的**唯一**并发保护。上层 registry 的 `put` / `update` /
 * `delete` 各自还有一道 `sameRun` 检查，但那道只看 run 引用变没变——一个只改了 `updatedAt`、
 * `outputCursorBytes` 或 `terminalHandshake` 的并发写，run 完全没动，registry 那道门放行，最后拦它的
 * 只有 store 里的 `sameSession`。
 *
 * 为什么必须有人钉：实测把 `sameSession` 改成 `return true`（即彻底关掉冲突检测），store 那四个测试
 * 文件 64 条全绿，全套 core 里唯一一条红是 `package-consumer` 抱怨「dist 比 src 旧」——那是我改源文件
 * 造成的时间戳产物，不是守 CAS 的。也就是说，在这条断言存在之前，整个冲突检测可以静默消失，用户看到
 * 的是两个并发写互相覆盖、后写的那个把前一个的进度悄悄丢掉。
 *
 * 两个 store 是**两个独立的调用点**（内存那个读自己的 Map，文件那个读磁盘文档再建 Map），所以每种形状
 * 都要在两边各跑一遍：只守一边时另一边的门可以单独被删掉。
 */

function storedSession(
  overrides: Partial<AgentMuxStoredAgentSession> = {}
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 12,
    createdAt: 100,
    updatedAt: 200,
    ...overrides
  } as AgentMuxStoredAgentSession
}

/** 两个 store 的构造方式不同，但 CAS 契约相同；用同一族断言逐个质询。 */
const stores: Array<{
  name: string
  open: () => Promise<{ store: AgentMuxAgentSessionStore; dispose: () => Promise<void> }>
}> = [
  {
    name: '内存 store',
    open: async () => ({
      store: new AgentMuxMemoryAgentSessionStore(),
      dispose: async () => {}
    })
  },
  {
    name: '文件 store',
    open: async () => {
      const root = await mkdtemp('/private/tmp/agentmux-store-cas-')
      return {
        store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')),
        dispose: async () => {
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }
]

const STALE = { code: 'STALE_AGENT_SESSION' }

for (const variant of stores) {
  describe(`${variant.name}：CAS 冲突检测`, () => {
    /** 跑一次用例，保证临时目录一定被清掉。 */
    async function withStore(
      body: (store: AgentMuxAgentSessionStore) => Promise<void>
    ): Promise<void> {
      const { store, dispose } = await variant.open()
      try {
        await body(store)
      } finally {
        await dispose()
      }
    }

    it('expected 的 updatedAt 落后于已落盘的那份时拒写', async () => {
      // 这是最常见的真实冲突形状，也是 registry 的 sameRun 完全看不见的那种：run 没变，只是别人先写了
      // 一次。若冲突检测失效，这次写会静默把中间那次的结果覆盖掉。
      await withStore(async (store) => {
        const first = storedSession()
        await store.compareAndSwap(null, first)
        // 别人先写了一次：磁盘/内存里现在是 updatedAt=300。
        await store.compareAndSwap(first, storedSession({ updatedAt: 300 }))
        // 我们手里还是那份旧的 first，拿它当 expected 就该被拒。
        await expect(
          store.compareAndSwap(first, storedSession({ updatedAt: 400 }))
        ).rejects.toMatchObject(STALE)
      })
    })

    it('expected 与已落盘那份只差一个字段时也拒写，不只比 run', async () => {
      // 单独一条，因为上一条改的是 updatedAt——一个「时间戳」字段，容易让人以为实现是按时间戳单调性
      // 判的。这里改 outputCursorBytes（读到哪个字节了），证明判据是**整份内容相等**，而不是某几个
      // 被挑出来的字段。若实现退化成只比 run/updatedAt，这一条红。
      await withStore(async (store) => {
        const first = storedSession()
        await store.compareAndSwap(null, first)
        await store.compareAndSwap(first, storedSession({ outputCursorBytes: 99 }))
        await expect(
          store.compareAndSwap(first, storedSession({ outputCursorBytes: 120 }))
        ).rejects.toMatchObject(STALE)
      })
    })

    it('以 null 为 expected 去创建一个已存在的 Session 时拒写', async () => {
      // 「我以为它不存在」这一侧。两个并发的创建路径（比如两次恢复同一个 Agent）都拿 null 当 expected，
      // 冲突检测失效时后一个会把前一个整份覆盖掉——包括 hookToken，于是前一个的 hook 投递永久失联。
      await withStore(async (store) => {
        await store.compareAndSwap(null, storedSession())
        await expect(
          store.compareAndSwap(null, storedSession({ hookToken: 'hook-token-2' }))
        ).rejects.toMatchObject(STALE)
      })
    })

    it('以某份内容为 expected 去删一个已经不在的 Session 时拒写', async () => {
      // 删除侧（`next === null`）。两次并发的 Stop 都会走到这里；第二次的 expected 是它自己读到的那份
      // 旧内容，而实际已经空了。冲突检测失效时第二次删除会「成功」，上层于是认为自己刚退役了一个还
      // 在跑的 Run。
      await withStore(async (store) => {
        const first = storedSession()
        await store.compareAndSwap(null, first)
        await store.compareAndSwap(first, null)
        await expect(store.compareAndSwap(first, null)).rejects.toMatchObject(STALE)
      })
    })

    it('expected 与已落盘那份逐字相同时放行——这道门只拦真冲突', async () => {
      // 对照侧，缺了它上面四条可以被一个「永远抛 STALE」的实现全部满足，而那样的 store 一个字节都写不
      // 进去。这条同时钉住「内容相等即可」——expected 不必是上一次写入返回的那个对象引用。
      await withStore(async (store) => {
        await store.compareAndSwap(null, storedSession())
        await store.compareAndSwap(storedSession(), storedSession({ updatedAt: 300 }))
        const loaded = await store.load()
        expect(loaded).toHaveLength(1)
        expect((loaded[0] as AgentMuxStoredAgentSession).updatedAt).toBe(300)
      })
    })
  })
}
