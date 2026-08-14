// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import {
  CONNECTION_LOST_DETAIL,
  CONNECTION_UNRECOVERABLE_DETAIL
} from '../src/renderer/src/lib/session-state.js'

/**
 * f-2588fuu6e / T-002：重连期间「已补发的正常态」不得把 `disconnected` 洗成正常运行态。
 *
 * 真缺陷（committed，逐行核实）：wire 断掉时 Agent 的子进程还活着、hook HTTP 服务器也没停
 * （`hookServer.stop()` 只在 `open()` 失败与 `dispose()` 调用，client.ts:691/1003），于是它照旧经
 * loopback POST 生命周期 hook；`acceptHookEvent` 没有连接闸门（client.ts:3570 只挡已终结的 run），
 * `publishHook` 盖的 observedAt 是 `Date.now()`（hook-normalizer.ts:480）——严格新于掉线那一刻。
 * 而 renderer 的两条状态覆盖 arm（`agent-status` / `agent-session` 的 semanticStatus）此前只有
 * observedAt 单调门禁，**没有** `disconnected` 保持项。于是一条迟到的 hook 把 `disconnected` 翻成
 * `working`：恢复横幅（SessionPane 键在 `status.state === 'disconnected'`）消失，可字节泵已被拆掉。
 * `unrecoverable` 那格尤其致命——give-up 后没有重连循环，「使用 Resume」这个唯一出路只挂在
 * `disconnected` 的 detail 上，洗掉状态就把它一起抹了。
 *
 * 唯一合法的「解掉线」是 `republishLiveRunState` 在重建完字节泵之后补发的 `process-state: running`
 * （client.ts:840-846，attach 重建 await 完才 publish）。它先把 `disconnected` 清成 running，此后
 * hook 才照常流动——所以字节通道真相只由 process-state 给，hook / 语义状态不是它的解除手。
 *
 * 判据走真渲染路径（createRoot + act，跑 effect），驱动真 store 的 applyEvent → 真 reducer。
 * 不用 renderToStaticMarkup：它不跑 effect、对删 effect 完全失明（验收 #4）。
 */

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

// 只 mock 重量级叶子子组件——它们不是被测对象，且 TerminalView 会拉起 xterm。被测对象是
// reducer 那两条 arm 与 SessionPane 的横幅键，两者都真跑。
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({
  TerminalView: () => <div data-test-view="terminal" />
}))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({
  ActivityView: () => <div data-test-view="activity" />
}))
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({
  AgentSessionComposer: ({ disabled }: { disabled?: boolean }) => (
    <div data-test-agent-composer={disabled ? 'disabled' : 'enabled'} />
  )
}))
vi.mock('../src/renderer/src/components/AgentInteractionCard.js', () => ({
  AgentInteractionCard: () => <div data-test-interaction-card />
}))

import { useAppStore } from '../src/renderer/src/store.js'
import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agentSession(): SessionSnapshot {
  return {
    id: 'agent-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } }
  }
}

const core = (event: RuntimeEvent['event']): RuntimeEvent => ({ type: 'core', hostId: 'local', event })

/** 掉线：Core 发 connection-state，renderer 把该 Host 的 Agent 置 disconnected。 */
function connectionLost(state: 'lost' | 'unrecoverable', observedAt: number): RuntimeEvent {
  return core({ type: 'connection-state', state, evidence: { source: 'run-process', observedAt } })
}

/** 迟到的原生 hook（掉线期间 Agent 子进程仍在 POST）：agent-status，observedAt 严格更新。 */
function lateHook(semantic: 'working' | 'waiting', observedAt: number): RuntimeEvent {
  return core({
    type: 'agent-status',
    agentSessionId: 'agent-1',
    state: semantic,
    detail: 'PostToolUse',
    evidence: { source: 'native-hook', observedAt, run: { runId: 'run-1' } }
  })
}

/** 随会话快照重发的 semanticStatus：agent-session，observedAt 严格更新。 */
function sessionSnapshotStatus(semantic: 'working' | 'waiting', observedAt: number): RuntimeEvent {
  return core({
    type: 'agent-session',
    session: {
      kind: 'agent',
      agentSessionId: 'agent-1',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: '/repo',
      run: { runId: 'run-1' },
      retiredRuns: [],
      outputCursorBytes: 0,
      createdAt: 1,
      updatedAt: observedAt,
      semanticStatus: { state: semantic, source: 'native-hook', observedAt }
    }
  })
}

/** 真正的通道恢复：republishLiveRunState 在重建完泵之后补发的 process-state: running。 */
function republishedRunning(observedAt: number): RuntimeEvent {
  return core({
    type: 'process-state',
    agentSessionId: 'agent-1',
    run: { runId: 'run-1' },
    pid: 42,
    state: 'running',
    evidence: { source: 'run-process', observedAt, run: { runId: 'run-1' } }
  })
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    sessions: [agentSession()],
    viewModes: { 'agent-1': 'terminal' }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <SessionPane
        sessionId="agent-1"
        surfaceKind="agent"
        interactiveResize={false}
        visible
        linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group-1' }}
      />
    )
  })
}

