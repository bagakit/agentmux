import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterObservationEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'

/**
 * #660：`resizeAgent` 作废屏幕证据之后必须把**在途的 readiness 观察**重新挂上。
 *
 * 缺陷机制（与 #628 同族，但触发点是 resize 而不是掉线）：
 * 1. `screenEvidence.discard()` 会 `dispose()` 那具长命证据；`dispose()` 同步 `notify()`，挂着的
 *    `wait()` 的 `inspect()` 看到 `disposed` 走 `abort()`，于是那次观察以
 *    AGENT_PROMPT_READINESS_CANCELLED 结束。
 * 2. `observeReadiness` 的 `.catch` 对这个码是**静默早退**（`if (… === 'AGENT_PROMPT_READINESS_CANCELLED')
 *    return`）：不发 agent-error、不重挂、连自己那条表项都不删。
 * 3. 没有别的推进者：`observeReadiness` 的其余调用点只有握手重跑（open/重连）与 Stop hook。
 *
 * 合起来：resize 落在 readiness 窗口里 ⇒ `readyThroughByte` 永远停在 pending ⇒ 此后每条 prompt 被
 * AGENT_PROMPT_NOT_READY 拒掉，且没有任何出路。而 desktop 侧恰恰在 Agent 面板布局时就 resize
 * （runtime-controller 的 resizeSessionAttachment → client.resizeAgent），所以这个窗口是常态。
 * #628 补的那道 timeout 救不了它：CANCELLED 走的是上面那条静默出口，不是超时出口。
 *
 * 两条判据分开写成两个 `it`，因为它们各自能被不同的变异杀掉，而写在一个 `it` 里前一条先抛会让后一条
 * 变成死代码：
 *   A（重挂了）—— 下一次观察必须重新 `observeOutput`。杀掉它的变异：整段重挂删掉（今天的形状）、
 *      换成只 `cancelAllReadiness()`、把重挂挪到 `discard()` **之前**（那时旧 entry 还在表里且
 *      `failed === false`，`ensure()` 会复用它，计数停在 1，随后 discard 又把它打死）。
 *   B（表项换了新的）—— 取消表里必须只有一条、且不是 resize 之前那条闭包。杀掉它的变异：绕开
 *      `observeReadiness` 直接调 `screenEvidence.wait(...)`——那样 A 照旧涨到 2，但 readiness 永远不会
 *      落盘，且旧闭包连着它的 AbortController 永久留着（每次 resize 泄一条）。
 *
 * 关于「重挂顺带收掉泄漏的表项」这件事：`observeReadiness` 第一行就是
 * `this.readinessCancels.get(id)?.()`，那条旧闭包自己会把表项删掉（身份相等才删）。所以修法不需要
 * 另外调 `cancelAllReadiness()`——它是**全 Session** 的，resize 一个 Agent 不该动别人的观察。
 */
type Internals = {
  kernel: Record<string, unknown>
  registry: {
    load(hostId: string): Promise<void>
    has(id: string): boolean
    get(id: string): AgentMuxStoredAgentSession
  }
  screenEvidence: AgentScreenEvidenceStore
  promptSubmission: {
    observeReadiness(
      session: AgentMuxAgentSession,
      readiness: NonNullable<AgentMuxAgentSession['terminalPromptReadiness']>
    ): void
  }
}

const RUN_ID = 'resize-run'
const AGENT_SESSION_ID = 'resize-agent'

// 未就绪的观察：只有边界，没有 readyThroughByte。这正是 resize 会打死的那个状态。
const PENDING_READINESS = {
  source: 'initial-composer' as const,
  id: 'resize-epoch-1',
  run: { runId: RUN_ID },
  outputCursorBytes: 0
}

// 已就绪：`initial-composer` 那一支要求 readyThroughByte **严格大于** outputCursorBytes
// （agent-session-store 的 terminalPromptReadiness 归一化），所以不能写 0。
const SETTLED_READINESS = { ...PENDING_READINESS, readyThroughByte: 7 }

function storedSession(
  readiness: NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']>
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/resize-agent',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-resize',
    hookToken: 'token-resize',
    outputCursorBytes: 0,
    terminalPromptReadiness: readiness,
    createdAt: 100,
    updatedAt: 100
  }
}

