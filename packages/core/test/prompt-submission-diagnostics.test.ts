import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type {
  AgentMuxAgentSession,
  AgentMuxStoredAgentSession
} from '../src/types.js'

function session(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'readiness-1',
      run: { runId: 'run-1' },
      outputCursorBytes: 0,
      readyThroughByte: 12
    }
  }
}

function run(acceptedInputBytes = 0): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 42,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 12,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

async function coordinatorFixture(stored = session()) {
  const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
  await registry.put(stored)
  const currentRun = run()
  const kernel = {
    identity: () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' }),
    // 降级路径（confirmRenderOrDegrade）先向 daemon 要权威 Run 状态确认 Agent 还活着。缺了它，任何
    // 走到降级的变异都会炸成 `kernel.status is not a function`——那是**红在 fixture 缺口**，不是红在
    // 断言上，于是变异「被杀」的结论是假的。给它一条 running 的真回答，降级路径才真的跑起来。
    status: vi.fn(async () => run()),
    input: vi.fn(async (_runId: string, operation: { expectedByte: number; data: string }) => ({
      run: run(operation.expectedByte + Buffer.byteLength(operation.data)),
      appliedByteRange: {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      }
    }))
  }
  // 形参表**从生产类型派生**，不手抄：下面那条 #628 守卫要从调用记录里读第 5 个实参（options），
  // 而 `vi.fn(async () => 1)` 会把 calls 的元组类型定成 `[]`，于是 `[4]` 是越界下标——vitest 只转译
  // 所以照旧全绿，`tsc --noEmit` 退 2（记忆 vitest-green-hides-type-drift-across-files）。用
  // `Parameters<...>` 而不是照抄一份 options 形状，是为了让「生产的 options 加/删字段」这件事由 tsc
  // 而不是由我记得改测试来保证。
  const screenEvidence = {
    wait: vi.fn(async (..._args: Parameters<AgentScreenEvidenceStore['wait']>) => 1)
  }
  const publisher = new AgentMuxClientEventPublisher()
  const coordinator = new AgentPromptSubmissionCoordinator({
    kernel: kernel as never,
    providers: new AgentProviderRegistry(),
    registry,
    publisher,
    agentInputCursors: new Map(),
    screenEvidence: screenEvidence as never,
    requireAgentSession: (agentSessionId: string) => registry.get(agentSessionId),
    assertAgentRun: () => {},
    updateExactAgentSession: async (agentSessionId, expectedRun, update) => (
      await registry.update(agentSessionId, expectedRun, update)
    )
  })
  return { registry, coordinator, currentRun, kernel, screenEvidence, publisher }
}

describe('prompt readiness refusal diagnostics', () => {
  it.each(['missing', 'pending'] as const)('continues with %s readiness and verifies the actual payload', async (state) => {
    const stored = session()
    if (state === 'missing') delete stored.terminalPromptReadiness
    else delete stored.terminalPromptReadiness!.readyThroughByte
    const { coordinator, currentRun, kernel, registry, screenEvidence } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    await coordinator.submitInputPlan(stored, currentRun, 'submission-new', 'hello', plan)
    expect(kernel.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['hello', '\r'])
    expect(screenEvidence.wait).toHaveBeenCalledTimes(1)
    expect(registry.get('agent-1').terminalPromptSubmission?.readinessEvidence).toBeUndefined()
    expect(registry.get('agent-1').terminalPromptSubmission?.submit.acknowledged).toBe(true)
  })

  it('sends a steer after acknowledged delivery without waiting for Stop', async () => {
    const stored = session()
    stored.terminalPromptReadiness = {
      ...stored.terminalPromptReadiness!,
      consumedBySubmissionId: 'submission-owner'
    }
    stored.terminalPromptSubmission = {
      run: { runId: 'run-1' },
      submissionId: 'submission-owner',
      promptDigest: 'a'.repeat(43),
      readinessEvidence: { source: 'initial-composer', id: 'readiness-1', outputCursorBytes: 0, readyThroughByte: 12 },
      outputCursorBytes: 12,
      payload: {
        operationId: 'payload-owner',
        inputByteRange: { startByte: 0, endByte: 1 },
        acknowledged: true
      },
      submit: {
        operationId: 'submit-owner',
        inputByteRange: { startByte: 1, endByte: 2 },
        acknowledged: true
      }
    }
    const { coordinator, currentRun, kernel } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('must remain private')

    await coordinator.submitInputPlan(stored, currentRun, 'submission-contender', 'must remain private', plan)
    expect(kernel.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['must remain private', '\r'])

  })

  it('reports non-sensitive submission facts when another two-phase prompt is in flight', async () => {
    const original = session()
    const fixture = await coordinatorFixture(original)
    const { registry, currentRun, kernel, coordinator } = fixture
    let releaseRender!: (value: number) => void
    const renderBlocked = new Promise<number>((resolve) => { releaseRender = resolve })
    let payloadAccepted!: () => void
    const payloadObserved = new Promise<void>((resolve) => { payloadAccepted = resolve })
    fixture.screenEvidence.wait.mockImplementation(async () => await renderBlocked)
    kernel.input.mockImplementation(async (_runId: string, operation: { expectedByte: number; data: string }) => {
      payloadAccepted()
      return {
        run: run(operation.expectedByte + Buffer.byteLength(operation.data)),
        appliedByteRange: {
          startByte: operation.expectedByte,
          endByte: operation.expectedByte + Buffer.byteLength(operation.data)
        }
      }
    })
    const current = original as AgentMuxAgentSession
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('secret prompt must not leak')
    const first = coordinator.submitInputPlan(current, currentRun, 'submission-1', 'secret prompt must not leak', plan)
    await payloadObserved

    const refusal = await coordinator.submitInputPlan(current, currentRun, 'submission-2', 'another secret prompt', plan)
      .then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_SUBMISSION_BUSY',
      detail: expect.stringContaining('runId=run-1 activeSubmissionId=submission-1')
    })
    expect(refusal?.detail).not.toContain('secret')
    expect(refusal?.message).not.toContain('secret')
    releaseRender(1)
    await first
    expect(kernel.input).toHaveBeenCalledTimes(2)
  })
})