async function apply(event: RuntimeEvent): Promise<void> {
  await act(async () => { useAppStore.getState().applyEvent(event) })
}

function bannerText(): string {
  return container.querySelector('.terminal-recovery')?.textContent ?? ''
}

describe('重连中间态：补发的正常态不得把 disconnected 洗成正常运行', () => {
  // 验收 #1 + #3（行为判据 + 变异红绿），hook 方向。
  it('lost 期间一条迟到的 native-hook 不得让恢复横幅消失', async () => {
    await mount()
    await apply(connectionLost('lost', 9))
    // 掉线态下横幅在场，正文说进程还在跑。
    expect(container.querySelector('.terminal-recovery')).not.toBeNull()
    expect(bannerText()).toContain('Remote terminal disconnected')

    // 迟到的 hook（observedAt 更新）：通道尚未重建，绝不能被它洗成正常态。
    await apply(lateHook('working', 20))

    // 横幅仍在——用户看到的状态与真实可用性一致。把 reducer 里 agent-status arm 的
    // `item.status.state !== 'disconnected'` 项删掉（退回「见到状态即覆盖」），这条红。
    expect(container.querySelector('.terminal-recovery')).not.toBeNull()
    expect(bannerText()).toContain('Remote terminal disconnected')
    // 且 store 里那条 Session 的状态仍是 disconnected——composer 可写性、tab 圆点等 8 处 UX 全键在它上。
    expect(useAppStore.getState().sessions[0]!.status.state).toBe('disconnected')
  })

  // 验收 #1 + #3，semanticStatus 方向（agent-session 会话快照重发）。
  it('lost 期间随会话快照重发的 semanticStatus 不得让横幅消失', async () => {
    await mount()
    await apply(connectionLost('lost', 9))
    expect(container.querySelector('.terminal-recovery')).not.toBeNull()

    await apply(sessionSnapshotStatus('working', 20))

    // 删掉 agent-session arm 的 `item.status.state !== 'disconnected'` 项，这条红。
    expect(container.querySelector('.terminal-recovery')).not.toBeNull()
    expect(bannerText()).toContain('Remote terminal disconnected')
  })

  // unrecoverable 那格：洗掉状态会抹掉「使用 Resume」这个唯一出路——最坏的谎话。
  it('unrecoverable 期间迟到的 hook 不得抹掉「已放弃、请手动恢复」横幅', async () => {
    await mount()
    await apply(connectionLost('unrecoverable', 9))
    expect(bannerText()).toContain('Can’t reach this host')

    await apply(lateHook('waiting', 20))

    expect(container.querySelector('.terminal-recovery')).not.toBeNull()
    // 终局标题仍在，Resume 出路仍在——detail 就挂在 disconnected 上，洗掉就一起没了。
    expect(bannerText()).toContain('Can’t reach this host')
    expect(bannerText()).toContain('Resume')
  })

  // 验收 #2（消失）+ #3：真恢复时横幅按真实状态消失，不残留。
  it('通道真恢复（process-state: running）后横幅消失，不残留', async () => {
    await mount()
    await apply(connectionLost('lost', 9))
    // 中间：迟到 hook 到过，但横幅仍在（上面已证）。
    await apply(lateHook('working', 20))
    expect(container.querySelector('.terminal-recovery')).not.toBeNull()

    // 真正的解除：republishLiveRunState 重建完泵之后补发的 process-state: running。
    await apply(republishedRunning(30))

    // 横幅消失——absence 是验收 #2 的那一半。把 reducer 的 process-state arm 改成永不清
    // disconnected（例如给它也加上 `!== 'disconnected'` 门），这条红：横幅永久残留。
    expect(container.querySelector('.terminal-recovery')).toBeNull()
    // store 状态回到 running：通道真回来了。
    expect(useAppStore.getState().sessions[0]!.status.state).toBe('running')
  })

  // 反向自检：不掉线时，一条正常 hook 照旧点亮状态——保持项只挡 disconnected，不误伤正常路径。
  it('未掉线时 native-hook 照常更新状态（保持项不误伤正常点亮）', async () => {
    await mount()
    // 没有 connection-state:lost。横幅本就不在。
    expect(container.querySelector('.terminal-recovery')).toBeNull()

    await apply(lateHook('working', 20))
    const status = useAppStore.getState().sessions[0]!.status
    expect(status.state).toBe('working')
    expect(container.querySelector('.terminal-recovery')).toBeNull()
  })
})

// 引用两个 SSOT 常量，防止未来横幅文案漂移时本文件静默失配（它们是 detail 的来源）。
void CONNECTION_LOST_DETAIL
void CONNECTION_UNRECOVERABLE_DETAIL