function runProjection(cols: number, rows: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [] as string[],
    workspacePath: '/tmp/resize-agent',
    pid: 321,
    state: { type: 'running' as const },
    cols,
    rows,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

/**
 * 真 client + 真 AgentScreenEvidenceStore + 真 registry + 真 AgentPromptSubmissionCoordinator；
 * 只把 kernel 的三个协作方法换成 fake（observeOutput 计次并给空重放、resize 原样回报、isConnected 为真）。
 * 屏幕证据的失效与重建逻辑是被测对象，绝不 stub。
 *
 * 空重放 ⇒ 屏幕上没有 composer 帧 ⇒ 任何 readiness 观察都停在 pending。「屏幕永不再变」在生产上就是
 * 这个形状。
 */
async function resizeClient(
  readiness: NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']>
): Promise<{
  client: AgentMuxClient
  state: Internals
  session: AgentMuxAgentSession
  observeCalls: () => number
  cancelEntry: () => (() => void) | undefined
  cancelCount: () => number
  swapRunDuringResize: (nextRunId: string) => void
  retireDuringResize: () => void
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession(readiness))
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let observeCalls = 0
  // 在 `kernel.resize` 的 await 里跑一次真相变更，模拟 resize 与别的生命周期操作撞车的交错。
  // 换 Run（resume）与退场（stop/删除）各是一种，注入点相同，所以共用这一个钩子。
  let duringResize: (() => Promise<void>) | null = null
  state.kernel.isConnected = () => true
  state.kernel.observeOutput = async () => {
    observeCalls += 1
    return {
      run: runProjection(80, 24),
      replay: [] as CtxmuxAdapterObservationEvent[],
      gap: null,
      close: async () => {}
    }
  }
  state.kernel.resize = async (_runId: string, cols: number, rows: number) => {
    const mutate = duringResize
    duringResize = null
    await mutate?.()
    return { run: runProjection(cols, rows), cols, rows }
  }
  ;(client as unknown as { connected: boolean }).connected = true

  // CAS 的 expected 一律取**存储里现在那一份**：`sameSession` 是 JSON 逐字比较，手工重造的字面量
  // 过不了归一化后的形状。缺席时响亮失败而不是 cast 掉——那意味着 fixture 的前提已经不成立。
  const currentlyStored = async (): Promise<AgentMuxStoredAgentSession> => {
    const [stored] = (await store.load()) as AgentMuxStoredAgentSession[]
    if (!stored) throw new Error('fixture 前提失效：存储里已经没有这个 Agent Session')
    return stored
  }

  const cancels = (state.promptSubmission as unknown as {
    readinessCancels: Map<string, () => void>
  }).readinessCancels
  return {
    client,
    state,
    session: state.registry.get(AGENT_SESSION_ID) as AgentMuxAgentSession,
    observeCalls: () => observeCalls,
    cancelEntry: () => cancels.get(AGENT_SESSION_ID),
    cancelCount: () => cancels.size,
    swapRunDuringResize: (nextRunId: string) => {
      duringResize = async () => {
        // readiness 必须跟着换到新 Run 上：`terminalPromptReadiness` 的归一化要求它的 run 与 Session
        // 当前 run 相等，否则整条写入被拒。
        const current = await currentlyStored()
        await store.compareAndSwap(current, {
          ...current,
          run: { runId: nextRunId },
          terminalPromptReadiness: {
            ...PENDING_READINESS,
            id: 'resize-epoch-2',
            run: { runId: nextRunId }
          }
        })
        await state.registry.load('local')
      }
    },
    retireDuringResize: () => {
      duringResize = async () => {
        await store.compareAndSwap(await currentlyStored(), null)
        await state.registry.load('local')
      }
    }
  }
}

/**
 * 把一次生产 readiness 观察真的挂上，并等到它**登记完**再返回。
 *
 * 为什么一个 `vi.waitFor(observeCalls === 1)` 就够：`build()` 在 `await kernel.observeOutput(...)`
 * 之后**没有任何 await**（世代校验、造证据、喂重放、`this.evidence.set(...)` 全是同步的），所以
 * fake 一返回，登记就在同一条微任务链上完成；而 `vi.waitFor` 本身让出宏任务，回来时那条链已排空。
 */
async function armPendingObservation(
  fixture: Awaited<ReturnType<typeof resizeClient>>
): Promise<() => void> {
  fixture.state.promptSubmission.observeReadiness(
    fixture.session,
    fixture.session.terminalPromptReadiness!
  )
  await vi.waitFor(() => {
    expect(fixture.observeCalls()).toBe(1)
    expect(fixture.cancelCount()).toBe(1)
  })
  const armed = fixture.cancelEntry()
  expect(armed, '起点自检：resize 之前必须真有一条在途的 readiness 观察').toBeDefined()
  return armed!
}

