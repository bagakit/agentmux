import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  type AgentMuxCompositionRequest
} from '@agentmux/core'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces,
  type AgentWorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agentSession(id: string): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Codex ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId: `run-${id}` }
    }
  }
}

function agentLaunchResult(session: SessionSnapshot): AgentLaunchResult {
  if (session.kind !== 'agent') throw new Error('Expected Agent Session fixture')
  return {
    session,
    timeline: { agentSessionId: session.id, revision: 0, items: [] }
  }
}

function agentTab(viewId: string, sessionId: string): WorkbenchTab {
  return createWorkbenchTab(viewId, {
    regionId: initialWorkbenchRegionId(viewId),
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId
  })
}

function compositionFixture(extraSessions: SessionSnapshot[] = []): WorkbenchTab {
  const caller = agentSession('caller')
  const tab = agentTab('caller-view', caller.id)
  useAppStore.setState({
    config,
    sessions: [caller, ...extraSessions],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('caller-group', [tab.id]) },
    executorDetections: {
      [executorDetectionKey('local', 'codex')]: {
        state: 'ready',
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', installed: true }
      }
    },
    error: null
  })
  return tab
}

function request<Operation extends AgentMuxCompositionRequest['operation']>(
  value: Omit<
    Extract<AgentMuxCompositionRequest, { operation: Operation }>,
    'schemaVersion' | 'requestId'
  >
): Extract<AgentMuxCompositionRequest, { operation: Operation }> {
  return {
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: `request-${value.operation}`,
    ...value
  } as Extract<AgentMuxCompositionRequest, { operation: Operation }>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function launchingRegion(): { tab: WorkbenchTab; surface: AgentWorkbenchSurface } | null {
  for (const tab of Object.values(useAppStore.getState().tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind === 'agent' && surface.phase === 'launching') return { tab, surface }
    }
  }
  return null
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Desktop Composition owner', () => {
  it('returns the caller View, Region, and Tab Group without changing layout', async () => {
    const caller = compositionFixture()
    const before = structuredClone(useAppStore.getState().layouts)

    await expect(useAppStore.getState().executeComposition(request({
      operation: 'context',
      caller: { agentSessionId: 'caller' }
    }))).resolves.toEqual({
      operation: 'context',
      context: {
        agentSessionId: 'caller',
        workspaceId: 'workspace',
        viewId: caller.id,
        regionId: caller.layout.activeRegionId,
        tabGroupId: 'caller-group',
        regions: [{
          regionId: caller.layout.activeRegionId,
          kind: 'agent',
          providerId: 'codex',
          executorId: 'codex',
          agentSessionId: 'caller',
          bounds: { x: 0, y: 0, width: 1, height: 1 }
        }],
        executors: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }]
      }
    })
    expect(useAppStore.getState().layouts).toEqual(before)
  })

  it('returns the whole View spatial map when the caller occupies only one Region', async () => {
    const left = agentSession('left')
    const rightTop = agentSession('right-top')
    const caller = agentSession('caller')
    const viewId = 'spatial-view'
    const leftRegionId = initialWorkbenchRegionId(viewId)
    const rightTopRegionId = 'right-top-region'
    const callerRegionId = 'caller-region'
    let tab = agentTab(viewId, left.id)
    tab = addWorkbenchRegion(tab, leftRegionId, 'right', {
      regionId: rightTopRegionId,
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: rightTop.id
    })
    tab = addWorkbenchRegion(tab, rightTopRegionId, 'down', {
      regionId: callerRegionId,
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: caller.id
    })
    useAppStore.setState({
      config,
      sessions: [left, rightTop, caller],
      activeWorkspaceId: 'workspace',
      mainSurface: 'workbench',
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('spatial-group', [tab.id]) },
      executorDetections: {
        [executorDetectionKey('local', 'codex')]: {
          state: 'ready',
          result: { executorId: 'codex', providerId: 'codex', hostId: 'local', installed: true }
        }
      },
      error: null
    })

    await expect(useAppStore.getState().executeComposition(request({
      operation: 'context',
      caller: { agentSessionId: caller.id }
    }))).resolves.toEqual({
      operation: 'context',
      context: {
        agentSessionId: caller.id,
        workspaceId: 'workspace',
        viewId,
        regionId: callerRegionId,
        tabGroupId: 'spatial-group',
        regions: [
          {
            regionId: leftRegionId,
            kind: 'agent',
            providerId: 'codex',
            executorId: 'codex',
            agentSessionId: left.id,
            bounds: { x: 0, y: 0, width: 0.5, height: 1 }
          },
          {
            regionId: rightTopRegionId,
            kind: 'agent',
            providerId: 'codex',
            executorId: 'codex',
            agentSessionId: rightTop.id,
            bounds: { x: 0.5, y: 0, width: 0.5, height: 0.5 }
          },
          {
            regionId: callerRegionId,
            kind: 'agent',
            providerId: 'codex',
            executorId: 'codex',
            agentSessionId: caller.id,
            bounds: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
          }
        ],
        executors: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }]
      }
    })
  })

  it.each(['split-left', 'split-right', 'split-up', 'split-down'] as const)(
    'opens an existing Session with %s inside the same Tab View',
    async (placement) => {
      const caller = compositionFixture([agentSession('target')])

      const result = await useAppStore.getState().executeComposition(request({
        operation: 'region.open',
        caller: { agentSessionId: 'caller' },
        agentSessionId: 'target',
        placement,
        relativeTo: { kind: 'self' }
      }))

      expect(result).toMatchObject({
        operation: 'region.open',
        region: {
          viewId: caller.id,
          kind: 'agent',
          agentSessionId: 'target',
          tabGroupId: 'caller-group'
        }
      })
      const state = useAppStore.getState()
      expect(Object.keys(state.tabs)).toEqual([caller.id])
      expect(state.layouts.workspace?.groups).toHaveLength(1)
      expect(workbenchSurfaces(state.tabs[caller.id]!)).toHaveLength(2)
    }
  )

  it('creates a new Tab View only for explicit tab placement', async () => {
    const caller = compositionFixture([agentSession('target')])

    const result = await useAppStore.getState().executeComposition(request({
      operation: 'region.open',
      caller: { agentSessionId: 'caller' },
      agentSessionId: 'target',
      placement: 'tab',
      relativeTo: { kind: 'self' }
    }))

    expect(result.operation).toBe('region.open')
    if (result.operation !== 'region.open') throw new Error('Unexpected result')
    expect(result.region.viewId).not.toBe(caller.id)
    const state = useAppStore.getState()
    expect(Object.keys(state.tabs)).toHaveLength(2)
    expect(state.layouts.workspace?.groups).toHaveLength(1)
    expect(state.layouts.workspace?.groups[0]?.tabOrder).toHaveLength(2)
  })

  it('fails closed for ambiguous self while allowing an exact Region', async () => {
    const caller = compositionFixture([agentSession('target')])
    const secondRegionId = 'caller-region-two'
    useAppStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        [caller.id]: addWorkbenchRegion(caller, caller.layout.activeRegionId, 'right', {
          regionId: secondRegionId,
          kind: 'agent',
          phase: 'attached',
          workspaceId: 'workspace',
          sessionId: 'caller'
        })
      }
    }))

    await expect(useAppStore.getState().executeComposition(request({
      operation: 'region.open',
      caller: { agentSessionId: 'caller' },
      agentSessionId: 'target',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))).rejects.toMatchObject({ code: 'AMBIGUOUS_REGION_TARGET' })

    await expect(useAppStore.getState().executeComposition(request({
      operation: 'region.open',
      caller: { agentSessionId: 'caller' },
      agentSessionId: 'target',
      placement: 'split-right',
      relativeTo: { kind: 'region', regionId: secondRegionId }
    }))).resolves.toMatchObject({
      operation: 'region.open',
      region: { viewId: caller.id }
    })
  })

  it('launches into a new Region in the current View', async () => {
    const caller = compositionFixture()
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => (
      agentLaunchResult(agentSession(input.agentSessionId!))
    ))

    const result = await useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      prompt: 'Inspect the failing tests',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))

    expect(result).toMatchObject({
      operation: 'launch',
      region: { viewId: caller.id, kind: 'agent', workspaceId: 'workspace' }
    })
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Inspect the failing tests',
      createOperationId: 'request-launch'
    }))
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([caller.id])
    expect(workbenchSurfaces(useAppStore.getState().tabs[caller.id]!)).toHaveLength(2)
  })

  it('joins a split launch to the caller View Topic in Scratch', async () => {
    const caller = {
      ...agentSession('caller'),
      workspacePath: '/scratch/topic--view--shared-topic'
    }
    const viewId = 'view:shared-topic'
    const tab = {
      ...createWorkbenchTab(viewId, {
        regionId: initialWorkbenchRegionId(viewId),
        kind: 'agent' as const,
        phase: 'attached' as const,
        workspaceId: SCRATCH_WORKSPACE_ID,
        sessionId: caller.id
      }),
      topicId: viewId
    }
    useAppStore.setState({
      config: {
        ...config,
        workspaces: [{
          id: SCRATCH_WORKSPACE_ID,
          name: 'Scratch',
          hostId: 'local',
          path: '/scratch',
          kind: 'folder'
        }]
      },
      sessions: [caller],
      activeWorkspaceId: SCRATCH_WORKSPACE_ID,
      tabs: { [viewId]: tab },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [viewId]) },
      executorDetections: {
        [executorDetectionKey('local', 'codex')]: {
          state: 'ready',
          result: { executorId: 'codex', providerId: 'codex', hostId: 'local', installed: true }
        }
      },
      workspaceFileRevisions: {},
      error: null
    })
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => (
      agentLaunchResult({
        ...agentSession(input.agentSessionId!),
        workspacePath: '/scratch/topic--view--shared-topic'
      })
    ))

    const result = await useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: caller.id },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))

    expect(result).toMatchObject({ region: { viewId } })
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ scratchTopicId: viewId }))
    expect(useAppStore.getState().tabs[viewId]?.topicId).toBe(viewId)
    expect(workbenchSurfaces(useAppStore.getState().tabs[viewId]!)).toHaveLength(2)
  })

  it('rolls back only the new Region when launch fails', async () => {
    compositionFixture()
    vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('provider launch failed'))
    const before = structuredClone({
      tabs: useAppStore.getState().tabs,
      layouts: useAppStore.getState().layouts
    })

    await expect(useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))).rejects.toThrow('provider launch failed')
    expect({
      tabs: useAppStore.getState().tabs,
      layouts: useAppStore.getState().layouts
    }).toEqual(before)
  })

  it('stops a late launch when its pending Region disappears', async () => {
    compositionFixture()
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()

    const launched = useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))
    const owner = launchingRegion()
    expect(owner).not.toBeNull()
    const session = agentSession(owner!.surface.sessionId)
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'agent-timeline',
        agentSessionId: session.id,
        revision: 1,
        mutation: {
          type: 'append',
          agentSessionId: session.id,
          item: {
            id: 'pending-before-close',
            agentSessionId: session.id,
            kind: 'lifecycle',
            status: 'complete',
            source: 'native-hook',
            createdAt: 1,
            updatedAt: 1,
            title: 'Started'
          }
        },
        evidence: { source: 'native-hook', observedAt: 1, run: session.control.run }
      }
    })
    expect(useAppStore.getState().pendingAgentLaunches[session.id]?.events).toHaveLength(1)
    await useAppStore.getState().closeRegion('workspace', owner!.tab.id, owner!.surface.regionId)
    expect(useAppStore.getState().pendingAgentLaunches[session.id]?.events).toHaveLength(1)
    pending.resolve(agentLaunchResult(session))

    await expect(launched).rejects.toMatchObject({ code: 'COMPOSITION_REGION_OWNER_LOST' })
    expect(stop).toHaveBeenCalledWith(session.control)
  })

  it('keeps a late Agent discoverable when its Region disappears and cleanup fails', async () => {
    compositionFixture()
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('runtime owner unavailable'))

    const launched = useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }))
    const owner = launchingRegion()
    expect(owner).not.toBeNull()
    const session = agentSession(owner!.surface.sessionId)
    const result = agentLaunchResult(session)
    await useAppStore.getState().closeRegion('workspace', owner!.tab.id, owner!.surface.regionId)
    pending.resolve(result)

    await expect(launched).rejects.toMatchObject({ code: 'COMPOSITION_REGION_OWNER_LOST' })
    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().sessions).toContainEqual(session)
    expect(useAppStore.getState().timelines[session.id]).toEqual(result.timeline)
    expect(useAppStore.getState().pendingAgentLaunches[session.id]).toBeUndefined()
  })

  it('rolls back immediately on timeout and stops a late Agent', async () => {
    compositionFixture()
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const controller = new AbortController()
    const timeout = Object.assign(new Error('Desktop Composition request timed out.'), {
      code: 'COMPOSITION_TIMEOUT'
    })

    const launched = useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }), controller.signal)
    const owner = launchingRegion()
    expect(owner).not.toBeNull()

    controller.abort(timeout)
    expect(workbenchSurfaces(useAppStore.getState().tabs['caller-view']!)).toHaveLength(1)
    expect(useAppStore.getState().layouts.workspace?.groups).toHaveLength(1)

    const session = agentSession(owner!.surface.sessionId)
    pending.resolve(agentLaunchResult(session))
    await expect(launched).rejects.toBe(timeout)
    expect(stop).toHaveBeenCalledWith(session.control)
  })

  it('keeps an aborted late Agent discoverable when cleanup fails', async () => {
    compositionFixture()
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('runtime owner unavailable'))
    const controller = new AbortController()
    const timeout = Object.assign(new Error('Desktop Composition request timed out.'), {
      code: 'COMPOSITION_TIMEOUT'
    })

    const launched = useAppStore.getState().executeComposition(request({
      operation: 'launch',
      caller: { agentSessionId: 'caller' },
      executorId: 'codex',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }), controller.signal)
    const owner = launchingRegion()
    expect(owner).not.toBeNull()
    controller.abort(timeout)

    const session = agentSession(owner!.surface.sessionId)
    const result = agentLaunchResult(session)
    pending.resolve(result)

    await expect(launched).rejects.toMatchObject({ code: 'COMPOSITION_TIMEOUT' })
    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().sessions).toContainEqual(session)
    expect(useAppStore.getState().timelines[session.id]).toEqual(result.timeline)
    expect(useAppStore.getState().pendingAgentLaunches[session.id]).toBeUndefined()
  })
})
