import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../../lib/fixture-values.mjs'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// The complete production App, original Store, notification owners, terminal and CSS run here.
// Only preview API ports and exact observation facts are controlled; no user Run is reached.
const initialConfig = await api.config.get()
const previewPath = fixturePath('notification-preview-project')
await api.config.save({ ...initialConfig, workspaces: initialConfig.workspaces.map(workspace => ({ ...workspace, path: previewPath })) }, initialConfig)
const seedSnapshot = await api.sessions.snapshot()
const originals = seedSnapshot.sessions.filter(session => session.kind === 'agent').slice(0, 2).map(session => ({ ...session, workspacePath: previewPath }))
if (originals.length !== 2) throw new Error('The original preview must provide two real-shaped Agent snapshots.')
api.sessions.onEvent = () => () => {}
api.sessions.snapshot = async () => ({ sessions: originals, timelines: {}, recoveryCandidates: [] })
api.continuousProgress.list = async () => []
api.sessions.notifyInputOccupation = async () => {}
const connectionCall = api.connections.call
api.connections.call = (async (method, input) => method === 'connection.binding.ls'
  ? { bindings: [] } : connectionCall(method, input as never)) as typeof api.connections.call
const writes: unknown[] = [], notices: unknown[] = []
api.sessions.write = async (...args) => { writes.push(args) }
api.sessions.paste = async (...args) => { writes.push(args) }
api.ui.notifyAgentAttention = async input => { notices.push(input); return { kind: 'shown' } as never }
const trustedEvents: unknown[] = []
for (const type of ['click', 'input', 'keydown']) document.addEventListener(type, event => {
  const target = event.target as HTMLElement
  trustedEvents.push({ type, trusted: event.isTrusted, label: target.getAttribute('aria-label') || target.textContent?.trim().slice(0, 120) })
}, true)
const tabId = 'notification-workface', regionId = 'notification-primary', neighborId = 'notification-neighbor'
let workspaceId = '', seeded = false
function sessions(count: number, problems: boolean) {
  return Array.from({ length: count }, (_, index) => {
    const base = originals[index % originals.length]!, id = index < 2 ? originals[index]!.id : `notice-agent-${index}`
    const run = index < 2 ? base.control.run : { runId: `notice-run-${index}` }
    return { ...base, id, hostId: 'local', label: ['Design review', 'Implementation', 'API contract', 'Regression suite', 'Documentation', 'Runtime audit'][index % 6] + (index > 5 ? ` ${Math.floor(index / 6) + 1}` : ''),
      control: { kind: 'agent' as const, hostId: 'local', agentSessionId: id, run }, processState: 'running' as const,
      status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() },
      semanticStatus: undefined, nativeService: undefined, terminalCapability: undefined, terminalPromptDelivery: undefined,
      ...(problems ? {
        creation: { createOperationId: `create-${id}`, initialPrompt: 'unknown' as const, agentMuxContext: 'confirmed' as const, intentDigest: `intent-${id}` },
        nativeSourceObservation: { state: 'unknown' as const, run, observedAt: Date.now() - 180000, reason: 'current-main-unconfirmed' },
        timelineObservation: { run, code: 'HISTORY_UNAVAILABLE', message: 'The previous history request did not complete. Original Session and saved history are retained.' }
      } : { creation: undefined, nativeSourceObservation: undefined, timelineObservation: undefined }) }
  })
}
const scene = {
  ready: true, writes, notices, trustedEvents,
  initialized() { return !useAppStore.getState().loading },
  seed(noisy = false) {
    const state = useAppStore.getState()
    workspaceId = state.config!.workspaces[0]!.id
    const agents = sessions(noisy ? 32 : 2, noisy)
    let tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: agents[0]!.id })
    tab = addWorkbenchRegion(tab, regionId, 'right', { regionId: neighborId, kind: 'agent', phase: 'attached', workspaceId, sessionId: agents[1]!.id })
    flushSync(() => useAppStore.setState({ sessions: agents as never, tabs: { [tabId]: tab },
      layouts: { [workspaceId]: createWorkspaceLayout('notification-group', [tabId]) },
      activeWorkspaceId: workspaceId, mainSurface: 'workbench', retainedSpatialFocus: null,
      agentNames: Object.fromEntries(agents.map(agent => [agent.id, agent.label])),
      viewModes: Object.fromEntries(agents.map(agent => [agent.id, 'terminal'])),
      agentComposerDrafts: { [agents[0]!.id]: 'Keep this original unsent design note.', [agents[1]!.id]: 'Independent implementation draft.' },
      pendingAgentLaunches: {}, notificationEvents: [], noticeReadReceipts: {}, error: null, lastError: null, errorNoticeContext: null,
      runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [],
      environmentWarning: noisy ? 'Shell startup scripts did not finish. Existing Agents keep their original environment.' : undefined,
      sessionNameMetadataWarning: noisy ? { code: 'NAME_STORE_UNAVAILABLE', message: 'The latest saved names could not be confirmed.', recovery: 'Restore storage access and retry reading names.' } : null,
      workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null } as never))
    seeded = true
  },
  activateNoise() {
    if (!seeded) throw new Error('Retained original workface must exist before passive observations.')
    flushSync(() => useAppStore.setState({ sessions: sessions(32, true) as never,
      environmentWarning: 'Shell startup scripts did not finish. Existing Agents keep their original environment.',
      sessionNameMetadataWarning: { code: 'NAME_STORE_UNAVAILABLE', message: 'The latest saved names could not be confirmed.', recovery: 'Restore storage access and retry reading names.' } as never }))
  },
  events() {
    const state = useAppStore.getState()
    state.reportError('The requested file could not be saved. Your original text remains available.', { kind: 'process-degraded', summary: 'Saving the review note did not complete' })
    state.reportError('The original Run exited with a confirmed failure. The Session and output remain available.', { kind: 'agent-broken', summary: 'Agent process exited', subject: state.sessions[1]!.control })
    state.reportError('Operation receipt is unavailable. Do not replay the operation until its original receipt is checked.', { kind: 'indeterminate', summary: 'Operation result is unconfirmed' })
    state.reportError('The system accepted the requested observation refresh.', { kind: 'healthy', summary: 'Observation refresh completed' })
    const detail = 'Original protocol diagnostic.\n' + Array.from({ length: 55 }, (_, index) => `Evidence line ${index + 1}: the same original request remains available for review.`).join('\n') + '\nFINAL ORIGINAL RECEIPT'
    state.reportError(detail, { kind: 'indeterminate', summary: 'The original history request needs review' })
    const delivery = { kind: 'process-degraded' as const, summary: 'Desktop banner duration is controlled by the platform',
      event: { source: 'desktop-notifications', key: 'duration-presentation', object: { kind: 'application' as const, id: 'desktop' } } }
    state.reportError('The requested duration is unavailable on this platform. The notification center remains available.', delivery)
    state.reportError('The same original platform limit was observed by the second notification consumer.', delivery)
  },
  newEvent() { useAppStore.getState().reportError('A later operation has its own retained receipt.', { summary: 'A new operation needs review', kind: 'indeterminate' }) },
  resolveAndRecur() {
    const original = useAppStore.getState().environmentWarning
    // Empty string is a confirmed healthy owner observation; undefined means unavailable.
    flushSync(() => useAppStore.setState({ environmentWarning: '' }))
    flushSync(() => useAppStore.setState({ environmentWarning: original }))
  },
  surface() {
    const state = useAppStore.getState()
    return structuredClone({ tab: state.tabs[tabId], layout: state.layouts[workspaceId], activeWorkspaceId: state.activeWorkspaceId,
      drafts: state.agentComposerDrafts, visibleSessions: state.sessions.slice(0, 2).map(session => ({ id: session.id, control: session.control, processState: session.processState })) })
  },
  facts() {
    const state = useAppStore.getState()
    return { surface: scene.surface(), events: state.notificationEvents, receipts: state.noticeReadReceipts,
      writes, notices, trustedEvents, activeElement: document.activeElement?.className }
  },
  async theme(mode: 'dark' | 'light') {
    const config = useAppStore.getState().config!
    await api.config.save({ ...config, appearance: { ...config.appearance, appAppearance: mode } }, config)
  }
}
Object.assign(window, { notificationScene: scene })
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
