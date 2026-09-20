import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceSidebar } from '../../../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const retained = JSON.parse(localStorage.getItem('space-tree-durable') ?? 'null')
const { sessions: previewSessions } = await api.sessions.snapshot()
const baseSession = previewSessions[0]
if (!baseSession) throw new Error('A nonempty preview Session is required')
const sessions = Array.from({ length: 13 }, (_, index) => ({
  ...baseSession, id: `tree-agent-${index}`, hostId: 'local', workspacePath: index === 0 ? '/standalone' : '/work/alpha',
  control: { ...baseSession.control, agentSessionId: `tree-agent-${index}`, run: { runId: `tree-run-${index}` } },
  status: { ...baseSession.status, state: index < 2 ? 'working' : index === 2 ? 'waiting' : index === 3 ? 'error' : 'running' }
}))
sessions.push(...Array.from({ length: 16 }, (_, index) => ({
  ...baseSession, id: `topic-agent-${index}`, hostId: 'local', workspacePath: '/topics/topic--view--0',
  control: { ...baseSession.control, agentSessionId: `topic-agent-${index}`, run: { runId: `topic-run-${index}` } },
  status: { ...baseSession.status, state: index < 12 ? 'waiting' : index < 15 ? 'error' : 'working' }
})), { ...baseSession, id: 'mote-agent', hostId: 'local', workspacePath: '/topics/topic--launcher--leader',
  control: { ...baseSession.control, agentSessionId: 'mote-agent', run: { runId: 'mote-run' } },
  status: { ...baseSession.status, state: 'working' } })
const tab = createWorkbenchTab('retained-tab', { regionId: 'retained-region', kind: 'agent',
  phase: 'attached', workspaceId: 'standalone', sessionId: sessions[0].id })
const tabs = { [tab.id]: tab }
const layouts = { standalone: createWorkspaceLayout('main', [tab.id]) }
const folder = (id, name, path) => ({ id, name, path, hostId: 'local', kind: 'folder' })
const topics = [
  'Release planning and decisions',
  'Harness knowledge archive',
  'A deliberately long Topic title to check narrow navigation',
  ...Array.from({ length: 10 }, (_, index) => `Topic ${index + 4}`)
].map((title, index) => ({ id: `view:${index}`, title, summary: 'Shared knowledge',
  collaborators: [], directoryPath: `topic--view--${index}`, topicPath: `topic--view--${index}/topic.md` }))
api.scratch.listTopics = async () => topics
api.workspaces.appearance = async () => ({ kind: 'directory', icon: null })
api.config.save = async updated => { useAppStore.setState({ config: updated }); return updated }
window.spaceTreeOpenCalls = []
useAppStore.setState({
  config: { ...config, workspaces: [
    folder(SCRATCH_WORKSPACE_ID, 'Topics', '/topics'),
    folder('standalone', 'Personal notes', '/standalone'),
    folder('alpha', 'Alpha', '/work/alpha'),
    folder('core', 'Core', '/work/alpha/packages/core'),
    folder('beta', 'Beta', '/work/beta')
  ] },
  sessions, layouts, tabs, activeWorkspaceId: 'standalone',
  collapsedProjectGroups: {}, pinnedItems: { [SCRATCH_WORKSPACE_ID]: ['view:0'] }, scratchTopicOrder: [], workspaceFileRevisions: {},
  ...(retained ?? {}),
  createScratchTopic: async preset => { window.spaceTreeOpenCalls.push({ kind: preset ?? 'topic' }) },
  openProjectFolder: async () => { window.spaceTreeOpenCalls.push({ kind: 'open-folder' }) },
  selectWorkspace: async id => { window.spaceTreeOpenCalls.push({ kind: 'folder', id }) },
  openScratchTopic: async (id, workspaceId) => { window.spaceTreeOpenCalls.push({ kind: 'topic', id, workspaceId }) }
})
window.spaceTreeBaseline = retained ? { sessions: retained.sessions, tabs: retained.tabs, layouts: retained.layouts } : { sessions, tabs, layouts }
window.spaceTreePersist = () => {
  const { config, sessions, tabs, layouts, activeWorkspaceId, collapsedProjectGroups, pinnedItems, scratchTopicOrder } = useAppStore.getState()
  const durable = { config, sessions, tabs, layouts, activeWorkspaceId, collapsedProjectGroups, pinnedItems, scratchTopicOrder }
  localStorage.setItem('space-tree-durable', JSON.stringify(durable))
  return durable
}
window.spaceTreeRetained = retained

window.spaceTreeDisclosure = () => useAppStore.getState().collapsedProjectGroups
const rect = node => {
  if (!node) return null
  const { x, y, width, height, right, bottom } = node.getBoundingClientRect()
  return { x, y, width, height, right, bottom }
}
window.spaceTreeGeometry = () => {
  const row = selector => {
    const node = document.querySelector(selector)
    return node && { box: rect(node), icon: rect(node.querySelector('.project-rail-row__icon, .lucide-folders') ?? node.closest('.project-rail-row-shell, .space-section-heading')?.querySelector('.space-disclosure__type')),
      title: rect(node.querySelector('.project-rail-row__identity, .project-rail-group__label, strong')),
      glyph: rect(node.querySelector('.project-rail-row__icon > svg, .project-rail-row__icon > span')),
      activity: rect(node.closest('.project-rail-entry')?.querySelector('.project-activity')), text: node.textContent, label: node.getAttribute('aria-label') }
  }
  const scroll = document.querySelector('.space-tree')
  const rail = document.querySelector('.project-rail')
  const style = getComputedStyle(rail)
  const edit = document.querySelector('[aria-label="Edit Mote SOUL.md"]')
  const focus = document.activeElement
  return {
    width: innerWidth, height: innerHeight,
    rail: rect(rail), indent: parseFloat(style.getPropertyValue('--rail-indent')),
    rowMin: parseFloat(style.getPropertyValue('--rail-row-min')),
    mote: row('.space-mote-row'), topics: row('[aria-label="Topics overview"]'), topic: row('.space-topic-row'),
    standalone: row('[data-workspace-id="standalone"]'), alpha: row('[data-workspace-id="alpha"]'),
    core: row('[data-workspace-id="core"]'), beta: row('[data-workspace-id="beta"]'),
    group: row('.project-rail-group__header'),
    edit: rect(edit), header: rect(document.querySelector('.project-rail-titlebar')),
    scroll: scroll && { box: rect(scroll), scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      scrollTop: scroll.scrollTop, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth },
    topicCount: document.querySelectorAll('.space-topic-row').length,
    topicExpanded: document.querySelector('[data-space-nav="space:topics"]')?.dataset.spaceExpanded,
    focus: { label: focus?.getAttribute('aria-label'), visible: focus?.matches(':focus-visible'),
      outline: focus && getComputedStyle(focus).outlineStyle },
    activity: [...document.querySelectorAll('.project-activity')].map(node => ({ box: rect(node), label: node.getAttribute('aria-label') })),
    original: { sessions: useAppStore.getState().sessions, tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts }
  }
}
createRoot(document.getElementById('root')).render(createElement('div', {
  style: { height: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }
}, createElement(WorkspaceSidebar)))
