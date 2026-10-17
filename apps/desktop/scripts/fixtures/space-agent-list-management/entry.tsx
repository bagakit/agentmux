import { createRoot } from 'react-dom/client'
import type { AgentMuxPermissionRequest } from '@agentmux/core'
import { parseConnectionResult } from '@agentmux/core/connections'
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { fixturePath } from '../../lib/fixture-values.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { SurfaceToolDock } from '../../../src/renderer/src/components/SurfaceToolDock'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import type { ProviderCatalogObservation, RuntimeSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

const phase = new URL(location.href).searchParams.get('phase')
if (!['seed', 'restore'].includes(phase ?? '')) throw new Error('Original private phase required')
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
mountThemeRuntime(window, { appAppearance: 'dark', ...(config.appearance.themeId !== undefined ? { themeId: config.appearance.themeId } : {}),
  ...(config.appearance.customThemes !== undefined ? { customThemes: config.appearance.customThemes } : {}) })
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base || !config.workspaces[0]) throw new Error('Nonempty typed Agent presentation facts required')
const workspace = { ...config.workspaces[0], id: 'space-list-proof', name: 'AgentMux · Space 工作区', hostId: 'local', path: fixturePath('private/space-list-proof') }
const names = ['复核原会话与连续阅读', '稳定列表顺序与公共偏好', '等待修改权限确认', '完成 Space 卡片设计', '离线保留，等待原身份恢复']
const states = ['working', 'working', 'waiting', 'done', 'disconnected'] as const
const ids = ['alpha', 'beta', 'gamma', 'delta', 'offline']
const { pendingInteraction: _originalInteraction, ...presentationBase } = base
const now = Date.now(), sessions: Extract<SessionSnapshot, { kind: 'agent' }>[] = ids.map((id, index) => ({ ...presentationBase, id, label: names[index]!, workspacePath: workspace.path,
  createdAt: now - (ids.length - index) * 60000, updatedAt: now - index * 1000,
  processState: index === 4 ? 'interrupted' as const : 'running' as const,
  control: { ...base.control, agentSessionId: id === 'gamma' ? 'canonical-gamma' : id, run: { runId: `private-original-${id}` } },
  status: { state: states[index]!, source: 'native-hook' as const, observedAt: now },
  semanticStatus: { state: states[index]!, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - 1000 },
  ...(index === 2 ? { pendingInteraction: { id: 'original-gamma-permission', kind: 'permission', agentSessionId: 'canonical-gamma',
    title: 'Allow editing src/space-list.tsx?', options: [], evidence: { source: 'native-hook', observedAt: now, run: { runId: `private-original-${id}` } } } satisfies AgentMuxPermissionRequest } : {})
}))
const timelines = Object.fromEntries(sessions.map((session, index) => [session.id, { agentSessionId: session.id, revision: 1, items: index === 4 ? [] : [
  { id: `prompt-${session.id}`, agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'native-hook', title: 'User prompt', content: '保留原工作面、原草稿和精确 Agent 身份，验证真实产品交互。', createdAt: now - 12000, updatedAt: now - 12000 },
  { id: `response-${session.id}`, agentSessionId: session.id, kind: 'assistant_message', status: 'complete', source: 'native-hook', title: 'Assistant reply', content: ['已核对原 Session 与终端阅读，正在检查状态变动不会改变列表位置。', '公共顺序偏好由原 Space owner 持久保存，新 Agent 按启动时间追加。', '等待原权限请求处理，不推测授权或关闭健康 Agent。', '卡片、菜单和详情沿同一 Focus 入口，保留已有响应。'][index]!, createdAt: now - 10000, updatedAt: now - 10000 }
] } satisfies RuntimeSnapshot['timelines'][string]]))
const singleTab = createWorkbenchTab('private-retained-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
  sessionId: 'alpha', regionId: 'private-retained-region' }, '原会话 · 保留工作面')
const splitTab = addWorkbenchRegion(singleTab, singleTab.layout.activeRegionId, 'right', { kind: 'agent', phase: 'attached',
  workspaceId: workspace.id, sessionId: 'beta', regionId: 'private-retained-peer-region' })
if (splitTab.layout.root.type !== 'split') throw new Error('Original private workface requires two real Regions')
const tab = { ...splitTab, layout: { ...splitTab.layout, root: { ...splitTab.layout.root, ratio: 0.6 },
  activeRegionId: 'private-retained-region' } }
