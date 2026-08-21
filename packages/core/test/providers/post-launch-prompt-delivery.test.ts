import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxError } from '../../src/errors.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent } from '../../src/types.js'
import type { CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'

// ---------------------------------------------------------------------------
// `post-launch-only` 的 Provider 起来之后**真的把那份 prompt 键进去了**——行为验收。
//
// 为什么必须是行为测试而不是源码扫描：这条轴此前只有 kimi.test.ts 里的 grep 接线断言
// （readFileSync + toContain），它**不执行代码**。实测四个变异全绿：
//   1. 调用点 `if (deferredPrompt)` → `if (deferredPrompt && false)`（launch 侧）
//   2. 同样改 resume 侧
//   3. 调用点取反 `if (!deferredPrompt)`（一次手误就够）
//   4. 最坏的一个：deliverPostLaunchPrompt 开头加 `if (text) return`，**整个方法变 no-op**，
//      从不 submit、从不 publish——而 205 条全绿。
// 变异 4 精确复刻了这条轴要消灭的失败形态：声明了能力、实现里悄悄不做、界面看起来一切正常。
// 标识符字面全都还在，所以 grep 数得到；早退发生在运行时，源码扫描看不见。
//
// 于是这里替身掉 promptSubmission 与事件出口，真的调用那个方法，断言「submit 发生过、
// 参数是那份 deferred 文本」；失败路径断言「发了 agent-error、且不抛」。
// ---------------------------------------------------------------------------

type SubmitCall = { session: AgentMuxAgentSession; run: CtxmuxAdapterRun; key: string; text: string }

type ClientInternals = {
  promptSubmission: {
    submitInputPlan(
      session: AgentMuxAgentSession,
      run: CtxmuxAdapterRun,
      key: string,
      text: string,
      plan: unknown
    ): Promise<void>
  }
  serializeAgentInput<T>(
    session: AgentMuxAgentSession,
    operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => Promise<T>
  ): Promise<T>
  deliverPostLaunchPrompt(
    provider: ReturnType<AgentProviderRegistry['get']>,
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    lifecycleOperationId: string,
    text: string
  ): Promise<boolean>
}

function session(): AgentMuxAgentSession {
  // 逐字段照 types.ts:427 的真实形状给，不用 `as` 掩盖差异。tsc 连着指出过三处 fixture 形状错：
  // 少了 kind/retiredRuns/outputCursorBytes，又多写了这个类型上根本没有的 label/capabilities/
  // displayState。vitest 只转译不查类型，三处都照旧全绿——形状错的 fixture 会让测试对着一个
  // 不存在的 Session 形状断言，所以这里的 tsc 干净本身就是验收的一部分。
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'kimi',
    executorId: 'kimi',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

const KIMI = new AgentProviderRegistry().get('kimi')

const RUN = { runId: 'run-1', pid: 4242 } as unknown as CtxmuxAdapterRun

function harness(submit: (call: SubmitCall) => Promise<void>): {
  internals: ClientInternals
  dispose: () => Promise<void>
  errors: () => Extract<AgentMuxClientEvent, { type: 'agent-error' }>[]
} {
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const internals = client as unknown as ClientInternals
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  internals.promptSubmission.submitInputPlan = async (s, run, key, text) =>
    await submit({ session: s, run, key, text })
  // serializeAgentInput 会去 store 里重取 session 并要求 run 在跑——那是真实生命周期才有的状态。
  // 这里只验「补送有没有真的发生」，所以把队列这一层替身成直通，把它自己的语义留给下面那条断言。
  internals.serializeAgentInput = async (s, operation) => await operation(s, RUN)
  return {
    internals,
    dispose: () => client.dispose(),
    errors: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'agent-error' }> => event.type === 'agent-error'
    )
  }
}

