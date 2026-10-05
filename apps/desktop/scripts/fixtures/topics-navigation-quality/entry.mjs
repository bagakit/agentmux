import { createElement as h } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { qualityTopics, seedTopicNavigation, topicCategory, topicWorkspace } from '../../../test/fixtures/topics-navigation-quality'
import '../../../src/renderer/src/styles/index.css'

seedTopicNavigation()
useAppStore.setState(state => ({ initialize: async () => () => {}, error: null, lastError: null,
  tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, tab], index) => [id, { ...tab, title: 'Research notes',
    regions: { [tab.layout.activeRegionId]: { kind: 'file', regionId: tab.layout.activeRegionId, workspaceId: topicWorkspace.id,
      path: `topic--view--quality-${index}/research.md` } } }])) }))
api.scratch.listTopics = async () => qualityTopics
api.spaceObjects.appearance = async () => ({ local: true, icon: null })
const reads = [], controls = []
api.files.readDirectory = async (workspaceId, path) => {
  reads.push({ workspaceId, path })
  return ['topic.md', 'research.md', 'decisions.md', 'references'].map(name => ({ name, path: path ? path + '/' + name : name,
    isDirectory: name === 'references', isSymlink: false }))
}
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.files.read = async (_workspace, path) => ({ status: 'read', document: { path, revision: 'private-source-1',
  content: '# Design system and interaction quality\n\nKeep the important thing easy to find, the next action clear, and the original work intact.\n\n## Current direction\n\n- Topics organize long-running research and discussion.\n- Knowledge keeps conclusions connected to their sources.\n- Files stay close at hand without taking over the directory.\n\n## Review notes\n\nThe selected Topic and its original workface remain in place while exploring another Topic’s files.\n' } })
api.topics.call = async (method, params) => {
  if (method === 'topic.category.ls') return { categories: [topicCategory], unavailable: [] }
  if (method === 'topic.inspect') return { topic: { topicId: params.topicId, title: qualityTopics.find(topic => topic.id === params.topicId)?.title,
    categorySpaceIds: [topicCategory.spaceId] }, unavailable: [] }
  if (method === 'topic.knowledge.ls' || method === 'topic.knowledge.search') return { entries: [], documents: [], unavailable: [], observation: { unavailable: [] } }
  throw new Error('Unconfigured private transport: ' + method)
}
for (const name of ['launchAgent', 'launchTerminal', 'stop', 'write', 'resume', 'interrupt']) api.sessions[name] = async () => {
  controls.push(name); throw new Error('Visual inspection must not invoke execution: ' + name)
}
window.agentmux = { git: { status: async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: topicWorkspace.path }) } }
createClientUiRoot(document.getElementById('root')).render(h(App))
void useAppStore.getState().setEditorRegionMode('topic-region-0', topicWorkspace.id, 'topic--view--quality-0/research.md', 'preview')
const originalSelection=useAppStore.getState().workbenchSpaceSelection
window.topicsQuality = {
  ready: true, topics: qualityTopics, workspace: topicWorkspace,
  theme(value) { document.documentElement.dataset.appearance = value; useAppStore.setState(state => ({ config: { ...state.config,
    appearance: { ...state.config.appearance, appAppearance: value } } })) },
  narrow() { useAppStore.setState({ projectRailOpen: false }) },
  longTitle() { useAppStore.setState({ topicCategories: [{ ...topicCategory, title: 'Product research and long-term interaction design references' }] }) },
  empty() { useAppStore.setState(state => ({ workbenchSpaceSelection: { ...state.workbenchSpaceSelection, topicId: null, zoneId: null, tabId: null, regionId: null },
    scratchTopicSnapshots: { [topicWorkspace.id]: { ...state.scratchTopicSnapshots[topicWorkspace.id], topics: [] } } })) },
  unconfirmed() { useAppStore.setState(state=>({ workbenchSpaceSelection:originalSelection,
    scratchTopicSnapshots:{[topicWorkspace.id]:{...state.scratchTopicSnapshots[topicWorkspace.id],topics:qualityTopics}},
    topicCategories: [{ ...topicCategory, readError: 'Category description is temporarily unavailable.' }] })) },
  facts() { const state = useAppStore.getState(); return { reads, controls, selection: state.workbenchSpaceSelection,
    tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, collapsed: state.explorerCollapsed,
    topicCount: document.querySelectorAll('.workspace-topic-entry').length } }
}
