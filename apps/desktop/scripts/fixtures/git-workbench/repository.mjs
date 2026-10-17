import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createGitWorkbenchFixture({ workspacePath, reviewWorktreePath, reviewBranch, mainStagedPath, reviewStagedPath, git, reviewGit }) {
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Private Author')
  await git('config', 'user.email', 'private@example.invalid')
  await writeFile(join(workspacePath, 'old.ts'), 'retained original body\n')
  await writeFile(join(workspacePath, 'removed.txt'), 'Removed only in the feature commit\n')
  await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 1, 2]))
  await git('add', '.')
  await git('commit', '-m', 'Initial repository', '-m', 'Nonstandard subject; original multiline body.\nLiteral <b>markup</b> remains text.')
  const rootOid = (await git('rev-parse', 'HEAD')).trim()
  for (let index = 0; index < 162; index++) await git('commit', '--allow-empty', '-m', `History ${String(index).padStart(3, '0')} · keep chronological context`)
  const ordinaryOids = (await git('log', '--format=%H', '--max-count=160')).trim().split('\n')
  await git('checkout', '-b', reviewBranch)
  await git('mv', 'old.ts', 'renamed.ts')
  await git('rm', 'removed.txt')
  await writeFile(join(workspacePath, 'changed.ts'), 'fixed commit body\n')
  await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 3, 4]))
  const longPath = 'nested/long-directory-for-fixed-commit-review/精确版本与只读审阅-long-file-name.ts'
  await mkdir(join(workspacePath, 'nested/long-directory-for-fixed-commit-review'), { recursive: true })
  await writeFile(join(workspacePath, longPath), 'long path fixed body\n')
  await git('add', '.')
  const standardSubject = 'feat(review)!: Keep fixed commit messages and file changes readable'
  const standardBody = 'Preserve the original message, including its line breaks.\n第二行正文保持可复制。\n\nBREAKING CHANGE: Review only the chosen immutable parent.'
  await git('commit', '-m', standardSubject, '-m', standardBody)
  const featureOid = (await git('rev-parse', 'HEAD')).trim()
  await git('checkout', 'main')
  await writeFile(join(workspacePath, 'main.ts'), 'main parent\n')
  await git('add', '.')
  await git('commit', '-m', 'Main parent')
  const mergeSubject = 'Read commit context · 长标题保留准确对象与阅读位置 without opening a second History or another editor for every file'
  const mergeBody = 'Full message with a clear subject.\nThe original branch and history stay available while files open as fixed version diffs.'
  await git('merge', '--no-ff', reviewBranch, '-m', mergeSubject, '-m', mergeBody)
  const mergeOid = (await git('rev-parse', 'HEAD')).trim()
  const parents = (await git('show', '-s', '--format=%P', 'HEAD')).trim().split(' ')
  await git('branch', 'topic/pure-branch')
  await git('worktree', 'add', reviewWorktreePath, reviewBranch)
  const oldTipRef = 'refs/heads/archive/original-main-tip-before-the-long-lived-review-history'
  const errorRef = 'refs/heads/topic/temporary-history-observation'
  const refs = [['refs/heads/topic/root-only', rootOid], [oldTipRef, rootOid], [errorRef, mergeOid],
    ['refs/remotes/origin/main', featureOid]]
  for (let index = 0; index < 320; index++) {
    const name = `topic/review-${String(index).padStart(3, '0')}/long-reference-name-preserves-the-complete-source-and-destination`
    refs.push(['refs/heads/' + name, ordinaryOids[index % ordinaryOids.length]],
      ['refs/remotes/origin/' + name, ordinaryOids[(index + 1) % ordinaryOids.length]])
  }
  await git('update-ref', '--stdin', { input: refs.map(([name, oid]) => `create ${name} ${oid}\n`).join('') })
  await writeFile(join(workspacePath, 'changed.ts'), 'dirty worktree body must remain untouched\n')
  await writeFile(join(workspacePath, mainStagedPath), 'Main staged body must never be committed by this probe\n')
  await git('add', '--', mainStagedPath)
  await writeFile(join(reviewWorktreePath, reviewStagedPath), 'Review staged body must never be committed by this probe\n')
  await reviewGit('add', '--', reviewStagedPath)
  return { rootOid, featureOid, mergeOid, parents, longPath, reviewWorktreePath, mainStagedPath, reviewStagedPath,
    oldTipRef, errorRef, manyRefs: refs.length, standardSubject, standardBody, mergeSubject, mergeBody }
}
