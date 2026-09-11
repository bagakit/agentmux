import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_STOP_TIMEOUT_CODE,
  SESSION_STOP_TIMEOUT_MS,
  sessionStopTimeoutError,
  withStopTimeout
} from '../src/shared/session-stop-timeout'

/**
 * 「经常出现 session 关不掉」的判据。
 *
 * 缺陷不是"停止失败了"，是"停止**永远不返回**"：整条链路（preload invoke → 主进程 handler →
 * ctxmux SDK 的 attachRecoverableStop → wire.receive）没有任何一处客户端超时。daemon 收下停止帧
 * 却没回执时，这个 await 永不结束；而关闭时占的那把重入租约在 `finally` 里释放，于是 `finally`
 * 也永不执行——之后每一次点关闭都被静默挡掉。用户看到的是「点了没反应，而且这个 Tab 现在连
 * 反应都没有了」。
 *
 * 原则 11 第 2 类：Agent 好好活着，是我们的握手没走通。所以超时要变成一个**如实的失败**，
 * 让既有收尾逻辑跑起来（保留投影、释放租约、说给用户听），而不是静默放行或伪装成功。
 */

describe('withStopTimeout：等收尾必须有上限', () => {
  it('正常返回时原样透传结果，不受超时影响', async () => {
    await expect(withStopTimeout(Promise.resolve('stopped'), 1_000)).resolves.toBe('stopped')
  })

  it('底层自己失败时原样透传那个错误，不冒充成超时', async () => {
    // Runtime 说"我失败了"和我们说"我没等到"是两件不同的事实，讲给用户的话也不同。
    const failure = new Error('run_not_found')
    await expect(withStopTimeout(Promise.reject(failure), 1_000)).rejects.toBe(failure)
  })

  it('永不结束的等待会在到点后被拒绝——这就是缺陷本身那一条', async () => {
    vi.useFakeTimers()
    try {
      // 一个永不 settle 的 Promise，正是 daemon 收下停止帧却没回执时的形状。
      const settled = withStopTimeout(new Promise<never>(() => {}), 60_000)
      const caught = settled.catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(60_000)
      const error = await caught
      expect(error, '永不结束的等待没有被兜住——关闭按钮会从此失效').toBeInstanceOf(Error)
      expect((error as Error & { code?: string }).code).toBe(SESSION_STOP_TIMEOUT_CODE)
    } finally {
      vi.useRealTimers()
    }
  })

  it('到点前不拒绝——慢一点的正常收尾不能被报成失败', async () => {
    // 一个正在写盘或排空 PTY 的 Agent 收尾到十几秒是正常的。掐早了会把成功的关闭报成失败，
    // 而那会让用户以为 Agent 出了事。
    vi.useFakeTimers()
    try {
      const settled = withStopTimeout(
        new Promise<string>((resolve) => { setTimeout(() => resolve('slow but fine'), 59_000) }),
        60_000
      )
      await vi.advanceTimersByTimeAsync(59_000)
      await expect(settled).resolves.toBe('slow but fine')
    } finally {
      vi.useRealTimers()
    }
  })

  it('是拒绝，不是 resolve——resolve 会把"没等到"记成"关成功了"', async () => {
    // 这一条钉住的是极性。若超时改成 resolve(undefined)，上层会把 Tab 移除而 Session 可能还活着，
    // 那是在拿用户的 Agent 撒谎；而拒绝会走既有失败路径：保留投影、报告、释放租约。
    vi.useFakeTimers()
    try {
      const outcome = vi.fn()
      const settled = withStopTimeout(new Promise<never>(() => {}), 5_000).then(
        () => outcome('resolved'),
        () => outcome('rejected')
      )
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
      expect(outcome).toHaveBeenCalledExactlyOnceWith('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('正常返回后不留悬挂定时器——否则进程被多吊住整整一分钟', async () => {
    vi.useFakeTimers()
    try {
      await withStopTimeout(Promise.resolve('done'), 60_000)
      expect(vi.getTimerCount(), '定时器没清掉——事件循环会被它吊住直到超时点').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('底层失败后同样不留悬挂定时器', async () => {
    vi.useFakeTimers()
    try {
      await withStopTimeout(Promise.reject(new Error('boom')), 60_000).catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('超时文案：说清哪一步没走通、Agent 什么状态、怎么恢复', () => {
  const message = sessionStopTimeoutError(SESSION_STOP_TIMEOUT_MS).message

  it('明确说 Agent 没受影响——这是第 2 类失败，不是"你的 Agent 死了"', () => {
    // 服务窗式提醒的第一要件：不能让用户以为自己的 Agent 出了事。
    expect(message).toContain('Agent is unaffected')
  })

  it('点名没走通的是我们这一步，不是 Agent', () => {
    expect(message).toContain('handshake did not complete')
  })

  it('给出从当前状态真能走通的恢复动作', () => {
    // 文案点名的动作必须从这个状态真的够得着。此刻 View 还在（失败路径保留投影），
    // 所以"再关一次"是真能走的——租约已经随这次拒绝释放了。
    expect(message).toContain('close it again')
  })

  it('带上等了多久，用户才知道这不是自己手滑', () => {
    expect(sessionStopTimeoutError(60_000).message).toContain('60s')
    expect(sessionStopTimeoutError(5_000).message).toContain('5s')
  })

  it('错误带 code，好让上层把"我们没等到"和"Runtime 说它失败了"分开讲', () => {
    expect(sessionStopTimeoutError(1_000).code).toBe(SESSION_STOP_TIMEOUT_CODE)
  })
})

describe('预算取值', () => {
  it('与 Core 给 stop 的长预算同档（60s）', () => {
    // 那张表把 stop 定为 long 的理由正是"要等进程真的收尾"，这里等的是同一件事。
    // 值就地定义而不从 Core import：preload 跑在隔离 bridge 上下文，跨包值导入会把 Core
    // 整个拉进这一层（记忆 renderer-value-import-of-core-barrel-breaks-packaging）。
    expect(SESSION_STOP_TIMEOUT_MS).toBe(60_000)
  })
})

describe('接线：上限接在那条唯一的共同出口上', () => {
  // 零调用者检查的那一半。上面每条行为判据全绿，也可能一个调用点都没有——helper 写得再对，
  // 没接上去就等于没做，而没有任何断言会红。
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

  it('自证：读到的 preload 非空且确有 sessions 这一面', () => {
    // 扫到空内容是第三种白绿：文件改名或搬走，下面每条断言都在空串上失去意义。
    expect(preload.length, 'preload 读到的是空内容——下面的断言没有对象').toBeGreaterThan(0)
    expect(preload, 'preload 里没有 sessions.stop——这道门守的东西已经不在这儿了').toContain(
      "ipcRenderer.invoke('sessions:stop'"
    )
  })

  it('stop 被 withStopTimeout 包住', () => {
    // renderer 有十二处 api.sessions.stop，逐个包会漂（下一处新增的不会带上），
    // 而且十二份超时就是十二个事实源。这里是它们唯一的共同出口。
    expect(
      /stop:\s*\([^)]*\)\s*=>\s*withStopTimeout\(\s*ipcRenderer\.invoke\('sessions:stop'/.test(preload),
      'sessions.stop 没有被 withStopTimeout 包住——一次没回执的握手会把关闭按钮永久锁死'
    ).toBe(true)
  })

  it('只有 stop 带这个上限，没有顺手套到别的 invoke 上', () => {
    // 过度防御的反面：给每条 IPC 都套一分钟上限，会把长连接、订阅和正常的慢操作一起掐掉。
    // 这个上限的理由是"等进程收尾"，别的操作没有这个理由。
    const wrapped = [...preload.matchAll(/withStopTimeout\(\s*ipcRenderer\.invoke\('([^']+)'/g)]
      .map((match) => match[1])
    expect(wrapped, 'withStopTimeout 套到了 sessions:stop 之外的通道上').toEqual(['sessions:stop'])
  })
})
