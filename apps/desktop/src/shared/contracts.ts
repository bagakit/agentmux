import type {
  AgentCatalogEntry,
  AgentMuxAgentContinuityResult,
  AgentMuxAgentContinuityConflictReason,
  AgentMuxAgentContinuityUnavailableReason,
  AgentCapabilities,
  AgentDisplayState,
  AgentExecutorConfig,
  AgentExecutorId,
  AgentProviderId,
  LaunchOptionSelection,
  AgentMuxClientEvent,
  AgentMuxEvidenceSource,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRunDataEvent,
  AgentMuxRunExitReason,
  AgentMuxRunInputData,
  AgentMuxRunRef,
  AgentMuxRunReplayGap,
  AgentMuxRunState,
  AgentTerminalCapabilityState,
  AgentTurnUsage,
  AgentMuxControlError,
  AgentMuxControlErrorCode,
  AgentMuxControlRequest,
  AgentMuxControlResult,
  AgentTimelineItem,
  AgentTimelineSnapshot
} from '@agentmux/core'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type ScratchTopicSnapshot
} from './scratch-topics'
import type { UsageSnapshot } from './process-usage'
import type {
  NotificationDelivery,
  NotificationModeId,
  NotificationSettings
} from './notification-presentation'

export { SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME }
export type { RunUsage, UsageSnapshot } from './process-usage'
export type { ScratchTopicSnapshot } from './scratch-topics'
// Only the two names product code imports through the contracts path are re-exported here; the rest of
// the notification vocabulary is imported straight from ./notification-presentation where it is used.
export type { NotificationDelivery, NotificationModeId } from './notification-presentation'

export type LocalHostConfig = {
  id: 'local'
  kind: 'local'
  label: string
}

export type SshHostConfig = {
  id: string
  kind: 'ssh'
  label: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}

export type HostConfig = LocalHostConfig | SshHostConfig

export type { AgentExecutorConfig, AgentExecutorId, AgentTimelineItem, AgentTimelineSnapshot }

/**
 * Every `WorkspaceRecord['kind']`, once, and the single source of truth for it. Iterate this (never a
 * hand-written list) when a test or a consumer needs to walk every kind.
 *
 * Before this tuple existed, `kind` was a bare `'folder' | 'worktree'` union compared by hand at ~7
 * sites (`kind === 'folder'`, `kind !== 'worktree'`, …). Adding a third member was therefore a SILENT
 * change: every one of those comparisons kept compiling and quietly took the pre-existing branch. That
 * is sharper here than for a many-armed union — with only two members, a `kind !== 'worktree'` test
 * literally MEANS "is a folder", so a third kind is silently folded into whichever side the author
 * happened to write. The tuple + `WorkspaceKind` + `assertUnreachableWorkspaceKind` turn that into a
 * compile error at the one place each semantic question is decided (see `isFolderWorkspace` /
 * `isWorktreeWorkspace`).
 */
export const WORKSPACE_KINDS = ['folder', 'worktree'] as const

/**
 * The kind of on-disk backing a Workspace record has. DERIVED from `WORKSPACE_KINDS` so the direction
 * is forced: a member added to the tuple widens this type (and reds every exhaustive switch below),
 * whereas a hand-written union could silently disagree with the tuple. See the two-way exactness proof
 * next to `isScratchWorkspaceId`, which bites if the field is ever re-divorced from the tuple.
 */
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/**
 * The exhaustiveness backstop for any consumer that switches on `workspace.kind`.
 *
 * `tsconfig` here runs `strict` but NOT `noImplicitReturns`, so a `switch (workspace.kind)` that
 * forgets a case does not fail on its own — tsc just widens the return type to include `undefined` and
 * stays green. Route every such switch's `default` through this: with all kinds handled `kind` is
 * `never` here and it compiles; add a member and `kind` is that member (not `never`), the call fails to
 * type-check, and the omission cannot ship. The throw is only the runtime backstop — the compile error
 * at the call site is the guard.
 */
export function assertUnreachableWorkspaceKind(kind: never): never {
  throw new Error(`Unhandled workspace kind: ${JSON.stringify(kind)}`)
}

export type WorkspaceRecord = {
  id: string
  name: string
  hostId: string
  path: string
  kind: WorkspaceKind
  repoPath?: string
  branch?: string
}

/**
 * Two-way exactness between `WORKSPACE_KINDS` and `WorkspaceKind`. Each conditional is `true` only when
 * its containment holds and `never` otherwise, and `never` is not assignable to a `true` slot — so a
 * break in either direction is a compile error that names which half failed.
 *
 * `satisfies readonly WorkspaceKind[]` alone would prove only ⊆ (the tuple lists nothing that is not a
 * kind); a short tuple would pass it. This proves ⊇ as well (every kind is in the tuple), which is the
 * direction a member addition would break. `void` keeps the proof from reading as dead code.
 */
const _workspaceKindsAreExactlyTheUnion: [
  (typeof WORKSPACE_KINDS)[number] extends WorkspaceKind ? true : never,
  WorkspaceKind extends (typeof WORKSPACE_KINDS)[number] ? true : never
] = [true, true]
void _workspaceKindsAreExactlyTheUnion

