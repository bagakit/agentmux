import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// Real App/Store/persistence and close entry. Only private preview host facts are controlled;
// no Agent/Native/CLI is started, stopped, retired or given input.
const snapshot = await api.sessions.snapshot()
const selected = snapshot.sessions.filter(s => s.kind === 'agent').slice(0, 2)
if (selected.length !== 2) throw new Error('Preview requires two nonempty original Agent facts')
const stopped = { ...selected[0]!, processState: 'exited' as const, label: 'Stopped investigation — retain original Session, history and unsent draft' }
// Both controlled preview Sessions belong to this private workspace. Cross-host placement
// would rightly be removed by the original verified durable restore.
const healthy = { ...selected[1]!, hostId: stopped.hostId, workspacePath: stopped.workspacePath, control: { ...selected[1]!.control, hostId: stopped.hostId }, processState: 'running' as const, label: 'Original healthy sibling — leave this work and its draft intact' }
api.sessions.snapshot = async () => ({ ...snapshot, sessions: [stopped, healthy] })
const records: unknown[] = [], recovery: unknown[] = [], attachment: unknown[] = [], submissions: unknown[] = []
const current = (control: typeof stopped.control) => useAppStore.getState().sessions.find(s => s.id === (control.kind === 'agent' ? control.agentSessionId : control.runId)) ?? [stopped, healthy].find(s => s.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))!
api.sessions.recover = async control => { recovery.push(structuredClone(control)); return structuredClone(current(control)) }
api.sessions.refresh = async control => structuredClone(current(control))
const attach = api.sessions.attach
api.sessions.attach = async (...args) => { attachment.push(structuredClone(args[0])); return { ...await attach(...args), session: structuredClone(current(args[0])) } }
api.sessions.submitPrompt = async (...args) => { submissions.push(structuredClone(args)); throw new Error('This close-only fixture grants no message execution') }
let pending = false, release: (() => void) | undefined
api.sessions.stop = async control => { records.push(structuredClone(control)); if (pending) await new Promise<void>(resolve => { release = resolve }) }
api.ui.requestStorageFlush = async () => {}
const root = createRoot(document.getElementById('root')!); flushSync(() => root.render(<App />))
while (useAppStore.getState().loading || !useAppStore.getState().config) await new Promise(resolve => setTimeout(resolve, 10))
const workspace = useAppStore.getState().config!.workspaces[0]!
// Preserve the initialized empty layouts of other configured preview workspaces too.
const originalLayouts = structuredClone(useAppStore.getState().layouts)
const view = createWorkbenchTab('closed-target', { kind: 'agent', regionId: 'closed-region', phase: 'attached', workspaceId: workspace.id, sessionId: stopped.id })
const sibling = createWorkbenchTab('retained-sibling', { kind: 'agent', regionId: 'retained-region', phase: 'attached', workspaceId: workspace.id, sessionId: healthy.id })
const layout = moveTabToNewGroup(createWorkspaceLayout('close-group', [view.id, sibling.id]), sibling.id, 'close-group', 'close-group', 'right', 'sibling-group')
const drafts = { [stopped.id]: 'Original stopped-session unsent draft remains', [healthy.id]: 'Original sibling unsent draft remains' }
const unknownInput = { operationId: 'original-unknown-operation', runId: stopped.control.run.runId, text: 'Private synthetic unconfirmed input', status: 'sending' as const, promptCondition: { expectedRun: stopped.control.run, afterSubmissionId: null } }
const warning = 'Saving the workbench is unconfirmed. The current Chromium local storage database directory is absent.'
const probe = {
 show(mode: 'exited' | 'pending') {
  release?.(); release = undefined; pending = mode === 'pending'; records.length = 0
  flushSync(() => useAppStore.setState({ sessions: [{ ...stopped, processState: pending ? 'running' : 'exited' }, healthy], tabs: { [view.id]: view, [sibling.id]: sibling },
   layouts: { ...originalLayouts, [workspace.id]: layout }, activeWorkspaceId: workspace.id, mainSurface: 'workbench', projectRailOpen: false, toolsOpen: false,
   closingWorkbenchViews: {}, agentComposerDrafts: drafts, agentSteerQueues: { [stopped.id]: [unknownInput] }, agentSteerInFlight: {},
   workbenchSaveWarning: mode === 'exited' ? warning : null, error: null, lastError: null, errorNoticeContext: null }))
  return probe.facts()
 },
 facts() { const s = useAppStore.getState(); return { tabs: s.tabs, layouts: s.layouts, sessions: s.sessions.map(x => ({ id: x.id, control: x.control, processState: x.processState })),
   drafts: s.agentComposerDrafts, queue: s.agentSteerQueues, closing: Object.keys(s.closingWorkbenchViews), error: s.error, saveWarning: s.workbenchSaveWarning, records, recovery, attachment, submissions } },
 raw() { const raw = localStorage.getItem('agentmux-workbench-v1'); if (!raw) throw new Error('Nonempty Chromium workbench required'); return JSON.parse(raw).state },
 async prepareQuit() { release?.(); await prepareRendererUpdate('quit'); return probe.raw() },
 target: view.id, sibling: sibling.id, stoppedId: stopped.id, healthyId: healthy.id, expectedDrafts: drafts, unknownInput, restoredUnknownInput: { ...unknownInput, status: 'deferred', error: 'Queued before restart. Choose Send to execute this message.', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' }
}
Object.assign(window, { stoppedViewClose: probe })
