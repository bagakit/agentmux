// @vitest-environment happy-dom
// Real trusted Main IPC: the registered sessions:launchAgent handler records the created Agent's
// exact Launcher Region in the isolated Core spatial file while the Renderer saves nothing.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { bridge, owningBridge } from './fixtures/terminal-observation-bridge'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import type { AgentLaunchResult, AppConfig } from '../src/shared/contracts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the trusted launch handler records the Launcher Agent position in Core with no Renderer save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-launcher-position-'))
  isolateCoreFixtureEnvironment(root)
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: {},
    workspaces: [{ id: 'project', hostId: 'local', name: 'Original project', path: root, kind: 'folder' }] }
  const spatial = new AgentMuxSpatialStateStore()
  const launcher = createWorkbenchTab('launch-tab', { regionId: 'launch-region', kind: 'launcher', workspaceId: 'project' } as never)
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [], tabs: { 'launch-tab': launcher },
    layouts: { project: createWorkspaceLayout('group', ['launch-tab']) }, spaceZoneBindings: {}, spatialRequests: {} } as never, []) })
  const store = new AgentMuxMemoryAgentSessionStore(), core = new AgentMuxClient({ store })
  const b = await owningBridge({ client: core, store, config })
  try {
    const commits = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'commit')
    vi.spyOn(b.runtime, 'launchAgent').mockImplementation(async input => ({ projectionFailures: [],
      created: { kind: 'agent', agentSessionId: input.agentSessionId!, hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: root,
        run: { runId: 'created-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
        creation: { createOperationId: input.createOperationId!, initialPrompt: 'confirmed', createdRun: { runId: 'created-run' } } } } as unknown as AgentLaunchResult))
    const result = await bridge.api!.sessions.launchAgent({ launcher: { tabId: 'launch-tab', regionId: 'launch-region' }, executionWorkspaceId: 'project',
      executorId: 'codex', hostId: 'local', workspacePath: root, prompt: 'Original first instruction',
      agentSessionId: 'created-agent', createOperationId: 'original-creation' })
    expect(result.placementIssue).toBeUndefined()
    expect(result.created.agentSessionId).toBe('created-agent')
    // No layout snapshot was committed; the position came from the creation owner alone.
    expect(commits).not.toHaveBeenCalled()
    const saved = (await new AgentMuxSpatialStateStore().read())!
    expect(saved.graph.regions.find(region => region.regionId === 'launch-region')).toEqual({ tabId: 'launch-tab', regionId: 'launch-region',
      kind: 'agent', agentSessionId: 'created-agent', runId: 'created-run', execution: { hostId: 'local', cwd: root } })
  } finally {
    await b.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
