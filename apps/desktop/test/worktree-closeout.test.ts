import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { AgentMuxControlServer, LocalExecutionHost, type AgentMuxClient } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { ConfigOwner } from '../src/main/config-owner'
import { WorktreeService } from '../src/main/worktree-service'
import { WorktreeCloseoutOwner } from '../src/main/worktree-closeout'
import { worktreeExecutionReferences } from '../src/main/worktree-execution-references'
import { GitPublicControl } from '../src/main/git-public-control'
import { GitService } from '../src/main/git-service'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const roots: string[] = [], children: ChildProcess[] = []
const servers: AgentMuxControlServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worktree-closeout-'))); roots.push(root)
  const host = new LocalExecutionHost(), repo = join(root, 'repo'), lane = join(root, 'lane')
  await mkdir(repo)
  const git = async (...args: string[]) => {
    const result = await host.run('git', ['-C', repo, ...args], { timeoutMs: 10_000 })
    expect(result.exitCode, result.stderr).toBe(0)
    return result.stdout
  }
  await git('init', '-b', 'main')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Initialize fixture')
  await git('worktree', 'add', '-b', 'feature', lane)
  const target: WorkspaceRecord = { id: 'default', name: 'Project', hostId: 'local', path: repo, kind: 'folder' }
  const source: WorkspaceRecord = { id: 'lane', name: 'Feature', hostId: 'local', path: lane, repoPath: repo, branch: 'feature', kind: 'worktree' }
  let config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [target, source],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as AppConfig
  const published: AppConfig[] = []
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: saved => { config = saved; published.push(saved) } })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', workspaceId: source.id, phase: 'attached', sessionId: 'original-session' }, 'Original title')
  const graph = desktopSpatialGraph({ config, sessions: [], tabs: { [tab.id]: tab }, layouts: { [source.id]: createWorkspaceLayout('original-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }, [])
  await spatial.commit({ expectedRevision: 0, graph })
  const worktrees = new WorktreeService(() => host, { save: (next, expected) => configOwner.edit(expected, next) })
  const executionReferences = vi.fn(async (_workspace: WorkspaceRecord): Promise<string[]> => [])
  const prepare = vi.fn(async () => {})
  const owner = new WorktreeCloseoutOwner({ config: configOwner, spatial, worktrees, executionReferences, prepare })
  const params = { workspaceId: source.id, expectedResource: { hostId: source.hostId, workspacePath: source.path }, operationId: 'original-close' }
  return { root, repo, lane, source, target, owner, params, git, spatial, worktrees, executionReferences, prepare, configOwner, published, get config() { return config } }
}

describe('original worktree closeout product owner', () => {
  it('persists the original workface before real Git removal and replays its original public operation after source withdrawal', async () => {
    const f = await fixture()
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workspaceId: f.source.id, targetWorkspaceId: f.target.id, movedTabIds: ['original-tab'], workface: 'moved', cleanup: 'removed', reason: null })
    await expect(stat(f.lane)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.git('worktree', 'list', '--porcelain')).not.toContain(f.lane)
    expect(f.config.workspaces.map(workspace => workspace.id)).toEqual([f.target.id])
    const restarted = new AgentMuxSpatialStateStore(f.spatial.path)
    const saved = await restarted.read()
    expect(saved!.graph.zones.some(zone => zone.workspaceId === f.source.id)).toBe(false)
    expect(desktopWorkbenchFromSpatial(saved!.graph).tabs['original-tab']).toMatchObject({ workspaceId: f.target.id,
      regions: { 'original-region': { sessionId: 'original-session', workspaceId: f.source.id } } })
    expect(await f.owner.publicClose(f.params)).toEqual(result)
    expect(f.executionReferences).toHaveBeenCalledTimes(1)
    await expect(f.owner.publicClose({ ...f.params, discardChanges: true })).rejects.toThrow('different input')
  })

  it('keeps a real live cwd and its process while collecting the original Agent display into the default workspace', async () => {
    const f = await fixture()
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.cwd());setInterval(()=>{},1000)'], { cwd: f.lane, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
    const cwd = await new Promise<string>(resolve => child.stdout!.once('data', data => resolve(String(data))))
    expect(cwd).toBe(f.lane)
    f.executionReferences.mockResolvedValue(['original-session'])
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workface: 'moved', cleanup: 'pending', movedTabIds: ['original-tab'] })
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(f.lane)
    expect(f.config.workspaces.find(workspace => workspace.id === f.source.id)?.closeout).toMatchObject({ targetWorkspaceId: f.target.id, cleanup: 'pending' })
    expect((await f.spatial.read())!.graph.tabs[0]).toMatchObject({ tabId: 'original-tab', workspaceId: f.target.id })
    f.executionReferences.mockResolvedValue([])
    child.kill(); await new Promise(resolve => child.once('exit', resolve))
    const retried = await f.owner.publicClose({ ...f.params, operationId: 'cleanup-after-release' })
    expect(retried.cleanup).toBe('removed')
    expect(await f.owner.publicClose(f.params)).toEqual(result)
  })

  it('retains evidence in an already unregistered cwd shell without running status against its ancestor repository', async () => {
    const f = await fixture()
    await f.git('worktree', 'remove', f.lane)
    await mkdir(f.lane)
    await writeFile(join(f.lane, 'evidence.json'), 'original evidence')
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workface: 'moved', cleanup: 'kept' })
    expect(result.reason).toContain('Git already ended')
    expect(await readFile(join(f.lane, 'evidence.json'), 'utf8')).toBe('original evidence')
    expect(f.config.workspaces.some(workspace => workspace.id === f.source.id)).toBe(false)
    expect((await f.spatial.read())!.graph.tabs[0]!.workspaceId).toBe(f.target.id)
  })

  it('finishes a previously unregistered and absent directory instead of leaving a permanent pending row', async () => {
    const f = await fixture(); await f.git('worktree', 'remove', f.lane)
    expect(await f.owner.publicClose(f.params)).toMatchObject({ workface: 'moved', cleanup: 'removed' })
    expect(f.config.workspaces.some(workspace => workspace.id === f.source.id)).toBe(false)
  })

  it('keeps unknown Runtime separate from successful presentation movement', async () => {
    const f = await fixture(); f.executionReferences.mockRejectedValue(new Error('Endpoint unavailable'))
    expect(await f.owner.publicClose(f.params)).toMatchObject({ workface: 'moved', cleanup: 'pending', reason: expect.stringContaining('unconfirmed') })
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(f.lane)
  })

  it('never deletes original file resources or dirty output, and explicit cleanup can resume after release', async () => {
    const f = await fixture()
    await writeFile(join(f.lane, 'output.md'), 'uncommitted output')
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workface: 'moved', cleanup: 'pending' })
    expect(f.config.workspaces.find(workspace => workspace.id === f.source.id)?.closeout?.retention).toBe('uncommitted-changes')
    expect(await readFile(join(f.lane, 'output.md'), 'utf8')).toBe('uncommitted output')
    expect(await f.owner.publicClose({ ...f.params, operationId: 'explicit-discard', discardChanges: true })).toMatchObject({ cleanup: 'removed' })
  })

  it('reports partial spatial persistence truth without deleting the directory or losing cleanup responsibility', async () => {
    const f = await fixture()
    const originalCommit = f.spatial.commit.bind(f.spatial)
    const failing = vi.spyOn(f.spatial, 'commit').mockRejectedValue(new Error('Spatial storage unavailable'))
    const partial = await f.owner.publicClose(f.params)
    expect(partial).toMatchObject({ workface: 'pending', cleanup: 'pending', reason: expect.stringContaining('incomplete') })
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(f.lane)
    expect(f.config.workspaces.find(workspace => workspace.id === f.source.id)?.closeout).toBeDefined()
    failing.mockImplementation(originalCommit)
    expect(await f.owner.publicClose({ ...f.params, operationId: 'restored-storage' })).toMatchObject({ workface: 'moved', cleanup: 'removed' })
  })

  it('does not merge different in-flight operations or discard choices', async () => {
    const f = await fixture()
    let release!: () => void
    f.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const first = f.owner.close({ workspaceId: f.source.id }, 'first')
    const other = await f.owner.close({ workspaceId: f.source.id, discardChanges: true }, 'second')
    expect(other).toMatchObject({ status: 'retained', reason: expect.stringContaining('still running') })
    release(); expect(await first).toMatchObject({ status: 'closed' })
  })

  it('retains a truthful cleanup responsibility when Git succeeds but the final receipt write fails', async () => {
    const f = await fixture()
    const commit = f.spatial.commit.bind(f.spatial)
    let writes = 0
    const failure = vi.spyOn(f.spatial, 'commit').mockImplementation(input => {
      writes++
      if (writes === 2) return Promise.reject(new Error('Final receipt write unavailable'))
      return commit(input)
    })
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workface: 'moved', cleanup: 'pending', reason: expect.stringContaining('Git confirmed directory removal') })
    await expect(stat(f.lane)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.config.workspaces.find(workspace => workspace.id === f.source.id)?.closeout?.retention).toBe('record-not-withdrawn')
    expect(await f.owner.publicClose(f.params)).toEqual(result)
    failure.mockImplementation(commit)
    expect(await f.owner.publicClose({ ...f.params, operationId: 'finish-withdrawal' })).toMatchObject({ workface: 'moved', cleanup: 'removed' })
  })

  it('keeps original file resource ownership until its workface is closed', async () => {
    const f = await fixture()
    const current = (await f.spatial.read())!
    current.graph.regions[0]!.kind = 'file'
    current.graph.regions[0]!.agentSessionId = null
    current.graph.resources['region:original-region'] = { workspaceId: f.source.id, path: 'saved.md' }
    await f.spatial.commit({ expectedRevision: current.revision, graph: current.graph })
    const result = await f.owner.publicClose(f.params)
    expect(result).toMatchObject({ workface: 'moved', cleanup: 'pending', reason: expect.stringContaining('file workfaces') })
    expect(f.config.workspaces.some(workspace => workspace.id === f.source.id)).toBe(true)
    expect((await f.spatial.read())!.graph.resources['region:original-region']).toEqual({ workspaceId: f.source.id, path: 'saved.md' })
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(f.lane)
  })

  it('refuses a redirected Workspace after prepare without deleting either original checkout', async () => {
    const f = await fixture(), other = join(f.root, 'another-lane')
    await f.git('worktree', 'add', '-b', 'another-feature', other)
    f.prepare.mockImplementation(async () => {
      await f.configOwner.update(config => ({ ...config, workspaces: config.workspaces.map(workspace => workspace.id === f.source.id ? { ...workspace, path: other } : workspace) }))
    })
    await expect(f.owner.publicClose(f.params)).rejects.toThrow('resource changed')
    expect(await stat(f.lane)).toBeDefined()
    expect(await stat(other)).toBeDefined()
    expect(f.executionReferences).not.toHaveBeenCalled()
    expect((await f.spatial.read())!.graph.tabs[0]!.workspaceId).toBe(f.source.id)
  })

  it('uses durable metadata and all current Runtime subjects when the Hosted session cache is empty', async () => {
    const f = await fixture()
    const cached = vi.fn(() => [])
    const client = {
      agentSessions: cached,
      readAgentSessions: vi.fn(async () => [{ workspacePath: join(f.lane, 'nested'), agentSessionId: 'recoverable-agent' }]),
      runtimeProjection: vi.fn(async () => ({ subjects: [
        { kind: 'agent', workspacePath: f.lane, agentSession: { agentSessionId: 'live-agent' }, run: { runId: 'live-run' } },
        { kind: 'terminal', workspacePath: f.lane, run: { runId: 'terminal-run' } },
        { kind: 'agent', workspacePath: f.lane + '-other', agentSession: { agentSessionId: 'unrelated-agent' }, run: { runId: 'other-run' } }
      ] }))
    } as unknown as Pick<AgentMuxClient, 'readAgentSessions' | 'runtimeProjection'>
    expect(await worktreeExecutionReferences(f.source, client)).toEqual(['recoverable-agent', 'live-agent', 'terminal-run'])
    expect(cached).not.toHaveBeenCalled()
    f.executionReferences.mockImplementation(workspace => worktreeExecutionReferences(workspace, client))
    expect(await f.owner.publicClose(f.params)).toMatchObject({ workface: 'moved', cleanup: 'pending' })
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(f.lane)
  })

  it('defers cleanup when either authoritative Runtime read fails', async () => {
    const f = await fixture()
    const client = { readAgentSessions: async () => { throw new Error('Metadata unavailable') },
      runtimeProjection: async () => ({ subjects: [] }) } as unknown as Pick<AgentMuxClient, 'readAgentSessions' | 'runtimeProjection'>
    f.executionReferences.mockImplementation(workspace => worktreeExecutionReferences(workspace, client))
    expect(await f.owner.publicClose(f.params)).toMatchObject({ cleanup: 'pending', reason: expect.stringContaining('unconfirmed') })
    expect(await stat(f.lane)).toBeDefined()
  })

  it('consumes the public CLI over a real Unix RPC chain and returns its exact original closeout receipt', async () => {
    const f = await fixture(), socket = join(f.root, 'close.sock')
    const host = new LocalExecutionHost()
    const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [],
      git: new GitPublicControl({ config: () => f.config, git: new GitService(() => host), closeWorktree: input => f.owner.publicClose(input) }),
      execute: async () => { throw new Error('This closeout has no unrelated presentation control.') } })
    servers.push(server); await server.start()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/u.test(key)))
    const args = [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + socket, 'git', 'worktree', 'close',
      '--workspace', f.source.id, '--host', f.source.hostId, '--workspace-path', f.source.path, '--operation-id', f.params.operationId]
    const cli = () => promisify(execFile)(process.execPath, args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 })
    const first = JSON.parse((await cli()).stdout)
    expect(first).toMatchObject({ ok: true, operation: 'git.worktree.close', result: { workspaceId: f.source.id, targetWorkspaceId: f.target.id,
      workface: 'moved', cleanup: 'removed', movedTabIds: ['original-tab'] } })
    expect(JSON.parse((await cli()).stdout)).toEqual(first)
    expect(f.executionReferences).toHaveBeenCalledTimes(1)
    expect(f.config.workspaces.some(workspace => workspace.id === f.source.id)).toBe(false)
  })
})
