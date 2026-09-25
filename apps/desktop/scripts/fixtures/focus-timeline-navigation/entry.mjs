import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

// Typed I/O for presentation only. Real public FileStore/Reader behavior is
// qualified by the owning and original T005 tests, not by this scene transport.
const now = Date.now(), HOUR = 3_600_000, id = 'archive-navigation'
const variant = new URL(location.href).searchParams.get('variant') ?? 'known'
const counts = { page: 0, timeline: 0, catalog: 0 }, controls = []
const identity = (name, project) => ({ name, kind: 'agent', providerId: 'claude', hostId: 'private-host', workspacePath: '/private/work', project: { id: project, name: project === 'alpha' ? 'Alpha' : 'Beta' } })
const entries = variant === 'unknown' ? [] : [{ sessionId: id, focusedAt: now - 2 * HOUR, identity: identity('Archived work', 'alpha') }, { sessionId: id, focusedAt: now - HOUR, identity: identity('Archived work', variant === 'conflict' ? 'beta' : 'alpha') }]
const native = Array.from({ length: 90 }, (_, i) => ({ id: `native-${i}`, kind: 'user-message', startedAt: now - HOUR - i * 1000, contentParts: [{ kind: 'text', text: `Original retained task ${i}: verify the timeline and keep the work readable.` }] }))
api.sessions.historySources = async () => { counts.catalog++; return [{ hostId: 'private-host', agentSessionId: id, state: 'retired', history: { providerId: 'claude', executorId: 'private', workspacePath: '/private/work', createdAt: 1 } }] }
api.sessions.timeline = async () => { counts.timeline++; return { agentSessionId: id, revision: 1, items: [{ id: 'captured', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: now - HOUR, updatedAt: now - HOUR, title: 'Input', content: 'Preserve the original timeline snapshot.' }] } }
api.sessions.historyPage = async (reference, options) => { counts.page++; const start = options?.cursor ? Number(options.cursor.slice(5)) : 0; return { agentSessionId: reference.agentSessionId, source: { providerId: 'claude', nativeSessionId: 'native-private' }, items: native.slice(start, start + 30), nextCursor: start + 30 < native.length ? `page-${start + 30}` : null } }
useAppStore.setState({ config: null, sessions: [], timelines: {}, tabs: {}, layouts: {}, focusTimelineHeight: 176, agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
window.navigationSceneState = () => ({ counts: { ...counts }, controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original, inputs: document.querySelectorAll('[data-input-message-id]').length, markers: document.querySelectorAll('[data-message-id]').length, start: Number(document.querySelector('.recent-focus')?.dataset.windowStart), end: Number(document.querySelector('.recent-focus')?.dataset.windowEnd), hours: Number(document.querySelector('[aria-label="Focus window size"]')?.value), projects: [...document.querySelectorAll('[data-timeline-project]')].filter(node => !node.hidden).map(node => ({ key: node.dataset.timelineProject, title: node.querySelector('strong')?.textContent, tooltip: node.querySelector('button')?.title })) })
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: '24px', color: 'var(--text-3)' } }, createElement('label', null, 'Current draft', createElement('input', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', marginTop: '8px', padding: '8px', width: 'min(380px, 100%)', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '4px' } }))),
  createElement(RecentFocusTimeline, { contexts: [], entries, currentSessionId: null, onSelect: value => { controls.push(value); throw new Error('Unexpected Context navigation') } })))
