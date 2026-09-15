import { AgentTerminalScreen } from './agent-terminal-screen.js'
import { AgentMuxError } from './errors.js'
import type { AgentScreenEvidenceStore } from './screen-evidence.js'
import type { AgentMuxAgentSession, PromptDeliveryDegradedReason } from './types.js'

/**
 * 「现在这个 Run 能不能收一条 prompt」的**唯一实时判定**（f-25q8fccdm / T-001）。
 *
 * 这个模块只回答**就绪**这一问，且只从**此刻可见的字节**回答：屏幕上的 composer 现在空不空。
 * 它刻意**不碰**任何持久记账——不读 `terminalPromptReadiness.consumedBySubmissionId`（那正是
 * 本轮重构要拆掉的「一次性许可证」），也不读 `semanticStatus`（它 15 分钟后会衰减成 `unknown`，
 * 而 `unknown` 恰恰是原则明令不许在任一方向上解决的那一类，见 agent-status-freshness.ts:48,57）。
 *
 * ── 所有权边界：谁回答哪一问 ──────────────────────────────────────────────
 * 三分类（能发 / 没看清 / 没了）是全系统的判定形状（AGENTS.md 原则 11），但**本模块只拥有前两支**：
 *
 *   - `ready`   —— composer 此刻是空的，可以发。
 *   - `busy`    —— composer 此刻**非空**（上一条已进 PTY、Agent 还在生成）。不能发：现在敲键会打断
 *                  生成。这一支存在的唯一理由，是它是旧的一次性 readiness 许可证**真正唯一**在守、
 *                  而幂等 replay guard（prompt-submission.ts:186-187）覆盖不到的那个窗口。拒绝的理由
 *                  必须是「composer 非空」这个**确定的观察**，绝不能退化成一句含糊的超时。
 *   - `degraded`—— 我们**没看清**（replay 被截断 / 读屏预算内 composer 一直不可读 / 观察被换掉）。
 *                  调用点在进到这里之前**已经**向 daemon 确认过 Run 在 `running`
 *                  （client.ts:3583-3589 的 serializeAgentInput 闸门，经 requireCurrentAgentRun →
 *                  kernel.status），所以这里放行 + 广播一条服务窗事实，绝不静默。
 *
 * 第三支 `gone`（Run 真的退了 / 不在了）**不由本模块产出**：它已经由上游那道闸门以
 * `STALE_AGENT_SESSION` 表达。本模块运行时 Run 必然是 running，所以这里**不再调一次 kernel.status**
 * ——同一个事实问两遍今天恰好一致、明天就会漂移（记忆 two-resolutions-that-happen-to-agree）。
 * 谁要加第二次 status 调用，先读这段。
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * 读屏的短预算。这不是等 Agent 冷启动的那条 120s 等待，也不是等「字送进去、屏幕该回显」的 10s 渲染
 * 确认——这是一次**当下快照**：稳态下 composer 空不空立刻就能从当前屏幕求值（agent-terminal-screen.ts
 * :219-233，requireOutputAfterBoundary/requireFrameAfterBoundary 都不置时同步判定），空则瞬时返回，
 * 正在生成则落到这个预算上、报 `busy`。取一个短值，是因为一个闲着的 Agent 不该让发送侧干等。
 */
export const LIVE_ADMISSION_QUERY_BUDGET_MS = 250

/**
 * 一次实时就绪判定的结果。三支互斥，各自的处理**方向相反**，所以绝不能坍缩成布尔：
 * `ready` 放行、`busy` 拒绝（拦住打断生成）、`degraded` 放行但带告示。
 */
export type PromptAdmission =
  | { kind: 'ready' }
  | { kind: 'busy' }
  | { kind: 'degraded'; reason: PromptDeliveryDegradedReason }

/**
 * 把读屏失败的错误码映成既有的服务窗降级原因（types.ts 的 PROMPT_DELIVERY_DEGRADED_REASONS 是 SSOT）。
 * 这三个码与映射照抄 confirmRenderOrDegrade 的降级白名单（prompt-submission.ts:495,514-516），让本模块
 * 产出的原因正是上层已经会广播的那套，不新造一份词汇。
 */
const DEGRADE_REASON_BY_CODE: Readonly<Record<string, PromptDeliveryDegradedReason>> = {
  OUTPUT_GAP: 'screen-evidence-gap',
  AGENT_PROMPT_RENDER_TIMEOUT: 'prompt-render-timeout',
  AGENT_PROMPT_READINESS_CANCELLED: 'screen-evidence-replaced'
}

/**
 * 此刻问一次：这个 Run 能不能收 prompt。
 *
 * @param awaitFreshFrame 只在一个 Run 的**首条** prompt（`terminalPromptSubmission === undefined`）为 true：
 *   首帧还在画时同步求值不成立，必须等 boundary 之后一个完整帧（对齐 initial-composer 的既有先例
 *   prompt-submission.ts:704-706）。稳态传 false，用同步快照，否则会把一个闲着的 Agent 误判成 degraded。
 */
