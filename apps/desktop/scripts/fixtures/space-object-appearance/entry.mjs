import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { WorkspaceSidebar } from '../../../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { WorkspaceTopicsPanel } from '../../../src/renderer/src/components/WorkspaceTopicsPanel'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { folderSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import '../../../src/renderer/src/styles/index.css'

const request = window.spaceAppearanceBoundary.request
const setup = await request('setup')
const workspace = setup.config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.sessions.snapshot = async () => request('snapshot')
api.sessions.attach = async control => request('attach', control)
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.onEvent = () => () => {}
api.ui.requestStorageFlush = async () => request('flush')
api.scratch.listTopics = async id => request('topics', id)
api.scratch.readTopic = async (id, topicId) => request('topic', id, topicId)
api.scratch.ensureTopic = async (id, topicId) => request('ensure-topic', id, topicId)
api.scratch.ensureMote = async (id, topicId) => request('ensure-mote', id, topicId)
api.workspaces.appearance = async id => request('appearance', id)
api.files.read = async (id, file) => request('file', id, file)
api.files.observe = async () => {}
api.files.unobserve = async () => {}

// Failure injection is at the real platform write boundary. It never replaces the Store writer.
window.spaceAppearanceWrites = { attempts: 0, failures: 0, completed: 0 }
window.spaceAppearanceFailLocalWrites = 0
const originalSetItem = Storage.prototype.setItem
Storage.prototype.setItem = function (key, value) {
  if (key === 'agentmux-workbench-v1') {
    window.spaceAppearanceWrites.attempts += 1
    if (window.spaceAppearanceFailLocalWrites > 0) {
      window.spaceAppearanceFailLocalWrites -= 1
      window.spaceAppearanceWrites.failures += 1
      throw new Error('Private localStorage write failure')
    }
    const result = originalSetItem.call(this, key, value)
    window.spaceAppearanceWrites.completed += 1
    return result
  }
  return originalSetItem.call(this, key, value)
}

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
    layouts: { ...useAppStore.getState().layouts, [workspace.id]: layout }, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: 'private-live-agent', history: [{ sessionId: 'private-live-agent', focusedAt: 1000 }] }, pmo: { sessionId: 'private-mote-agent' } },
    scratchTopicOrder: ['view:other', 'view:original'], pinnedItems: { [workspace.id]: ['view:original'] },
    documents: { [fileKey]: { ...originalFile.document, content: `${originalFile.document.content}\nOriginal unsaved file note\n` } },
    dirtyDocuments: { [fileKey]: true } })
  useAppStore.getState().setAgentComposerDraft('private-live-agent', 'Original unsent draft survives restart')
  if (setup.manualFolder) {
    const manual = setup.manualFolder
    const target = folderSpaceIconTarget({ hostId: manual.hostId, repoPath: manual.path, name: manual.name })
    useAppStore.setState({ spaceObjectIcons: { [target.key]: manual.manualIcon } })
  }
}

window.spaceAppearanceState = () => {
  const current = useAppStore.getState()
  const persisted = projectPersistedWorkbench(current)
  const tabs = Object.fromEntries(Object.entries(persisted.tabs).map(([id, tab]) => [id, {
    ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([region, surface]) => {
      const { phase: _phase, ...durable } = surface
      return [region, durable]
    }))
  }]))
  return { loading: current.loading, icons: current.spaceObjectIcons,
    workface: { tabs, layouts: persisted.layouts, activeWorkspaceId: current.activeWorkspaceId,
      agentFocus: current.agentFocus, drafts: current.agentComposerDrafts,
      order: current.scratchTopicOrder, pins: current.pinnedItems,
      documents: current.documents, dirtyDocuments: current.dirtyDocuments },
    warning: current.workbenchSaveWarning, writes: { ...window.spaceAppearanceWrites },
    durable: JSON.parse(localStorage.getItem('agentmux-workbench-v1') ?? 'null') }
}
window.spaceAppearanceFlush = () => prepareRendererUpdate()
window.spaceAppearanceUi = () => ({
  regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId).sort(),
  rail: (() => {
    const rail = document.querySelector('[data-space-appearance-rail] .sidebar.project-rail')
    if (!rail) return null
    const bounds = rail.getBoundingClientRect()
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  })(),
  targets: [...document.querySelectorAll('[data-space-icon-target]')].map(node => {
    const icon = node.querySelector('[data-space-icon-source]') ?? node.closest('.project-rail-row-shell')?.querySelector('[data-space-icon-source]')
    const image = icon?.querySelector('img'), monogram = icon?.hasAttribute('data-monogram') ? icon : null
    const painted = image ?? monogram, style = painted ? getComputedStyle(painted) : null, bounds = painted?.getBoundingClientRect()
    return { key: node.dataset.spaceIconTarget, workspaceId: node.dataset.workspaceId, text: node.textContent, source: icon?.dataset.spaceIconSource,
      icon: icon?.dataset.spaceIcon, detectedImage: image?.getAttribute('src') ?? null, recency: painted?.dataset.folderIconRecency,
      monogram: monogram?.textContent ?? null, hue: monogram?.style.getPropertyValue('--folder-icon-hue') ?? null,
      color: style?.color, backgroundColor: style?.backgroundColor,
      filter: style?.filter, opacity: style ? Number(style.opacity) : null, title: icon?.title,
      identityBounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
      imageBounds: image && bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
      selected: node.getAttribute('aria-current'), attention: node.closest('[data-space-entry]')?.querySelector('.project-activity')?.getAttribute('aria-label') }
  }),
  dialog: document.querySelector('[role="dialog"]')?.textContent ?? null,
  alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
  focus: { target: document.activeElement?.dataset.spaceIconTarget, label: document.activeElement?.getAttribute('aria-label'),
    visible: document.activeElement?.matches(':focus-visible') }
})
function Fixture() {
  useEffect(() => { window.spaceAppearanceReady = true; return () => dispose?.() }, [])
  return createElement('section', { style: { display: 'flex', width: '100vw', height: '100vh' } },
    createElement('div', { 'data-space-appearance-rail': '', style: { width: 240, flexShrink: 0, height: '100%' } }, createElement(WorkspaceSidebar)),
    createElement('main', { style: { flex: 1, minWidth: 0, height: '100%', position: 'relative' } },
      createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true })),
    createElement('aside', { style: { width: 340, height: '100%', position: 'relative' } },
      createElement(WorkspaceTopicsPanel, { workspace, onRevealDirectory: () => {} }),
      createElement(GlobalSystemNotices)))
}
createRoot(document.getElementById('root')).render(createElement(Fixture))
