import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { deriveFocusProjectLanes, retainedWorktreeFacts } from '../src/renderer/src/lib/focus-project-lanes'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
it('retains completed and terminal-only projects while distinguishing live Agent Run counts', () => {
  const rows = [{ id: 'a', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: true }, { id: 'done', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: false }, { id: 'terminal', workspaceId: 'beta', workspaceName: 'Beta', workspacePath: _hygiene_fixturePath("beta"), liveAgent: false }] as FocusContext[]
  const lanes = deriveFocusProjectLanes(rows)
  expect(lanes.map(lane => ({ workspaceId: lane.workspaceId, labels: lane.labels, active: lane.activeAgentIds, contexts: lane.contextIds }))).toEqual([
    { workspaceId: 'alpha', labels: ['Alpha'], active: ['a'], contexts: ['a', 'done'] }, { workspaceId: 'beta', labels: ['Beta'], active: [], contexts: ['terminal'] }
  ])
})
it('preserves a known checkout association when Git no longer lists the checkout', () => {
  const before = retainedWorktreeFacts([], { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature', worktreePath: _hygiene_fixturePath("checkout"), workspaceId: 'checkout', isCurrent: false }] })
  expect(before).toEqual([{ hostId: 'local', repoPath: _hygiene_fixturePath("repo"), path: _hygiene_fixturePath("checkout"), branch: 'feature', removed: false }])
  expect(retainedWorktreeFacts(before, { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature', worktreePath: null, workspaceId: null, isCurrent: false }] })).toEqual([{ ...before[0], removed: true }])
})
it('gathers closed worktree Agents with the default project while preserving original Context execution paths', () => {
  const target: WorkspaceRecord = { id: 'default', name: 'Project', kind: 'folder', hostId: 'local', path: _hygiene_fixturePath('project') }
  const source: WorkspaceRecord = { id: 'checkout', name: 'Feature', kind: 'worktree', hostId: 'local', path: _hygiene_fixturePath('project-checkout'),
    repoPath: target.path, branch: 'feature', closeout: { targetWorkspaceId: target.id, operationId: 'close-original', cleanup: 'pending', reason: 'Original execution resources remain.' } }
  const row = (id: string, workspace: WorkspaceRecord): FocusContext => ({ id, hostId: workspace.hostId, workspace, workspaceId: workspace.id,
    workspaceName: workspace.name, workspacePath: workspace.path, topicId: null, liveAgent: true }) as FocusContext
  const rows = [row('original-agent', source), row('default-agent', target)]
  const config = { workspaces: [target, source] } as AppConfig
  for (const removed of [false, true]) {
    const lanes = deriveFocusProjectLanes(rows, config, { topics: {}, worktrees: [{ hostId: source.hostId, path: source.path, repoPath: target.path, branch: source.branch!, removed }] })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ workspaceId: target.id, projectId: target.id, path: target.path, labels: ['Project'], recovery: null,
      activeAgentIds: ['original-agent', 'default-agent'], contextIds: ['original-agent', 'default-agent'] })
  }
  expect(rows[0]!.workspacePath).toBe(source.path)
  expect(rows[0]!.workspace).toBe(source)
  const { closeout: _closeout, ...openSource } = source
  const openLanes = deriveFocusProjectLanes([row('original-agent', openSource)], { ...config, workspaces: [target, openSource] })
  expect(openLanes[0]).toMatchObject({ workspaceId: source.id, path: source.path, labels: ['Project', 'feature'] })
})
it('uses the retained Tab presentation after completed cleanup withdraws the original resource', () => {
  const target: WorkspaceRecord = { id: 'default', name: 'Project', kind: 'folder', hostId: 'local', path: _hygiene_fixturePath('project') }
  const originalPath = _hygiene_fixturePath('project-checkout')
  const row = { id: 'original-agent', hostId: 'local', workspaceId: 'unregistered', workspaceName: 'Feature', workspacePath: originalPath,
    topicId: null, liveAgent: true } as FocusContext
  const tabs = { original: { workspaceId: target.id, regions: { original: { sessionId: row.id } } } } as unknown as Record<string, WorkbenchTab>
  const lanes = deriveFocusProjectLanes([row], { workspaces: [target] } as AppConfig, { topics: {}, worktrees: [{ hostId: 'local', path: originalPath, repoPath: target.path, branch: 'feature', removed: true }] }, tabs)
  expect(lanes).toHaveLength(1)
  expect(lanes[0]).toMatchObject({ workspaceId: target.id, labels: ['Project'], path: target.path, recovery: null, activeAgentIds: [row.id] })
  expect(row.workspacePath).toBe(originalPath)
})