/**
 * Whether a Workspace is a plain folder rather than a git worktree. The SSOT for the `kind === 'folder'`
 * test that the rebind, project-grouping and file-explorer paths used to inline. Centralising it in a
 * `switch` routed through `assertUnreachableWorkspaceKind` means a third kind cannot compile until
 * someone decides, HERE, whether it is folder-like — instead of each call site silently answering "yes"
 * (its `=== 'folder'` stays false) or "no" (its `!== 'folder'` stays true) for the new kind.
 *
 * A `switch` (not `kind === 'folder'`) is what makes it exhaustiveness-checked: TypeScript narrows the
 * `true` branch to a folder surface, which keeps the returned type predicate sound, and the `default`
 * reds the day a member is added.
 */
export function isFolderWorkspace(
  workspace: WorkspaceRecord
): workspace is WorkspaceRecord & { kind: 'folder' } {
  switch (workspace.kind) {
    case 'folder':
      return true
    case 'worktree':
      return false
    default:
      return assertUnreachableWorkspaceKind(workspace.kind)
  }
}

/**
 * Whether a Workspace is a git worktree rather than a plain folder. The SSOT for the `kind === 'worktree'`
 * / `kind !== 'worktree'` test that fan-out grouping and worktree removal used to inline. Same
 * exhaustiveness contract as {@link isFolderWorkspace}: a third kind must be classified here before it
 * compiles, rather than being silently swept into the "not a worktree" side at each call site.
 */
export function isWorktreeWorkspace(
  workspace: WorkspaceRecord
): workspace is WorkspaceRecord & { kind: 'worktree' } {
  switch (workspace.kind) {
    case 'worktree':
      return true
    case 'folder':
      return false
    default:
      return assertUnreachableWorkspaceKind(workspace.kind)
  }
}

/**
 * Reserved id for the always-present "no project" scratch workspace. It is a real
 * `kind:'folder'` record backed by a dedicated on-disk directory (so it satisfies the
 * strict config schema and every file/launch path works unchanged), rendered distinctly
 * in the sidebar. See `ConfigStore.get` (main) for provisioning.
 */
export function isScratchWorkspaceId(id: string | null | undefined): boolean {
  return id === SCRATCH_WORKSPACE_ID
}

export type TerminalThemeId = 'graphite' | 'catppuccin-mocha'

export type AppearanceConfig = {
  terminalTheme: TerminalThemeId
}

export type BrowserToolbarConfig = {
  selectElement: boolean
  screenshot: boolean
  devTools: boolean
  viewport: boolean
  more: boolean
}

export type BrowserConfig = {
  toolbar: BrowserToolbarConfig
}

/**
 * 当前配置形状的版本号，唯一真源。
 *
 * 本仓对配置演进的答案是**版本号 +1 然后重置**，不是往读取路径上叠回填（见测试
 * `resets retired config to current default without migration or fallback`）。凡改动配置形状到
 * 「旧文件读出来在语义上已经不对」的程度，就把这个数字 +1：低于它的磁盘配置被删掉重置成当前默认，
 * 等于它的正常校验，高于它的严格拒绝并保留文件（不猜未来形状）。
 *
 * 落在 contracts 而不是 config-store，是因为这个数字有**五**处消费者：本文件的 `AppConfig.version`
 * 类型、config-store 的 zod 字面量、`DEFAULT_CONFIG.version`、`get()` 里的重置阈值、以及 renderer
 * 那份浏览器预览用的 mock config。它们必须联动，而分居各处的联动常量必然 drift。
 *
 * 值得记下的是**谁在守它**：漏改这里的类型时，2058 条测试全绿（vitest 只转译不查类型），只有
 * `tsc --noEmit` 报错；而 tsc 是逐个挖的——修好类型才暴露出 api.ts 那处，一共两轮。所以这条的守卫是
 * 类型检查而不是测试，落在 `pnpm check` 的第一步（`pnpm typecheck` → 各包 `tsc --noEmit`）。只跑
 * `pnpm test` 验不出这一族漂移。
 */
export const CONFIG_VERSION = 9

export type AppConfig = {
  version: typeof CONFIG_VERSION
  hosts: HostConfig[]
  executors: Record<AgentExecutorId, AgentExecutorConfig>
  workspaces: WorkspaceRecord[]
  appearance: AppearanceConfig
  browser: BrowserConfig
  // Optional so the field can land without a version bump or a migration: `ConfigStore.get` fills the
  // explicit default when it is absent (same shape as the scratch-workspace back-fill), and every read
  // goes through resolveNotificationModeId, which also defaults. Absence therefore never means "off".
  notifications?: NotificationSettings
}

export type FileDocument = {
  path: string
  content: string
  revision: string
}

export type WorkspaceFileReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'deleted' }
  // The target exists but is a directory. Not an error: the caller reveals it in the file tree
  // instead of opening it as a document. Path detection is pure-string, so a directory path is a
  // valid clickable link; only Main can tell it is a directory, so Main says so here.
  | { status: 'directory' }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileWriteInput = {
  path: string
  content: string
  expectedRevision: string | null
}

