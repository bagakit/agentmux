import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentMuxControlRequest, type ExecutionHost } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchResult, AppConfig, ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId, projectResourceWorkspace, spatialSources, workspaceZoneId } from '../src/shared/space-addresses'
import { createSpaceZoneResource, type SpaceZoneResourcePorts } from '../src/main/space-zone-resources'
import { executeSpatialControl, spatialCatalog, type SpatialControlPorts, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
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


describe('Topic and Mote placement retain the explicit execution resource', () => {
  it.each([
    ['topic', 'directory'], ['topic', 'worktree'], ['mote', 'directory'], ['mote', 'worktree']
  ] as const)('launches the %s-bound %s in its Project resource and preserves the real Home', async (shape, kind) => {
    const scratch: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: repo.hostId, path: _hygiene_fixturePath("scratch"), kind: 'folder' }
    const directory = shape === 'mote' ? 'topic--launcher--leader' : 'topic--view--resource'
    const topic: ScratchTopicSnapshot = { id: shape === 'mote' ? PMO_TEAMS_TOPIC_ID : 'view:resource',
      directoryPath: directory, ...(shape === 'mote' ? { identityDirectoryPath: (_hygiene_fixturePath("motes/") + directory), physicalDirectoryPath: (_hygiene_fixturePath("motes/") + directory) } : {}),
      topicPath: `${directory}/topic.md`, title: shape, summary: '', collaborators: [] }
    const topicPath = shape === 'mote' ? (_hygiene_fixturePath("motes/") + directory) : (_hygiene_fixturePath("scratch/") + (directory) + "")
    const context = spatialSources(config([repo, scratch]), [topic])
    const space = context.spaces.find(item => item.topicId === topic.id)!
    expect(space).toMatchObject({ kind: shape, directoryPath: topicPath, hostId: repo.hostId })
    const home = context.zones.find(item => item.zoneId === homeZoneId(space.spaceId))!
    expect(home).toEqual({ zoneId: homeZoneId(space.spaceId), workspaceId: SCRATCH_WORKSPACE_ID,
      kind: 'home', hostId: repo.hostId, directoryPath: topicPath, branch: null })
    const initial = config([repo, scratch])
    initial.executors.fixture = { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false }
    const resources = { ...ports(initial), topics: async () => [topic] }
    const state: SpatialWorkbench = { config: resources.config(), sessions: [], tabs: {},
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('display-group', []) },
      spaceZoneBindings: {}, spatialRequests: {} }
    const launchAgent = vi.fn<SpatialControlPorts['launch']>(async input => {
      // Core's reply is controlled; the oracle below checks the actual production launch input.
      const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: input.agentSessionId, kind: 'agent',
        providerId: 'codex', executorId: input.executorId, hostId: input.hostId, workspacePath: input.workspacePath, label: 'Task',
        capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
        createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: 1 },
        control: { kind: 'agent', agentSessionId: input.agentSessionId, hostId: input.hostId, run: { runId: 'controlled-run' } } }
      const result: AgentLaunchResult = { created: { ...agentCreationFixture(session),
        creation: { createOperationId: input.createOperationId, initialPrompt: 'confirmed' } },
        creation: { createOperationId: input.createOperationId, initialPrompt: 'confirmed' }, session,
        timeline: { agentSessionId: input.agentSessionId, revision: 0, items: [] }, projectionFailures: [] }
      return result
    })
    const createResource = vi.fn<SpatialControlPorts['createResource']>(input => createSpaceZoneResource(input, resources))
    const originalRequestId = `resource-cwd:${shape}:${kind}`
    const resource = kind === 'worktree'
      ? { kind, projectId, path: _hygiene_fixturePath("new-tree"), branch: 'feat/task', createBranch: true }
      : { kind, projectId, path: _hygiene_fixturePath("new-dir") }
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: originalRequestId, operation: 'agent.open',
      content: { kind: 'new-agent', executorId: 'fixture', prompt: 'exact first task' },
      destination: { spaceId: space.spaceId, displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'display-group', newZone: resource }, focus: false })
    if (request.operation !== 'agent.open') throw new Error('The strict parser must return the original Agent open tuple')
    const control: SpatialControlPorts = { get: () => state, patch: patch => Object.assign(state, patch), topics: async () => [topic],
      createResource, launch: launchAgent, creation: async () => { throw new Error('No second creation reader is needed for the first launch') },
      attach: async (_regionId, created) => { state.sessions = [...state.sessions, created.session!] },
      save: async layoutApplied => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
      focus: vi.fn(), isFocused: () => false, notice: vi.fn(), closing: () => false }
    const result = await executeSpatialControl(control, request)
    if (result.operation !== 'agent.open') throw new Error('The original owner must return an Agent open receipt')
    expect(result.outcome).toBe('opened')
    expect(createResource).toHaveBeenCalledExactlyOnceWith({ spaceId: space.spaceId, resource })
    expect(launchAgent).toHaveBeenCalledOnce()
    expect(launchAgent.mock.calls[0]![0]).toEqual({ executorId: 'fixture', hostId: repo.hostId, workspacePath: resource.path,
      agentSessionId: result.agent!.agentSessionId, createOperationId: originalRequestId, prompt: 'exact first task' })
    const resourceWorkspaceId = kind === 'worktree' ? 'worktree' : 'new-zone'
    const zoneId = workspaceZoneId(space.spaceId, resourceWorkspaceId)
    const catalog = spatialCatalog(state, [topic])
    expect(catalog.zones.find(zone => zone.zoneId === zoneId)).toEqual({ zoneId, workspaceId: resourceWorkspaceId,
      kind, hostId: repo.hostId, directoryPath: resource.path, branch: kind === 'worktree' ? 'feat/task' : null })
    expect(catalog.zones.find(zone => zone.zoneId === home.zoneId)).toEqual(home)
    expect(result.resource).toMatchObject({ path: resource.path, workspaceId: resourceWorkspaceId, hostId: repo.hostId, kind })
    expect(result.to).toMatchObject({ spaceId: space.spaceId, zoneId, workspaceId: resourceWorkspaceId,
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'display-group' })
    expect(result.agent).toMatchObject({ cwd: resource.path, initialPrompt: 'confirmed', createOperationId: originalRequestId })
  })
})
