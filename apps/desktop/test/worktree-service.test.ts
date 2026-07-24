import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  parseGitBranches,
  parseGitWorktreePorcelain,
  WorktreeService
} from '../src/main/worktree-service.js'

const config: AppConfig = {
  version: 3,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: []
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

function gitResult(args: readonly string[], stdout = '', stderr = '', exitCode = 0) {
  return { command: 'git', args, exitCode, stdout, stderr, durationMs: 1 }
}

function branchHost(options: { createExitCode?: number } = {}): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes('rev-parse')) return gitResult(args, (_hygiene_fixturePath("srv/repo") + "\n"))
      if (args.includes('for-each-ref')) {
        return gitResult(args, 'feature/free\nfeature/used\nmain\n')
      }
      if (args.includes('list')) {
        return gitResult(
          args,
          ("worktree " + _hygiene_fixturePath("srv/repo\u0000HEAD") + " abc\u0000branch refs/heads/main\u0000\u0000") +
          ("worktree " + _hygiene_fixturePath("srv/worktrees/used\u0000HEAD") + " def\u0000branch refs/heads/feature/used\u0000\u0000")
        )
      }
      if (args.includes('add')) {
        const exitCode = options.createExitCode ?? 0
        return gitResult(args, '', exitCode ? 'fatal: could not create worktree' : '', exitCode)
      }
      return gitResult(args)
    })
  }
}

