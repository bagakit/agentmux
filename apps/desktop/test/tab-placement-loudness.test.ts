import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import { api } from '../src/renderer/src/lib/api.js'
import {
  addTab,
  addTabOrThrow,
  addTabPlacement,
  createWorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout.js'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 落点不在场时不许留孤儿 Tab（#307）。
//
// `addTab` 挂不上就原样返回 layout。作为纯 reducer 这没错，但三个启动落点当时都是
// `launcher ? layout : addTab(layout, tabGroupId, tabId)`：Tab 记录先写进 `state.tabs`，
// 这个返回值再写回 `state.layouts`，于是那条 Tab 进了 tabs 而**不在任何分组的 tabOrder 里**。
// 实测（launchAgent / createBrowser，`tabGroupId` 指向一个不存在的分组、无 launcher 归属）：
//   抛出的是 `null`，`state.tabs` 多出一条记录，`groups[0].tabOrder` 为空 —— 一个永不显示、
//   永不可关的孤儿，用户点了按钮什么反馈都没有。整套测试当时零红。
//
// 判据取**后置条件**「调用之后这条 Tab 必须属于某个分组」，不取 `next === layout` 的身份比较：
// 后者认不出「Tab 已在别处、activateTab 恰好返回同一个对象」这种正常情形。
//
// 这个文件守三层，缺一层就有一族回归无人守：
//   1. 纯函数层：addTabPlacement / addTabOrThrow 自己的取值（挂上 / 挂不上两侧）
//   2. 接线层：三个落点真的走那条判定 —— 行为断言，看孤儿数与是否抛
//   3. 结构层：`state.layouts` 的写入点不再直接用裸 `addTab`
// ---------------------------------------------------------------------------

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

const workspace: WorkspaceRecord = {
  id: 'workspace', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder'
}

function prepare(): void {
  const config: AppConfig = {
    version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {
      codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
    },
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }
  useAppStore.setState({
    config,
    sessions: [],
    timelines: {},
    activeWorkspaceId: workspace.id,
    tabs: {},
    layouts: { [workspace.id]: createWorkspaceLayout('pane') },
    warmTerminal: null,
    unclaimedTerminalSessionIds: [],
    error: null
  })
}

/** tabs 里有、却不在任何分组 tabOrder 里的 Tab —— 这就是这个 feature 要根除的东西。 */
function orphanTabIds(): string[] {
  const state = useAppStore.getState()
  const layout = state.layouts[workspace.id]
  if (!layout) throw new Error('fixture 里没有 layout，判据落空')
  return Object.keys(state.tabs).filter(
    (tabId) => !layout.groups.some((group) => group.tabOrder.includes(tabId))
  )
}

function terminalSession(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    executorId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', terminalSessionId: id }
  }
}

describe('addTabPlacement / addTabOrThrow', () => {
  it('落点在场时与 addTab 完全一致', () => {
    const layout = createWorkspaceLayout('pane')
    const expected = addTab(layout, 'pane', 'tab-1')
    expect(addTabPlacement(layout, 'pane', 'tab-1')).toEqual(expected)
    expect(addTabOrThrow(layout, 'pane', 'tab-1')).toEqual(expected)
    // 挂上的定义就是「属于某个分组」，不是「对象换了个新的」。
    expect(expected.groups[0]?.tabOrder).toContain('tab-1')
  })

  it('落点不在场时交回 null / 抛，绝不返回一个没挂上的 layout', () => {
    const layout = createWorkspaceLayout('pane')
    expect(addTabPlacement(layout, 'no-such-group', 'tab-1')).toBeNull()
    expect(() => addTabOrThrow(layout, 'no-such-group', 'tab-1')).toThrow(/Tab Group/)
    // 对照：裸 addTab 在这里静默返回原 layout —— 这正是三个落点当时留下孤儿的原因。
    expect(addTab(layout, 'no-such-group', 'tab-1')).toBe(layout)
  })

  it('Tab 已在别的分组时算挂上了——身份比较会把这条判错', () => {
    // `activateTab` 对「已经是活动 Tab」可以返回同一个对象引用。若判据写成 `next === layout`
    // 就抛，这条正常路径会变成响亮失败。所以判据必须是后置条件而不是身份。
    const seeded = addTab(createWorkspaceLayout('pane'), 'pane', 'tab-1')
    const next = addTabPlacement(seeded, 'other-group', 'tab-1')
    expect(next).not.toBeNull()
    expect(next!.groups.find((group) => group.tabOrder.includes('tab-1'))?.id).toBe('pane')
  })
})

