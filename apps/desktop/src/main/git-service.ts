import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type {
  AppConfig,
  GitAheadBehind,
  GitDiffSide,
  GitFileChange,
  GitFileDiff,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions,
  GitRemoteResult,
  GitStatusResult,
  WorkspaceRecord
} from '../shared/contracts.js'

/**
 * The one place git's own error text is trusted enough to show a person. Git can echo a remote URL
 * with credentials embedded in it; the secret must never reach a log line or the UI.
 *
 * Both userinfo shapes are redacted, because both carry a secret: the pair form
 * (`https://alice:ghp_secret@github.com/…`) and the bare-token form
 * (`https://ghp_secret@github.com/…`), which is how CI and `git remote set-url origin
 * https://$TOKEN@github.com/…` embed a PAT — there the entire userinfo IS the token, so a rule that
 * only fired on a colon would leak the very case that appears most often.
 *
 * The scheme prefix is what keeps this safe to widen: an ssh remote is written `git@github.com:o/r`
 * with no `://`, so it never matches and a bare `git@…` username survives intact — it is an identity,
 * not a secret, and redacting it would destroy the only useful detail in the message.
 * Pure so the redaction itself is unit-testable without running git.
 */
export function scrubGitCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1***@')
}

/**
 * Parse `git status --porcelain=v1 -z --branch --untracked-files=all` output.
 *
 * `-z` is the whole point: entries are separated by NUL, which disables git's C-quoting, so a path
 * with a space, a quote, a newline, or CJK bytes arrives verbatim between two NULs — no unescaping,
 * no locale. The parser therefore never sees a filename it has to decode, only bytes to slice.
 *
 * Layout: an optional `## <branch-info>` header token, then one `XY<space><path>` token per change.
 * A rename or copy (`R`/`C` in either column) spends a second token on the original path, which this
 * consumes in lockstep. Pure — it takes a string and returns data, so every shape below is testable
 * against a fixed string with no git process in the loop.
 */
export function parseGitStatusPorcelain(
  output: string
): { branch: string | null; changes: GitFileChange[] } {
  const tokens = output.split('\0')
  let branch: string | null = null
  const changes: GitFileChange[] = []
  let cursor = 0
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    cursor += 1
    if (!token) continue
    if (token.startsWith('## ')) {
      branch = parseBranchHeader(token.slice(3))
      continue
    }
    // `XY<space><path>`: two status columns, a separator, then the path. Anything shorter is not a
    // status entry and is skipped rather than mis-sliced.
    if (token.length < 4) continue
    const index = token[0]!
    const worktree = token[1]!
    const path = token.slice(3)
    const renameOrCopy = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
    let origPath: string | null = null
    if (renameOrCopy && cursor < tokens.length) {
      origPath = tokens[cursor]!
      cursor += 1
    }
    changes.push({
      path,
      origPath,
      index,
      worktree,
      // X is the index-vs-HEAD column: any non-blank, non-`?` mark means something is staged.
      staged: index !== ' ' && index !== '?',
      // Y is the worktree-vs-index column.
      unstaged: worktree !== ' ' && worktree !== '?',
      untracked: index === '?' && worktree === '?'
    })
  }
  return { branch, changes }
}

/**
 * The current branch out of the `--branch` header. `## main`, `## main...origin/main [ahead 1]`, and
 * `## No commits yet on main` all resolve to `main`; a detached `## HEAD (no branch)` resolves to
 * null. Branch names cannot contain spaces or `...`, so splitting on those recovers the local name.
 */
function parseBranchHeader(header: string): string | null {
  if (header.startsWith('HEAD (no branch)')) return null
  const noCommits = header.match(/^No commits yet on (.+)$/)
  const text = noCommits ? noCommits[1]! : header
  const local = text.split('...')[0]!.split(' ')[0]!.trim()
  return local || null
}

// A repository that git itself reports as absent — the exact fatal it prints for a plain directory.
// Matched as text (not inferred from the exit code) because deciding "not a repo" is the one place a
// non-zero exit has a specific, benign meaning; every other non-zero exit is a real error to surface.
const NOT_A_GIT_REPOSITORY = /^fatal: not a git repository \(or any of the parent directories\): .+\n?$/

