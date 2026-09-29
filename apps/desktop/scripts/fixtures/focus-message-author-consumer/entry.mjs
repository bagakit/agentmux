import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
// This input is the sealed genuine manual Composer/Main/Core receipt and fresh
// FileStore/public projector output of the owning test, not a constructed author DTO.
const variant = new URL(location.href).searchParams.get('variant')
if (!variant.startsWith('authors')) await import('../focus-timeline-navigation/entry.mjs')
else {
  const producer = JSON.parse(variant === 'authors-crowded' ? __AGENTMUX_FOCUS_AUTHOR_CROWDED_PRODUCER__ : __AGENTMUX_FOCUS_AUTHOR_PUBLIC_PRODUCER__)
  Date.now = () => producer.now
  const counts = { page: 0, timeline: 0, catalog: 0 }, controls = []
  api.sessions.historySources = async () => { counts.catalog++; return producer.sources }
  api.sessions.timeline = async () => { counts.timeline++; return producer.captured }
  api.sessions.historyPage = async () => { counts.page++; return producer.nativePage }
  useAppStore.setState({ sessions: producer.sessions, config: producer.config, agentNames: producer.agentNames, timelines: { [producer.sessionId]: producer.captured }, tabs: {}, layouts: {}, focusTimelineHeight: 176, agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  window.navigationSceneState = () => ({ start: Number(document.querySelector('.recent-focus')?.dataset.windowStart), end: Number(document.querySelector('.recent-focus')?.dataset.windowEnd), counts: { ...counts, projector: Number(window.__focusAuthorProjectorCalls ?? 0) }, controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original, markers: [...document.querySelectorAll('.recent-focus__message')].map(n=>({id:n.dataset.messageId,role:n.dataset.messageAuthor,label:n.getAttribute('aria-label'),title:n.title})), inputs: document.querySelectorAll('[data-input-message-id]').length, hours: Number(document.querySelector('[aria-label="Focus window size"]')?.value) })
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } }, createElement('section', { style: { flex: 1, padding: 24 } }, createElement('label', null, 'Current draft', createElement('input', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', width: 'min(380px,100%)', marginTop: 8, padding: 8, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 4 } }))), createElement(RecentFocusTimeline, { contexts, entries: [], currentSessionId: producer.sessionId, onSelect: id => controls.push(id) })))
}