describe('WorktreeService', () => {
  it('parses branch and null-delimited worktree evidence without losing paths', () => {
    expect(parseGitBranches('main\nfeature/a\nmain\n')).toEqual(['main', 'feature/a'])
    expect(parseGitWorktreePorcelain(
      ("worktree " + _hygiene_fixturePath("srv/repo") + " with space\u0000HEAD abc\u0000branch refs/heads/main\u0000\u0000") +
      ("worktree " + _hygiene_fixturePath("srv/worktrees/free\u0000HEAD") + " def\u0000detached\u0000\u0000")
    )).toEqual([
      { path: (_hygiene_fixturePath("srv/repo") + " with space"), branch: 'main' },
      { path: _hygiene_fixturePath("srv/worktrees/free"), branch: null }
    ])
  })

  it('projects bound and unbound branches from remote Git truth', async () => {
    const executionHost = branchHost()
    const service = new WorktreeService(() => executionHost, { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), kind: 'folder' }]
    }

    const snapshot = await service.list('repo', branchConfig)

    expect(snapshot).toEqual({
      kind: 'git-repository',
      hostId: 'remote',
      repoPath: _hygiene_fixturePath("srv/repo"),
      branches: [
        { name: 'main', worktreePath: _hygiene_fixturePath("srv/repo"), workspaceId: 'repo', isCurrent: true },
        { name: 'feature/used', worktreePath: _hygiene_fixturePath("srv/worktrees/used"), workspaceId: null, isCurrent: false },
        { name: 'feature/free', worktreePath: null, workspaceId: null, isCurrent: false }
      ]
    })
  })

  it('models a plain folder as a normal non-Git capability state', async () => {
    const executionHost = branchHost()
    vi.mocked(executionHost.run).mockImplementation(async (command, args) => command === 'test'
      ? gitResult(args, '', '', 1)
      : gitResult(
          args,
          '',
          'fatal: not a git repository (or any of the parent directories): .git\n',
          128
        ))
    const service = new WorktreeService(() => executionHost, { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'plain', name: 'plain', hostId: 'remote', path: _hygiene_fixturePath("srv/plain-folder"), kind: 'folder' }]
    }

    await expect(service.list('plain', branchConfig)).resolves.toEqual({
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: _hygiene_fixturePath("srv/plain-folder")
    })
    expect(executionHost.run).toHaveBeenCalledWith(
      'git',
      ['-C', _hygiene_fixturePath("srv/plain-folder"), 'rev-parse', '--show-toplevel'],
      {
        env: { LC_ALL: 'C', LANG: 'C' },
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024
      }
    )
    expect(executionHost.run).toHaveBeenNthCalledWith(
      2,
      'test',
      ['-e', _hygiene_fixturePath("srv/plain-folder/.git"), '-o', '-L', _hygiene_fixturePath("srv/plain-folder/.git")],
      { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 }
    )
    expect(executionHost.run).toHaveBeenNthCalledWith(
      3,
      'test',
      ['-e', _hygiene_fixturePath("srv/.git"), '-o', '-L', _hygiene_fixturePath("srv/.git")],
      { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 }
    )
    expect(executionHost.run).toHaveBeenNthCalledWith(
      4,
      'test',
      ['-e', '/.git', '-o', '-L', '/.git'],
      { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 }
    )
  })

  it.each([
    ("fatal: detected dubious ownership in repository at " + _hygiene_fixturePath("srv/repo") + "\n"),
    ("fatal: cannot change to " + _hygiene_fixturePath("srv/missing:") + " Permission denied\n")
  ])('keeps unrelated Git discovery failures fail-closed: %s', async (stderr) => {
    const executionHost = branchHost()
    vi.mocked(executionHost.run).mockImplementation(async (_command, args) => gitResult(args, '', stderr, 128))
    const service = new WorktreeService(() => executionHost, { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), kind: 'folder' }]
    }

    await expect(service.list('repo', branchConfig)).rejects.toThrow(stderr.trim())
  })

  it('rejects Git-only branch actions for a plain folder', async () => {
    const executionHost = branchHost()
    vi.mocked(executionHost.run).mockImplementation(async (command, args) => command === 'test'
      ? gitResult(args, '', '', 1)
      : gitResult(
          args,
          '',
          'fatal: not a git repository (or any of the parent directories): .git\n',
          128
        ))
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'plain', name: 'plain', hostId: 'remote', path: _hygiene_fixturePath("srv/plain-folder"), kind: 'folder' }]
    }

    await expect(service.openBranch('plain', 'main', branchConfig)).rejects.toThrow(
      'Workspace is not a Git repository'
    )
    await expect(service.createForBranch({
      workspaceId: 'plain',
      branch: 'main',
      path: _hygiene_fixturePath("srv/plain-folder.worktrees/main")
    }, branchConfig)).rejects.toThrow('Workspace is not a Git repository')
    expect(save).not.toHaveBeenCalled()
  })

  it('fails closed when present Git metadata is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-corrupt-repository-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/\n')
    const service = new WorktreeService(() => new LocalExecutionHost(), { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    await expect(service.list('repo', branchConfig)).rejects.toThrow('not a git repository')
  })

  it('fails closed when Git metadata is a dangling symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-dangling-git-metadata-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    await symlink(join(root, 'missing-git-directory'), join(repoPath, '.git'))
    const service = new WorktreeService(() => new LocalExecutionHost(), { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    await expect(service.list('repo', branchConfig)).rejects.toThrow('not a git repository')
  })

  it('registers an existing worktree only when its bound branch is opened', async () => {
    const executionHost = branchHost()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), kind: 'folder' }]
    }

    const selection = await service.openBranch('repo', 'feature/used', branchConfig)

    expect(selection.workspace).toMatchObject({
      hostId: 'remote',
      path: _hygiene_fixturePath("srv/worktrees/used"),
      branch: 'feature/used',
      repoPath: _hygiene_fixturePath("srv/repo"),
      kind: 'worktree'
    })
    expect(selection.config.workspaces).toHaveLength(2)
    expect(save).toHaveBeenCalledOnce()
  })

  it('creates an existing unbound branch worktree and registers only after Git succeeds', async () => {
    const executionHost = branchHost()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), kind: 'folder' }]
    }

    const selection = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/free',
      path: _hygiene_fixturePath("srv/worktrees/free")
    }, branchConfig)

    expect(executionHost.run).toHaveBeenCalledWith(
      'git',
      ['-C', _hygiene_fixturePath("srv/repo"), 'worktree', 'add', '--', _hygiene_fixturePath("srv/worktrees/free"), 'feature/free'],
      { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    expect(selection.workspace).toMatchObject({ path: _hygiene_fixturePath("srv/worktrees/free"), branch: 'feature/free' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('does not register an unbound branch when Git worktree creation fails', async () => {
    const executionHost = branchHost({ createExitCode: 128 })
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), kind: 'folder' }]
    }

    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/free',
      path: _hygiene_fixturePath("srv/worktrees/free")
    }, branchConfig)).rejects.toThrow('fatal: could not create worktree')
    expect(save).not.toHaveBeenCalled()
  })

  it('creates and registers a real local Git worktree for an existing branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const worktreePath = join(root, 'worktrees', 'feature-real')
    await mkdir(repoPath)
    const executionHost = new LocalExecutionHost()
    expect((await executionHost.run('git', ['-C', repoPath, 'init', '-b', 'main'])).exitCode).toBe(0)
    await writeFile(join(repoPath, 'README.md'), '# fixture\n')
    expect((await executionHost.run('git', ['-C', repoPath, 'add', 'README.md'])).exitCode).toBe(0)
    expect((await executionHost.run('git', [
      '-C', repoPath,
      '-c', 'user.name=AgentMux Test',
      '-c', 'user.email=agentmux@example.invalid',
      'commit', '-m', 'fixture'
    ])).exitCode).toBe(0)
    expect((await executionHost.run('git', ['-C', repoPath, 'branch', 'feature/real'])).exitCode).toBe(0)

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }
    const creation = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/real',
      path: worktreePath
    }, branchConfig)

    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect((await executionHost.run('git', ['-C', worktreePath, 'branch', '--show-current'])).stdout.trim()).toBe('feature/real')
    expect(creation.workspace).toMatchObject({ path: worktreePath, branch: 'feature/real', kind: 'worktree' })
    expect(save).toHaveBeenCalledOnce()
  })
})