// Non-interactive, non-localized environment for every git invocation.
// - LC_ALL/LANG=C: porcelain output is parsed by structure and known phrases, so a translated git
//   would break the parser. The locale lock keeps the bytes predictable.
// - GIT_TERMINAL_PROMPT=0: this runs in an unattended main process, so git must fail fast rather than
//   block forever reading a credential prompt from a terminal that is not there.
// - GIT_SSH_COMMAND BatchMode: the same no-hang guarantee for any transport that reaches ssh. Local
//   status/stage/commit never touch ssh; the baseline is set here so remote verbs added later inherit
//   it instead of each rediscovering the hang.
const GIT_NONINTERACTIVE_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
} as const

const GIT_RUN_OPTIONS = {
  env: GIT_NONINTERACTIVE_ENV,
  timeoutMs: 20_000,
  maxOutputBytes: 2 * 1024 * 1024
} as const

// Network verbs (push/pull/fetch) get a longer clock and a larger output ceiling than local plumbing:
// a real transfer can legitimately take longer than a `rev-parse`, and the no-hang guarantee comes from
// the non-interactive env (BatchMode ssh + GIT_TERMINAL_PROMPT=0), not from a short timeout. Local
// plumbing this task adds (rev-parse/rev-list for ahead-behind) keeps the short `GIT_RUN_OPTIONS` bound.
const GIT_REMOTE_RUN_OPTIONS = {
  env: GIT_NONINTERACTIVE_ENV,
  timeoutMs: 120_000,
  maxOutputBytes: 4 * 1024 * 1024
} as const

/**
 * The one place a remote git failure is turned into something a person can act on. Pure: it takes the
 * captured stdout/stderr and returns a classification, so every branch below is unit-testable with a
 * fixed string and no git process in the loop.
 *
 * Two rules make this safe rather than merely convenient:
 *   1. Every returned message is scrubbed of credentials first — git echoes the remote URL, which can
 *      carry `user:token@`, into both the rejection line and the "failed to push" line. The token must
 *      never reach the UI or a log, so redaction happens before any text leaves this function.
 *   2. Only a `fatal:`-prefixed line matching a known "no upstream" phrase is swallowed as no-upstream.
 *      A hook or progress line can echo the words "no upstream" without being a benign missing-upstream;
 *      requiring the fatal: prefix keeps an auth/corruption error from masquerading as no-upstream and
 *      being silently hidden.
 */
export function classifyGitRemoteError(result: { stdout: string; stderr: string }): GitRemoteResult {
  const raw = `${result.stderr}\n${result.stdout}`
  const message = scrubGitCredentials((result.stderr.trim() || result.stdout.trim()))
  if (NO_UPSTREAM_FATAL.test(raw)) return { kind: 'no-upstream', message }
  if (NON_FAST_FORWARD.test(raw)) return { kind: 'non-fast-forward', message }
  if (DIVERGED.test(raw)) return { kind: 'diverged', message }
  return { kind: 'error', message }
}

// A push git itself refused because the local tip is behind its remote counterpart — the actionable
// "remote has updates, sync first" case, distinct from a transport or auth failure.
const NON_FAST_FORWARD = /\(non-fast-forward\)|\bUpdates were rejected because\b/

// A pull that cannot be reconciled without a merge/rebase decision. The first phrase is `--ff-only`
// refusing; the second is a bare pull on a host with no pull.rebase/pull.ff policy, which is exactly
// the hard-fail the unpinned auto-merge fallback exists to absorb.
const DIVERGED = /fatal: Not possible to fast-forward|fatal: Need to specify how to reconcile divergent branches/

// The two shapes git prints when the current branch has no upstream to push to or compare against.
// Anchored to the `fatal:` prefix so only git's own fatal — never an echoed hook/progress line — is
// treated as benign missing-upstream.
const NO_UPSTREAM_FATAL =
  /fatal: (no upstream configured for branch|The current branch .+ has no upstream branch|You are not currently on a branch)/

// The pull strategy the caller pins, mapped to the git flag. `auto` (the default) pins nothing and
// lets git's own config decide — which is what makes the unpinned-only auto-merge fallback meaningful.
const STRATEGY_FLAG: Record<GitPullStrategy | 'auto', string | null> = {
  auto: null,
  'ff-only': '--ff-only',
  merge: '--no-rebase',
  rebase: '--rebase'
}

