import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const snapshot = await api.sessions.snapshot()
const selected = snapshot.sessions.find(session => session.id === 'session-codex')
const workspaceId = 'workspace-demo'
const projects = Array.from({ length: 24 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/fixture/project-${index}`, hostId: 'local', kind: 'folder' }))
config.workspaces.push(...projects)
const sessions = [selected, ...projects.map((workspace, index) => ({ ...selected, id: `context-${index}`, label: `Context ${index}`, workspacePath: workspace.path }))]
const tab = createWorkbenchTab('fixture-tab', { regionId: 'fixture-region', workspaceId, kind: 'agent', phase: 'attached', sessionId: selected.id })
const seed = {
  config, sessions, timelines: snapshot.timelines, providerCatalog: [], agentNames: {},
  tabs: { [tab.id]: tab }, layouts: { [workspaceId]: { root: { type: 'leaf', groupId: 'fixture-group' }, groups: [{ id: 'fixture-group', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'fixture-group' } },
  mainSurface: 'agents', activeWorkspaceId: workspaceId,
  agentFocus: { execution: { sessionId: selected.id, history: sessions.map((session, index) => ({ sessionId: session.id, focusedAt: 1000 + index * 60000 })) }, pmo: { sessionId: null } }
}
useAppStore.setState(seed)
window.focusProbeWheels = []
document.addEventListener('wheel', event => window.focusProbeWheels.push({ trusted: event.isTrusted, tracks: Boolean(event.target.closest('.recent-focus__viewport')), lanes: Boolean(event.target.closest('.focus-project-lanes__rows')), deltaX: event.deltaX, deltaY: event.deltaY }), true)
window.restoreFocusProbe = state => useAppStore.setState({ ...state, config })
window.focusProbeInputReceipt = async () => (await api.sessions.snapshot()).timelines['session-codex'].items.at(-1)
window.focusProbeState = () => {
  const { tabs, layouts, agentFocus, sessions, timelines } = useAppStore.getState()
  return { tabs, layouts, agentFocus, sessions, timelines }
}
function Fixture() {
  useEffect(() => { window.focusProbeReady = true }, [])
  return createElement('section', { className: 'workspace-main-surface', style: { width: '100vw', height: '100vh', position: 'relative' } },
    createElement(GlobalFocusSurface),
    createElement('div', { className: 'workspace-workbench-registry' },
      createElement('div', { className: 'workspace-workbench-slot workspace-workbench-slot--focus-source' },
        createElement(WorkspaceWorkbench, { workspaceId, visible: true, focusTabId: tab.id, focusPortalTargetId: 'focus-workspace-slot' }))))
}
createRoot(document.getElementById('root')).render(createElement(Fixture))
window.focusProbeGeometry = () => {
  const inspect = selector => {
    const node = document.querySelector(selector)
    if (!node) throw new Error(`Missing rendered Focus node: ${selector}`)
    const rect = node.getBoundingClientRect()
    return { height: rect.height, width: rect.width, top: rect.top, left: rect.left, scrollHeight: node.scrollHeight, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX, overflowY: getComputedStyle(node).overflowY }
  }
  const lanes = document.querySelector('.focus-project-lanes__rows')
  const rect = lanes.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + 30, rect.top + Math.min(20, rect.height / 2))
  const right = document.querySelector('#focus-workspace-slot .workbench-region')
  const rightRect = right.getBoundingClientRect()
  const rightHit = document.elementFromPoint(rightRect.left + rightRect.width / 2, rightRect.top + rightRect.height / 2)
  return { lanes: inspect('.focus-project-lanes__rows'), tracks: inspect('.recent-focus__viewport'), track: inspect('.focus-project-lanes__track'), body: inspect('#focus-workspace-slot .workbench-region'), slot: inspect('#focus-workspace-slot'), timeline: inspect('.recent-focus'), main: inspect('.global-focus-layout'), leftHit: Boolean(hit?.closest('.focus-project-lanes')), rightHit: Boolean(rightHit?.closest('#focus-workspace-slot')), terminal: Boolean(document.querySelector('#focus-workspace-slot .xterm')), hydrating: Boolean(document.querySelector('#focus-workspace-slot .terminal-view__xterm--hydrating')), regionIds: [...document.querySelectorAll('#focus-workspace-slot [data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId) }
}