describe('启动落点不在场时响亮失败，不留孤儿 Tab', () => {
  it('launchAgent', async () => {
    prepare()
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    await expect(
      useAppStore.getState().launchAgent('codex', 'go', 'no-such-group', undefined)
    ).rejects.toThrow(/Tab Group/)
    expect(orphanTabIds(), 'launchAgent 留下了永不显示的孤儿 Tab').toEqual([])
    // 落点判定要排在真正启动之前：否则 agent 已经跑起来了却无处安放。
    expect(launch, '落点不在场却已经把 agent 启动了').not.toHaveBeenCalled()
  })

  it('createBrowser', async () => {
    prepare()
    const create = vi.spyOn(api.browser, 'create')
    await expect(
      useAppStore.getState().createBrowser('no-such-group', undefined)
    ).rejects.toThrow(/Tab Group/)
    expect(orphanTabIds(), 'createBrowser 留下了永不显示的孤儿 Tab').toEqual([])
    expect(create, '落点不在场却已经建了 BrowserView').not.toHaveBeenCalled()
  })

  it('promoteWarmTerminal：抛之外还要把已取出的 PTY 停掉', async () => {
    prepare()
    const session = terminalSession('warm-1')
    // 泊车的那个 shell 已经起好了。promoteWarmTerminal 会先把它从全局单槽里取出（消费掉），
    // 所以落点不在场时它没有别的归宿——必须停掉，否则那个进程泄漏且用户永远看不到它。
    useAppStore.setState({
      warmTerminal: { key: warmTerminalKey('local', '/repo'), ready: Promise.resolve(session), session },
      unclaimedTerminalSessionIds: [session.id],
      sessions: [session]
    })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)

    await expect(
      useAppStore.getState().promoteWarmTerminal('no-such-group', undefined)
    ).rejects.toThrow(/Tab Group/)

    expect(orphanTabIds(), 'promoteWarmTerminal 留下了永不显示的孤儿 Tab').toEqual([])
    expect(stop, '落点不在场时泊车的 PTY 没被停掉——进程泄漏').toHaveBeenCalledWith(session.control)
    expect(
      useAppStore.getState().unclaimedTerminalSessionIds,
      '停掉了却还记在未认领清单里'
    ).not.toContain(session.id)
  })
})

describe('同步动作：不抛，但要把失败摆到界面上', () => {
  // selectSession / openLauncher 是 `void` 动作，调用方是 onClick——抛出只会变成未捕获异常，
  // 用户什么也看不到。所以这两条走 reportError；判据是「state.error 非空 且 没有孤儿」，
  // 缺任何一半都是缺陷：静默回落（旧行为）两条都不满足，而「抛了但留了孤儿」满足前一半。
  it('openLauncher', () => {
    prepare()
    useAppStore.getState().openLauncher('no-such-group')
    expect(orphanTabIds(), 'openLauncher 留下了永不显示的孤儿 Tab').toEqual([])
    expect(useAppStore.getState().error, '落点不在场却一句话都不说').toMatch(/Tab Group/)
  })

  it('selectSession', () => {
    prepare()
    const session = terminalSession('attach-1')
    useAppStore.setState({ sessions: [session] })
    useAppStore.getState().selectSession(session.id, 'no-such-group')
    expect(orphanTabIds(), 'selectSession 留下了永不显示的孤儿 Tab').toEqual([])
    expect(useAppStore.getState().error, '落点不在场却一句话都不说').toMatch(/Tab Group/)
  })
})