export type WorkspaceFileWriteResult =
  | { status: 'written'; revision: string }
  | { status: 'conflict'; observedRevision: string | null }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileInvalidated = {
  workspaceId: string
  path: string
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
}

export type CreateWorkspacePathInput = {
  path: string
  kind: 'file' | 'directory'
}

export type WorkspacePathRef = {
  workspaceId: string
  path: string
}

export type MoveWorkspacePathInput = {
  source: WorkspacePathRef
  destination: WorkspacePathRef
}

export type WorkspacePathMoveResult =
  | { status: 'moved' }
  | {
      status: 'error'
      code: string
      message: string
      finalLocation: 'source' | 'unknown'
    }

export type CreateWorkspaceInput = {
  hostId: string
  path: string
  name?: string
}

export type CreateWorktreeForBranchInput = {
  workspaceId: string
  branch: string
  path: string
  /**
   * Create `branch` from the repository's current HEAD instead of requiring it to already exist.
   *
   * This is what makes a fan-out possible: opening N fresh branches for one bake-off. Without it a
   * caller must create every branch by hand first. When the branch already exists this is refused
   * rather than silently re-pointing it — moving someone's existing branch is never the intent.
   */
  createBranch?: boolean
}

/**
 * One fan-out: the same prompt taken down N lanes, each on its own new branch and worktree.
 *
 * `baseName` is only a stem — the concrete branch names and paths are derived in main by the single
 * planning source, never chosen here, so a re-run of the same request is reproducible and no caller
 * can mint a second naming scheme.
 */
export type RunFanOutInput = {
  workspaceId: string
  prompt: string
  count: number
  baseName: string
  /** Executors to spread the lanes across, reused cyclically when there are fewer than lanes. */
  executorIds: readonly string[]
}

/**
 * What became of one lane. Mirrors the orchestrator's own three states exactly — a partial failure is
 * neither reported as total failure nor dressed up as success, and a lane that built a worktree but
 * could not launch says whether that directory is still on disk, or it becomes an orphan nobody claims.
 *
 * `cleanup` is that answer, and it uses the same vocabulary as every other teardown ({@link
 * WorktreeRetention}) rather than a second one. It was a `worktreeRetained: boolean` until the three
 * retention states were separated, and the boolean got one of them backwards: a removal that deleted the
 * directory and then failed to withdraw the record came back as `retained: true`, i.e. "the directory is
 * still there" about a directory git had just deleted. A boolean cannot carry that distinction, so it is
 * not a boolean.
 *
 * `null` means the lane's worktree was handed back — nothing is left for anyone to decide about.
 */
export type FanOutLaneOutcome =
  | { status: 'launched'; branch: string; path: string; sessionId: string }
  | {
      status: 'launch-failed'
      branch: string
      path: string
      error: string
      cleanup: { retention: WorktreeRetention; reason: string } | null
    }
  | { status: 'worktree-failed'; branch: string; path: string; error: string }

/**
 * `rejected` carries the planner's own reason (a count below one, past the ceiling, or no executors).
 * `single` is not a failure: one lane is not a bake-off, so the caller should take the ordinary launch
 * path rather than pay for orchestration to compare a result with nothing.
 */
export type RunFanOutResult =
  | { kind: 'fanout'; lanes: FanOutLaneOutcome[] }
  | { kind: 'single'; executorId: string }
  | { kind: 'rejected'; reason: string }

export type KeepOneOfFanOutInput = {
  keepWorkspaceId: string
  removeWorkspaceIds: readonly string[]
}

/**
 * Remove one worktree on its own, outside any bake-off.
 *
 * `discardChanges` is the opt-in that says what it is: without it a worktree holding uncommitted work is
 * refused and git's own words come back as the reason. Losing an agent's output is the one outcome this
 * must never produce silently, so the caller has to ask for it in a second, separate act.
 */
export type RemoveWorktreeInput = {
  workspaceId: string
  discardChanges?: boolean
}

/**
 * How far a removal got before it stopped. Three genuinely different states of the world, and the reason
 * this is a field rather than something each consumer infers from the message text.
 *
 * `retained` used to carry only a `reason` string, and every consumer then guessed the cause from its own
 * context. All three guessed differently and one could not be right: the batch banner asserted "they
 * still hold changes" for every retained lane, the removal dialog offered "Discard uncommitted work?"
 * whatever git had actually said, and the fan-out's launch-failure cleanup assumed a failed removal meant
 * the directory survived. That last assumption is false in exactly one case — the one below that says so.
 */
