import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

// Only api.ts's maintained typed data factory is selected by the private compiler.
// BrowserPane retains the actual desktop branch and its native geometry owner.
Object.assign(api.browser, window.moteNative.browser)
Object.assign(api.ui, window.moteNative.ui)
const config = await api.config.get()
const session = (await api.sessions.snapshot()).sessions.find(item => item.kind === 'agent')
if (!session) throw new Error('A nonempty controlled Session reference is required')
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/settings-proof/topics', name: 'Topics', kind: 'folder' }
const project = { id: 'workspace-demo', hostId: 'local', path: '/private/settings-proof/project', name: 'Browser Settings proof', kind: 'folder' }
const actualConfig = { ...config, workspaces: [project, scratch] }
const topicId = 'launcher:settings-proof'
const path = scratch.path + '/' + scratchTopicDirectoryName(topicId)
const topic = { id: topicId, directoryPath: path, topicPath: path + '/topic.md', title: 'Foreground Mote',
  summary: 'This other Tab remains available above Settings.', collaborators: [],
  soul: { path: path + '/SOUL.md', content: '# SOUL', version: 'private-controlled-topic' } }
api.scratch.listTopics = async () => [topic]
api.scratch.ensureMote = async () => topic
api.scratch.readTopic = async () => topic
const tabs = {}
for (const [id, workspaceId, foreground] of [['background-browser', project.id, false], ['foreground-mote-browser', scratch.id, true]]) {
  const browser = await api.browser.create(id, window.moteNative.fixturePageUrl + '?owner=' + id, workspaceId)
  const surface = { kind: 'browser', regionId: id + '-region', workspaceId, browserId: id, ...browser }
  const tab = foreground ? createWorkbenchTab('foreground-mote-tab', surface) : createWorkbenchTab('background-tab', {
    kind: 'agent', phase: 'attached', regionId: 'controlled-agent-region', workspaceId, sessionId: session.id
  })
  if (!foreground) { tab.regions[surface.regionId] = surface; tab.layout = splitWorkbenchRegion(tab.layout, 'controlled-agent-region', 'right', surface.regionId) }
  if (foreground) tab.topicId = topicId
  tabs[tab.id] = tab
}
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: actualConfig,
  activeWorkspaceId: project.id, mainSurface: 'agents', tabs, sessions: [session], toolsOpen: false, projectRailOpen: false,
  layouts: { [project.id]: createWorkspaceLayout('background-group', ['background-tab']), [scratch.id]: createWorkspaceLayout('mote-group', ['foreground-mote-tab']) },
  agentFocus: { execution: { sessionId: session.id, history: [] }, pmo: { sessionId: null } },
  agentComposerDrafts: { [session.id]: 'The original unsent draft' } })
const root = createRoot(document.getElementById('root'))
root.render(createElement(App))
let originalStage, originalHost, originalParent, originalState
window.browserSettingsProof = {
  ready: true,
  captureOriginal() {
    originalStage = document.querySelector('[data-native-browser-stage="background-browser"]')
    originalHost = originalStage?.closest('.retained-workbench-view'); originalParent = originalHost?.parentElement
    originalState = useAppStore.getState()
    if (!originalStage || !originalHost || !originalParent) throw new Error('The actual retained Browser binding must exist')
  },
  openMote() { requestPmoTeamsTopicFloatingOpen({ targetTabId: 'foreground-mote-tab', targetTopicId: topicId }) },
  facts() {
    const state = useAppStore.getState()
    return { settings: !!document.querySelector('[data-fixture-settings]'),
      sameStage: document.querySelector('[data-native-browser-stage="background-browser"]') === originalStage,
      sameHost: originalStage?.closest('.retained-workbench-view') === originalHost,
      sameParent: originalHost?.parentElement === originalParent,
      sameTabs: state.tabs === originalState?.tabs, sameLayouts: state.layouts === originalState?.layouts,
      sameSessions: state.sessions === originalState?.sessions, sameDrafts: state.agentComposerDrafts === originalState?.agentComposerDrafts,
      moteOpen: document.querySelector('[data-pmo-teams-topic-floating]')?.matches(':popover-open') ?? false }
  }
}
