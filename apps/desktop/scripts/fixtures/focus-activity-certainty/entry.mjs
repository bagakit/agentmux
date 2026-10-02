import { createElement as h } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import '../../../src/renderer/src/styles/index.css'

const seed = await (await fetch('./public-scene-seed.json')).json()
if (seed.schema !== 'agentmux.activity-certainty-public-scene-seed.v1' || seed.rows.length !== 4) throw new Error('Exact public four-state seed required')
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base || !config.workspaces[0]) throw new Error('Maintained preview presentation shape missing')
const { semanticStatus: _previous, pendingInteraction: _pending, ...presentationBase } = base
const names = { 'scene-bare': 'No activity observation', 'scene-stale': 'Working observation expired',
  'scene-working': 'Confirmed working', 'scene-idle': 'Confirmed idle' }
const sessions = seed.rows.map(({ session, run, capabilities }) => ({ ...presentationBase,
  id: session.agentSessionId, providerId: session.providerId, executorId: session.executorId,
  hostId: session.hostId, workspacePath: session.workspacePath, label: names[session.agentSessionId],
  capabilities, processState: run.state, latestOutputBytes: run.latestOutputBytes,
  status: session.semanticStatus ?? { state: 'running', source: 'run-process', observedAt: run.observedAt },
  ...(session.semanticStatus ? { semanticStatus: session.semanticStatus } : {}),
  control: { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId, run: session.run } }))
const workspace = { ...config.workspaces[0], id: 'activity-certainty-project', name: 'Activity certainty · private proof',
  hostId: seed.rows[0].session.hostId, path: seed.rows[0].session.workspacePath, kind: 'folder' }
if (!sessions.every(session => session.workspacePath === workspace.path)) throw new Error('Exact shared resource facts required')
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path })
api.scratch.listTopics = async () => []
const controls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
for (const key of Object.keys(controls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { controls[key]++; return original(...args) } }
useAppStore.setState({ loading: false, config: { ...config, workspaces: [workspace] }, sessions, timelines: {},
  tabs: {}, layouts: {}, agentNames: names, scratchTopicSnapshots: {}, providerCatalog: [],
  activeWorkspaceId: workspace.id, mainSurface: 'agents', error: null,
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
const original = useAppStore.getState()
createClientUiRoot(document.getElementById('root')).render(h('div', { style: { height: '100%', minHeight: 0, display: 'flex' } }, h(GlobalFocusSurface)))
window.activityCertaintyProof = { ready: true, population: sessions.map(session => session.id), observerNow: seed.observerNow,
  facts() { const state = useAppStore.getState(); return { controls: { ...controls }, originalFocus: state.agentFocus === original.agentFocus,
    originalControls: state.sessions.every((session, index) => session.control === sessions[index].control),
    sessions: state.sessions.map(session => ({ id: session.id, runId: session.control.run.runId, processState: session.processState })) } } }
