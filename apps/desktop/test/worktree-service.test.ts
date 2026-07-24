import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { WorktreeService } from '../src/main/worktree-service.js'

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

function host(exitCode = 0): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async () => ({
      command: 'git',
      args: [],
      exitCode,
      stdout: '',
      stderr: exitCode === 0 ? '' : 'fatal: invalid reference',
      durationMs: 1
    }))
  }
}

describe('WorktreeService', () => {
  it('runs one argument-array Git command and registers only after success', async () => {
    const executionHost = host()
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    const result = await service.create(
      {
        hostId: 'remote',
        repoPath: '/srv/repo',
        path: '/srv/worktrees/feature-x',
        branch: 'feature/x',
        baseRef: 'origin/main'
      },
      config
    )

    expect(executionHost.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'worktree', 'add', '-b', 'feature/x', '--', '/srv/worktrees/feature-x', 'origin/main'],
      { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    expect(result.workspace).toMatchObject({
      hostId: 'remote',
      kind: 'worktree',
      repoPath: '/srv/repo',
      path: '/srv/worktrees/feature-x',
      branch: 'feature/x'
    })
    expect(save).toHaveBeenCalledOnce()
  })

  it('does not register a workspace when Git fails', async () => {
    const executionHost = host(128)
    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })

    await expect(
      service.create(
        {
          hostId: 'remote',
          repoPath: '/srv/repo',
          path: '/srv/worktrees/broken',
          branch: 'broken',
          baseRef: 'missing'
        },
        config
      )
    ).rejects.toThrow('fatal: invalid reference')
    expect(save).not.toHaveBeenCalled()
  })

  it('creates and registers a real local Git worktree', async () => {
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

    const save = vi.fn(async (value: AppConfig) => value)
    const service = new WorktreeService(() => executionHost, { save })
    const creation = await service.create(
      {
        hostId: 'local',
        repoPath,
        path: worktreePath,
        branch: 'feature/real',
        baseRef: 'HEAD'
      },
      config
    )

    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect((await executionHost.run('git', ['-C', worktreePath, 'branch', '--show-current'])).stdout.trim()).toBe('feature/real')
    expect(creation.workspace).toMatchObject({ path: worktreePath, branch: 'feature/real', kind: 'worktree' })
    expect(save).toHaveBeenCalledOnce()
  })
})
