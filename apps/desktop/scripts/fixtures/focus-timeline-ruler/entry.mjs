import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

// The existing navigation fixture's typed transport; these records are not a
// new public Reader or a Human/Provider Writer qualification.
const recordedAt = Date.parse('2026-10-04T00:00:00Z'), HOUR = 3_600_000, id = 'archive-ruler'
const counts = { page: 0, timeline: 0, catalog: 0 }, controls = []
const identity = { name: 'Archived work', kind: 'agent', providerId: 'claude', hostId: 'private-host', workspacePath: '/private/work', project: { id: 'alpha', name: 'Alpha' } }
const entries = [{ sessionId: id, focusedAt: recordedAt - 2 * HOUR, identity }, { sessionId: id, focusedAt: recordedAt - HOUR, identity }]
const native = Array.from({ length: 90 }, (_, i) => ({ id: `native-${i}`, kind: 'user-message', startedAt: recordedAt - i * 1000, contentParts: [{ kind: 'text', text: `Original retained task ${i}: verify the ruler and keep the work readable.` }] }))
api.sessions.historySources = async () => { counts.catalog++; return [{ hostId: 'private-host', agentSessionId: id, state: 'retired', history: { providerId: 'claude', executorId: 'private', workspacePath: '/private/work', createdAt: 1 } }] }
api.sessions.timeline = async () => { counts.timeline++; return { agentSessionId: id, revision: 1, items: [{ id: 'captured', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: recordedAt, updatedAt: recordedAt, title: 'Input', content: 'Preserve the original timeline snapshot.' }] } }
api.sessions.historyPage = async (reference, options) => { counts.page++; const start = options?.cursor ? Number(options.cursor.slice(5)) : 0; return { agentSessionId: reference.agentSessionId, source: { providerId: 'claude', nativeSessionId: 'native-private' }, items: native.slice(start, start + 30), nextCursor: start + 30 < native.length ? `page-${start + 30}` : null } }
useAppStore.setState({ config: null, sessions: [], timelines: {}, tabs: {}, layouts: {}, focusTimelineHeight: 176, agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
window.rulerSceneState = () => {
  const section = document.querySelector('.recent-focus'), scale = document.querySelector('.recent-focus__time-scale'), viewport = document.querySelector('.recent-focus__viewport'), date = document.querySelector('[aria-label="Focus history date and time"]')
  return { counts: { ...counts }, controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original, ruler: useAppStore.getState().focusTimelineRuler, recordedAt,
    mode: section?.dataset.rulerMode, zone: section?.dataset.timeZone, start: Number(section?.dataset.windowStart), end: Number(section?.dataset.windowEnd), hours: Number(document.querySelector('[aria-label="Focus window size"]')?.value), date: date?.value, invalidDate: date?.getAttribute('aria-invalid'), dateError: document.querySelector('.recent-focus__date-error')?.textContent,
    rows: [...document.querySelectorAll('[data-input-message-id]')].map(n => ({ id: n.dataset.inputMessageId, source: n.dataset.inputSource, time: n.querySelector('small')?.textContent })), bodyId: document.querySelector('[data-input-preview-id]')?.dataset.inputPreviewId, bodyTime: document.querySelector('[data-input-preview-id] .log-turn__time')?.textContent,
    viewport: viewport ? { scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft } : null, scale: scale?.getBoundingClientRect().toJSON(),
    ticks: [...document.querySelectorAll('[data-tick-at]')].map(n => ({ instant: Number(n.dataset.tickAt), tier: n.dataset.tier, title: n.title, rect: n.getBoundingClientRect().toJSON(), label: n.querySelector('time')?.textContent, labelRect: n.querySelector('time')?.getBoundingClientRect().toJSON(), height: Number.parseFloat(getComputedStyle(n, '::after').height) })),
    grid: [...document.querySelectorAll('.recent-focus__grid path')].map(n => ({ tier: n.dataset.tier, d: n.getAttribute('d') })), settingsOpen: !!document.querySelector('.focus-ruler-settings') }
}
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: '24px', color: 'var(--text-3)' } }, createElement('label', null, 'Current draft', createElement('input', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', marginTop: '8px', padding: '8px', width: 'min(380px, 100%)', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '4px' } }))),
  createElement(RecentFocusTimeline, { contexts: [], entries, currentSessionId: null, onSelect: value => { controls.push(value); throw new Error('Unexpected Context navigation') } })))
