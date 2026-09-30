import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SurfaceSwitch } from '../../../src/renderer/src/components/TopRowChrome'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const { sessions } = await api.sessions.snapshot()
const base = sessions[0]
const states = ['working', 'waiting', 'done', 'running', 'disconnected']
const names = ['Compile the parser and validate its output', 'Review filesystem permission', 'Parser review ready', 'Current context', 'Saved context']
const ids = ['working', 'attention', 'result', 'idle', 'offline']
const item = content => ({ items: [{ id: 'activity', kind: 'assistant_message', status: 'complete', title: content, content, createdAt: 1000, updatedAt: 1000 }] })
useAppStore.setState({ config, mainSurface: 'workbench',
  sessions: ids.map((id, index) => ({ ...base, id, status: { ...base.status, state: states[index] } })),
  agentNames: Object.fromEntries(ids.map((id, index) => [id, names[index]])),
  timelines: { working: item('Running the parser checks'), result: item('Parser tests pass') },
  agentFocus: { execution: { sessionId: 'idle', history: [] }, pmo: { sessionId: null } } })
window.updatePreview = () => useAppStore.setState(state => ({
  agentNames: { ...state.agentNames, working: 'Parser ready' },
  sessions: state.sessions.map(session => session.id === 'attention' ? { ...session, status: { ...session.status, state: 'done' } } : session),
  timelines: { ...state.timelines, working: item('Compiled successfully') }
}))
window.previewGeometry = () => {
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
  const tooltip = document.querySelector('#surface-navigation-tooltip-focus')
  return { width: innerWidth, height: innerHeight, footer: rect(document.querySelector('.window-status-bar')),
    button: rect(document.querySelector('.surface-navigation__focus')), tooltip: tooltip ? rect(tooltip) : null,
    content: tooltip ? rect(tooltip.querySelector('.focus-navigation-preview')) : null,
    rows: [...(tooltip?.querySelectorAll('[data-preview-session]') ?? [])].map(node => node.dataset.previewSession),
    counts: Object.fromEntries([...(tooltip?.querySelectorAll('[data-preview-count]') ?? [])].map(node => [node.dataset.previewCount, node.textContent])),
    text: tooltip?.textContent, interactive: tooltip?.querySelectorAll('button, input, [tabindex]').length,
    surface: useAppStore.getState().mainSurface, selectedId: useAppStore.getState().agentFocus.execution.sessionId }
}
createRoot(document.getElementById('root')).render(createElement('div', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('div', { style: { flex: 1, padding: 24 } }, 'Private fixture · real Focus footer components'),
  createElement('footer', { className: 'window-status-bar' }, createElement('div', { className: 'window-status-bar__surface-switch' }, createElement(SurfaceSwitch)))))
