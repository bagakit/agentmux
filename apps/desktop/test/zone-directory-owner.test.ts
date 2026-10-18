import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentMuxControlServer, LocalExecutionHost, connectAgentMuxRpc } from '@agentmux/core'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'
import type { GitWorktreesResult } from '@agentmux/git/types'
import { parseGitResult } from '../../../packages/core/src/public-rpc-git'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'
import { WorktreeService } from '../src/main/worktree-service'
import { GitService } from '../src/main/git-service'
import { GitPublicControl } from '../src/main/git-public-control'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'

let root: string, repo: string, lane: string, host: LocalExecutionHost, workspace: WorkspaceRecord, config: AppConfig
let native: WorktreeService, owner: GitPublicControl
const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
const target = () => ({ workspaceId: workspace.id, expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
const ready = (value: GitWorktreesResult) => { expect(value.kind).toBe('ready'); if (value.kind !== 'ready') throw Error('Fixture Git unavailable'); return value }
async function git(...args: string[]) {
  const value = await host.run('git', args, options)
  expect(value.exitCode, value.stderr).toBe(0)
  return value.stdout
}
function candidate(path: string, id = path): WorkspaceRecord { return { ...workspace, id, path, repoPath: repo, kind: 'worktree', branch: 'old registration' } }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'zd-')))
  repo = join(root, 'repo'); lane = join(root, 'linked\n目录'); await mkdir(repo)
  host = new LocalExecutionHost()
  await git('init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'source.txt'), 'original\n')
  await git('-C', repo, 'add', '.')
  await git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed')
  await git('-C', repo, 'worktree', 'add', '-qb', 'lane', lane)
  workspace = { id: 'original-root', name: 'Original', path: repo, hostId: 'local', kind: 'folder', repoPath: repo }
  config = { version: 9, workspaces: [workspace], hosts: [{ id: 'local', kind: 'local', label: 'Fixture' }], executors: {},
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
      viewport: true, saveBookmark: true, more: true } } }
  native = new WorktreeService(() => host, { save: async () => { throw Error('Read must never write configuration') } })
  owner = new GitPublicControl({ config: () => config, git: new GitService(() => host), worktrees: native })
})
afterEach(async () => { vi.restoreAllMocks(); await host.dispose(); await rm(root, { recursive: true, force: true }) })

it('observes a deduplicated native/candidate union with missing, ordinary directory, non-directory and proven aliases', async () => {
  const missing = join(root, 'missing'), file = join(root, 'file'), plain = join(root, 'plain'), alias = join(root, 'alias'), dangling = join(root, 'dangling')
  await writeFile(file, 'ordinary file'); await mkdir(plain); await symlink(lane, alias); await symlink(missing, dangling)
  const candidates = [missing, file, plain, alias, dangling, join(file, 'child'), lane]
  config = { ...config, workspaces: [workspace, ...candidates.map(path => candidate(path)),
    { ...candidate(join(root, 'foreign')), hostId: 'foreign' }, { ...candidate(join(root, 'unrelated')), repoPath: join(root, 'different-repo') }] }
  const before = JSON.stringify(config), calls = vi.spyOn(host, 'run'), result = ready(await native.observe(workspace.id, config))
  expect(result.directories).toEqual([
    { path: repo, kind: 'directory', canonicalPath: repo }, { path: lane, kind: 'directory', canonicalPath: lane },
    { path: missing, kind: 'missing' }, { path: file, kind: 'not-directory' }, { path: plain, kind: 'directory', canonicalPath: plain },
    { path: alias, kind: 'directory', canonicalPath: lane }, { path: dangling, kind: 'missing' }, { path: join(file, 'child'), kind: 'missing' }
  ])
  expect(result.warnings).toEqual([])
  expect(result.worktrees.map(value => value.path)).toEqual([repo, lane])
  expect(result.worktrees[1]!.aliases).toEqual([alias])
  expect(parseGitResult('git.worktrees', result, target())).toBe(result)
  expect(calls.mock.calls.filter(call => call[0] === 'node')).toHaveLength(1)
  expect(calls.mock.calls.filter(call => call[0] === 'git')).toHaveLength(2)
  expect(JSON.stringify(config)).toBe(before)
  await symlink(lane, missing)
  const refreshed = ready(await owner.call('git.worktrees', target()))
  expect(refreshed.directories.find(value => value.path === missing)).toEqual({ path: missing, kind: 'directory', canonicalPath: lane })
  expect(refreshed.worktrees[1]!.aliases).toEqual([missing, alias, dangling])
})

