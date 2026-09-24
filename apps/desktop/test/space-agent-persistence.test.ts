import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { directoryIdentity, spatialSources, workspaceZoneId } from '../src/shared/space-addresses'
import { createSpaceZoneResource } from '../src/main/space-zone-resources'

const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
  workspaces: [{ id: 'target', hostId: 'local', name: 'Target', path: '/target', kind: 'folder' },
    { id: '__scratch__', hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
describe('durable Space placement through the actual restore owner', () => {
  it('retains exact Tab/Group/Region and spatial binding through a successful empty snapshot and cwd mismatch', () => {
    const spaceId = directoryIdentity('local', '/target')
    const tab = { ...createWorkbenchTab('tab', { regionId: 'region', kind: 'agent', phase: 'attached', workspaceId: 'target', sessionId: 'original-agent' }),
      space: { spaceId, zoneId: workspaceZoneId(spaceId, 'target') } }
    const persisted = projectPersistedWorkbench({ tabs: { tab }, layouts: { target: createWorkspaceLayout('original-group', ['tab']) } })
    const restored = restorePersistedWorkbench({ config, sessions: [], persisted, createTabGroupId: () => 'new-group' })
    expect(restored.tabs).toEqual({ tab })
    expect(restored.layouts.target).toEqual(persisted.layouts.target)
    const withDifferentCwd = restorePersistedWorkbench({ config, sessions: [{ id: 'original-agent', kind: 'agent', hostId: 'local', workspacePath: '/original-execution' } as never], persisted, createTabGroupId: () => 'new-group' })
    expect(withDifferentCwd.tabs).toEqual({ tab })
    const retired = restorePersistedWorkbench({ config, sessions: [], persisted, retiredSessionIds: new Set(['original-agent']), createTabGroupId: () => 'new-group' })
    expect(retired.tabs).toEqual({})
  })
  it('persists a preassigned launching Agent reference and preserves a temporarily undiscovered Workspace', () => {
    const spaceId = directoryIdentity('local', '/target')
    const tab = { ...createWorkbenchTab('reserved', { regionId: 'reserved-region', kind: 'agent', phase: 'launching', workspaceId: 'target', sessionId: 'reserved-agent' }),
      space: { spaceId, zoneId: workspaceZoneId(spaceId, 'target') } }
    const persisted = projectPersistedWorkbench({ tabs: { reserved: tab }, layouts: { target: createWorkspaceLayout('original-group', ['reserved']) } })
    expect(Object.keys(persisted.tabs)).toEqual(['reserved'])
    const restored = restorePersistedWorkbench({ config: { ...config, workspaces: [] }, sessions: [], persisted, createTabGroupId: () => 'new' })
    expect(restored.tabs).toEqual({ reserved: tab })
    expect(restored.layouts.target).toEqual(persisted.layouts.target)
  })
  it('retains discoverable directories for stale bindings and retains a Topic association when filesystem discovery is absent', () => {
    const targetSpace = directoryIdentity('local', '/target'), missingTopic = directoryIdentity('local', '/topics/topic--ordinary')
    const stale = spatialSources(config, [], { bad: { workspaceId: 'target', spaceId: 'not-an-identity' } })
    expect(stale.spaces.map(space => space.spaceId)).toContain(targetSpace)
    expect(stale.zones.map(zone => zone.workspaceId)).toContain('target')
    expect(stale.spaces.find(space => space.spaceId === targetSpace)?.issue).toContain('association is invalid')
    const retained = spatialSources(config, [], { [workspaceZoneId(missingTopic, 'target')]: { spaceId: missingTopic, workspaceId: 'target' } })
    expect(retained.zones.filter(zone => zone.workspaceId === 'target')).toEqual([{ zoneId: workspaceZoneId(missingTopic, 'target'), spaceId: missingTopic,
      workspaceId: 'target', kind: 'directory', hostId: 'local', directoryPath: '/target', branch: null }])
    expect(retained.spaces.find(space => space.spaceId === missingTopic)?.issue).toContain('discovery is unavailable')
  })
  it.each(['/target', '/target/', '/target/.'])('rejects an already-owned directory %s before registration and preserves its old Space', async path => {
    let calls = 0
    await expect(createSpaceZoneResource({ spaceId: directoryIdentity('local', '/topics'), resource: { kind: 'directory', path } }, {
      host: () => { throw new Error('Existing resources must fail before a host probe') },
      config: () => config, topics: async () => [], worktrees: { createForBranch: async () => { throw new Error('Git must not run') } },
      register: async () => { calls++; return { workspace: config.workspaces[0]!, changed: false } }
    })).rejects.toMatchObject({ code: 'SPACE_RESOURCE_ALREADY_BOUND' })
    expect(calls).toBe(0)
    expect(spatialSources(config, []).spaces.map(space => space.spaceId)).toContain(directoryIdentity('local', '/target'))
  })
})
