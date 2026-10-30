import { fixturePath } from '../../lib/fixture-values.mjs'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { executionFocusPresentation } from '../../../src/renderer/src/lib/focus-tab-projection'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base?.control.run.runId || !config.workspaces[0]) throw Error('Typed preview original identity required')
const { pendingInteraction: _pending, ...agent } = base
const workspace = { ...config.workspaces[0], id: 'private-recovery', hostId: 'local', path: fixturePath('private/focus-recovery'), name: 'Conversation recovery' }
const target = { ...agent, id: 'original-retained', hostId: 'local', label: '原任务 · 查看对话与恢复', workspacePath: workspace.path,
  processState: 'exited', status: { state: 'disconnected', source: 'run-process', observedAt: Date.now() },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-retained', run: { runId: 'original-exited-run' } } }
const neighbor = { ...target, id: 'healthy-neighbor', label: '仍在运行的邻居', processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
  control: { ...target.control, agentSessionId: 'healthy-neighbor', run: { runId: 'healthy-neighbor-run' } } }
mountThemeRuntime(window, { ...config.appearance, theme: 'dark' })
const calls = [], controlEffects = { resume: 0, launchAgent: 0, write: 0, interrupt: 0 }; let fail = true
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
api.scratch.listTopics = async () => []
api.sessions.stop = async control => { calls.push(structuredClone(control)); if (fail) { fail = false; throw Error('The original Stop receipt is unavailable. Its result is unconfirmed.') } }
for (const key of Object.keys(controlEffects)) api.sessions[key] = async () => { controlEffects[key]++; throw Error('Unexpected execution in read-only recovery scene') }
const original = useAppStore.getState(), drafts = { [target.id]: '保留原草稿，不发送，也不重建会话。' }
function reset(unknown = false) {
  fail = true
  useAppStore.setState({ ...original, loading: false, config: { ...config, workspaces: [workspace] },
    sessions: [neighbor, { ...target, ...(unknown ? { runUnobserved: true } : {}) }],
    agentNames: { [target.id]: target.label, [neighbor.id]: neighbor.label }, timelines: {}, tabs: {}, layouts: {}, scratchTopicSnapshots: {},
    activeWorkspaceId: workspace.id, mainSurface: 'agents', focusView: 'list', agentComposerDrafts: drafts,
    agentFocus: { execution: { sessionId: target.id, history: [] }, pmo: { sessionId: null } }, error: null, lastError: null, errorDismissed: false }, true)
}
reset()
const select = reference => useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
function Probe() {
  const state = useAppStore()
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, workbenchSelectionCatalog(state), select)
  return h(GlobalFocusSurface, { presentation, onSelectContext: state.focusExecutionSession, onSelectLocation: select })
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, {}, h(Probe)))
window.recoveryProof = { ready: true, reset,
  facts() { const state = useAppStore.getState(); return { calls: [...calls], controlEffects, draftsKept: state.agentComposerDrafts === drafts,
    controls: state.sessions.map(session => session.control), selected: state.agentFocus.execution.sessionId,
    regions: Object.values(state.tabs).flatMap(tab => Object.values(tab.regions).filter(region => region.kind === 'agent').map(region => ({ tabId: tab.id, sessionId: region.sessionId, phase: region.phase }))) } } }
