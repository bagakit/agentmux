import type { GitFileChange } from '../../../shared/contracts'

/**
 * What source control says about one file-tree node. A closed union: the whole point of this task is
 * that the file tree finally shows what the Changes panel already knew, and a closed set is what lets
 * the two presentation tables below be exhaustive — a new member makes `tsc` red at the tables rather
 * than degrading silently to grey/Unknown (记忆 exhaustive tables must be tsc-forced).
 *
 * `added` vs `untracked` are kept apart on purpose even though both read green: an added file is
 * staged (git knows about it), an untracked one is not, and the non-colour mark (`A` vs `?`) is what
 * makes the two legible without colour (无障碍：颜色不作唯一信号).
 */
export type FileTreeGitStatus =
  | 'modified'
  | 'added'
  | 'untracked'
  | 'deleted'
  | 'renamed'
  | 'conflicted'

/**
 * The one and only place a mixed directory's status is decided. A directory can contain files of
 * several statuses at once; when collapsed it can show only one, so the aggregation has to pick.
 *
 * Higher wins. The order is by "how much this wants your eye": a conflict needs you, a deletion is
 * destructive and notable, a modification is the common "something changed in here", and
 * added/untracked are the quietest. **This table is the single source of that priority** — the
 * directory side and the file side both read it, so the two can never drift apart (记忆
 * two-resolutions-that-happen-to-agree / same concept judged in two places). It is exported so a test
 * can pin the exact ranking, and it is a `Record<FileTreeGitStatus, number>` so adding a status
 * without ranking it fails to compile.
 */
export const FILE_TREE_GIT_STATUS_PRIORITY: Record<FileTreeGitStatus, number> = {
  conflicted: 5,
  deleted: 4,
  modified: 3,
  renamed: 2,
  added: 1,
  untracked: 0
}

/**
 * The status → CSS-class table. Exhaustive by construction (`Record<FileTreeGitStatus, string>`), so
 * the compiler forces a class for every status; the component only indexes it, it never re-decides.
 */
export const FILE_TREE_GIT_STATUS_CLASS: Record<FileTreeGitStatus, string> = {
  modified: 'tree-row--git-modified',
  added: 'tree-row--git-added',
  untracked: 'tree-row--git-untracked',
  deleted: 'tree-row--git-deleted',
  renamed: 'tree-row--git-renamed',
  conflicted: 'tree-row--git-conflicted'
}

/**
 * The status → single-character mark. This is the **non-colour** carrier of the same fact: the letter
 * distinguishes the states for a colour-blind reader and in a quick glance, matching git's own
 * porcelain letters (`?` for untracked, `!` reserved here for a conflict that wants attention).
 * Exhaustive for the same reason as the class table.
 */
export const FILE_TREE_GIT_STATUS_MARK: Record<FileTreeGitStatus, string> = {
  modified: 'M',
  added: 'A',
  untracked: '?',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!'
}

/**
 * A short human label for a node's status, for `title`/`aria-label`. Exhaustive.
 */
export const FILE_TREE_GIT_STATUS_LABEL: Record<FileTreeGitStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'Untracked',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted'
}

/**
 * Collapse one git change into a single tree status.
 *
 * The mark read is the same one the Changes panel labels with: the staged (index) column when the
 * file is staged, otherwise the worktree column. Git's status letters are an open set, so the tail
 * falls back to `modified` — any tracked, non-blank change is at least a modification; the fallback is
 * a real union member, never an "unknown" that would break the exhaustive tables above.
 */
export function fileTreeGitStatusOfChange(change: GitFileChange): FileTreeGitStatus {
  if (change.untracked) return 'untracked'
  const mark = change.staged ? change.index : change.worktree
  switch (mark) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    case 'U':
      return 'conflicted'
    case 'M':
    case 'T':
    default:
      return 'modified'
  }
}

/** The higher-priority of two statuses, per {@link FILE_TREE_GIT_STATUS_PRIORITY}. */
function moreUrgent(a: FileTreeGitStatus, b: FileTreeGitStatus): FileTreeGitStatus {
  return FILE_TREE_GIT_STATUS_PRIORITY[a] >= FILE_TREE_GIT_STATUS_PRIORITY[b] ? a : b
}

/** Each repo-relative-path ancestor directory of a workspace-relative file path, nearest first is not required. */
function ancestorDirectories(path: string): string[] {
  const segments = path.split('/')
  const dirs: string[] = []
  let prefix = ''
  for (let i = 0; i < segments.length - 1; i += 1) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!
    dirs.push(prefix)
  }
  return dirs
}

/**
 * A lookup from a file-tree node (path + whether it is a directory) to its git status, or null.
 *
 * `get` is the whole surface the renderer needs: it never re-derives anything, it only asks.
 */
export type FileTreeGitStatusIndex = {
  get: (path: string, isDirectory: boolean) => FileTreeGitStatus | null
}

const EMPTY_INDEX: FileTreeGitStatusIndex = { get: () => null }

/**
 * Project the porcelain changes onto the file tree, keyed by **workspace-relative** path.
 *
 * `repoRelativePrefix` bridges the two coordinate systems: porcelain paths are relative to the git
 * top-level, the tree's paths are relative to the workspace root, and the two are not always the same
 * directory (a workspace can be a subfolder of its repo). The prefix (`''` when they coincide) is
 * stripped so a change lands on the node the user actually sees; a change outside the prefix belongs
 * to another part of the repo that this tree does not show, and is dropped.
 *
 * Files get their own status; every ancestor directory gets the most urgent status among its
 * descendants, so a collapsed folder still signals that something inside it changed (记忆: 目录聚合，
 * 折叠状态下用户看不见). Both sides read the one priority table above — there is no second decision.
 */
export function buildFileTreeGitStatusIndex(
  changes: readonly GitFileChange[],
  repoRelativePrefix = ''
): FileTreeGitStatusIndex {
  if (changes.length === 0) return EMPTY_INDEX
  const prefix = repoRelativePrefix ? `${repoRelativePrefix.replace(/\/+$/, '')}/` : ''
  const fileStatus = new Map<string, FileTreeGitStatus>()
  const dirStatus = new Map<string, FileTreeGitStatus>()
  for (const change of changes) {
    if (prefix && !change.path.startsWith(prefix)) continue
    const path = prefix ? change.path.slice(prefix.length) : change.path
    if (!path) continue
    const status = fileTreeGitStatusOfChange(change)
    const existing = fileStatus.get(path)
    fileStatus.set(path, existing ? moreUrgent(existing, status) : status)
    for (const dir of ancestorDirectories(path)) {
      const current = dirStatus.get(dir)
      dirStatus.set(dir, current ? moreUrgent(current, status) : status)
    }
  }
  return {
    get: (path, isDirectory) => (isDirectory ? dirStatus.get(path) : fileStatus.get(path)) ?? null
  }
}

/**
 * The workspace-root-relative prefix a change path carries because the workspace sits inside its repo.
 *
 * Both inputs are absolute host paths from the same host; porcelain paths are relative to `repoPath`,
 * tree paths relative to `workspacePath`. When the workspace is at (or above) the repo top-level the
 * prefix is empty. Normalised on `/` — the hosts this runs against (local macOS, SSH) both use it.
 */
export function fileTreeRepoRelativePrefix(repoPath: string, workspacePath: string): string {
  const repo = repoPath.replace(/\/+$/, '')
  const workspace = workspacePath.replace(/\/+$/, '')
  if (workspace === repo) return ''
  if (workspace.startsWith(`${repo}/`)) return workspace.slice(repo.length + 1)
  return ''
}
