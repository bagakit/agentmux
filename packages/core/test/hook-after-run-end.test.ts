import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterExitEvent, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession,
  NativeHookEnvelope
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 一个 run 的进程终结是「这个 run 再不会有 hook 事件」的权威终点。acceptKernelEvent 里那条注释已经把
// 这个不变量写下来了，但没有任何代码执行它：acceptHookEvent 的唯一拒收判据是会话绑定（findByRun +
// agentSessionId/providerId 匹配），而自然退出并不解绑 registry——解绑只发生在 stop/retire 的
// releaseLifecycle。于是退出之后迟到的 hook 照单全收，把 semanticStatus='working' 既**发出去**又
// **落盘**，Agent 在列表里重新转圈且永不停：exited 之后不会再有 process-state 来拨正它，而 15 分钟
// 衰减只把 working 降到 running，不会降到 exited。
//
// 为什么修在 Core 而不是只在 renderer 补一层守卫：Core 是 run 生命周期的权威，而这里有**两个写入点**
// （发布事件、写存储）。只挡渲染端等于把谎话留在磁盘上——下次冷启动读回来的 semanticStatus 仍是
// working，且任何别的 API 消费者都会照样被骗。
//
// 三条终结路径都核对过：exited 与 interrupted（PTY 消失）都不解绑 registry，故两者都要挡；而「打断
// 当轮」根本不产生 process-state、run 仍是 running，此时 hook 是正常刷新，必须放行——修复不误伤。
// ---------------------------------------------------------------------------

function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-hook-after-end'.padEnd(43, 'A'),
    hookToken: 'token-hook-after-end'.padEnd(43, 'B'),
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' }
  }
}

function run(state: CtxmuxAdapterRun['state']): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: state.type === 'running' ? 999 : null,
    state,
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

/** 一条真实的 codex 中途 hook：normalizer 会把它投影成 semanticState='working'。 */
function workingHook(receiptId: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId: 'codex',
    eventName: 'PreToolUse',
    payload: { tool_name: 'shell', session_id: 'native-1' }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  connectionEpoch: number
  reconnectSleep: (ms: number) => Promise<void>
  handleConnectionLost(epoch: number): void
  republishLiveRunState(): Promise<void>
  open(epoch: number): Promise<void>
  acceptKernelEvent(event: CtxmuxAdapterExitEvent): void
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  stopRequestedRuns: Set<string>
  endedRuns: Map<string, unknown>
}

async function harness(): Promise<{
  client: AgentMuxClient
  internals: Internals
  store: AgentMuxMemoryAgentSessionStore
  statuses: () => Extract<AgentMuxClientEvent, { type: 'agent-status' }>[]
  storedStatus: () => Promise<AgentMuxStoredAgentSession['semanticStatus']>
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => run({ type: 'running' })
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return {
    client,
    internals,
    store,
    statuses: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'agent-status' }> => event.type === 'agent-status'
    ),
    storedStatus: async () => {
      const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
      return sessions.find((session) => session.agentSessionId === 'agent-1')?.semanticStatus
    }
  }
}

function exit(state: CtxmuxAdapterRun['state'], observedAt = 100): CtxmuxAdapterExitEvent {
  return { type: 'exit', runId: 'run-1', state, observedAt }
}

/**
 * 让 harness 的 kernel 在 `list()` 里报出这个 run 的某个状态，并把重连/冷启动跑得通所需的最小面补齐。
 *
 * 重连与冷启动共用同一个 kernel 面，所以这里一次装好两条路各自要用的东西：`connect` 给重连、
 * 三个 `on*` 订阅给 `open()`。`open()` 里那些恢复工作（handshake / hook ingress / 陈旧生命周期）与
 * 本判据无关，故 `status` 一并报同一个状态。
 */
function kernelReporting(internals: Internals, state: CtxmuxAdapterRun['state']): void {
  internals.kernel.list = async () => [run(state)]
  internals.kernel.status = async () => run(state)
  internals.kernel.connect = async () => {}
  internals.kernel.onEvent = () => () => {}
  internals.kernel.onError = () => () => {}
  internals.kernel.onConnectionLost = () => () => {}
}

