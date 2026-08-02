import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import {
  AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  agentMuxControlTimeoutMs,
  isLongAgentMuxControlOperation
} from '@agentmux/core/control'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'

function inspectRequest(requestId: string): AgentMuxControlRequest {
  return {
    schemaVersion: AGMUX_CONTROL_SCHEMA_VERSION,
    requestId,
    operation: 'inspect.tab',
    caller: { agentSessionId: 'caller' },
    target: { kind: 'self' }
  }
}

function openRequest(requestId: string): AgentMuxControlRequest {
  return {
    schemaVersion: AGMUX_CONTROL_SCHEMA_VERSION,
    requestId,
    operation: 'open.agent',
    caller: { agentSessionId: 'caller' },
    content: { kind: 'new-agent', executorId: 'codex' },
    destination: { kind: 'new-tab', after: { kind: 'self' } }
  }
}

const AGMUX_CONTROL_SCHEMA_VERSION = AGENTMUX_CONTROL_SCHEMA_VERSION

afterEach(() => vi.useRealTimers())

describe('Desktop Control IPC bridge', () => {
  it('cancels the Renderer transaction when a long request times out and ignores its late response', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const cancellations: unknown[] = []
    const bridge = new DesktopControlIpcBridge({
      isAvailable: () => true,
      sendRequest: (request) => sent.push(request),
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })

    const pending = bridge.execute(openRequest('open-timeout'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(sent).toHaveLength(1)
    // 不硬写 60_000：那会是这个预算的第三份手抄（core 两条路各一份 + 测试一份），于是把其中一处
    // 改掉时测试照旧绿。这里问的是「这条路等的就是 core 说的那个数」。
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('open.agent'))

    await rejected
    expect(cancellations).toEqual([{
      requestId: 'open-timeout',
      code: 'CONTROL_TIMEOUT',
      message: 'Desktop Control request timed out.'
    }])
    expect(bridge.accept({
      requestId: 'open-timeout',
      ok: true,
      result: {
        operation: 'open.agent',
        region: {
          kind: 'agent',
          tabId: 'late-tab',
          regionId: 'late-region',
          workspaceId: 'workspace',
          agentSessionId: 'late',
          providerId: 'codex',
          executorId: 'codex'
        }
      }
    })).toBe(false)
  })

  it('cancels every pending Renderer transaction when the owner is disposed', async () => {
    const cancellations: unknown[] = []
    const bridge = new DesktopControlIpcBridge({
      isAvailable: () => true,
      sendRequest: () => {},
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })
    const pending = bridge.execute(inspectRequest('dispose-me'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })

    bridge.dispose()

    await rejected
    expect(cancellations).toEqual([expect.objectContaining({ requestId: 'dispose-me' })])
  })
})

/**
 * 等待预算是**一处**，两条到达路共用。
 *
 * 同一条 `amux open.agent` 有两条到达执行方的路，各有一个等待方：CLI→daemon 的 socket
 * （core 的 control-host），以及 Renderer 拥有屏幕时 main→Renderer 的这条 IPC 桥。此前两侧各手抄
 * `2_000` / `60_000`，而**「哪些操作算慢」在 core 是命名函数、在桥这边被内联展开成同样的四项析取**。
 * 后果：加一个慢操作（将来的 `open.file` 等磁盘、`arrange` 等布局落定）时，只改 core 那个函数的人
 * 会得到一个全绿的仓库，而这条路静默给它 2 秒——用户看到的是「同一个命令有时能开出来、有时报
 * CONTROL_TIMEOUT」，差别只在当时是谁拥有屏幕。取值手抄会漂移，判据手抄同样会且更难看出来。
 *
 * 上面那条行为测试已经用 `agentMuxControlTimeoutMs('open.agent')` 推进定时器，所以桥**取的数**有人守。
 * 下面补的是它守不住的那一层：桥有没有真的**从那一处取**，还是自己又算了一遍恰好相等的数。
 */
