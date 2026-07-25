import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type {
  AgentLaunchResult,
  AgentTimelineItem,
  AppConfig,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionSnapshot
} from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  titleWorkbenchSurface
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 6,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex',
      providerId: 'codex',
      command: 'codex',
      args: [],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }
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

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
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
      run: { runId: `run:${id}` }
    }
  }
}

function item(agentSessionId: string, id: string, content: string): AgentTimelineItem {
  return {
    id,
    agentSessionId,
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Assistant response',
    content
  }
}

function timelineEvent(
  session: Extract<SessionSnapshot, { kind: 'agent' }>,
  revision: number,
  timelineItem: AgentTimelineItem
): RuntimeEvent {
  return {
    type: 'core',
    hostId: session.hostId,
    event: {
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision,
      mutation: { type: 'append', agentSessionId: session.id, item: timelineItem },
      evidence: {
        source: 'native-hook',
        observedAt: revision,
        run: session.control.run
      }
    }
  }
}

function agentSessionEvent(session: Extract<SessionSnapshot, { kind: 'agent' }>): RuntimeEvent {
  return {
    type: 'core',
    hostId: session.hostId,
    event: {
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: session.id,
        providerId: session.providerId,
        executorId: session.executorId,
        hostId: session.hostId,
        workspacePath: session.workspacePath,
        run: session.control.run,
        retiredRuns: [],
        outputCursorBytes: session.latestOutputBytes,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    }
  }
}

