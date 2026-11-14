import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxStoredAgentSession } from '@agentmux/core'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName, serializeMoteQuickMode } from '@agentmux/host/mote-model'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { inspectConversationConsumers } from '../../../src/renderer/src/lib/conversation-consumer-observation'
import { readingDraft, readingSessionId } from './source'

/** Finite startup facts only. Conversation results stay with the original public Reader. */
export async function mountReadingScene(container: HTMLElement, stored: AgentMuxStoredAgentSession, options: { unrelatedTabs?: number; mainSurface?: 'board' | 'workbench' } = {}) {
  const initial = useAppStore.getState(), originalConfig = await api.config.get()
  const prototype = (await api.sessions.snapshot()).sessions.find(value => value.kind === 'agent')!
  if (!prototype || prototype.kind !== 'agent') throw new Error('The private scene needs a typed Agent prototype')
  const writes: { method: string; args: unknown[] }[] = []
  const originals: (() => void)[] = []
  function port<T extends object, K extends keyof T>(object: T, key: K, value: T[K]) {
    const original = object[key]; object[key] = value; originals.push(() => { object[key] = original })
  }
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: stored.workspacePath.slice(0, -scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID).length - 1), name: 'Private reading topics', kind: 'folder' as const }
  const reference = { hostId: 'local', sessionId: readingSessionId, displayWorkspaceId: workspace.id,
    groupId: 'reading-original-group', tabId: 'reading-original-tab', regionId: 'reading-original-region' }
  const session = { ...prototype, id: readingSessionId, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: stored.workspacePath,
    label: 'Private original Mote', nativeHandle: stored.nativeHandle, nativeBinding: undefined, nativeSourceObservation: undefined, nativeConfirmation: undefined,
    processState: 'running' as const, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 },
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1, stateEnteredAt: 1 },
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: readingSessionId, run: stored.run } }
  const tab = { ...createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', regionId: reference.regionId, workspaceId: workspace.id, sessionId: readingSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
  const unrelatedWorkspace = { ...workspace, id: 'private-unrelated-workspace', path: workspace.path + '/unrelated', name: 'Unrelated retained work' }
  const unrelated = Array.from({ length: options.unrelatedTabs ?? 0 }, (_, index) => {
    const id = `private-unrelated-${index}`
    const agent = { ...session, id, workspacePath: unrelatedWorkspace.path, nativeHandle: undefined,
      control: { ...session.control, agentSessionId: id, run: { runId: id + '-run' } } }
    return { session: agent, tab: createWorkbenchTab(id + '-tab', { kind: 'agent', phase: 'attached', regionId: id + '-region', workspaceId: unrelatedWorkspace.id, sessionId: id }) }
  })
  const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: stored.workspacePath, topicPath: stored.workspacePath + '/topic.md', collaborators: [],
    quickMode: { status: 'saved' as const, version: 'private-reading-role', defaults: { conversation: reference } },
    soul: { path: stored.workspacePath + '/SOUL.md', content: '# Private reading identity', version: 'private-reading-soul' } }
  const spaceId = directoryIdentity('local', stored.workspacePath), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const main: MoteDialoguePage['main'] = { target, identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null,
    documentRevision: 'sha256:' + 'a'.repeat(64), roleRevision: 'private-reading-role', current: reference, issue: null }
  port(api.moteDialogue, 'read', async () => ({ main, links: [], incarnation: 'private-reading-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }))
  port(api.moteDialogue, 'inspectRecovery', async () => ({ operation: null }))
  port(api.moteDialogue, 'ensureRecovery', async input => ({ operation: { operationId: input.operationId, agentSessionId: readingSessionId,
    trigger: 'manual', previousRun: stored.run, policy: {}, admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'reattachable', reason: 'private-original-live',
    evidence: { kind: 'run-alive', observedAt: 1 }, moteMainEntry: { target: input.target, reference: input.reference, expectedRoleRevision: input.expectedRoleRevision } } }) as any)
  port(api.motePreferences, 'read', async () => ({ target, kind: 'quick', status: 'ready', source: { resource: { ...target.expectedResource, zoneId, zonePath: stored.workspacePath, path: 'MOTE.md' },
    result: { status: 'read', document: { path: 'MOTE.md', content: serializeMoteQuickMode('', { conversation: reference }), revision: 'sha256:' + 'a'.repeat(64) } } }, defaults: { conversation: reference },
    choices: { executors: [], conversations: [], destinations: [] }, main: true, maintenance: { status: 'unbound', schedule: null, issue: null }, issue: null }) as any)
  port(api.scratch, 'listTopics', async () => [topic]); port(api.scratch, 'readTopic', async () => topic); port(api.scratch, 'ensureMote', async () => topic)
  port(api.sessions, 'snapshot', async () => ({ sessions: [session, ...unrelated.map(item => item.session)], timelines: {}, recoveryCandidates: [] }))
  port(api.sessions, 'onEvent', () => () => {})
  port(api.sessions, 'refresh', async () => session)
  port(api.sessions, 'notifyInputOccupation', async () => {})
  port(api.sessions, 'attach', async control => {
    if (control.agentSessionId !== readingSessionId || control.run.runId !== stored.run.runId) throw new Error('Wrong private attachment')
    return { attachmentId: 'private-reading-attachment', session, currentSize: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [], gap: null } as any
  })
  port(api.sessions, 'refreshAttachment', control => api.sessions.attach(control))
  port(api.sessions, 'detach', async () => {})
  port(api.sessions, 'replay', async () => ({ replay: [], gap: null }))
  port(api.sessions, 'resize', async (_id, cols, rows) => ({ cols, rows }))
  for (const method of ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'write', 'paste', 'submitPrompt', 'respondInteraction', 'replyQuestion'] as const) {
    port(api.sessions, method, (async (...args: unknown[]) => { writes.push({ method, args }); throw new Error('Reading must not dispatch ' + method) }) as any)
  }
  port(api.demands, 'list', async () => []); port(api.continuousProgress, 'goals', async () => []); port(api.continuousProgress, 'list', async () => [])
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null, railMode: 'avatars' }))
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: { ...originalConfig, hosts: originalConfig.hosts.filter(value => value.id === 'local'), workspaces: [workspace, ...(unrelated.length ? [unrelatedWorkspace] : [])] },
    sessions: [session, ...unrelated.map(item => item.session)], timelines: {}, activeWorkspaceId: workspace.id, mainSurface: options.mainSurface ?? 'board', projectRailOpen: false, toolsOpen: false,
    tabs: Object.fromEntries([tab, ...unrelated.map(item => item.tab)].map(item => [item.id, item])),
    layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [tab.id]), ...(unrelated.length ? { [unrelatedWorkspace.id]: createWorkspaceLayout('private-unrelated-group', unrelated.map(item => item.tab.id)) } : {}) },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics: [topic], error: null, reading: false } },
    viewModes: Object.fromEntries([session, ...unrelated.map(item => item.session)].map(item => [item.id, 'activity'])), agentComposerDrafts: { [readingSessionId]: readingDraft },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  const root = createRoot(container)
  root.render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
  const panel = () => document.getElementById('pmo-teams-topic-floating-panel')!
  return { root, reference, target, session, panel,
    open() { const trigger = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button'); if (!trigger) throw new Error('Original Mote launcher absent'); trigger.click() },
    hide() { const close = panel().querySelector<HTMLButtonElement>('[aria-label="Close Mote"]'); if (!close) throw new Error('Original Mote close absent'); close.click() },
    feed() { return panel().querySelector<HTMLElement>('.activity-feed')! },
    facts() { const state = useAppStore.getState(); return { writes: structuredClone(writes), reference, target, control: state.sessions.find(value => value.id === readingSessionId)?.control,
      consumers: inspectConversationConsumers({ hostId: 'local', agentSessionId: readingSessionId }).consumers,
      drafts: state.agentComposerDrafts, mainSurface: state.mainSurface, primaryVisible: [...document.querySelectorAll<HTMLElement>('.agent-surface:not([data-session-presentation])')].some(value => !panel()?.contains(value) && value.checkVisibility?.() && !value.closest('[hidden],[inert],[aria-hidden="true"]')),
      panelOpen: panel()?.matches(':popover-open') ?? false, nativeIds: [...(panel()?.querySelectorAll<HTMLElement>('[data-native-record-id]') ?? [])].map(value => value.dataset.nativeRecordId) } },
    close() { requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); root.unmount(); useAppStore.setState(initial, true); for (const restore of originals.reverse()) restore() }
  }
}
