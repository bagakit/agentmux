import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import React from 'react'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { AppConfig, SessionSnapshot, AgentLaunchResult } from '../../../src/shared/contracts'

const config: AppConfig = { version: 9, hosts: [{ id: 'local', label: 'This Mac', kind: 'local' }],
  executors: { codex: { label: 'Code reviewer', providerId: 'codex', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false }, claude: { label: 'Writing partner', providerId: 'claude', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'project', name: 'Recovery work', path: _hygiene_fixturePath("private-fixture/project"), hostId: 'local', kind: 'folder' }, { id: SCRATCH_WORKSPACE_ID, name: 'No Project', path: _hygiene_fixturePath("private-fixture/scratch"), hostId: 'local', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const originalId = 'retained-original-session-7B2a', moteId = 'selected-review-mote'
function session(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("private-fixture/project"), label: 'Code reviewer',
    promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, createdAt: Date.now() - 7200000, updatedAt: Date.now() - 3600000, latestOutputBytes: 0, processState: 'running',
    status: { state: 'waiting', source: 'native-hook', observedAt: 1 }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'private-run:' + id } } }
}
export async function initializeRecoveryScene() {
  api.config.get = async () => config; api.providers.list = async () => []; api.demands.list = async () => []
  api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
  api.ui.requestStorageFlush = async () => undefined
  api.sessions.historyPage = async () => ({ source: 'unavailable', items: [], reason: 'native-handle-unavailable' } as never)
  api.sessions.timeline = async reference => ({ agentSessionId: reference.agentSessionId, revision: 0, items: [] })
  api.sessions.launchAgent = async () => { throw new Error('Private fixture: creation reply was lost.') }
  api.sessions.submitPrompt = async () => { await new Promise<void>(resolve => { Object.assign(window, { __releaseRecoveryAnalysis: resolve }) }) }
  api.sessions.refresh = async control => useAppStore.getState().sessions.find(item => item.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))!
  api.continuousProgress.pauseForInput = async () => undefined
  api.sessions.creation = async () => { throw new Error('Private fixture: original Core creation read is unavailable.') }
  api.scratch.listTopics = async () => [{ id: 'design-review-mote', title: 'Design review', summary: '', collaborators: [], directoryPath: 'design-review', topicPath: 'design-review/topic.md', soul: { path: 'design-review/SOUL.md', content: 'Review work', version: 'v1' } }]
  await useAppStore.getState().initialize()
  const original = { ...session(originalId), processState: 'exited' as const, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1, continuity: 'unavailable' as const, continuityReason: 'native-handle-unavailable' as const } }
  const sourceTab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'project', sessionId: originalId })
  const target = { ...createWorkbenchTab('review-mote-tab', { regionId: 'review-mote-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: moteId }), topicId: 'design-review-mote' }
  useAppStore.setState({ config, sessions: [original, session(moteId)], tabs: { [sourceTab.id]: sourceTab, [target.id]: target }, layouts: { project: createWorkspaceLayout('original-group', ['original-tab']), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['review-mote-tab']) },
    activeWorkspaceId: 'project', mainSurface: 'workbench', viewModes: { [originalId]: 'terminal' }, spatialRequests: {}, timelines: {}, agentSteerQueues: {}, pendingAgentLaunches: {}, recoveryCandidates: [],
    agentNames: { [originalId]: 'Original implementation work', [moteId]: 'Review partner' }, agentComposerDrafts: { [originalId]: 'Keep the original unsent thought.', [moteId]: 'Keep the Mote draft.' },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("private-fixture/scratch")]), revision: 0, reading: false, error: null, topics: await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) } } })
}
export function recoveryScene() { return <DesktopClientUiProvider><SessionPane sessionId={originalId} surfaceKind="agent" visible interactiveResize={false} linkOrigin={{ workspaceId: 'project', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} /></DesktopClientUiProvider> }

/** The new branches retain an exact original reference and reuse the qualified dialogs. */
export function setUnobservedRecoveryScene(mode: 'connecting' | 'created') {
  const original = session(originalId)
  const created: AgentLaunchResult['created'] = { kind: 'agent', hostId: 'local', agentSessionId: originalId, run: original.control.run,
    providerId: original.providerId, executorId: original.executorId, workspacePath: original.workspacePath, retiredRuns: [], createdAt: original.createdAt, updatedAt: original.updatedAt,
    creation: { createOperationId: 'original-create-operation', initialPrompt: 'confirmed' } }
  useAppStore.setState(state => ({ sessions: state.sessions.filter(item => item.id !== originalId),
    recoveryCandidates: mode === 'connecting' ? [{ agentSessionId: originalId, hostId: 'local', workspacePath: original.workspacePath, providerId: original.providerId, executorId: original.executorId, capabilities: original.capabilities, label: original.label, createdAt: original.createdAt, updatedAt: original.updatedAt, run: original.control.run }] : [],
    pendingAgentLaunches: mode === 'created' ? { [originalId]: { request: { executorId: 'codex', hostId: 'local', workspacePath: original.workspacePath, prompt: 'Original submitted request' }, events: [], overflowed: false, created,
      projectionFailures: [{ step: 'session', message: 'The original Host did not return current Session facts.' }] } } : {} }))
}