it('keeps native registered-but-missing entries even without a corresponding config candidate', async () => {
  await rm(lane, { recursive: true })
  const result = ready(await native.observe(workspace.id, config))
  expect(result.worktrees[1]).toMatchObject({ path: lane, branch: 'lane', kind: 'linked' })
  expect(result.directories).toEqual([{ path: repo, kind: 'directory', canonicalPath: repo }, { path: lane, kind: 'missing' }])
  expect(result.warnings).toEqual([])
  expect(parseGitResult('git.worktrees', result, target())).toBe(result)
  expect(await git('-C', repo, 'worktree', 'list', '--porcelain', '-z')).toContain(`worktree ${lane}\0`)
})

it('retains successful directory facts but marks ambiguous alias relationships incomplete', async () => {
  const run = host.run.bind(host)
  vi.spyOn(host, 'run').mockImplementation(async (command, args, options) => {
    const result = await run(command, args, options)
    if (command !== 'node') return result
    return { ...result, stdout: JSON.stringify(JSON.parse(result.stdout).map((value: { path: string }) => value.path === lane
      ? { path: lane, kind: 'directory', canonicalPath: repo } : value)) }
  })
  const result = ready(await owner.call('git.worktrees', target()))
  expect(result.directories).toEqual([{ path: repo, kind: 'directory', canonicalPath: repo }, { path: lane, kind: 'directory', canonicalPath: repo }])
  expect(result.worktrees.map(value => value.aliases)).toEqual([[], []])
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain('ambiguous')
})

it.each(['EACCES', 'EIO', 'ELOOP'])('retains per-path %s as unavailable, independent of healthy Git', async code => {
  const path = join(root, 'probe-failure'), run = host.run.bind(host)
  config = { ...config, workspaces: [workspace, candidate(path)] }
  vi.spyOn(host, 'run').mockImplementation(async (command, args, options) => {
    const result = await run(command, args, options)
    if (command !== 'node') return result
    return { ...result, stdout: JSON.stringify(JSON.parse(result.stdout).map((value: { path: string }) => value.path === path
      ? { path, kind: 'unavailable', reason: `${code}: controlled Host failure` } : value)) }
  })
  const result = ready(await owner.call('git.worktrees', target()))
  expect(result.worktrees).toHaveLength(2)
  expect(result.directories.find(value => value.path === path)).toEqual({ path, kind: 'unavailable', reason: `${code}: controlled Host failure` })
  expect(result.warnings).toEqual([])
})

it.each(['process', 'malformed', 'wrong-path', 'unknown-kind', 'relative-canonical', 'extra-field', 'nul-canonical', 'nul-reason'])('preserves native content and exposes whole FS %s failure on every requested path', async failure => {
  const run = host.run.bind(host)
  vi.spyOn(host, 'run').mockImplementation(async (command, args, options) => {
    const result = await run(command, args, options)
    if (command !== 'node') return result
    if (failure === 'process') return { ...result, exitCode: 1, stderr: 'Controlled Host offline' }
    if (failure === 'malformed') return { ...result, stdout: '{}' }
    const values = JSON.parse(result.stdout); values[0] = failure === 'wrong-path' ? { ...values[0], path: lane }
      : failure === 'relative-canonical' ? { ...values[0], canonicalPath: 'relative' }
        : failure === 'nul-canonical' ? { ...values[0], canonicalPath: repo + '\0bad' }
          : failure === 'nul-reason' ? { path: repo, kind: 'unavailable', reason: 'EIO\0bad' }
        : failure === 'extra-field' ? { ...values[0], injected: true } : { ...values[0], kind: 'invented' }
    return { ...result, stdout: JSON.stringify(values) }
  })
  const result = ready(await native.observe(workspace.id, config))
  expect(result.worktrees.map(value => value.path)).toEqual([repo, lane])
  expect(result.directories).toEqual([repo, lane].map(path => ({ path, kind: 'unavailable', reason: expect.any(String) })))
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain('Canonical Git worktrees remain readable')
  expect(parseGitResult('git.worktrees', result, target())).toBe(result)
})

