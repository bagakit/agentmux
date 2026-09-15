import { describe, expect, it, vi } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import {
  LIVE_ADMISSION_QUERY_BUDGET_MS,
  queryPromptAdmission,
  type PromptAdmission
} from '../src/prompt-admission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { AgentMuxAgentSession } from '../src/types.js'

// ---------------------------------------------------------------------------
// f-25q8fccdm / T-001：实时就绪判定模块。判据是「此刻 composer 空不空」，只从当下的屏幕字节回答，
// 绝不读持久记账。三支互斥、处理方向相反：ready 放行、busy 拒绝（拦住打断生成）、degraded 放行带告示。
//
// 关键防伪：ready / busy 这一支**不是**由测试拼一个布尔喂进去的——它由生产代码里的
// `composer === '' ? ready : busy` 对一块**真实** AgentTerminalScreen 解析出来的 composer 文本判定。
// screenEvidence.wait 的替身**真的调用**生产传进来的谓词（就像真实现那样：谓词为真才 resolve），
// 谓词通过副作用把 composerText 的结果写回 module——所以把 `=== ''` 变异成 `!== ''`（或调换 ready/busy）
// 会让 ready 与 busy 两条用例同时翻红。替身若忽略谓词直接 resolve，module 里的 composer 恒为 null，
// ready 用例在**正确**实现下就会失败——这道自证保证替身没有把判据架空。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function session(): AgentMuxAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    outputCursorBytes: 512,
    createdAt: 1,
    updatedAt: 1
  }
}

/** 一块真实屏幕，写进给定的字节序列（照抄 agent-terminal-screen.test.ts 里已验证的转义序列）。 */
async function screenShowing(...writes: string[]): Promise<AgentTerminalScreen> {
  const screen = new AgentTerminalScreen(80, 24)
  for (const data of writes) {
    const dataBytes = encoder.encode(data)
    await screen.write({
      startByte: screen.throughByte,
      endByte: screen.throughByte + dataBytes.byteLength,
      dataBytes
    })
  }
  return screen
}

/**
 * screenEvidence.wait 的替身：像真实现一样**真的跑谓词**。谓词为真才 resolve（返回 throughByte），
 * 为假就抛超时——正是真 wait 在预算内谓词一直不真时的行为。谓词的返回值来自对**真实屏幕**的解析。
 * `generation` 恒返回 0，代表本次观察前后**没有**发生 discard——候选 d 世代校验会通过、admission
 * 走它自己的 ready/busy 判定。
 */
function evidenceShowingScreen(screen: AgentTerminalScreen): {
  wait: ReturnType<typeof vi.fn>
  generation: ReturnType<typeof vi.fn>
} {
  return {
    wait: vi.fn(async (..._args: Parameters<AgentScreenEvidenceStore['wait']>) => {
      const predicate = _args[3]
      if (!predicate(screen)) {
        throw new AgentMuxError('Timed out reading the Agent composer state.', 'AGENT_PROMPT_RENDER_TIMEOUT')
      }
      return screen.throughByte
    }),
    generation: vi.fn((..._args: Parameters<AgentScreenEvidenceStore['generation']>) => 0)
  }
}

/** screenEvidence.wait 的替身：直接抛一个给定 code 的错误（读屏没看清 / 或真故障）。 */
function evidenceThrowing(code: string): {
  wait: ReturnType<typeof vi.fn>
  generation: ReturnType<typeof vi.fn>
} {
  return {
    wait: vi.fn(async (..._args: Parameters<AgentScreenEvidenceStore['wait']>) => {
      throw new AgentMuxError('screen wait failed', code)
    }),
    generation: vi.fn((..._args: Parameters<AgentScreenEvidenceStore['generation']>) => 0)
  }
}

/**
 * candidate d 世代守卫的替身：观察前 generation=0，观察后 generation=1（模拟 wait 期间上游触发过
 * discard 且 rebuild 了 evidence——wait 依旧用旧证据 resolve 出来了）。这条 fake 让我们在没有真
 * discard 的情况下测「世代变化必须让判定作废」这条不变量。
 */