/**
 * `assertSubmission`（prompt-submission.ts:140）那 10 条对账里的**两条字节游标顺序**不变量。
 *
 * 它守的是「存储里那份 submission 记录与我这次要投递的东西是同一回事」，在四处被调用（:168 的
 * 认领复用、:319 的认领之后、:333 的每个阶段之前、:415），每次都读**存储里当时那份**——所以
 * 它是这条路径上唯一挡住「记录被改坏了还照着投」的门。
 *
 * 为什么单独钉这两条：`AGENT_PROMPT_OPERATION_CONFLICT` 这个码在整个 core 里只出现在生产代码
 * 一处，测试侧零引用。实测把
 *
 *     value.readyThroughByte < value.readinessOutputCursorBytes ||   // (A)
 *     value.outputCursorBytes < value.readyThroughByte ||            // (B)
 *
 * 各自换成 `false ||`（一次只改一条），两次都是 40 条全绿——`core` 的 `test` 脚本是全目录扫描，
 * 所以不是范围问题，是这两条真的无人守。其余 8 条（runId / submissionId / promptDigest /
 * 两个 operationId / 两个长度 / 相邻）本文件已有测试会顺带覆盖到一部分，这两条不会。
 *
 * 三个游标的语义与它们必须满足的顺序（见 :217-232 写入点）：
 *   - `readinessOutputCursorBytes`：就绪 epoch 建立**那一刻**的输出游标；
 *   - `readyThroughByte`：屏幕证据确认「composer 已经空到这个字节」——必须 ≥ 上一个，
 *     因为它是在那个时刻**之后**观察到的；
 *   - `outputCursorBytes`：`Math.max(run.latestOutputBytes, readyThroughByte)`——按构造 ≥ 上一个。
 * 两条不变量就是这条链上相邻的两段。它们被破坏意味着这份记录描述的屏幕状态自相矛盾（例如「确认
 * 空到第 5 字节」却又说「epoch 建立时已经到第 9 字节」），此时照着投递就是在一个**并非它以为的
 * 那个** composer 状态上敲键——键落到别的地方，而两阶段投递的 operationId 幂等性还会让这次错误
 * 投递被当成正常受理。
 *
 * 样本的造法：**不自己拼 submission 对象**（那样等于自证——拼出来的东西跟着实现一起漂）。而是先
 * 真跑一次提交把记录建立起来（认领 + 两阶段都投完），再直接改存储里那**一个**字段，然后重进
 * `submitInputPlan`。这样被测的就是生产代码写出来的记录经过一次真实的损坏之后，那道门认不认得。
 */
