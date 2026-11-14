import { useState } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { TopicActionsMenu } from '../../../src/renderer/src/components/TopicContextMenu'
import { AgentRegionHeader } from '../../../src/renderer/src/components/AgentRegionHeader'
import { WorkbenchPresentationContext } from '../../../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { applyConfigEdit } from '../../../src/shared/config-edit'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentPromotionApply, AgentPromotionReceipt } from '@agentmux/core/agent-promotion'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

const source = { hostId: 'local', sessionId: 'trusted-agent', displayWorkspaceId: 'project', groupId: 'project-group', tabId: 'project-tab', regionId: 'project-region' }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'project', name: 'A familiar project', hostId: 'local', path: '/private/promotion/project', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } }
const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: source.sessionId, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: config.workspaces[0]!.path,
  promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, label: 'Infrastructure research · a trusted collaborator', createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: source.sessionId, run: { runId: 'original-healthy-run' } } }
const tab = createWorkbenchTab(source.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'project', sessionId: session.id, regionId: source.regionId })
useAppStore.setState({ config, sessions: [session], tabs: { [tab.id]: tab }, layouts: { project: createWorkspaceLayout(source.groupId, [tab.id]) },
  activeWorkspaceId: 'project', mainSurface: 'workbench', agentComposerDrafts: { [session.id]: 'Keep the original draft' },
  loading: false, error: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [],
  detectExecutors: async () => {}, checkHost: async () => {}, refreshSpatialState: async () => {}, refreshScratchTopics: async () => [] })
api.config.save = async (requested, expected) => { const saved = applyConfigEdit(useAppStore.getState().config!, expected!, requested); useAppStore.setState({ config: saved }); return saved }
let receipt: AgentPromotionReceipt | null = null, resolveApply: ((value: { promotion: AgentPromotionReceipt }) => void) | null = null, rejectApply: ((reason: Error) => void) | null = null
let emptyClubs = false
const clubs = [{ title: 'Research Club · product and architecture', directoryPath: '/private/promotion/motes/research', target: { spaceId: 'research-club', zoneId: 'research-home', expectedResource: { hostId: 'local', workspaceId: 'mote-workspace', workspacePath: '/private/promotion' } } }, { title: 'Writing Club', directoryPath: '/private/promotion/motes/writing', target: { spaceId: 'writing-club', zoneId: 'writing-home', expectedResource: { hostId: 'local', workspaceId: 'mote-workspace', workspacePath: '/private/promotion' } } }]
const calls: Array<{ method: string; params: unknown }> = []
api.agentPromotions.call = async (method, params) => {
  calls.push({ method, params })
  if (method === 'agent.promote.inspect') return 'operationId' in params ? { promotion: receipt, discovery: null } : { promotion: null, discovery: { clubs: emptyClubs ? [] : clubs, memberships: [], pending: receipt?.state === 'partial' ? [receipt] : [], nextCursor: null, issue: null } }
  const input = params as AgentPromotionApply
  receipt = { ...input, topicId: 'launcher:trusted-mote', moteSpaceId: 'trusted-mote', zoneId: 'trusted-home', directoryPath: '/private/promotion/motes/trusted',
    conversation: { ...source, displayWorkspaceId: 'trusted-mote', groupId: 'trusted-group', tabId: 'trusted-tab', regionId: 'trusted-region' },
    state: 'partial', stage: 'spatial', diskDurability: 'unconfirmed', unavailable: [{ code: 'SPATIAL_UNCONFIRMED', message: 'The original member association is not yet confirmed.', recovery: 'Inspect and explicitly continue this original promotion.' }] }
  return await new Promise((resolve, reject) => { resolveApply = resolve; rejectApply = reject })
}
mountThemeRuntime(window, config.appearance)
function Scene() {
  const [settings, setSettings] = useState(true)
  return <SettingsNavigation.Provider value={{ open: () => setSettings(true), openToolkit: () => {}, openHost: () => {}, openChannel: () => {}, channelEntries: [], channelPresentation: () => null, openMoteLark: () => {}, chooseAgent: () => {} }}><div style={{ height: '100vh', padding: 32, background: 'var(--surface-0)', color: 'var(--text)' }}>
    <div style={{ maxWidth: 900, margin: '0 auto', paddingTop: 40 }}>
      <p style={{ fontSize: 12, color: 'var(--text-3)' }}>A familiar project</p>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-1)' }}>
        <WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference: source }}><AgentRegionHeader name={session.label} executorLabel="Codex" sessionId={session.id} sessionKind="agent" executionHost={{ id: 'local', label: 'This Mac', configured: true, cwd: session.workspacePath }} regionId={source.regionId} nativeSession={session} readOnly={false} onHistory={undefined} /></WorkbenchPresentationContext.Provider>
        <div style={{ padding: 24, minHeight: 240 }}><h2 style={{ fontWeight: 500 }}>The work continues here.</h2><p style={{ color: 'var(--text-2)' }}>Same Agent. Same conversation. A space for what comes next.</p><textarea aria-label="Original draft" defaultValue="Keep the original draft" style={{ width: '100%', marginTop: 30 }} /></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <span>A familiar Topic</span><TopicActionsMenu title="A familiar Topic" pinned={false}
          onPromote={() => {}} onCopyPath={() => {}} onCopyLink={() => {}} onRename={() => {}} onReveal={() => {}} onTogglePin={() => {}} onEditWiki={() => {}} />
      </div>
      <button type="button" className="small-button" data-open-promotion-settings onClick={() => setSettings(true)}>Promotion settings</button>
    </div>
    {settings ? <SettingsPanel initialSection="mote-promotion" onClose={() => setSettings(false)} /> : null}
  </div></SettingsNavigation.Provider>
}
createClientUiRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { agentPromotionProbe: {
  calls, source,
  empty(value: boolean) { emptyClubs = value },
  unknown() { if (!rejectApply) throw Error('No original submitted promotion'); rejectApply(new Error('The original save reply was lost. Inspect before continuing.')); rejectApply = null; resolveApply = null },
  closeSettings() { const close = document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]'); if (!close) throw Error('Actual Settings close control unavailable'); close.click() },
  policy(enabled: boolean) { useAppStore.setState({ config: { ...useAppStore.getState().config!, promotion: { enabled } } }) },
  partial() { if (!receipt || !resolveApply) throw Error('No original submitted promotion'); resolveApply({ promotion: receipt }); resolveApply = null },
  complete() { if (!receipt || !resolveApply) throw Error('No original submitted promotion'); receipt = { ...receipt, state: 'complete', stage: 'complete', diskDurability: 'confirmed', unavailable: [] }; resolveApply({ promotion: receipt }); resolveApply = null },
  theme(light: boolean) { const appearance = { ...config.appearance, appAppearance: light ? 'light' as const : 'dark' as const }; useAppStore.setState(state => ({ config: { ...state.config!, appearance } })); updateThemeSelection(appearance, window) },
  facts() { const s = useAppStore.getState(); return { sessions: s.sessions, tabs: s.tabs, layouts: s.layouts, drafts: s.agentComposerDrafts, activeWorkspaceId: s.activeWorkspaceId, calls } }
} })
