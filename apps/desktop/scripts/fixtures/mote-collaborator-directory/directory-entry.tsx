import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { ScratchTopicSnapshot, MoteDirectoryView } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("fixture/topics"), name: 'Topics', kind: 'folder' as const }
const definitions = [[PMO_TEAMS_TOPIC_ID, 'Main Mote'], ['launcher:untitled', 'Untitled Mote'], ['launcher:analyst', 'Research and systems design'], ['launcher:research', 'Research partner'], ['launcher:debugger', 'Debugger'], ['launcher:archived', 'Early experiments']] as const
const topics: ScratchTopicSnapshot[] = definitions.map(([id,title]) => {
  const directoryPath = workspace.path + '/' + scratchTopicDirectoryName(id)
  return { id, title, summary: 'Persistent collaborator', directoryPath, identityDirectoryPath: directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# SOUL\n\nBe practical and thoughtful.\n', version: 'fixture' },
    moteArchive: { state: id === 'launcher:archived' ? 'archived' : 'active', version: id === PMO_TEAMS_TOPIC_ID ? 'primary' : 'unwritten' } }
})
const tabs = Object.fromEntries(topics.map(topic => {
  const spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
  const tab = { ...createWorkbenchTab('tab-' + topic.id, { kind: 'launcher', regionId: 'region-' + topic.id, workspaceId: workspace.id }, 'Discussion'), topicId: topic.id, space: { spaceId, zoneId } }
  return [tab.id,tab]
}))
const layout = createWorkspaceLayout('original-group', Object.keys(tabs)), active = tabs['tab-launcher:analyst']!
const selected = { spaceId: active.space!.spaceId, zoneId: active.space!.zoneId, workspaceId: workspace.id, topicId: active.topicId!, tabId: active.id, groupId: 'original-group', regionId: active.layout.activeRegionId }
const palettes = ['lavender','sky','mint','peach','sky'] as const
const icons = Object.fromEntries(topics.slice(1).map((topic,index) => [directoryIdentity('local',topic.directoryPath), { ...DEFAULT_MOTE_FACE, palette: palettes[index]! }]))
api.scratch.listTopics = async () => topics
api.scratch.readTopic = async (_workspace,id) => topics.find(topic => topic.id === id) ?? null
api.scratch.ensureMote = async (_workspace,id) => topics.find(topic => topic.id === id)!
api.config.save = async config => { useAppStore.getState().setConfig(config); return config }
const forbidden: string[] = []
api.sessions.launchAgent = async () => { forbidden.push('launch'); throw Error('No Agent execution is authorized in this UI capture') }
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [workspace], executors: {},
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
  sessions: [], tabs, layouts: { [workspace.id]: { ...layout, groups: layout.groups.map(group => ({ ...group, activeTabId: active.id })) } }, loading: false,
  initialize: async () => () => {}, detectExecutors: async () => {}, prewarmTerminal: async () => {},
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', projectRailOpen: true, toolsOpen: false,
  scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, reading: false, error: null } },
  workbenchSpaceSelection: selected, collapsedProjectGroups: {}, pinnedItems: { [workspace.id]: ['launcher:analyst'] },
  agentComposerDrafts: { [active.layout.activeRegionId]: 'Keep this original unsent thought.' }, spaceObjectIcons: icons })
function Scene() {
  const [settings, setSettings] = useState(false)
  Object.assign(window, { directoryScene: {
    settings: setSettings,
    coldReadIssue: () => {
      requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
      const topic = topics.find(t => t.id === 'launcher:analyst')!
      topic.kind = 'mote'; topic.soul = undefined
      topic.readError = '.agents: collaborator details could not be read'
      useAppStore.setState({ scratchTopicSnapshots: { [workspace.id]: {
        scope: scratchTopicsScope(workspace), revision: 0, topics: [...topics], reading: false, error: null
      } } })
    },
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    view: (moteDirectoryView: MoteDirectoryView) => useAppStore.setState({ config: { ...useAppStore.getState().config!, moteDirectoryView } }),
    facts: () => ({ selection: useAppStore.getState().workbenchSpaceSelection, drafts: useAppStore.getState().agentComposerDrafts, forbidden })
  } })
  return <DesktopClientUiProvider><App />{settings ? <div style={{ position: 'fixed', inset: 0, zIndex: 2, background: 'var(--bg)' }}><SettingsPanel initialSection="mote" onClose={() => setSettings(false)} /></div> : null}</DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