describe('Control 等待预算只有一处', () => {
  const bridgeSource = readFileSync(
    new URL('../src/main/control-ipc-bridge.ts', import.meta.url),
    'utf8'
  )

  it('长操作等长预算、短操作等短预算——取值本身', () => {
    expect(agentMuxControlTimeoutMs('open.agent')).toBe(AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS)
    expect(agentMuxControlTimeoutMs('inspect.tab')).toBe(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
    // 自检：两个预算相等时上面两条恒真，整族退化成装饰。
    expect(
      AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS,
      '长短预算相等，这一族分辨不出任何东西'
    ).toBeGreaterThan(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
  })

  it('慢的是「要等外面」的那些，快的是只读/只动本地状态的', () => {
    // 判据落在**语义**上而不是抄一份清单：等进程起来、等 composer 就绪、等 Provider 重建会话、
    // 等进程收尾——这四类要长预算；inspect/focus/arrange/list 两秒内不返回就是真出事了。
    for (const operation of ['open.agent', 'open.terminal', 'open.browser', 'send', 'resume', 'stop'] as const) {
      expect(isLongAgentMuxControlOperation(operation), `${operation} 要等外面，必须走长预算`).toBe(true)
    }
    for (const operation of ['inspect.tab', 'inspect.region', 'focus', 'arrange', 'list.agents'] as const) {
      expect(isLongAgentMuxControlOperation(operation), `${operation} 只读或只动本地状态，不该占长预算`).toBe(false)
    }
  })

  it('桥从 core 那一处取预算，不再自己算一遍——判据是 import 关系，不是字面量缺席', () => {
    // 为什么判 import 而不是「没有 60_000 这个字面量」：换个写法（`60 * 1_000`、`6e4`、一个中间常量）
    // 就能绕过字面量判据，而"自己算一遍"这件事照旧发生。这里问的是它到底从哪儿拿这个数。
    expect(
      /import\s*\{[^}]*\bagentMuxControlTimeoutMs\b[^}]*\}\s*from\s*'@agentmux\/core\/control'/.test(bridgeSource),
      '桥没有从 @agentmux/core/control 导入 agentMuxControlTimeoutMs：预算又变成两处各算一遍'
    ).toBe(true)
    // 自检：正则认得出它要找的那种形状，否则上面那条是死代码。
    expect(
      /import\s*\{[^}]*\bagentMuxControlTimeoutMs\b[^}]*\}\s*from\s*'@agentmux\/core\/control'/.test(
        "import { agentMuxControlTimeoutMs } from '@agentmux/core/control'"
      ),
      '判据认不出正常的导入写法'
    ).toBe(true)

    // 而且那个导入必须真被用上，且**延时位取的就是它**：只导入不调用等于没接（本仓 noUnusedLocals
    // 未开，tsc 不会拦）。判法不是「某个禁止形状不在场」——换个拼法就能绕过，还会误伤别处按操作
    // 派发的合法 `operation === 'send'`。这里把每一处 setTimeout 的延时位抽出来，只允许 core 那一处。
    const delays = [...bridgeSource.matchAll(/setTimeout\(\s*(?:\(\)\s*=>[\s\S]*?\}\s*,\s*)?([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)]
      .map((match) => match[1]!)
    for (const delay of delays) {
      expect(
        delay,
        `setTimeout 的延时位写着 \`${delay}\`，不是从 @agentmux/core/control 那一处取的`
      ).toBe('agentMuxControlTimeoutMs(request.operation)')
    }
    // 自检：抽取器真的找到了那个调用点，否则上面那个循环跑零次、恒绿。
    expect(delays.length, 'setTimeout 延时位抽取器一个都没找到，上面那条守卫是死代码').toBe(1)
    // 自检：抽取器认得出「自己算一遍」的那种拼法（事故当时就是这个形状）。
    const historical = `const timeout = setTimeout(() => {\n  this.cancel(id)\n}, longOperation(request.operation) ? LONG : SHORT)`
    expect(
      [...historical.matchAll(/setTimeout\(\s*(?:\(\)\s*=>[\s\S]*?\}\s*,\s*)?([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/g)].map((m) => m[1]!),
      '抽取器认不出内联算一遍的形状，那条守卫是死代码'
    ).toEqual(['longOperation(request.operation)'])
  })
})
