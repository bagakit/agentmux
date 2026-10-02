import { createElement as h } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { seedMoteWorkface, moteTopics, customMoteId, scratchWorkspace } from '../../../test/fixtures/mote-workface'
import { MoteWorkface } from '../../../src/renderer/src/components/MoteWorkface'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { scratchTopicLogicalPath } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

seedMoteWorkface()
const topic = moteTopics.find(topic => topic.id === customMoteId)
const root = scratchTopicLogicalPath(scratchWorkspace, topic)
if (!root) throw new Error('Original rawFS Mote scope must be known')
const reads = [], controls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
const names = ['SOUL.md', 'topic.md', 'research.md', 'meeting-notes.md', 'references']
api.files.readDirectory = async (workspaceId, path) => {
  reads.push({ workspaceId, path })
  if (workspaceId !== scratchWorkspace.id || path !== root) throw new Error('Unexpected materials resource scope')
  return names.map(name => ({ name, path: root + '/' + name, isDirectory: name === 'references', isSymlink: false }))
}
api.scratch.listTopics = async () => moteTopics
window.agentmux = { git: { status: async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: scratchWorkspace.path }) } }
for (const key of Object.keys(controls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { controls[key]++; return original(...args) } }
const originalState = useAppStore.getState(), request = { topicId: topic.id, token: {} }
// Only the unrelated conversation paint is isolated. The real Mote wrapper,
// material action owner, Explorer, original hook, controls and CSS are consumed.
const child = h('section', { 'data-original-child': '', style: { padding: '24px', height: '100%' } },
  h('small', {}, 'Private materials fixture · discussion paint isolated'),
  h('textarea', { 'aria-label': 'Retained original child draft', readOnly: true, value: 'Analyst unsent',
    style: { width: '90%', marginTop: '20px', minHeight: '90px' } }))
createClientUiRoot(document.getElementById('root')).render(h(MoteWorkface,
  { workspaceId: scratchWorkspace.id, topicId: topic.id, materialsRequest: request, visible: true }, child))
window.workfaceExplorerProof = { ready: true, root, workspaceId: scratchWorkspace.id, topicId: topic.id,
  title: topic.title, names, facts() { const state = useAppStore.getState(); return { reads: [...reads], controls: { ...controls },
    originalFocus: state.agentFocus === originalState.agentFocus,
    originalControls: state.sessions.every((session, index) => session.control === originalState.sessions[index].control),
    originalDrafts: state.agentComposerDrafts === originalState.agentComposerDrafts,
    activeWorkspaceId: state.activeWorkspaceId, drafts: state.agentComposerDrafts } } }
