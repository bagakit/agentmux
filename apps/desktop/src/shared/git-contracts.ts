/**
 * 源码控制的线上合同：`git status` / 单文件 diff / remote 动词 / Pull Request 就绪度。
 *
 * 为什么单独一个文件而不是留在 `contracts.ts` 里：这一族的耦合是**单向且只朝一个方向**的。实测（AST
 * 遍历整份 contracts.ts 的声明图）：这 14 个符号引用本地其他符号 **0 次**，而本地引用它们的 10 条边
 * **全部**来自 `AgentMuxDesktopApi` / `AgentMuxPreloadApi` 那两个 IPC 门面——也就是说它和 Workspace、
 * Session、Browser 三族之间没有任何一条边。十二个消费者里有九个从 contracts 只导入这一族的名字，
 * 它们本来就不需要路过那 1400 行。
 *
 * 与 Browser 一族的区别也是实测出来的、不是感觉：Browser 有一条 `AppConfig -> BrowserConfig` 的非门面
 * 入边（配置要持久化浏览器设置），所以它切出去会**留下一条跨文件依赖**；Git 这一族一条都没有，切口是干净的。
 *
 * 边界：这里只放**跨进程传的形状**。git 的解析（porcelain 两列怎么读）归
 * `renderer/src/lib/git-porcelain-status.ts`，那是 #746 立的 SSOT；执行归 main 侧的
 * `git-service.ts` / `gh-service.ts`。形状放这里是因为两侧都要认它，而两侧谁都不该拥有它。
 */


/**
 * One entry from `git status`. `index`/`worktree` are git's own two status columns (X and Y), kept
 * raw so the UI can label states precisely without the parser pre-deciding; the booleans are the
 * common questions derived from them. `origPath` is the pre-rename path, present only for a rename or
 * copy. Every path is repo-root-relative, exactly as git emits it.
 */
