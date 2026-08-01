import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// api 在模块加载时就要判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { GitFileChange, GitStatusResult, WorkspaceRecord } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  git: { status: null as GitStatusResult | null, loading: false, error: null as string | null },
  state: { openFileDiff: vi.fn() }
}))

// useGitStatus 靠 useEffect 取数，而 renderToStaticMarkup **不跑 effect**——真用它就永远只能渲染出
// 「还在加载」。所以这里换掉 hook 本身，让 status 成为测试能控制的输入。
vi.mock('../src/renderer/src/hooks/useGitStatus.js', () => ({
  useGitStatus: () => ({ ...fixture.git, refresh: vi.fn() })
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel.js'

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

/** 一条 git 变更。index/worktree 是 git 的两列状态码，两者含义不同——这正是被守的判据之一。 */
function change(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path,
    origPath: null,
    index: ' ',
    worktree: ' ',
    staged: false,
    unstaged: false,
    untracked: false,
    ...overrides
  }
}

function render(changes: GitFileChange[]): string {
  fixture.git.status = {
    kind: 'git-repository',
    hostId: 'local',
    repoPath: '/repo',
    branch: 'main',
    changes
  }
  return renderToStaticMarkup(createElement(ChangesPanel, { workspace }))
}

/**
 * 取出一个分组的那一段标记。两个分组用同一套 `change-row` 类名，所以「文件出现在页面上」证不了
 * 「它出现在**对的**分组里」——必须按分组切片，否则对调谓词后断言照旧通过。
 */
function group(markup: string, label: 'Staged' | 'Changes'): string {
  const head = `<div class="branch-group"><span>${label}</span>`
  const start = markup.indexOf(head)
  expect(start, `没渲染出 ${label} 分组——判据落空了，下面的断言会变成恒真`).toBeGreaterThanOrEqual(0)
  const rest = markup.slice(start + head.length)
  const next = rest.indexOf('<div class="branch-group">')
  return next < 0 ? rest : rest.slice(0, next)
}

afterEach(() => {
  fixture.git = { status: null, loading: false, error: null }
  fixture.state.openFileDiff.mockReset()
})

/**
 * 提交区两个控件各自的 disabled。**必须分开读**：两者的表达式不同（按钮多一个「消息非空」的合取项），
 * 一个 `markup.toContain('disabled=""')` 分不清是谁关着，也就分不清删掉了哪一个合取项。
 */
function disabled(markup: string, which: 'textarea' | 'submit'): boolean {
  const head = which === 'textarea' ? '<textarea ' : '<button type="submit" '
  const start = markup.indexOf(head)
  expect(start, `提交区没渲染出 ${which}——判据落空了`).toBeGreaterThanOrEqual(0)
  const openTag = markup.slice(start, markup.indexOf('>', start))
  return openTag.includes('disabled=""')
}

/**
 * Source Control 的渲染守卫。
 *
 * 此前 `ChangesPanel` 在整个 test/ 目录里**零引用**——没有任何测试渲染过它，对它的引用只有别的测试
 * 文件里的 `readFileSync().toContain()` 源码文本断言。于是这一族全部无人守：
 *
 * - 把 `staged`/`unstaged` 两个谓词对调（:53 / :57），文件进错分组；
 * - 把传给 `changeRow` 的 `canStage` 对调（:143 / :146），**未暂存文件不再渲染暂存按钮**——用户没有
 *   任何入口把文件加进暂存区，提交流程死锁；
 * - `changeLabel` 读错状态列（:23，`staged ? index : worktree` 取反），每一行都退化成泛化的
 *   "Changed"，看不出到底是改了、加了还是删了。
 *
 * `git-status-porcelain.test.ts` 挡不住任何一条：它断言的是**数据模型**（porcelain 两列解析成
 * staged/unstaged/untracked 布尔），到 `change.staged` 为止就停了；面板怎么用这个布尔分组、怎么选
 * 状态列、画 `+` 还是 `✓`，它一概不碰。`tsc` 也挡不住——对调的两侧类型完全相同。
 */
describe('Source Control 面板', () => {
  it('暂存与未暂存分到各自的组里，且只有未暂存的那条给得出暂存入口', () => {
    const markup = render([
      change('src/staged.ts', { index: 'M', staged: true }),
      change('src/dirty.ts', { worktree: 'M', unstaged: true })
    ])

    const stagedGroup = group(markup, 'Staged')
    const changesGroup = group(markup, 'Changes')

    // 分组归属：各自只在自己那一组里。谓词对调时两条都红。
    expect(stagedGroup).toContain('staged.ts')
    expect(stagedGroup).not.toContain('dirty.ts')
    expect(changesGroup).toContain('dirty.ts')
    expect(changesGroup).not.toContain('staged.ts')

    // canStage：只有未暂存那条有暂存按钮，已暂存那条是只读对勾。这两条守的是**入口在不在**，
    // 与分组归属正交——把 changeRow 的两个布尔对调时，上面四条仍绿，只有这两条红。
    expect(changesGroup, '未暂存的文件没有暂存按钮——用户无法把它加进暂存区')
      .toContain('aria-label="Stage src/dirty.ts"')
    expect(stagedGroup, '已暂存的文件又给了一次暂存按钮').not.toContain('aria-label="Stage')
    expect(stagedGroup).toContain('change-row__staged-mark')
  })

  it('状态标签按 git 的两列各取所需：暂存看 index，未暂存看 worktree', () => {
    // 每一行的 index 与 worktree **刻意不同**：读错那一列就必然落进 switch 的 default（"Changed"），
    // 而不是恰好也对。两列填一样的值会让这条判据恒真。
    const markup = render([
      change('a.ts', { index: 'A', worktree: ' ', staged: true }),
      change('b.ts', { index: 'M', worktree: ' ', staged: true }),
      change('c.ts', { index: ' ', worktree: 'D', unstaged: true }),
      change('d.ts', { index: ' ', worktree: 'M', unstaged: true })
    ])

    const stagedGroup = group(markup, 'Staged')
    const changesGroup = group(markup, 'Changes')
    expect(stagedGroup).toContain('Added')
    expect(stagedGroup).toContain('Modified')
    expect(changesGroup).toContain('Deleted')
    expect(changesGroup).toContain('Modified')
    // 取反那一行后每条都会变成 "Changed"；这条钉住「没有任何一行退化」。
    expect(markup, '有行退化成泛化的 Changed——状态列读错了').not.toContain('>Changed<')
  })

  it('未跟踪的文件先按未跟踪判，不看两列状态码', () => {
    // untracked 在 changeLabel 里是**最先**判的（:22 早退），这条守那次早退：删掉它，git 给未跟踪
    // 文件的两列是 '??'，会落进 default 变成 "Changed"。
    const markup = render([change('new.ts', { index: '?', worktree: '?', untracked: true, unstaged: true })])
    expect(group(markup, 'Changes')).toContain('Untracked')
  })

  it('没有暂存内容时，消息框与提交按钮都关着', () => {
    // 界面不给出一条注定被拒的路：没有暂存内容时连消息都不让写。
    const markup = render([change('src/dirty.ts', { worktree: 'M', unstaged: true })])
    expect(markup).toContain('Stage a file to commit')
    expect(disabled(markup, 'textarea'), '没有暂存内容却让人写提交消息').toBe(true)
    expect(disabled(markup, 'submit'), '没有暂存内容却让人点提交').toBe(true)
  })

  /**
   * 有暂存内容时**只有消息框打开**，按钮仍关着——因为按钮多一个合取项 `!commitMessage.trim()`。
   *
   * 这条与上一条合起来把两个 `disabled` 表达式的**差别**钉住了，而不只是「有没有 disabled」：
   * - 把 textarea 的 `staged.length === 0` 删掉 → 上一条的 textarea 断言红；
   * - 把按钮的 `staged.length === 0` 删掉 → 上一条的按钮断言红；
   * - 把按钮的 `!commitMessage.trim()` 删掉 → 这一条的按钮断言红（空消息也能点，提交必被服务端拒）。
   * 三个合取项各自成为某一条断言现场里唯一还站着的守卫。
   */
  it('有暂存内容时消息框打开，但空消息仍点不了提交', () => {
    const markup = render([change('src/staged.ts', { index: 'M', staged: true })])
    expect(markup).toContain('Commit (1)')
    expect(disabled(markup, 'textarea'), '有暂存内容却不让写提交消息').toBe(false)
    expect(disabled(markup, 'submit'), '消息还是空的就让人点提交——这一次提交注定被拒').toBe(true)
  })
})
