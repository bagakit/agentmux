import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
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
    input: vi.fn(async (_runId: string, operation: { expectedByte: number; data: string }) => ({
      run: run(operation.expectedByte + Buffer.byteLength(operation.data)),
      appliedByteRange: {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      }
    }))
  }
  const screenEvidence = { wait: vi.fn(async () => 1) }
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
  it('reports the observed Run and pending epoch when no readiness can be consumed', async () => {
    const stored = session()
    delete stored.terminalPromptReadiness
    const { coordinator, currentRun, kernel } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('must remain private')

    const refusal = await coordinator.submitInputPlan(
      stored,
      currentRun,
      'submission-not-ready',
      'must remain private',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_NOT_READY',
      detail: expect.stringContaining('runId=run-1 readinessId=none readinessSource=none')
    })
    expect(refusal?.detail).toContain('reason=epoch-missing')
    expect(refusal?.message).not.toContain('must remain private')
    expect(kernel.input).not.toHaveBeenCalled()
  })

  it('reports the owner submission when a readiness epoch was already consumed', async () => {
    const stored = session()
    stored.terminalPromptReadiness = {
      ...stored.terminalPromptReadiness!,
      consumedBySubmissionId: 'submission-owner'
    }
    stored.terminalPromptSubmission = {
      run: { runId: 'run-1' },
      submissionId: 'submission-owner',
      promptDigest: 'a'.repeat(43),
      readinessSource: 'initial-composer',
      readinessId: 'readiness-1',
      readinessOutputCursorBytes: 0,
      readyThroughByte: 12,
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

    const refusal = await coordinator.submitInputPlan(
      stored,
      currentRun,
      'submission-contender',
      'must remain private',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_READINESS_CONSUMED',
      detail: expect.stringContaining('runId=run-1 readinessId=readiness-1')
    })
    expect(refusal?.detail).toContain('consumedBySubmissionId=submission-owner')
    expect(refusal?.message).not.toContain('must remain private')
    expect(kernel.input).not.toHaveBeenCalled()
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
      submission.readyThroughByte = submission.readinessOutputCursorBytes - 1
    })
    expect(refusal, 'readyThroughByte < readinessOutputCursorBytes 必须被拒').toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  })

  it('输出游标落在「已确认空到」之前时被拒（outputCursorBytes 按构造不可能小于 readyThroughByte）', async () => {
    // 同理只改一个字段：把 outputCursorBytes 压到 readyThroughByte 之下。readyThroughByte 本身
    // 不动，所以 (A) 保持为假，红只能来自 (B)。
    const refusal = await refusalAfterCorrupting((submission) => {
      submission.outputCursorBytes = submission.readyThroughByte - 1
    })
    expect(refusal, 'outputCursorBytes < readyThroughByte 必须被拒').toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  })

  it('两条判据各自独立：上面两次损坏各只违反其中一条顺序（否则一条能掩盖另一条）', async () => {
    // 本仓反复记过「两个守卫互相掩盖：各自单独变异都存活」。这里把「每次损坏只违反一条」这个前提
    // 直接钉成断言，读的是生产代码写出来的真实取值，而不是我在注释里的声称。
    const { persisted } = await submittedFixture()
    const { readinessOutputCursorBytes: epochCursor, readyThroughByte, outputCursorBytes } = persisted

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

  it('观察之前 prompt 就是发不出去的——这正是插早退之后生产里的样子', async () => {
    // 反向那一侧，把「观察半边承重」这件事变成可证的：同一个起点上**不**调 observeReadiness，
    // submitInputPlan 必须以 observation-pending 被拒。上面那条与这条成对，才排除了
    // 「submitInputPlan 本来就不需要 readyThroughByte」这种解释。
    const stored = unobservedSession()
    const { coordinator, currentRun, kernel } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('hello')

    const refusal = await coordinator.submitInputPlan(
      stored as AgentMuxAgentSession,
      currentRun,
      'submission-before-observation',
      'hello',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)

    expect(refusal).toMatchObject({ code: 'AGENT_PROMPT_NOT_READY' })
    expect(refusal?.detail, 'epoch 在场、只差观察——理由必须是 observation-pending 而不是 epoch-missing')
      .toContain('reason=observation-pending')
    expect(kernel.input).not.toHaveBeenCalled()
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
})