it('reports directory facts for plain, missing and Git-unavailable original targets', async () => {
  const plain = join(root, 'plain'); await mkdir(plain)
  config = { ...config, workspaces: [{ ...workspace, path: plain }] }; workspace = config.workspaces[0]!
  expect(await owner.call('git.worktrees', target())).toMatchObject({ kind: 'not-a-git-repository', directories: [{ path: plain, kind: 'directory', canonicalPath: plain }] })
  const missing = join(root, 'missing')
  config = { ...config, workspaces: [{ ...workspace, path: missing }] }; workspace = config.workspaces[0]!
  expect(await owner.call('git.worktrees', target())).toMatchObject({ kind: 'unavailable', directories: [{ path: missing, kind: 'missing' }] })
  config = { ...config, workspaces: [{ ...workspace, path: repo }] }; workspace = config.workspaces[0]!
  const run = host.run.bind(host)
  vi.spyOn(host, 'run').mockImplementation(async (command, args, options) => command === 'git'
    ? { command, args, exitCode: 1, stdout: '', stderr: 'Controlled Git unavailable', durationMs: 1 } : run(command, args, options))
  const result = await owner.call('git.worktrees', target())
  expect(result).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('Controlled Git unavailable'),
    directories: [{ path: repo, kind: 'directory', canonicalPath: repo }] })
})

it('uses the real bare-plus-linked native owner from its linked checkout target', async () => {
  const bare = join(root, 'bare.git'), linked = join(root, 'bare-linked')
  await git('clone', '--bare', repo, bare); await git('-C', bare, 'worktree', 'add', '-b', 'bare-lane', linked)
  workspace = { ...workspace, path: linked }; config = { ...config, workspaces: [workspace] }
  const result = ready(await owner.call('git.worktrees', target()))
  expect(result.worktrees).toEqual([{ path: bare, kind: 'bare', branch: null, detached: false, aliases: [] },
    { path: linked, kind: 'linked', branch: 'bare-lane', detached: false, aliases: [] }])
  expect(result.directories).toEqual([bare, linked].map(path => ({ path, kind: 'directory', canonicalPath: path })))
})

it('strictly validates all directory states, coverage and aliases through the original public codec', async () => {
  const value = ready(await owner.call('git.worktrees', target()))
  expect(parseGitResult('git.worktrees', value, target())).toBe(value)
  const invalid = [
    { ...value, directories: [] }, { ...value, directories: [value.directories[0], value.directories[0]] },
    { ...value, directories: value.directories.slice(0, 1) },
    ...[{ path: lane, kind: 'directory' }, { path: lane, kind: 'missing', canonicalPath: lane },
      { path: lane, kind: 'unavailable', reason: '' }, { path: 'relative', kind: 'missing' }, { path: lane, kind: 'invented' }]
      .map(directory => ({ ...value, directories: [value.directories[0], directory] })),
    { ...value, worktrees: [value.worktrees[0], { ...value.worktrees[1], aliases: [join(root, 'fake')] }] }
  ]
  for (const answer of invalid) expect(() => parseGitResult('git.worktrees', answer, target())).toThrow()
  const noNative = new GitPublicControl({ config: () => config, git: new GitService(() => host) })
  expect(await noNative.call('git.worktrees', target())).toMatchObject({ kind: 'unavailable', directories: [{ path: repo, kind: 'unavailable' }] })
  expect(agentMuxCommandHelp('git.worktrees')).toContain('Directory observations independently')
})

it('delivers structured current directory facts through public RPC and the actual compiled source CLI', async () => {
  const missing = join(root, 'saved-missing'); config = { ...config, workspaces: [workspace, candidate(missing)] }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), git: owner })
  await server.start()
  try {
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'public.sock') } })
    try { expect((await client.call('git.worktrees', target())).directories.find(value => value.path === missing)).toEqual({ path: missing, kind: 'missing' }) }
    finally { await client.dispose() }
    const program = process.env.AGENTMUX_TEST_GIT_CLI ?? resolve('.local/zone-clarity/compiled-cli/dist/agentmux.js')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/u.test(key)))
    for (const [path, expected] of [[repo, 'ready'], [missing, 'unavailable']] as const) {
      if (path === missing) { workspace = { ...workspace, path }; config = { ...config, workspaces: [workspace] } }
      const result = await promisify(execFile)(process.execPath, [program, '--endpoint', `unix:${join(root, 'public.sock')}`, 'git', 'worktrees',
        '--workspace', workspace.id, '--host', workspace.hostId, '--workspace-path', workspace.path], { env, timeout: 15_000 })
      const response = JSON.parse(result.stdout)
      if (process.env.ZONE_CLARITY_CLI_EVIDENCE) await appendFile(process.env.ZONE_CLARITY_CLI_EVIDENCE, JSON.stringify({ args: ['git', 'worktrees', workspace.id, workspace.hostId, workspace.path], response }) + '\n')
      expect(response.ok).toBe(true); expect(response.operation).toBe('git.worktrees'); expect(response.result.kind).toBe(expected)
      expect(response.result.directories).toContainEqual({ path: missing, kind: 'missing' })
    }
  } finally { await server.stop() }
})
