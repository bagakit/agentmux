import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

// NewTabSurface 会拉进 TerminalView → xterm addon（模块加载期就要 `self`）。本测试关心的是
// 笔记入口在不在、store 接线对不对，终端渲染不在范围内；与本仓其他组件测试同一处理。
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { DESKTOP_ACTIONS, DESKTOP_ACTION_ATTRIBUTE } from '../src/shared/desktop-actions.js'
import { api } from '../src/renderer/src/lib/api.js'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { noteStemForDate, NOTE_FILE_EXTENSION } from '../src/renderer/src/lib/note-names.js'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function workspaceFixture(): void {
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
    documents: {},
    workspaceFileRevisions: {},
    error: null
  })
}

function warmShellSession(): SessionSnapshot {
  return {
    id: 'warm-shell',
    kind: 'terminal',
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Shell',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', terminalSessionId: 'warm-shell' }
  } as SessionSnapshot
}

/**
 * 本仓的组件测试是 `renderToStaticMarkup`，而 zustand 的 `useStore` 把
 * `selector(api.getInitialState())` 当作 server snapshot（见 zustand/react.js）。
 * server 渲染走的正是那一支，因此**测试事先 setState 的内容对 markup 完全不可见**。
 *
 * 这一条不测产品行为，它测的是上面那句话仍然成立——一旦哪天换了 harness（真 DOM、
 * 或 zustand 改了 server snapshot），它会红，届时「初始页上的笔记入口」那一组就可以
 * 改回按分支渲染，源码文本判据也就不再必要了。
 */