describe('assertSubmission 的字节游标顺序对账', () => {
  /**
   * 真跑一次提交，返回落盘之后的那份 submission 记录。
   *
   * 走完整条路径（`claimPromptReadiness` → payload → submit），所以拿到的是**生产代码自己**写出
   * 来的形状，而不是测试拼的。
   */
  async function submittedFixture() {
    const stored = session()
    const fixture = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    await fixture.coordinator.submitInputPlan(
      stored as AgentMuxAgentSession,
      fixture.currentRun,
      'submission-1',
      'hello',
      plan
    )
    const persisted = fixture.registry.get('agent-1').terminalPromptSubmission
    expect(persisted, '前置：一次成功的提交必须留下 submission 记录').toBeDefined()
    return { ...fixture, plan, stored, persisted: persisted! }
  }

  /**
   * 把存储里那份 submission 的一个字段改掉，然后重进 `submitInputPlan`（同一个 submissionId，
   * 于是走 :168 那条「复用已有认领」的分支，`assertSubmission` 在那里对账）。
   *
   * 返回抛出来的错误（没抛则是 null）——判据要的是「这道门认不认得」，不是别的错误码。
   */
  async function refusalAfterCorrupting(
    mutate: (submission: NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']>) => void
  ) {
    const { coordinator, registry, currentRun, plan, stored } = await submittedFixture()
    const corrupted = registry.get('agent-1')
    mutate(corrupted.terminalPromptSubmission!)
    return await coordinator.submitInputPlan(
      stored as AgentMuxAgentSession,
      currentRun,
      'submission-1',
      'hello',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)
  }

  it('前置自检：不损坏任何字段时，重进不会报 OPERATION_CONFLICT（否则下面两条的红与损坏无关）', async () => {
    // 这一条把「下面两条的红来自那次损坏」变成可证的。少了它，任何让重进失败的原因都会让下面两条
    // 变成假红，而假红读起来跟真守卫一模一样。
    //
    // 判据是「不是这个码」而不是「完全通过」：干净重进确实会被**另一道**门拒——两个阶段都已经
    // acknowledged，而 fixture 的 `currentRun.acceptedInputBytes` 是 0，于是 :336 那条
    // 「CtxMux 游标不能落在已落盘的阶段收据之前」先响。那是正当行为，不是本条要守的事；把它写成
    // 「必须完全通过」会让这条自检钉住一个假前提，然后为了让它绿而去改判据——方向正好反了。
    const refusal = await refusalAfterCorrupting(() => {})
    expect(refusal?.code, '未损坏的重进不该报 OPERATION_CONFLICT').not.toBe('AGENT_PROMPT_OPERATION_CONFLICT')
  })

  it('readyThroughByte 落在就绪 epoch 的游标之前时被拒（确认空到的字节不可能早于 epoch 建立时）', async () => {
    // 只改这一个字段。压到 epoch 游标之下让 (A) 为真；(B) 比的是 `outputCursorBytes >= readyThroughByte`，
    // 把 readyThroughByte 改小只会让 (B) 更容易成立，所以红只能来自 (A)。最后一条测试把这个
    // 「只违反一条」的前提直接钉成断言，而不是留在注释里。
    const refusal = await refusalAfterCorrupting((submission) => {
      submission.readinessEvidence!.readyThroughByte = submission.readinessEvidence!.outputCursorBytes - 1
    })
    expect(refusal, 'readyThroughByte < readinessOutputCursorBytes 必须被拒').toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  })

  it('输出游标落在「已确认空到」之前时被拒（outputCursorBytes 按构造不可能小于 readyThroughByte）', async () => {
    // 同理只改一个字段：把 outputCursorBytes 压到 readyThroughByte 之下。readyThroughByte 本身
    // 不动，所以 (A) 保持为假，红只能来自 (B)。
    const refusal = await refusalAfterCorrupting((submission) => {
      submission.outputCursorBytes = submission.readinessEvidence!.readyThroughByte - 1
    })
    expect(refusal, 'outputCursorBytes < readyThroughByte 必须被拒').toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  })

  it('两条判据各自独立：上面两次损坏各只违反其中一条顺序（否则一条能掩盖另一条）', async () => {
    // 本仓反复记过「两个守卫互相掩盖：各自单独变异都存活」。这里把「每次损坏只违反一条」这个前提
    // 直接钉成断言，读的是生产代码写出来的真实取值，而不是我在注释里的声称。
    const { persisted } = await submittedFixture()
    const { outputCursorBytes } = persisted
    const { outputCursorBytes: epochCursor, readyThroughByte } = persisted.readinessEvidence!

    // 干净记录上两条顺序都成立——这是「损坏前后的差别只有那一条」的另一半。
    expect(readyThroughByte).toBeGreaterThanOrEqual(epochCursor)
    expect(outputCursorBytes).toBeGreaterThanOrEqual(readyThroughByte)

    // 损坏 1（readyThroughByte := epochCursor - 1）：违反 (A)，不违反 (B)。
    expect(epochCursor - 1, '损坏 1 必须真的违反 (A)').toBeLessThan(epochCursor)
    expect(outputCursorBytes, '损坏 1 不该连带违反 (B)——否则红分不清来自哪条')
      .toBeGreaterThanOrEqual(epochCursor - 1)

    // 损坏 2（outputCursorBytes := readyThroughByte - 1）：违反 (B)，不违反 (A)。
    expect(readyThroughByte - 1, '损坏 2 必须真的违反 (B)').toBeLessThan(readyThroughByte)
    expect(readyThroughByte, '损坏 2 不该连带违反 (A)').toBeGreaterThanOrEqual(epochCursor)
  })
})


/**
 * `observeReadiness` 的**观察半边**：把「composer 空了」这个屏幕事实变成 `readyThroughByte`。
 *
 * 为什么必须单独钉：上面那一族全部从一个**已经带着 `readyThroughByte: 12`** 的 stored session 出发
 * （见本文件 `session()`），于是它们守的只是「拿到就绪之后怎么消费」。观察半边——那个
 * `screenEvidence.wait(...).then(persistReady)` 的尾巴——没有任何测试执行到。
 *
 * 实测：在 `observeReadiness` 第一行插一个 `return`，整个 core 945 条全绿。而生产后果是最重的一类：
 * `readyThroughByte` 永远是 `undefined`，`claimPromptReadiness` 于是恒抛 `AGENT_PROMPT_NOT_READY`
 * （reason=`observation-pending`），**用户发出的每一条 prompt 都被拒，且没有任何出路**——没有别的
 * 代码路径会补上这个字段。
 *
 * 所以这一族从「就绪还没被观察到」的真起点出发（`readyThroughByte` 缺席），驱一次真实的观察，
 * 断言两件事成对：落盘的就绪状态真的长出了 `readyThroughByte`，且紧随其后的 `submitInputPlan`
 * 真的能过闸。只断言前者不够——那只证明写了个字段，不证明它是消费侧要的那一个。
 */
describe('prompt readiness observation', () => {
  /** 观察还没发生的真起点：epoch 在场（source/id/run/cursor 都有），只差 readyThroughByte。 */
  function unobservedSession(): AgentMuxStoredAgentSession {
    const stored = session()
    stored.terminalPromptReadiness = {
      source: 'initial-composer',
      id: 'readiness-1',
      run: { runId: 'run-1' },
      outputCursorBytes: 0
    }
    return stored
  }

  it('把「composer 空了」变成 readyThroughByte 并落盘，此后 prompt 才发得出去', async () => {
    const stored = unobservedSession()
    const { coordinator, registry, currentRun, kernel, screenEvidence } = await coordinatorFixture(stored)

    // 前提自检：起点上就绪确实**没有**被观察过。若哪天 fixture 又预置了这个字段，本条会变成
    // 「验一个已经成立的事实」而恒绿——那正是它要消灭的形状，所以先响亮地钉住起点。
    expect(
      registry.get('agent-1').terminalPromptReadiness?.readyThroughByte,
      '起点必须是「观察尚未发生」，否则这条测试什么都没验'
    ).toBeUndefined()

    // 观察半边是 fire-and-forget（`void … .then(persistReady)`），没有返回值可等。
    // 屏幕证据返回 7：这个数字必须**逐字**出现在落盘的就绪里，否则就是某处自己编了一个。
    screenEvidence.wait.mockImplementation(async () => 7)
    coordinator.observeReadiness(stored as AgentMuxAgentSession, stored.terminalPromptReadiness!)
    await vi.waitFor(() => {
      expect(registry.get('agent-1').terminalPromptReadiness?.readyThroughByte).toBe(7)
    })

    // 同一个 epoch 必须原地长出字段，而不是被换成一个新 epoch——消费侧按 id 对账。
    expect(registry.get('agent-1').terminalPromptReadiness).toMatchObject({
      source: 'initial-composer',
      id: 'readiness-1',
      readyThroughByte: 7
    })

    // 成对的下半句：观察写进去的这个字段，正是消费侧要的那一个。缺了它 submitInputPlan 会抛
    // AGENT_PROMPT_NOT_READY（reason=observation-pending），也就是「每条 prompt 都被拒」。
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    await coordinator.submitInputPlan(
      registry.get('agent-1') as AgentMuxAgentSession,
      currentRun,
      'submission-after-observation',
      'hello',
      plan
    )
    expect(kernel.input, '观察落盘之后，两阶段投递必须真的发出去').toHaveBeenCalledTimes(2)
  })

  it('does not block a healthy Run when readiness observation is pending and render confirmation degrades', async () => {
    const stored = unobservedSession()
    const { coordinator, currentRun, kernel, registry, screenEvidence } = await coordinatorFixture(stored)
    screenEvidence.wait.mockRejectedValue(new AgentMuxError('History evicted', 'OUTPUT_GAP'))
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    await coordinator.submitInputPlan(stored, currentRun, 'without-observation', 'hello', plan)
    expect(kernel.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['hello', '\r'])
    expect(registry.get('agent-1').terminalPromptDelivery).toMatchObject({ state: 'unverified', reason: 'screen-evidence-gap' })
    expect(registry.get('agent-1').terminalPromptSubmission?.readinessEvidence).toBeUndefined()
  })

  it('观察失败要响亮地报出去，不能静默停在「永远等就绪」', async () => {
    // 观察半边的 `.catch` 也承重：屏幕证据超时/Run 提前退出时，若把错误吞掉，用户看到的是
    // 一个永远发不出 prompt 的 Agent 且没有任何解释。CANCELLED 是唯一该静默的那一种（见实现）。
    const stored = unobservedSession()
    const { coordinator, screenEvidence, publisher } = await coordinatorFixture(stored)
    const events: Array<{ type: string; code?: string }> = []
    publisher.onEvent((event) => { events.push(event as { type: string; code?: string }) })

    screenEvidence.wait.mockImplementation(async () => {
      throw new AgentMuxError('Agent Run exited before its composer became ready.', 'AGENT_RUN_EXITED')
    })
    coordinator.observeReadiness(stored as AgentMuxAgentSession, stored.terminalPromptReadiness!)

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'agent-error' && event.code === 'AGENT_RUN_EXITED')).toBe(true)
    })
  })

  // 上面那条钉的是「观察失败会响亮报出去」。但它有个前提：观察**得先失败**。#628 的真缺陷正是这个前提
  // 不成立——这条等待此前根本没有上界，于是「屏幕永不再变」时它既不成功也不失败，永远停在 pending，
  // 上面那条 catch 一辈子不执行。所以那条测试对本缺陷完全免疫，必须另立判据。
  //
  // 判据落在**预算在不在场**，而不是「超时了会怎样」：真等 120s 是不可跑的，而 fake timer 只能证明
  // 「若 arm 了定时器则会触发」，证不出 arm 这件事本身。`wait()` 里那个定时器是
  // `if (options.timeoutMs !== undefined)` 才 arm 的（agent-terminal-screen.ts），所以「实参里有没有
  // 这个键」正是那条定时器可达性的充要条件——这个键就是判据本身，不是它的代理。
  //
  // 常量是模块私有（prompt-submission.ts 只 export 那个 class），所以期望值不能 import。这里**刻意
  // 不写死 120_000**：写死等于把手抄的第二份钉在测试里，改产品预算就要改测试（记忆
  // expected-value-must-not-derive-from-mutation-target 的另一面——锚点要独立，但独立的锚点不该是
  // 同一个数字的复制）。改成钉住**关系**：composer 预算必须严格宽于渲染预算。这条关系是设计理由本身
  // （冷启动 ≫ 回显），而且它同时否掉一种看似无害的修法：把渲染那个常量拿过来复用，两个预算就相等，
  // 本条立刻红（记忆 two-budgets-guard-one-thing：短的那个只贡献假阴性）。
  it('等 composer 的那条 wait 必须带上界，且比渲染预算宽——没有它，屏幕不再变就永久 pending', async () => {
    const stored = unobservedSession()
    const { coordinator, screenEvidence } = await coordinatorFixture(stored)
    // 永不 settle 的观察：生产上「断线丢流 / TUI 卡在别的界面 / composer 匹配器认不出这版布局」都是
    // 这个形状。没有预算时，此后每条 prompt 被 AGENT_PROMPT_NOT_READY 拒掉且没有任何出路。
    screenEvidence.wait.mockImplementation(() => new Promise<number>(() => {}))

    coordinator.observeReadiness(stored as AgentMuxAgentSession, stored.terminalPromptReadiness!)

    // fixture 的 wait 忽略 options，所以只能从调用记录里取实参（也正因如此，行为侧看不见这个键）。
    // 不写 `as {...}`：那等于在这里再手抄一份 options 形状，把上面「让 tsc 管字段增删」那句作废。
    expect(screenEvidence.wait, 'observeReadiness 必须真的发起了屏幕观察').toHaveBeenCalledTimes(1)
    const readinessOptions = screenEvidence.wait.mock.calls[0]![4]
    expect(
      readinessOptions.timeoutMs,
      '就绪观察没有 timeoutMs：wait() 不会 arm 定时器，屏幕永不再变时这条等待永久 pending（#628）'
    ).toBeTypeOf('number')
    // 成对的下半句：措辞与预算必须同时在场。只给措辞时那句文案是死代码——那正是本缺陷发货时的样子。
    expect(readinessOptions.timeoutMessage, '有预算就必须有措辞，否则超时对用户是一句空话').toBeTruthy()

    // 关系判据：拿渲染预算作独立锚点（它走 submitInputPlan → waitForRender，与就绪观察是两条独立
    // 路径、两个独立常量）。两者相等即回归。渲染那条路要求 store 里就绪已落盘（claimPromptReadiness
    // 读的是**存储**里的 readiness，不是入参），所以另起一个 fixture——默认 session() 自带
    // readyThroughByte。
    const renderFixture = await coordinatorFixture()
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    await renderFixture.coordinator.submitInputPlan(
      renderFixture.registry.get('agent-1') as AgentMuxAgentSession,
      renderFixture.currentRun,
      'submission-render-budget',
      'hello',
      plan
    )
    const renderCall = renderFixture.screenEvidence.wait.mock.calls.at(-1)
    // 在场自证：没走到渲染确认这条路时，下面的比较会在 undefined 上恒真地过去。
    expect(renderCall, '没有取到渲染确认那次 wait——关系判据会在缺席的操作数上恒真').toBeDefined()
    const renderOptions = renderCall![4]
    expect(renderOptions.timeoutMs, '渲染确认那条等待本来就有预算，它是这里的独立锚点').toBeTypeOf('number')
    expect(
      readinessOptions.timeoutMs!,
      '等空 composer 横跨 Agent 冷启动，必须严格宽于「字已送进去、屏幕该回显了」那条；' +
      '两者相等通常意味着有人把渲染那个常量拿过来复用了'
    ).toBeGreaterThan(renderOptions.timeoutMs!)
  })
})

