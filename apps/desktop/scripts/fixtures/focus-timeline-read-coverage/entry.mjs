import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

// The raw pages/timelines below are the exact JSON emitted by the capture's
// public FileStore/Provider reader. Only Renderer transport is isolated here.
// The current semantic states are typed UI observations, not physical Run proof.
const proof = await fetch('./public-inputs.json').then(response => response.json())
const HOUR = 3_600_000, counts = { page: 0, timeline: 0, catalog: 0 }, controls = []
window.coverageSceneWheelTrace = []
document.addEventListener('wheel', event => queueMicrotask(() => window.coverageSceneWheelTrace.push({
  clientX: event.clientX, clientY: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, shift: event.shiftKey,
  prevented: event.defaultPrevented, target: event.target instanceof Element ? event.target.className : null
})), { passive: true })
const referenceKey = reference => JSON.stringify([reference.hostId, reference.agentSessionId])
const readSource = reference => {
  const found = proof.sources.find(source => referenceKey(source) === referenceKey(reference))
  if (!found) throw new Error('This observed Context has no read source in this private fixture.')
  return found
}
api.sessions.historySources = async () => { counts.catalog++; return proof.sources.map(({ page, timeline, ...source }) => source) }
api.sessions.historyPage = async reference => { counts.page++; return structuredClone(readSource(reference).page) }
api.sessions.timeline = async reference => { counts.timeline++; return structuredClone(readSource(reference).timeline) }
const contexts = Array.from({ length: 13 }, (_, i) => ({ id: `current-${i}`, name: i === 12 ? 'Review 13 · Current Focus' : `Review ${String(i + 1).padStart(2, '0')}`,
  detail: 'Observed current task', state: i === 12 ? 'working' : i === 1 ? 'running' : 'done', stateLabel: i === 12 ? 'Working' : i === 1 ? 'Idle' : 'Done',
  processState: 'running', bucket: i === 12 ? 'working' : 'idle', kind: 'agent', providerId: 'claude', hostId: 'private-host', topicId: null,
  workspaceId: 'project', workspaceName: 'Observed project', workspacePath: '/private/observed', liveAgent: true, actionable: false,
  lastActivityAt: null, runId: `not-controlled-current-${i}`, workingEnteredAt: i === 12 ? proof.now - HOUR : null, workspace: undefined }))
const lanes = [{ id: 'observed-project', workspaceId: 'project', projectId: 'project', name: 'Observed project', path: '/private/observed', labels: ['Observed project'], topicId: null,
  recovery: null, projectWorkspaceId: 'project', summary: null, activeAgentIds: contexts.map(context => context.id), contextIds: contexts.map(context => context.id) }]
const entries = [{ sessionId: 'archive-coverage-a', focusedAt: proof.now - 2 * HOUR, identity: { name: 'Closed review A', kind: 'agent', providerId: 'claude', hostId: 'private-host', workspacePath: proof.sources[0].history.workspacePath, project: { id: 'alpha', name: 'Observed Alpha' } } },
  ...contexts.slice(0, 2).map((context, i) => ({ sessionId: context.id, focusedAt: proof.now - (80 - i * 10) * 60_000,
    identity: { name: context.name, kind: 'agent', providerId: 'claude', hostId: 'private-host', workspacePath: '/private/observed', project: { id: 'project', name: 'Observed project' } } }))]
useAppStore.setState({ config: null, sessions: [], timelines: {}, tabs: {}, layouts: {}, focusTimelineHeight: 168,
  agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
window.coverageSceneState = () => {
  const node = document.querySelector('.recent-focus'), viewport = document.querySelector('.recent-focus__viewport')
  return { counts: { ...counts, projector: globalThis.coverageProjectorCount ?? 0 }, controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original,
    start: Number(node?.dataset.windowStart), end: Number(node?.dataset.windowEnd), read: Number(node?.dataset.readSourceCount), native: Number(node?.dataset.nativeRecordCount), captured: Number(node?.dataset.capturedRecordCount), bytes: Number(node?.dataset.readBytes), trimmed: !!node?.dataset.readingTrimmed,
    tracks: [...document.querySelectorAll('[data-focus-timeline-id]')].map(item => item.dataset.focusTimelineId), markers: [...document.querySelectorAll('.recent-focus__lane [data-message-id]')].map(item => item.dataset.messageId),
    scroll: viewport ? { top: viewport.scrollTop, client: viewport.clientHeight, height: viewport.scrollHeight } : null,
    input: document.querySelector('[aria-label="Input records Context"]')?.value }
}
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: '24px', color: 'var(--text-3)' } }, createElement('label', null, 'Current draft', createElement('input', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', marginTop: '8px', padding: '8px', width: 'min(380px, 100%)', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '4px' } }))),
  createElement(RecentFocusTimeline, { contexts, lanes, entries, currentSessionId: 'current-12', onSelect: value => { controls.push(value); throw new Error('Unexpected Context navigation') } })))
