import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxError, AgentMuxRpcService, type AgentMuxRuntimeProjection } from '@agentmux/core'
import { createHostSnapshotObservation } from '../src/snapshot-observation.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
async function originalConfiguration(workspaces = [
  { id: 'repo', hostId: 'local', name: 'Repo', path: '/original/repo', kind: 'folder' },
  { id: 'worktree', hostId: 'local', name: 'Branch', path: '/original/worktree', repoPath: '/original/repo', kind: 'worktree' },
  { id: 'other', hostId: 'local', name: 'Other', path: '/original/other', kind: 'folder' }
]) {
  const root = await mkdtemp(join(tmpdir(), 'amx-snapshot-directories-')); roots.push(root)
  const path = join(root, 'configuration.json')
  await writeFile(path, JSON.stringify({ workspaces, executors: {
    codex: { providerId: 'codex', label: 'Original Codex' }, claude: { providerId: 'claude', label: 'Original Claude' }
  } }))
  return path
}
function projection(): AgentMuxRuntimeProjection {
  const agent = (id: string, path: string, state: 'running' | 'exited') => ({ kind: 'agent', hostId: 'local', workspacePath: path,
    agentSession: { agentSessionId: id }, run: { runId: 'run-' + id, state } })
  // Only the original Core observation port is controlled; the Host and public service are real.
  return { hostId: 'local', subjects: [agent('active', '/original/worktree', 'running'),
    agent('ended', '/original/repo', 'exited'), agent('unrelated', '/elsewhere', 'running')] } as AgentMuxRuntimeProjection
}
const generic = () => vi.fn(async () => { throw new AgentMuxError('No GUI owner is mounted.', 'CONTROL_UNAVAILABLE') })

it('reads nonempty original Project and Executor directories through the public service without a GUI owner', async () => {
  const path = await originalConfiguration(), runtimeProjection = vi.fn(async () => projection()), execute = generic()
  const service = new AgentMuxRpcService({ snapshot: createHostSnapshotObservation(path, () => [{ hostId: 'local', client: { runtimeProjection } }]), execute })
  const value = await service.call('app.snapshot', { include: ['projects', 'executors'] })
  expect(value.projects).toHaveLength(2)
  expect(value.projects.find(project => project.name === 'Repo')).toMatchObject({ path: '/original/repo', activeAgentSessionIds: ['active'] })
  expect(value.projects.find(project => project.name === 'Other')!.activeAgentSessionIds).toEqual([])
  expect(value.executors.map(executor => [executor.executorId, executor.availability])).toEqual([['codex', 'unknown'], ['claude', 'unknown']])
  expect(value.unavailable).toEqual([]); expect(execute).not.toHaveBeenCalled()
  expect(runtimeProjection).toHaveBeenCalledTimes(1)
})

it('keeps exact directory filters and the public response limit', async () => {
  const path = await originalConfiguration(), runtimeProjection = vi.fn(async () => projection())
  const service = new AgentMuxRpcService({ snapshot: createHostSnapshotObservation(path, () => [{ hostId: 'local', client: { runtimeProjection } }]), execute: generic() })
  const all = await service.call('app.snapshot', { include: ['projects', 'executors'], limit: 1 })
  expect(all.projects).toHaveLength(1); expect(all.executors).toHaveLength(1)
  const selected = await service.call('app.snapshot', { include: ['projects', 'executors'], projectId: all.projects[0]!.projectId, executorId: 'claude' })
  expect(selected.projects.map(project => project.projectId)).toEqual([all.projects[0]!.projectId])
  expect(selected.executors.map(executor => executor.executorId)).toEqual(['claude'])
  expect(selected.unavailable).toEqual([])
})

it('accepts an explicitly empty directory without falling through to another owner or probing a Runtime', async () => {
  const path = await originalConfiguration([]), clients = vi.fn(() => []), execute = generic()
  const service = new AgentMuxRpcService({ snapshot: createHostSnapshotObservation(path, clients), execute })
  const value = await service.call('app.snapshot', { include: ['projects'] })
  expect(value.projects).toEqual([]); expect(value.unavailable).toEqual([]); expect(execute).not.toHaveBeenCalled()
})

it('keeps saved directories and independent Executor facts when a Project Runtime observation fails', async () => {
  const path = await originalConfiguration(), runtimeProjection = vi.fn(async () => { throw new Error('Original Runtime temporarily unavailable') })
  const service = new AgentMuxRpcService({ snapshot: createHostSnapshotObservation(path, () => [{ hostId: 'local', client: { runtimeProjection } }]), execute: generic() })
  const value = await service.call('app.snapshot', { include: ['projects', 'executors'] })
  expect(value.projects).toHaveLength(2); expect(value.executors).toHaveLength(2)
  expect(value.unavailable).toEqual([expect.objectContaining({ source: 'projects', code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('temporarily unavailable') })])
  expect(runtimeProjection).toHaveBeenCalledTimes(1)
})

it('preserves a partial owner issue and still reads an unprovided directory from its original generic owner', async () => {
  const issue = { source: 'projects', code: 'CONTROL_UNAVAILABLE', message: 'Project membership is unconfirmed', recovery: 'Reconnect original Host' }
  const execute = vi.fn(async (request: { operation: string }) => {
    if (request.operation === 'list.agents') return { operation: 'list.agents' as const, agents: [{ executorId: 'actual', label: 'Actual', providerId: 'codex', availability: 'available' as const }] }
    throw new Error('A supplied directory was queried twice')
  })
  const service = new AgentMuxRpcService({ snapshot: async () => ({ projects: [], unavailable: [issue] }), execute })
  const value = await service.call('app.snapshot', { include: ['projects', 'executors'] })
  expect(value.projects).toEqual([]); expect(value.executors[0]!.executorId).toBe('actual'); expect(value.unavailable).toEqual([issue])
  expect(execute).toHaveBeenCalledTimes(1)
})

it('retains the independent Goal activity and spatial Zone dependency reads', async () => {
  const execute = vi.fn(async (request: { operation: string }) => {
    if (request.operation === 'demand.list') return { operation: 'demand.list' as const, demands: [] }
    if (request.operation === 'space.ls') return { operation: 'space.ls' as const, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    throw new Error('Unrequested source')
  })
  const service = new AgentMuxRpcService({ snapshot: async () => ({ goals: [], spaces: [] }), execute })
  const value = await service.call('app.snapshot', { include: ['activity', 'zones'] })
  expect(value.unavailable).toEqual([])
  expect(execute.mock.calls.map(([request]) => request.operation).sort()).toEqual(['demand.list', 'space.ls'])
})