/**
 * 几何在渲染确认的**途中**变了，不许把这次已经受据的 payload 判死。
 *
 * 走到 `waitForRender` 时，payload 的 CtxMux 受据已经确认——那串字**已经躺在 composer 里**了。此刻
 * 屏幕证据因为 resize 失效（`TERMINAL_GEOMETRY_CHANGED`）说明的只是「我们这块表重置了」，不是
 * 「Agent 不行了」：新几何下重建一块屏幕再看一眼就是了，预算还剩多少就看多久。这正是原则 11 第 2 类
 * ——我们自己的证据链断了，不能因此收走用户还握着的能力。
 *
 * 反例（生产上真会发生）：desktop 在 Agent 面板布局时就 resize，所以「resize 落在渲染确认窗口里」是
 * 常态而非边角。若这里直接抛，submitInputPlan 会把 TERMINAL_GEOMETRY_CHANGED 交给
 * `confirmRenderOrDegrade`——那条路虽然也不阻断 `\r`，但会把一次**本可以完整确认**的提交记成
 * `unverified` 降级并广播服务窗：用户看到一条「这次没验成」的告示，而真相只是窗口被拖动了一下。
 *
 * 为什么要专门写这条：实测把那个 catch 改成无条件 `throw error`，**整个 core 确定性套件 110 文件
 * 1269 条测试全绿**——这个重试循环此前一条判据都没有。既有的 resize 测试守的是另一处
 * （`observeReadiness` 的 `.catch` 重挂，client-agent-resize-readiness.test.ts），两者位置不同、
 * 各自能被不同变异杀掉，互相不覆盖。
 */