/**
 * Reject a ref-like input (remote name, branch, refspec) that could be read as an option. Refs have no
 * pathspec escape hatch the way file paths do (`:(literal)`), so the only safe rule is an outright ban
 * on a leading `-` plus the control/space/`~^:?*[` bytes git forbids in a ref anyway. A path uses
 * `toLiteralPathspec` instead; a ref uses this.
 */
function assertSafeRef(value: string, label: string): string {
  if (value === '') throw new Error(`A ${label} is required`)
  if (value.startsWith('-')) throw new Error(`A ${label} cannot begin with "-"`)
  if (/[\0\n\r\t ~^:?*[\\]/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

/**
 * Turn a user-supplied path into a pathspec that git cannot misread as a flag or a pattern.
 *
 * `:(literal)` disables git's pathspec magic so `*`, `:`, and friends are matched byte-for-byte, and
 * combined with a `--` terminator in the argv, a file literally named `-x` is still a path and never
 * an option. This is the correct defense for paths — an outright ban on `-`-prefixed names would break
 * real files — whereas refs (added in later tasks) have no pathspec and must reject `-` instead.
 */
function toLiteralPathspec(path: string): string {
  if (path === '') throw new Error('A file path is required')
  if (path.includes('\0')) throw new Error('Invalid file path')
  return `:(literal)${path}`
}

/**
 * The two fatals `git show HEAD:<path>` prints when the path is not in HEAD: it was never committed
 * (`does not exist in`), or it is on disk but untracked (`exists on disk, but not in`). Both mean the
 * old side is absent — which is exactly how an added file is drawn. This is anchored to those precise
 * phrases so that any OTHER fatal (an unreadable tree, a corrupt object) is NOT mistaken for absence
 * and swallowed into an empty diff; it must surface as the real error it is.
 */
const PATH_ABSENT_IN_HEAD = /^fatal: path '.+' (?:does not exist in|exists on disk, but not in) '[^']+'/m

/** The largest blob or worktree file held as diffable text; anything larger is reported as binary. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/**
 * One side of a diff as read from the working tree: absent (the file is not on disk), present but too
 * large to hold as text, or present with its raw bytes. Kept separate from {@link GitDiffSide} so the
 * binary/text decision — a NUL scan on the bytes — lives in one pure place.
 */
export type WorktreeFileRead =
  | { present: false }
  | { present: true; oversized: true }
  | { present: true; oversized: false; bytes: Buffer }

/** Reads a worktree file by absolute path. Injectable so the diff logic is testable without a disk. */
export type WorktreeReader = (absolutePath: string) => Promise<WorktreeFileRead>

/**
 * The default worktree reader: node fs, with the same size ceiling git blobs get. A missing file is
 * `present: false` (that is how a deleted file is drawn), a non-file (a directory) likewise, and a file
 * past the ceiling is `oversized` rather than read into memory.
 */
const defaultWorktreeReader: WorktreeReader = async (absolutePath) => {
  let info
  try {
    info = await stat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false }
    throw error
  }
  if (!info.isFile()) return { present: false }
  if (info.size > MAX_DIFF_BYTES) return { present: true, oversized: true }
  return { present: true, oversized: false, bytes: await readFile(absolutePath) }
}

/** True when a caught error is the executor's output-byte-limit rejection — treat that blob as binary. */
function isOutputLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'COMMAND_OUTPUT_LIMIT'
  )
}

/** Fold a worktree read into a diff side, deciding binary from a NUL scan of the actual bytes. */
function worktreeReadToDiffSide(read: WorktreeFileRead): GitDiffSide {
  if (!read.present) return { present: false }
  if (read.oversized) return { present: true, binary: true }
  if (read.bytes.includes(0)) return { present: true, binary: true }
  return { present: true, binary: false, text: read.bytes.toString('utf8') }
}

/** Decide binary from a NUL scan of blob text git printed for the HEAD side. */
function blobTextToDiffSide(text: string): GitDiffSide {
  if (text.includes('\0')) return { present: true, binary: true }
  return { present: true, binary: false, text }
}

/**
 * Build a structured single-file diff from its two sides. Pure: `change` is derived from which sides
 * are present and, when both are present text, whether the text differs. A binary side forces a
 * present/present pair to `modified` (there is no text to compare), and never carries raw bytes.
 */
