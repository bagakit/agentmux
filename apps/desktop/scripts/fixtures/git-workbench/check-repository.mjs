import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitWorkbenchFixture } from './repository.mjs'

const root = await mkdtemp(join(tmpdir(), 'amux-git-fixture-'))
const workspacePath = join(root, 'repository'), reviewWorktreePath = join(root, 'worktree')
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
function run(directory, ...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {}
  return new Promise((done, fail) => {
    const child = execFile('git', ['-C', directory, ...args], { env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? fail(error) : done(stdout))
    child.stdin.end(options.input)
  })
}
try {
  await mkdir(workspacePath)
  const git = (...args) => run(workspacePath, ...args), reviewGit = (...args) => run(reviewWorktreePath, ...args)
  const fixture = await createGitWorkbenchFixture({ workspacePath, reviewWorktreePath, reviewBranch: 'feature/readable-history',
    mainStagedPath: 'main-draft-fixture.txt', reviewStagedPath: 'review-draft-fixture.txt', git, reviewGit })
  const refs = (await git('for-each-ref', '--format=%(refname)')).trim().split('\n')
  assert.equal(refs.length, fixture.manyRefs + 3)
  assert.ok(refs.includes(fixture.oldTipRef) && refs.includes('refs/remotes/origin/main') && refs.includes('refs/heads/main'))
  const firstPage = (await git('log', '--all', '--topo-order', '--max-count=50', '--format=%H')).trim().split('\n')
  assert.equal(firstPage.length, 50)
  assert.ok(!firstPage.includes(fixture.rootOid))
  const firstThreePages = (await git('log', '--all', '--topo-order', '--max-count=150', '--format=%H')).trim().split('\n')
  assert.equal(firstThreePages.length, 150)
  assert.ok(!firstThreePages.includes(fixture.rootOid))
  assert.equal((await git('rev-parse', fixture.oldTipRef)).trim(), fixture.rootOid)
  assert.equal((await git('show', '-s', '--format=%P', fixture.mergeOid)).trim().split(' ').length, 2)
  assert.equal(await git('show', '-s', '--format=%B', fixture.featureOid), fixture.standardSubject + '\n\n' + fixture.standardBody + '\n\n')
  const changes = await git('diff-tree', '--no-commit-id', '-r', '-M', '--name-status', fixture.featureOid)
  for (const change of ['A\tchanged.ts', 'M\tbinary.bin', 'D\tremoved.txt', 'R100\told.ts\trenamed.ts']) assert.ok(changes.includes(change), change)
  assert.equal(await readFile(join(workspacePath, 'changed.ts'), 'utf8'), 'dirty worktree body must remain untouched\n')
  assert.ok((await git('diff', '--cached', '--name-only')).includes(fixture.mainStagedPath))
  assert.ok((await reviewGit('diff', '--cached', '--name-only')).includes(fixture.reviewStagedPath))
  console.log(JSON.stringify({ passed: true, scope: 'Private real-Git fixture only; no Renderer, public navigation, process recovery or aesthetics claim.',
    refs: refs.length, firstPage: firstPage.length, oldTipOutsideFirstThreePages: true, mergeParents: fixture.parents.length }))
} finally {
  await rm(root, { recursive: true, force: true })
}
