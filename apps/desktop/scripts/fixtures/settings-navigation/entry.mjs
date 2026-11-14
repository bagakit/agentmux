import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererControlApi } from '../../../src/renderer/src/lib/control-api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import '../../../src/renderer/src/styles/index.css'
const boundary = window.settingsNavigationBoundary
const setup = await boundary.setup(), preview = await api.config.get()
const cwd = setup.workspace
const session = { id: 'private-mote', kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: cwd,
  label: 'Private input owner', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'private-mote', run: { runId: 'private-native-input' } } }
const tab = { ...createWorkbenchTab('private-mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'private-mote-region', sessionId: session.id }), topicId: PMO_TEAMS_TOPIC_ID }
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Private Mote', summary: '', collaborators: [], directoryPath: cwd,
  topicPath: cwd + '/topic.md', soul: { path: cwd + '/SOUL.md', content: '# Private identity', version: 'v1' } }
api.scratch.listTopics = async () => [topic]
api.scratch.ensureTopic = api.scratch.ensureMote = async () => topic
const config = { ...preview, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', hostId: 'local', path: setup.workspace, kind: 'folder' }] }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ sessions: [session], timelines: {}, recoveryCandidates: [] })
const forbidden = []
for (const method of ['launchAgent', 'launchTerminal', 'stop', 'write', 'paste', 'submitPrompt', 'resume']) api.sessions[method] = async () => {
  forbidden.push(method); throw new Error('Settings navigation must not invoke Runtime: ' + method)
}
api.control = createRendererControlApi(boundary.control)
useAppStore.setState({ prewarmTerminal: async () => {} })
const dispose = await useAppStore.getState().initialize()
window.addEventListener('beforeunload', () => dispose())
useAppStore.setState({ initialize: async () => () => {}, prewarmTerminal: async () => {}, loading: false,
  config,
  sessions: [session], tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('private-group', [tab.id]) },
  activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench', workbenchNavigationInputPolicy: 'preserve',
  viewModes: { [session.id]: 'activity' }, agentComposerDrafts: { [session.id]: 'Original Mote draft remains' } })
createRoot(document.getElementById('root')).render(createElement(DesktopClientUiProvider, null, createElement(App)))
let originalInput, selectionNode, focusEvents = [], compositionEvents = []
window.settingsNavigationProof = {
  async openMote() { requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id }) },
  prepareInput() {
    originalInput = document.querySelector('[data-pmo-teams-topic-floating] [data-workbench-region-id="private-mote-region"] [role="textbox"]')
    if (!originalInput) throw new Error('Original Mote Composer is not mounted')
    originalInput.focus()
    selectionNode = originalInput.firstChild.firstChild
    const range = document.createRange(); range.setStart(selectionNode, 3); range.collapse(true)
    const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range)
    for (const type of ['focusin', 'focusout']) originalInput.addEventListener(type, event => focusEvents.push(event.type))
    for (const type of ['compositionstart', 'compositionend']) originalInput.addEventListener(type, event => compositionEvents.push(event.type))
    originalInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    return this.facts()
  },
  facts() {
    const state = useAppStore.getState(), selection = document.getSelection()
    return { ready: Boolean(document.querySelector('[data-main-surface]')), inputMounted: Boolean(document.querySelector('[data-pmo-teams-topic-floating] [role="textbox"]')),
      sameInput: Boolean(originalInput && originalInput === document.activeElement && originalInput.isConnected),
      sameSelection: Boolean(selectionNode && selection.anchorNode === selectionNode && selection.anchorOffset === 3),
      draft: state.agentComposerDrafts[session.id], tabs: Object.keys(state.tabs), mainSurface: state.mainSurface,
      forbidden: [...forbidden], focusEvents: [...focusEvents], compositionEvents: [...compositionEvents],
      actualSection: document.querySelector('[data-settings-page]')?.dataset.settingsPage ?? null }
  },
  manualProfile() { document.querySelector('[data-settings-target="profile"]').click() },
  focusProfile() { document.getElementById('profile-display-name').focus() },
  profileDraft() { return document.getElementById('profile-display-name')?.value ?? null }
}