const clipboard: string[] = [], controls: unknown[] = []
const restarts: { control: unknown; operationId: string; observeOnly: boolean }[] = []
let failedAgent: string | null = null
api.ui.writeClipboardText = async text => { clipboard.push(text) }
api.sessions.stop = async control => {
  if (control.kind !== 'agent') throw new Error('Only the original private Agent stop target is configured')
  controls.push(structuredClone(control)); if (control.agentSessionId === failedAgent) throw new Error('Original gamma stop receipt unavailable')
}
api.sessions.restart = async (control, operationId, observeOnly = false) => {
  restarts.push({ control: structuredClone(control), operationId, observeOnly })
  return { agentSessionId: control.agentSessionId, operationId, expectedRun: control.run, previousRun: control.run,
    phase: 'unconfirmed', canRetry: false, observedAt: Date.now(), detail: 'Private original restart receipt is unconfirmed. Check the same operation.' }
}
api.sessions.refresh = async control => {
  if (control.kind !== 'agent') throw new Error('Only the original private Agent observation is configured')
  const session = sessions.find(session => session.control.agentSessionId === control.agentSessionId && session.control.hostId === control.hostId && session.control.run.runId === control.run.runId)
  if (!session) throw new Error('Original private Session control changed')
  return structuredClone(session)
}
api.sessions.recover = async control => ({ kind: 'reattachable', session: await api.sessions.refresh(control) })
api.sessions.listMessages = async (session, options) => ({ hostId: session.hostId, participantSessionId: session.agentSessionId, direction: options.direction, messages: [], nextBeforeSequence: null })
api.connections.call = async (method, params) => {
  if (method !== 'connection.binding.ls') throw new Error('Only the exact private audience read is configured')
  return parseConnectionResult(method, { bindings: [] }, params)
}
api.schedule.list = async () => ({ schedules: [], executionScope: 'connected-host' })
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
api.config.get = async () => ({ ...config, workspaces: [workspace] })
api.sessions.snapshot = async () => ({ sessions, timelines, recoveryCandidates: [] })
async function privateProviders(options: { observation: true }): Promise<ProviderCatalogObservation>
async function privateProviders(): Promise<ProviderCatalogObservation['catalog']>
async function privateProviders(options?: { observation: true }): Promise<ProviderCatalogObservation | ProviderCatalogObservation['catalog']> {
  return options ? { catalog: [], warnings: [] } : []
}
api.providers.list = privateProviders
api.demands.list = async () => []

