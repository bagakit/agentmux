import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentProviderRegistry, type AgentMuxAgentSession, type AgentMuxHeadlessRuntime } from '@agentmux/core'
import { AgentMuxHostExecutorOwner } from '../../../../packages/core/src/executor-owner'
import { AgentMuxCreationAuthority } from '../../../../packages/core/src/agent-creation-authority'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../../../host/src/mote-resources'
import { api } from '../../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { useAppStore, prepareRendererUpdate } from '../../src/renderer/src/store'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { injectedContextCore } from './injected-context-core'
import { openHostGoalTransport } from './host-goal-transport'

/** Actual Host discussion, public spatial creation, Core input and stores; only Native I/O is controlled. */
export async function openHostGoalDiscussionFixture(config: AppConfig) {
  let core: Awaited<ReturnType<typeof injectedContextCore>>
  const owner: ReturnType<AgentMuxHeadlessRuntime['ownerIdentity']> = {
    runtimeId: 'private-goal-discussion-runtime', ownerInstanceId: 'private-goal-discussion-owner',
    processId: process.pid, protocolVersion: 2, availability: 'connected', ctxmux: null
  }
  const host = await openHostGoalTransport({ config: () => useAppStore.getState().config,
    runtime: () => ({ client: core.core, ownerIdentity: () => owner }) as AgentMuxHeadlessRuntime })
  const coreRoot = join(host.directory, 'core'), scratchRoot = join(host.directory, 'scratch')
  await mkdir(coreRoot); await mkdir(scratchRoot)
  const listenerAsset = process.env.AGENTMUX_PRIVATE_LISTENER_ASSET
  const runtimeId = owner.runtimeId!
  const executors = new AgentMuxHostExecutorOwner({ path: join(coreRoot, 'executors.json'), runtimeId, catalog: () => core.core.catalog() })
  core = await injectedContextCore(coreRoot, undefined, () => ({ hostExecutorOwner: executors,
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(coreRoot, 'creation-authority'), runtimeId }) }))
  if (listenerAsset) vi.stubEnv('AGENTMUX_PRIVATE_LISTENER_ASSET', listenerAsset)
  // Rendering readiness is controlled Native evidence; all input admission and receipts remain Core-owned.
  vi.spyOn((core.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const scratch = { ...config.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)!, path: scratchRoot }
  const executorId = Object.keys(config.executors)[0]!
  // The fixture owns Native I/O. Avoid probing the developer's installed Codex or selecting its live actor carrier.
  const executor = { ...config.executors[executorId]!, command: process.execPath }
  const actualConfig = { ...config, executors: { ...config.executors, [executorId]: executor },
    workspaces: config.workspaces.map(workspace => workspace.id === SCRATCH_WORKSPACE_ID ? scratch : workspace) }
  const topic = await new ScratchTopics().ensure(scratch, PMO_TEAMS_TOPIC_ID)
  await executors.configure({ executorId, config: executor })
  const primary = await core.core.createAgent({ agentSessionId: 'primary', providerId: executor.providerId, executorId,
    workspacePath: topic.physicalDirectoryPath!, createOperationId: 'fixture-primary', injectAgentMuxGuide: false })
  function snapshot(session: AgentMuxAgentSession): Extract<SessionSnapshot, { kind: 'agent' }> {
    return { id: session.agentSessionId, kind: 'agent', providerId: session.providerId, executorId: session.executorId, hostId: 'local',
      workspacePath: session.workspacePath, label: executor.label, createdAt: session.createdAt, updatedAt: session.updatedAt, agentSessionUpdatedAt: session.updatedAt,
      processState: 'running', status: { state: 'working', source: 'run-process', observedAt: session.updatedAt }, latestOutputBytes: 0,
      capabilities: new AgentProviderRegistry().get(session.providerId).catalog.capabilities,
      control: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } }
  }
  const primaryTab = { ...createWorkbenchTab('primary-tab', { kind: 'agent', phase: 'attached', regionId: 'primary-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: primary.agentSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState(state => ({ config: actualConfig, sessions: [...state.sessions.filter(session => session.id !== 'primary'), snapshot(primary)],
    tabs: { ...state.tabs, [primaryTab.id]: primaryTab }, layouts: { ...state.layouts,
      [SCRATCH_WORKSPACE_ID]: state.layouts[SCRATCH_WORKSPACE_ID] ?? createWorkspaceLayout('fixture-mote-group', [primaryTab.id]) }, scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
      [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], reading: false, error: null } } }))
  await host.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), [topic]) })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => host.spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => host.spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => host.spatial.subscribe(listener))
  vi.spyOn(api.config, 'get').mockImplementation(async () => useAppStore.getState().config!)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
  const stopEvents = core.core.onEvent(event => {
    if (event.type !== 'agent-session') return
    useAppStore.setState(state => ({ sessions: [...state.sessions.filter(session => session.id !== event.session.agentSessionId), snapshot(event.session)] }))
  })
  const prepared = useAppStore.getState()
  const disposeRenderer = await prepared.initialize()
  // The test starts after bootstrap; preserve the exact pre-operation presentation objects.
  useAppStore.setState({ config: prepared.config, tabs: prepared.tabs, layouts: prepared.layouts, sessions: prepared.sessions,
    demands: prepared.demands, selectedDemandId: prepared.selectedDemandId, mainSurface: prepared.mainSurface,
    agentFocus: prepared.agentFocus, activeWorkspaceId: prepared.activeWorkspaceId, scratchTopicSnapshots: prepared.scratchTopicSnapshots })
  return { host, core, topic, primary, async dispose() {
    const failures: unknown[] = []
    try { await prepareRendererUpdate() } catch (error) { failures.push(error) }
    disposeRenderer(); stopEvents()
    try { await host.dispose(() => core.dispose()) } catch (error) { failures.push(error) }
    vi.unstubAllEnvs()
    if (failures.length) throw new AggregateError(failures, 'Private Goal discussion fixture cleanup failed: ' + failures.map(String).join('; '))
  } }
}
