import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import type { GitBranchComparisonResult, GitBranchComparisonSnapshot } from '../src/shared/git-contracts.js'
import { GitService, GIT_NONINTERACTIVE_ENV } from '../src/main/git-service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
function configuration(path: string): AppConfig {
  return { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'repo', hostId: 'local', path, name: 'Private', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
}
function ready(value: GitBranchComparisonResult) {
  expect(value.kind).toBe('ready')
  if (value.kind !== 'ready') throw new Error('Comparison did not return a snapshot')
  return value
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-branch-compare-'))); roots.push(root)
  const host = new LocalExecutionHost()
  async function git(...args: string[]) {
    const result = await host.run('git', ['-C', root, ...args], options)
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
  }
  await git('init', '-b', 'base'); await git('config', 'user.name', 'Private Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await mkdir(join(root, 'sub'))
  await Promise.all(Object.entries({ 'common.txt': 'seed\n', ':(glob)abc.txt': 'magic seed\n', 'rename-old.txt': 'identical rename content\n', 'delete.txt': 'deleted content\n', 'a*.txt': 'literal seed\n', 'abc.txt': 'decoy seed\n', 'sub/file.txt': 'sub seed\n' }).map(([path, text]) => writeFile(join(root, path), text)))
  await git('add', '--all'); await git('commit', '-m', 'Seed'); const seed = await git('rev-parse', 'HEAD')
  await git('branch', 'target')
  await writeFile(join(root, 'base-only.txt'), 'base-only\n'); await writeFile(join(root, 'common.txt'), 'base advanced\n')
  await git('add', '--all'); await git('commit', '-m', 'Base advanced'); const base = await git('rev-parse', 'HEAD')
  await git('switch', 'target'); await rename(join(root, 'rename-old.txt'), join(root, 'rename-new.txt')); await rm(join(root, 'delete.txt'))
  await Promise.all(Object.entries({ 'common.txt': 'target advanced\n', ':(glob)abc.txt': 'magic target\n', 'added.txt': 'target addition\n', 'a*.txt': 'literal target\n', 'sub/file.txt': 'sub target\n', '中文\nfile.txt': 'newline target\n', 'image.bin': Buffer.from([1, 0, 2]) }).map(([path, text]) => writeFile(join(root, path), text)))
  await git('add', '--all'); await git('commit', '-m', 'Target'); const target = await git('rev-parse', 'HEAD')
  await git('switch', '-c', 'distractor', 'base'); await writeFile(join(root, 'common.txt'), 'HEAD decoy\n')
  await git('add', '--all'); await git('commit', '-m', 'HEAD distractor'); await writeFile(join(root, 'common.txt'), 'dirty decoy\n')
  const readDisk = vi.fn(async () => { throw new Error('Comparison read the worktree') })
  const run = vi.spyOn(host, 'run'); const service = new GitService(() => host, readDisk)
  return { root, host, git, seed, base, target, service, config: configuration(root), run, readDisk }
}

describe('GitService branch comparison with actual private Git', () => {
  it('compares the target from the merge base, not current HEAD, and reads pinned renamed/add/delete/newline/literal blobs', async () => {
    const f = await fixture(), result = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'merge-base' }, f.config))
    expect(result.snapshot).toEqual({ hostId: 'local', repoPath: f.root, mode: 'merge-base', baseBranch: 'base', targetBranch: 'target', baseOid: f.base, targetOid: f.target, comparisonBaseOid: f.seed })
    expect(result.entries).toEqual([
      { path: ':(glob)abc.txt', origPath: null, change: 'modified' },
      { path: 'a*.txt', origPath: null, change: 'modified' }, { path: 'added.txt', origPath: null, change: 'added' },
      { path: 'common.txt', origPath: null, change: 'modified' }, { path: 'delete.txt', origPath: null, change: 'deleted' },
      { path: 'image.bin', origPath: null, change: 'added' }, { path: 'rename-new.txt', origPath: 'rename-old.txt', change: 'renamed' },
      { path: 'sub/file.txt', origPath: null, change: 'modified' }, { path: '中文\nfile.txt', origPath: null, change: 'added' }
    ])
    expect(result.warnings).toEqual([])
    // Listing is metadata-only; blob I/O starts with the explicit per-file read below.
    expect(f.run.mock.calls.filter(([, args]) => args.includes('cat-file'))).toEqual([])
    const renamed = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: result.entries.find(value => value.path === 'rename-new.txt')! }, f.config)
    expect(renamed.old).toEqual({ present: true, binary: false, text: 'identical rename content\n' }); expect(renamed.new).toEqual(renamed.old)
    const diff = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path: 'common.txt', origPath: null } }, f.config)
    expect(diff.old).toEqual({ present: true, binary: false, text: 'seed\n' }); expect(diff.new).toEqual({ present: true, binary: false, text: 'target advanced\n' })
    await expect(f.service.branchDiff('repo', { snapshot: result.snapshot, file: result.entries.find(value => value.path === 'a*.txt')! }, f.config)).resolves.toMatchObject({
      old: { present: true, binary: false, text: 'literal seed\n' }, new: { present: true, binary: false, text: 'literal target\n' }
    })
    await expect(f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path: ':(glob)abc.txt', origPath: null } }, f.config)).resolves.toMatchObject({
      old: { present: true, binary: false, text: 'magic seed\n' }, new: { present: true, binary: false, text: 'magic target\n' }
    })
    for (const [path, change, old, fresh] of [['added.txt', 'added', false, true], ['delete.txt', 'deleted', true, false], ['中文\nfile.txt', 'added', false, true]] as const) {
      const entry = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path, origPath: null } }, f.config)
      expect({ change: entry.change, old: entry.old.present, new: entry.new.present }).toEqual({ change, old, new: fresh })
    }
    const binary = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path: 'image.bin', origPath: null } }, f.config)
    expect(binary).toEqual({ path: 'image.bin', old: { present: false }, new: { present: true, binary: true }, binary: true, change: 'added' })
    expect(f.readDisk).not.toHaveBeenCalled()
    expect(await f.git('symbolic-ref', '--short', 'HEAD')).toBe('distractor')
    expect(await f.git('diff', '--name-only')).toBe('common.txt')
    expect(f.run.mock.calls.filter(([, args]) => args.some(value => ['fetch', 'checkout', 'worktree', 'merge', 'switch'].includes(value)))).toEqual([])
  })

  it('keeps two-point direction and captured OIDs after refs move, with a subfolder Workspace and a true empty result', async () => {
    const f = await fixture(), cfg = configuration(join(f.root, 'sub'))
    const result = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'two-point' }, cfg))
    expect(result.snapshot.comparisonBaseOid).toBe(f.base)
    expect(result.entries.find(value => value.path === 'base-only.txt')).toEqual({ path: 'base-only.txt', origPath: null, change: 'deleted' })
    await f.git('branch', '-f', 'target', 'distractor')
    const diff = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path: 'common.txt', origPath: null } }, cfg)
    expect(diff.old).toEqual({ present: true, binary: false, text: 'base advanced\n' }); expect(diff.new).toEqual({ present: true, binary: false, text: 'target advanced\n' })
    const sub = await f.service.branchDiff('repo', { snapshot: result.snapshot, file: { path: 'sub/file.txt', origPath: null } }, cfg)
    expect(sub.new).toEqual({ present: true, binary: false, text: 'sub target\n' })
    const refreshed = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'two-point' }, cfg))
    expect(refreshed.snapshot.targetOid).not.toBe(result.snapshot.targetOid)
    const empty = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'base', mode: 'merge-base' }, cfg))
    expect(empty.entries).toEqual([]); expect(empty.snapshot.targetOid).toBe(f.base)
    expect(f.readDisk).not.toHaveBeenCalled()
  })

  it('rejects invalid/missing local refs and unrelated merge-base without converting errors to an empty list', async () => {
    const f = await fixture()
    for (const baseBranch of ['--help', 'base~1', 'refs/heads/base', 'missing', '@{-1}']) {
      await expect(f.service.compareBranches('repo', { baseBranch, targetBranch: 'target', mode: 'merge-base' }, f.config)).rejects.toThrow()
    }
    await f.git('restore', '--', 'common.txt'); await f.git('switch', '--orphan', 'unrelated'); await f.git('rm', '-rf', '--ignore-unmatch', '.'); await writeFile(join(f.root, 'island.txt'), 'island\n'); await f.git('add', '--all'); await f.git('commit', '-m', 'Unrelated')
    await expect(f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'unrelated', mode: 'merge-base' }, f.config)).rejects.toThrow(/common ancestor/)
    const result = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'unrelated', mode: 'two-point' }, f.config))
    expect(result.entries.find(value => value.path === 'island.txt')).toEqual({ path: 'island.txt', origPath: null, change: 'added' })
  })

  it('refuses another repository/host and invalid path/OID descriptors before reading blobs', async () => {
    const f = await fixture(), result = ready(await f.service.compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'merge-base' }, f.config))
    const descriptor = { snapshot: result.snapshot, file: { path: 'common.txt', origPath: null } }; f.run.mockClear()
    await expect(f.service.branchDiff('repo', { ...descriptor, snapshot: { ...result.snapshot, hostId: 'other' } }, f.config)).rejects.toThrow(/no longer refers/)
    await expect(f.service.branchDiff('repo', { ...descriptor, snapshot: { ...result.snapshot, repoPath: f.root + '-other' } }, f.config)).rejects.toThrow(/no longer refers/)
    for (const path of ['../common.txt', '/common.txt', '', 'sub/../common.txt']) await expect(f.service.branchDiff('repo', { ...descriptor, file: { path, origPath: null } }, f.config)).rejects.toThrow(/repository-relative/)
    await expect(f.service.branchDiff('repo', { ...descriptor, snapshot: { ...result.snapshot, targetOid: 'HEAD' } }, f.config)).rejects.toThrow(/complete commit/)
    expect(f.run.mock.calls.filter(([, args]) => args.includes('cat-file'))).toEqual([])
  })
})