describe('起来之后补送那份 prompt——行为验收（不是源码扫描）', () => {
  it('真的把 deferred 文本提交了一次，键是这次生命周期操作', async () => {
    // 这条对「整个方法变 no-op」和「调用点被掐断」都变红：它数的是 submit 真的发生过。
    const calls: SubmitCall[] = []
    const { internals, dispose } = harness(async (call) => { calls.push(call) })
    try {
      await internals.deliverPostLaunchPrompt(
        KIMI,
        session(),
        RUN,
        'op-7',
        'review this repo'
      )
    } finally {
      await dispose()
    }

    expect(calls).toHaveLength(1)
    // 送进去的必须是那份文本本身，不是空串、不是被截断的东西。
    expect(calls[0]?.text).toBe('review this repo')
    // 键要能追回这次生命周期操作，否则时间轴上认不出这条是谁送的。
    expect(calls[0]?.key).toBe('launch-prompt:op-7')
  })

  it('空白文本一个字都不送——不占一次 turn', async () => {
    const calls: SubmitCall[] = []
    const { internals, dispose } = harness(async (call) => { calls.push(call) })
    try {
      await internals.deliverPostLaunchPrompt(KIMI, session(), RUN, 'op-8', '   ')
    } finally {
      await dispose()
    }
    expect(calls).toHaveLength(0)
  })

  it('送不到时发 agent-error 而不是抛——进程已经起来了，抛会让调用方回滚一次成功的启动', async () => {
    const { internals, dispose, errors } = harness(async () => {
      throw new AgentMuxError('kernel refused the input', 'AGENT_INPUT_REJECTED')
    })
    try {
      // 关键是**不抛**：这个方法的合同是绝不把已经起来的 Run 拖成一次失败的启动。
      await expect(
        internals.deliverPostLaunchPrompt(KIMI, session(), RUN, 'op-9', 'hello')
      ).resolves.toBe(false)

      const reported = errors()
      expect(reported).toHaveLength(1)
      // 原始错误码要带出来，别折成一个笼统的自己的码——那样用户和日志都追不回真因。
      expect(reported[0]?.code).toBe('AGENT_INPUT_REJECTED')
      // 确认失败不等于绝对没送到：先检查 Agent 回复再决定是否重投。
      expect(reported[0]?.message).toContain('was not confirmed')
      expect(reported[0]?.evidence).toBeDefined()
    } finally {
      await dispose()
    }
  })

  it('没带错误码的普通异常也要落一个自己的码，不能发出一条无码的错误', async () => {
    const { internals, dispose, errors } = harness(async () => { throw new Error('boom') })
    try {
      await internals.deliverPostLaunchPrompt(KIMI, session(), RUN, 'op-10', 'hello')
      expect(errors()[0]?.code).toBe('AGENT_LAUNCH_PROMPT_UNDELIVERED')
    } finally {
      await dispose()
    }
  })

  it('连告知都发不出去时，仍然不抛——否则健康的 Run 会被报成启动失败', async () => {
    // 这条守的是那个二层兜底。调用点在 create/resume 的 try 内、且在内层 rollback catch **之后**、
    // hookBinding 已注册之后；异常穿出去会让调用方收到「启动失败」，而 Run 其实活得很好。
    const { internals, dispose } = harness(async () => { throw new Error('boom') })
    try {
      ;(internals as unknown as { publisher: { publish(): void } }).publisher.publish = () => {
        throw new Error('publisher is down')
      }
      await expect(
        internals.deliverPostLaunchPrompt(KIMI, session(), RUN, 'op-11', 'hello')
      ).resolves.toBe(false)
    } finally {
      await dispose()
    }
  })

  it('补送排进 input tail，不绕过序列化——与用户手动提交共用同一条队列', async () => {
    // 每一个其它 submitInputPlan 调用者都在 serializeAgentInput 内；此前只有补送这一处例外。
    // 那个窗口是真的：session 在补送之前已经 publish 过 agent-session，渲染端此刻 composer 就绪，
    // 用户能在这次 await 返回前自己提交一条。两条并发时 single-phase 会读到同一个 expectedByte，
    // 字节栅栏挡住错位，于是不是损坏，而是顺序无保证 + 落后那条拿 receipt-mismatch。
    //
    // 所以这里断言的是**真的经过了那一层**：把 serializeAgentInput 替身成记录器，
    // 去掉生产代码里那次包裹，这条就变红。
    let wrapped = 0
    const calls: SubmitCall[] = []
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const internals = client as unknown as ClientInternals
    internals.promptSubmission.submitInputPlan = async (s, run, key, text) => {
      calls.push({ session: s, run, key, text })
    }
    internals.serializeAgentInput = async (s, operation) => {
      wrapped += 1
      return await operation(s, RUN)
    }
    try {
      await internals.deliverPostLaunchPrompt(KIMI, session(), RUN, 'op-12', 'queued')
    } finally {
      await client.dispose()
    }

    expect(wrapped).toBe(1)
    expect(calls).toHaveLength(1)
  })
})
