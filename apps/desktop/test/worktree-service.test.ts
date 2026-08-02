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

  /**
   * argv 硬化的四个 `--` 里此前只有一个被守住（createForBranch 的 adopt 分支，:256 那条断言）。
   * 另外三个——create 的 `-b` 分支、remove 的两个分支——删掉 `--` 后本文件全绿。
   *
   * 这一条用**真 git** 守 create 的两个分支：让 git 自己当检测器，而不是回述我们已经相信的 argv。
   * 破口形状是「路径以短横线开头」，这是可达的：`input.path` 全程无校验，而默认路径由分支名派生
   * （defaultWorktreePath 会把非法字符换成 `-`），用户也可以自己填任何一行字。少了 `--`，git 把它
   * 当选项解析，退 129 报 `unknown switch`——于是「创建 worktree」对这个分支永久失败。
   */
  it('worktree add 的两个分支都用 -- 终止选项，短横线开头的路径不会被当成开关', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-dash-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    const executionHost = new LocalExecutionHost()
    const git = async (...args: string[]) => {
      const result = await executionHost.run('git', ['-C', repoPath, ...args])
      expect(result.exitCode, `fixture git ${args.join(' ')}: ${result.stderr}`).toBe(0)
      return result
    }
    await git('init', '-b', 'main')
    await writeFile(join(repoPath, 'README.md'), '# fixture\n')
    await git('add', 'README.md')
    await git('-c', 'user.name=AgentMux Test', '-c', 'user.email=agentmux@example.invalid', 'commit', '-m', 'fixture')
    await git('branch', 'feature/adopt')

    const service = new WorktreeService(() => executionHost, { save: async (value: AppConfig) => value })
    const baseConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }

    // 相对路径才让短横线落在 argv 元素的**第一个字符**上（绝对路径以 `/` 开头，git 不会误读）。
    // `worktree add` 的相对路径基准是 `-C` 给的仓库，实测如此，所以下面按 repoPath 拼盘上位置。
    const adopted = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/adopt',
      path: '-dash-adopt'
    }, baseConfig)
    expect(adopted.workspace.path).toBe('-dash-adopt')
    expect((await stat(join(repoPath, '-dash-adopt'))).isDirectory(), '认领已有分支时 -- 丢了：git 把路径当开关').toBe(true)

    const created = await service.createForBranch({
      workspaceId: 'repo',
      branch: 'feature/fresh',
      path: '-dash-create',
      createBranch: true
    }, baseConfig)
    expect(created.workspace.branch).toBe('feature/fresh')
    expect((await stat(join(repoPath, '-dash-create'))).isDirectory(), '新建分支时 -- 丢了：git 把路径当开关').toBe(true)
  }, 20000)

  // A real repository with one registered worktree lane, shared by the removal cases below. These
  // assertions are about git's actual refusal and prune behaviour, so they run against real git rather
  // than a mock that could only echo back what we already believe.
  const buildLocalWorktreeFixture = async () => {    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-removal-test-'))
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
    const runSpy = vi.spyOn(executionHost, 'run')

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
    // `--` 终止选项解析，所以一条以短横线开头的 worktree 路径不会被 git 读成开关。这里只能钉 argv：
    // 不像 create（相对路径按 `-C` 的仓库解析），移除前那次 `-C workspace.path` 的 status 探针会把
    // 相对路径按进程 cwd 解析，用真短横线路径就测不成同一件事了。孪生的 create 侧由真 git 守。
    expect(runSpy).toHaveBeenCalledWith(
      'git',
      ['-C', repoPath, 'worktree', 'remove', '--', worktreePath],
      expect.anything()
    )
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
    const { repoPath, worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    await writeFile(join(worktreePath, 'README.md'), '# fixture\nabandoned edit\n')
    await writeFile(join(worktreePath, 'AGENT_NOTES.md'), 'abandoned\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const runSpy = vi.spyOn(executionHost, 'run')

    // discardChanges is the opt-in that says what it is: the caller has chosen to throw this lane away.
    const removal = await service.removeWorktree({ workspaceId: 'lane', discardChanges: true }, fixtureConfig)

    expect(removal.removedPath).toBe(worktreePath)
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(save).toHaveBeenCalledOnce()
    expect(removal.config.workspaces.some((item) => item.id === 'lane')).toBe(false)
    // 这是第四个 `--`，与上面那条是**两个分支**：`--force` 那一支自己也要终止选项解析。少了它，
    // 一条短横线开头的路径会被 git 读成开关，于是「丢弃改动并移除」这条路对该分支永久失败。
    expect(runSpy).toHaveBeenCalledWith(
      'git',
      ['-C', repoPath, 'worktree', 'remove', '--force', '--', worktreePath],
      expect.anything()
    )
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

  it('leaves the path immediately re-addable after removal', async () => {
    const { repoPath, worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)

    // `git worktree remove` deletes the admin entry itself, so the path is free again with no prune —
    // verified against real git. This test's earlier name claimed it proved prune ran; it never could,
    // because it passes with or without prune. It pins the property that actually matters: after a
    // removal the lane's path can be reused, which is what a repeat fan-out needs.
    const readd = await executionHost.run('git', ['-C', repoPath, 'worktree', 'add', '--', worktreePath, 'feature/lane'])
    expect(readd.exitCode).toBe(0)
    expect((await stat(join(worktreePath, 'README.md'))).isFile()).toBe(true)
  }, 20000)

  /**
   * 脏树探测失败必须当场停下，不许带着「没查清」继续去删。
   *
   * #413 原本的判断是「删掉这句 assertGit 后脏 worktree 会被删」。**那个前提是错的**，实测（真 git）：
   * 三种脏形状（改过的跟踪文件 / 未跟踪文件 / 只 staged）git 自己都以 128 拒绝 `worktree remove`，
   * 而不带 discardChanges 的那条路正好不传 `--force`。所以删掉这句不丢工作——git 是第二道闸，这条
   * 断言因此不去钉「不会被删」（那件事由 git 保证，不由这句 assert 保证），severity 也该从 HIGH 降下来。
   *
   * 它真正买到的是**不带着无知往前走**。少了它，探测失败退化成空 stdout，`trim() !== ''` 为假，
   * 「未提交改动」那条 throw 不发生，于是请求继续走到 `worktree remove`——一棵没查清的树上执行删除，
   * 成败全看 git 那一侧当天怎么答（实测：手工删掉目录后 remove 退 0 并顺利撤记录，等于跳过了整道
   * 保护）。而两类原因的补救动作相反：真的脏，去看那些改动或显式丢弃；探测坏了（gitdir 断链、
   * git 不在 PATH、输出超 maxOutputBytes 而抛），丢弃改动一点忙都帮不上（#400/#401 那一族）。
   *
   * 判据是**行为**：探测失败后那条 `worktree remove` 一次都不许发出。删掉 assertGit，它立刻发出。
   * 顺带钉住措辞不许把探测失败说成脏树——那是把用户推向没用的那个补救。
   */
  it('stops at a failed dirty-tree probe instead of removing an unverified worktree', async () => {
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const attempted: string[][] = []
    // 只让脏树探测失败，别的 git 调用照旧走真 git——否则测的是「host 整体坏了」，那是另一件事。
    const probeFailingHost: ExecutionHost = {
      id: executionHost.id,
      kind: executionHost.kind,
      label: executionHost.label,
      exposeLoopbackPort: async (port: number) => await executionHost.exposeLoopbackPort(port),
      dispose: async () => await executionHost.dispose(),
      run: async (command, args, options) => {
        attempted.push([...args])
        if (args.includes('status') && args.includes('--porcelain')) {
          // 真实形状：探测失败时 stdout 是空的（断链的 gitdir 让 git 退 128 且只写 stderr）。
          // 空 stdout 正是「被读成干净」的那个入口。
          return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
        }
        return await executionHost.run(command, args, options)
      }
    }
    const service = new WorktreeService(() => probeFailingHost, { save })

    const failure = await service
      .removeWorktree({ workspaceId: 'lane' }, fixtureConfig)
      .then(() => null, (error: unknown) => error as Error)

    expect(failure, '探测失败却让移除照样成功了').not.toBeNull()
    // 自检：探测真的发出去了，否则下面「没发 remove」是因为整条路根本没走到。
    expect(
      attempted.some((args) => args.includes('status') && args.includes('--porcelain')),
      '根本没发脏树探测——这条断言测不到它想测的东西'
    ).toBe(true)
    // 判据：一棵没查清的树上不许执行删除。这条就是删掉 assertGit 后会红的那一条。
    expect(
      attempted.filter((args) => args.includes('worktree') && args.includes('remove')),
      '脏树探测失败后仍然发出了 worktree remove——带着「没查清」去删了'
    ).toEqual([])
    // 措辞：不许把探测失败说成脏树——补救动作相反，说错就是把用户推向没用的那一个。这个子串取自
    // 脏树那条 throw，且是它独有的（探测失败那条报的是 git 自己对探测的说法）。
    expect(
      failure?.message,
      '探测失败被说成「有未提交改动」，而丢弃改动治不了探测失败'
    ).not.toContain('Worktree has uncommitted changes')
    // 而记录与目录都必须原样留着：没查清就不动。
    expect(save).not.toHaveBeenCalled()
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
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

  // A real repository with several fan-out lanes, for the keep-the-winner teardown cases. Lanes are
  // named <stem>-1, <stem>-2, … exactly as a fan-out plan produces them, so the projection that reads
  // them as one bake-off (fanout-group) is exercised by the same shapes this service leaves behind.
  const buildFanOutFixture = async (stem: string, count: number) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-fanout-teardown-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
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
    const lanes: { id: string; branch: string; path: string }[] = []
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const branch = `${stem}-${ordinal}`
      const path = join(root, 'worktrees', branch)
      await git('worktree', 'add', '-b', branch, '--', path, 'HEAD')
      lanes.push({ id: `lane-${branch}`, branch, path })
    }
    const fixtureConfig: AppConfig = {
      ...config,
      workspaces: [
        { id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' },
        ...lanes.map((lane) => ({
          id: lane.id, name: lane.branch, hostId: 'local', path: lane.path,
          kind: 'worktree' as const, repoPath, branch: lane.branch
        }))
      ]
    }
    return { root, repoPath, executionHost, lanes, config: fixtureConfig }
  }

  it('keeps the chosen lane untouched and tears the clean losers down', async () => {
    const { executionHost, lanes, config: fixtureConfig } = await buildFanOutFixture('retry', 3)
    const [winner, loserA, loserB] = lanes
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    const result = await service.keepOneOfFanOut({
      keepWorkspaceId: winner!.id,
      removeWorkspaceIds: [loserA!.id, loserB!.id]
    }, fixtureConfig)

    // The winner's worktree stays exactly as it was — that is what "keep this one" means.
    expect((await stat(winner!.path)).isDirectory()).toBe(true)
    expect(result.config.workspaces.some((item) => item.id === winner!.id)).toBe(true)
    expect(result.keptWorkspaceId).toBe(winner!.id)
    // Both losers are gone from disk and from the record set.
    expect(result.outcomes.every((outcome) => outcome.status === 'removed')).toBe(true)
    await expect(stat(loserA!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(loserB!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.config.workspaces.some((item) => item.id === loserA!.id || item.id === loserB!.id)).toBe(false)
  }, 30000)

  it('does not silently discard a losing lane that still holds uncommitted work', async () => {
    const { executionHost, lanes, config: fixtureConfig } = await buildFanOutFixture('retry', 3)
    const [winner, dirtyLoser, cleanLoser] = lanes
    // The lane the user did not pick still carries an agent's untracked output. Discarding it because it
    // lost the bake-off is data loss: the whole point of the T-002 protection is that this cannot happen
    // silently. Removing that guard from removeWorktree must turn THIS assertion red.
    await writeFile(join(dirtyLoser!.path, 'AGENT_NOTES.md'), 'work the agent did not commit\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    const result = await service.keepOneOfFanOut({
      keepWorkspaceId: winner!.id,
      removeWorkspaceIds: [dirtyLoser!.id, cleanLoser!.id]
    }, fixtureConfig)

    // The dirty loser survives on disk AND in the record set, reported as retained with git's reason.
    const dirtyOutcome = result.outcomes.find((outcome) => outcome.workspaceId === dirtyLoser!.id)
    expect(dirtyOutcome).toMatchObject({ status: 'retained' })
    expect(dirtyOutcome && 'reason' in dirtyOutcome ? dirtyOutcome.reason : '').toMatch(/uncommitted changes/)
    expect((await stat(dirtyLoser!.path)).isDirectory()).toBe(true)
    expect((await stat(join(dirtyLoser!.path, 'AGENT_NOTES.md'))).isFile()).toBe(true)
    expect(result.config.workspaces.some((item) => item.id === dirtyLoser!.id)).toBe(true)
    // …and one lane refusing to go never strands the clean lane: it is torn down as normal.
    const cleanOutcome = result.outcomes.find((outcome) => outcome.workspaceId === cleanLoser!.id)
    expect(cleanOutcome).toMatchObject({ status: 'removed' })
    await expect(stat(cleanLoser!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.config.workspaces.some((item) => item.id === cleanLoser!.id)).toBe(false)
  }, 30000)

  it('refuses to tear down the very lane it was asked to keep', async () => {
    const { executionHost, lanes, config: fixtureConfig } = await buildFanOutFixture('retry', 2)
    const [winner, loser] = lanes
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    // A caller that mistakenly lists the winner among the losers must not lose it — removing the lane the
    // user chose to keep is the exact mistake this guard refuses.
    const result = await service.keepOneOfFanOut({
      keepWorkspaceId: winner!.id,
      removeWorkspaceIds: [winner!.id, loser!.id]
    }, fixtureConfig)

    expect((await stat(winner!.path)).isDirectory()).toBe(true)
    expect(result.config.workspaces.some((item) => item.id === winner!.id)).toBe(true)
    // Only the genuine loser was acted on; the winner never appears in the outcomes.
    expect(result.outcomes.map((outcome) => outcome.workspaceId)).toEqual([loser!.id])
  }, 30000)

  it('fails closed when asked to keep a lane that does not exist', async () => {
    const { executionHost, lanes, config: fixtureConfig } = await buildFanOutFixture('retry', 2)
    const [, loser] = lanes
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    // Reporting a lane as kept when no such workspace exists would be a lie, and tearing the losers down
    // around a phantom winner is worse than refusing outright.
    await expect(service.keepOneOfFanOut({
      keepWorkspaceId: 'ghost',
      removeWorkspaceIds: [loser!.id]
    }, fixtureConfig)).rejects.toThrow('Unknown workspace')
    expect(save).not.toHaveBeenCalled()
    expect((await stat(loser!.path)).isDirectory()).toBe(true)
  }, 30000)
})