describe('渲染确认途中几何变了：重建屏幕再看，而不是把这次提交判成未验证', () => {
  it('第一次 wait 抛 TERMINAL_GEOMETRY_CHANGED 后重试，不降级、不把错误抛给调用方', async () => {
    const fixture = await coordinatorFixture()
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')
    // 降级会广播一条带 terminalPromptDelivery 的 agent-session 事件。订阅它而不是查结束态，理由见下方断言。
    const degradeEvents: unknown[] = []
    fixture.publisher.onEvent((event) => {
      if (event.type === 'agent-session' && event.session.terminalPromptDelivery) degradeEvents.push(event)
    })
    let waits = 0
    fixture.screenEvidence.wait.mockImplementation(async () => {
      waits += 1
      // 只有**第一次**几何变化；第二次是重建后的那块屏幕，正常确认。写成「永远抛」证不出重试，
      // 只会证出超时——那是另一条出口。
      if (waits === 1) {
        throw new AgentMuxError(
          'Terminal screen geometry changed; rebuild from the owner-confirmed size.',
          'TERMINAL_GEOMETRY_CHANGED'
        )
      }
      return 1
    })

    await expect(fixture.coordinator.submitInputPlan(
      fixture.registry.get('agent-1') as AgentMuxAgentSession,
      fixture.currentRun,
      'submission-geometry-retry',
      'hello',
      plan
    )).resolves.toBeUndefined()

    expect(waits, '几何变化之后没有重建屏幕再看一眼——这次提交被白白记成未验证').toBe(2)
    // 降级必须**压根没发生过**，而不是「最后没留下痕迹」：`confirmRenderOrDegrade` 成功那一支会调
    // `clearDelivery` 把告示撤下，所以只看结束态的 `terminalPromptDelivery` 是**恒真**的——实测过：
    // 让 catch 里多写一次 publishDeliveryDegrade（重试照旧、waits 仍是 2），结束态断言 12/12 全绿。
    // 判据因此改成「有没有广播过那条降级 session 事件」，它在时间线上留痕，事后清除抹不掉。
    expect(
      degradeEvents,
      '几何变化被当成了证据链失败：一次本可完整确认的提交被记成 unverified 降级并广播了服务窗'
    ).toEqual([])
  })
})

