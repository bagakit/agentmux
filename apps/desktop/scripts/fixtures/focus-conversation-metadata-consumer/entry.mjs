import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'
const producer = await window.focusMetadataProof.initial(), controls = []
Date.now = () => producer.now
const senderPath = '/private-controlled-focus-peer-own-project'
const sessions = producer.sessions.map(session => session.id === producer.senderId ? { ...session, workspacePath: senderPath } : session)
const config = { ...producer.config, workspaces: [...producer.config.workspaces,
  { id: 'peer-own-project', hostId: 'local', name: 'Peer own project', path: senderPath, kind: 'folder' }] }
const goal = (title, sessionIds) => ({ id: title, title, sessionIds, description: '', status: 'todo', priority: 'normal', projectId: null,
  projectName: null, createdAt: producer.now, updatedAt: producer.now, source: 'session' })
useAppStore.setState({ sessions, config, agentNames: producer.agentNames, timelines: { [producer.sessionId]: producer.captured },
  demands: { sender: goal('Exact sender goal', [producer.senderId]), recipient: goal('Recipient only goal', [producer.sessionId]) },
  tabs: {}, layouts: {}, focusTimelineHeight: 168, agentComposerDrafts: { original: 'Keep the original draft' },
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
window.focusMetadataMissingProject = () => useAppStore.setState({ config: producer.config })
window.focusMetadataSceneState = () => ({ controls: [...controls], draft: useAppStore.getState().agentComposerDrafts.original,
  fullDetailReads: [...(window.__focusMetadataDetailReads ?? [])],
  markerIDs: [...document.querySelectorAll('.recent-focus__message')].map(node => node.dataset.messageId),
  sourceRole: document.querySelector('.recent-focus__message-preview')?.dataset.messageAuthor,
  turn: (() => { const turn = document.querySelector('.recent-focus__message-preview .log-turn'); if (!turn) return null
    return { id: turn.dataset.messageId, role: turn.dataset.speakerRole, direction: turn.dataset.messageDirection,
      relation: turn.dataset.speakerRelation, currentProject: turn.querySelector('[data-project-workspace-id]')?.dataset.projectWorkspaceId,
      body: turn.querySelector('.log-turn__body')?.textContent, details: turn.querySelector('section[aria-label="Message details"]')?.textContent } })() })
const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
createRoot(document.getElementById('root')).render(createElement('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
  createElement('section', { style: { flex: 1, padding: 24 } }, createElement('label', null, 'Original draft',
    createElement('textarea', { id: 'original-draft', defaultValue: 'Keep the original draft', style: { display: 'block', marginTop: 8,
      width: 'min(380px,100%)', padding: 8, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 6 } }))),
  createElement(RecentFocusTimeline, { contexts, entries: [], currentSessionId: producer.sessionId, onSelect: id => controls.push(id) })))
