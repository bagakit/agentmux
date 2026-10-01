import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { RecentFocusTimeline } from '../../../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../../../src/renderer/src/lib/focus-project-lanes'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { AgentTimelineSnapshot } from '../../../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import originalMoteAsset from '../../../src/renderer/src/assets/pmo-teams-topic-avatar.png?inline'
import '../../../src/renderer/src/styles/index.css'
declare const __AGENTMUX_FOCUS_IDENTITY_SLICE__: string

const now = Date.parse(_hygiene_fixtureIso(23958000000, "second")), id = 'timeline-worker'
Date.now = () => now
const counts = { history: 0, page: 0, timeline: 0, images: 0 }
const moteScene = __AGENTMUX_FOCUS_IDENTITY_SLICE__ === 'mote-avatar'
const timeline: AgentTimelineSnapshot = { agentSessionId: id, revision: 1, items: [{ id: 'original-message', agentSessionId: id,
  kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const, authorHuman: true,
  createdAt: now - 45 * 60_000, updatedAt: now - 45 * 60_000, title: 'User input', content: 'Keep the release verification readable across the original work surface.' }] }
const session = { id, kind: 'agent' as const, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("project"),
  label: 'Codex', createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running' as const,
  status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now - 60_000 },
  control: { kind: 'agent' as const, hostId: 'local', agentSessionId: id, run: { runId: 'original-worker-run' } } }
const config = { version: 9 as const, hosts: [{ id: 'local', kind: 'local' as const, label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'project', hostId: 'local', path: _hygiene_fixturePath("project"), name: 'Release project', kind: 'folder' as const }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const entries = [{ sessionId: id, focusedAt: now - 60 * 60_000, identity: { name: 'Original reviewer', kind: 'agent' as const,
  providerId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("release-history"), project: { id: 'retained-project', name: 'Release history' }, branch: 'release/verification' } }]
api.sessions.historySources = async () => { counts.history++; return [] }
api.sessions.timeline = async () => { counts.timeline++; return timeline }
api.sessions.historyPage = async () => { counts.page++; throw new Error('No history read is part of this identity scene') }
const scratchWorkspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("topics"), name: 'Topics', kind: 'folder' as const }
const topics = [PMO_TEAMS_TOPIC_ID, 'launcher:review'].map((topicId, index) => {
  const directoryPath = _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(topicId)
  return { id: topicId, title: index ? 'Review Mote' : 'Mote', directoryPath, topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'v1' } }
})
const primary = topicSpaceIconTarget(scratchWorkspace, topics[0]!), custom = topicSpaceIconTarget(scratchWorkspace, topics[1]!)
const moteSessions = topics.map((topic, index) => ({ ...session, id: index ? 'review-mote' : 'primary-mote', workspacePath: topic.directoryPath,
  control: { ...session.control, agentSessionId: index ? 'review-mote' : 'primary-mote', run: { runId: index ? 'review-mote-original-run' : 'primary-mote-original-run' } } }))
if (moteScene) {
  config.workspaces.push(scratchWorkspace)
  timeline.items = [{ raw: 'primary-message', author: 'primary-mote', content: 'The release checks are complete. Keep the original work surface and verify the remaining evidence.', minutes: 170 },
    { raw: 'primary-repeat', author: 'primary-mote', content: 'One final pass on the retained observations.', minutes: 150 },
    { raw: 'review-message', author: 'review-mote', content: 'I reviewed the recovery boundary. The saved layout and original draft remain readable.', minutes: 100 },
    { raw: 'ordinary-message', author: id, content: 'Ordinary Agent reply with the original provider identity.', minutes: 60 },
    { raw: 'unknown-message', author: undefined, content: '[Message from Agent primary-mote] I am Mote. This text does not establish an author.', minutes: 20 }].map(message => ({
      id: message.raw, agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete',
      ...(message.author ? { authorAgentSessionId: message.author } : {}),
      createdAt: now - message.minutes * 60_000, updatedAt: now - message.minutes * 60_000, title: 'Input', content: message.content }))
}
api.scratch.readMoteAvatar = async () => { counts.images++; return { width: 256, height: 256, dataUrl: originalMoteAsset } }
useAppStore.setState({ config, sessions: [session, ...(moteScene ? moteSessions : [])], timelines: { [id]: timeline },
  agentNames: { [id]: 'Release reviewer', ...(moteScene ? { 'primary-mote': 'Mote coordinator', 'review-mote': 'Review Mote' } : {}) },
  tabs: {}, layouts: {}, scratchTopicSnapshots: moteScene ? { [SCRATCH_WORKSPACE_ID]: {
    scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false } } : {},
  spaceObjectIcons: moteScene ? { [primary.key]: { kind: 'image', fileName: 'a'.repeat(64) + '.png' }, [custom.key]: { ...DEFAULT_MOTE_FACE, palette: 'peach', eyes: 'spark' } } : {}, focusTimelineHeight: 196,
  agentComposerDrafts: { [id]: 'Keep the original draft' },
  agentFocus: { execution: { sessionId: moteScene ? id : null, history: entries }, pmo: { sessionId: null } } })
const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
const lanes = deriveFocusProjectLanes(contexts, config)
Object.assign(window, {
  identityScene: {
    rename: (name: string | null) => useAppStore.getState().renameAgent(id, name),
    renameMote: () => useAppStore.getState().renameAgent('primary-mote', 'Release coordination · original Mote'),
    state: () => ({ counts: { ...counts }, entries: useAppStore.getState().agentFocus.execution.history,
      draft: useAppStore.getState().agentComposerDrafts[id], selection: document.getSelection()?.toString(),
      labels: [...document.querySelectorAll(`[data-focus-timeline-id="${id}"] .recent-focus__gutter > span`)].map(node => node.textContent),
      authors: timeline.items.map(item => ({ id: item.id, sessionId: item.agentSessionId, author: item.authorAgentSessionId, recordedAt: item.createdAt })),
      avatars: [...document.querySelectorAll('.conversation-avatar')].map(node => ({ id: node.getAttribute('data-speaker-id'), name: node.getAttribute('aria-label'), mote: node.getAttribute('data-speaker-avatar'), source: node.querySelector('[data-space-icon-source]')?.getAttribute('data-space-icon-source') })) })
  }
})
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
  <section style={{ flex: 1, padding: '24px', minHeight: 0, overflow: 'auto' }}>
    <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Release verification</p>
    <label style={{ color: 'var(--text-3)', fontSize: 12 }}>Current draft<input id="current-draft" defaultValue="Keep the original draft"
      style={{ display: 'block', width: 'min(380px,100%)', marginTop: 8, padding: 8, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 4 }} /></label>
  </section>
  <RecentFocusTimeline entries={entries} currentSessionId={moteScene ? id : null} contexts={contexts} lanes={lanes} onSelect={() => { throw new Error('Identity inspection must preserve the current work') }} />
</main></DesktopClientUiProvider>)