export async function queryPromptAdmission(
  screenEvidence: Pick<AgentScreenEvidenceStore, 'wait' | 'generation'>,
  session: AgentMuxAgentSession,
  options: {
    activeComposer: string
    outputCursorBytes: number
    awaitFreshFrame: boolean
  }
): Promise<PromptAdmission> {
  // 谓词只判「composer 现在可读了没有」（非 null）。可读之后由下面的 `=== ''` 分 ready / busy——把
  // 「读到了」与「读到的是空」拆开，才能让「composer 非空」是一个确定的观察，而不是掉进超时里。
  let composer: string | null = null
  // 顺序吞噬 candidate d（cutover plan §顺序吞噬）：`generation()` 是 store 上一个 read-only 计数，
  // 每次 discard(sessionId) +1。在观察**开始前**记一个基线世代，观察结束后**必须**是同一世代——
  // 否则说明本轮读屏期间 upstream 触发过 discard（resize / 掉线重挂），我们读到的 composer 已不能
  // 代表「此刻」的屏幕。这条守卫让 admission 与下游 confirmRenderOrDegrade 各自独立观测到 discard，
  // 不再抢答 CANCELLED——两位都当 degraded 处理，各自广播各自的服务窗。
  const admissionGeneration = screenEvidence.generation(session.agentSessionId)
  // 双超时：`timeoutMs` 走 `wait` 内部的 timer；`Promise.race` 独立于它兜底。两者都存在是**故意的
  // 冗余**——`wait` 尊重 timeoutMs 时（生产路径）内部 timer 先赢；`wait` 因任何原因不尊重（并发
  // 观察相互阻塞的 in-flight 场景、上游代码路径尚未接线 timer、或将来重构疏漏），外层 race 兜底防
  // 止 admission 拖住整条 submit 队列。健康 Agent 稳态下毫秒级返回，两条路径都不会触发。
  const admissionBudgetElapsed = new Promise<'admission-budget-elapsed'>((resolve) => {
    const t = setTimeout(() => resolve('admission-budget-elapsed'), LIVE_ADMISSION_QUERY_BUDGET_MS)
    t.unref?.()
  })
  try {
    const outcome = await Promise.race([
      screenEvidence.wait(
        session,
        options.outputCursorBytes,
        options.awaitFreshFrame,
        (screen: AgentTerminalScreen): boolean => {
          composer = screen.composerText(options.activeComposer)
          return composer !== null
        },
        {
          timeoutMs: LIVE_ADMISSION_QUERY_BUDGET_MS,
          timeoutMessage: 'Timed out reading the Agent composer state.',
          terminalMessage: 'Agent Run exited before its composer state could be read.',
          ...(options.awaitFreshFrame ? { requireFrameAfterBoundary: true } : {})
        }
      ),
      admissionBudgetElapsed
    ])
    if (outcome === 'admission-budget-elapsed') {
      // 外层预算耗尽——把它当作跟 wait 内部超时同一件事：我们没看清 composer。
      return { kind: 'degraded', reason: 'prompt-render-timeout' }
    }
  } catch (error) {
    const reason = error instanceof AgentMuxError ? DEGRADE_REASON_BY_CODE[error.code] : undefined
    // 只有「没看清」的三类降级放行；其余（Run 退出→AGENT_PROMPT_RENDER_FAILED、数据损坏等）照常抛，
    // fail-closed——那不是慢证据，放行它才是把别的故障说成「就绪」。
    if (reason === undefined) throw error
    return { kind: 'degraded', reason }
  }
  // 观察后**再核一次世代**：若在等待窗口里发生过 discard（本次 wait 已经用旧证据 resolve，或者
  // 下一次 wait 会 rebuild 一具全新 evidence），当次判定必须作废——判成 degraded 让下游拿到同样
  // 的信号，而不是把一个过时的 composer 快照当 ready 放行。这一条把候选 d 的核心不变量落成代码。
  if (screenEvidence.generation(session.agentSessionId) !== admissionGeneration) {
    return { kind: 'degraded', reason: 'screen-evidence-replaced' }
  }
  // wait 成功但**从未见到一帧**——真实的 `wait` 契约会跑 predicate 直到返回 true 才 resolve，因此正常
  // 路径下 composer 必然非 null；但 predicate 也可能被 `wait` 内部的旧证据/短路路径绕开，或者 predicate
  // 唯一一次看到的屏幕上 provider 匹配器认不出布局（`composerText` 返回 null）。这两种都归到「没看清」
  // 而不是「非空 = busy」——把「读到了但没解析出 composer」错判成 busy 会拦掉一个健康 Agent。
  if (composer === null) return { kind: 'degraded', reason: 'screen-evidence-gap' }
  return composer === '' ? { kind: 'ready' } : { kind: 'busy' }
}