describe('#660 resizeAgent 作废屏幕证据之后要重挂在途的 readiness 观察', () => {
  it('判据 A：下一次观察必须重新 observeOutput（重挂，而不是只把旧的杀掉）', async () => {
    const fixture = await resizeClient(PENDING_READINESS)
    await armPendingObservation(fixture)

    await fixture.client.resizeAgent(AGENT_SESSION_ID, { runId: RUN_ID }, 120, 40)

    // 重挂的那次观察要走 ensure() → build() → observeOutput，所以计数涨到 2。
    // 今天的形状（只 discard、不重挂）停在 1：readiness 永远 pending，此后每条 prompt 被
    // AGENT_PROMPT_NOT_READY 拒掉。
    await vi.waitFor(() => {
      expect(
        fixture.observeCalls(),
        'resize 之后没有人重挂 readiness 观察：readyThroughByte 永远停在 pending，prompt 全被拒'
      ).toBe(2)
    })
  })

  it('判据 B：取消表里只剩一条，且不是 resize 之前那条闭包', async () => {
    const fixture = await resizeClient(PENDING_READINESS)
    const armed = await armPendingObservation(fixture)

    await fixture.client.resizeAgent(AGENT_SESSION_ID, { runId: RUN_ID }, 120, 40)

    await vi.waitFor(() => {
      expect(
        fixture.cancelCount(),
        '取消表不是恰好一条：要么旧闭包泄漏在里面，要么这个 Session 的观察被清空了没人重挂'
      ).toBe(1)
      expect(
        fixture.cancelEntry(),
        '取消表里还是 resize 之前那条闭包：那次观察已经被 CANCELLED 打死，它连着的 AbortController 永久留着'
      ).not.toBe(armed)
    })
  })

  it('反向自证：readiness 已就绪时不重挂——重挂是 resize 打死在途观察的补救，不是无条件卫生', async () => {
    // 少了这一条，「无条件重挂」也能过上面两条。而无条件重挂在生产上是白付一次从 byte 0 的全量重放：
    // readiness 已落定时 `markReady` 会走 `readyThroughByte !== undefined` 那条早退，什么也不做。
    const fixture = await resizeClient(SETTLED_READINESS)
    expect(
      fixture.session.terminalPromptReadiness?.readyThroughByte,
      '起点自检：这一条的 readiness 必须是已就绪的，否则它与上面两条同形'
    ).toBe(7)

    await fixture.client.resizeAgent(AGENT_SESSION_ID, { runId: RUN_ID }, 120, 40)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      fixture.observeCalls(),
      'readiness 已就绪却仍然重挂：那次重放是白付的'
    ).toBe(0)
    expect(fixture.cancelCount()).toBe(0)
  })

  it('Run 在 resize 期间被换掉时不重挂——重挂的对象必须是发起这次 resize 的那个 Run', async () => {
    // 第三个条件（`sameRun`）的靶子。这不是理论缝隙：resize 是 await 的，而 resume 会在同一个
    // agentSessionId 上换 Run。删掉 `sameRun(...)` 那一项时，重挂会挂到**新** Run 的 readiness 上，
    // 而它自己的握手路径同时也在挂——于是同一个 epoch 上两条观察互相取消。
    //
    // 起点自检钉住前提真的成立（Run 真换了），否则这条会退化成与判据 A 同形而恒绿。
    const fixture = await resizeClient(PENDING_READINESS)
    await armPendingObservation(fixture)
    fixture.swapRunDuringResize('resize-run-2')

    await fixture.client.resizeAgent(AGENT_SESSION_ID, { runId: RUN_ID }, 120, 40)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      fixture.state.registry.get(AGENT_SESSION_ID).run.runId,
      '起点自检：这一条要求 Run 在 await 期间真的换掉了'
    ).toBe('resize-run-2')
    expect(
      fixture.observeCalls(),
      '给已经换掉的 Run 重挂了观察：那条 readiness 归新 Run 的握手路径管，两条会互相取消'
    ).toBe(1)
  })

  it('Session 在 resize 期间退场时安静跳过——一次已经成功的 resize 不该改口说 UNKNOWN_AGENT_SESSION', async () => {
    // `registry.has()` 那道门的靶子。也是可达分支：resize 是 await 的，stop/删除会在这期间让 Session
    // 退场。把 `has()` 换成直接 `requireAgentSession()`（或整块只留 `get()`）时，这里会抛
    // UNKNOWN_AGENT_SESSION——而 PTY 其实已经改好了尺寸，调用方却收到一个失败。
    const fixture = await resizeClient(PENDING_READINESS)
    await armPendingObservation(fixture)
    fixture.retireDuringResize()

    const applied = await fixture.client.resizeAgent(AGENT_SESSION_ID, { runId: RUN_ID }, 120, 40)

    expect(
      fixture.state.registry.has(AGENT_SESSION_ID),
      '起点自检：这一条要求 Session 在 await 期间真的退场了'
    ).toBe(false)
    expect(applied, 'resize 本身已经生效，返回值必须如实报告新几何').toEqual({
      runId: RUN_ID,
      cols: 120,
      rows: 40
    })
  })
})
