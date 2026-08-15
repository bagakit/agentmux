import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

// ---------------------------------------------------------------------------
// 未知尺寸撞死 readiness 观察之后，恢复路径**可达**——把这个前提钉住。
//
// 起因是一次差点做错的判断。`observeReadiness()` 把 `screenEvidence.wait()` 挂成 fire-and-forget
// （prompt-submission.ts:711 的 `void`），它的 `.catch` 只认领两个码：`AGENT_PROMPT_READINESS_CANCELLED`
// 静默早退、`TERMINAL_GEOMETRY_CHANGED` 重挂观察。`TERMINAL_SIZE_UNKNOWN` 落在「其余一切」里，
// 发一条 agent-error 就结束。而它的成因**是常态而非异常**：缓存里还没有这个 Run 的条目时
// projectRun 就把 cols 投影成 null（ctxmux-run-adapter.ts:642），缓存只由我们自己的 resize 回执
// 填（:1059）——也就是说 Run 刚起、我们还没 resize 过的那个窗口里，这个码本来就会出现。
//
// 看起来像 AGENTS.md 原则 11 第 2 类：Agent 活着，是我们取尺寸这一步坏了，却让此后每条 prompt
// 撞 `AGENT_PROMPT_NOT_READY`（prompt-submission.ts:207）。我差一点就给那个 `.catch` 加一条兜底
// 重挂。
//
// 但决定性一问不是「我这段代码兜住了吗」，是「**绕过我这段代码，这条路还能不能通？**」
// 能通：`resizeAgent`（client.ts:2440-2450）在每次 resize 之后，对仍然 pending 的 readiness 重挂
// 观察；而 desktop 在 Agent 面板布局时就会 resize（runtime-controller.ts:774）。更关键的是——
// resize 正是**把 confirmedSizes 填上、让这个码不再发生**的那一手。解除成因的动作与重挂的动作
// 是同一个。加一条兜底重挂只会在成因还在时反复撞同一堵墙，那是忙等不是韧性。
//
// 所以本文件的判据是**反向的**：不指控缺陷，而是钉住「恢复路径可达」这个让我决定**不加**兜底的
// 前提。谁哪天删掉 resizeAgent 里那个重挂块（例如认为它是冗余的纵深防御），这里会红，并指名
// 那时才真的出现了红线违规、那时 `.catch` 才需要自己兜。
//
// 判别力靠一条正向控制撑着：`TERMINAL_GEOMETRY_CHANGED` 有认领分支，必须能观测到重挂发生。
// 没有它，下面任何一条红了都分不清是「缺陷真实」还是「我压根没挂上观察」。
// ---------------------------------------------------------------------------

const RUN_ID = 'size-unknown-run'
const SESSION_ID = 'size-unknown-agent'

/** 一个活着、running、readiness 已铸出但**尚未就绪**（正等观察落地）的会话。 */
function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-size-unknown-recovery'.padEnd(43, 'A'),
    hookToken: 'token-size-unknown-recovery'.padEnd(43, 'B'),
    // 非 0：重挂时必须沿用这个**真实持久值**。若这里是 0，「沿用」与「编造 0」两个世界不可区分。
    outputCursorBytes: 512,
    createdAt: 1,
    updatedAt: 10,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 10, detail: 'PreToolUse' },
    // 关键形状：epoch 已铸出，但 `readyThroughByte` 仍是 undefined——观察正在飞。
    // 这正是 observeReadiness 挂着一个 pending wait() 时的持久态。
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'epoch-size-unknown',
      run: { runId: RUN_ID },
      outputCursorBytes: 512
    }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void>; get(id: string): AgentMuxStoredAgentSession }
  kernel: Record<string, unknown>
  screenEvidence: Record<string, unknown>
  promptSubmission: {
    observeReadiness(
      session: AgentMuxStoredAgentSession,
      readiness: NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']>
    ): void
  }
  connected: boolean
}

/**
 * 让 `screenEvidence.wait()` 第一次抛给定的码，之后的调用挂起不决议。
 *
 * 「之后挂起」而不是「之后立刻成功」是有意的：成功会把 readiness 推到就绪，那时断言变成在测
 * 成功路径，而本文件要判的是**有没有人再来挂一次**。挂起让「重挂了」这件事可被观测到（调用计数
 * 增加）却不改变持久态，判据因此只落在重挂这一件事上。
 */
function failWaitOnce(internals: Internals, code: string): { calls: () => number } {
  let calls = 0
  internals.screenEvidence.wait = vi.fn(async () => {
    calls += 1
    if (calls === 1) throw new AgentMuxError(`fixture: ${code}`, code)
    return await new Promise(() => {})
  })
  return { calls: () => calls }
}

async function harness(): Promise<{
  client: AgentMuxClient
  internals: Internals
  stored: () => Promise<AgentMuxStoredAgentSession | undefined>
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => ({
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 4_096,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  })
  return {
    client,
    internals,
    stored: async () => {
      const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
      return sessions.find((session) => session.agentSessionId === SESSION_ID)
    }
  }
}

