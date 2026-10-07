import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxControlServer, connectAgentMuxRpc, LocalExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService } from '../src/main/git-service.js'
import { GitPublicControl } from '../src/main/git-public-control.js'
import type { GitCommitDetailsResult } from '@agentmux/git/types'

const exec = promisify(execFile)
const runOptions = { timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
let root: string, repo: string, plain: string, server: AgentMuxControlServer, rootOid: string, renamedOid: string
let config: AppConfig, host: LocalExecutionHost, gitService: GitService, owner: GitPublicControl
let socket: string
const target = () => ({ workspaceId: 'original', expectedResource: { hostId: 'local', workspacePath: repo } })
const ready = (value: GitCommitDetailsResult) => { if (value.kind !== 'ready') throw new Error('Commit fixture must be readable'); return value }
async function git(...args: string[]) {
  const result = await host.run('git', ['-C', repo, ...args], runOptions)
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
async function cli(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/u.test(key)))
  const program = process.env.AGENTMUX_TEST_GIT_CLI ?? resolve('packages/core/bin/amux')
  try {
    const result = await exec(process.execPath, [program, '--endpoint', 'unix:' + socket, ...args], { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, body: JSON.parse(result.stdout), stderr: result.stderr }
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string }
    if (typeof result.code !== 'number') throw error
    return { code: result.code, body: JSON.parse(result.stdout.trim() || result.stderr.trim()), stderr: result.stderr }
  }
}
const cliTarget = () => ['--workspace', 'original', '--host', 'local', '--workspace-path', repo]

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-git-public-')))
  repo = join(root, 'repo'); plain = join(root, 'plain')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(repo); await mkdir(plain)
  host = new LocalExecutionHost()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Public Fixture'); await git('config', 'user.email', 'public@example.invalid')
  await writeFile(join(repo, 'old name.txt'), 'original content\nline two\nline three\n')
  await git('add', '--', 'old name.txt'); await git('commit', '-m', 'Root title', '-m', '完整 root body\nsecond line')
  rootOid = await git('rev-parse', 'HEAD')
  await rename(join(repo, 'old name.txt'), join(repo, 'new\nname 中文.txt'))
  await git('add', '-A'); await git('commit', '-m', 'Rename title', '-m', 'Full body\nwith another line')
  renamedOid = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'dirty.txt'), 'Keep user work\n')
  config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'original', hostId: 'local', path: repo, name: 'Original', kind: 'folder' },
      { id: 'plain', hostId: 'local', path: plain, name: 'Plain', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  gitService = new GitService(() => host)
  owner = new GitPublicControl({ config: () => config, git: gitService })
  socket = join(root, 'control.sock')
  server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [], git: owner,
    execute: async request => {
      if (request.operation !== 'open.git') throw new Error('Unexpected presentation request')
      const result = request.oid === undefined
        ? await owner.call('git.history', { workspaceId: request.workspaceId, expectedResource: request.expectedResource, limit: 1 })
        : await owner.call('git.commit', { workspaceId: request.workspaceId, expectedResource: request.expectedResource, oid: request.oid, ...(request.parentOid === undefined ? {} : { parentOid: request.parentOid }) })
      if (result.kind !== 'ready') throw new Error('Original repository unavailable')
      // Protocol-only placement; the real Renderer owner and public CLI are verified in the native probe.
      const snapshot = request.oid === undefined ? { hostId: result.snapshot.hostId, repoPath: result.snapshot.repoPath } : result.snapshot
      return { operation: 'open.git', workspaceId: request.workspaceId, read: { kind: 'ready', snapshot }, presentation: { tabId: 'original-git-tab', regionId: 'original-git-region' } }
    } })
  await server.start()
}, 20_000)
afterAll(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }) })

