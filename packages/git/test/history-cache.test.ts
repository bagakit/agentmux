import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { GitRepository, GIT_NONINTERACTIVE_ENV, readLocalWorktreeFile, type GitHistoryResult, type GitCommandRunner } from '../src/index.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
function ready(value: GitHistoryResult) {
  expect(value.kind).toBe('ready')
  if (value.kind !== 'ready') throw new Error('Expected actual history')
  return value
}
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-history-cache-'))); roots.push(path)
  const host: GitCommandRunner = { run: (command, args, options) => new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { env: { ...process.env, ...options?.env }, timeout: options?.timeoutMs,
      maxBuffer: options?.maxOutputBytes, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return }
      resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
    })
    child.stdin?.end(options?.input)
  }) }
  const git = async (args: string[], input?: string) => {
    const result = await host.run('git', ['-C', path, ...args], { ...options, ...(input === undefined ? {} : { input }) })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'History Cache Fixture'])
  await git(['config', 'user.email', 'fixture@example.invalid'])
  const commit = async (message: string) => { await git(['commit', '--allow-empty', '-F', '-'], message); return git(['rev-parse', 'HEAD']) }
  await commit('Ancestor')
  const seed = await commit('Seed'), next = await commit('Next')
  const repository = () => new GitRepository({ hostId: 'local', path }, host, readLocalWorktreeFile)
  const originalRun = host.run.bind(host), run = vi.spyOn(host, 'run')
  const logs = () => run.mock.calls.filter(([, args]) => args.includes('log'))
  return { path, host, git, commit, seed, next, repository, originalRun, run, logs }
}

it('reuses exact first-page objects across repository instances while refreshing refs and protecting cached bytes from callers', async () => {
  const f = await fixture()
  const first = ready(await f.repository().history({ limit: 1 }))
  expect(f.logs()).toHaveLength(1)
  first.commits[0]!.parents.length = 0
  first.commits[0]!.subject = 'Caller edit'
  first.snapshot.refs.length = 0
  await f.git(['tag', 'fresh-decoration', f.next])
  const second = ready(await f.repository().history({ limit: 1 }))
  expect(f.logs()).toHaveLength(1)
  expect(second.commits[0]).toMatchObject({ oid: f.next, subject: 'Next', parents: [f.seed] })
  expect(second.commits[0]!.refs.map(ref => ref.name)).toContain('refs/tags/fresh-decoration')
  expect(second.snapshot.checkedAt).toBeGreaterThan(first.snapshot.checkedAt)
  expect(f.run.mock.calls.filter(([, args]) => args.includes('for-each-ref'))).toHaveLength(2)
  expect(f.run.mock.calls.filter(([, args]) => args.includes('HEAD^{commit}'))).toHaveLength(2)
  const last = await f.commit('New immutable root')
  const changed = ready(await f.repository().history({ limit: 1 }))
  expect(f.logs()).toHaveLength(2); expect(changed.commits[0]!.oid).toBe(last)
}, 20_000)

it('separates page sizes and Host runners, keeps cursors on Git, and reports current missing roots', async () => {
  const f = await fixture()
  const first = ready(await f.repository().history({ limit: 1 }))
  const full = ready(await f.repository().history({ limit: 2 }))
  expect(full.commits).toHaveLength(2); expect(full.nextCursor?.offset).toBe(2); expect(f.logs()).toHaveLength(2)
  const next = ready(await f.repository().history({ limit: 1, cursor: first.nextCursor! }))
  expect(next.commits[0]!.oid).toBe(f.seed); expect(f.logs()).toHaveLength(3)
  const otherRunner = { run: f.host.run.bind(f.host) }
  await new GitRepository({ hostId: 'local', path: f.path }, otherRunner, readLocalWorktreeFile).history({ limit: 1 })
  expect(f.logs()).toHaveLength(4)
  await new GitRepository({ hostId: 'other-host', path: f.path }, f.host, readLocalWorktreeFile).history({ limit: 1 })
  expect(f.logs()).toHaveLength(5)
  // A broken authoritative observation cannot be hidden by a completed cache entry.
  f.run.mockImplementation((command, args, input) => args.includes('for-each-ref')
    ? Promise.resolve({ exitCode: 128, stdout: '', stderr: 'Missing referenced object' }) : f.originalRun(command, args, input))
  await expect(f.repository().history({ limit: 1 })).rejects.toThrow('Missing referenced object')
}, 20_000)

it('evicts least recently read metadata at the byte budget and serves oversized pages without retaining them', async () => {
  const f = await fixture()
  await f.commit('Large immutable message\n\n' + 'x'.repeat(600_000))
  await f.repository().history({ limit: 1 }); await f.repository().history({ limit: 2 })
  await f.repository().history({ limit: 1 }); expect(f.logs()).toHaveLength(3)
  await f.commit('Oversized immutable message\n\n' + 'y'.repeat(1_100_000))
  await f.repository().history({ limit: 1 }); await f.repository().history({ limit: 1 })
  expect(f.logs()).toHaveLength(5)
}, 20_000)

it('bounds the number of small retained pages without limiting subsequent reads', async () => {
  const f = await fixture()
  for (let limit = 1; limit <= 16; limit += 1) await f.repository().history({ limit })
  await f.repository().history({ limit: 1 }); await f.repository().history({ limit: 17 })
  await f.repository().history({ limit: 1 }); expect(f.logs()).toHaveLength(17)
  await f.repository().history({ limit: 2 }); expect(f.logs()).toHaveLength(18)
}, 20_000)

it('keeps changing shallow boundaries authoritative even when complete root OIDs stay unchanged', async () => {
  const f = await fixture()
  expect(ready(await f.repository().history()).commits).toHaveLength(3)
  await writeFile(join(f.path, '.git', 'shallow'), f.next + '\n')
  expect(ready(await f.repository().history()).commits.map(commit => commit.oid)).toEqual([f.next])
  expect(ready(await f.repository().history()).commits.map(commit => commit.oid)).toEqual([f.next])
  expect(f.logs()).toHaveLength(3)
}, 20_000)

it('keeps legacy graft changes authoritative and ignores replace refs along the original no-replacement contract', async () => {
  const f = await fixture()
  const original = ready(await f.repository().history())
  await f.git(['replace', '--graft', f.next])
  const replacement = ready(await f.repository().history())
  expect(replacement.commits).toEqual(original.commits); expect(f.logs()).toHaveLength(1)
  await writeFile(join(f.path, '.git', 'info', 'grafts'), f.next + '\n')
  expect(ready(await f.repository().history()).commits.map(commit => commit.oid)).toEqual([f.next])
  expect(f.logs()).toHaveLength(2)
  await rm(join(f.path, '.git', 'info', 'grafts'))
  expect(ready(await f.repository().history()).commits).toEqual(original.commits)
  expect(f.logs()).toHaveLength(2)
  const unavailable = new GitRepository({ hostId: 'local', path: f.path }, f.host, async () => { throw new Error('Metadata unavailable') })
  expect(ready(await unavailable.history()).commits).toEqual(original.commits)
  expect(f.logs()).toHaveLength(3)
}, 20_000)