if (phase === 'seed') {
  const retained = { ...useAppStore.getState(), config: { ...config, workspaces: [workspace] }, sessions,
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('private-retained-group', [tab.id]) } }
  localStorage.setItem('private.space-list-spatial-snapshot', JSON.stringify({ schemaVersion: 1, revision: 1,
    graph: desktopSpatialGraph(retained, []) }))
  const { name, version } = useAppStore.persist.getOptions()
  if (!name) throw new Error('Original Store persistence key is unavailable')
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('private-retained-group', [tab.id]) } }),
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', workspaceTool: 'agents',
    agentNames: Object.fromEntries(ids.map((id, index) => [id, names[index]!])),
    agentComposerDrafts: { alpha: '保留原草稿，不向任何真实用户 Run 发送内容。' }
  } }))
}
// The typed native spatial port returns the same original durable graph on restart.
// Its original execution facts must exist before production startup can attach a saved Region.
const readSpatial = (): AgentMuxSpatialState => {
  const bytes = localStorage.getItem('private.space-list-spatial-snapshot')
  if (!bytes) throw new Error('Original private spatial snapshot is missing; no restore seed is allowed')
  const value: unknown = JSON.parse(bytes)
  if (!value || typeof value !== 'object' || Reflect.get(value, 'schemaVersion') !== 1 ||
      !Number.isSafeInteger(Reflect.get(value, 'revision')) || Reflect.get(value, 'revision') < 0)
    throw new Error('Original private spatial snapshot is invalid; no restore seed is allowed')
  return { schemaVersion: 1, revision: Reflect.get(value, 'revision'), graph: parseAgentMuxSpatialGraph(Reflect.get(value, 'graph')) }
}
const spatialCommits: unknown[] = []
api.spatial.read = async () => readSpatial()
api.spatial.retainLabels = async () => readSpatial()
api.spatial.commit = async input => {
  const previous = readSpatial()
  if (previous.revision !== input.expectedRevision) throw new Error('Original private spatial revision changed')
  spatialCommits.push(structuredClone(input))
  const saved: AgentMuxSpatialState = { schemaVersion: 1, revision: input.expectedRevision + 1, graph: structuredClone(input.graph) }
  localStorage.setItem('private.space-list-spatial-snapshot', JSON.stringify(saved))
  return saved
}
await useAppStore.getState().initialize()
const originalOrder = useAppStore.getState().workspaceAgentOrder
const original = useAppStore.getState()
function Scene() {
  const surface = useAppStore(state => state.mainSurface)
  if (surface === 'agents') return <DesktopClientUiProvider><div style={{ height: '100vh', width: '100vw' }}><GlobalFocusSurface workspaceOpen={false} /></div></DesktopClientUiProvider>
  return <DesktopClientUiProvider><div className="workspace-main-surface" style={{ display: 'flex', width: '100vw', height: '100vh', minWidth: 0 }}>
    <div data-space-list-pane style={{ width: 'min(384px, 100vw)', flex: '0 0 auto', display: 'flex', minWidth: 0 }}><SurfaceToolDock workspace={workspace} /></div>
    <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}><WorkspaceWorkbench workspaceId={workspace.id} visible /></div>
    <footer className="window-status-bar" style={{ position: 'fixed', bottom: 0, right: 0 }}><GlobalSystemNotices /></footer>
  </div></DesktopClientUiProvider>
}
const scene = {
  ready: true, phase, seedCount: phase === 'seed' ? 1 : 0, workspaceId: workspace.id, originalOrder,
  showSpace() { useAppStore.getState().setMainSurface('workbench') },
  flush: () => prepareRendererUpdate('quit'),
  addHostCollision() {
    const original = sessions.find(session => session.id === 'gamma')!
    const otherHost = { ...original, hostId: 'other-host', workspacePath: fixturePath('private/other-host'),
      control: { ...original.control, hostId: 'other-host', run: { runId: 'other-host-original-gamma' } } }
    useAppStore.setState(state => ({ sessions: [otherHost, ...state.sessions.map(session => session.id === 'gamma' ? { ...session, runUnobserved: true as const } : session)] }))
  },
  clearSingleOperations() {
    clipboard.length = 0; controls.length = 0; restarts.length = 0
    useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.hostId !== 'other-host').map(session => { if (session.id !== 'gamma') return session; const { runUnobserved: _observation, ...confirmed } = session; return confirmed }) }))
  },
  retainedReply(exited: boolean) {
    useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'delta'
      ? { ...session, processState: exited ? 'exited' : 'running', status: { ...session.status, state: 'done' } } : session) }))
  },
  failAgent(id: string | null) { failedAgent = sessions.find(session => session.id === id)?.control.agentSessionId ?? null },
  changeRun(id: string) { useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === id && session.kind === 'agent' ? { ...session, control: { ...session.control, run: { runId: `changed-original-${id}` } } } : session) })) },
  churn() { for (let index = 0; index < 100; index++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1, updatedAt: now + index, status: { ...session.status, observedAt: now + index } })) })) },
  facts() { const state = useAppStore.getState(); return {
    order: [...document.querySelectorAll<HTMLElement>('.workspace-agent-list-item')].map(node => node.dataset.agentKey),
    cards: [...document.querySelectorAll<HTMLElement>('.workspace-agent-list-item button.focus-context')].map(node => ({ id: node.dataset.sessionId, state: node.dataset.state, text: node.textContent })),
    preference: state.workspaceAgentOrder, clipboard: [...clipboard], controls: structuredClone(controls), restarts: structuredClone(restarts),
    sessions: state.sessions.map(session => ({ id: session.id, control: session.control, runUnobserved: session.runUnobserved === true })),
    tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
    originalWorkface: state.tabs === original.tabs && state.layouts === original.layouts,
    originalDrafts: state.agentComposerDrafts === original.agentComposerDrafts,
    error: state.error, notifications: state.notificationEvents, spatialCommits: spatialCommits.length,
    selection: [...document.querySelectorAll<HTMLInputElement>('.workspace-agent-list-item input[type=checkbox]')].filter(node => node.checked).map(node => node.closest<HTMLElement>('[data-agent-key]')!.dataset.agentKey)
  } }
}
declare global { interface Window { spaceListScene: typeof scene } }
window.spaceListScene = scene
createRoot(document.getElementById('root')!).render(<Scene />)
