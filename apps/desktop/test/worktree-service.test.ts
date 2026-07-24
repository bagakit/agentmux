import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  version: 1,
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
      hostId: 'remote',
      repoPath: '/srv/repo',
      branches: [
        { name: 'main', worktreePath: '/srv/repo', workspaceId: 'repo', isCurrent: true },
        { name: 'feature/used', worktreePath: '/srv/worktrees/used', workspaceId: null, isCurrent: false },
        { name: 'feature/free', worktreePath: null, workspaceId: null, isCurrent: false }
      ]
    })
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
  })
})