function evidenceGenerationChangedMidWait(screen: AgentTerminalScreen): {
  wait: ReturnType<typeof vi.fn>
  generation: ReturnType<typeof vi.fn>
} {
  let calls = 0
  return {
    wait: vi.fn(async (..._args: Parameters<AgentScreenEvidenceStore['wait']>) => {
      // predicate 仍跑真屏幕；wait 内部按老 evidence resolve。
      _args[3](screen)
      return screen.throughByte
    }),
    generation: vi.fn((..._args: Parameters<AgentScreenEvidenceStore['generation']>) => calls++)
  }
}

async function admit(
  evidence: { wait: ReturnType<typeof vi.fn>; generation: ReturnType<typeof vi.fn> },
  awaitFreshFrame = false
): Promise<PromptAdmission> {
  return await queryPromptAdmission(evidence as never, session(), {
    activeComposer: '›',
    outputCursorBytes: 512,
    awaitFreshFrame
  })
}

describe('queryPromptAdmission：从当下屏幕判「现在能不能发」', () => {
  it('ready：composer 此刻是空的（对真实屏幕解析出 ""）', async () => {
    const screen = await screenShowing('[22;1H› [22;3H')
    try {
      // 前置自检：这块屏幕的 composer 真的是空串，不是恰好被别的原因判空。
      expect(screen.composerText('›'), '前置：该屏幕的 composer 必须解析成空串').toBe('')
      expect(await admit(evidenceShowingScreen(screen))).toEqual({ kind: 'ready' })
    } finally {
      screen.dispose()
    }
  })

  it('busy：composer 此刻非空——上一条已进 PTY、Agent 还在生成，不许发（拦住打断生成）', async () => {
    const screen = await screenShowing(
      '[22;1H› [22;3H',
      '[?2026h[22;3H/exit[22;8H[?2026l'
    )
    try {
      // 前置自检：composer 真的读到了、且非空——这正是「生成中」窗口的形状。
      expect(screen.composerText('›'), '前置：该屏幕的 composer 必须是非空文本').toBe('/exit')
      // 拒绝的理由必须是「非空」这个确定观察（kind: 'busy'），不能退化成 degraded 的超时。
      expect(await admit(evidenceShowingScreen(screen))).toEqual({ kind: 'busy' })
    } finally {
      screen.dispose()
    }
  })

  it.each([
    ['OUTPUT_GAP', 'screen-evidence-gap'],
    ['AGENT_PROMPT_RENDER_TIMEOUT', 'prompt-render-timeout'],
    ['AGENT_PROMPT_READINESS_CANCELLED', 'screen-evidence-replaced']
  ] as const)('degraded：读屏没看清（%s）→ 放行并带上服务窗原因 %s', async (code, reason) => {
    expect(await admit(evidenceThrowing(code))).toEqual({ kind: 'degraded', reason })
  })

  it('fail-closed：非白名单错误（Run 退出 / 数据损坏）照常抛，degraded 不吞它', async () => {
    // 这条与 degraded 成对：证明 degraded 分支是**按 code 精确放行**的三类，而不是「读屏一失败就放行」。
    // 少了它，把 catch 改成无条件 degraded 也全绿——那会把一个真退出的 Run 当成「就绪降级」放行。
    const rejection = await admit(evidenceThrowing('AGENT_PROMPT_RENDER_FAILED'))
      .then(() => null, (error: unknown) => error as AgentMuxError)
    expect(rejection, 'Run 退出这类真故障必须原样抛出，不能被降级吞掉').toBeInstanceOf(AgentMuxError)
    expect(rejection?.code).toBe('AGENT_PROMPT_RENDER_FAILED')
  })

  it('三支互斥：ready / busy / degraded 落在三个不同的 kind 上', async () => {
    const empty = await screenShowing('[22;1H› [22;3H')
    const filled = await screenShowing(
      '[22;1H› [22;3H',
      '[?2026h[22;3H/exit[22;8H[?2026l'
    )
    try {
      const kinds = new Set([
        (await admit(evidenceShowingScreen(empty))).kind,
        (await admit(evidenceShowingScreen(filled))).kind,
        (await admit(evidenceThrowing('OUTPUT_GAP'))).kind
      ])
      expect(kinds).toEqual(new Set(['ready', 'busy', 'degraded']))
    } finally {
      empty.dispose()
      filled.dispose()
    }
  })

  describe('读屏预算与首帧要求的接线（否则闲着的 Agent 被误判 / 永久 pending）', () => {
    it('稳态（awaitFreshFrame=false）：用同步快照，带上界预算，不要求新帧', async () => {
      const screen = await screenShowing('[22;1H› [22;3H')
      try {
        const evidence = evidenceShowingScreen(screen)
        await admit(evidence, false)
        const options = evidence.wait.mock.calls[0]![4]
        // 有上界预算：缺了它，屏幕不再变时这条读屏永久 pending（#628 那一类）。锚定到导出的 SSOT 常量，
        // 不写第二份字面量。
        expect(options.timeoutMs, '读屏必须带上界预算').toBe(LIVE_ADMISSION_QUERY_BUDGET_MS)
        // requireOutputAfterBoundary（第 3 个实参）在稳态必须是 false——同步快照，不等新输出。
        expect(evidence.wait.mock.calls[0]![2], '稳态用同步快照，不等 boundary 之后的新输出').toBe(false)
        expect(options.requireFrameAfterBoundary, '稳态不要求新帧，否则闲着的 Agent 被误判成 degraded')
          .toBeUndefined()
      } finally {
        screen.dispose()
      }
    })

    it('首条 prompt（awaitFreshFrame=true）：必须等 boundary 之后一个完整帧', async () => {
      const screen = await screenShowing('[22;1H› [22;3H')
      try {
        const evidence = evidenceShowingScreen(screen)
        await admit(evidence, true)
        expect(evidence.wait.mock.calls[0]![2], '首帧路径必须要求 boundary 之后有新输出').toBe(true)
        expect(evidence.wait.mock.calls[0]![4].requireFrameAfterBoundary, '首条 prompt 必须等一个完整帧')
          .toBe(true)
      } finally {
        screen.dispose()
      }
    })
  })

  describe('candidate d 世代守卫（顺序吞噬 fix）', () => {
    it('观察期间世代变化 → 判定作废（degraded=screen-evidence-replaced，绝不当 ready 放行）', async () => {
      // 场景：wait 用旧证据 resolve、composer=""——若无世代校验，admission 会把这个**过时**快照
      // 当 ready 放行；有了守卫，能识别出「等待期间 discard 发生过」并转 degraded，把同一件事
      // 交给下游 confirmRenderOrDegrade 独立决策。
      const screen = await screenShowing('\x1b[22;1H› \x1b[22;3H')
      try {
        const evidence = evidenceGenerationChangedMidWait(screen)
        // 前置自检：屏幕的 composer 真的是空串——若没有世代守卫，这里会被判成 ready，正好证伪守卫。
        expect(screen.composerText('›'), '前置：composer 空串').toBe('')
        const result = await admit(evidence)
        expect(result, '世代变化必须让判定作废，转 degraded；不能把过时快照当 ready 放行')
          .toEqual({ kind: 'degraded', reason: 'screen-evidence-replaced' })
        // 双向证明：generation 被读了两次（观察前 + 观察后）——这就是守卫存在的判据。删掉这两次
        // 中的任一次都会让守卫瘸腿：只前不后 → 每次都记录基线但从不核对；只后不前 → 恒不变化。
        expect(evidence.generation.mock.calls.length,
          '世代守卫必须记录基线（观察前）并核对结果（观察后），共 2 次').toBe(2)
      } finally {
        screen.dispose()
      }
    })

    it('观察期间世代不变 → 判定生效（稳态 ready 不许被守卫误伤）', async () => {
      // 反向：稳态下 generation 恒 0，守卫不介入。这条与上一条互相钉住守卫的两侧——上一条钉「变
      // 化必须触发」，本条钉「不变化不许误伤」。
      const screen = await screenShowing('\x1b[22;1H› \x1b[22;3H')
      try {
        expect(await admit(evidenceShowingScreen(screen))).toEqual({ kind: 'ready' })
      } finally {
        screen.dispose()
      }
    })
  })
})