describe('public CLI to Desktop Git owner to neutral Git on a real private repository', () => {
  it('preserves real fixed RPC reads and opens when reference observation is unavailable', async () => {
    const run = host.run.bind(host)
    const observed = vi.spyOn(host, 'run').mockImplementation((command, args, options) => args.includes('for-each-ref')
      ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Reference observation temporarily unavailable' })
      : run(command, args, options))
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    try {
      const selected = ready(await client.call('git.commit', { ...target(), oid: rootOid }))
      expect(selected.commit.message).toBe('Root title\n\n完整 root body\nsecond line\n')
      expect(selected.entries).toHaveLength(1)
      expect(selected.warnings.join('\n')).toContain('Commit references unavailable')
      const entry = selected.entries[0]!
      const diff = await client.call('git.diff', { ...target(), input: { kind: 'commit', snapshot: selected.snapshot, file: { path: entry.path, origPath: entry.origPath } } })
      expect(diff.new).toMatchObject({ present: true, text: 'original content\nline two\nline three\n' })
      const opened = await client.call('git.open', { ...target(), oid: rootOid })
      expect(opened).toMatchObject({ read: { kind: 'ready', snapshot: selected.snapshot }, presentation: { regionId: 'original-git-region' } })
    } finally { observed.mockRestore(); await client.dispose() }
  })

  it('reads all messages, root/rename entries and immutable file contents over actual Unix RPC', async () => {
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    const before = await git('status', '--porcelain')
    try {
      const first = await client.call('git.commit', { ...target(), oid: rootOid })
      expect(first).toMatchObject({ kind: 'ready', snapshot: { commitOid: rootOid, parentOid: null }, commit: { message: 'Root title\n\n完整 root body\nsecond line\n' } })
      const selected = ready(await client.call('git.commit', { ...target(), oid: renamedOid, parentOid: rootOid }))
      expect(selected.entries).toEqual([{ path: 'new\nname 中文.txt', origPath: 'old name.txt', change: 'renamed' }])
      await git('commit', '--allow-empty', '-m', 'Moved HEAD')
      const entry = selected.entries[0]!
      const diff = await client.call('git.diff', { ...target(), input: { kind: 'commit', snapshot: selected.snapshot, file: { path: entry.path, origPath: entry.origPath } } })
      expect(diff).toMatchObject({ path: 'new\nname 中文.txt', old: { present: true, binary: false, text: 'original content\nline two\nline three\n' }, new: { present: true, binary: false, text: 'original content\nline two\nline three\n' } })
      expect(await git('status', '--porcelain')).toBe(before)
      expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('Keep user work\n')
    } finally { await client.dispose() }
  }, 20_000)

  it('runs the production CLI entry for history, commit, diff, open and generated help', async () => {
    const before = await git('rev-parse', 'HEAD'), status = await git('status', '--porcelain')
    const history = await cli(['git', 'history', ...cliTarget(), '--limit', '1'])
    expect(history.code, history.stderr).toBe(0); expect(history.body.result.commits).toHaveLength(1)
    expect(history.body.result.nextCursor.offset).toBe(1)
    const next = await cli(['git', 'history', ...cliTarget(), '--limit', '1', '--cursor', JSON.stringify(history.body.result.nextCursor)])
    expect(next.code, next.stderr).toBe(0); expect(next.body.result.snapshot).toEqual(history.body.result.snapshot)
    expect(next.body.result.commits[0].oid).not.toBe(history.body.result.commits[0].oid)
    const commit = await cli(['git', 'commit', ...cliTarget(), '--oid', renamedOid])
    expect(commit.code, commit.stderr).toBe(0); expect(commit.body.result.commit.message).toContain('Full body\nwith another line')
    const inputPath = join(root, 'diff.json')
    await writeFile(inputPath, JSON.stringify({ kind: 'commit', snapshot: commit.body.result.snapshot, file: { path: 'new\nname 中文.txt', origPath: 'old name.txt' } }))
    const diff = await cli(['git', 'diff', ...cliTarget(), '--input', inputPath])
    expect(diff.code, diff.stderr).toBe(0); expect(diff.body.result.new.text).toBe('original content\nline two\nline three\n')
    const opened = await cli(['git', 'open', ...cliTarget(), '--oid', renamedOid, '--operation-id', 'git-open-public'])
    expect(opened.code, opened.stderr).toBe(0)
    expect(opened.body).toMatchObject({ operation: 'git.open', operationId: 'git-open-public', result: { read: { kind: 'ready', snapshot: { commitOid: renamedOid } }, presentation: { tabId: 'original-git-tab', regionId: 'original-git-region' } } })
    const repository = await cli(['git', 'open', ...cliTarget(), '--operation-id', 'git-history-public'])
    expect(repository.code, repository.stderr).toBe(0)
    expect(repository.body.result.read.snapshot).toEqual({ hostId: 'local', repoPath: repo })
    expect(await git('rev-parse', 'HEAD')).toBe(before); expect(await git('status', '--porcelain')).toBe(status)
  }, 60_000)

  it('refuses wrong targets before Git and refuses a resource changed during a read', async () => {
    const history = vi.spyOn(gitService, 'history')
    await expect(owner.call('git.history', { ...target(), expectedResource: { hostId: 'another', workspacePath: repo } })).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' })
    await expect(owner.call('git.history', { ...target(), workspaceId: 'missing' })).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' })
    await expect(owner.call('git.history', { ...target(), expectedResource: { hostId: 'local', workspacePath: plain } })).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' })
    expect(history).not.toHaveBeenCalled()
    history.mockRestore()
    const original = config.workspaces[0]!
    const pendingOwner = new GitPublicControl({ config: () => config, git: { ...gitService, history: async (...args) => {
      const value = await gitService.history(...args); config = { ...config, workspaces: [{ ...original, path: plain }] }; return value
    }, commitDetails: gitService.commitDetails.bind(gitService), commitDiff: gitService.commitDiff.bind(gitService), branchDiff: gitService.branchDiff.bind(gitService) } })
    try { await expect(pendingOwner.call('git.history', target())).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' }) }
    finally { config = { ...config, workspaces: [original, { id: 'plain', hostId: 'local', path: plain, name: 'Plain', kind: 'folder' }] } }
  })

  it('keeps plain directories explicit and Git failures actionable through the real CLI', async () => {
    const folder = await owner.call('git.history', { workspaceId: 'plain', expectedResource: { hostId: 'local', workspacePath: plain } })
    expect(folder).toEqual({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: plain })
    const foreign = await cli(['git', 'commit', '--workspace', 'original', '--host', 'local', '--workspace-path', plain, '--oid', renamedOid])
    expect(foreign.code).toBe(1); expect(foreign.body.error.code).toBe('GIT_RESOURCE_MISMATCH')
    const missing = await cli(['git', 'commit', ...cliTarget(), '--oid', 'f'.repeat(40)])
    expect(missing.code).toBe(1); expect(missing.body.ok).toBe(false)
    const wrongParent = await cli(['git', 'commit', ...cliTarget(), '--oid', rootOid, '--parent', renamedOid])
    expect(wrongParent.code).toBe(1); expect(wrongParent.body.ok).toBe(false)
    expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('Keep user work\n')
  }, 60_000)

  it('prints the actual compiled command and skill discovery without needing a Git request', async () => {
    const program = process.env.AGENTMUX_TEST_GIT_CLI ?? resolve('packages/core/bin/amux')
    const objectHelp = await exec(process.execPath, [program, '--help', 'git'], { timeout: 15_000 })
    for (const action of ['history', 'commit', 'diff', 'open']) expect(objectHelp.stdout).toContain('amux git ' + action)
    const diffHelp = await exec(process.execPath, [program, '--help', 'git', 'diff'], { timeout: 15_000 })
    expect(diffHelp.stdout).toContain('--input FILE|-'); expect(diffHelp.stdout).toContain('Keep both rename paths')
    const skill = await exec(process.execPath, [program, 'git', '--skill'], { timeout: 15_000 })
    expect(skill.stdout).toContain('Reading never checks out, stages or writes Git')
    expect(skill.stdout).toContain('read and presentation are separate facts')
  }, 30_000)
})
