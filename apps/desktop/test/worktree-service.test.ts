import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  classifyRetention,
  parseGitBranches,
  parseGitWorktreePorcelain,
  WorktreeRetainedError,
  WorktreeService
} from '../src/main/worktree-service.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

/**
 * The non-interactive environment every git invocation in this service must carry, written out as a
 * literal rather than imported from `git-service.js`.
 *
 * Importing the constant would make this expectation move with the thing it is checking: strip a key
 * from the shared bundle and both sides change together, so the assertion stays green. Spelled out
 * here, it is an outside anchor — and it is checking a real property, not a formality. Two of the
 * assertions below used to pin the shapes this service actually had: `rev-parse` carried a private
 * two-key `{LC_ALL, LANG}` copy (the locale half duplicated, the anti-hang half absent), and
 * `worktree add` carried *no env at all*. An unattended `worktree add` against a repository whose
 * remote wants a password would sit forever on a prompt no one can answer, and that missing env was
 * written into this file as a requirement.
 */
const NONINTERACTIVE_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
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
        env: NONINTERACTIVE_ENV,
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
      // `worktree add` used to carry no env at all. It checks out a tree, so it runs whatever smudge
      // filters and hooks the repository configures — an LFS smudge reaches the remote and can prompt
      // for credentials — and it holds the index lock while it does. Blocking here is the worst case.
      { env: NONINTERACTIVE_ENV, timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
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

  it('refuses a trailing-slash VARIANT of an already-registered path, before touching Git', async () => {
    // The exact-duplicate case above passes even with a raw `item.path === path` check. This one does
    // not: the requested path is a trailing-slash spelling of the taken one, which a raw `===` treats as
    // a different place — it would let the caller reach `git worktree add`, create a real worktree, and
    // only then have `save()` reject it, orphaning the directory. Routing through the shared location
    // rule (the same normalizer the schema uses) is what makes this refuse before Git runs.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-registered-variant-test-'))
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
      path: `${takenPath}/`,
      createBranch: true
    }, branchConfig)).rejects.toThrow('Workspace already registered')

    expect(runSpy).not.toHaveBeenCalledWith('git', expect.arrayContaining(['worktree', 'add']), expect.anything())
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

  it('区分「git 拒了」与「git 删掉了、记录没撤下」：后者目录已经不在，没有东西可丢弃', async () => {
    // 这两档此前都只叫 `retained`，于是三个消费者各自靠上下文猜原因，而其中一个猜法结构上不可能对：
    // `save` 排在 git 之后，它失败时目录**已经被删了**，而记录还指着那个路径。把这一档当脏树处理，
    // 就会给用户弹一个「Discard uncommitted work?」，按下去是去删一个不存在的目录。
    //
    // 用真 git 而不是 mock：判据的关键一半是「目录真的不在了」，那是 git 的事实，不是替身的说法。
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async () => {
      throw new Error('config volume went read-only')
    })
    const service = new WorktreeService(() => executionHost, { save })

    const error = await service
      .removeWorktree({ workspaceId: 'lane' }, fixtureConfig)
      .then(() => null)
      .catch((thrown: unknown) => thrown)

    // 分类在失败现场定，而不是留给 catch 去猜：catch 看到的只有一个 Error，而两档的区别是
    // 「目录还在不在」——那件事只有这里知道。
    expect(error).toBeInstanceOf(WorktreeRetainedError)
    expect((error as WorktreeRetainedError).retention).toBe('record-not-withdrawn')
    // 原话要带出来，用户唯一有用的下一步在里面（只读卷？权限？）。
    expect((error as WorktreeRetainedError).message).toContain('config volume went read-only')
    // 判据的另一半：git 真的删掉了。所以这一档说「还留着」是假话。
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    // 而脏树那一档 git 根本没跑到，两档在同一个维度上取值相反——这就是它们必须分开的理由。
    expect(classifyRetention(error).retention).not.toBe('uncommitted-changes')
  }, 20000)

  it('git 自己失败时归到 git-failed：没有东西被删掉，也没有东西可丢弃', async () => {
    // 与上一条成对。这一档的事实是「目录还在、记录还在」，唯一有用的话是 git 的原话。
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    // 记录指向一个 git 不认识的路径：`worktree remove` 会失败，而失败发生在 save 之前。
    //
    // 这个目录必须**真的建出来**。此前这里用的是一个从未创建的子路径，与上面那句「目录还在」自相矛盾，
    // 而当时的实现对「路径在不在」完全不取值，所以矛盾无从暴露。现在它是承重的：路径不在场时，
    // 「git 不认识这个路径」的正确处置是撤掉那条幽灵记录（见下一条测试），不是永久报错。
    const orphanPath = join(worktreePath, 'not-a-worktree')
    await mkdir(orphanPath, { recursive: true })
    const broken: AppConfig = {
      ...fixtureConfig,
      workspaces: fixtureConfig.workspaces.map((item) =>
        item.id === 'lane' ? { ...item, path: orphanPath } : item
      )
    }

    const error = await service
      .removeWorktree({ workspaceId: 'lane', discardChanges: true }, broken)
      .then(() => null)
      .catch((thrown: unknown) => thrown)

    expect(error).not.toBeNull()
    // 服务层不给它挂分类：git 失败是**默认**那一档，由共用的分类器兜。三个消费者各写一份 fallback
    // 就是它们当初判得不一样的形状。
    expect(error).not.toBeInstanceOf(WorktreeRetainedError)
    expect(classifyRetention(error).retention).toBe('git-failed')
    // 什么都没删：目录还在，记录也还在。
    expect((await stat(orphanPath)).isDirectory()).toBe(true)
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  it('路径不在场且 git 也不认识它：撤掉那条幽灵记录，而不是永久报错', async () => {
    // 这是上一条的**同句不同境**。git 对这两种情形打印的是同一句话（实测：`fatal: '<path>' is not a
    // working tree`），分界线只在磁盘上——上一条那个目录真的在，所以路径大概是写错了，报错是对的；
    // 这一条路径不在，记录说的那个签出哪儿都不存在，那条记录就是幽灵。
    //
    // 撤掉它是安全的，因为没有东西可丢：目录不存在，git 也不持有这个登记。而**不**撤掉它就是 #492
    // 的死胡同换个入口重现——界面上留一行永远删不掉的 worktree。所以这不是「顺便宽容一点」，
    // 而是同一个状态必须有同一个出路，无论它是怎么变成这样的。
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const phantomPath = join(worktreePath, 'never-existed')
    // 自检：这个路径真的不在场，否则这条测试测的是上一条那个情形。
    await expect(stat(phantomPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const phantom: AppConfig = {
      ...fixtureConfig,
      workspaces: fixtureConfig.workspaces.map((item) =>
        item.id === 'lane' ? { ...item, path: phantomPath } : item
      )
    }

    const removal = await service.removeWorktree({ workspaceId: 'lane' }, phantom)

    expect(removal.removedPath).toBe(phantomPath)
    expect(removal.config.workspaces.some((item) => item.id === 'lane')).toBe(false)
  }, 20000)

  it('记录没撤下之后重试能真的撤下来：那一档不是死路', async () => {
    // 这一族此前是永久的，而挡路的是我们自己，不是 git。两处各拦一次：先是脏树探针在已消失的目录里
    // 跑 `status --porcelain`（git 退 128），去掉那道之后是 `worktree remove` 自己——我们上一次成功的
    // 移除已经把登记撤了，所以 git 说「这不是一个工作树」并退 128。两次都被读成失败，于是用户界面上
    // 留着一个 worktree 行，点多少次都删不掉。
    //
    // 用真 git 而不是替身：判据的关键一半是「git 对着自己已经撤掉的登记会怎么回话」，那是 git 的事实。
    // 替身说什么都证明不了——这条测试最早就是照着一个猜错的前提写的（猜它退 0），真 git 才纠正了它。
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    let failNext = true
    const save = vi.fn(async (value: AppConfig) => {
      if (failNext) throw new Error('config volume went read-only')
      return value
    })
    const service = new WorktreeService(() => executionHost, { save })

    const first = await service
      .removeWorktree({ workspaceId: 'lane' }, fixtureConfig)
      .then(() => null)
      .catch((thrown: unknown) => thrown)
    // 自检：先确认真的走到了那一档，否则下面整段会因为「压根不是这个场景」而恒真。
    expect(first).toBeInstanceOf(WorktreeRetainedError)
    expect((first as WorktreeRetainedError).retention).toBe('record-not-withdrawn')
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })

    // 卷恢复可写，用户再点一次删除。这一次必须真的成功。
    failNext = false
    const second = await service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)

    expect(second.removedPath).toBe(worktreePath)
    // 记录真的撤下来了。只断言「没抛」是不够的：不撤记录而静静返回，那一行照旧留在界面上。
    expect(second.config.workspaces.some((item) => item.id === 'lane')).toBe(false)
  }, 20000)

  it('目录还在时脏树保护照旧拦住：跳过探针只针对「路径不存在」', async () => {
    // 与上一条成对，且是它的反向自证。上面那条买的是「路径不在场就别探」，而这条钉住豁免的边界：
    // 目录在场时探针必须照跑照拦。只钉上面那条时，把 `directoryPresent` 改成恒 `false` 也全绿——
    // 而那颗变异的后果是脏树保护对每一次删除都失效，用户的未提交产出被静默删掉。
    const { worktreePath, executionHost, config: fixtureConfig } = await buildLocalWorktreeFixture()
    await writeFile(join(worktreePath, 'AGENT_NOTES.md'), 'work in progress\n')
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await expect(service.removeWorktree({ workspaceId: 'lane' }, fixtureConfig)).rejects.toThrow(
      'Worktree has uncommitted changes'
    )
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
    expect(save).not.toHaveBeenCalled()
  }, 20000)

  it('目录不在了但 git 拒绝的理由是别的（锁）：仍然如实失败，绝不当成已经删掉', async () => {
    // 「已经删掉了」这一档必须按 git 打印的**那一句**判，不能按情形判。锁住的 worktree 是分界线：
    // 有人刻意锁了它，而目录恰好不在（卷没挂上、被手工移走），此时 git 退的也是 128。若判据宽成
    // 「失败 + 目录不在 = 已经删掉」，我们就会把一个别人明确锁住的登记静默撤掉，而 git 从来没同意过。
    //
    // 真 git 实测过：锁住时 `worktree remove` 说的是「cannot remove a locked working tree」，
    // 与「is not a working tree」是两句不同的话，所以按句子判的实现在这里必须响亮地失败。
    const { repoPath, worktreePath, executionHost, config: fixtureConfig } =
      await buildLocalWorktreeFixture()
    const lock = await executionHost.run('git', ['-C', repoPath, 'worktree', 'lock', '--', worktreePath])
    expect(lock.exitCode).toBe(0)
    await rm(worktreePath, { recursive: true, force: true })
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    const failure = await service
      .removeWorktree({ workspaceId: 'lane' }, fixtureConfig)
      .then(() => null, (error: unknown) => error as Error)

    expect(failure, '锁住的 worktree 被当成「已经删掉了」，记录被静默撤下').not.toBeNull()
    // 自检：确认失败的正是那句锁的话，而不是碰巧因为别的原因失败——否则这条测试证不到分界线。
    expect(failure?.message).toContain('locked')
    // 记录必须留着：git 没撤登记，我们也不能撤。
    expect(save).not.toHaveBeenCalled()
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

  // 判据是**用户看到的那件事**：fan-out 之后 `git status` 里不该多出一坨 `?? .worktrees/`。
  // 不断言"写了哪个文件、写了哪一行"——那是实现；换成别的机制（真 .gitignore、把根挪到仓外）
  // 只要 status 干净就同样是对的，而断言写法会把那些正确的改法判红。
  //
  // 用真 git：这条性质完全由 git 的 ignore 语义决定（锚定、目录尾斜杠、info/exclude 的生效范围），
  // 假 host 只能证"我们发了那条命令"，证不了"git 因此闭嘴了"——而后者才是用户的体验。
  it('creating a worktree leaves the user\'s git status clean, not littered with .worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-status-noise-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    // 必须在仓**内部**：这正是这条噪音的来源，也是 workspace-projects 有意的选择。
    const worktreePath = join(repoPath, '.worktrees', 'lane')
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

    const status = async (): Promise<string> =>
      (await executionHost.run('git', ['-C', repoPath, 'status', '--porcelain'])).stdout.trim()
    // 起点必须干净，否则下面那条断言可能只是"本来就没东西"。
    expect(await status()).toBe('')

    const service = new WorktreeService(() => executionHost, { save: vi.fn(async (value: AppConfig) => value) })
    const branchConfig: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    }
    await service.createForBranch({
      workspaceId: 'repo', branch: 'lane-a', path: worktreePath, createBranch: true
    }, branchConfig)

    // 目录确实建出来了——先证靶子在场，否则"status 干净"可能是因为压根没创建成功。
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
    expect(await status(), 'fan-out 不该在用户仓里留下未跟踪的 .worktrees').toBe('')

    // 用户自己的改动仍然照常出现：挡掉的只能是 fan-out 的那个根，不能顺手把别的也遮了。
    await writeFile(join(repoPath, 'mine.txt'), 'my work\n')
    expect(await status()).toBe('?? mine.txt')

    // 遮蔽面必须是**顶层的那个目录**，不是"名字里带 .worktrees 的任何东西"。
    // 一条不锚定、不带尾斜杠的 `.worktrees` 同样能让上面那条断言变绿，却会连用户自己在任意深度
    // 建的同名文件一起吞掉——那是把用户的东西弄丢，比留点噪音严重得多。
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', '.worktrees'), 'notes about my worktrees\n')
    expect(
      (await status()).split('\n').sort(),
      '只该遮住顶层那个 fan-out 根；用户在别处的同名文件必须照常出现'
    ).toEqual(['?? docs/', '?? mine.txt'])

    // 第二条 lane 不重复写：exclude 文件里那一行只能有一条。
    await service.createForBranch({
      workspaceId: 'repo', branch: 'lane-b', path: join(repoPath, '.worktrees', 'lane-b'), createBranch: true
    }, branchConfig)
    const exclude = await readFile(join(repoPath, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((line) => line.includes('.worktrees'))).toHaveLength(1)
  }, 30000)

  it('已有的 exclude 末尾没有换行时，追加的那行不会粘到上一行上', async () => {
    // `printf ... >> file` 在文件末尾无换行时会把新行**粘**在最后一行后面：`notes.txt` + `/.worktrees/`
    // 变成一条 `notes.txt/.worktrees/`，于是**两条规则同时失效**——用户原有的忽略项也被吃掉了。
    // git 不会报错，只是安静地不再忽略；实测 `git status` 里 `notes.txt` 与 `.worktrees/` 双双冒出来。
    //
    // 末尾无换行的 `info/exclude` 不是假想：它是人手写的文件，编辑器不给补尾换行的多得是。
    // 判据落在 `git status` 上而不是文件内容上：要守的是「两条规则都还生效」，不是「文件长什么样」。
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-exclude-newline-test-'))
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

    // 用户已有的一条忽略规则，**末尾故意不带换行**。
    await writeFile(join(repoPath, '.git', 'info', 'exclude'), 'notes.txt')

    await new WorktreeService(() => executionHost, { save: vi.fn(async (value: AppConfig) => value) })
      .createForBranch(
        { workspaceId: 'repo', branch: 'lane-a', path: join(repoPath, '.worktrees', 'lane'), createBranch: true },
        { ...config, workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }] }
      )

    await writeFile(join(repoPath, 'notes.txt'), 'my notes\n')
    const status = (await executionHost.run('git', ['-C', repoPath, 'status', '--porcelain'])).stdout.trim()
    expect(
      status,
      '追加粘行了：用户原有的 notes.txt 规则和我们加的 .worktrees 规则会双双失效'
    ).toBe('')
  }, 30000)

  // 写 exclude 是锦上添花，绝不能反过来把用户要的东西弄没。原则 11 class 2：我方这一步降级了，
  // 但"创建 worktree"这个能力本身好好的——因为一次便利写入失败就让创建失败，是把用户真正要的
  // 那件事拿走。
  it('still creates the worktree when the exclude write cannot happen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-exclude-failure-test-'))
    temporaryRoots.push(root)
    const repoPath = join(root, 'repo')
    const worktreePath = join(repoPath, '.worktrees', 'lane')
    await mkdir(repoPath)
    const real = new LocalExecutionHost()
    expect((await real.run('git', ['-C', repoPath, 'init', '-b', 'main'])).exitCode).toBe(0)
    await writeFile(join(repoPath, 'README.md'), '# fixture\n')
    expect((await real.run('git', ['-C', repoPath, 'add', 'README.md'])).exitCode).toBe(0)
    expect((await real.run('git', [
      '-C', repoPath,
      '-c', 'user.name=AgentMux Test',
      '-c', 'user.email=agentmux@example.invalid',
      'commit', '-m', 'fixture'
    ])).exitCode).toBe(0)

    // 只让那一次便利写入炸，其余全部走真 git——这样失败的确实是被测的那一步。
    const executionHost: ExecutionHost = {
      id: 'local', kind: 'local', label: 'This Mac',
      exposeLoopbackPort: vi.fn(async (port: number) => port),
      dispose: vi.fn(async () => {}),
      run: vi.fn(async (command: string, args: readonly string[], options?: Parameters<ExecutionHost['run']>[2]) => {
        if (command === 'sh') throw new Error('read-only .git')
        return await real.run(command, args, options)
      })
    }
    const service = new WorktreeService(() => executionHost, { save: vi.fn(async (value: AppConfig) => value) })
    const creation = await service.createForBranch({
      workspaceId: 'repo', branch: 'lane-a', path: worktreePath, createBranch: true
    }, {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: repoPath, kind: 'folder' }]
    })

    expect(creation.workspace).toMatchObject({ path: worktreePath, branch: 'lane-a', kind: 'worktree' })
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
  }, 30000)
})
