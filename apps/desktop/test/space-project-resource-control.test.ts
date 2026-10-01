import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHost } from '@agentmux/core'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, projectResourceWorkspace } from '../src/shared/space-addresses'
import { createSpaceZoneResource, type SpaceZoneResourcePorts } from '../src/main/space-zone-resources'
import { WorktreeService } from '../src/main/worktree-service'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const repo: WorkspaceRecord = { id: 'resource', name: 'Resource', hostId: 'execution', path: _hygiene_fixturePath("resource"), kind: 'folder' }
const display: WorkspaceRecord = { id: 'display', name: 'Display', hostId: 'local', path: _hygiene_fixturePath("display"), kind: 'folder' }
const projectId = directoryIdentity(repo.hostId, repo.path)
const spaceId = directoryIdentity(display.hostId, display.path)
function config(workspaces: WorkspaceRecord[] = [display, repo]): AppConfig {
  return { version: 9, hosts: [{ id: 'local', label: 'Local', kind: 'local' }, { id: 'execution', label: 'Execution', kind: 'ssh', hostname: 'fixture.invalid' }], executors: {}, workspaces,
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
}
function ports(initial = config()) {
  let current = initial
  const register = vi.fn(async (input: { hostId: string; path: string }) => {
    const workspace = { ...input, id: 'new-zone', name: 'Zone', kind: 'folder' as const }
    current = { ...current, workspaces: [...current.workspaces, workspace] }
    return { workspace, changed: true }
  })
  const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  const host = vi.fn(() => ({ run } as unknown as ExecutionHost))
  const worktreeWorkspace = { ...repo, id: 'worktree', kind: 'worktree' as const, repoPath: repo.path, path: _hygiene_fixturePath("new-tree"), branch: 'feat/task' }
  const createForBranch = vi.fn(async () => { current = { ...current, workspaces: [...current.workspaces, worktreeWorkspace] }; return { config: current, workspace: worktreeWorkspace } })
  return { host, run, register, createForBranch, config: () => current, topics: async () => [], worktrees: { createForBranch } }
}

describe('Project resources are independent of Space placement', () => {
  it('uses the explicit Project Host for a directory even when the display Space is on another Host', async () => {
    const owner = ports()
    const result = await createSpaceZoneResource({ spaceId, resource: { kind: 'directory', projectId, path: _hygiene_fixturePath("new-dir") } }, owner)
    expect(owner.host.mock.calls).toEqual([[repo.hostId]])
    expect(owner.run.mock.calls).toHaveLength(1)
    expect(owner.register).toHaveBeenCalledWith({ hostId: repo.hostId, path: _hygiene_fixturePath("new-dir") })
    expect(result.resource).toEqual({ projectId, sourceWorkspaceId: repo.id, hostId: repo.hostId, path: _hygiene_fixturePath("new-dir"), workspaceId: 'new-zone', kind: 'directory', branch: null })
  })
  it('creates Git from the explicit Project and reports its source separately from the display Space', async () => {
    const owner = ports()
    const result = await createSpaceZoneResource({ spaceId, resource: { kind: 'worktree', projectId, path: _hygiene_fixturePath("new-tree"), branch: 'feat/task', createBranch: true } }, owner)
    expect(owner.createForBranch).toHaveBeenCalledOnce()
    expect(owner.createForBranch.mock.calls[0]).toEqual([{ workspaceId: repo.id, path: _hygiene_fixturePath("new-tree"), branch: 'feat/task', createBranch: true }, config()])
    expect(result.resource).toMatchObject({ projectId, sourceWorkspaceId: repo.id, hostId: repo.hostId, workspaceId: 'worktree', path: _hygiene_fixturePath("new-tree") })
    expect(owner.register).not.toHaveBeenCalled()
  })
  it('rejects an unknown Project before probing or changing a resource', async () => {
    const owner = ports()
    await expect(createSpaceZoneResource({ spaceId, resource: { kind: 'directory', projectId: 'unknown', path: _hygiene_fixturePath("new-dir") } }, owner)).rejects.toMatchObject({ code: 'SPACE_RESOURCE_PROJECT_UNKNOWN' })
    expect(owner.host).not.toHaveBeenCalled(); expect(owner.register).not.toHaveBeenCalled(); expect(owner.createForBranch).not.toHaveBeenCalled()
  })
  it('uses the unique repository root, and requires an exact choice when only multiple worktrees remain', () => {
    const one = { ...repo, id: 'one', kind: 'worktree' as const, repoPath: repo.path, path: _hygiene_fixturePath("one") }
    const two = { ...one, id: 'two', path: _hygiene_fixturePath("two") }
    expect(projectResourceWorkspace([one, repo, two], projectId)).toEqual(repo)
    expect(() => projectResourceWorkspace([one, two], projectId)).toThrow('--source-workspace')
    expect(projectResourceWorkspace([one, two], projectId, two.id)).toEqual(two)
    expect(() => projectResourceWorkspace([one, two, display], projectId, display.id)).toThrow('not in the specified Project')
  })
  it('does not register or delete a directory after its existence probe fails', async () => {
    const owner = ports(); owner.run.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' })
    await expect(createSpaceZoneResource({ spaceId, resource: { kind: 'directory', projectId, path: _hygiene_fixturePath("missing") } }, owner)).rejects.toMatchObject({ code: 'SPACE_DIRECTORY_UNAVAILABLE' })
    expect(owner.register).not.toHaveBeenCalled(); expect(owner.createForBranch).not.toHaveBeenCalled()
  })

  it.each([false, true])('creates a real Git worktree, preserving it when registration fails: %s', async failSave => {
    const root = await mkdtemp(join(tmpdir(), 'amux-project-resource-')); roots.push(root)
    const gitRepo = join(root, 'repo'), landing = join(root, 'display'), target = join(gitRepo, '.worktrees', 'task')
    await mkdir(gitRepo); await mkdir(landing)
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1' }
    await exec('git', ['init', '-b', 'main', gitRepo], { env: gitEnv })
    await writeFile(join(gitRepo, 'content.txt'), 'preserved\n')
    await exec('git', ['-C', gitRepo, 'add', 'content.txt'], { env: gitEnv })
    await exec('git', ['-C', gitRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: create private repository'], { env: gitEnv })
    let current = config([{ ...repo, hostId: 'local', path: gitRepo }, { ...display, path: landing }])
    const host = { run: async (command: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number } = {}) => {
      try { const value = await exec(command, args, { env: { ...gitEnv, ...options.env }, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes }); return { ...value, exitCode: 0 } }
      catch (error) { const value = error as { code?: number; stdout?: string; stderr?: string }; if (typeof value.code !== 'number') throw error; return { exitCode: value.code, stdout: value.stdout ?? '', stderr: value.stderr ?? '' } }
    } } as unknown as ExecutionHost
    const worktrees = new WorktreeService(() => host, { save: async next => { if (failSave) throw new Error('Private registration unavailable'); current = next; return next } })
    const owner: SpaceZoneResourcePorts = { host: () => host, config: () => current, topics: async () => [], worktrees, register: async () => { throw new Error('Git uses the existing Worktree owner') } }
    const result = await createSpaceZoneResource({ spaceId: directoryIdentity('local', landing), resource: { kind: 'worktree', projectId: directoryIdentity('local', gitRepo), path: target, branch: 'feat/task', createBranch: true } }, owner)
    await expect(access(join(target, 'content.txt'))).resolves.toBeUndefined()
    expect(result.resource).toMatchObject({ projectId: directoryIdentity('local', gitRepo), sourceWorkspaceId: repo.id, path: target, kind: 'worktree', branch: 'feat/task' })
    if (failSave) { expect(result.workspace).toBeNull(); expect(result.issue).toEqual({ code: 'WORKTREE_REGISTRATION_UNCONFIRMED', message: expect.stringContaining('Private registration unavailable') }); expect(current.workspaces).toHaveLength(2) }
    else { expect(result.workspace?.path).toBe(target); expect(result.resource.workspaceId).toBe(result.workspace?.id); expect(current.workspaces).toHaveLength(3) }
  })
})