function launcherTab(id: string) {
  return createWorkbenchTab(id, {
    regionId: initialWorkbenchRegionId(id),
    kind: 'launcher',
    workspaceId: 'workspace'
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Timeline convergence', () => {
  it('switches Terminal and Activity as projections of the same Agent Session', () => {
    const session = agentSession('projection-session')
    const timeline = {
      agentSessionId: session.id,
      revision: 1,
      items: [item(session.id, 'projection-item', 'same Timeline')]
    }
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
    const recover = vi.spyOn(api.sessions, 'recover')
    const stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.setState({
      sessions: [session],
      timelines: { [session.id]: timeline },
      viewModes: { [session.id]: 'terminal' }
    })

    useAppStore.getState().setViewMode(session.id, 'activity')

    expect(useAppStore.getState().viewModes[session.id]).toBe('activity')
    expect(useAppStore.getState().sessions[0]).toBe(session)
    expect(useAppStore.getState().timelines[session.id]).toBe(timeline)
    expect(launchAgent).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('keeps concurrent launch events with their owned Region and replays only revisions after each baseline', async () => {
    const left = launcherTab('launcher-left')
    const right = launcherTab('launcher-right')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [left.id]: left, [right.id]: right },
      layouts: { workspace: createWorkspaceLayout('pane', [left.id, right.id]) },
      error: null
    })

    const pending = new Map<string, ReturnType<typeof deferred<AgentLaunchResult>>>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => {
      const operation = deferred<AgentLaunchResult>()
      pending.set(input.agentSessionId!, operation)
      return await operation.promise
    })

    const launchLeft = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: left.id,
      regionId: left.layout.activeRegionId
    })
    const launchRight = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: right.id,
      regionId: right.layout.activeRegionId
    })
    const leftSurface = titleWorkbenchSurface(useAppStore.getState().tabs[left.id]!)
    const rightSurface = titleWorkbenchSurface(useAppStore.getState().tabs[right.id]!)
    if (leftSurface.kind !== 'agent' || rightSurface.kind !== 'agent') {
      throw new Error('Expected concurrent Agent launch surfaces')
    }
    const leftSession = agentSession(leftSurface.sessionId)
    const rightSession = agentSession(rightSurface.sessionId)
    const leftItem = item(leftSession.id, 'left-1', 'left event')
    const rightItem = item(rightSession.id, 'right-1', 'right event')

    useAppStore.getState().applyEvent(timelineEvent(leftSession, 1, leftItem))
    useAppStore.getState().applyEvent(timelineEvent(rightSession, 1, rightItem))

    pending.get(leftSession.id)!.resolve({
      session: leftSession,
      timeline: { agentSessionId: leftSession.id, revision: 1, items: [leftItem] }
    })
    pending.get(rightSession.id)!.resolve({
      session: rightSession,
      timeline: { agentSessionId: rightSession.id, revision: 0, items: [] }
    })
    await Promise.all([launchLeft, launchRight])

    const state = useAppStore.getState()
    expect(state.timelines[leftSession.id]).toEqual({
      agentSessionId: leftSession.id,
      revision: 1,
      items: [leftItem]
    })
    expect(state.timelines[rightSession.id]).toEqual({
      agentSessionId: rightSession.id,
      revision: 1,
      items: [rightItem]
    })
    expect(state.pendingAgentLaunches).toEqual({})
    expect(titleWorkbenchSurface(state.tabs[left.id]!)).toMatchObject({ sessionId: leftSession.id })
    expect(titleWorkbenchSurface(state.tabs[right.id]!)).toMatchObject({ sessionId: rightSession.id })
  })

  it('replays stateful Agent events that arrive before the launch result is installed', async () => {
    const launcher = launcherTab('launcher-state-events')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'process-state',
        agentSessionId: session.id,
        run: session.control.run,
        state: 'exited',
        pid: null,
        exitCode: 7,
        evidence: { source: 'run-process', observedAt: 2, run: session.control.run }
      }
    })
    expect(useAppStore.getState().pendingAgentLaunches[session.id]?.events).toHaveLength(1)

    pending.resolve({
      session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }
    })
    await launched

    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({
      id: session.id,
      processState: 'exited',
      status: expect.objectContaining({ state: 'exited', exitCode: 7 })
    }))
  })

  it('removes a just-launched Session when its Run was removed before the result arrived', async () => {
    const launcher = launcherTab('launcher-removed')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'run-removed',
        agentSessionId: session.id,
        run: session.control.run,
        evidence: { source: 'run-process', observedAt: 2, run: session.control.run }
      }
    })

    pending.resolve({
      session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }
    })
    await launched

    expect(useAppStore.getState().sessions.some((candidate) => candidate.id === session.id)).toBe(false)
    expect(useAppStore.getState().tabs[launcher.id]).toBeUndefined()
  })

  it('converges initialization events against the snapshot baseline without duplicating included revisions', async () => {
    const session = agentSession('startup-session')
    const first = item(session.id, 'startup-1', 'included in snapshot')
    const second = item(session.id, 'startup-2', 'arrived during snapshot')
    const snapshot = deferred<RuntimeSnapshot>()
    let listener: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => await snapshot.promise)
    vi.spyOn(api.sessions, 'onEvent').mockImplementation((next) => {
      listener = next
      return () => { listener = null }
    })
    useAppStore.setState({ loading: true, restoredWorkbench: null })

    const initialized = useAppStore.getState().initialize()
    listener!(timelineEvent(session, 1, first))
    listener!(timelineEvent(session, 2, second))
    snapshot.resolve({
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [first] }
      },
      recoveryCandidates: []
    })

    const dispose = await initialized
    expect(useAppStore.getState().timelines[session.id]).toEqual({
      agentSessionId: session.id,
      revision: 2,
      items: [first, second]
    })
    dispose()
  })

  it('discovers an external Agent created during initialization from a canonical membership snapshot', async () => {
    const session = agentSession('external-startup-session')
    const first = item(session.id, 'external-1', 'included in membership snapshot')
    const second = item(session.id, 'external-2', 'arrived during membership snapshot')
    const initialSnapshot = deferred<RuntimeSnapshot>()
    const membershipSnapshot = deferred<RuntimeSnapshot>()
    let listener: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      .mockImplementationOnce(async () => await initialSnapshot.promise)
      .mockImplementationOnce(async () => await membershipSnapshot.promise)
    vi.spyOn(api.sessions, 'onEvent').mockImplementation((next) => {
      listener = next
      return () => { listener = null }
    })
    useAppStore.setState({ loading: true, restoredWorkbench: null })

    const initialized = useAppStore.getState().initialize()
    listener!(agentSessionEvent(session))
    initialSnapshot.resolve({ sessions: [], timelines: {}, recoveryCandidates: [] })
    const dispose = await initialized
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    listener!(timelineEvent(session, 2, second))
    membershipSnapshot.resolve({
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [first] }
      },
      recoveryCandidates: []
    })

    await vi.waitFor(() => expect(useAppStore.getState().timelines[session.id]).toEqual({
      agentSessionId: session.id,
      revision: 2,
      items: [first, second]
    }))
    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({
      id: session.id,
      control: session.control,
      updatedAt: 2
    }))
    dispose()
  })

  it('allows a later unknown Agent event to retry a failed membership snapshot', async () => {
    const session = agentSession('membership-retry-session')
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      .mockRejectedValueOnce(new Error('membership snapshot unavailable'))
      .mockResolvedValueOnce({
        sessions: [session],
        timelines: { [session.id]: { agentSessionId: session.id, revision: 0, items: [] } },
        recoveryCandidates: []
      })
    useAppStore.setState({
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      error: null
    })

    useAppStore.getState().applyEvent(agentSessionEvent(session))
    await vi.waitFor(() => expect(useAppStore.getState().error).toBe('membership snapshot unavailable'))
    useAppStore.getState().applyEvent(agentSessionEvent(session))

    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useAppStore.getState().sessions).toContainEqual(session))
  })

  it('keeps pending-launch events with their launch owner while membership resync overflows', async () => {
    const launcher = launcherTab('launcher-membership-overflow')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
      error: null
    })
    const launchResult = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await launchResult.promise)
    const firstMembership = deferred<RuntimeSnapshot>()
    const secondMembership = deferred<RuntimeSnapshot>()
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      .mockImplementationOnce(async () => await firstMembership.promise)
      .mockImplementationOnce(async () => await secondMembership.promise)

    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const pendingSession = agentSession(surface.sessionId)
    const pendingItem = item(pendingSession.id, 'pending-owned-1', 'launch-owned event')
    const externalSession = agentSession('external-membership-overflow')

    useAppStore.getState().applyEvent(agentSessionEvent(externalSession))
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: pendingSession.hostId,
      event: {
        type: 'process-state',
        agentSessionId: pendingSession.id,
        run: pendingSession.control.run,
        state: 'exited',
        pid: null,
        exitCode: 7,
        evidence: { source: 'run-process', observedAt: 2, run: pendingSession.control.run }
      }
    })
    useAppStore.getState().applyEvent(timelineEvent(pendingSession, 1, pendingItem))
    for (let revision = 1; revision <= 257; revision += 1) {
      useAppStore.getState().applyEvent(timelineEvent(
        externalSession,
        revision,
        item(externalSession.id, `external-overflow-${revision}`, `${revision}`)
      ))
    }
    expect(useAppStore.getState().pendingAgentLaunches[pendingSession.id]).toMatchObject({
      overflowed: false,
      events: expect.any(Array)
    })
    expect(useAppStore.getState().pendingAgentLaunches[pendingSession.id]?.events).toHaveLength(2)

    firstMembership.resolve({ sessions: [], timelines: {}, recoveryCandidates: [] })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    secondMembership.resolve({
      sessions: [externalSession],
      timelines: {
        [externalSession.id]: { agentSessionId: externalSession.id, revision: 257, items: [] }
      },
      recoveryCandidates: []
    })
    await vi.waitFor(() => expect(useAppStore.getState().sessions).toContainEqual(externalSession))
    launchResult.resolve({
      session: pendingSession,
      timeline: { agentSessionId: pendingSession.id, revision: 0, items: [] }
    })
    await launched

    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().pendingAgentLaunches[pendingSession.id]).toBeUndefined()
    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({
      id: pendingSession.id,
      processState: 'exited',
      status: expect.objectContaining({ state: 'exited', exitCode: 7 })
    }))
    expect(useAppStore.getState().timelines[pendingSession.id]).toEqual({
      agentSessionId: pendingSession.id,
      revision: 1,
      items: [pendingItem]
    })
  })

  it('does not let an older membership baseline remove a launch that settles while it is in flight', async () => {
    const launcher = launcherTab('launcher-stale-membership')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
      error: null
    })
    const launchResult = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await launchResult.promise)
    const membershipSnapshot = deferred<RuntimeSnapshot>()
    const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(
      async () => await membershipSnapshot.promise
    )

    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const launchingSurface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (launchingSurface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const launchedSession = agentSession(launchingSurface.sessionId)
    const response = item(launchedSession.id, 'settled-during-membership', 'ready')
    const externalSession = agentSession('stale-membership-trigger')

    useAppStore.getState().applyEvent(agentSessionEvent(externalSession))
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
    useAppStore.getState().applyEvent(agentSessionEvent(launchedSession))
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: launchedSession.hostId,
      event: {
        type: 'process-state',
        agentSessionId: launchedSession.id,
        run: launchedSession.control.run,
        state: 'exited',
        pid: null,
        exitCode: 0,
        evidence: { source: 'run-process', observedAt: 2, run: launchedSession.control.run }
      }
    })
    useAppStore.getState().applyEvent(timelineEvent(launchedSession, 1, response))
    launchResult.resolve({
      session: launchedSession,
      timeline: { agentSessionId: launchedSession.id, revision: 0, items: [] }
    })
    await launched
    expect(titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)).toMatchObject({
      kind: 'agent',
      phase: 'attached',
      sessionId: launchedSession.id
    })

    membershipSnapshot.resolve({
      sessions: [externalSession],
      timelines: {
        [externalSession.id]: { agentSessionId: externalSession.id, revision: 0, items: [] }
      },
      recoveryCandidates: []
    })
    await vi.waitFor(() => expect(useAppStore.getState().sessions).toContainEqual(externalSession))

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({
      id: launchedSession.id,
      processState: 'exited'
    }))
    expect(useAppStore.getState().timelines[launchedSession.id]).toEqual({
      agentSessionId: launchedSession.id,
      revision: 1,
      items: [response]
    })
    expect(titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)).toMatchObject({
      kind: 'agent',
      phase: 'attached',
      sessionId: launchedSession.id
    })
  })

  it('restarts initialization from a fresh snapshot when mixed events overflow the boot buffer', async () => {
    const session = agentSession('overflowed-startup-session')
    const firstSnapshot = deferred<RuntimeSnapshot>()
    const secondSnapshot = deferred<RuntimeSnapshot>()
    let snapshotCalls = 0
    let listener: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => {
      snapshotCalls += 1
      return await (snapshotCalls === 1 ? firstSnapshot.promise : secondSnapshot.promise)
    })
    vi.spyOn(api.sessions, 'onEvent').mockImplementation((next) => {
      listener = next
      return () => { listener = null }
    })
    useAppStore.setState({ loading: true, restoredWorkbench: null })

    const initialized = useAppStore.getState().initialize()
    listener!({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'run-removed',
        agentSessionId: session.id,
        run: session.control.run,
        evidence: { source: 'run-process', observedAt: 2, run: session.control.run }
      }
    })
    for (let index = 0; index < 256; index += 1) {
      listener!({
        type: 'core',
        hostId: session.hostId,
        event: {
          type: 'agent-status',
          agentSessionId: session.id,
          state: 'working',
          evidence: { source: 'native-hook', observedAt: 3 + index, run: session.control.run }
        }
      })
    }
    firstSnapshot.resolve({
      sessions: [session],
      timelines: { [session.id]: { agentSessionId: session.id, revision: 0, items: [] } },
      recoveryCandidates: []
    })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    secondSnapshot.resolve({ sessions: [], timelines: {}, recoveryCandidates: [] })

    const dispose = await initialized
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().timelines).toEqual({})
    dispose()
  })

  it('bounds launch-time buffering and requires a canonical resync after overflow', async () => {
    const launcher = launcherTab('launcher-overflow')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
      error: null
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)

    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    for (let revision = 1; revision <= 257; revision += 1) {
      useAppStore.getState().applyEvent(timelineEvent(
        session,
        revision,
        item(session.id, `overflow-${revision}`, `${revision}`)
      ))
    }
    expect(useAppStore.getState().pendingAgentLaunches[session.id]).toMatchObject({
      overflowed: true,
      events: expect.any(Array)
    })
    expect(useAppStore.getState().pendingAgentLaunches[session.id]?.events).toHaveLength(256)

    const canonicalSnapshot = deferred<RuntimeSnapshot>()
    const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(
      async () => await canonicalSnapshot.promise
    )
    const baseline = { agentSessionId: session.id, revision: 257, items: [] }
    pending.resolve({
      session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }
    })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
    const next = item(session.id, 'overflow-258', '258')
    const last = item(session.id, 'overflow-259', '259')
    useAppStore.getState().applyEvent(timelineEvent(session, 258, next))
    useAppStore.getState().applyEvent(timelineEvent(session, 259, last))
    canonicalSnapshot.resolve({
      sessions: [session],
      timelines: { [session.id]: baseline },
      recoveryCandidates: []
    })
    await launched

    expect(useAppStore.getState().pendingAgentLaunches[session.id]).toBeUndefined()
    expect(useAppStore.getState().timelines[session.id]).toEqual({
      agentSessionId: session.id,
      revision: 259,
      items: [next, last]
    })
  })

  it('preserves launch event order when a current Run exit is followed by a late old-Run event', async () => {
    const launcher = launcherTab('launcher-run-order')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'process-state',
        agentSessionId: session.id,
        run: session.control.run,
        state: 'exited',
        pid: null,
        exitCode: 7,
        evidence: { source: 'run-process', observedAt: 2, run: session.control.run }
      }
    })
    const staleRun = { runId: 'stale-run' }
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'process-state',
        agentSessionId: session.id,
        run: staleRun,
        state: 'running',
        pid: 99,
        evidence: { source: 'run-process', observedAt: 3, run: staleRun }
      }
    })
    pending.resolve({
      session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }
    })
    await launched

    expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({
      id: session.id,
      processState: 'exited',
      status: expect.objectContaining({ state: 'exited', exitCode: 7 })
    }))
  })

  it('replays an authoritative Run restart while rejecting stale and equal-version rebinds', async () => {
    const launcher = launcherTab('launcher-run-rebind')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) }
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    const rebound = {
      ...session,
      updatedAt: 3,
      control: {
        ...session.control,
        run: { runId: 'run:rebound' }
      }
    }
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'process-state',
        agentSessionId: session.id,
        run: session.control.run,
        state: 'exited',
        pid: null,
        exitCode: 0,
        evidence: { source: 'run-process', observedAt: 2, run: session.control.run }
      }
    })
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'agent-session',
        session: {
          kind: 'agent',
          agentSessionId: session.id,
          providerId: session.providerId,
          executorId: session.executorId,
          hostId: session.hostId,
          workspacePath: session.workspacePath,
          run: rebound.control.run,
          retiredRuns: [session.control.run],
          outputCursorBytes: 0,
          createdAt: 1,
          updatedAt: 3
        }
      }
    })
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'process-state',
        agentSessionId: session.id,
        run: rebound.control.run,
        state: 'running',
        pid: 101,
        evidence: { source: 'run-process', observedAt: 4, run: rebound.control.run }
      }
    })
    const response = item(session.id, 'rebound-response', 'new run response')
    useAppStore.getState().applyEvent(timelineEvent(rebound, 1, response))
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'agent-session',
        session: {
          kind: 'agent',
          agentSessionId: session.id,
          providerId: session.providerId,
          executorId: session.executorId,
          hostId: session.hostId,
          workspacePath: session.workspacePath,
          run: session.control.run,
          retiredRuns: [],
          outputCursorBytes: 0,
          createdAt: 1,
          updatedAt: 2
        }
      }
    })
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'agent-session',
        session: {
          kind: 'agent',
          agentSessionId: session.id,
          providerId: session.providerId,
          executorId: session.executorId,
          hostId: session.hostId,
          workspacePath: session.workspacePath,
          run: { runId: 'run:equal-version-conflict' },
          retiredRuns: [rebound.control.run],
          outputCursorBytes: 0,
          createdAt: 1,
          updatedAt: 4
        }
      }
    })
    const lateOldRunCommit = item(session.id, 'late-old-run-commit', 'committed at resume boundary')
    useAppStore.getState().applyEvent(timelineEvent(session, 2, lateOldRunCommit))
    pending.resolve({
      session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }
    })
    await launched

    expect(useAppStore.getState().sessions.find((candidate) => candidate.id === session.id)?.control.run)
      .toEqual(rebound.control.run)
    expect(useAppStore.getState().sessions.find((candidate) => candidate.id === session.id)?.processState)
      .toBe('running')
    expect(useAppStore.getState().timelines[session.id]).toEqual({
      agentSessionId: session.id,
      revision: 2,
      items: [response, lateOldRunCommit]
    })
  })

  it('surfaces failed cleanup and keeps the late Agent discoverable after its View closes', async () => {
    const launcher = launcherTab('launcher-cleanup')
    useAppStore.setState({
      config,
      sessions: [],
      timelines: {},
      pendingAgentLaunches: {},
      activeWorkspaceId: 'workspace',
      tabs: { [launcher.id]: launcher },
      layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
      error: null
    })
    const pending = deferred<AgentLaunchResult>()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async () => await pending.promise)
    const stop = vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('runtime owner unavailable'))
    const launched = useAppStore.getState().launchAgent('codex', '', 'pane', {
      tabId: launcher.id,
      regionId: launcher.layout.activeRegionId
    })
    const surface = titleWorkbenchSurface(useAppStore.getState().tabs[launcher.id]!)
    if (surface.kind !== 'agent') throw new Error('Expected an Agent launch surface')
    const session = agentSession(surface.sessionId)
    const baseline = { agentSessionId: session.id, revision: 0, items: [] }
    await useAppStore.getState().closeTab('workspace', 'pane', launcher.id)
    pending.resolve({ session, timeline: baseline })

    await expect(launched).rejects.toMatchObject({ code: 'AGENT_LAUNCH_CLEANUP_FAILED' })
    expect(stop).toHaveBeenCalledWith(session.control)
    expect(useAppStore.getState().sessions).toContainEqual(session)
    expect(useAppStore.getState().timelines[session.id]).toEqual(baseline)
    expect(useAppStore.getState().error).toContain('cleanup failed')
  })

  it('coalesces another gap during resync and never lets an older snapshot replace a newer revision', async () => {
    const session = agentSession('gap-session')
    const first = item(session.id, 'gap-1', 'one')
    const second = item(session.id, 'gap-2', 'two')
    const third = item(session.id, 'gap-3', 'three')
    const fourth = item(session.id, 'gap-4', 'four')
    useAppStore.setState({
      config,
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [first] }
      },
      pendingAgentLaunches: {},
      error: null
    })
    const firstResync = deferred<{ agentSessionId: string; revision: number; items: AgentTimelineItem[] }>()
    const secondResync = deferred<{ agentSessionId: string; revision: number; items: AgentTimelineItem[] }>()
    const timeline = vi.spyOn(api.sessions, 'timeline')
      .mockImplementationOnce(async () => await firstResync.promise)
      .mockImplementationOnce(async () => await secondResync.promise)

    useAppStore.getState().applyEvent(timelineEvent(session, 3, third))
    useAppStore.getState().applyEvent(timelineEvent(session, 2, second))
    useAppStore.getState().applyEvent(timelineEvent(session, 4, fourth))
    expect(useAppStore.getState().timelines[session.id]?.revision).toBe(2)

    firstResync.resolve({ agentSessionId: session.id, revision: 3, items: [first, second, third] })
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(2))
    secondResync.resolve({ agentSessionId: session.id, revision: 4, items: [first, second, third, fourth] })
    await vi.waitFor(() => expect(useAppStore.getState().timelines[session.id]?.revision).toBe(4))

    expect(useAppStore.getState().timelines[session.id]?.items).toEqual([first, second, third, fourth])
    expect(useAppStore.getState().error).toBeNull()
  })

  it('does not let an in-flight Timeline snapshot resurrect a removed Session', async () => {
    const session = agentSession('removed-during-timeline-resync')
    const first = item(session.id, 'removed-1', 'one')
    const third = item(session.id, 'removed-3', 'three')
    const timelineSnapshot = deferred<{
      agentSessionId: string
      revision: number
      items: AgentTimelineItem[]
    }>()
    const timeline = vi.spyOn(api.sessions, 'timeline').mockImplementation(
      async () => await timelineSnapshot.promise
    )
    useAppStore.setState({
      config,
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [first] }
      },
      pendingAgentLaunches: {},
      error: null
    })

    useAppStore.getState().applyEvent(timelineEvent(session, 3, third))
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(1))
    useAppStore.getState().applyEvent({
      type: 'core',
      hostId: session.hostId,
      event: {
        type: 'run-removed',
        agentSessionId: session.id,
        run: session.control.run,
        evidence: { source: 'run-process', observedAt: 4, run: session.control.run }
      }
    })
    timelineSnapshot.resolve({ agentSessionId: session.id, revision: 3, items: [first, third] })
    await timeline.mock.results[0]!.value
    await Promise.resolve()

    expect(useAppStore.getState().sessions).not.toContainEqual(session)
    expect(useAppStore.getState().timelines[session.id]).toBeUndefined()
  })
})