const oid = '1'.repeat(40), targetOid = '2'.repeat(40)
const snapshot: GitBranchComparisonSnapshot = { hostId: 'local', repoPath: '/private-repo', mode: 'merge-base', baseBranch: 'base', targetBranch: 'target', baseOid: oid, targetOid, comparisonBaseOid: oid }
function fakeHost(answer: (args: readonly string[]) => { stdout?: string; stderr?: string; exitCode?: number } | never): ExecutionHost {
  return { id: 'local', kind: 'local', label: 'Private', exposeLoopbackPort: vi.fn(), dispose: vi.fn(),
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      const value = args.includes('--show-toplevel') ? { stdout: '/private-repo\n' }
        : args.includes('check-ref-format') ? {} : args.includes('rev-parse') ? { stdout: args.some(value => value.includes('target')) ? targetOid + '\n' : oid + '\n' }
        : args.includes('merge-base') ? { stdout: oid + '\n' } : answer(args)
      return { command: 'git', args, stdout: value.stdout ?? '', stderr: value.stderr ?? '', exitCode: value.exitCode ?? 0, durationMs: 1 }
    }) }
}

describe('Git comparison bounded failures at the ExecutionHost boundary', () => {
  it('returns explicit not-repo and surfaces unreadable trees/blob failures with scrubbed errors', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'agentmux-not-repo-')); roots.push(plain)
    await expect(new GitService(() => new LocalExecutionHost()).compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'merge-base' }, configuration(plain))).resolves.toEqual({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: plain })
    const unreadable = fakeHost(() => ({ exitCode: 128, stderr: 'fatal: cannot read https://secret@example.invalid/tree' }))
    await expect(new GitService(() => unreadable).branchDiff('repo', { snapshot, file: { path: 'x.txt', origPath: null } }, configuration('/private-repo'))).rejects.toThrow('https://***@example.invalid/tree')
    const host = fakeHost(args => args.includes('ls-tree') ? { stdout: `100644 blob ${oid}\tx.txt\0` } : { exitCode: 128, stderr: 'fatal: missing blob object' })
    await expect(new GitService(() => host).branchDiff('repo', { snapshot, file: { path: 'x.txt', origPath: null } }, configuration('/private-repo'))).rejects.toThrow(/missing blob object/)
  })

  it('rejects oversized lists and malformed NUL records, preserving genuine warnings', async () => {
    const input = { baseBranch: 'base', targetBranch: 'target', mode: 'merge-base' } as const
    for (const output of ['M\0x.txt', 'R100\0old.txt\0', Array.from({ length: 1_001 }, (_, index) => `A\0${index}.txt\0`).join('')]) {
      const host = fakeHost(() => ({ stdout: output }))
      await expect(new GitService(() => host).compareBranches('repo', input, configuration('/private-repo'))).rejects.toThrow(/incomplete|1000-file/)
    }
    const host = fakeHost(() => ({ stdout: 'M\0x.txt\0', stderr: 'warning: read https://secret@example.invalid/info' }))
    const result = ready(await new GitService(() => host).compareBranches('repo', input, configuration('/private-repo')))
    expect(result.entries).toEqual([{ path: 'x.txt', origPath: null, change: 'modified' }]); expect(result.warnings).toEqual(['warning: read https://***@example.invalid/info'])
    const calls = vi.mocked(host.run).mock.calls.filter(([, args]) => args.includes('diff'))
    expect(calls).toHaveLength(1); expect(calls[0]![1]).toEqual(['-C', '/private-repo', 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', '-l1000', oid, targetOid, '--'])
  })

  it('treats bounded blob output as present/unrenderable, while list output limits remain errors', async () => {
    const limit = () => { throw Object.assign(new Error('output byte limit'), { code: 'COMMAND_OUTPUT_LIMIT' }) }
    const host = fakeHost(args => args.includes('ls-tree') ? { stdout: `100644 blob ${oid}\tx.txt\0` } : limit())
    const diff = await new GitService(() => host).branchDiff('repo', { snapshot, file: { path: 'x.txt', origPath: null } }, configuration('/private-repo'))
    expect(diff).toEqual({ path: 'x.txt', old: { present: true, binary: true }, new: { present: true, binary: true }, binary: true, change: 'modified' })
    const listHost = fakeHost(limit)
    await expect(new GitService(() => listHost).compareBranches('repo', { baseBranch: 'base', targetBranch: 'target', mode: 'merge-base' }, configuration('/private-repo'))).rejects.toMatchObject({ code: 'COMMAND_OUTPUT_LIMIT' })
  })
})