function assertStoreStateInvisibleToStaticMarkup(): void {
  workspaceFixture()
  useAppStore.setState({
    warmTerminal: {
      key: warmTerminalKey('local', '/repo'),
      ready: Promise.resolve(null),
      session: warmShellSession()
    } as never
  })
  const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'pane' }))
  // store 里三个条件齐全，热终端那条分支却渲染不出来——这正是 harness 的盲点。
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(markup).not.toContain('launch-terminal__head')
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// 用户诉求：「创建笔记那个功能挺好的, 可以实现这个功能, 加到初始页上面去」。
//
// 命名判定本身在 note-names.test.ts 里测过了（那 12 条守的是「撞名绝不覆盖」）。
// 这一层只回答两个**接线**问题——本仓栽过的正是这一族：判定写对、纯函数测试全绿，
// 但没人调它，或者调了却没人能点到。
//   1. store 的 createNote 真的走那条候选序列，且**打开的是实际建出来的那个名字**；
//   2. 初始页上真有那个入口，两条分支（有热终端 / 兜底）都有。
// ---------------------------------------------------------------------------
describe('createNote 接线', () => {
  it('把候选名喂给真正的写入面，撞名就往后走，并打开实际建出来的那一个', async () => {
    workspaceFixture()
    const stem = noteStemForDate(new Date())
    const taken = `${stem}${NOTE_FILE_EXTENSION}`
    const attempted: string[] = []
    // 模拟磁盘上已经有今天的第一条笔记：写入面是 O_EXCL，撞名**失败**而不是截断。
    const create = vi.spyOn(api.files, 'create').mockImplementation(async (_workspaceId, input) => {
      attempted.push(input.path)
      if (input.path === taken) throw new Error('EEXIST: file already exists')
    })
    const opened: string[] = []
    // openFile 自己有一整套读文件/挂 Tab 的路，这里只关心它被喂了哪个名字。
    const openFile = vi.fn(async (path: string) => { opened.push(path) })
    useAppStore.setState({ openFile: openFile as never })

    const name = await useAppStore.getState().createNote()

    // 承重：撞名后返回并打开的是 -2 那个，不是算出来的第一个。整条路只解析一次 workspace，
    // 所以 create 与 open 必然落在同一个 Workspace 上。
    expect(name).toBe(`${stem}-2${NOTE_FILE_EXTENSION}`)
    expect(attempted).toEqual([taken, `${stem}-2${NOTE_FILE_EXTENSION}`])
    expect(opened).toEqual([`${stem}-2${NOTE_FILE_EXTENSION}`])
    expect(create.mock.calls.every(([workspaceId]) => workspaceId === 'workspace')).toBe(true)
    // 建的是文件不是目录——kind 传错的话笔记会变成一个打不开的空目录。
    expect(create.mock.calls.map(([, input]) => input.kind)).toEqual(['file', 'file'])
  })

  it('让文件树看见新文件：写入后 workspace 的失效计数前进', async () => {
    workspaceFixture()
    vi.spyOn(api.files, 'create').mockResolvedValue(undefined)
    useAppStore.setState({ openFile: (async () => {}) as never })
    const before = useAppStore.getState().workspaceFileRevisions.workspace ?? 0

    await useAppStore.getState().createNote()

    expect(useAppStore.getState().workspaceFileRevisions.workspace).toBe(before + 1)
  })

  it('没有活动 Workspace 时响亮失败，绝不静默无事发生', async () => {
    useAppStore.setState({ config, activeWorkspaceId: null })
    const create = vi.spyOn(api.files, 'create').mockResolvedValue(undefined)

    await expect(useAppStore.getState().createNote()).rejects.toThrow(/workspace/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('候选全部失败时把真实原因抛给调用方，而不是当成建好了', async () => {
    workspaceFixture()
    vi.spyOn(api.files, 'create').mockRejectedValue(new Error('EACCES: permission denied'))
    const openFile = vi.fn(async () => {})
    useAppStore.setState({ openFile: openFile as never })

    await expect(useAppStore.getState().createNote()).rejects.toThrow(/EACCES/)
    // 没建出来就绝不能去打开一个不存在的文件——那会给用户一个「不可用」的空编辑器。
    expect(openFile).not.toHaveBeenCalled()
  })
})

describe('初始页上的笔记入口', () => {
  const noteAction = `${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.createNote}"`

  it('初始页渲染出带 create-note 动作标记的按钮', () => {
    workspaceFixture()
    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'pane' }))
    expect(markup).toContain(noteAction)
    expect(markup).toContain('Create note')
  })

  it('入口只有一处：整份 markup 里 create-note 恰好出现一次', () => {
    workspaceFixture()
    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'pane' }))
    expect(markup.split(noteAction)).toHaveLength(2)
  })

  // 这一条守的是「入口不在任何分支里」，而**不能**用渲染两条分支来守——原因是本仓一族假绿的根：
  // zustand 的 useStore 把 `selector(api.getInitialState())` 当 server snapshot（见
  // node_modules zustand/react.js），renderToStaticMarkup 走的正是那一支，所以测试事先
  // setState 的一切对 markup 完全不可见，任何以 store 取值为条件的分支在这个 harness 里都不可达。
  // 实测：store 里 activeWorkspaceId='workspace'、config 在场，渲染出来的却是「No host」。
  // 第一版就栽在这里——两个用例其实渲染的是同一条兜底分支，把热终端分支里的笔记卡删掉 7 条全绿。
  // 于是改成消除分岔本身：入口在 quick-grid 里只写一次、在任何三元之外。判据落在源码上是刻意的——
  // 「有没有被抄成两份」本身就是一个文本性质，渲染只能看见其中一条分支所以看不出抄没抄。
  it('源码里 create-note 与 open-browser 各只有一处，没有被分支抄成两份', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
      'utf8'
    )
    // 自检：断言的目标确实在这个文件里，别让改名把下面两条变成恒真。
    expect(source).toContain('DESKTOP_ACTIONS.createNote')
    expect(source.split('DESKTOP_ACTIONS.createNote')).toHaveLength(2)
    expect(source.split('DESKTOP_ACTIONS.openBrowser')).toHaveLength(2)
  })

  it('笔记入口与浏览器入口是两个不同的动作标记', () => {
    // 同一个 id 会让两张卡在自动化与埋点里彼此不可分，且复制粘贴时最容易出这个错。
    expect(DESKTOP_ACTIONS.createNote).not.toBe(DESKTOP_ACTIONS.openBrowser)
    expect(DESKTOP_ACTIONS.createNote).not.toBe(DESKTOP_ACTIONS.claimReusableTerminal)
  })

  it('前提自检：这个 harness 看不见 store 取值，所以上一条只能判源码', () => {
    assertStoreStateInvisibleToStaticMarkup()
  })
})
