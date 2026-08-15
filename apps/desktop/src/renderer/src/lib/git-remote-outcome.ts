import type { GitRemoteResult } from '../../../shared/git-contracts'

/**
 * 远端 git 动作（push / pull / fetch）的结果说给用户听的那一句，以及破坏性操作的「先武装再执行」判定。
 *
 * 为什么需要这一层（#206）：`git-service.ts` 把每个远端失败**分类**成了 5 个 kind——`ok` /
 * `no-upstream` / `non-fast-forward` / `diverged` / `error`，每个 message 都已脱敏（远端 URL 可能带
 * `user:token@`，绝不能进 UI）。这套分类是有代价做出来的，而渲染层如果只是 `setError(result.message)`，
 * 就把 5 类压回 1 类：用户看到 git 的原话，而不是「下一步该干什么」。分类白做。
 *
 * **判据落在 (动作, kind) 这一对上，而不是只看 kind。** 同一个 kind 在不同动作下是不同的处境：
 *   - push 得到 `non-fast-forward`：远端有你没有的提交 → 「先 Pull」。
 *   - pull 得到 `diverged`：两边都有对方没有的提交 → 「要决定 merge 还是 rebase」。
 *   - push 得到 `no-upstream`：你在 detached HEAD 上（push 自己带 `--set-upstream`，正常分支不会缺
 *     upstream）→ 「先 checkout 一个分支」。
 *   - pull 得到 `no-upstream`：这个分支还没发布过 → 「先 Push」。
 * 只按 kind 写一张表，最后两条会说成同一句话——而它们的下一步恰好相反（一个去 checkout，一个去 push）。
 * 这正是本仓 #85 那次「两类折成同一条 remedy，其一是错建议」的形状，所以这里的表是嵌套的。
 *
 * 与 `pr-eligibility.ts` 同一条纪律：UI 按 **key** 分支，永不按文案分支；文案与 key 放在一起，用
 * exhaustive `Record` 让漏一条被 tsc 抓住。
 */

/** 三个远端动作。刻意不含本地动作（stage/unstage/discard）——它们不返回 {@link GitRemoteResult}。 */
export type GitRemoteVerb = 'push' | 'pull' | 'fetch'

/** 失败的那几个 kind。`ok` 不在其中：它没有 message，也没有「下一步」。 */
export type GitRemoteFailureKind = Exclude<GitRemoteResult['kind'], 'ok'>

/**
 * 每个动作成功后说的那一句。刻意分开而不是一句「Done」：用户点了三个不同的按钮，回执要能对上他点的
 * 那一个，否则并发点两次时看不出是哪个成了。
 */
export const GIT_REMOTE_SUCCESS: Record<GitRemoteVerb, string> = {
  push: 'Pushed to the remote.',
  pull: 'Pulled from the remote.',
  fetch: 'Fetched from the remote.'
}

/**
 * (动作, 失败 kind) → 那一句可行动的话。
 *
 * `error` 一栏刻意**不**写死一句话，而是留给 git 自己脱敏后的 message：那一类是「认不出来的失败」
 * （认证、传输、仓库损坏），我们编不出比 git 更准的说法，编了反而盖住真相。所以这张表里 `error` 存的是
 * 前缀，真正的 message 由 {@link describeGitRemote} 接在后面。其余三类是我们**认出来了**的处境，
 * 说的就是下一步，不再附 git 原话——那句话在这三种情况下只会重复我们已经翻译过的事实。
 */
const FAILURE_COPY: Record<GitRemoteVerb, Record<GitRemoteFailureKind, string>> = {
  push: {
    // push 自带 --set-upstream，所以正常分支不会缺 upstream；能走到这里基本只有 detached HEAD。
    'no-upstream': 'You are on a detached HEAD. Check out a branch before pushing.',
    'non-fast-forward': 'The remote has commits you do not. Pull first, then push again.',
    // push 不产生 diverged（那是 pull 的 reconcile 决定），但 kind 是同一个联合，必须给一句不误导的话。
    diverged: 'The branch and the remote have diverged. Pull to reconcile them, then push again.',
    error: 'Could not push:'
  },
  pull: {
    // 与 push 的同名 kind 说的是相反的下一步：这里的意思是「这个分支还没发布过」。
    'no-upstream': 'This branch has no upstream yet. Push it first, then pull.',
    'non-fast-forward': 'The remote has moved in a way this pull cannot apply. Fetch and review before pulling again.',
    diverged: 'Both sides have new commits. Choose how to reconcile them — merge or rebase — then pull again.',
    error: 'Could not pull:'
  },
  fetch: {
    // fetch 不需要 upstream（它按 remote 名取），所以这一格今天基本不可达；仍要有一句不误导的话。
    'no-upstream': 'There is no remote branch to fetch for this branch.',
    'non-fast-forward': 'The remote rejected the fetch. Check the remote configuration.',
    diverged: 'The remote refs have diverged from the local copies. Review the branch before fetching again.',
    error: 'Could not fetch:'
  }
}

/**
 * 一次远端动作的结果，翻成给用户看的一句话。
 *
 * 成功与失败分成两个形状而不是「message + 一个 ok 布尔」：调用方拿到 `ok: false` 时必须处理 message，
 * 而 `ok: true` 时那句话是回执不是错误——两者在界面上去的地方不同（横幅 vs 提示），折成一个形状会让
 * 调用方自己再判一次。
 */
export type GitRemoteOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: GitRemoteFailureKind; message: string }

export function describeGitRemote(verb: GitRemoteVerb, result: GitRemoteResult): GitRemoteOutcome {
  if (result.kind === 'ok') return { ok: true, message: GIT_REMOTE_SUCCESS[verb] }
  const copy = FAILURE_COPY[verb][result.kind]
  // 只有认不出来的那一类才附 git 原话（已在 main 侧脱敏）。其余三类我们已经把处境翻译成下一步了，
  // 再接一句 git 原文只是把同一件事说两遍，而且那句话往往比我们的说法更让人不知所措。
  if (result.kind !== 'error') return { ok: false, kind: result.kind, message: copy }
  const detail = result.message.trim()
  return { ok: false, kind: 'error', message: detail ? `${copy} ${detail}` : copy }
}

/**
 * 「丢弃一个文件的改动」这个破坏性动作的两步判定。
 *
 * 为什么要两步：`discard` 在 main 侧对未跟踪文件走的是 `git clean --force`——**从磁盘上删文件**，
 * 没有 reflog、没有 stash、无法撤销（见 `git-service.ts` 的 discard 注释）。一次误点就是永久丢失。
 * 而这一族按钮就挨在 Stage 旁边。
 *
 * 为什么不用 `window.confirm`：它阻塞渲染进程，在测试里不可达，而且本仓渲染层至今没有任何一处用它
 * （唯一提到它的地方是 xterm 库自己的默认行为，见 TerminalView 注释）。这里改成**行内武装**：第一次
 * 点是「武装这一行」，第二次点同一行才真的执行。判定做成纯函数，这样「不可能一次点击就删掉文件」是一条
 * 能被质询的断言，而不是藏在组件事件处理里的顺序假设。
 *
 * @param armed 当前被武装的那一行的 path，没有则为 null
 * @param clicked 这次点的那一行的 path
 */
export function discardIntent(armed: string | null, clicked: string): 'arm' | 'discard' {
  // 只有**同一行**已被武装才执行。武装着 A 又去点 B 时是给 B 武装，不是删 B——否则「武装」这一步
  // 就只挡住了第一次点击，挡不住点错行。
  return armed === clicked ? 'discard' : 'arm'
}