export function buildFileDiff(path: string, oldSide: GitDiffSide, newSide: GitDiffSide): GitFileDiff {
  const binary = (oldSide.present && oldSide.binary) || (newSide.present && newSide.binary)
  return { path, old: oldSide, new: newSide, binary, change: classifyDiffChange(oldSide, newSide) }
}

function classifyDiffChange(oldSide: GitDiffSide, newSide: GitDiffSide): GitFileDiff['change'] {
  if (!oldSide.present && !newSide.present) return 'unchanged'
  if (!oldSide.present) return 'added'
  if (!newSide.present) return 'deleted'
  if (oldSide.binary || newSide.binary) return 'modified'
  return oldSide.text === newSide.text ? 'unchanged' : 'modified'
}

/**
 * Resolve a repo-relative path to an absolute one that is provably inside the worktree, or throw.
 *
 * This is the guard that stands in front of `git clean`, the one verb that deletes files from disk: a
 * `../` traversal or an absolute path must never let a discard reach outside the repository root. Pure
 * (path arithmetic only, no fs), so the traversal rejection is unit-testable on its own.
 */
export function assertInWorktree(repoRoot: string, relativePath: string): string {
  if (relativePath === '') throw new Error('A file path is required')
  if (relativePath.includes('\0')) throw new Error('Invalid file path')
  const root = resolve(repoRoot)
  const absolute = resolve(root, relativePath)
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`Path is outside the worktree: ${relativePath}`)
  }
  return absolute
}


/**
 * Local git source control: read what changed on the current branch, stage one file, commit.
 *
 * Sits in Desktop main beside `WorktreeService` and, like it, never spawns a process itself — it runs
 * everything through the injected `ExecutionHost.run('git', argv)` seam, which is what lets the whole
 * class be driven by a fake executor in tests. All parsing lives in the pure functions above; this
 * class only assembles hardened argv and normalizes errors.
 */