describe('hook events arriving after the run already ended', () => {
  it('a live run still accepts hooks — the fix must not silence a healthy Agent', async () => {
    // 正向那一侧。没有它，「一律不收 hook」这种过宽的修法也会全绿，而那会让每个 Agent 都不再动。
    const { client, internals, statuses, storedStatus } = await harness()
    try {
      await internals.acceptHookEvent(workingHook('receipt-live'), AbortSignal.timeout(5_000))
      expect(statuses().at(-1)).toMatchObject({ state: 'working' })
      expect(await storedStatus()).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  it('does not resurrect an exited run to working — not in the event stream', async () => {
    const { client, internals, statuses } = await harness()
    try {
      internals.acceptKernelEvent(exit({ type: 'exited', code: 0, signal: null }))
      await internals.acceptHookEvent(workingHook('receipt-late'), AbortSignal.timeout(5_000))
      // 迟到的 hook 一条 agent-status 都不该发：exited 之后再没有拨正它的事件，一发就永久转圈。
      expect(statuses()).toEqual([])
    } finally {
      await client.dispose()
    }
  })

  it('does not resurrect an exited run to working — not on disk either', async () => {
    // 两个写入点各自钉一条：只挡发布会把 working 留在存储里，冷启动读回来照样撒谎。
    const { client, internals, storedStatus } = await harness()
    try {
      internals.acceptKernelEvent(exit({ type: 'exited', code: 0, signal: null }))
      await internals.acceptHookEvent(workingHook('receipt-late-disk'), AbortSignal.timeout(5_000))
      expect(await storedStatus()).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  it('does not resurrect an interrupted run either — the PTY is equally gone', async () => {
    // interrupted（PTY 消失）与 exited 一样不解绑 registry。只挡 exited 会留下同形的第二条路。
    const { client, internals, statuses, storedStatus } = await harness()
    try {
      internals.acceptKernelEvent(exit({ type: 'interrupted', reason: 'pty-vanished' }))
      await internals.acceptHookEvent(workingHook('receipt-after-interrupt'), AbortSignal.timeout(5_000))
      expect(statuses()).toEqual([])
      expect(await storedStatus()).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 上面守的是**在场**那条路：退出事件真的到了。但实时事件流不是唯一的到达路径，而是在场时的那一条。
  // 有两个窗口里它压根不存在：
  //   - 掉线期间（wire 断了，事件流没了）
  //   - App 没在跑的时候（冷启动，订阅还没装）
  // 在这两个窗口里退出的 run，台账里没有它，于是上面那道闸门放行它迟到的 hook——Agent 被点亮成 working
  // 且**永久转圈**（exited 之后再没有 process-state 拨正它，working 的时钟衰减只降到 running）。
  // 两个窗口都在未变异的源码上实测复现过：`endedRuns.size === 0`，hook 照收，working 既发出去又落盘。
  //
  // 这两条路唯一能知道真相的地方是 daemon 的 `list()`，所以补台账必须落在**两处** list() 各自之后。
  // -------------------------------------------------------------------------
  it('掉线期间退出的 run：重连后迟到的 hook 不许复活它', async () => {
    const { client, internals, statuses, storedStatus } = await harness()
    try {
      internals.reconnectSleep = async () => {}
      // 掉线期间它退出了——我们一条退出事件都没收到。重连后 list() 是唯一真相来源。
      kernelReporting(internals, { type: 'exited', code: 0, signal: null })
      internals.open = async () => {}
      internals.handleConnectionLost(internals.connectionEpoch)
      await vi.waitFor(() => expect(internals.endedRuns.has('run-1')).toBe(true))
      internals.connected = true

      await internals.acceptHookEvent(workingHook('receipt-after-offline-exit'), AbortSignal.timeout(5_000))
      expect(statuses()).toEqual([])
      expect(await storedStatus()).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  it('App 关着的时候退出的 run：冷启动后迟到的 hook 也不许复活它', async () => {
    // 与上一条是**两处**不同的 list()（`open()` 里那次 vs 重连后那次）。只补一处的话另一条路仍会
    // 静默保持旧行为——这正是本仓「两个写入点要收成一处投影」那族缺陷的形状，所以两条各钉一条。
    const { client, internals, statuses, storedStatus } = await harness()
    try {
      kernelReporting(internals, { type: 'exited', code: 0, signal: null })
      await internals.open(internals.connectionEpoch)

      await internals.acceptHookEvent(workingHook('receipt-after-cold-start'), AbortSignal.timeout(5_000))
      expect(statuses()).toEqual([])
      expect(await storedStatus()).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  it('补台账不许假装知道停止意图：裸 0 记成 unknown，不冒充「干净完成」', async () => {
    // daemon 的 list() 只报 code/signal，永远不知道那次退出是不是我们主动关的。所以走与实时路径
    // **同一个** classifyRunExit：冷启动时停止意图台账天然是空的，裸 0 必须如实归为 unknown。
    // 判据钉具体取值而不只是「有记录」：改成 `'user-stopped'` 或 `'crashed'` 之类好听的默认值时，
    // 只判在场的话照旧全绿，而那正是「猜一个好听的比承认不知道更糟」。
    const { client, internals } = await harness()
    try {
      kernelReporting(internals, { type: 'exited', code: 0, signal: null })
      await internals.open(internals.connectionEpoch)
      expect(internals.endedRuns.get('run-1')).toBe('unknown')
    } finally {
      await client.dispose()
    }
  })

  it('daemon 报的故障信号照旧分类成 crashed——补台账不是把原因一律抹平', async () => {
    // 反向那一侧。上一条只证「不许瞎猜」，若实现干脆把补进去的原因写死成 undefined（「一律不可分类」），
    // 上一条会红但**这一条**才说得清代价：daemon 明明报了 SIGKILL，用户 reload 后仍该看到「它自己崩了」。
    const { client, internals } = await harness()
    try {
      kernelReporting(internals, { type: 'exited', code: 0, signal: 'SIGKILL' })
      await internals.open(internals.connectionEpoch)
      expect(internals.endedRuns.get('run-1')).toBe('crashed')
    } finally {
      await client.dispose()
    }
  })

  it('补台账只补空缺，绝不覆盖实时那处算出的更好答案', async () => {
    // wire 断（handleConnectionLost）**不**清台账——它只置 connected=false、发事件、排重连，不调
    // disconnect()。所以重连后那次 list() 会把掉线**之前**就已实时收到过退出事件的 run 再报一遍。
    // 那些 run 的原因是带着停止意图算出来的（user-stopped），是更好的答案；覆盖它等于把 user-stopped
    // 降级成 unknown：用户明明自己按了停止，重连后界面改口说「不知道」。
    const { client, internals } = await harness()
    try {
      // 实时路径：先记下停止意图，再收到裸 0 的退出——合成出 user-stopped。
      internals.stopRequestedRuns.add('run-1')
      internals.acceptKernelEvent(exit({ type: 'exited', code: 0, signal: null }))
      expect(internals.endedRuns.get('run-1')).toBe('user-stopped')

      // 掉线这一步同步做完的部分里，台账必须还在——这正是上面那段前提，也是本场景可达的理由。
      internals.reconnectSleep = async () => {}
      internals.open = async () => {}
      kernelReporting(internals, { type: 'exited', code: 0, signal: null })
      internals.handleConnectionLost(internals.connectionEpoch)
      expect(internals.endedRuns.get('run-1'), '掉线不该清掉已知的终结事实').toBe('user-stopped')

      // 重连后走的就是这个方法（reconnectLoop 里那一处）。此时停止意图已被读走删掉，重算只能得到
      // unknown——所以它必须认出「已经知道了」而跳过，而不是拿一个更差的答案盖上去。
      await internals.republishLiveRunState()
      expect(internals.endedRuns.get('run-1')).toBe('user-stopped')
    } finally {
      await client.dispose()
    }
  })

  it('还在跑的 run 不会被补进台账——补的是终结，不是「list() 里出现过」', async () => {
    // 挡板那一侧：若把条件放宽成「凡 list() 报出来的都记一笔」，上面每条都仍会绿，而后果是每个健康
    // Agent 的 hook 从此一律被拒收——所有人都不再动。所以必须有人钉住 running 不入台账。
    //
    // 这里走 republishLiveRunState 而不是 open()：两条路共用同一个 backfillEndedRuns，而 open() 会对
    // 一个 running 的 run 真去做终端握手（attach），那与本判据无关且需要一整套 kernel 面。
    const { client, internals, statuses } = await harness()
    try {
      kernelReporting(internals, { type: 'running' })
      await internals.republishLiveRunState()
      expect(internals.endedRuns.has('run-1')).toBe(false)
      await internals.acceptHookEvent(workingHook('receipt-still-live'), AbortSignal.timeout(5_000))
      expect(statuses().at(-1)).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  // 上面四条守的是 hook 这条入口的行为。但喂 agent-status 的入口有**两条**：hook 与 ACP
  // （client-event-publisher 的 publishHook / publishAcp，各自还配一条落盘）。ACP 那条今天零 Provider
  // 走（没有 Provider 声明 acpStrategy: adapter），所以它上面的同形缺陷此刻观察不到——正因如此它也无法
  // 用行为断言来守，而「观察不到」正是它会被下一个人顺手删掉的原因。
  //
  // 所以这里守结构：两条入口都必须查同一份「已终结」台账。判据不是「文件里出现了 endedRuns 这个词」，
  // 也不是几个计数（那只约束被点名的方法，第三处写入开在别处就照旧全绿——实测过），而是「每一次对这份
  // 台账的访问，分别属于哪个成员、是哪种操作」的**全集**。搬走一处、删掉一处、或新开一处，集合都会变。
  it('both status entry points consult the same ended-run ledger', async () => {
    const source = await readFile(new URL('../src/client.ts', import.meta.url), 'utf8')

    // 把每一次对台账的访问标成「哪个成员:什么操作」。按**成员归属**而不是按每个方法各数一次：
    // 后者只约束被点名的那几个方法，第三处写入只要开在别的方法里就两边都满足——这一点是实测过的
    // （在 backfillEndedRuns 前面插一个 zzThirdWriter 再顺手把总数改成 3，11 条全绿）。所以判据是
    // 全集相等：任何新增、删除、或把访问搬到别的方法里，都会让这个集合与下面列的对不上。
    const MEMBER = /^ {2}(?:private |protected |public |static |readonly |async |\*)*([A-Za-z_$][\w$]*)\s*[(<]/
    const ACCESS = /this\.endedRuns\.(has|get|set)\(/g
    let owner = '<不在任何成员里>'
    const accesses: string[] = []
    for (const line of source.split('\n')) {
      const member = MEMBER.exec(line)
      if (member) owner = member[1]!
      for (const hit of line.matchAll(ACCESS)) accesses.push(`${owner}:${hit[1]}`)
    }

    // 自检：判据本身必须能失配。上面那个正则若哪天认不出访问（改名、换成解构、加了别的缩进层级），
    // 集合会变空，而「空集 == 空集」是恒绿的。所以先钉住它确实认出了东西。
    expect(accesses.length, '判据失效了：一次台账访问都没认出来').toBeGreaterThan(0)

    // 六次访问，各自承重：
    // - 闸门（has）：喂 agent-status 的**两条**入口——hook（acceptHookEvent）与 ACP（构造器里的
    //   acp.onEvent 回调）。ACP 那条今天零 Provider 走（没有 Provider 声明 acpStrategy: adapter），
    //   观察不到，所以只能这样守结构——而「观察不到」正是它会被下一个人顺手删掉的原因。
    // - 只补空缺（backfillEndedRuns:has）：判「这条已经知道了吗」，用来不覆盖实时那处算出的更好答案。
    // - 写入（set）：各对应「run 终结了」的一条到达路径——实时事件流与 daemon 快照。多一处就是第三个
    //   真相来源；少一处就有一整个窗口里的终结无人记录（掉线期间与冷启动前退出的 run 会因此被迟到的
    //   hook 复活成永久转圈，本文件上面那几条钉的正是这两个窗口）。
    // - 取值（get）：只有 projectRun 一处，run 投影的唯一入口。多一处就意味着又有人自己去 snapshot 侧
    //   算了一遍，而两条路对「它为什么没了」算出不同答案时，用户看到什么取决于他有没有 reload。
    //
    // `has` 与 `get` 必须分开（不能折成一次 `get() ?? fallback`）：台账里的 `undefined` 是「有记录但
    // 当时不可分类」（interrupted 那种终结），与「压根没这条记录」不是一回事。
    expect(accesses.sort()).toEqual([
      'acceptHookEvent:has',
      'acceptKernelEvent:set',
      'backfillEndedRuns:has',
      'backfillEndedRuns:set',
      'constructor:has',
      'projectRun:get'
    ])
  })
})
