import { describe, expect, it } from 'vitest'
import type { WorkspaceBranchesSnapshot } from '../src/shared/contracts.js'
import {
  branchHasWorktree,
  branchOpenIntent,
  visibleWorkspaceBranchesState,
  type WorkspaceBranchesRequestState
} from '../src/renderer/src/lib/workspace-branches-state.js'

const snapshot: WorkspaceBranchesSnapshot = {
  kind: 'git-repository',
  hostId: 'local',
  repoPath: '/repo-a',
  branches: [
    { name: 'main', worktreePath: '/repo-a', workspaceId: 'workspace-a', isCurrent: true }
  ]
}

describe('Workspace Branch snapshot identity', () => {
  it('hides the previous Workspace snapshot on the synchronous Project-switch render', () => {
    const previous: WorkspaceBranchesRequestState = {
      workspaceId: 'workspace-a',
      snapshot,
      loading: false,
      error: 'stale error'
    }

    expect(visibleWorkspaceBranchesState('workspace-b', previous)).toEqual({
      snapshot: null,
      loading: true,
      error: null
    })
    expect(visibleWorkspaceBranchesState('workspace-a', previous)).toEqual({
      snapshot,
      loading: false,
      error: 'stale error'
    })
  })

  it('shows no loading or stale data when no Workspace is selected', () => {
    expect(visibleWorkspaceBranchesState(null, {
      workspaceId: 'workspace-a',
      snapshot,
      loading: false,
      error: null
    })).toEqual({ snapshot: null, loading: false, error: null })
  })

  it('keeps a non-Git folder snapshot on the normal success path', () => {
    const nonGitSnapshot: WorkspaceBranchesSnapshot = {
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: '/srv/plain-folder'
    }

    expect(visibleWorkspaceBranchesState('plain-folder', {
      workspaceId: 'plain-folder',
      snapshot: nonGitSnapshot,
      loading: false,
      error: null
    })).toEqual({ snapshot: nonGitSnapshot, loading: false, error: null })
  })
})

/**
 * 「这个分支有没有 worktree」与「点它该走哪条路」——这两个判定此前散落在 BranchesPanel 的**七处**，
 * 且其中只有渲染出来的那几处被守住。
 *
 * 为什么必须在这一层钉：`openBranch` 里的那处分流只在 onClick 中执行，而本仓的渲染测试用
 * `renderToStaticMarkup`，**永不触发点击**——实测把它取反，branches-panel.test.tsx 的 5 条断言全绿。
 * 所以修法是把那个判定**从组件里搬走**，让它成为一个能被直接质询的纯函数；下面两组用例就是那个质询。
 */
describe('分支的 worktree 判定', () => {
  // 空串是这七处此前会得出**相反结论**的那个输入：`!== null` 说「有」，truthy 说「没有」。
  // 取值判据只有一个：有一条**非空**路径才算有 worktree——空串既不能 cd 进去，也不能传给 git worktree。
  it.each([
    { worktreePath: '/wt/a', has: true, why: '一条真实路径' },
    { worktreePath: null, has: false, why: 'git 说这条分支没有 worktree' },
    { worktreePath: '', has: false, why: '空串不是一个能打开的目录（此前 !== null 那一处会说「有」）' }
  ])('branchHasWorktree($worktreePath) = $has —— $why', ({ worktreePath, has }) => {
    expect(branchHasWorktree({ worktreePath }), `空串/null 的取值判据漂了：${worktreePath}`).toBe(has)
  })

  /**
   * 分流的两个方向都要钉。取反的后果是每一次点分支都做成相反的事：点已有 worktree 的分支弹出创建
   * 对话框（且因 createWorktree 自己的早退，提交后静默什么都不做），点没有 worktree 的分支去调
   * openBranch，后端抛「Branch has no worktree」。
   */
  it.each([
    { worktreePath: '/wt/a', intent: 'open-worktree' as const },
    { worktreePath: null, intent: 'create-worktree' as const },
    { worktreePath: '', intent: 'create-worktree' as const }
  ])('branchOpenIntent($worktreePath) = $intent', ({ worktreePath, intent }) => {
    expect(branchOpenIntent({ worktreePath }), '点分支的分流判反了').toBe(intent)
  })

  it('分流与「有没有 worktree」永远同进同退——它们不许是两个可以各自漂移的判断', () => {
    for (const worktreePath of ['/wt/a', '/wt/b', '', null]) {
      expect(
        branchOpenIntent({ worktreePath }) === 'open-worktree',
        `两个判定对 ${JSON.stringify(worktreePath)} 得出了相反的结论`
      ).toBe(branchHasWorktree({ worktreePath }))
    }
  })
})