export type WorktreeRetention =
  /**
   * The dirty-tree protection refused. The directory and its record are both intact, git's own words say
   * what is uncommitted, and discarding it explicitly is a real next step the user can take.
   */
  | 'uncommitted-changes'
  /**
   * Git failed, or a precondition did. The directory and its record are both intact and nothing was
   * discarded. There is nothing to discard here, so offering to is a lie — the reason is the whole answer.
   */
  | 'git-failed'
  /**
   * Git removed the worktree and the record could not be withdrawn. **The directory is gone** and the
   * record still points at it. This is the one retention where "still on disk" is false, so saying "it
   * still holds changes" here sends the user to look for work that is deleted.
   *
   * Removing again IS the way out, and it is the caller's next step rather than a dead end — but only
   * because the service now recognizes the state. Verified against real git (2.50.1, one fresh
   * repository per case): a retry after a completed removal exits **128** with `fatal: '<path>' is not
   * a working tree`, for plain and `--force` alike, because our own successful removal already
   * deregistered the entry. Git is telling us its half is done; there was never anything left for it
   * to do. What made this permanent was reading that as a failure — two of ours in a row, first the
   * dirty-tree probe running inside the vanished directory (128) and then the removal itself. The
   * service now skips the probe when the path provably does not exist, and treats that one sentence
   * from git as "already gone" when the directory is likewise gone, so the retry reaches the record.
   */
  | 'record-not-withdrawn'

/**
 * Mirrors the batch teardown's states rather than inventing a second vocabulary: `removed` means git
 * confirmed and the record is withdrawn, `retained` means the removal did not complete, with `retention`
 * saying how far it got and git's reason carried through unedited.
 *
 * A refusal is deliberately NOT a thrown error across this boundary. `retained` is an ordinary answer the
 * surface has to render — the whole point of the protection is that "there is work here" reaches the user.
 */
export type RemoveWorktreeOutcome =
  | { status: 'removed'; removedPath: string; config: AppConfig }
  | { status: 'retained'; retention: WorktreeRetention; reason: string }

/**
 * One loser's fate in a keep-the-winner teardown. `retention` is required rather than optional so that a
 * new construction site cannot compile without deciding which of the three states it is reporting.
 */
export type FanOutTeardownResult =
  | { status: 'removed'; workspaceId: string; removedPath: string }
  | { status: 'retained'; workspaceId: string; retention: WorktreeRetention; reason: string }

export type KeepOneOfFanOutOutcome = {
  keptWorkspaceId: string
  outcomes: FanOutTeardownResult[]
}

export type WorkspaceBranchRecord = {
  name: string
  worktreePath: string | null
  workspaceId: string | null
  isCurrent: boolean
}

export type WorkspaceBranchesSnapshot =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      branches: WorkspaceBranchRecord[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

export type WorkspaceSelectionResult = {
  config: AppConfig
  workspace: WorkspaceRecord
}

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

export type AgentLaunchInput = {
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  scratchTopicId?: string
  agentSessionId?: string
  createOperationId?: string
  prompt?: string
  /**
   * The choice ids the launcher picked for this Provider's declared launch options (DESCRIBE half in
   * {@link AgentCatalogEntry.launchOptions}). Core resolves each choice's argv at spawn; a choice the
   * Provider does not declare fails closed. Absent/empty leaves the Provider's own defaults untouched.
   */
  launchOptions?: LaunchOptionSelection
  cols?: number
  rows?: number
}

export type TerminalLaunchInput = {
  hostId: string
  workspacePath: string
  createOperationId?: string
  shellCommand?: string
  cols?: number
  rows?: number
}

export type AgentSessionControl = {
  kind: 'agent'
  hostId: string
  agentSessionId: string
  run: AgentMuxRunRef
}

export type TerminalSessionControl = {
  kind: 'terminal'
  hostId: string
  runId: string
  run: AgentMuxRunRef
}

export type SessionControl = AgentSessionControl | TerminalSessionControl

export type SessionStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
  /**
   * WHY an `exited` Run ended, carried verbatim from Core — synthesized there from the stop intent we
   * recorded and the code/signal the kernel observed. Absent unless the Run exited. Lets the surface tell
   * "you stopped it" (`user-stopped`) apart from "it died" (`crashed`) and from a bare 0 with no intent
   * (`unknown`), which we refuse to dress up as a clean finish.
   */
  exitReason?: AgentMuxRunExitReason
  continuity?: 'unavailable' | 'conflict'
  /**
   * WHY a continuity recovery could not happen, carried verbatim from Core.
   *
   * `continuity` alone answers "did it fail", and folding Core's distinct reasons into that single bit
   * is what makes every dead Agent read as one indistinguishable "resume unavailable". The three cases
   * call for different things from the user — a Provider that cannot resume at all is permanent, a
   * missing handle is about this one Session, and a conflict means something else already owns it — so
   * the reason has to survive the trip to the renderer. Absent for `conflict`, whose own two classes
   * ride on `continuityConflict` instead — see there for why they cannot share this field.
   */
  continuityReason?: AgentMuxAgentContinuityUnavailableReason
  /**
   * WHICH of Core's two conflict classes this is, carried verbatim.
   *
   * A separate field rather than another member of `continuityReason`: that field's union is Core's
   * *unavailable* reasons, and widening it would let a conflict value flow into the `unavailable`
   * branch of every existing switch — the compiler would stop objecting exactly where the two
   * concepts must stay apart.
   *
   * Why it must reach the renderer at all: the two classes call for **opposite** actions.
   * `session-run-changed` means this Agent Session is alive on a NEWER Run (something already resumed
   * it), so "wait" is a wrong instruction — waiting never brings back a Run that has been replaced;
   * the surface should re-read the live Session, which `sessions.refresh` does by stable
   * `agentSessionId`. `lifecycle-busy` means another lifecycle operation holds it right now, which is
   * transient — there waiting IS the right answer. Folding them lost that difference and told half the
   * users to wait for something that will never happen.
   */
  continuityConflict?: AgentMuxAgentContinuityConflictReason
}

