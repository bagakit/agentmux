import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 启动失败绝不能是静默的。
//
// 缺陷形状：`canonicalizeAgentLaunch` 返回 `null`（在途 overflow 触发重新取快照，而这个 session
// 已经不在快照里了——进程在启动过程中就没了）时，`launchAgent` 只翻回 launcher 然后**直接 return**：
// 既不 `reportError`，也不 throw。用户看到的是初始页自己闪回来，草稿还在，而没有任何一个字解释
// 发生了什么——与「我刚才是不是没点上」一字不差。
//
// 同一个条件在另一个调用点（Control 那条 `runControlRequest` 路径）判得完全不同：那里
// `if (!canonical) return await cleanup(controlFailure('CONTROL_OWNER_LOST', ...))`，是响亮失败。
// 两条路对同一个事实判得不一样，就先假定其中一条是 bug（记忆 guard-count-exits-not-conditions）。
//
// 这一族的判据落在**用户能不能知道**上，而不是「状态对不对」：状态本来就是对的（region 翻回
// launcher 是正确行为），错的是它一声不响。所以断言钉的是 `error` 有值 + 那个 Promise 被 reject。
// ---------------------------------------------------------------------------

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex',
      providerId: 'codex',
      command: 'codex',
      args: [],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function launcherFixture(): WorkbenchTab {
  const tabId = 'launcher-tab'
  const launcher = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId: 'workspace'
  })
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    tabs: { [launcher.id]: launcher },
    layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
    pendingAgentLaunches: {},
    agentComposerDrafts: {},
    error: null
  })
  return launcher
}

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

/**
 * 摆出「in-flight 事件溢出，重取快照时这个 session 已经不在了」这个真实场景。
 *
 * `sessionId` 由 `launchAgent` 内部生成、从不出参，所以溢出标记只能在 mock 拿到它的那一刻写：
 * 这也正是真实时序——事件在启动返回前就已经溢出了。
 */
function launchThatVanishesDuringResync(): { stopped: string[] } {
  const stopped: string[] = []
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input): Promise<AgentLaunchResult> => {
    const id = input.agentSessionId!
    useAppStore.setState((state) => ({
      pendingAgentLaunches: {
        ...state.pendingAgentLaunches,
        [id]: { events: [], overflowed: true }
      }
    }))
    return { session: agentSession(id), timeline: { agentSessionId: id, revision: 0, items: [] } }
  })
  // 快照里没有它 —— `canonicalizeAgentLaunch` 于是返回 null。
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {} } as never)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control) => {
    stopped.push((control as { agentSessionId: string }).agentSessionId)
  })
  return { stopped }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('启动在重新对齐时失败也必须响亮', () => {
  it('前提自检：这一次真的走进了 canonicalize 返回 null 那条路', async () => {
    // 若 fixture 没能让 canonicalize 返回 null，下面两条会因为「启动成功了」而绿，
    // 判据就与被测的那条路无关了。region 翻回 launcher 是这条路独有的可观测结果：
    // 启动成功会是 attached agent，别的失败路径会先抛在更前面（那时 stop 也不会被调）。
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    launchThatVanishesDuringResync()

    await useAppStore
      .getState()
      .launchAgent('codex', 'p', 'pane', { tabId: launcher.id, regionId })
      .catch(() => {})

    expect(
      useAppStore.getState().tabs[launcher.id]?.regions[regionId],
      '没有走到「翻回 launcher」那一步——本族判据与被测路径无关了'
    ).toMatchObject({ kind: 'launcher' })
  })

  it('用户被告知了：错误进 store，界面不会一声不响地闪回初始页', async () => {
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    launchThatVanishesDuringResync()

    await useAppStore
      .getState()
      .launchAgent('codex', 'p', 'pane', { tabId: launcher.id, regionId })
      .catch(() => {})

    const error = useAppStore.getState().error
    expect(
      error,
      '启动失败后 error 仍是空的——用户只看到初始页自己闪回来，没有任何解释'
    ).toBeTruthy()
    // 内容判据：那句话必须说清是这个 Session 没了，而不是一句泛泛的「失败」。
    // 只判「非空」的话，把它换成 reportError('') 或任意常量串也会绿。
    expect(String(error).toLowerCase(), `错误文本没有说明原因：${String(error)}`).toMatch(
      /session|会话/
    )
  })

  it('调用方也知道：那个 Promise 被 reject，不是静默 resolve', async () => {
    // 与上一条判的是不同的事：只 reportError 不 throw 时，UI 上有提示了，但 `run()` 的
    // await 会正常返回，调用方（含扇出批量启动）会把这次当成成功继续往下走。
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    launchThatVanishesDuringResync()

    await expect(
      useAppStore.getState().launchAgent('codex', 'p', 'pane', { tabId: launcher.id, regionId })
    ).rejects.toThrow()
  })

  it('草稿留在原处，重试不用重新打一遍', async () => {
    // 这条路与别的失败路径一样沿用同一个 regionId 翻回 launcher，所以草稿的规矩也必须一样。
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    useAppStore.getState().setAgentComposerDraft(regionId, '我打了很久的那段话')
    launchThatVanishesDuringResync()

    await useAppStore
      .getState()
      .launchAgent('codex', '我打了很久的那段话', 'pane', { tabId: launcher.id, regionId })
      .catch(() => {})

    expect(
      useAppStore.getState().agentComposerDrafts[regionId],
      '这条失败路径把草稿清掉了——用户要重新打一遍'
    ).toBe('我打了很久的那段话')
  })

  it('在途台账里那条记录被销掉，不留一个永远 pending 的 session', async () => {
    // 反向边界：翻回 launcher 之后，`pendingAgentLaunches` 里那一条若留着，
    // 迟到的 hook 事件会继续往一个没有归属的 session 上投（#157/#176 那一族的形状）。
    const launcher = launcherFixture()
    const regionId = launcher.layout.activeRegionId
    launchThatVanishesDuringResync()

    await useAppStore
      .getState()
      .launchAgent('codex', 'p', 'pane', { tabId: launcher.id, regionId })
      .catch(() => {})

    expect(
      Object.keys(useAppStore.getState().pendingAgentLaunches),
      '在途台账里留下了一条没有归属的记录'
    ).toEqual([])
  })
})
