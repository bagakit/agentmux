import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { EMPTY_AGENT_FOCUS } from '../../../src/renderer/src/lib/agent-focus'
import { goalExplorationPending } from '../../../src/renderer/src/lib/goals-entry-actions'
import { directGoalRequest } from '../../../src/renderer/src/lib/goals-direct-pmo'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import type { SessionSnapshot, AgentLaunchInput } from '../../../src/shared/contracts'

// Capture the existing preview transport before the shared entry overrides Config save.
const saveConfig = api.config.save, launch = api.sessions.launchAgent, ensure = api.scratch.ensureMote
/** Preview DTOs only. Actual Main notes, delivery and restart have separate owning/native proof. */
export function mainMotePreview(initial: ReturnType<typeof useAppStore.getState>, render: () => void) {
  const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/preview/main-mote', kind: 'folder' as const }
  const original: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id: 'main-mote-original-agent', kind: 'agent', label: '原主 bot', hostId: 'local', workspacePath: `${scratch.path}/${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}`,
    providerId: 'claude', executorId: 'codex-2', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'main-mote-original-agent', run: { runId: 'main-mote-original-run' } }
  }
  const primary = { ...createWorkbenchTab('main-mote-original-tab', { kind: 'agent', phase: 'attached', regionId: 'main-mote-original-region', workspaceId: scratch.id, sessionId: original.id }), topicId: PMO_TEAMS_TOPIC_ID, name: '原来的讨论' }
  const requests: AgentLaunchInput[] = [], preparations: string[] = []
  const history = new Map<string, string>()
  let failLaunch = false
  async function seed(mode?: 'cold' | 'unknown') {
    if (directGoalRequest() || goalExplorationPending()) throw new Error('Settle the original request before preview reseeding')
    requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requests.length = 0; preparations.length = 0; history.clear(); failLaunch = false
    const config = { ...initial.config!, workspaces: [...initial.config!.workspaces.filter(item => item.id !== scratch.id).map(item => ({ ...item, path: item.path.startsWith('/') ? item.path : `/preview/${item.path}` })), scratch],
      appearance: { ...initial.config!.appearance, appAppearance: 'light' as const }, executors: {
        wrong: { label: '另一位 Agent', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true },
        'codex-2': { label: '原主 bot', providerId: 'claude', command: '/preview/original-claude', args: ['--original'], env: {}, injectAgentMuxGuide: false }
      } }
    if (mode === 'cold') { config.workspaces = [scratch]; delete (config.executors as Partial<typeof config.executors>).wrong }
    useLauncherState.setState({ sections: {}, executors: {}, persistenceIssue: null })
    await saveConfig(config, await api.config.get())
    await ensure(scratch.id, PMO_TEAMS_TOPIC_ID)
    const snapshot = await api.scratch.renameTitle(scratch.id, PMO_TEAMS_TOPIC_ID, '我的主 Mote')
    api.scratch.ensureMote = async (workspaceId, topicId) => { preparations.push(topicId); return ensure(workspaceId, topicId) }
    api.sessions.launchAgent = async input => {
      requests.push(structuredClone(input)); if (failLaunch) throw new Error('启动回执尚未确认。目标、原 Tab 和请求都已保留。')
      const receipt = await launch(input)
      if (!receipt.session) throw new Error('The preview transport did not return its Session projection')
      const session = receipt.session
      const path = input.scratchTopicId ? `${scratch.path}/${scratchTopicDirectoryName(input.scratchTopicId)}` : input.workspacePath
      // The preview transport reflects Main's real resolved Topic-directory fact.
      session.workspacePath = path; receipt.created.workspacePath = path
      history.set(session.id, input.prompt ?? '')
      return receipt
    }
    api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: control.agentSessionId }, nextCursor: null,
      items: history.has(control.agentSessionId) ? [
        { id: `${control.agentSessionId}-request`, kind: 'user-message', startedAt: 1, contentParts: [{ kind: 'text', text: history.get(control.agentSessionId)! }] },
        { id: `${control.agentSessionId}-answer`, kind: 'assistant-message', startedAt: 2, contentParts: [{ kind: 'text', text: '我们继续在这次讨论中梳理你的目标。你可以先说说现在最想了解的事情。' }] }
      ] : [] })
    api.sessions.observeHistory = async control => ({ source: { providerId: 'claude', nativeSessionId: control.agentSessionId }, dispose() {} })
    flushSync(() => {
      useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false, config, mainSurface: 'board', activeWorkspaceId: null,
        sessions: [...initial.sessions.map(session => ({ ...session, workspacePath: session.workspacePath.startsWith('/') ? session.workspacePath : `/preview/${session.workspacePath}` })), ...(mode ? [] : [original])], tabs: mode === 'cold' ? {} : { [primary.id]: primary }, layouts: { [scratch.id]: createWorkspaceLayout('main-mote-group', mode === 'cold' ? [] : [primary.id]) },
        agentFocus: { ...EMPTY_AGENT_FOCUS, pmo: { sessionId: mode === 'cold' ? null : original.id } }, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), topics: [snapshot], revision: 1, error: null, reading: false } },
        demands: {}, selectedDemandId: null, demandPmoTabIds: {}, pendingAgentLaunches: {}, agentComposerDrafts: {}, error: null, lastError: null, errorNoticeContext: null,
        viewModes: { [original.id]: 'activity' }, retainedSpatialFocus: null, recoveryCandidates: [], runtimeOwnershipWarnings: [] })
      render()
    })
  }
  return { seed, failLaunch: (fail: boolean) => { failLaunch = fail }, facts: () => {
    const state = useAppStore.getState(), floating = readPmoTeamsTopicFloatingState(), target = floating?.targetTabId ? state.tabs[floating.targetTabId] : undefined
    return { topicId: target?.topicId, tabId: target?.id, region: target?.regions[target.layout.activeRegionId], tabName: target?.name,
      original: state.sessions.find(item => item.id === original.id), primaryTab: state.tabs[primary.id], requests, preparations, floating,
      goals: state.demands, mapping: state.demandPmoTabIds, draft: target ? state.agentComposerDrafts[target.layout.activeRegionId] : undefined,
      pending: goalExplorationPending(), directRequest: directGoalRequest() }
  } }
}
