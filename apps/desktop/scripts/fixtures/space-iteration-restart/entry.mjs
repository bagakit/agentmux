import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { WorkspaceSidebar } from '../../../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { WorkspaceTopicsPanel } from '../../../src/renderer/src/components/WorkspaceTopicsPanel'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

const request = window.spaceRestartBoundary.request
const setup = await request('setup')
const workspace = setup.config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.sessions.snapshot = async () => request('snapshot')
api.sessions.recover = async (control, cwd) => request('recover', control, cwd)
api.sessions.attach = async (control) => request('attach', control)
api.sessions.detach = async attachmentId => request('detach', attachmentId)
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.onEvent = listener => window.spaceRestartBoundary.onEvent(event => {
  window.spaceRestartFacts ??= []
  window.spaceRestartFacts.push(event)
  listener(event)
})
api.ui.requestStorageFlush = async () => request('flush')
api.scratch.listTopics = async id => request('topics', id)
api.scratch.readTopic = async (id, topicId) => request('topic', id, topicId)
api.scratch.ensureTopic = async (id, topicId) => request('ensure-topic', id, topicId)
api.scratch.ensureMote = async (id, topicId) => request('ensure-mote', id, topicId)
api.files.read = async (id, file) => request('file', id, file)
api.files.observe = async () => {}
api.files.unobserve = async () => {}

const dispose = await useAppStore.getState().initialize()
if (setup.phase === 'seed') {
  const originalFile = await api.files.read(workspace.id, 'topic--view--original/topic.md')
  if (originalFile.status !== 'read') throw new Error('Private file fixture must be readable')
  const fileKey = `${workspace.id}\0topic--view--original/topic.md`
  const agent = createWorkbenchTab('original-agent-tab', {
    regionId: 'original-agent-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'private-live-agent'
  })
  agent.topicId = 'view:original'
  agent.layout = splitWorkbenchRegion(agent.layout, 'original-agent-region', 'right', 'original-file-region')
  agent.layout.root.ratio = 0.63
  agent.layout.activeRegionId = 'original-file-region'
  agent.regions['original-file-region'] = { regionId: 'original-file-region', kind: 'file', workspaceId: workspace.id, path: 'topic--view--original/topic.md' }
  const idle = createWorkbenchTab('original-idle-tab', {
    regionId: 'original-idle-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'private-idle-agent'
  })
  idle.topicId = 'view:original'
  const mote = createWorkbenchTab('original-mote-tab', {
    regionId: 'original-mote-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'private-mote-agent'
  })
  mote.topicId = 'launcher:leader'
  const background = createWorkbenchTab('original-background-tab', {
    regionId: 'original-background-region', kind: 'launcher', workspaceId: workspace.id
  })
  background.topicId = 'view:original'
  const layout = createWorkspaceLayout('original-group-left', [agent.id, mote.id, background.id])
  layout.groups.push({ id: 'original-group-right', tabOrder: [idle.id], activeTabId: idle.id, recentTabIds: [idle.id] })
  layout.root = { type: 'split', direction: 'horizontal', ratio: 0.57,
    first: { type: 'leaf', groupId: 'original-group-left' }, second: { type: 'leaf', groupId: 'original-group-right' } }
  layout.activeGroupId = 'original-group-left'
  layout.groups[0].activeTabId = agent.id
  useAppStore.setState({ tabs: { [agent.id]: agent, [idle.id]: idle, [mote.id]: mote, [background.id]: background },
    layouts: { [workspace.id]: layout }, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: 'private-live-agent', history: [{ sessionId: 'private-live-agent', focusedAt: 1000 }] }, pmo: { sessionId: 'private-mote-agent' } },
    toolsOpen: true, workspaceTool: 'files-branches', scratchTopicOrder: ['view:other', 'view:original'],
    pinnedItems: { [workspace.id]: ['view:original'] },
    documents: { [fileKey]: { ...originalFile.document, content: `${originalFile.document.content}\nOriginal unsaved file note\n` } },
    dirtyDocuments: { [fileKey]: true } })
  useAppStore.getState().setAgentComposerDraft('private-live-agent', 'Original unsent draft survives restart')
}

function state() {
  const current = useAppStore.getState()
  const workbench = projectPersistedWorkbench(current)
  // Runtime phase is transient. Identity, geometry, placement and paths must compare exactly.
  const tabs = Object.fromEntries(Object.entries(workbench.tabs).map(([id, tab]) => [id, {
    ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([region, surface]) => {
      const { phase: _phase, ...durable } = surface
      return [region, durable]
    }))
  }]))
  return { loading: current.loading, tabs, layouts: workbench.layouts,
    activeWorkspaceId: current.activeWorkspaceId, agentFocus: current.agentFocus,
    drafts: current.agentComposerDrafts, order: current.scratchTopicOrder, pins: current.pinnedItems,
    documents: current.documents, dirtyDocuments: current.dirtyDocuments,
    error: current.error, timelines: current.timelines,
    sessions: current.sessions.map(one => ({ id: one.id, processState: one.processState, runId: one.control.run.runId })) }
}
window.spaceRestartState = state
window.spaceRestartUi = () => ({
  regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId).sort(),
  topicTree: [...document.querySelectorAll('.space-topic-row strong')].map(node => node.textContent),
  overview: [...document.querySelectorAll('.workspace-topic-entry .selector-row__identity strong')].map(node => node.textContent),
  motes: [...document.querySelectorAll('.space-mote-row strong')].map(node => node.textContent),
  alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
  overviewSelected: document.querySelector('[data-current="true"]')?.dataset.topicId,
  topicSelected: document.querySelector('.space-topic-row[aria-current="page"]')?.getAttribute('aria-label'),
  topologies: [...document.querySelectorAll('[data-topic-tab-id]')].map(node => node.dataset.topicTabId)
})
function Fixture() {
  const error = useAppStore(one => one.error)
  useEffect(() => { window.spaceRestartReady = true; return () => dispose?.() }, [])
  return createElement('section', { style: { display: 'flex', width: '100vw', height: '100vh' } },
    createElement('div', { style: { width: 220, height: '100%' } }, createElement(WorkspaceSidebar)),
    createElement('main', { style: { flex: 1, minWidth: 0, height: '100%', position: 'relative' } },
      createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true })),
    createElement('aside', { style: { width: 340, height: '100%' } },
      createElement(WorkspaceTopicsPanel, { workspace, onRevealDirectory: () => {} }),
      error ? createElement('div', { role: 'alert' }, error) : null))
}
createRoot(document.getElementById('root')).render(createElement(Fixture))
