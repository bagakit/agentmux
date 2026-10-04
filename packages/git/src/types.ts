/** Host-neutral Git data and wire contracts. Paths state their repository or workspace coordinate. */

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

/** Read-only association evidence. Unavailable observation is never "no remote". */
export type GitProjectIdentityResult =
  | { kind: 'known'; hostId: string; repoPath: string; identities: string[] }
  | { kind: 'no-remote'; hostId: string; repoPath: string }
  | { kind: 'not-a-git-repository'; hostId: string; workspacePath: string }
  | { kind: 'unavailable'; hostId: string; workspacePath: string; reason: string }

export interface GitProjectIdentityApi {
  /** Inspect the original Workspace's ExecutionHost and configured fetch source; never fetch. */
  projectIdentity(workspaceId: string): Promise<GitProjectIdentityResult>
}

/**
 * One side of a single-file diff: HEAD/worktree or pinned comparison commits. Absent is a first-class
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

export type GitBranchCompareMode = 'merge-base' | 'two-point'

export type GitBranchCompareInput = {
  // Names from WorkspaceBranchesSnapshot.branches, without the refs/heads/ prefix.
  // Main validates and resolves exact refs/heads/<name>^{commit}; no arbitrary rev expression.
  baseBranch: string
  targetBranch: string
  mode: GitBranchCompareMode
}

export type GitBranchComparisonSnapshot = {
  // Main derives this provenance from the configured Workspace and actual Git repository.
  // On every subsequent read it must match the Workspace's current host/repository.
  hostId: string
  repoPath: string
  mode: GitBranchCompareMode
  baseBranch: string
  targetBranch: string
  // Complete immutable commit OIDs from the initial comparison. Never re-resolve labels on file read.
  baseOid: string
  targetOid: string
  // baseOid for two-point; actual merge-base commit for merge-base.
  comparisonBaseOid: string
}

export type GitBranchChange = {
  // Both coordinates are repo-root-relative, exactly from name-status -z; never FileService paths.
  path: string
  origPath: string | null
  change: 'added' | 'deleted' | 'modified' | 'renamed' | 'type-changed'
}

export type GitBranchComparisonResult =
  | {
      kind: 'ready'
      snapshot: GitBranchComparisonSnapshot
      entries: GitBranchChange[]
      // Actual credential-scrubbed Git diagnostics, including a bounded rename-detection warning.
      // Empty means Git emitted none. These are transient result data, not a new notice registry.
      warnings: string[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

// The same minimal descriptor crosses IPC and lives in the persisted git-diff surface.
// No blob payload, loading flag, error state, whole change list or second snapshot identity.
export type GitBranchDiffDescriptor = {
  snapshot: GitBranchComparisonSnapshot
  file: Pick<GitBranchChange, 'path' | 'origPath'>
}

export interface GitBranchComparisonApi {
  // Existing handle('git:compareBranches') -> GitService.compareBranches(workspaceId,input,config).
  // Invalid branch / no merge base / timeout / output or row limit rejects with scrubbed error.
  // A ready empty list is exclusively a successful actual zero-change comparison.
  compareBranches(workspaceId: string, input: GitBranchCompareInput): Promise<GitBranchComparisonResult>

  // Existing handle('git:branchDiff') -> GitService.branchDiff(workspaceId,descriptor,config).
  // Read only comparisonBaseOid:(origPath ?? path) and targetOid:path in the configured repo.
  // Added/deleted absence is explicit; unrelated read failure rejects, never becomes empty content.
  // Returns the existing old/new renderer shape. Its binary flag already includes the read-size cap;
  // the shared canvas must say "binary or too large for textual diff", not claim a specific cause.
  branchDiff(workspaceId: string, descriptor: GitBranchDiffDescriptor): Promise<GitFileDiff>
}

/** Existing refs observed in one repository. Tags decorate commits; they never add history roots. */
export type GitHistoryRef = { name: string; kind: 'local' | 'remote' | 'head' | 'tag'; oid: string }
export type GitHistorySnapshot = {
  hostId: string
  repoPath: string
  selectedRef: string | null
  roots: string[]
  refs: GitHistoryRef[]
  checkedAt: number
}
export type GitHistoryCursor = { snapshot: GitHistorySnapshot; offset: number }
export type GitHistoryInput = { ref?: string | null; cursor?: GitHistoryCursor; limit?: number }
export type GitHistoryCommit = {
  oid: string
  parents: string[]
  subject: string
  author: string
  authoredAt: number | null
  refs: GitHistoryRef[]
}
export type GitHistoryResult =
  | { kind: 'ready'; snapshot: GitHistorySnapshot; commits: GitHistoryCommit[]; nextCursor: GitHistoryCursor | null }
  | { kind: 'not-a-git-repository'; hostId: string; workspacePath: string }
export interface GitHistoryApi {
  /** Metadata only, fixed heads + remote-tracking + HEAD. No fetch, index writes or file blobs. */
  history(workspaceId: string, input?: GitHistoryInput): Promise<GitHistoryResult>
}

/** One immutable commit and the direct parent selected for its file comparison. */
export type GitCommitDetailsInput = { oid: string; parentOid?: string }
export type GitCommitSnapshot = {
  hostId: string
  repoPath: string
  commitOid: string
  parentOid: string | null
}
export type GitCommitDetails = GitHistoryCommit & {
  /** Full decoded commit message, including body and original line breaks. */
  message: string
  committer: string
  committedAt: number | null
}
export type GitCommitDetailsResult =
  | { kind: 'ready'; snapshot: GitCommitSnapshot; commit: GitCommitDetails;
      entries: GitBranchChange[]; warnings: string[] }
  | { kind: 'not-a-git-repository'; hostId: string; workspacePath: string }
export type GitCommitDiffDescriptor = {
  kind: 'commit'
  snapshot: GitCommitSnapshot
  file: Pick<GitBranchChange, 'path' | 'origPath'>
}
/** Original branch descriptors remain valid durable data. */
export type GitDiffDescriptor = GitBranchDiffDescriptor | GitCommitDiffDescriptor
export interface GitCommitApi {
  commitDetails(workspaceId: string, input: GitCommitDetailsInput): Promise<GitCommitDetailsResult>
  commitDiff(workspaceId: string, descriptor: GitCommitDiffDescriptor): Promise<GitFileDiff>
}
