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

const fixture = vi.hoisted(() => ({
  snapshot: null as WorkspaceBranchesSnapshot | null,
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

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel.js'

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
