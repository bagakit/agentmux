import type { WorkspaceBranchRecord, WorkspaceBranchesSnapshot } from '../../../shared/contracts'

export type WorkspaceBranchesRequestState = {
  workspaceId: string
  snapshot: WorkspaceBranchesSnapshot | null
  loading: boolean
  error: string | null
}

export type VisibleWorkspaceBranchesState = {
  snapshot: WorkspaceBranchesSnapshot | null
  loading: boolean
  error: string | null
}

export function visibleWorkspaceBranchesState(
  workspaceId: string | null,
  state: WorkspaceBranchesRequestState | null
): VisibleWorkspaceBranchesState {
  if (!workspaceId) return { snapshot: null, loading: false, error: null }
  if (state?.workspaceId !== workspaceId) {
    return { snapshot: null, loading: true, error: null }
  }
  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error
  }
}

/**
 * 一个分支的 worktree 路径——**只在这里判一次**，并且同时给出标志与取值。
 *
 * 为什么必须把「有没有」和「是哪条」收成同一个函数：BranchesPanel 里这个概念此前被独立判了七次，
 * 其中一处用 `!== null` 而其余用 truthy——空串在两种写法下结论相反，所以那不是「同一个判断写了
 * 七遍」，而是七个可以各自漂移的判断。而只返回一个 boolean 并不够：调用方拿到 `true` 之后还得自己
 * 再判一次才能把 `string | null` 收窄成 `string`，于是判定点又长回来。返回「非空路径或 null」让标志
 * （`!== null`）与取值出自同一次判断，调用方无从各判一次。
 *
 * 且这七处**并非都被守住**：分组那两处的渲染结果有断言，而 `openBranch` 里的第三处只在点击时执行，
 * 而渲染测试用 renderToStaticMarkup **永不触发点击**——实测把它取反，5 条渲染断言全绿。
 *
 * 判据是「有一条非空路径」而不是 `!== null`：空串既不是一个能 cd 进去的目录，也不是一个能传给
 * `git worktree` 的参数，把它当作「有 worktree」会让下游拿着空路径去开一个不存在的目录。
 */
export function branchWorktreePath(
  branch: Pick<WorkspaceBranchRecord, 'worktreePath'>
): string | null {
  const path = branch.worktreePath
  return typeof path === 'string' && path.length > 0 ? path : null
}

/** 上面那一次判断的布尔面。它没有自己的判据——只是同一个结果的另一种形状。 */
export function branchHasWorktree(branch: Pick<WorkspaceBranchRecord, 'worktreePath'>): boolean {
  return branchWorktreePath(branch) !== null
}

/**
 * 点一个分支该走哪条路：直接进它的 worktree，还是先问用户要在哪儿建一个。
 *
 * 抽出来是为了让这个分流**可被直接质询**。留在组件里它只在 onClick 中执行，而本仓的渲染测试跑不到
 * 点击，于是取反后没有任何测试发红——后果是每一次点分支都做成相反的事：点已有 worktree 的分支会弹
 * 创建对话框（且因 createWorktree 自己的早退，提交后静默什么都不做），点没有 worktree 的分支会去调
 * openBranch，后端抛「Branch has no worktree」。
 */
export function branchOpenIntent(
  branch: Pick<WorkspaceBranchRecord, 'worktreePath'>
): 'open-worktree' | 'create-worktree' {
  return branchHasWorktree(branch) ? 'open-worktree' : 'create-worktree'
}
