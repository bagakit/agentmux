import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import type { GitHistoryResult } from '../src/shared/git-contracts.js'
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
function ready(value: GitHistoryResult) {
  expect(value.kind).toBe('ready')
  if (value.kind !== 'ready') throw new Error('No history snapshot')
  return value
}
async function repository(empty = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-history-'))); roots.push(root)
  const host = new LocalExecutionHost()
  async function git(...args: string[]) {
    const result = await host.run('git', ['-C', root, ...args], options)
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main'); await git('config', 'user.name', 'History Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  const service = new GitService(() => host), config = configuration(root)
  const commit = async (subject: string) => { await git('commit', '--allow-empty', '-m', subject); return git('rev-parse', 'HEAD') }
  if (empty) return { root, host, git, commit, service, config }
  const seed = await commit('Seed'), main = await commit('Main changes')
  await git('switch', '-c', 'topic', seed); const topic = await commit('Topic changes')
  await git('switch', 'main'); await git('merge', '--no-ff', 'topic', '-m', 'Merge topic'); const merge = await git('rev-parse', 'HEAD')
  await git('tag', '-a', 'release', '-m', 'Observed release', merge)
  await git('switch', '--orphan', 'remote-only'); const remoteSeed = await commit('Remote root'), remote = await commit('Remote only')
  await git('update-ref', 'refs/remotes/origin/topic', remote)
  await git('switch', '--orphan', 'tag-only'); const tagOnly = await commit('Tag-only history'); await git('tag', 'excluded-tag', tagOnly)
  await git('switch', 'main'); await git('branch', '-D', 'remote-only', 'tag-only')
  await writeFile(join(root, 'dirty.txt'), 'Keep this worktree fact\n')
  return { root, host, git, commit, service, config, seed, main, topic, merge, remoteSeed, remote, tagOnly }
}

describe('GitService history through actual private Git', () => {
  it('reads all observed heads, remote-tracking and HEAD with real merge parents, tag decorations and no tag-only roots or writes', async () => {
    const f = await repository(), run = vi.spyOn(f.host, 'run')
    const page = ready(await f.service.history('repo', {}, f.config))
    expect(new Set(page.commits.map(commit => commit.oid))).toEqual(new Set([f.seed, f.main, f.topic, f.merge, f.remoteSeed, f.remote]))
    expect(page.commits.find(commit => commit.oid === f.merge)).toMatchObject({ parents: [f.main, f.topic], subject: 'Merge topic', author: 'History Fixture' })
    expect(page.commits.find(commit => commit.oid === f.remoteSeed)?.parents).toEqual([])
    expect(page.commits.find(commit => commit.oid === f.merge)?.refs.map(ref => ref.name)).toEqual(['refs/heads/main', 'refs/tags/release', 'HEAD'])
    expect(page.commits.find(commit => commit.oid === f.remote)?.refs).toEqual([{ name: 'refs/remotes/origin/topic', kind: 'remote', oid: f.remote }])
    expect(page.nextCursor).toBeNull()
    const log = run.mock.calls.find(([, args]) => args.includes('log'))
    expect(log).toBeDefined(); expect(log![1]).toContain('--max-count=51')
    expect(log![2]?.input).toBe(page.snapshot.roots.join('\n') + '\n')
    expect(run.mock.calls.filter(([, args]) => args.some(value => ['fetch', 'checkout', 'switch', 'add', 'merge', 'worktree', 'cat-file'].includes(value)))).toEqual([])
    expect(await f.git('symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(await f.git('status', '--porcelain')).toBe('?? dirty.txt')
  }, 20_000)

  it('pages exactly once over fixed OIDs after ref moves, and refresh or explicit ref selection creates a new scope', async () => {
    const f = await repository()
    let page = ready(await f.service.history('repo', { limit: 2 }, f.config))
    const initial = page.snapshot, expected = (await f.git('rev-list', '--topo-order', ...initial.roots)).split('\n')
    expect(expected).toHaveLength(6); expect(page.nextCursor?.offset).toBe(2)
    await f.git('branch', '-f', 'topic', f.remote!); const newTip = await f.commit('New HEAD after snapshot')
    await f.git('update-ref', 'refs/remotes/origin/topic', newTip)
    const loaded = [...page.commits]
    for (let count = 0; page.nextCursor && count < expected.length; count += 1) {
      page = ready(await f.service.history('repo', { limit: 2, cursor: page.nextCursor }, f.config))
      expect(page.snapshot).toEqual(initial); loaded.push(...page.commits)
    }
    expect(page.nextCursor).toBeNull()
    expect(loaded.map(commit => commit.oid)).toEqual(expected)
    expect(new Set(loaded.map(commit => commit.oid)).size).toBe(6)
    const refreshed = ready(await f.service.history('repo', {}, f.config))
    expect(new Set(refreshed.commits.map(commit => commit.oid))).toEqual(new Set([...expected, newTip]))
    expect(refreshed.snapshot.refs.find(ref => ref.name === 'refs/heads/main')?.oid).toBe(newTip)
    expect(refreshed.snapshot.roots).not.toEqual(initial.roots)
    const ref = ready(await f.service.history('repo', { ref: 'refs/heads/topic', limit: 1 }, f.config))
    expect(ref.snapshot.roots).toEqual([f.remote]); expect(ref.commits[0]?.oid).toBe(f.remote)
    expect(ref.nextCursor?.offset).toBe(1)
    await expect(f.service.history('repo', { ref: 'refs/tags/release' }, f.config)).rejects.toThrow('no observed commit')
    await expect(f.service.history('repo', { ref: '--all' }, f.config)).rejects.toThrow('no observed commit')
  }, 20_000)

  it('retains raw parents at a shallow boundary instead of pretending it is a root', async () => {
    const f = await repository()
    await writeFile(join(f.root, '.git', 'shallow'), f.merge! + '\n')
    const page = ready(await f.service.history('repo', { ref: 'refs/heads/main' }, f.config))
    expect(page.commits.map(commit => commit.oid)).toEqual([f.merge])
    expect(page.commits[0]?.parents).toEqual([f.main, f.topic])
    expect(page.nextCursor).toBeNull()
  }, 20_000)

  it('keeps unborn empty and non-repository distinct from unreadable refs, failed Git and invalid cursors', async () => {
    const f = await repository(true), empty = ready(await f.service.history('repo', {}, f.config))
    expect(empty.commits).toEqual([]); expect(empty.snapshot.roots).toEqual([]); expect(empty.nextCursor).toBeNull()
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-history-plain-'))); roots.push(plain)
    expect(await f.service.history('repo', {}, configuration(plain))).toEqual({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: plain })
    await expect(f.service.history('repo', { limit: 0 }, f.config)).rejects.toThrow('page size')
    await expect(f.service.history('repo', { cursor: { snapshot: empty.snapshot, offset: -1 } }, f.config)).rejects.toThrow('cursor offset')
    await expect(f.service.history('repo', { cursor: { snapshot: { ...empty.snapshot, hostId: 'other' }, offset: 0 } }, f.config)).rejects.toThrow('does not belong')
    await expect(f.service.history('repo', { cursor: { snapshot: { ...empty.snapshot, roots: ['--all'] }, offset: 0 } }, f.config)).rejects.toThrow('complete commit')
    await writeFile(join(f.root, '.git', 'HEAD'), '1'.repeat(40) + '\n')
    await expect(f.service.history('repo', {}, f.config)).rejects.toThrow()
  }, 20_000)

  it('reports reference metadata overflow and executor errors rather than a partial All or empty history', async () => {
    const f = await repository()
    const original = f.host.run.bind(f.host)
    vi.spyOn(f.host, 'run').mockImplementation(async (command, args, options) => {
      if (args.includes('for-each-ref')) return { exitCode: 0, stdout: Array.from({ length: 2001 }, (_, i) => `refs/heads/b${i}\0commit\0${f.seed}\0\0`).join('\n'), stderr: '' }
      return original(command, args, options)
    })
    await expect(f.service.history('repo', {}, f.config)).rejects.toThrow('2000-ref limit')
    vi.mocked(f.host.run).mockImplementation(async (command, args, options) => {
      if (args.includes('log')) throw new Error('private timeout')
      return original(command, args, options)
    })
    await expect(f.service.history('repo', {}, f.config)).rejects.toThrow('private timeout')
  }, 20_000)
})