it('rejects a stale automatic completion at the durable input claim, while leaving manual input available', async () => {
  const stored = session()
  stored.semanticStatus = { state: 'done', source: 'native-hook', observedAt: 1 }
  const fixture = await coordinatorFixture(stored)
  await fixture.registry.update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 2 }, updatedAt: 2 }))
  const plan = new AgentProviderRegistry().get('codex').planPromptInput('next')
  await expect(fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'auto', 'next', plan, '["run-1",1]'))
    .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(fixture.kernel.input).not.toHaveBeenCalled()
  await fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), fixture.currentRun, 'manual', 'next', plan)
  expect(fixture.kernel.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['next', '\r'])
})

it('checks cancellation at the durable claim, after any input queue wait', async () => {
  const stored = session(); const fixture = await coordinatorFixture(stored)
  const cancelled = new AbortController(); cancelled.abort()
  const plan = new AgentProviderRegistry().get('codex').planPromptInput('next')
  await expect(fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'auto', 'next', plan, undefined, cancelled.signal))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_CANCELLED' })
  expect(fixture.kernel.input).not.toHaveBeenCalled()
  expect(fixture.registry.get(stored.agentSessionId).terminalPromptSubmission).toBeUndefined()
})
it('reconciles an admitted automatic operation after its completion changes without admitting another prompt', async () => {
  const stored = session(); stored.semanticStatus = { state: 'done', source: 'native-hook', observedAt: 1 }
  const fixture = await coordinatorFixture(stored)
  const plan = new AgentProviderRegistry().get('codex').planPromptInput('next')
  await fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'auto', 'next', plan, '["run-1",1]')
  await fixture.registry.update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 2 }, updatedAt: Date.now() }))
  const calls = fixture.kernel.input.mock.calls.length
  expect(calls).toBe(2)
  await fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(5), 'auto', 'next', plan, '["run-1",1]')
  expect(fixture.kernel.input).toHaveBeenCalledTimes(calls)
  await expect(fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(5), 'other-auto', 'next', plan, '["run-1",1]'))
    .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(fixture.kernel.input).toHaveBeenCalledTimes(calls)
})

