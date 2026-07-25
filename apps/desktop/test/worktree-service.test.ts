import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
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
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('for-each-ref')) {
        return gitResult(args, 'feature/free\nfeature/used\nmain\n')
      }
      if (args.includes('list')) {
        return gitResult(
          args,
          'worktree /srv/repo\0HEAD abc\0branch refs/heads/main\0\0' +
          'worktree /srv/worktrees/used\0HEAD def\0branch refs/heads/feature/used\0\0'
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
      'worktree /srv/repo with space\0HEAD abc\0branch refs/heads/main\0\0' +
      'worktree /srv/worktrees/free\0HEAD def\0detached\0\0'
    )).toEqual([
      { path: '/srv/repo with space', branch: 'main' },
      { path: '/srv/worktrees/free', branch: null }
    ])
  })

  it('projects bound and unbound branches from remote Git truth', async () => {
    const executionHost = branchHost()
    const service = new WorktreeService(() => executionHost, { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    const snapshot = await service.list('repo', branchConfig)

    expect(snapshot).toEqual({
      kind: 'git-repository',
      hostId: 'remote',
      repoPath: '/srv/repo',
      branches: [
        { name: 'main', worktreePath: '/srv/repo', workspaceId: 'repo', isCurrent: true },
        { name: 'feature/used', worktreePath: '/srv/worktrees/used', workspaceId: null, isCurrent: false },
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
      workspaces: [{ id: 'plain', name: 'plain', hostId: 'remote', path: '/srv/plain-folder', kind: 'folder' }]
    }

    await expect(service.list('plain', branchConfig)).resolves.toEqual({
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: '/srv/plain-folder'
    })
    expect(executionHost.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/plain-folder', 'rev-parse', '--show-toplevel'],
      {
        env: { LC_ALL: 'C', LANG: 'C' },
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024
      }
    )
    expect(executionHost.run).toHaveBeenNthCalledWith(
      2,
      'test',
      ['-e', '/srv/plain-folder/.git', '-o', '-L', '/srv/plain-folder/.git'],
      { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 }
    )
    expect(executionHost.run).toHaveBeenNthCalledWith(
      3,
      'test',
      ['-e', '/srv/.git', '-o', '-L', '/srv/.git'],
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
    'fatal: detected dubious ownership in repository at /srv/repo\n',
    'fatal: cannot change to /srv/missing: Permission denied\n'
  ])('keeps unrelated Git discovery failures fail-closed: %s', async (stderr) => {
    const executionHost = branchHost()
    vi.mocked(executionHost.run).mockImplementation(async (_command, args) => gitResult(args, '', stderr, 128))
    const service = new WorktreeService(() => executionHost, { save: vi.fn() })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
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
      workspaces: [{ id: 'plain', name: 'plain', hostId: 'remote', path: '/srv/plain-folder', kind: 'folder' }]
    }

    await expect(service.openBranch('plain', 'main', branchConfig)).rejects.toThrow(
      'Workspace is not a Git repository'
    )
    await expect(service.createForBranch({
      workspaceId: 'plain',
      branch: 'main',
      path: '/srv/plain-folder.worktrees/main'
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
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    const selection = await service.openBranch('repo', 'feature/used', branchConfig)

    expect(selection.workspace).toMatchObject({
      hostId: 'remote',
      path: '/srv/worktrees/used',
      branch: 'feature/used',
      repoPath: '/srv/repo',
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
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    const selection = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/free',
      path: '/srv/worktrees/free'
    }, branchConfig)

    expect(executionHost.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'worktree', 'add', '--', '/srv/worktrees/free', 'feature/free'],
      { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    expect(selection.workspace).toMatchObject({ path: '/srv/worktrees/free', branch: 'feature/free' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('does not register an unbound branch when Git worktree creation fails', async () => {
    const executionHost = branchHost({ createExitCode: 128 })
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/free',
      path: '/srv/worktrees/free'
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
  }, 20000)

  it('creates a brand-new branch from HEAD and registers its real worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-create-branch-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const worktreePath = join(root, 'worktrees', 'from-head')
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
    const repoHead = (await executionHost.run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }
    // The branch does not exist yet: this is the point of the feature — open a fresh lane from where I
    // am now without hand-creating the branch first. Adopting an existing branch is a different intent.
    const creation = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/from-head',
      path: worktreePath,
      createBranch: true
    }, branchConfig)

    expect((await executionHost.run('git', ['-C', worktreePath, 'branch', '--show-current'])).stdout.trim()).toBe('feature/from-head')
    // "From HEAD" is the contract, not a detail: the new branch must start at the repo's current commit,
    // otherwise the lane is baking off against the wrong baseline.
    expect((await executionHost.run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(repoHead)
    expect(creation.workspace).toMatchObject({ path: worktreePath, branch: 'feature/from-head', kind: 'worktree' })
    expect(save).toHaveBeenCalledOnce()
  }, 20000)

  it('refuses createBranch onto an existing name and leaves that branch where it points', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-existing-branch-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
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
    // Pin feature/taken to the first commit, then move main ahead, so a silent re-point to HEAD would
    // show up as a changed commit. Without this divergence "does not move it" could pass vacuously.
    expect((await executionHost.run('git', ['-C', repoPath, 'branch', 'feature/taken'])).exitCode).toBe(0)
    const takenBefore = (await executionHost.run('git', ['-C', repoPath, 'rev-parse', 'feature/taken'])).stdout.trim()
    await writeFile(join(repoPath, 'SECOND.md'), '# second\n')
    expect((await executionHost.run('git', ['-C', repoPath, 'add', 'SECOND.md'])).exitCode).toBe(0)
    expect((await executionHost.run('git', [
      '-C', repoPath,
      '-c', 'user.name=AgentMux Test',
      '-c', 'user.email=agentmux@example.invalid',
      'commit', '-m', 'second'
    ])).exitCode).toBe(0)
    const repoHead = (await executionHost.run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(takenBefore).not.toBe(repoHead)

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/taken',
      path: join(root, 'worktrees', 'taken'),
      createBranch: true
    }, branchConfig)).rejects.toThrow('Branch already exists')

    // The refusal is only meaningful if the existing branch was untouched: re-pointing it to HEAD would
    // move someone's work, which is the exact outcome createBranch is supposed to prevent.
    expect((await executionHost.run('git', ['-C', repoPath, 'rev-parse', 'feature/taken'])).stdout.trim()).toBe(takenBefore)
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  it('still requires an existing branch on the default path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-unknown-branch-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
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

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    // Without createBranch the operation adopts an existing branch; an unknown name must be a readable
    // refusal, not an implicit "then I'll invent it" that would blur the two intents.
    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/ghost',
      path: join(root, 'worktrees', 'ghost')
    }, branchConfig)).rejects.toThrow('Unknown branch')
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  it('registers nothing when real Git worktree creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-create-fails-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const worktreePath = join(root, 'worktrees', 'occupied')
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
    expect((await executionHost.run('git', ['-C', repoPath, 'branch', 'feature/free'])).exitCode).toBe(0)
    // Occupy the target path so git's own `worktree add` fails. This exercises the real failure path
    // rather than a mocked non-zero exit, then proves the service left no config record behind it.
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, 'in-the-way.txt'), 'occupied\n')

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/free',
      path: worktreePath
    }, branchConfig)).rejects.toThrow('already exists')
    expect(save).not.toHaveBeenCalled()

    // A failed create must leave feature/free retryable: re-listing shows it still unbound and
    // unregistered, not stranded as if a worktree already claimed it.
    const snapshot = await service.list('repo', branchConfig)
    if (snapshot.kind !== 'git-repository') throw new Error('expected a git repository snapshot')
    expect(snapshot.branches.find((item) => item.name === 'feature/free')).toMatchObject({
      worktreePath: null,
      workspaceId: null
    })
  }, 20000)

  it('refuses an already-registered path before touching Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-registered-path-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const takenPath = join(root, 'worktrees', 'already-there')
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

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    // A prior workspace already occupies takenPath; requesting the same path must be refused rather than
    // collapsing two workspace records onto one directory.
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [
        { id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' },
        { id: 'taken', name: 'taken', hostId: 'local', path: takenPath, kind: 'worktree', repoPath, branch: 'feature/taken' }
      ]
    }
    const runSpy = vi.spyOn(executionHost, 'run')

    await expect(service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/new',
      path: takenPath,
      createBranch: true
    }, branchConfig)).rejects.toThrow('Workspace already registered')

    // "Before touching Git" is the guarantee: the mutating step never ran, so there is no half-made
    // worktree on disk to unwind. `list` reads git but never mutates it, hence add specifically.
    expect(runSpy).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.anything()
    )
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  // A real repository with one registered worktree lane, shared by the removal cases below. These
  // assertions are about git's actual refusal and prune behaviour, so they run against real git rather
  // than a mock that could only echo back what we already believe.
  const buildLocalWorktreeFixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-removal-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const worktreePath = join(root, 'worktrees', 'lane')
    await mkdir(repoPath)
    const executionHost = new LocalExecutionHost()
    const git = async (...args: string[]) => {
      const result = await executionHost.run('git', ['-C', repoPath, ...args])
      expect(result.exitCode).toBe(0)
      return result
    }
    await git('init', '-b', 'main')
    await writeFile(join(repoPath, 'README.md'), '# fixture\n')
    await git('add', 'README.md')
    await git('-c', 'user.name=AgentMux Test', '-c', 'user.email=agentmux@example.invalid', 'commit', '-m', 'fixture')
    await git('branch', 'feature/lane')
    await git('worktree', 'add', '--', worktreePath, 'feature/lane')
    const fixtureConfig: AppConfig = {
      ...config,
      workspaces: [
        { id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' },
        { id: 'lane', name: 'feature/lane', hostId: 'local', path: worktreePath, kind: 'worktree', repoPath, branch: 'feature/lane' }
      ]
    }
    return { repoPath, worktreePath, executionHost, config: fixtureConfig }
  }

  it('removes a clean worktree, deregisters it from Git, and withdraws the workspace record', async () => {
    const { repoPath, worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    const removal = await service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)

    expect(removal.removedPath).toBe(worktreePath)
    // The lane is gone from disk, not merely deregistered — a removed worktree left on disk is a leak.
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    // Git no longer holds a worktree at that path, which is what frees the branch to be used again.
    const list = await executionHost.run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
    expect(list.stdout).not.toContain(worktreePath)
    // The saved config is the authoritative record set, and the removed lane must not survive in it.
    expect(save).toHaveBeenCalledOnce()
    expect(removal.config.workspaces.some((item) => item.id === 'lane')).toBe(false)
  }, 20000)

  it('refuses to remove a worktree with an uncommitted modification, leaving it fully intact', async () => {
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    await writeFile(join(worktreePath, 'README.md'), '# fixture\nuncommitted edit\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await expect(service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)).rejects.toThrow(
      'Worktree has uncommitted changes'
    )
    // Losing an agent's output because it happened to be the lane you did not pick is the one outcome
    // this must never produce silently: the directory stays, and the record stays because save never ran.
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(fixtureConfig.workspaces.some((item) => item.id === 'lane')).toBe(true)
  }, 20000)

  it('refuses to remove a worktree that holds an untracked file, leaving it fully intact', async () => {
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    // Untracked output is still output; `status --porcelain` reports it, so removal must still refuse —
    // an agent that never got as far as `git add` has not consented to losing its work either.
    await writeFile(join(worktreePath, 'AGENT_NOTES.md'), 'work in progress\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await expect(service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)).rejects.toThrow(
      'Worktree has uncommitted changes'
    )
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(fixtureConfig.workspaces.some((item) => item.id === 'lane')).toBe(true)
  }, 20000)

  it('removes a dirty worktree when changes are explicitly discarded', async () => {
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    await writeFile(join(worktreePath, 'README.md'), '# fixture\nabandoned edit\n')
    await writeFile(join(worktreePath, 'AGENT_NOTES.md'), 'abandoned\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    // discardChanges is the opt-in that says what it is: the caller has chosen to throw this lane away.
    const removal = await service.removeWorktree({ workspaceId: 'lane', discardChanges: true }, fixtureConfig)

    expect(removal.removedPath).toBe(worktreePath)
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(save).toHaveBeenCalledOnce()
    expect(removal.config.workspaces.some((item) => item.id === 'lane')).toBe(false)
  }, 20000)

  it('rejects removal of a workspace that is not a worktree', async () => {
    const { executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    // The plain repo folder is not a lane and carries no repoPath to prune against; removing it would be
    // a category error, refused before any git runs so we never point `worktree remove` at a main tree.
    await expect(service.removeWorktree({ workspaceId: 'repo' }, fixtureConfig)).rejects.toThrow(
      'Workspace is not a worktree'
    )
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  it('prunes Git metadata so a worktree can be recreated at the same path', async () => {
    const { repoPath, worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)

    // Without the prune step git keeps a dangling record and refuses to add here; a clean re-add at the
    // same path is the observable proof that prune actually ran.
    const readd = await executionHost.run('git', ['-C', repoPath, 'worktree', 'add', '--', worktreePath, 'feature/lane'])
    expect(readd.exitCode).toBe(0)
    expect((await stat(join(worktreePath, 'README.md'))).isFile()).toBe(true)
  }, 20000)

  it('keeps the workspace record when Git removal fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-removal-failure-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const strandedPath = join(root, 'stranded')
    await mkdir(repoPath)
    await mkdir(strandedPath)
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
    await writeFile(join(strandedPath, 'agent-output.txt'), 'real work\n')

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    // The record points at a real directory that git does not know as a worktree, so `worktree remove`
    // fails. discardChanges skips the status gate so it is the removal step itself that refuses here.
    const failureConfig: AppConfig = {
      ...config,
      workspaces: [
        { id: 'stranded', name: 'stranded', hostId: 'local', path: strandedPath, kind: 'worktree', repoPath, branch: 'ghost' }
      ]
    }

    await expect(
      service.removeWorktree({ workspaceId: 'stranded', discardChanges: true }, failureConfig)
    ).rejects.toThrow()
    // A record withdrawn ahead of a failed removal would strand this directory with nothing pointing at
    // it, so the record must live exactly as long as the directory does.
    expect(save).not.toHaveBeenCalled()
    expect((await stat(strandedPath)).isDirectory()).toBe(true)
  }, 20000)
})
