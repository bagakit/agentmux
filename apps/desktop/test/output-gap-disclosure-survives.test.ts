import { describe, expect, it } from 'vitest'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'

/**
 * 守「截断披露不被紧随的 running 洗掉」。
 *
 * 缺陷（逐行核实，并由本文件的变异实测）：重连重建字节泵时，daemon 可能已经把游标处的字节逐出
 * （first_available_byte > cursor）。Core 会为此发一条 `agent-error / OUTPUT_GAP`——「你的历史输出
 * 被丢了」。但它此前发在 `publishRunState(running)` **之前**，而渲染端 reducer 的新鲜度判据是
 * `observedAt >=`（session-state.ts:513），`run-process` 又不在豁免来源里（只豁免 native-hook/acp）。
 * 两个 observedAt 来自相邻两次 `Date.now()`，gap 那次在前——所以 running 恒 `>=`，恒赢。
 *
 * 结果：这句披露一次都没到过屏幕。用户看到输出里一段无法解释的断裂，状态一切正常，没有任何提示说
 * 「这里少了一段，是 daemon 丢的」。这与 7abf8492 修的那个缺陷是同一个形状的孪生兄弟，长在同一个
 * 方法的另一条分支上：那条是「失败被洗成正常」，这条是「截断被洗成正常」。
 *
 * 两条分支的解法**必须不同**，这正是返回值从 boolean 改成三态的原因：
 * - 接不上（dead）：跳过 republish。流是死的，running 是谎话。
 * - 截断（truncated）：**照常** republish，但把披露排在它**后面**。流是活的，running 是实话；
 *   同一条 `>=` 规则，谁最后发谁赢。
 *
 * 判据走**真 reducer**（`reduceRuntimeEvent`），不是断言 Core 里两条 publish 的源码顺序：顺序断言
 * 不执行代码，也不回答「用户最终看到什么」这唯一要紧的问题。同刻时间戳是刻意的——`>=` 只在同毫秒
 * 那一档才是独有的承重条件，跨毫秒时靠 `>` 就已经生效，所以用同刻才真正钉住它。
 */

const SESSION: SessionSnapshot = {
  id: 'agent-1',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  label: 'Agent',
  createdAt: 1,
  updatedAt: 1,
  processState: 'running',
  latestOutputBytes: 0,
  capabilities: { interaction: false, posture: false, skills: false, commands: false },
  run: { runId: 'run-1' },
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  // reducer 认 run 身份走的是 `control.run`（session-state.ts:75、:71），不是顶层 `run`。两处都给
  // 同一个 runId，免得 fixture 形状对不上导致测试静默失明。
  control: { canInterrupt: true, canSend: true, run: { runId: 'run-1' } }
} as unknown as SessionSnapshot

const OBSERVED_AT = 100

/** Core 事件经 `{type:'core', hostId, event}` 这层信封到达 renderer——reducer 读的是 `.event`。 */
function wrap(event: unknown): RuntimeEvent {
  return { type: 'core', hostId: 'local', event } as RuntimeEvent
}

function gapError(): RuntimeEvent {
  return wrap({
    type: 'agent-error',
    agentSessionId: 'agent-1',
    code: 'OUTPUT_GAP',
    message: 'CtxMux evicted output before this Attachment could resume it.',
    evidence: { source: 'terminal-output', observedAt: OBSERVED_AT, run: { runId: 'run-1' } }
  })
}

function runningState(): RuntimeEvent {
  return wrap({
    type: 'process-state',
    agentSessionId: 'agent-1',
    state: 'running',
    run: { runId: 'run-1' },
    // 同刻：与 gap 那条同一个 observedAt。`>=` 让后到者赢，所以结局只由顺序决定。
    evidence: { source: 'run-process', observedAt: OBSERVED_AT }
  })
}

function apply(events: RuntimeEvent[]): SessionSnapshot {
  let state = { sessions: [SESSION] } as unknown as Parameters<typeof reduceRuntimeEvent>[0]
  for (const event of events) state = reduceRuntimeEvent(state, event)
  return (state as unknown as { sessions: SessionSnapshot[] }).sessions[0]!
}

describe('重连遇到 daemon 截断时，披露必须活到屏幕上', () => {
  it('先 running 后 gap：用户看得见截断', () => {
    // 这是修复后的发出顺序。把 client.ts 里两条 publish 换回「先 gap 后 running」，这条红。
    const session = apply([runningState(), gapError()])
    expect(session.status.state, 'OUTPUT_GAP 披露被紧随的 running 洗掉了').toBe('error')
  })

  it('反序会丢掉披露——这正是被修的缺陷，钉住它以免顺序被人调回去', () => {
    // 不是多余的旁证：它证明上一条的绿**来自顺序**，而不是「reducer 恰好偏爱 error」。同样两条事件、
    // 同样的同刻时间戳，只换顺序，结局就相反——这才叫顺序是承重的。
    const session = apply([gapError(), runningState()])
    expect(session.status.state, '同刻下后到的 running 本应赢；这一条不成立，上一条的绿就不再说明顺序')
      .toBe('running')
  })
})
