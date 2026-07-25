import { describe, expect, it } from 'vitest'
import { parseGitStatusPorcelain, scrubGitCredentials } from '../src/main/git-service'

// These fixtures are the exact byte shapes of `git status --porcelain=v1 -z --branch
// --untracked-files=all`, verified against real git: entries are NUL-separated, `-z` disables
// C-quoting so paths are literal bytes, and a rename spends a second NUL-token on the old path.
const NUL = '\0'

describe('parseGitStatusPorcelain', () => {
  it('reads the current branch from the --branch header', () => {
    const { branch } = parseGitStatusPorcelain(`## main${NUL}`)
    expect(branch).toBe('main')
  })

  it('recovers the local branch when the header carries upstream and ahead/behind', () => {
    const { branch } = parseGitStatusPorcelain(`## main...origin/main [ahead 2, behind 1]${NUL}`)
    expect(branch).toBe('main')
  })

  it('reports a detached HEAD as no branch rather than the literal "HEAD"', () => {
    const { branch } = parseGitStatusPorcelain(`## HEAD (no branch)${NUL}`)
    expect(branch).toBeNull()
  })

  it('recovers the branch name before the first commit exists', () => {
    const { branch } = parseGitStatusPorcelain(`## No commits yet on main${NUL}`)
    expect(branch).toBe('main')
  })

  it('classifies staged, unstaged, and untracked from the two status columns', () => {
    const output = [
      `## main`,
      `M  staged-only.txt`,
      ` M worktree-only.txt`,
      `MM both.txt`,
      `?? brand-new.txt`,
      ``
    ].join(NUL)
    const { changes } = parseGitStatusPorcelain(output)
    // `unstaged` means a tracked file changed in the worktree (the Y column); `untracked` is its own
    // exclusive state, so a brand-new file is untracked-only, not also "unstaged".
    expect(changes).toEqual([
      { path: 'staged-only.txt', origPath: null, index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false },
      { path: 'worktree-only.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
      { path: 'both.txt', origPath: null, index: 'M', worktree: 'M', staged: true, unstaged: true, untracked: false },
      { path: 'brand-new.txt', origPath: null, index: '?', worktree: '?', staged: false, unstaged: false, untracked: true }
    ])
  })

  it('keeps paths with spaces and CJK bytes verbatim (the whole reason for -z)', () => {
    const output = [`## main`, ` M sub/nested file.txt`, `D  cjk 名字.txt`, ``].join(NUL)
    const { changes } = parseGitStatusPorcelain(output)
    expect(changes.map((change) => change.path)).toEqual(['sub/nested file.txt', 'cjk 名字.txt'])
  })

  it('consumes the old path a rename emits as its own NUL-token', () => {
    // A rename is `R<space><newpath>\0<oldpath>\0`; the parser must pair the two, not read the old
    // path as a second bogus change.
    const output = [`## main`, `R  new name.txt`, `old name.txt`, ` M after.txt`, ``].join(NUL)
    const { changes } = parseGitStatusPorcelain(output)
    expect(changes).toEqual([
      { path: 'new name.txt', origPath: 'old name.txt', index: 'R', worktree: ' ', staged: true, unstaged: false, untracked: false },
      { path: 'after.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }
    ])
  })

  it('returns an empty change set for a clean tree', () => {
    const { branch, changes } = parseGitStatusPorcelain(`## main${NUL}`)
    expect(branch).toBe('main')
    expect(changes).toEqual([])
  })
})

describe('scrubGitCredentials', () => {
  it('redacts a user:password embedded in a remote URL', () => {
    const scrubbed = scrubGitCredentials('fatal: unable to access https://alice:ghp_secret@github.com/o/r.git/')
    expect(scrubbed).toContain('https://***@github.com/o/r.git/')
    expect(scrubbed).not.toContain('ghp_secret')
    expect(scrubbed).not.toContain('alice')
  })

  it('leaves an ssh-style username with no password intact', () => {
    const text = 'Cloning into git@github.com:o/r.git'
    expect(scrubGitCredentials(text)).toBe(text)
  })

  it('leaves ordinary error text untouched', () => {
    const text = "error: pathspec 'x.txt' did not match any file(s) known to git"
    expect(scrubGitCredentials(text)).toBe(text)
  })
})
