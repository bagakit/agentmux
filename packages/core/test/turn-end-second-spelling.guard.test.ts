import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { hookResponseFor } from '../src/agent-hook-command.js'
import { rawEventNamesForLifecycle } from '../src/agent-hook-event.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxStoredAgentSession,
  AgentProviderId,
  NativeHookEnvelope
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 守「turn-end 的第二拼法」不再被漏掉。
//
// canonical 表（agent-hook-event.ts）把 `Stop` 与 `StopFailure`（以及 grok 的 `stop_failure`/
// `stop_cancelled`、Hermes 的 `on_session_end`/`post_llm_call`、Pi 的 `agent_settled`、Gemini 的
// `AfterAgent`、Copilot 的 `agentStop`…）**全部**归一到 `turn-end`。三个消费点若改回比原始拼法
// `=== 'Stop'`，就只认 PascalCase 的第一种收尾，对 kimi/grok 真实发出的 `StopFailure` 静默失明：
//   client.ts  取内核输出光标快照（terminalPromptReadiness）
//   client.ts  promptSubmission.observeReadiness（就绪观察）
//   agent-hook-command.ts  Antigravity 的收尾门控回执
//
// 这份守卫**从 SSOT 派生** turn-end 的原始名集合（rawEventNamesForLifecycle），绝不手抄一份事件名
// ——手抄的清单正是本次要修的缺陷形状。将来加一行 `StopCancelled → turn-end` 会自动被覆盖。
//
// 判据钉的是**行为**（第二拼法与 `Stop` 走同一分支、产生同一副作用），不是源码里有没有某个字符串：
// `toContain` 不执行代码，对提前 return 与拼法替换都失明。
// ---------------------------------------------------------------------------

// SSOT：所有归一到 turn-end 的原始方言名。三个消费点都必须对这一整组一视同仁。
const TURN_END_RAW_NAMES = rawEventNamesForLifecycle('turn-end')
// `Stop` 是 canonical 表里 PascalCase 的第一种收尾，也是被漏改的三处硬编码的那一个字面量。
// 「第二拼法」= 除它以外的每一个 turn-end 原始名。这一组必须非空，否则整份守卫是无意义的空扫。
const SECOND_SPELLINGS = TURN_END_RAW_NAMES.filter((name) => name !== 'Stop')

function storedSession(providerId: AgentProviderId = 'codex'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-turn-end-guard'.padEnd(43, 'A'),
    hookToken: 'token-turn-end-guard'.padEnd(43, 'B'),
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-1' }
  }
}

function runningRun(): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 7,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

function hook(receiptId: string, eventName: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId: 'codex',
    eventName,
    payload: { hook_event_name: eventName, tool_name: 'shell', session_id: 'native-1' }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  promptSubmission: { observeReadiness(...args: unknown[]): void }
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}

async function driveTurnEnd(eventName: string): Promise<{
  readiness: AgentMuxStoredAgentSession['terminalPromptReadiness']
  observeReadinessCalls: number
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => runningRun()
  // 只观察「site 2 是否被走到」，不让它真的去等屏幕证据（那是 fire-and-forget，会开着句柄）。
  const observeSpy = vi
    .spyOn(internals.promptSubmission, 'observeReadiness')
    .mockImplementation(() => {})
  try {
    await internals.acceptHookEvent(hook(`receipt-${eventName}`, eventName), AbortSignal.timeout(5_000))
    const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
    const session = sessions.find((s) => s.agentSessionId === 'agent-1')
    return {
      readiness: session?.terminalPromptReadiness,
      observeReadinessCalls: observeSpy.mock.calls.length
    }
  } finally {
    observeSpy.mockRestore()
    await client.dispose()
  }
}

describe('turn-end second-spelling guard: SSOT floor', () => {
  it('从 canonical 表派生出的 turn-end 原始名必须非空，且含 Stop 之外的第二拼法', () => {
    // 空扫默默通过是本仓已知的假绿形状——这里显式给守卫一个下界：没有第二拼法可测，就是守卫坏了。
    expect(TURN_END_RAW_NAMES.length).toBeGreaterThan(0)
    expect(TURN_END_RAW_NAMES).toContain('Stop')
    expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)
    // StopFailure 是本次缺陷的具体可达面（kimi/grok 都声明它）。它必须在 SSOT 的 turn-end 组里，
    // 否则「第二拼法会被漏掉」这个前提本身已不成立，守卫必须响亮地报出来而不是静默改守别的。
    expect(SECOND_SPELLINGS).toContain('StopFailure')
  })
})

describe('turn-end second-spelling guard: Antigravity 收尾门控回执 (agent-hook-command.ts)', () => {
  it('每一个 turn-end 原始名都与 Stop 得到同一个门控回执', () => {
    // 行为判据：hookResponseFor 是纯函数，直接比对副作用（返回的 stdout）。
    // 基线——Stop 必须回收尾决策，挡住「整支函数坏掉」这种过宽失败。
    expect(hookResponseFor('antigravity', 'Stop')).toBe('{"decision":""}\n')
    expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)
    for (const name of SECOND_SPELLINGS) {
      // 若这里改回 `=== 'Stop'`，StopFailure 等第二拼法会落到 `{}\n`（无决策），Antigravity 把它
      // 读作 HARD DENY——本条断言随即变红。
      expect(hookResponseFor('antigravity', name), `${name} 应与 Stop 同为收尾决策`).toBe(
        '{"decision":""}\n'
      )
    }
  })
})

describe('turn-end second-spelling guard: client 摄入侧两处收尾分支 (client.ts)', () => {
  it('turn-end 的第二拼法与 Stop 一样：取光标快照 + 触发就绪观察', async () => {
    // 基线：Stop 两处副作用都在（否则等价性无意义）。
    const stopEffect = await driveTurnEnd('Stop')
    expect(stopEffect.readiness?.source, 'Stop 应建立 native-stop 就绪光标').toBe('native-stop')
    expect(stopEffect.observeReadinessCalls, 'Stop 应触发就绪观察').toBeGreaterThan(0)

    expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)
    for (const name of SECOND_SPELLINGS) {
      const effect = await driveTurnEnd(name)
      // site 1：`=== 'Stop'` 的话，第二拼法拿不到 stopRun，terminalPromptReadiness 缺席——本断言变红。
      expect(effect.readiness?.source, `${name} 应像 Stop 一样建立就绪光标`).toBe('native-stop')
      // site 2：`=== 'Stop'` 的话，第二拼法不会触发 observeReadiness——本断言变红。
      expect(
        effect.observeReadinessCalls,
        `${name} 应像 Stop 一样触发就绪观察`
      ).toBeGreaterThan(0)
    }
  })
})
