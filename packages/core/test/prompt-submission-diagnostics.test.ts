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
