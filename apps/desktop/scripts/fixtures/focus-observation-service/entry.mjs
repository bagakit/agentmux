import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

const bridge = window.focusObservationProof, initial = await bridge.initial()
api.sessions.historyPage = bridge.historyPage
api.sessions.historySources = bridge.historySources
api.sessions.observeHistory = async (reference, callback, options) => {
  const handle = await bridge.observe(reference, callback)
  if (options?.signal?.aborted) handle.dispose()
  else options?.signal?.addEventListener('abort', () => handle.dispose(), { once: true })
  return handle
}
const sessions = initial.subjects.map(subject => ({ id: subject.id, kind: 'agent', providerId: 'claude', executorId: 'private', hostId: 'local', workspacePath: initial.path,
  label: subject.label, processState: 'unknown', status: { state: 'unknown', source: 'private-fixture', observedAt: initial.now }, latestOutputBytes: 0,
  createdAt: initial.now, updatedAt: initial.now, capabilities: { terminal: false, timeline: 'none', permission: 'none', providerResume: false, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: subject.id, run: { runId: `private-not-controlled-${subject.id}` } } }))
const contexts = sessions.map(session => ({ id: session.id, name: session.label, detail: 'Reading known native inputs', kind: 'agent', providerId: 'claude', hostId: 'local', topicId: null,
  state: 'unknown', stateLabel: 'Status not observed', processState: 'unknown', bucket: 'idle', workspaceId: 'private-project', workspaceName: 'Private input review', workspacePath: initial.path,
  liveAgent: false, actionable: false, lastActivityAt: null, runId: session.control.run.runId, workingEnteredAt: null }))
const lanes = [{ id: 'private-project', workspaceId: 'private-project', projectId: 'private-project', name: 'Private input review', path: initial.path, labels: ['Private input review'], topicId: null, recovery: null, projectWorkspaceId: 'private-project', summary: null, activeAgentIds: [], contextIds: contexts.map(item => item.id) }]
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {}, workspaces: [{ id: 'private-project', hostId: 'local', name: 'Private input review', path: initial.path, kind: 'folder' }] }, sessions, timelines: {}, tabs: {}, layouts: {}, focusTimelineHeight: 168, agentComposerDrafts: { original: 'Keep the original draft' }, agentFocus: { execution: { sessionId: initial.subjects[0].id, history: [] }, pmo: { sessionId: null } } })
function Scene() {
  const [selected, select] = useState(initial.subjects[0].id)
  window.focusProofSelect = id => { useAppStore.setState({ agentFocus: { execution: { sessionId: id, history: [] }, pmo: { sessionId: null } } }); select(id) }
  return createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
    createElement('section', { style: { flex: 1, padding: 24 } }, createElement('label', null, 'Original draft', createElement('textarea', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', padding: 10, marginTop: 8, width: 'min(380px, 100%)', color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 6 } }))),
    createElement(RecentFocusTimeline, { contexts, lanes, entries: [], currentSessionId: selected, onSelect() { throw new Error('No Context navigation in this private proof') } }))
}
createRoot(document.getElementById('root')).render(createElement(Scene))
