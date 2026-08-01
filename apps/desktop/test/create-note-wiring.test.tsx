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
import { createWorkbenchTab, documentKey, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
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

  // -------------------------------------------------------------------------
  // 建的时候在 A、打开的时候已经切到 B。
  //
  // 缺陷原形：createNote 捕获一次 workspaceId，而 `openFile` 签名里没有 workspace 参数、
  // 自己重读 activeWorkspaceId。create walk 是异步的（本地一次子进程、远端 host.run 可达 15s），
  // 这期间侧栏的 selectWorkspace 完全可点——它不受卡片那个组件本地 busy 约束。
  //
  // 于是笔记建在 A，打开的却按 B 解析。而名字只是今天的日期，B 里有同名文件的概率很高，
  // 那时用户在静默地编辑另一个项目里的另一个文件，界面上一切正常。
  // 修法是给 openFile 加显式 workspace 参数，让整条路只解析一次。
  // -------------------------------------------------------------------------
  it('走到一半用户切了 Workspace：绝不按新 Workspace 去打开，也绝不静默无事发生', async () => {
    workspaceFixture()
    // 两个 Workspace 都有 layout：否则 openFile 会在「没有 layout」那一支静默 return，
    // 缺陷会退化成「什么都没发生」，测不出更坏的那一种（真的把 B 的同名文件打开了）。
    useAppStore.setState({
      config: {
        ...config,
        workspaces: [
          ...config.workspaces,
          { id: 'other', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }
        ]
      },
      layouts: {
        workspace: createWorkspaceLayout('pane'),
        other: createWorkspaceLayout('other-pane')
      }
    })
    const stem = noteStemForDate(new Date())
    const name = `${stem}${NOTE_FILE_EXTENSION}`
    // 写入面**真的**建出文件（call through），只是在它 resolve 之前把 activeWorkspaceId
    // 切走——模拟用户在等待期间点了侧栏。必须 call through：读侧的 mock 只按 path 索引，
    // 于是「文件在盘上」这个前提对两个 Workspace 都成立，openFile 会在它自己解析出来的那个
    // Workspace 下真的开出一份文档。这正是缺陷的锋利形态——不是「打不开」，而是**开错了**。
    // 这里刻意不替换 openFile：判据必须落在它真正解析出来的 Workspace 上，
    // 而不是一个只会回显 activeWorkspaceId 的桩（那测的是桩，不是产品）。
    const realCreate = api.files.create
    const created: Array<string | undefined> = []
    vi.spyOn(api.files, 'create').mockImplementation(async (workspaceId, input) => {
      created.push(workspaceId)
      await realCreate(workspaceId, input)
      useAppStore.setState({ activeWorkspaceId: 'other' })
    })

    const outcome = await useAppStore.getState().createNote().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )

    // 前提自检：文件确实是建在 workspace 而不是 other 上的，否则下面判的不是这个缺陷。
    expect(created).toEqual(['workspace'])
    const documents = useAppStore.getState().documents
    // 承重：**绝不能**在 other 里开出一份文档——那是另一个项目里的同名文件，
    // 用户会以为自己在编辑刚建的笔记，而界面上一切正常。
    expect(documents[documentKey('other', name)]).toBeUndefined()
    if (outcome.ok) {
      // 报成功就必须真的把建出来的那一份打开了。
      expect(outcome.value).toBe(name)
      expect(documents[documentKey('workspace', name)]).toBeDefined()
    } else {
      // 也可以选择不打开，但那必须响亮失败并说清笔记在哪，不能静默什么都没发生。
      expect(String(outcome.error)).toMatch(new RegExp(stem))
    }
  })

  // 第二条笔记：`before + 1` 的 fixture 永远从 0 起步，所以把这个自增写成常量 `1`
  // 与正确实现在第一条笔记上完全无法区分。真实症状出在**第二**条——计数不前进，
  // 文件树的失效键不变，新笔记要等到别的写入面碰巧 bump 才会出现在树里。
  it('连着建两条笔记，失效计数每次都前进（不是恒等于 1）', async () => {
    workspaceFixture()
    vi.spyOn(api.files, 'create').mockResolvedValue(undefined)
    useAppStore.setState({ openFile: (async () => {}) as never })

    await useAppStore.getState().createNote()
    const afterFirst = useAppStore.getState().workspaceFileRevisions.workspace
    await useAppStore.getState().createNote()
    const afterSecond = useAppStore.getState().workspaceFileRevisions.workspace

    expect(afterSecond).toBe((afterFirst ?? 0) + 1)
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
  //
  // 判据必须数**产出那个属性的每一种写法**，不能只数符号名：实测在不可见的热终端分支里用字面量
  // `data-agentmux-action="create-note"` 抄一张重复卡片，符号计数不变、markup 也看不见，
  // 于是这条守卫恰好对它要防的那个缺陷失明。
  it('源码里 create-note 与 open-browser 各只有一处，任何写法都算', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
      'utf8'
    )
    // 自检：这个文件确实在渲染动作属性。没有它，「每个动作只出现一次」在一个**根本不写这个属性**
    // 的文件上也成立（0≠1 会红，但读到的原因是错的）。判属性名而不是某个具体 key 的符号：
    // key 改名由下面的逐个计数负责，属性名消失才是「判据挂在了空处」。
    // 不用 toContain 数具体符号是刻意的——那条会被下面的 toBe(1) 完全蕴含，是死断言。
    expect(source).toContain(DESKTOP_ACTION_ATTRIBUTE)
    const occurrencesOf = (key: string, value: string): number =>
      // 三种能产出这个属性的写法：符号引用、动作 id 字面量、以及 selector 辅助函数。
      // 数出现总次数而不是逐种数——一张重复卡片无论用哪种写法，总数都会变成 2。
      [`DESKTOP_ACTIONS.${key}`, `"${value}"`, `'${value}'`, `desktopActionSelector('${key}')`]
        .reduce((total, spelling) => total + source.split(spelling).length - 1, 0)

    for (const [key, value] of Object.entries(DESKTOP_ACTIONS)) {
      // 终端是**唯一**刻意分支的那一件：热终端在场时它带实时预览独占一行，不在场时退化成 grid
      // 里的一张卡，两种形态差别太大没法合成一个。所以它出现两次是设计，其余每一个都必须只有一次。
      const expected = key === 'claimReusableTerminal' ? 2 : 1
      expect(occurrencesOf(key, value), `${key} 应出现 ${expected} 次`).toBe(expected)
    }
    // 前提自检：上面那个例外不是随手放宽的——终端确实是两条形态各写一次，
    // 而这两条都在同一个三元里。若哪天终端也收成一张卡，这条会红，届时例外就该删掉。
    expect(source).toContain('launch-terminal__fallback')
  })

  // 上一条数的是「卡片没被抄两份」。这一条数的是**承载它们的容器**没被抄两份——
  // 卡片只写一次的前提是 quick-grid 本身无条件存在；一旦 grid 又被分成两份，
  // 卡片就必须跟着分身，于是上一条会红、但红在一个让人误以为是「多写了一张卡」的位置上。
  // 把这个前提单独钉住，坏掉时读到的就是真正的原因。
  it('quick-grid 与它外层的 stack 各只有一个，卡片不必跟着分支分身', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
      'utf8'
    )
    expect(source.split('className="launch-surfaces-stack"')).toHaveLength(2)
    expect(source.split('className="launch-surface-quick-grid"')).toHaveLength(2)
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
