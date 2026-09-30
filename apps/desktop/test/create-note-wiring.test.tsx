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
import { createWorkspaceLayout, findGroupForTab, moveTabToNewGroup } from '@agentmux/layout'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { noteStemForDate, NOTE_FILE_EXTENSION } from '../src/renderer/src/lib/note-names.js'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
    control: { kind: 'terminal', hostId: 'local', runId: 'warm-shell', run: { runId: 'warm-shell' } }
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
      // 归属必须真的落在这个挂载点上（`{ tabGroupId: 'pane' }` 没有 regionId，故 warmLauncherId
      // 算出 `group:pane`）。若这里给个不匹配的归属，下面那条 `not.toContain` 会因为「槽不归它」
      // 而通过，于是这条测试就不再证明 harness 的盲点了——它会为了错的理由恒绿。
      ownerLauncherId: 'group:pane',
      ready: Promise.resolve(null),
      session: warmShellSession()
    } as never
  })
  const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'pane' }))
  // store 里几个条件齐全（含归属），热终端那条分支却渲染不出来——这正是 harness 的盲点。
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(markup).not.toContain('launch-terminal__head')
}

afterEach(() => {
  vi.restoreAllMocks()
  useLauncherState.setState({drafts:{}})
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
  it('使用真实typed写入候选，并保已创建文件与准确分组', async () => {
    workspaceFixture()
    const paths: string[] = []
    const write = vi.spyOn(api.files, 'write').mockImplementation(async (_workspaceId, input) => {
      paths.push(input.path)
      return paths.length === 1 ? {status:'conflict', observedRevision:'occupied'} : {status:'written',revision:'created'}
    })
    const open = vi.fn(async () => true)
    useAppStore.setState({openFile:open})
    const receipt = await useAppStore.getState().createNote('pane')
    expect(receipt.status).toBe('written'); expect(receipt.revealed).toBe(true)
    expect(paths).toEqual([`${noteStemForDate(new Date())}${NOTE_FILE_EXTENSION}`, `${noteStemForDate(new Date())}-2${NOTE_FILE_EXTENSION}`])
    expect(write.mock.calls.map(([workspaceId])=>workspaceId)).toEqual(['workspace','workspace'])
    expect(open).toHaveBeenCalledWith(receipt.path,'pane',undefined,'workspace',undefined,expect.objectContaining({displayWorkspaceId:'workspace'}))
    expect(useAppStore.getState().workspaceFileRevisions.workspace).toBe(1)
  })
  it('没有资源Workspace就不发写入', async () => {
    useAppStore.setState({config,activeWorkspaceId:null})
    const write=vi.spyOn(api.files,'write')
    await expect(useAppStore.getState().createNote()).rejects.toThrow(/workspace/i)
    expect(write).not.toHaveBeenCalled()
  })
  it('保真实permission code，不把失败当成已创建', async () => {
    workspaceFixture()
    const write=vi.spyOn(api.files,'write').mockResolvedValue({status:'error',code:'EACCES',message:'permission denied'})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('pane',undefined,'draft')
    expect(receipt.status).toBe('error'); expect(receipt.draft).toBe('draft')
    expect(write).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled()
  })
  it('launcher绑定A且活动Workspace是B，正文仍写A的Files owner', async () => {
    workspaceFixture()
    useAppStore.setState({config:{...config,workspaces:[...config.workspaces,{id:'b',name:'B',hostId:'local',path:'/b',kind:'folder'}]},activeWorkspaceId:'b',layouts:{...useAppStore.getState().layouts,b:createWorkspaceLayout('other')}})
    const write=vi.spyOn(api.files,'write').mockResolvedValue({status:'written',revision:'created'})
    useAppStore.setState({openFile:vi.fn(async()=>true)})
    const receipt=await useAppStore.getState().createNote('pane',{tabId:'launcher-tab',regionId:initialWorkbenchRegionId('launcher-tab')})
    expect(receipt.target.workspaceId).toBe('workspace');expect(write.mock.calls.map(([workspaceId])=>workspaceId)).toEqual(['workspace'])
  })
  it('每个新意图各增加原失效计数，普通Markdown不参与迁移', async () => {
    workspaceFixture();vi.spyOn(api.files,'write').mockResolvedValue({status:'written',revision:'created'});useAppStore.setState({openFile:vi.fn(async()=>true)})
    const first=await useAppStore.getState().createNote('pane'), second=await useAppStore.getState().createNote('pane')
    expect(first.noteId).not.toBe(second.noteId);expect(useAppStore.getState().workspaceFileRevisions.workspace).toBe(2)
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
      new URL('../src/renderer/src/components/LauncherSecondarySurfaces.tsx', import.meta.url),
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
      const expected = 1
      expect(occurrencesOf(key, value), `${key} 应出现 ${expected} 次`).toBe(expected)
    }
    // 前提自检：上面那个例外不是随手放宽的——终端确实是两条形态各写一次，
    // 而这两条都在同一个三元里。若哪天终端也收成一张卡，这条会红，届时例外就该删掉。
    expect(source).toContain('function header(kind: UtilityKind)')
  })

  // 上一条数的是「卡片没被抄两份」。这一条数的是**承载它们的容器**没被抄两份——
  // 卡片只写一次的前提是 quick-grid 本身无条件存在；一旦 grid 又被分成两份，
  // 卡片就必须跟着分身，于是上一条会红、但红在一个让人误以为是「多写了一张卡」的位置上。
  // 把这个前提单独钉住，坏掉时读到的就是真正的原因。
  it('quick-grid 与它外层的 stack 各只有一个，卡片不必跟着分支分身', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/LauncherSecondarySurfaces.tsx', import.meta.url),
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

// ---------------------------------------------------------------------------
// 「这个 launcher 面向哪个 Workspace」必须只有一处实现。
//
// 上面那两条钉的是 createNote **今天**落对了。这一条钉的是第七个启动动作不能再手抄一遍——
// 原缺陷正是这么来的：五个动作各写一遍，四个一致、第五个漏掉了 launcher 那一侧。
// 行为测试对「新加的第七个动作」天然失明（它还不存在），所以这一层判源码是刻意的。
// ---------------------------------------------------------------------------
describe('launcher Workspace 判定只有一处', () => {
  const sources = ['store.ts', 'components/NewTabSurface.tsx'] as const
  const readSource = (relative: string): string =>
    readFileSync(new URL(`../src/renderer/src/${relative}`, import.meta.url), 'utf8')

  /**
   * 每个收 `launcher` 形参的 store action，函数体里必须恰好调一次 `resolveLauncherWorkspaceId`。
   *
   * 这是这一族的**主判据**。下面那条数拼法的是补充，它单独**挡不住原缺陷**：实测原 createNote
   * 的逐字形状（`const workspaceId = get().activeWorkspaceId`，见 cc0e62e^ store.ts:3100）在那
   * 三条正则上是 0 命中——因为那句话里既没有 `??` 也没有 `launcherTab`。同一条正则也漏掉「把
   * 局部变量改名再手抄一遍」（`boundTab?.workspaceId ?? active`）。
   *
   * 方向错了才会那样：数拼法问的是「有没有人手抄这条规则」，要枚举无穷种写法；而缺陷问的是
   * 「有没有人**不走**那个唯一实现」，只要枚举那几个动作——它们有一个可枚举的共同标记，就是
   * 形参表里的 `launcher`。收了它却不调那个实现，就是又自己判了一次。
   *
   * 「恰好一次」两侧都承重：0 次是漏掉 launcher 那一侧（原缺陷），2 次以上是同一个动作里判了
   * 两遍（本仓 two-resolutions-that-happen-to-agree 那一族）。
   */
  it('每个收 launcher 的 store action 都必须调 resolveLauncherWorkspaceId', () => {
    const source = readSource('store.ts')
    const lines = source.split('\n')
    // 形参表里带 `launcher` 的 async action 声明。判形参而不是判名字：第七个动作叫什么都逃不掉。
    const declarations = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^ {2}async \w+\([^)]*\blauncher\b/.test(line))

    // 前提自检：这个正则必须真的抓到今天那五个。抓到 0 个（或漏掉某个）时下面的循环恒绿——
    // 正是这一条要防的形状。
    //
    // 判「至少覆盖这五个」而不是「恰好是这五个」：后者会把第七个动作先撞在这条白名单上，红出来
    // 的原因就变成「清单该更新了」，而真正的原因是「你收了 launcher 却没调那个实现」。判据的红
    // 必须指向缺陷本身，所以在场性归这一条，是否调用全部交给下面的循环。
    const names = declarations.map(({ line }) => line.trim().match(/async (\w+)/)![1]!)
    expect(
      names.filter((name) => [
        'createBrowser', 'createNote', 'launchAgent', 'launchTerminal', 'promoteWarmTerminal'
      ].includes(name)).sort(),
      '收 launcher 形参的 action 没有全被抓到，判据对漏掉的那些失效'
    ).toEqual(['createBrowser', 'createNote', 'launchAgent', 'launchTerminal', 'promoteWarmTerminal'])

    for (const { line, index } of declarations) {
      const name = line.trim().match(/async (\w+)/)![1]
      // 函数体到下一个同缩进的 `},` 为止。store 的 action 全是两空格缩进的对象方法。
      let end = lines.length
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (/^ {2}\},?$/.test(lines[cursor]!)) { end = cursor; break }
      }
      const body = lines.slice(index, end).join('\n')
      expect(
        body.match(/resolveLauncherWorkspaceId\(/g) ?? [],
        `${name} 收了 launcher 却没有恰好一次走 resolveLauncherWorkspaceId——它在自己判 Workspace 归属`
      ).toHaveLength(1)
    }
  })

  it('补充判据：也没有地方重新手抄 `?? activeWorkspaceId` 这条规则', () => {
    // 只是补充。它数的是符号，因此对上一条注释里那两种形状失明（已实测）；留着是因为它能抓到
    // 「走了那个实现、又在别处顺手多判一次」这类不在 action 体内的手抄。
    const spellings = [
      /\?\?\s*(?:state\.|get\(\)\.|current\.)?activeWorkspaceId/g,
      /launcherTab\?\.workspaceId/g,
      /tabWorkspaceId\s*\?\?/g
    ]
    // 唯一合法的出现位置是 resolveLauncherWorkspaceId 的**实参**（`launcherTabWorkspaceId:
    // launcherTab?.workspaceId`），那种写法带着字段名。
    //
    // openFile 的 `requestedWorkspaceId ?? activeWorkspaceId` 是**另一条**规则：它消费调用方
    // 上游已经解析好的那一个，不重新推导 launcher 归属。它必须是例外，但例外不能只是白名单
    // 一行文本——那样第七个动作把变量命名成 requestedWorkspaceId 就绕过了。所以例外自带前提：
    // 那个名字必须真的是 openFile 声明里的**形参**（下一条测试钉住这一点）。
    const allowed = (line: string): boolean =>
      line.includes('launcherTabWorkspaceId')
      || line.includes('activeWorkspaceId:')
      || line.includes('requestedWorkspaceId ??')
    for (const relative of sources) {
      const source = readSource(relative)
      for (const pattern of spellings) {
        for (const hit of source.match(pattern) ?? []) {
          const line = source.split('\n').find((candidate) => candidate.includes(hit))!
          expect(
            allowed(line),
            `${relative} 里这一行自己判了一次 launcher Workspace，应该走 resolveLauncherWorkspaceId：\n${line.trim()}`
          ).toBe(true)
        }
      }
    }
  })

  it('前提自检：那个例外名字处处都是声明出来的形参，不是随手取的变量', () => {
    // 没有这一条，`requestedWorkspaceId ??` 就是一句可以被任何人借用的免检咒语。
    const source = readSource('store.ts')
    const lines = source.split('\n')

    // 原来这条钉的是「`requestedWorkspaceId` 在全文出现恰好 2 次」，前提是只有 openFile 一个动作
    // 收这个形参。后来 openFileDiff 与 openScratchTopic 也收了同一个上游解析结果，次数变成 6，
    // 于是它红了——红的是「计数假设只有一个」，不是被判的性质。按性质重写：**每一处读取都必须
    // 待在一个把它声明为形参的 action 里**。这样第七个动作把局部变量命名成 requestedWorkspaceId
    // 来蹭上面那条例外时，这里当场红，而合法地多一个收参的 action 不会。
    const declaresParam = (line: string): boolean => /^ {2}async \w+\([^)]*\brequestedWorkspaceId\b/.test(line)

    const reads = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\brequestedWorkspaceId\s*\?\?/.test(line))
    // 自检：真的扫到了读取点。一个都没有时下面的循环是空转，`for` of 空集合什么都不证明。
    expect(reads.length, '一处 `requestedWorkspaceId ??` 都没扫到——这条自检在空转').toBeGreaterThan(0)

    for (const { line, index } of reads) {
      // 往回找最近的一个 action 签名。不用 `findLast`——本仓的 `lib` 低于 es2023，它在 tsc 下不存在。
      const owner = lines.slice(0, index).reverse().find((candidate) => /^ {2}async \w+\(/.test(candidate))
      expect(
        owner !== undefined && declaresParam(owner),
        `这一行借用了 requestedWorkspaceId 这个例外，但它所在的 action 并没有把它声明为形参：\n${line.trim()}\n所属签名：${owner?.trim() ?? '（找不到）'}`
      ).toBe(true)
    }

    // 反面：这个名字不许被任何人**造**出来。上面按「所属 action 的签名」判归属，而
    // `const requestedWorkspaceId = …` 会让一个自造的值住进一个恰好收了同名形参的 action 里，
    // 从签名那侧看不出来。
    expect(source).not.toMatch(/\b(?:const|let|var)\s+requestedWorkspaceId\b/)
  })


  it('前提自检：这条规则的两个消费面都真的 import 了那个唯一实现', () => {
    // 没有这一条，上面那条在一个**根本不关心 Workspace** 的文件上也恒绿（0 处手抄）。
    // 判 import 关系而不是「函数名出现过」：裸标识符能绕过 toContain（记忆
    // guard-criterion-must-be-import-relation）。
    for (const relative of sources) {
      expect(readSource(relative)).toMatch(
        /import \{[^}]*resolveLauncherWorkspaceId[^}]*\} from '(?:\.\/lib|\.\.\/lib)\/launcher-workspace'/
      )
    }
  })

  it('两个必填字段：漏掉 launcher 那一侧是编译错误，不是一个看起来合理的结果', () => {
    // 原缺陷的形状是「launcher 那一侧整个没写」。若把它做成可选参数，第七个动作可以什么都不传、
    // 拿到 activeWorkspaceId，于是同一个 bug 原地重来一次而 tsc 全程沉默。
    // 判源码是因为「这个字段是不是可选的」是一个类型性质，运行期看不见。
    const helper = readFileSync(
      new URL('../src/renderer/src/lib/launcher-workspace.ts', import.meta.url),
      'utf8'
    )
    expect(helper).toMatch(/launcherTabWorkspaceId: string \| undefined/)
    expect(helper).not.toMatch(/launcherTabWorkspaceId\?:/)
  })
})