export type GitFileChange = {
  path: string
  origPath: string | null
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

/**
 * Result of reading source-control status for a workspace. A discriminated union mirroring
 * `WorkspaceBranchesSnapshot`: a plain folder is a first-class, non-error answer, not a thrown
 * exception. `branch` is null on a detached HEAD.
 *
 * `repoRelativePrefix` is how deep the workspace sits inside `repoPath`, as reported by git itself
 * (`''` when they are the same directory). It is carried here rather than recomputed by the renderer
 * because the two paths are not comparable as strings — `repoPath` is canonicalized by git while a
 * workspace path is whatever the config stored — and a failed comparison silently degrades to `''`,
 * which is also the legitimate "same directory" value. It is required, not optional: a consumer that
 * forgot to pass it would otherwise default to the value that misattributes markers.
 */
export type GitStatusResult =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      repoRelativePrefix: string
      branch: string | null
      changes: GitFileChange[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

/**
 * One side (old = HEAD blob, new = worktree file) of a single-file diff. Absent is a first-class
 * state, not empty text: a missing old side is how an added file is drawn, a missing new side a
 * deleted one. `binary` carries no `text` — a file with a NUL byte or one too large to read is
 * reported as binary rather than having raw bytes stuffed into a string field.
 */
export type GitDiffSide =
  | { present: false }
  | { present: true; binary: true }
  | { present: true; binary: false; text: string }

/**
 * A structured single-file diff built by reading blobs, not by parsing unified-diff text. `change`
 * is derived from which sides are present and whether their text differs; `binary` is true when
 * either side is binary. The renderer decides how to draw added/deleted/modified/unchanged from
 * this shape without re-deciding anything the service already knows.
 */
export type GitFileDiff = {
  path: string
  old: GitDiffSide
  new: GitDiffSide
  binary: boolean
  change: 'added' | 'deleted' | 'modified' | 'unchanged'
}

/** How a pull reconciles with its upstream when the caller pins a strategy rather than leaving it to git. */
export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase'

/** Common remote-verb inputs. `remote`/`refspec` default to `origin`/`HEAD` and are `-`-prefix rejected. */
export type GitRemoteOptions = {
  remote?: string
  refspec?: string
}

export type GitPushOptions = GitRemoteOptions & {
  /** Use `--force-with-lease` (never a bare `--force`); opt-in for a deliberate history rewrite. */
  forceWithLease?: boolean
}

/**
 * Outcome of a remote verb (push/pull/fetch). `ok` is success; every failure is a classification of
 * git's own output, and its `message` is already credential-scrubbed — a remote URL can carry a
 * `user:token@`, which must never surface. `no-upstream` is the one benign failure (nothing to push
 * to / compare against); `non-fast-forward` and `diverged` are actionable ("sync first"); `error` is
 * everything else (auth, transport, corruption) surfaced rather than hidden.
 */
export type GitRemoteResult =
  | { kind: 'ok'; message?: undefined }
  | { kind: 'no-upstream'; message: string }
  | { kind: 'non-fast-forward'; message: string }
  | { kind: 'diverged'; message: string }
  | { kind: 'error'; message: string }

/**
 * How far the current branch is ahead of / behind its effective upstream. `upstream` is the resolved
 * full ref name the counts are relative to (the push target `@{push}` when it exists, else the
 * configured `@{upstream}`), or null when the branch has no upstream at all.
 */
export type GitAheadBehind = {
  upstream: string | null
  ahead: number
  behind: number
}

/**
 * The result of probing GitHub CLI availability and authentication for a workspace. Three states the
 * UI must keep distinct: `not-installed` (the gh binary is absent — the fix is to install it),
 * `not-authenticated` (gh is present but logged out — the fix is `gh auth login`), and `authenticated`
 * (ready). Authentication is entirely delegated to `gh auth`; AgentMux only *probes* `gh auth status`
 * and never reads, stores, or forwards a token — gh inherits GH_TOKEN/GITHUB_TOKEN from the process on
 * its own, so this adds no new credential-storage surface.
 */
export type GhAuthProbe =
  | { kind: 'not-installed' }
  | { kind: 'not-authenticated' }
  | { kind: 'authenticated' }

export type CreatePullRequestInput = {
  title: string
  body: string
  base: string
  /** Omitted lets gh infer the current branch, which is the ordinary case. */
  head?: string
  draft?: boolean
}

/**
 * Where a pull request's base branch came from, so the UI can say why it is proposing that target.
 *
 * `remote-head` is `origin/HEAD` — the remote's own declared default, the only authoritative answer.
 * `fallback` is a guess made because that ref is absent: it is genuinely missing in ordinary clones
 * (`git clone` writes it, but a repo initialized locally and pushed never gets one, and `git remote
 * set-head` is the only way to add it), so a UI that assumes "the default branch is knowable" is wrong
 * on a large fraction of real repositories. A guess must be visible and overridable, never silent —
 * opening a PR against the wrong base is not a mistake the user can undo by clicking again.
 */
export type PrBaseSource = 'remote-head' | 'fallback'

/**
 * Everything needed to answer "can a pull request be opened right now?", read in ONE main-process call.
 *
 * Why one call rather than the renderer assembling it: two of these facts (`baseRef`,
 * `baseExistsOnRemote`) have no renderer-side source at all — there is no `ls-remote` on the git bridge
 * and no notion of a default branch in this contract. The rest would take three independent awaits
 * (`gh.authStatus`, `git.status`, `git.aheadBehind`), and anything that awaits between reading two
 * facts can act on a pair that was never true together: the branch can move while the auth probe is in
 * flight. Gathering them together makes the set internally consistent by construction.
 *
 * This is a *hint*, not the authority. `GhService.createPullRequest` re-checks the base against the
 * remote and refuses on its own terms; this exists so the user gets "push it first" instead of whatever
 * gh happens to print. `checkedAt` is when the read happened, so a stale panel can say so.
 */
export type PrReadiness = {
  auth: GhAuthProbe
  branch: string | null
  baseRef: string
  baseSource: PrBaseSource
  baseExistsOnRemote: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasUncommittedChanges: boolean
  checkedAt: number
}

/**
 * Three outcomes, kept apart because they call for different responses.
 *
 * `refused` is a decision made *before* anything was created — a failed preflight, a missing binary,
 * an empty title — so nothing exists on GitHub and the composer keeps its content for a retry.
 * `failed` means gh ran and did not succeed; the message is already credential-scrubbed. Neither is
 * retried automatically: a write that may have partly landed must never be repeated on its own, or the
 * user ends up with two pull requests.
 */
export type CreatePullRequestResult =
  | { kind: 'created'; url: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }
