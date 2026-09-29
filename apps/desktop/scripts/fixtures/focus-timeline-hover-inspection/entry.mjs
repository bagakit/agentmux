import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../../../src/renderer/src/lib/focus-project-lanes'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
const producer = JSON.parse(__AGENTMUX_FOCUS_HOVER_PUBLIC_PRODUCER__)
Date.now = () => producer.now
const counts = { page: 0, timeline: 0, catalog: 0, images: 0 }, controls = []
const nativePage = { ...producer.nativePage, items: [...producer.nativePage.items, { id: 'hover-resource-only', kind: 'user-message', startedAt: producer.now - 15 * 60_000,
  contentParts: [{ kind: 'resource', resourceType: 'image', reference: '/recorded/design.png', label: 'Design preview image' }] }] }
api.sessions.historySources = async () => { counts.catalog++; return producer.sources }
api.sessions.timeline = async () => { counts.timeline++; return producer.captured }
api.sessions.historyPage = async () => { counts.page++; return nativePage }
api.ui.readPastedImage = async () => { counts.images++; return null }
useAppStore.setState({ sessions: producer.sessions, config: producer.config, agentNames: producer.agentNames, timelines: { [producer.sessionId]: producer.captured }, tabs: {}, layouts: {}, focusTimelineHeight: 196,
  agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: producer.sessionId, history: [] }, pmo: { sessionId: null } } })
const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts.map(context => ({ ...context, detail: context.id === producer.sessionId ? 'Reviewing timeline interactions and preserving the original input' : context.detail }))
const lanes = deriveFocusProjectLanes(contexts, producer.config).map(lane => ({ ...lane, summary: 'Keep historical work readable while improving the current Focus experience.' }))
const entries = [{ sessionId: 'retained-unknown-context', focusedAt: producer.now - 20 * 60_000 }]
window.hoverSceneState = () => ({ start: Number(document.querySelector('.recent-focus')?.dataset.windowStart), end: Number(document.querySelector('.recent-focus')?.dataset.windowEnd),
  counts: { ...counts, projector: Number(window.__focusHoverProjectorCalls ?? 0) }, controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original, ruler: useAppStore.getState().focusTimelineRuler, nameWidth: { saved: useAppStore.getState().focusTimelineNameWidth, rendered: Number.parseFloat(document.querySelector('.recent-focus')?.style.getPropertyValue('--focus-name-width') ?? '') },
  markers: [...document.querySelectorAll('.recent-focus__message')].map(node => ({ id: node.dataset.messageId, role: node.dataset.messageAuthor })) })
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: 24 } }, createElement('label', null, 'Current draft', createElement('input', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', width: 'min(380px,100%)', marginTop: 8, padding: 8, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 4 } }))),
  createElement(RecentFocusTimeline, { contexts, lanes, entries, currentSessionId: producer.sessionId, onSelect: id => controls.push(id) })))