describe('Scratch Topic 的落点', () => {
  // Scratch 两条路径挂的是 `layout.activeGroupId`，所以要让落点缺席，得让 activeGroupId
  // 指向一个不在 `groups` 里的分组——这正是分屏关掉一半之后 layout 可能短暂处于的形状。
  function prepareScratch(): void {
    const scratch: WorkspaceRecord = {
      id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder'
    }
    const base = createWorkspaceLayout('pane')
    useAppStore.setState({
      config: {
        version: 9,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {},
        workspaces: [scratch],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
      },
      sessions: [],
      activeWorkspaceId: scratch.id,
      tabs: {},
      layouts: { [scratch.id]: { ...base, activeGroupId: 'no-such-group' } },
      error: null
    })
  }

  function scratchOrphans(): string[] {
    const state = useAppStore.getState()
    const layout = state.layouts[SCRATCH_WORKSPACE_ID]
    if (!layout) throw new Error('fixture 里没有 Scratch layout，判据落空')
    return Object.keys(state.tabs).filter(
      (tabId) => !layout.groups.some((group) => group.tabOrder.includes(tabId))
    )
  }

  it('createScratchTopic', async () => {
    prepareScratch()
    vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({
      workspaceId: SCRATCH_WORKSPACE_ID, topicId: 't', title: 'Untitled', updatedAt: 1
    } as never)
    await expect(useAppStore.getState().createScratchTopic()).rejects.toThrow(/Tab Group/)
    expect(scratchOrphans(), 'createScratchTopic 留下了永不显示的孤儿 Tab').toEqual([])
  })

  it('openScratchTopic', async () => {
    prepareScratch()
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({
      workspaceId: SCRATCH_WORKSPACE_ID, topicId: 't', title: 'Untitled', updatedAt: 1
    } as never)
    await expect(useAppStore.getState().openScratchTopic('t')).rejects.toThrow(/Tab Group/)
    expect(scratchOrphans(), 'openScratchTopic 留下了永不显示的孤儿 Tab').toEqual([])
  })
})

describe('结构层：写 state.layouts 的地方不许用裸 addTab', () => {
  // 上面那组是行为断言，只覆盖「三个落点」这三条今天在场的路径。但这条不变量是全局的：
  // 任何往 `state.layouts` 写 `addTab(...)` 返回值的新代码都会重新引入孤儿 Tab，而它自己那条
  // 路径没人为它写行为测试。所以再钉一层结构判据。
  //
  // 豁免：`addTabPlacement` 自己就要调 addTab（它是那条判定的落点），`insertTabAfter` 之类
  // reducer 内部的组合也在 workbench-layout.ts 里 —— 那个文件整体豁免，因为它是纯 reducer 层，
  // 不接触 `state.tabs`，产不出孤儿。判据只管 store 这一侧。
  it('store.ts 里 addTab 的调用点为零', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL('../src/renderer/src/store.ts', import.meta.url),
      'utf8'
    )
    const ts = (await import('typescript')).default
    const ast = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true)

    const calls: { name: string; line: number }[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text
        if (name === 'addTab' || name === 'addTabPlacement' || name === 'addTabOrThrow') {
          calls.push({ name, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    // 前提自检：判据认得出这一族调用。数成 0 就是遍历坏了，主断言会静默通过。
    expect(calls.length, '一个 addTab* 调用都没找到——判据失效，主断言恒绿')
      .toBeGreaterThanOrEqual(4)

    const bare = calls.filter((call) => call.name === 'addTab')
    expect(bare, [
      `store.ts 里还有 ${bare.length} 处裸 \`addTab(\` 调用（行号：${bare.map((c) => c.line).join(', ')}）。`,
      'addTab 挂不上时静默返回原 layout；store 把 Tab 记录写进 state.tabs 再写回这个 layout，',
      '那条 Tab 就成了不在任何 tabOrder 里的孤儿——永不显示、永不可关，且零报错。',
      '改用 addTabOrThrow（挂不上即抛）或 addTabPlacement（要自己做清理时取 null 判断）。'
    ].join('\n')).toEqual([])
  })
})