it('recovers a lost acknowledgement after submit was accepted and the Agent is working', async () => {
  const stored = session(); stored.semanticStatus = { state: 'done', source: 'native-hook', observedAt: 1 }
  const fixture = await coordinatorFixture(stored)
  const plan = new AgentProviderRegistry().get('codex').planPromptInput('next')
  const accepted = new Map<string, { startByte: number; endByte: number }>(); let cursor = 0
  fixture.kernel.input.mockImplementation(async (_runId, operation) => {
    const id = (operation as typeof operation & { operationId: string }).operationId
    let range = accepted.get(id)
    if (!range) { range = { startByte: operation.expectedByte, endByte: operation.expectedByte + Buffer.byteLength(operation.data) }; accepted.set(id, range); cursor = range.endByte }
    return { run: run(cursor), appliedByteRange: range }
  })
  const update = fixture.registry.update.bind(fixture.registry)
  const spy = vi.spyOn(fixture.registry, 'update').mockImplementationOnce(update)
    .mockRejectedValueOnce(new Error('receipt persistence interrupted'))
  await expect(fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'auto', 'next', plan, '["run-1",1]')).rejects.toThrow('receipt persistence interrupted')
  spy.mockRestore()
  expect(cursor).toBe(5)
  expect(fixture.registry.get(stored.agentSessionId).terminalPromptSubmission?.submit.acknowledged).toBe(false)
  await update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 2 }, updatedAt: Date.now() }))
  await fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(cursor), 'auto', 'next', plan, '["run-1",1]')
  expect(accepted.size).toBe(2)
  expect(cursor).toBe(5)
  expect(fixture.registry.get(stored.agentSessionId).terminalPromptSubmission?.submit.acknowledged).toBe(true)
})

