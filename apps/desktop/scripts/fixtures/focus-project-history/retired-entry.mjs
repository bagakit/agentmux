import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
const config = await api.config.get()
useAppStore.setState({ config, sessions: [], timelines: {}, tabs: {}, layouts: {}, mainSurface: 'agents', focusTimelineHeight: 208,
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
window.retiredSourceState = () => ({ members: useAppStore.getState().sessions.length, tracks: [...document.querySelectorAll('[data-focus-timeline-id]')].map(node => ({ id: node.dataset.focusTimelineId, historical: node.dataset.historyOnly })),
  markers: [...document.querySelectorAll('[data-message-id]')].map(node => node.dataset.messageId), inputs: [...document.querySelectorAll('[data-input-message-id]')].map(node => node.dataset.inputMessageId),
  selected: document.querySelector('[aria-label="Input records Context"]')?.value, sources: document.querySelectorAll('[aria-label="Input records Context"] option[value^="archived-"]').length })
const onSelect = () => { throw new Error('A retained history view must never navigate to or resume the recipient') }
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column', padding: '0' } },
  createElement('section', { style: { flex: 1, padding: '24px', color: 'var(--text-3)', fontSize: '13px' } }, 'Private retained-input scene · original Core records, no active Session'),
  createElement(RecentFocusTimeline, { contexts: [], entries: [], currentSessionId: null, onSelect })))
window.retiredSourceReady = true
