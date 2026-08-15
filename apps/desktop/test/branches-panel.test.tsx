import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// api 在模块加载时判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type {
  WorkspaceBranchRecord,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../src/shared/contracts.js'
import type { GitAheadBehind } from '../src/shared/git-contracts.js'
import { allStyles } from './helpers/styles.js'

const fixture = vi.hoisted(() => ({
  snapshot: null as WorkspaceBranchesSnapshot | null,
  aheadBehind: null as GitAheadBehind | null,
  state: {
    activateWorkspaceSelection: vi.fn(),
    runFanOut: vi.fn(),
    config: { projects: [], executors: [] },
    sessions: [] as unknown[]
  }
}))

// useWorkspaceBranches 靠 useEffect 取数，而 renderToStaticMarkup **不跑 effect**——真用它就只能
// 渲染出「还在加载」。换掉 hook，让 snapshot 成为测试能控制的输入。
vi.mock('../src/renderer/src/hooks/useWorkspaceBranches.js', () => ({
  useWorkspaceBranches: () => ({
    snapshot: fixture.snapshot,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

// 同上：ahead/behind 也是 effect 取数。**不替换它，`facts` 就恒为 null，整个同步徽标是死代码而
// 这个文件照旧全绿**——这正是它需要被守的形状（实测：新增徽标后 6 条断言一条没动）。
vi.mock('../src/renderer/src/hooks/useGitAheadBehind.js', () => ({
  useGitAheadBehind: () => ({
    workspaceId: 'ws-1',
    facts: fixture.aheadBehind,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel.js'
import { gitSyncBadge } from '../src/renderer/src/lib/git-sync-badge.js'

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

function branch(name: string, overrides: Partial<WorkspaceBranchRecord> = {}): WorkspaceBranchRecord {
  return { name, worktreePath: null, workspaceId: null, isCurrent: false, ...overrides }
}

function render(branches: WorkspaceBranchRecord[]): string {
  fixture.snapshot = {
    kind: 'git-repository',
    hostId: 'local',
    repoPath: '/repo',
    branches
  }
  return renderToStaticMarkup(createElement(BranchesPanel, { workspace }))
}

/**
 * 取出一行的尾部标签区那一段。同步徽标与三岔状态标签都画在这里，按行切片才能问「**这一行**上
 * 有没有徽标」——只在整页 markup 上判，"徽标只画在当前分支那行"这条就无法被否证。
 */
function trailingOf(markup: string, branchName: string): string {
  const anchor = `>${branchName}<`
  const at = markup.indexOf(anchor)
  expect(at, `没渲染出分支「${branchName}」——判据落空了，下面的断言会变成恒真`).toBeGreaterThanOrEqual(0)
  const rest = markup.slice(at)
  // 右界必须是**下一行的开头**而不是文档末尾：切到末尾会让下一行的徽标顶上来，于是
  // 「这一行没有徽标」永远判不出（本仓 section-slice-without-right-bound 那一族）。
  const next = rest.slice(anchor.length).indexOf('<button type="button" class="branch-row')
  return next < 0 ? rest : rest.slice(0, anchor.length + next)
}

/**
 * 取出一个分组的那一段标记。两个分组用同一套 `branch-row` 类名，所以「分支出现在页面上」证不了
 * 「它出现在**对的**分组里」——必须按分组切片，否则对调谓词后断言照旧通过。
 */
function group(markup: string, label: 'Worktrees' | 'Without worktree'): string {
  const head = `<div class="branch-group"><span>${label}</span>`
  const start = markup.indexOf(head)
  expect(start, `没渲染出「${label}」分组——判据落空了，下面的断言会变成恒真`).toBeGreaterThanOrEqual(0)
  const rest = markup.slice(start + head.length)
  const next = rest.indexOf('<div class="branch-group">')
  return next < 0 ? rest : rest.slice(0, next)
}

afterEach(() => {
  fixture.snapshot = null
  fixture.aheadBehind = null
  fixture.state.activateWorkspaceSelection.mockReset()
  fixture.state.runFanOut.mockReset()
})

/**
 * Branches 面板的渲染守卫。
 *
 * 此前 `BranchesPanel` 在 test/ 里只被四个 `readFileSync().toContain()` 源码文本断言提到——那种断言
 * **不执行任何代码**，把整个组件改成 `return null` 都不会红。于是这一族全部无人守：
 *
 * - 把 `bound`/`unbound` 两个谓词对调（:60-71），每个分支都进错分组：已有 worktree 的落到
 *   「Without worktree」，点它反而弹出创建对话框；没 worktree 的落到「Worktrees」，点它去开一个
 *   不存在的 worktree。
 * - 尾标签的三岔（`isCurrent` → Current / 有 worktree → Worktree / 否则 → Branch，:203-205）任一支
 *   写错，用户就读不出这一行到底是哪种。
 *
 * `worktreePath` 这一个概念在本文件里被**独立判了七次**（:62 :68 :78 :89 :164 :170 :203），其中 :170
 * 用的是 `!== null` 而其余用 truthy。空串在两种写法下结论相反，所以这不是"同一个判断写了七遍"，
 * 而是七个可以各自漂移的判断。下面第三条就钉住「分组、尾标签、副标题这三处必须对同一个分支得出
 * 同一个结论」——而不是逐个抄一遍它们当下的取值。
 */
describe('Branches 面板', () => {
  it('有无 worktree 分到各自的组里', () => {
    const markup = render([
      branch('main', { worktreePath: '/repo', workspaceId: 'ws-1' }),
      branch('feature/a')
    ])

    const withWorktree = group(markup, 'Worktrees')
    const without = group(markup, 'Without worktree')

    expect(withWorktree).toContain('>main<')
    expect(withWorktree).not.toContain('feature/a')
    expect(without).toContain('feature/a')
    expect(without).not.toContain('>main<')
  })

  it('尾标签三岔各自可辨：Current / Worktree / Branch', () => {
    // 三支都给一个样本，且**当前分支自己也有 worktree**——这样 `isCurrent` 优先于 worktree 这层
    // 顺序也被钉住：把两支调换顺序，main 会显示成 Worktree 而不是 Current。
    const markup = render([
      branch('main', { worktreePath: '/repo', workspaceId: 'ws-1', isCurrent: true }),
      branch('feature/a', { worktreePath: '/wt/a', workspaceId: 'ws-2' }),
      branch('feature/b')
    ])

    const withWorktree = group(markup, 'Worktrees')
    const without = group(markup, 'Without worktree')
    expect(withWorktree).toContain('Current')
    expect(withWorktree).toContain('>Worktree<')
    expect(without).toContain('Branch')
    // 没 worktree 的那条必须显式带上 unbound 修饰——它是"这行还不能直接进"的唯一视觉线索。
    expect(without).toContain('branch-row__state--unbound')
    expect(withWorktree).not.toContain('branch-row__state--unbound')
  })

  it('同一个分支在分组、尾标签、副标题三处得到同一个结论', () => {
    // 七处独立判 `worktreePath` 的一致性判据。不抄它们当下的取值，而是要求：**落在
    // 「Without worktree」组里的行，绝不出现有 worktree 那两个记号**（`>Worktree<` 尾标签、
    // 副标题里的真实路径），反之亦然。任一处的谓词单独取反，这条就红。
    const markup = render([
      branch('bound-1', { worktreePath: '/wt/1', workspaceId: 'ws-2' }),
      branch('bound-2', { worktreePath: '/wt/2', workspaceId: 'ws-3' }),
      branch('loose-1'),
      branch('loose-2')
    ])

    const withWorktree = group(markup, 'Worktrees')
    const without = group(markup, 'Without worktree')

    // 有 worktree 那一组：每一行都露出自己的路径，且没有一行自称「No worktree」。
    expect(withWorktree).toContain('/wt/1')
    expect(withWorktree).toContain('/wt/2')
    expect(withWorktree, '有 worktree 的行却把副标题写成 No worktree').not.toContain('No worktree')

    // 没有 worktree 那一组：每一行副标题都是 No worktree，且绝不出现任何 worktree 路径。
    expect(without).toContain('No worktree')
    expect(without.match(/\/wt\//g), '没有 worktree 的行却露出了一条 worktree 路径').toBeNull()
    expect(without, '没有 worktree 的行却打上了 Worktree 尾标签').not.toContain('>Worktree<')
  })

  it('不是 git 仓库时说清楚，且一个分组头都不渲染', () => {
    fixture.snapshot = { kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/plain' }
    const markup = renderToStaticMarkup(createElement(BranchesPanel, { workspace }))
    expect(markup).toContain('Not a Git repository')
    // 守的是两道 `length > 0` 的门（:241 / :242），而**不是** useMemo 里的 kind 判据：
    // not-a-git-repository 快照压根没有 `branches` 字段，所以那两个 useMemo 无论怎么写都得到空数组
    // （实测：把 kind 判据换成从 snapshot 上乐观取 branches，5 条仍全绿——那是个无效变异）。
    // 真能坏的是这两道门：任一改成恒真，就会渲染出一个空的分组头，用户在一个非仓库目录下看到
    // 「Worktrees」标题下空无一物。
    expect(markup, '非仓库快照下渲染出了分组头').not.toContain('branch-group')
  })

  it('是仓库但一条本地分支都没有时，指向该怎么做', () => {
    // 与上一条是不同的空：仓库在，只是还没有分支。两条文案不能折成同一句。
    const markup = render([])
    expect(markup).toContain('No local branches')
    expect(markup).not.toContain('Not a Git repository')
  })

  /**
   * 「一个分支有没有 worktree」这个判定在本文件里**只许出现零次**——它整个搬到了
   * workspace-branches-state 的 branchWorktreePath，由 workspace-branches-state.test.ts 直接质询。
   *
   * 为什么需要这道结构守卫而不只是上面那三条渲染断言：渲染断言守的是**当下的取值**，守不住「明天
   * 有人在这里再手写一次 `branch.worktreePath ? …`」。而那正是这个缺陷的成因——七处独立判定里只有
   * 露在渲染结果上的几处被守住，`openBranch` 里那处只在 onClick 执行，renderToStaticMarkup 永不触发
   * 点击，取反后 5 条渲染断言全绿。判据落在「谁读那个字段」上，因为增殖是按读取点发生的。
   *
   * 计数而不是 `not.toContain`：本文件合法地保留一个同名的**局部** state（`worktreePath`，创建对话框
   * 的输入框），裸词匹配会把它一起抓进来。所以判据是 `branch.worktreePath` 这种**从记录上取字段**的
   * 形状，并且先自检这个形状真能匹配到东西，免得写错正则后这道门恒绿。
   */
  it('面板里不许再手写第二处 worktreePath 判定', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/BranchesPanel.tsx', import.meta.url),
      'utf8'
    )
    const fieldReads = source.match(/\bbranch(?:es)?[A-Za-z]*\.worktreePath\b/g) ?? []
    expect(fieldReads, `面板里又出现了 ${fieldReads.length} 处直接读 worktreePath：${fieldReads.join(', ')}`)
      .toEqual([])
    // 自检：上面那个空数组必须是「真的没有」，而不是正则写错。拿一段已知含有该形状的文本喂给它。
    expect(
      'const x = branch.worktreePath ?? null'.match(/\bbranch(?:es)?[A-Za-z]*\.worktreePath\b/g),
      '判据正则连一段确定含有该形状的文本都匹配不到——这道门是恒绿的'
    ).toHaveLength(1)
    // 且判定必须真的来自那个唯一判定点，不是本地又写了个同名函数。
    expect(source, '面板不再从单一判定点取 worktree 路径了').toContain(
      "from '../lib/workspace-branches-state'"
    )
    expect(source).toContain('branchWorktreePath(branch)')
  })
})

/**
 * 当前分支的 ↑↓ 同步计数徽标。
 *
 * 为什么单独一族：`useGitAheadBehind` 靠 effect 取数，而 `renderToStaticMarkup` 不跑 effect。**不
 * 替换那个 hook，`facts` 就恒为 null，整个徽标分支一行都执行不到**——实测接上徽标后本文件原有 6 条
 * 断言一条没动，那段代码在全绿下是死的。所以这一族的第一件事是让 facts 成为可控输入。
 *
 * 判据落在三处各自能坏的地方：
 *   1. `kind` 有没有真的到 class 上（三种可见状态必须互不相同，写死成某一种就红）；
 *   2. 徽标只画在 `isCurrent` 那一行（ahead/behind 是 HEAD 相对自己 upstream 的事实，画到别的分支
 *      行上是谎——那些分支各有各的 upstream）；
 *   3. 两种「没有数字可报」的状态（no-upstream / synced）一个盒子都不画。
 *
 * 已知且刻意的缺口，记在这里免得下一个人以为它坏了：`no-upstream` 与 `synced` 都不渲染，于是
 * `gitSyncBadge` 为它们准备的两句不同的 `title` **在这个面板上到不了 DOM**——用户读不出「还没有
 * upstream」和「已同步」的区别。这不是「区别落在 title 上」，那种说法会给一个不可达的东西背书。
 * 要露出前者需要一个新的视觉记号（不是空盒子），属产品决定，已单独记录。
 */
describe('Branches 面板的同步计数徽标', () => {
  const UPSTREAM = 'refs/remotes/origin/main'

  function currentAnd(other: string): WorkspaceBranchRecord[] {
    return [
      branch('main', { worktreePath: '/repo', workspaceId: 'ws-1', isCurrent: true }),
      branch(other, { worktreePath: '/wt/a', workspaceId: 'ws-2' })
    ]
  }

  it('三种有数字的状态各画自己的 kind 与文本', () => {
    // 三种各判一次，且每次都断言**另外两种不在场**：把 class 里的 `${sync.kind}` 换成任一字面量，
    // 或者让 label 与 kind 来自两次独立判定，都会在这里红。
    const cases = [
      { facts: { upstream: UPSTREAM, ahead: 2, behind: 0 }, kind: 'ahead', label: '↑2' },
      { facts: { upstream: UPSTREAM, ahead: 0, behind: 3 }, kind: 'behind', label: '↓3' },
      { facts: { upstream: UPSTREAM, ahead: 2, behind: 3 }, kind: 'diverged', label: '↑2 ↓3' }
    ] as const

    for (const probe of cases) {
      fixture.aheadBehind = probe.facts
      const row = trailingOf(render(currentAnd('feature/a')), 'main')
      expect(row, `${probe.kind} 没画出自己的 kind`).toContain(`data-sync-kind="${probe.kind}"`)
      expect(row, `${probe.kind} 没画出自己的 class`).toContain(`branch-row__sync--${probe.kind}`)
      expect(row, `${probe.kind} 的文本没上去`).toContain(probe.label)
      for (const other of cases) {
        if (other.kind === probe.kind) continue
        expect(row, `${probe.kind} 的行上出现了 ${other.kind}`).not.toContain(
          `data-sync-kind="${other.kind}"`
        )
      }
    }
  })

  it('徽标只出现在当前分支那一行', () => {
    fixture.aheadBehind = { upstream: UPSTREAM, ahead: 2, behind: 0 }
    const markup = render(currentAnd('feature/a'))

    expect(trailingOf(markup, 'main'), '当前分支这行没有徽标').toContain('data-sync-kind=')
    expect(
      trailingOf(markup, 'feature/a'),
      '非当前分支画上了 HEAD 的计数——那条分支有它自己的 upstream，这个数字说不了它的事'
    ).not.toContain('data-sync-kind=')
    // 整页只许有一个。删掉 `branch.isCurrent &&` 后每一行都会画，这条按数量红——上面那条按行
    // 切片也会红，两条各守一侧。
    expect(markup.match(/data-sync-kind=/g) ?? [], '整页出现了不止一个同步徽标').toHaveLength(1)
  })

  it('没有数字可报的两种状态一个盒子都不画', () => {
    // no-upstream：upstream 缺席，两个 0 是占位不是测量结果。
    fixture.aheadBehind = { upstream: null, ahead: 0, behind: 0 }
    expect(render(currentAnd('feature/a')), 'no-upstream 画出了一个空徽标').not.toContain(
      'data-sync-kind='
    )
    // synced：有 upstream 且两侧都是 0。与上一种同样不画，但**不是同一个理由**。
    fixture.aheadBehind = { upstream: UPSTREAM, ahead: 0, behind: 0 }
    expect(render(currentAnd('feature/a')), 'synced 画出了一个空徽标').not.toContain('data-sync-kind=')
    // 自检：同一条渲染路径在有数字时**确实**画得出来。少了这条，上面两句在锚点改名后会恒绿。
    fixture.aheadBehind = { upstream: UPSTREAM, ahead: 1, behind: 0 }
    expect(
      render(currentAnd('feature/a')),
      '连有数字的状态都画不出来——上面两条 not.toContain 是恒真的'
    ).toContain('data-sync-kind=')
  })

  it('还没问出结果时不画，也不炸', () => {
    // `facts === null` 是「还没问」（或桥不在场），与「问了得到 0/0」是两件事。少了组件里那道
    // null 门，`gitSyncBadge(null)` 会当场抛。
    fixture.aheadBehind = null
    const markup = render(currentAnd('feature/a'))
    expect(markup).toContain('>main<')
    expect(markup, 'facts 还是 null 时就画出了徽标').not.toContain('data-sync-kind=')
  })

  /**
   * 每一种**会渲染出徽标**的 kind 都必须在样式表里有自己的一条规则。
   *
   * 清单不手抄：从 `gitSyncBadge` 自己身上取——喂给它覆盖四个正负组合的事实，把 label 非空的那些
   * kind 收集起来。手抄一份清单就会在加第六种状态时静默漏掉 CSS，而那种漏法的症状是徽标以继承色
   * 出现，测试与 tsc 都不会红。
   *
   * 扫的是 `allStyles()`（整张表）而不是某一个文件名。此前这里硬写 dock.css，于是把 Source Control
   * 那一段拆到 source-control.css 时它当场变红——而拆分并没有让任何一条规则失效。判据本来就该是
   * 「这条规则在层叠里吗」，不是「它在哪个文件里」：后者让每一次按表面再拆一刀都要来改这条断言，
   * 且反过来，若那个文件从 @import 里掉出去（规则真的失效了），硬写路径的读法照旧全绿。
   */
  it('每种可见 kind 在样式表里都有配色', () => {
    const probes: GitAheadBehind[] = [
      { upstream: null, ahead: 0, behind: 0 },
      { upstream: UPSTREAM, ahead: 0, behind: 0 },
      { upstream: UPSTREAM, ahead: 4, behind: 0 },
      { upstream: UPSTREAM, ahead: 0, behind: 4 },
      { upstream: UPSTREAM, ahead: 4, behind: 4 }
    ]
    const visible = [...new Set(probes.map(gitSyncBadge).filter((b) => b.label !== '').map((b) => b.kind))]
    expect(visible.length, '一种会渲染的 kind 都收集不到——判据落空了').toBeGreaterThan(0)

    const css = allStyles()
    for (const kind of visible) {
      expect(css, `可见状态 ${kind} 没有配色规则，徽标会以继承色出现`).toContain(
        `.branch-row__sync--${kind} {`
      )
    }
  })
})