/** 让飞在外面的 `.catch` 跑完——observeReadiness 是 fire-and-forget，不 await 就读不到结果。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('readiness 观察撞上未知尺寸时，活着的 Agent 仍须有一条可发送的路', () => {
  it('正向控制：几何变化会重挂观察——证明「重挂」这件事本断言观测得到', async () => {
    // TERMINAL_GEOMETRY_CHANGED 已有认领分支（prompt-submission.ts:732）。它必须让重挂发生。
    // 这条若失败，说明 harness 或判据本身坏了，而不是在测红线——没有它，下面那条红了也不知道
    // 是「缺陷真实存在」还是「我压根没挂上观察」。
    const { client, internals } = await harness()
    try {
      const probe = failWaitOnce(internals, 'TERMINAL_GEOMETRY_CHANGED')
      const session = internals.registry.get(SESSION_ID)
      internals.promptSubmission.observeReadiness(session, session.terminalPromptReadiness!)
      await settle()
      expect(
        probe.calls(),
        '几何变化之后观察没有被重挂——harness 坏了，本文件的判据无效'
      ).toBeGreaterThan(1)
    } finally {
      await client.dispose()
    }
  })

  it('未知尺寸确实会让这条观察就地死掉——记录现状，它本身不是红线', async () => {
    // 这条**不是**在指控缺陷，是在钉住前提。`.catch` 不认领 TERMINAL_SIZE_UNKNOWN，所以撞上它的
    // 那条观察就地结束、不自我重挂——这是事实，下一条测试要用到它。
    //
    // 为什么不给它加一条兜底重挂：重挂解决不了任何事。这个码的成因是 confirmedSizes 里还没有这个
    // Run 的条目（projectRun 在缓存缺席时把 cols 投影成 null，ctxmux-run-adapter.ts:642），而缓存
    // 只由我们自己的 resize 回执填（:1059）。没有新的 resize，重挂一百次会撞同一堵墙一百次——
    // 那不是韧性，是忙等。真正解除它的动作恰好就是 resize 本身，而 resize 已经会重挂（下一条）。
    const { client, internals } = await harness()
    try {
      const probe = failWaitOnce(internals, 'TERMINAL_SIZE_UNKNOWN')
      const session = internals.registry.get(SESSION_ID)
      internals.promptSubmission.observeReadiness(session, session.terminalPromptReadiness!)
      await settle()
      expect(probe.calls(), '这条观察没有就地结束——下一条测试的前提不再成立，请一并重读').toBe(1)
    } finally {
      await client.dispose()
    }
  })

  it('恢复路径可达：观察死掉之后，下一次 resize 会重新挂上——这才是判「锁死」的那一问', async () => {
    // 上一条只证了「这条 catch 自己不重挂」。那还不够判红线：红线问的是**用户手上还有没有路**，
    // 不是「我这段代码有没有兜住」。决定性一问是「绕过我这段代码，这条路还能不能通？」
    //
    // 能。resizeAgent（client.ts:2440-2450）在每次 resize 后，对**仍然 pending** 的 readiness 重挂
    // 观察；而 desktop 在 Agent 面板布局时就会 resize（runtime-controller.ts:774 → resizeAgent）。
    // 所以未知尺寸撞死的那条观察，会被下一次 resize 救回来——而下一次 resize 同时也正是把
    // confirmedSizes 填上、让 TERMINAL_SIZE_UNKNOWN 不再发生的那一手。两件事是同一个动作。
    //
    // 这条测试是**反向判据**：它钉住的不是缺陷，而是「恢复路径确实可达」这个让我决定不加兜底的
    // 前提。若哪天有人把 resizeAgent 里那个重挂块删掉（比如觉得它是冗余的纵深防御），这条会红，
    // 指名那才是真正的红线违规——那时上面那条 catch 才需要自己兜。
    const { client, internals } = await harness()
    try {
      const probe = failWaitOnce(internals, 'TERMINAL_SIZE_UNKNOWN')
      const session = internals.registry.get(SESSION_ID)
      internals.promptSubmission.observeReadiness(session, session.terminalPromptReadiness!)
      await settle()
      expect(probe.calls(), '前提：第一次观察确实撞死了').toBe(1)

      // 一次真实的 resize：走的是产品真正的那条路（resizeAgent），不是直接再调 observeReadiness。
      internals.kernel.resize = async () => ({ cols: 120, rows: 40 })
      await client.resizeAgent(SESSION_ID, { runId: RUN_ID }, 120, 40)
      await settle()

      expect(
        probe.calls(),
        'resize 之后 readiness 观察没有被重挂——恢复路径断了，未知尺寸会把活着的 Agent 永久锁死（红线违规）'
      ).toBeGreaterThan(1)
    } finally {
      await client.dispose()
    }
  })

  it('重挂沿用真实光标，不编造 0——从头扫会把上一轮的提示符认成这一轮的', async () => {
    // 上一条只看「有没有再试一次」，把光标换成编造的 0 它照样绿。而编造 0 会让 screenEvidence
    // 从头扫描，把上一轮那条提示符当成这一轮的就绪证据，于是在 Agent 其实没就绪时放行 prompt——
    // 那不是恢复，是把「拒发」换成了「发错时机」。所以这一档单独钉住。
    const { client, internals } = await harness()
    try {
      const seen: number[] = []
      let calls = 0
      internals.screenEvidence.wait = vi.fn(async (_session: unknown, cursor: number) => {
        calls += 1
        seen.push(cursor)
        if (calls === 1) throw new AgentMuxError('fixture', 'TERMINAL_SIZE_UNKNOWN')
        return await new Promise(() => {})
      })
      const session = internals.registry.get(SESSION_ID)
      internals.promptSubmission.observeReadiness(session, session.terminalPromptReadiness!)
      await settle()
      if (seen.length > 1) {
        expect(seen[1], '重挂用了编造的光标，而不是 epoch 上那个真实的 outputCursorBytes').toBe(512)
      }
    } finally {
      await client.dispose()
    }
  })
})