it('does not continue a partially accepted old transaction into a pending interaction', async () => {
  const stored = session(); const fixture = await coordinatorFixture(stored)
  const plan = new AgentProviderRegistry().get('codex').planPromptInput('next')
  // Persist a real claim, then interrupt before either byte phase is accepted.
  fixture.kernel.input.mockRejectedValueOnce(new Error('connection interrupted'))
  await expect(fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'same-op', 'next', plan)).rejects.toThrow('connection interrupted')
  await fixture.registry.update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    pendingInteraction: { request: { id: 'permission', agentSessionId: 'agent-1', kind: 'permission', title: 'Allow?', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run-1' }, hookReceiptId: 'permission' } } } as never,
    updatedAt: Date.now() }))
  fixture.kernel.input.mockClear()
  await expect(fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(0), 'same-op', 'next', plan))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
  expect(fixture.kernel.input).not.toHaveBeenCalled()
})

it.each(['single-phase', 'two-phase'] as const)('consumes done atomically for manual %s input before a delayed native start', async (kind) => {
  const stored = session(); stored.semanticStatus = { state: 'done', source: 'native-hook', observedAt: 1 }
  const fixture = await coordinatorFixture(stored)
  const plan = kind === 'single-phase' ? { kind: 'single-phase' as const, data: 'next\r' }
    : new AgentProviderRegistry().get('codex').planPromptInput('next')
  await fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'manual-1', 'next', plan)
  const afterManual = fixture.registry.get(stored.agentSessionId)
  expect(afterManual.semanticStatus?.state).toBe('done')
  expect(afterManual.promptCompletionAdmission).toMatchObject({ completionId: '["run-1",1]', startByte: 0, endByte: 5 })
  const writes = fixture.kernel.input.mock.calls.length
  expect(writes).toBe(kind === 'single-phase' ? 1 : 2)
  await expect(fixture.coordinator.submitInputPlan(afterManual, run(5), 'auto-stale', 'next', plan, '["run-1",1]'))
    .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(fixture.kernel.input).toHaveBeenCalledTimes(writes)
  await fixture.coordinator.submitInputPlan(afterManual, run(5), 'manual-2', 'next', plan)
  expect(fixture.kernel.input).toHaveBeenCalledTimes(writes * 2)
  await fixture.registry.update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 2 }, updatedAt: Date.now() }))
  await fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(10), 'auto-new', 'next', plan, '["run-1",2]')
  expect(fixture.kernel.input).toHaveBeenCalledTimes(writes * 3)
})
it('reuses the original single-phase operation and byte range after an unknown outcome', async () => {
  const stored = session(); stored.semanticStatus = { state: 'done', source: 'native-hook', observedAt: 1 }
  const fixture = await coordinatorFixture(stored)
  const plan = { kind: 'single-phase' as const, data: 'next\r' }
  await fixture.coordinator.submitInputPlan(stored, fixture.currentRun, 'auto', 'next', plan, '["run-1",1]')
  const first = fixture.kernel.input.mock.calls[0]!
  await fixture.registry.update(stored.agentSessionId, stored.run, (current) => ({ ...current,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 2 }, updatedAt: Date.now() }))
  await fixture.coordinator.submitInputPlan(fixture.registry.get(stored.agentSessionId), run(5), 'auto', 'next', plan, '["run-1",1]')
  expect(fixture.kernel.input.mock.calls).toEqual([first, first])
  expect(fixture.registry.get(stored.agentSessionId).promptCompletionAdmission).toMatchObject({ startByte: 0, endByte: 5 })
})
