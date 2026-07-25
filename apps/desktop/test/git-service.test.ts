import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService } from '../src/main/git-service.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

const NONINTERACTIVE_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
}
const RUN_OPTIONS = { env: NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

function gitResult(args: readonly string[], stdout = '', stderr = '', exitCode = 0) {
  return { command: 'git', args, exitCode, stdout, stderr, durationMs: 1 }
}

/** A fake host that resolves the repo root and answers each git verb with canned output. */
function gitHost(handlers: {
  status?: () => ReturnType<typeof gitResult>
  add?: (args: readonly string[]) => ReturnType<typeof gitResult>
  commit?: (args: readonly string[], input?: unknown) => ReturnType<typeof gitResult>
} = {}): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async (_command: string, args: readonly string[], options?: { input?: unknown }) => {
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('status')) return handlers.status?.() ?? gitResult(args, '## main\0')
      if (args.includes('add')) return handlers.add?.(args) ?? gitResult(args)
      if (args.includes('commit')) return handlers.commit?.(args, options?.input) ?? gitResult(args)
      return gitResult(args)
    })
  }
}

function withWorkspace(host: ExecutionHost): { service: GitService; config: AppConfig } {
  const service = new GitService(() => host)
  return {
    service,
    config: {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }
  }
}

describe('GitService (contract, fake executor)', () => {
  it('reads status at the working-tree root with a non-interactive, locale-locked env', async () => {
    const host = gitHost({ status: () => gitResult([], '## main\0 M a.txt\0?? b.txt\0') })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.status('repo', cfg)

    expect(result).toEqual({
      kind: 'git-repository',
      hostId: 'remote',
      repoPath: '/srv/repo',
      branch: 'main',
      changes: [
        { path: 'a.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
        { path: 'b.txt', origPath: null, index: '?', worktree: '?', staged: false, unstaged: false, untracked: true }
      ]
    })
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
      RUN_OPTIONS
    )
  })

  it('models a plain folder as a non-Git state rather than throwing', async () => {
    const host = gitHost()
    vi.mocked(host.run).mockImplementation(async (_command, args) =>
      gitResult(args, '', 'fatal: not a git repository (or any of the parent directories): .git\n', 128)
    )
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.status('repo', cfg)).resolves.toEqual({
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: '/srv/repo'
    })
  })

  it('stages a file through -- and a :(literal) pathspec so a name is never read as a flag', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.stage('repo', '-rf dangerous.txt', cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'add', '--', ':(literal)-rf dangerous.txt'],
      RUN_OPTIONS
    )
  })

  it('rejects an empty path before any git call', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.stage('repo', '', cfg)).rejects.toThrow('A file path is required')
    expect(host.run).not.toHaveBeenCalled()
  })

  it('passes the commit message over stdin, never in argv', async () => {
    let seenInput: unknown
    const host = gitHost({
      commit: (_args, input) => {
        seenInput = input
        return gitResult([], '[main abc] done\n')
      }
    })
    const { service, config: cfg } = withWorkspace(host)

    await service.commit('repo', '  a message starting with -m  ', cfg)

    expect(seenInput).toBe('a message starting with -m')
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'commit', '--file=-', '--cleanup=whitespace'],
      { ...RUN_OPTIONS, input: 'a message starting with -m' }
    )
  })

  it('rejects an empty commit message before any git call', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.commit('repo', '   ', cfg)).rejects.toThrow('A commit message is required')
    expect(host.run).not.toHaveBeenCalled()
  })

  it('scrubs credentials out of a failing git error before it can surface', async () => {
    const host = gitHost({
      commit: () => gitResult(
        [],
        '',
        'fatal: unable to access https://alice:ghp_secret@github.com/o/r.git/',
        128
      )
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.commit('repo', 'msg', cfg)).rejects.toThrow(/\*\*\*@github\.com/)
    await expect(service.commit('repo', 'msg', cfg)).rejects.not.toThrow(/ghp_secret/)
  })
})

describe('GitService (real git, temporary repository)', () => {
  async function makeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-git-'))
    temporaryRoots.push(root)
    const host = new LocalExecutionHost()
    const run = async (args: string[], input?: string) => {
      const result = await host.run('git', ['-C', root, ...args], {
        timeoutMs: 20_000,
        ...(input === undefined ? {} : { input })
      })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
      return result
    }
    await run(['init', '-q'])
    // Identity is set repo-local, not via env: GitService.commit deliberately runs with only its
    // non-interactive env, so it must inherit the identity from git config the way a real checkout
    // does. This also proves the service does not depend on author env being passed in.
    await run(['config', 'user.email', 't@example.com'])
    await run(['config', 'user.name', 'Test'])
    await run(['commit', '-q', '--allow-empty', '-m', 'init'])
    return root
  }

  it('sees a change, stages exactly it, and commits it — the full slice against real git', async () => {
    const root = await makeRepo()
    // A name that begins with a dash and contains a space: the exact shape the argv hardening exists
    // for. If the `--`/`:(literal)` guard regressed, `git add` would read it as a flag and fail.
    const fileName = '-tricky name.txt'
    await writeFile(join(root, fileName), 'hello\n')

    const service = new GitService(() => new LocalExecutionHost())
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: root, kind: 'folder' }]
    }

    const before = await service.status('repo', cfg)
    expect(before.kind).toBe('git-repository')
    if (before.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(before.branch).not.toBeNull()
    const untracked = before.changes.find((change) => change.path === fileName)
    expect(untracked).toMatchObject({ untracked: true, staged: false })

    await service.stage('repo', fileName, cfg)
    const staged = await service.status('repo', cfg)
    if (staged.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(staged.changes.find((change) => change.path === fileName)).toMatchObject({ staged: true })

    await service.commit('repo', 'add the tricky file', cfg)
    const after = await service.status('repo', cfg)
    if (after.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(after.changes.find((change) => change.path === fileName)).toBeUndefined()
  })
})