type SessionSnapshotBase = {
  id: string
  hostId: string
  workspacePath: string
  label: string
  createdAt: number
  updatedAt: number
  processState: AgentMuxRunState
  interruptionReason?: string
  status: SessionStatus
  latestOutputBytes: number
}

/**
 * 「PTY 为什么消失」那一条事实，从任何带着它的形状里取出来。
 *
 * 这是 `runExitFacts`（Core 侧，管 exitCode / exitSignal / exitReason 那三条）的第四条同族事实，
 * 只是它落在 Session 本体而不是 `status` 里，所以不能塞进那个函数。为什么也要收成一处：这一段
 * `...(state === 'interrupted' && reason ? { interruptionReason: reason } : {})` 此前在三个地方
 * 各抄了一份——主进程的 agent 快照、主进程的 terminal 快照、renderer 的实时事件路径。
 *
 * 漏抄一处没有任何东西会红（字段可选、投影不要求在场），而后果是具体的：SessionPane 靠
 * `interruptionReason === 'daemon_restart'` 决定要不要自动重开一个终端。实时路径丢掉这条事实时，
 * 一个被 daemon 重启打死的终端不会自动恢复，只会摊着一个「Check again」——而按 PTY 已经没了的
 * 事实，那个按钮永远不可能成功。同一族事故已经发生过两次（`exitSignal`、`exitReason` 各一次，
 * 都是「崩溃当下看不到、reload 之后反而看到了」）。
 *
 * 入参收成「带这两条字段的任意对象」而不是具名类型：三个调用方的载体是三个不同的类型
 * （台账里的 run、线上的 process-state 事件），它们只在这两条上同名同义。
 */
export function runInterruptionFact(source: {
  state: AgentMuxRunState
  interruptionReason?: string
}): { interruptionReason?: string } {
  // 两个条件都必需：`interrupted` 之外的状态不该带这条（它只对「PTY 没了」有定义），而理由缺席时
  // 不能落成空串——空串会把「没说原因」伪装成「原因是空的」，也会让 daemon_restart 的判定读到假值。
  return source.state === 'interrupted' && source.interruptionReason
    ? { interruptionReason: source.interruptionReason }
    : {}
}

export type SessionSnapshot = SessionSnapshotBase & (
  | {
      kind: 'agent'
      providerId: AgentProviderId
      executorId: AgentExecutorId
      capabilities: AgentCapabilities
      /** Core-owned terminal capability fact; absent means no active degradation marker. */
      terminalCapability?: AgentTerminalCapabilityState
      pendingInteraction?: AgentMuxInteractionRequest
      /**
       * The launch-option choice ids that fixed this Agent's security posture at spawn, projected from
       * the Core Session record so a surface can show what this Agent is ALLOWED to do without asking
       * the user to remember what they picked. This is the DESCRIBE half only — ids, resolved against
       * the Provider's catalog declaration for labels. The argv these ids resolve to never leaves Core.
       * Absent when the create narrowed nothing, in which case the Agent runs on the Provider's own
       * defaults and no scope is displayed rather than a guess.
       */
      launchOptions?: LaunchOptionSelection
      /**
       * 最近一个 turn 的真实原生 token 用量，仅 usage 能力声明的 Provider（claude/codex）会有。缺席读作
       * "此 Provider 不报 token 用量"或"还没有一 turn 的用量"，UI 两者都不显示 0 或估算值。
       */
      turnUsage?: AgentTurnUsage
      control: AgentSessionControl
    }
  | { kind: 'terminal'; providerId: null; control: TerminalSessionControl }
)

export type RuntimeEvent = {
  type: 'core'
  hostId: string
  event: AgentMuxClientEvent
}

export type RuntimeSnapshot = {
  sessions: SessionSnapshot[]
  timelines: Record<string, AgentTimelineSnapshot>
  recoveryCandidates: AgentSessionRecoveryCandidate[]
}

export type AgentSessionRecoveryCandidate = {
  agentSessionId: string
  hostId: string
  workspacePath: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  capabilities: AgentCapabilities
  terminalCapability?: AgentTerminalCapabilityState
  label: string
  createdAt: number
  updatedAt: number
  run: AgentMuxRunRef
}

export type AgentLaunchResult = {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  timeline: AgentTimelineSnapshot
}

