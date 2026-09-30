import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
// Presentation transport only. Real public Reader and FileStore are covered by
// the actual owning fixture; this scene cannot sign Run or restart continuity.
const now = Date.now(), HOUR = 3_600_000, id = 'width-archive'
const counts = { catalog: 0, page: 0, timeline: 0 }, controls = []
const identity = (name, project) => ({ name, kind: 'agent', providerId: 'claude', hostId: 'private', workspacePath: '/private/' + project, project: { id: project, name: project === 'alpha' ? 'Alpha · 产品交互与长名称' : 'Beta · 已归档工作记录' } })
const entries = [{ sessionId: id, focusedAt: now - HOUR, identity: identity('进行中的功能设计与实现', 'alpha') },
  { sessionId: 'width-two', focusedAt: now - 2 * HOUR, identity: identity('性能与连续阅读验证', 'alpha') },
  { sessionId: 'width-three', focusedAt: now - HOUR / 2, identity: identity('交付与问题跟踪', 'beta') }]
const native = Array.from({ length: 90 }, (_, i) => ({ id: `width-native-${i}`, kind: 'user-message', startedAt: now - HOUR - i * 1000, contentParts: [{ kind: 'text', text: `Original retained width task ${i}: preserve the body, selection, and source window.` }] }))
api.sessions.historySources = async () => { counts.catalog++; return [{ hostId: 'private', agentSessionId: id, state: 'retired', history: { providerId: 'claude', executorId: 'private', workspacePath: '/private/alpha', createdAt: 1 } }] }
api.sessions.timeline = async () => { counts.timeline++; return { agentSessionId: id, revision: 1, items: [{ id: 'captured-width', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: now - HOUR, updatedAt: now - HOUR, title: 'Input', content: 'Original captured width task: keep the source visible.' }] } }
api.sessions.historyPage = async (reference, options) => { counts.page++; const start = options?.cursor ? Number(options.cursor.slice(5)) : 0; return { agentSessionId: reference.agentSessionId, source: { providerId: 'claude', nativeSessionId: 'native-width' }, items: native.slice(start, start + 30), nextCursor: start + 30 < native.length ? `page-${start + 30}` : null } }
useAppStore.setState({ config: null, sessions: [], timelines: {}, tabs: {}, layouts: {}, focusTimelineNameWidth: 112, focusTimelineHeight: 184, agentComposerDrafts: { original: 'Keep the original width draft' }, agentFocus: { execution: { sessionId: null, history: entries }, pmo: { sessionId: null } } })
window.widthSceneState = () => ({ counts: { ...counts }, controls: [...controls], savedWidth: useAppStore.getState().focusTimelineNameWidth,
  draft: useAppStore.getState().agentComposerDrafts.original, inputs: document.querySelectorAll('[data-input-message-id]').length,
  start: Number(document.querySelector('.recent-focus')?.dataset.windowStart), end: Number(document.querySelector('.recent-focus')?.dataset.windowEnd),
  width: parseFloat(getComputedStyle(document.querySelector('.recent-focus')).getPropertyValue('--focus-name-width')) })
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: '24px', color: 'var(--text-3)' } }, createElement('label', null, 'Original unsent draft', createElement('input', { id: 'width-original-draft', defaultValue: 'Keep the original width draft', style: { display: 'block', marginTop: '8px', padding: '8px', width: 'min(380px, 100%)', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '4px' } }))),
  createElement(RecentFocusTimeline, { contexts: [], entries, currentSessionId: null, onSelect: value => { controls.push(value); throw new Error('Unexpected Context navigation') } })))