export class GitService {
  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly readWorktreeFile: WorktreeReader = defaultWorktreeReader
  ) {}

  async status(workspaceId: string, config: AppConfig): Promise<GitStatusResult> {
    const workspace = this.workspace(config, workspaceId)
    const host = this.hostFor(workspace.hostId)
    const repoPath = await this.resolveRepoPath(host, workspace.path)
    if (repoPath === null) {
      return { kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path }
    }
    // Run at the working-tree root so porcelain's root-relative paths and the root-relative pathspec
    // used by `stage` describe the same file. `--untracked-files=all` lists new files individually
    // rather than collapsing a new directory into one entry the user cannot stage piecemeal.
    const result = await host.run(
      'git',
      ['-C', repoPath, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
      GIT_RUN_OPTIONS
    )
    this.assertGit(result, 'Could not read Git status')
    const { branch, changes } = parseGitStatusPorcelain(result.stdout)
    return { kind: 'git-repository', hostId: workspace.hostId, repoPath, branch, changes }
  }

  async stage(workspaceId: string, path: string, config: AppConfig): Promise<void> {
    const workspace = this.workspace(config, workspaceId)
    const host = this.hostFor(workspace.hostId)
    // Build the pathspec before resolving the repo, so an empty or NUL-bearing path fails loudly
    // without a git round-trip.
    const pathspec = toLiteralPathspec(path)
    const repoPath = await this.resolveRepoPath(host, workspace.path)
    if (repoPath === null) throw new Error('Workspace is not a Git repository')
    const result = await host.run(
      'git',
      // `--` terminates options; `:(literal)<path>` makes the argument an exact path. Together they
      // close both shell injection (argv is an array, never a string) and flag injection.
      ['-C', repoPath, 'add', '--', pathspec],
      GIT_RUN_OPTIONS
    )
    this.assertGit(result, 'Could not stage the file')
  }

  async commit(workspaceId: string, message: string, config: AppConfig): Promise<void> {
    const workspace = this.workspace(config, workspaceId)
    const text = message.trim()
    if (!text) throw new Error('A commit message is required')
    const host = this.hostFor(workspace.hostId)
    const repoPath = await this.resolveRepoPath(host, workspace.path)
    if (repoPath === null) throw new Error('Workspace is not a Git repository')
    const result = await host.run(
      'git',
      // The message goes in over stdin (`--file=-`), never in argv: that removes any length limit and
      // any chance of a message that starts with `-` being read as an option. `--cleanup=whitespace`
      // pins behavior regardless of the host's `commit.cleanup` config, so a line the user typed
      // starting with `#` is kept rather than silently dropped.
      ['-C', repoPath, 'commit', '--file=-', '--cleanup=whitespace'],
      { ...GIT_RUN_OPTIONS, input: text }
    )
    this.assertGit(result, 'Could not create the commit')
  }

  /**
   * A structured single-file diff: the HEAD blob (old side) paired with the worktree file (new side),
   * built by reading blobs — never by parsing unified-diff text.
   *
   * The old side comes from `git show --end-of-options HEAD:<path>`. Two things make this correct:
   *   - `--end-of-options` guarantees a path beginning with `-` is still read as `HEAD:<path>`, never
   *     as a flag; the rev is a single argument, so there is no pathspec to escape here.
   *   - A failure is NOT swallowed into an empty diff. Only git's precise "path … does not exist in
   *     HEAD" / "exists on disk, but not in HEAD" fatal is read as "old side absent" (an added file).
   *     Any other failure — an unreadable tree, a corrupt object — is re-thrown. "Can't read it" is the
   *     signal that renders an added/deleted file, so it must never be a silent fallback to HEAD.
   * A blob too large for the executor's byte ceiling is reported as binary rather than raised as an
   * output-limit error. The new side is read straight from disk through the injected reader; a NUL byte
   * on either side (or an oversized side) marks the file binary, and binary sides carry no text.
   */
  async diff(workspaceId: string, path: string, config: AppConfig): Promise<GitFileDiff> {
    const repoPath = await this.requireRepoPath(workspaceId, config)
    // Guard the worktree read first: an escaping path must be rejected before any git or fs work.
    const absolute = assertInWorktree(repoPath, path)
    const host = this.host(workspaceId, config)
    const oldSide = await this.readHeadBlob(host, repoPath, path)
    const newSide = worktreeReadToDiffSide(await this.readWorktreeFile(absolute))
    return buildFileDiff(path, oldSide, newSide)
  }

  /** Read the HEAD blob for a path into a diff side, or mark it absent / binary. */
  private async readHeadBlob(host: ExecutionHost, repoPath: string, path: string): Promise<GitDiffSide> {
    let result
    try {
      result = await host.run(
        'git',
        // `--end-of-options` fences the rev so a `-`-prefixed path cannot be read as a flag. The rev is
        // `HEAD:<path>`, a single argument — there is no pathspec here, hence no `:(literal)`.
        ['-C', repoPath, 'show', '--end-of-options', `HEAD:${path}`],
        GIT_RUN_OPTIONS
      )
    } catch (error) {
      // A blob past the output ceiling is binary-for-our-purposes, not a hard error.
      if (isOutputLimitError(error)) return { present: true, binary: true }
      throw error
    }
    if (result.exitCode === 0) return blobTextToDiffSide(result.stdout)
    // The one benign failure: the path is not in HEAD, which is how an added file is drawn. Every other
    // failure is real and must surface rather than be flattened into an empty (or HEAD-fallback) diff.
    if (PATH_ABSENT_IN_HEAD.test(result.stderr)) return { present: false }
    this.assertGit(result, 'Could not read the file from HEAD')
    return { present: false }
  }

  /**
   * Move a file out of the index back to its HEAD state, leaving the worktree copy untouched. Uses
   * `restore --staged` with the same `--`/`:(literal)` hardening as `stage`, so a `-`-prefixed name is
   * a path and never a flag.
   */
  async unstage(workspaceId: string, path: string, config: AppConfig): Promise<void> {
    const pathspec = toLiteralPathspec(path)
    const repoPath = await this.requireRepoPath(workspaceId, config)
    const result = await this.host(workspaceId, config).run(
      'git',
      ['-C', repoPath, 'restore', '--staged', '--', pathspec],
      GIT_RUN_OPTIONS
    )
    this.assertGit(result, 'Could not unstage the file')
  }

  /**
   * Throw away a file's changes. The two cases are genuinely different git operations:
   *   - A tracked file is restored to its HEAD content with `restore --worktree --source=HEAD`.
   *   - An untracked file has never been committed, so there is nothing to restore — it is removed with
   *     `clean --force`. Before that runs, the path is put through {@link assertInWorktree}: `clean`
   *     deletes from disk, so a `../` traversal or absolute path must be rejected rather than allowed to
   *     reach outside the repository root.
   * Both use `--`/`:(literal)` so the path is never read as a flag.
   */
  async discard(workspaceId: string, path: string, untracked: boolean, config: AppConfig): Promise<void> {
    const pathspec = toLiteralPathspec(path)
    const repoPath = await this.requireRepoPath(workspaceId, config)
    const host = this.host(workspaceId, config)
    if (untracked) {
      // Reject an escaping path before the one verb that removes files from disk.
      assertInWorktree(repoPath, path)
      const result = await host.run('git', ['-C', repoPath, 'clean', '--force', '--', pathspec], GIT_RUN_OPTIONS)
      this.assertGit(result, 'Could not discard the untracked file')
      return
    }
    const result = await host.run(
      'git',
      ['-C', repoPath, 'restore', '--worktree', '--source=HEAD', '--', pathspec],
      GIT_RUN_OPTIONS
    )
    this.assertGit(result, 'Could not discard the changes')
  }

  /**
   * Push the current branch. Defaults to `origin HEAD` with `--set-upstream`, so a first push both
   * publishes the branch and records its upstream in one call. `--force-with-lease` (never a bare
   * `--force`) is opt-in and placed before `--set-upstream` so the lease still applies to the push.
   *
   * A rejection is not thrown — it is classified into an actionable, credential-scrubbed result so the
   * UI can say "the remote has updates, sync first" rather than surface a raw stderr or, worse, a URL
   * with an embedded token.
   */
  async push(workspaceId: string, config: AppConfig, options: GitPushOptions = {}): Promise<GitRemoteResult> {
    const remote = assertSafeRef(options.remote ?? 'origin', 'remote name')
    const refspec = assertSafeRef(options.refspec ?? 'HEAD', 'refspec')
    const repoPath = await this.requireRepoPath(workspaceId, config)
    const argv = ['-C', repoPath, 'push']
    if (options.forceWithLease) argv.push('--force-with-lease')
    argv.push('--set-upstream', remote, refspec)
    return this.remote(await this.host(workspaceId, config).run('git', argv, GIT_REMOTE_RUN_OPTIONS))
  }

  /**
   * Pull the current branch from its configured upstream — the same integration a bare `git pull`
   * performs, and the same ref ahead/behind measures against. The strategy is either pinned by the
   * caller (`ff-only` / `merge` / `rebase`) or left to git. When the caller does not pin one and a bare
   * pull hard-fails because the branch has diverged and the host has no `pull.rebase`/`pull.ff` policy,
   * this retries once with an explicit merge — the auto-merge fallback that keeps an unconfigured host
   * from failing a routine pull. A pinned `ff-only` is never second-guessed: its diverged result is
   * surfaced as-is. No positional remote/refspec is passed: `origin HEAD` is a push idiom (git would
   * read `HEAD` as a remote ref to fetch), so pull relies on the upstream tracking push established.
   */
  async pull(
    workspaceId: string,
    config: AppConfig,
    options: { strategy?: GitPullStrategy } = {}
  ): Promise<GitRemoteResult> {
    const repoPath = await this.requireRepoPath(workspaceId, config)
    const host = this.host(workspaceId, config)
    const run = async (strategyFlag: string | null): Promise<GitRemoteResult> => {
      const argv = ['-C', repoPath, 'pull']
      if (strategyFlag) argv.push(strategyFlag)
      return this.remote(await host.run('git', argv, GIT_REMOTE_RUN_OPTIONS))
    }
    const first = await run(STRATEGY_FLAG[options.strategy ?? 'auto'])
    // Only an unpinned caller gets the fallback: a diverged bare pull retries as an explicit merge.
    if (first.kind === 'diverged' && options.strategy === undefined) return run('--no-rebase')
    return first
  }

  /** Fetch from a remote (default `origin`) with `--prune`, so deleted remote branches stop lingering. */
  async fetch(workspaceId: string, config: AppConfig, options: GitRemoteOptions = {}): Promise<GitRemoteResult> {
    const remote = assertSafeRef(options.remote ?? 'origin', 'remote name')
    const repoPath = await this.requireRepoPath(workspaceId, config)
    return this.remote(
      await this.host(workspaceId, config).run('git', ['-C', repoPath, 'fetch', '--prune', remote], GIT_REMOTE_RUN_OPTIONS)
    )
  }

  /**
   * How far the current branch is ahead of / behind its effective upstream. "Effective" is the key
   * word: a branch can track `origin/main` for reads yet push to `origin/<branch>`, so the target that
   * matters is `@{push}` — the true push destination — and only if that does not resolve do we fall
   * back to the configured `@{upstream}` (which also covers a local-branch upstream like
   * `refs/heads/main`). When neither resolves, there is simply no upstream: ahead/behind are both zero.
   */
  async aheadBehind(workspaceId: string, config: AppConfig): Promise<GitAheadBehind> {
    const repoPath = await this.requireRepoPath(workspaceId, config)
    const host = this.host(workspaceId, config)
    const upstream = (await this.resolveRef(host, repoPath, '@{push}')) ?? (await this.resolveRef(host, repoPath, '@{upstream}'))
    if (upstream === null) return { upstream: null, ahead: 0, behind: 0 }
    const result = await host.run(
      'git',
      ['-C', repoPath, 'rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      GIT_RUN_OPTIONS
    )
    this.assertGit(result, 'Could not count commits against the upstream')
    // `--left-right --count HEAD...<upstream>` prints "<ahead>\t<behind>": left of the symmetric-diff
    // is HEAD's own commits (ahead), right is the upstream's (behind).
    const [ahead, behind] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10))
    return { upstream, ahead: Number.isFinite(ahead) ? ahead! : 0, behind: Number.isFinite(behind) ? behind! : 0 }
  }

  /**
   * Resolve a magic revision (`@{push}` / `@{upstream}`) to its full ref name, or null when it does not
   * exist. `--verify --quiet` turns a missing upstream into a clean exit-1 with empty output instead of
   * a fatal; these two revisions must be passed as plain revision arguments (git cannot resolve them
   * after `--end-of-options`), which is safe because they are compile-time constants, not user input.
   */
  private async resolveRef(host: ExecutionHost, repoPath: string, revision: string): Promise<string | null> {
    const result = await host.run(
      'git',
      ['-C', repoPath, 'rev-parse', '--symbolic-full-name', '--verify', '--quiet', revision],
      GIT_RUN_OPTIONS
    )
    const ref = result.stdout.trim()
    return result.exitCode === 0 && ref ? ref : null
  }

  /** Fold a captured remote-verb result into the discriminated result the renderer consumes. */
  private remote(result: { exitCode: number; stdout: string; stderr: string }): GitRemoteResult {
    if (result.exitCode === 0) return { kind: 'ok' }
    return classifyGitRemoteError(result)
  }

  private host(workspaceId: string, config: AppConfig): ExecutionHost {
    return this.hostFor(this.workspace(config, workspaceId).hostId)
  }

  private async requireRepoPath(workspaceId: string, config: AppConfig): Promise<string> {
    const workspace = this.workspace(config, workspaceId)
    const repoPath = await this.resolveRepoPath(this.hostFor(workspace.hostId), workspace.path)
    if (repoPath === null) throw new Error('Workspace is not a Git repository')
    return repoPath
  }

  private workspace(config: AppConfig, id: string): WorkspaceRecord {
    const workspace = config.workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`Unknown workspace: ${id}`)
    return workspace
  }

  /**
   * The working-tree root for a workspace, or null when it is genuinely not a repository.
   *
   * The decision is made from git's output, not its exit code: a non-zero exit whose stderr is the
   * specific "not a git repository" fatal means null (a plain folder), while any other non-zero exit
   * is re-thrown as the real failure it is. Trusting the exit code alone would flatten a permissions
   * or corruption error into a misleading "not a repo".
   */
  private async resolveRepoPath(host: ExecutionHost, path: string): Promise<string | null> {
    const result = await host.run('git', ['-C', path, 'rev-parse', '--show-toplevel'], GIT_RUN_OPTIONS)
    if (result.exitCode !== 0 && NOT_A_GIT_REPOSITORY.test(result.stderr)) return null
    this.assertGit(result, 'Workspace is not a Git repository')
    const repoPath = result.stdout.trim()
    if (!repoPath) throw new Error('Git returned an empty repository path')
    return repoPath
  }

  private assertGit(
    result: { exitCode: number; stdout: string; stderr: string },
    fallback: string
  ): void {
    if (result.exitCode !== 0) {
      throw new Error(scrubGitCredentials(result.stderr.trim() || result.stdout.trim() || fallback))
    }
  }
}