export type SessionAttachResult = {
  attachmentId: string
  session: SessionSnapshot
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type SessionRecoveryResult =
  | { kind: 'terminal-restarted'; session: SessionSnapshot }
  | { kind: 'reattachable' | 'resumed'; session: SessionSnapshot }
  | Extract<AgentMuxAgentContinuityResult, { kind: 'unavailable' | 'retired' | 'conflict' }>

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type ExecutorDetection = {
  executorId: AgentExecutorId
  providerId: AgentProviderId
  hostId: string
  installed: boolean
}

export type DesktopControlResponse =
  | { requestId: string; ok: true; result: AgentMuxControlResult }
  | { requestId: string; ok: false; error: AgentMuxControlError }

export type DesktopControlCancellation = {
  requestId: string
  code: AgentMuxControlErrorCode
  message: string
}

export const CONTROL_REQUEST_CHANNEL = 'agentmux:control-request'
export const CONTROL_CANCEL_CHANNEL = 'agentmux:control-cancel'
export const CONTROL_RESPONSE_CHANNEL = 'control:response'

export type BrowserSnapshot = {
  id: string
  navigationId: string
  profileId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: BrowserViewport
  error: string | null
}

export type BrowserProfileImportedSource = {
  browserLabel: string
  profileLabel: string
  importedAt: number
  importedCookies: number
  skippedCookies: number
}

export type BrowserProfileSummary = {
  id: string
  label: string
  createdAt: number
  isDefault: boolean
  source: BrowserProfileImportedSource | null
}

export type BrowserProfileImportSourceSummary = {
  token: string
  browserLabel: string
  profileLabel: string
}

export const BROWSER_VIEWPORT_PRESETS = {
  responsive: null,
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
} as const

export type BrowserViewport = keyof typeof BROWSER_VIEWPORT_PRESETS

export const BROWSER_PNG_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const BROWSER_PNG_MAX_BYTES = 18 * 1024 * 1024
export const BROWSER_PNG_MAX_PIXELS = 32 * 1024 * 1024
export const BROWSER_PNG_MAX_DIMENSION = 16_384

export type BrowserPng = {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

export type BrowserScreenshotCapture = {
  browserId: string
  navigationId: string
  image: BrowserPng
}

export type BrowserElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserElementSelection = {
  browserId: string
  navigationId: string
  pageTitle: string
  pageUrl: string
  tagName: string
  role: string
  accessibleName: string
  selector: string
  text: string
  nearbyText: string[]
  attributes: Record<string, string>
  html: string
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserAnnotationMarker = {
  id: string
  index: number
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserEvent =
  | { type: 'updated'; browser: BrowserSnapshot }
  | { type: 'closed'; id: string }

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export const WINDOW_RESIZE_EVENT_CHANNEL = 'agentmux:window-resize'
/** Main -> renderer: the user clicked a notification about this Agent Session. */
export const AGENT_ATTENTION_ACTIVATE_CHANNEL = 'agentmux:agent-attention-activate'

// The four push channels below used to be hand-written string literals at BOTH ends — the sender in
// main and the `ipcRenderer.on` in preload each spelled the name out. That is not symmetric with the
// request/response channels above, and it is a silent failure mode: `webContents.send` and
// `ipcRenderer.on` both take `channel: string`, so misspelling one side compiles clean, registers a
// listener nobody ever fires, and the feature simply goes dead with no error anywhere. The
// invoke/handle surface cannot drift this way because ipc-parity.test.ts compares the two sets — but
// that extractor only reads `handle(...)`/`invoke(...)` call nodes, so `.send`/`.on` were entirely
// outside its view. Naming each channel once here makes a rename a compile error at every use site.
/** Main -> renderer: one runtime/session event from the Agent runtime controller. */
export const SESSION_EVENT_CHANNEL = 'agentmux:session-event'
/** Main -> renderer: one embedded-browser lifecycle/navigation event. */
export const BROWSER_EVENT_CHANNEL = 'agentmux:browser-event'
/** Main -> renderer: a periodic CPU/RSS sample for the resource panel. */
export const RESOURCE_USAGE_CHANNEL = 'agentmux:resource-usage'
/** Main -> renderer: a watched workspace file changed on disk; re-read it. */
export const WORKSPACE_FILE_INVALIDATED_CHANNEL = 'agentmux:workspace-file-invalidated'

export type WindowResizeEvent = {
  active: boolean
}

export type AgentMuxDesktopApi = {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
  }
  hosts: {
    check(host: HostConfig): Promise<HostCheckResult>
  }
  workspaces: {
    chooseLocalFolder(): Promise<WorkspaceRecord | null>
    /** Pick a replacement directory while preserving the existing Workspace identity. */
    rebindLocalFolder(workspaceId: string): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    listBranches(workspaceId: string): Promise<WorkspaceBranchesSnapshot>
    openBranch(workspaceId: string, branch: string): Promise<WorkspaceSelectionResult>
    createWorktreeForBranch(input: CreateWorktreeForBranchInput): Promise<WorkspaceSelectionResult>
    removeWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome>
    runFanOut(input: RunFanOutInput): Promise<RunFanOutResult>
    keepOneOfFanOut(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome>
  }
  files: {
    readDirectory(workspaceId: string, path: string): Promise<WorkspaceDirectoryEntry[]>
    read(workspaceId: string, path: string): Promise<WorkspaceFileReadResult>
    write(workspaceId: string, input: WorkspaceFileWriteInput): Promise<WorkspaceFileWriteResult>
    observe(workspaceId: string, path: string): Promise<void>
    unobserve(workspaceId: string, path: string): Promise<void>
    onInvalidated(listener: (event: WorkspaceFileInvalidated) => void): () => void
    create(workspaceId: string, input: CreateWorkspacePathInput): Promise<void>
    move(input: MoveWorkspacePathInput): Promise<WorkspacePathMoveResult>
    delete(workspaceId: string, path: string): Promise<void>
    reveal(workspaceId: string, path: string): Promise<void>
  }
  scratch: {
    listTopics(workspaceId: string): Promise<ScratchTopicSnapshot[]>
    readTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot | null>
    ensureTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot>
    renameTitle(workspaceId: string, topicId: string, title: string): Promise<ScratchTopicSnapshot>
  }
  ui: {
    readClipboardText(): Promise<string>
    writeClipboardText(text: string): Promise<void>
    writeClipboardImage(image: BrowserPng): Promise<void>
    openExternal(url: string): Promise<void>
    /** Native file picker. Returns absolute paths, or null when dismissed. */
    chooseFiles(input?: { defaultPath?: string }): Promise<string[] | null>
    /** Persists pasted image bytes and returns the path an Agent can read them from. */
    savePastedImage(input: { bytes: Uint8Array; extension: string }): Promise<string>
    /**
     * Ask Desktop main to raise a native notification about one Agent Session.
     *
     * The renderer decides WHETHER a state change deserves a person's attention and passes the chosen
     * dwell `mode`; main only delivers, because only main can reach the OS. The result distinguishes
     * `shown` from `unsupported`, and within `shown` reports whether the requested mode was honoured
     * or the platform downgraded it — so a caller never assumes a persistent banner it did not get.
     */
    notifyAgentAttention(input: {
      sessionId: string
      title: string
      body: string
      mode: NotificationModeId
    }): Promise<NotificationDelivery>
    /**
     * Fires when the user clicks one of those notifications, carrying the Session id it was about.
     * Main focuses the window; WHERE to go inside it stays with the renderer, which owns View/Region.
     */
    onAgentAttentionActivate(listener: (sessionId: string) => void): () => void
    getZoomFactor(): number
    onWindowResize(listener: (event: WindowResizeEvent) => void): () => void
  }
  providers: {
    list(): Promise<AgentCatalogEntry[]>
  }
  executors: {
    detect(executorId: AgentExecutorId, hostId: string): Promise<ExecutorDetection>
  }
  control: {
    onRequest(listener: (
      request: AgentMuxControlRequest,
      signal: AbortSignal
    ) => AgentMuxControlResult | Promise<AgentMuxControlResult>): () => void
  }
  sessions: {
    snapshot(): Promise<RuntimeSnapshot>
    launchAgent(input: AgentLaunchInput): Promise<AgentLaunchResult>
    launchTerminal(input: TerminalLaunchInput): Promise<SessionSnapshot>
    timeline(session: AgentSessionControl): Promise<AgentTimelineSnapshot>
    attach(session: SessionControl, afterByte?: number): Promise<SessionAttachResult>
    detach(attachmentId: string): Promise<void>
    write(session: SessionControl, data: AgentMuxRunInputData): Promise<void>
    submitPrompt(session: AgentSessionControl, prompt: string): Promise<void>
    respondInteraction(
      session: AgentSessionControl,
      response: AgentMuxInteractionResponse
    ): Promise<void>
    // Set the Agent's live security posture in-band. The renderer sends the picked mode id; Core resolves
    // the Provider's declared keystroke and writes it over the PTY-input transport (bytes never cross IPC).
    setPosture(session: AgentSessionControl, modeId: string): Promise<void>
    resume(session: AgentSessionControl, prompt: string, operationId: string): Promise<SessionSnapshot>
    acknowledge(session: SessionControl, throughByte: number): Promise<void>
    interrupt(session: SessionControl): Promise<void>
    resize(attachmentId: string, cols: number, rows: number): Promise<void>
    refresh(session: SessionControl): Promise<SessionSnapshot>
    // Recover a session whose PTY was lost (daemon_restart / tmux_* interruption, or exit).
    // The physical PTY cannot be revived, so this mints a *fresh* Run in the same cwd:
    // terminals relaunch the host shell; agents resume via provider-native resume. If the
    // Transport loss remains an error and never authorizes resume.
    // Returns the Core continuity disposition; the renderer rebinds only an attached/resumed
    // Agent or a newly restarted raw Terminal.
    recover(session: SessionControl, workspacePath?: string): Promise<SessionRecoveryResult>
    stop(session: SessionControl): Promise<void>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  /**
   * 进程资源用量。**只在有人订阅时才采样**——折叠态一次 `ps` 都不发生。
   *
   * 做成订阅而不是"查一次"，是因为零开销这件事必须由生命周期本身保证：给一个查询接口，
   * 调用方一开定时器就又回到了常驻轮询，而那不会让任何测试变红。
   */
  resourceUsage: {
    /** 开始采样并接收快照，返回退订函数；最后一个订阅者离开时采样停止。 */
    subscribe(listener: (snapshot: UsageSnapshot) => void): () => void
  }
  browser: {
    create(id: string, url: string): Promise<BrowserSnapshot>
    navigate(id: string, url: string): Promise<BrowserSnapshot>
    back(id: string): Promise<BrowserSnapshot>
    forward(id: string): Promise<BrowserSnapshot>
    reload(id: string): Promise<BrowserSnapshot>
    switchProfile(id: string, profileId: string): Promise<BrowserSnapshot>
    listProfiles(): Promise<BrowserProfileSummary[]>
    createProfile(label: string): Promise<BrowserProfileSummary>
    deleteProfile(profileId: string): Promise<void>
    detectProfileImportSources(): Promise<BrowserProfileImportSourceSummary[]>
    importProfile(sourceToken: string, label: string): Promise<BrowserProfileSummary>
    openDevTools(id: string): Promise<void>
    setViewport(id: string, viewport: BrowserViewport): Promise<BrowserSnapshot>
    captureScreenshot(id: string): Promise<BrowserScreenshotCapture>
    selectElement(id: string): Promise<BrowserElementSelection | null>
    cancelElementSelection(id: string): Promise<void>
    setAnnotationMarkers(id: string, navigationId: string, markers: BrowserAnnotationMarker[]): Promise<void>
    setBounds(id: string, bounds: BrowserBounds | null): Promise<void>
    /** Release only the Main-owned native page surface; the Renderer Region remains present. */
    release(id: string): Promise<void>
    /** Rebuild a previously released native page from the retained Region projection. */
    restore(id: string, input: {
      profileId: string
      viewport: BrowserViewport
    }): Promise<BrowserSnapshot>
    close(id: string): Promise<void>
    onEvent(listener: (event: BrowserEvent) => void): () => void
  }
}

export type AgentMuxPreloadApi = Omit<AgentMuxDesktopApi, 'control'> & {
  control: {
    onRequest(listener: (request: AgentMuxControlRequest) => void): () => void
    onCancellation(listener: (cancellation: DesktopControlCancellation) => void): () => void
    respond(response: DesktopControlResponse): void
  }
  /**
   * Local Git source control. Lives on the preload API only, not the shared `AgentMuxDesktopApi`,
   * because it is a Desktop-main capability with no meaningful web-preview mock — the renderer reaches
   * it through `window.agentmux.git`, never through the shared mock `api`.
   *
   * **This surface speaks two path coordinate systems, and the parameter names say which.** They differ
   * whenever a workspace is a subfolder of its repository, and confusing them is silent — both are
   * well-formed relative paths, so a mix-up reads a same-named file somewhere else in the repo instead
   * of erroring:
   *   - `repoPath` — repo-root-relative, porcelain's own coordinate. `status` reports these
   *     ({@link GitFileChange.path}), and the write verbs hand the same value straight back to a
   *     pathspec. Everything porcelain names is reachable, including files outside the workspace.
   *   - `workspacePath` — workspace-relative, the coordinate everything the user points at uses: the
   *     file tree's nodes, `files.read`, `openFile`, the document key, the editor tab identity.
   *
   * `diff` is the one method on the workspace side of that line, because a diff is an *editor* surface:
   * its path is the open document's path. A caller holding porcelain output must therefore convert
   * before calling it — `workspaceRelativeGitPath` in the renderer does that, and returns null for the
   * changes a subfolder workspace cannot show at all.
   */
  git: {
    status(workspaceId: string): Promise<GitStatusResult>
    stage(workspaceId: string, repoPath: string): Promise<void>
    commit(workspaceId: string, message: string): Promise<void>
    diff(workspaceId: string, workspacePath: string): Promise<GitFileDiff>
    unstage(workspaceId: string, repoPath: string): Promise<void>
    discard(workspaceId: string, repoPath: string, untracked: boolean): Promise<void>
    push(workspaceId: string, options?: GitPushOptions): Promise<GitRemoteResult>
    pull(workspaceId: string, options?: { strategy?: GitPullStrategy }): Promise<GitRemoteResult>
    fetch(workspaceId: string, options?: GitRemoteOptions): Promise<GitRemoteResult>
    aheadBehind(workspaceId: string): Promise<GitAheadBehind>
  }
  /**
   * GitHub CLI capability probing. Like `git`, a Desktop-main capability with no web-preview mock —
   * the renderer reaches it through `window.agentmux.gh`. Only *probes* `gh auth status`; it never
   * reads or persists a token, so it adds no credential-storage surface.
   *
   * There is deliberately no `authStatus` leaf here. `GhService.authStatus` still exists and runs — but
   * only *inside* main, as the first step of `prReadiness` — because the auth answer must be read
   * together with the branch facts, not on its own (see {@link PrReadiness}). Exposing it separately
   * re-opened the drift that type explicitly closes: a renderer could read auth, then read the branch,
   * and act on a pair that was never simultaneously true. Ask `prReadiness`; `auth` is one of its fields.
   */
  gh: {
    prReadiness(workspaceId: string): Promise<PrReadiness>
    createPullRequest(workspaceId: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>
  }
}
