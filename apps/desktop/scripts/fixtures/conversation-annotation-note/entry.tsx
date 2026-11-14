import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { parseConversationReadPage, projectConversationReading, type ConversationTimelineReadInput } from '@agentmux/core/conversation'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

const id = 'private-annotation-agent'
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id, kind: 'agent', hostId: 'local', workspacePath: _hygiene_fixturePath("private-annotation"), label: 'Annotation preview',
  providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
  createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'done', source: 'run-process', observedAt: 1 },
  latestOutputBytes: 0, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'private-annotation-run' } }
}
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private preview' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'preview-project', hostId: 'local', path: _hygiene_fixturePath("private-annotation"), kind: 'folder', name: 'Private preview' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const compactEditorScene = new URLSearchParams(location.search).has('compact-editor')
const text = `## Make the reading surface useful

The first repeated phrase is background. The second repeated phrase is the passage we want to discuss.

The annotation should stay attached to **the selected words**, with a light underline and a note beside the reading area. It must keep the original message, not guess the first matching phrase.

### A small, complete change

Keep the Markdown nodes and the actual selection. At narrow widths the note can sit below the reading area, leaving the passage visible and the reply draft available.

The user decides when to send. Adding the note only appends the original message ID, quote and note to the existing draft.

${compactEditorScene ? '' : Array.from({ length: 20 }, (_, n) => `Reading context ${n + 1}. Scroll this same message; its source identity and selected text remain unchanged.`).join('\n\n')}`
const page: AgentSessionHistoryPage = {
  agentSessionId: id, source: { providerId: 'codex', nativeSessionId: 'private-native-annotation' },
  items: [{ id: 'native-annotation-original', kind: 'assistant-message', contentParts: [
    { kind: 'reasoning', text: 'A preceding disclosure can move the actual text Range without resizing the reading viewport. '.repeat(8) },
    { kind: 'text', text }
  ] }], nextCursor: null
}
const controls: string[] = [], reads: unknown[] = [], pauses: unknown[] = []
api.sessions.historyPage = async (control, options) => { reads.push({ control, options }); return page }
const reference = { hostId: session.hostId, agentSessionId: id }
const timeline = projectConversationReading({ agentSessionId: id, routeHostId: session.hostId, executionHostId: session.hostId, historyPage: page }).timeline
const units = [...timeline.events].reverse().map(event => ({ kind: 'item' as const,
  item: { event, records: timeline.records.filter(record => event.recordIds.includes(record.id)) } }))
function readWindow(input: ConversationTimelineReadInput) {
  return parseConversationReadPage({ ...reference, sourceHostId: session.hostId, scope: timeline.scope, coverage: timeline.coverage,
    order: { ...timeline.order, direction: 'newest-first' }, items: units, nextCursor: null, budgetBytes: input.maxBytes ?? 65536,
    ...(input.processDetails ? { processDetails: input.processDetails } : {}),
    window: { id: 'annotation-window', revision: 1, itemCount: units.length, complete: true, view: input.view ?? 'annotation-view', replay: 'annotation-replay',
      checkpoint: { ...reference, sourceHostId: session.hostId, frontier: { ...reference, scope: timeline.scope, cuts: [] } },
      outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => {
  try { const result = readWindow(input); reads.push({ input, records: result.items.length }); return result }
  catch (error) { reads.push({ input, error: String(error) }); throw error }
}
api.conversation.readConversationChanges = async input => {
  const result = readWindow(input)
  return { ...result, checkpoint: result.window.checkpoint, more: false }
}
api.conversation.observeConversation = async () => {
  const closed = new AbortController()
  return { ...reference, sourceHostId: session.hostId, coverage: timeline.coverage, scope: timeline.scope, closed: closed.signal, dispose() { closed.abort() } }
}
api.conversation.releaseConversationView = async input => ({ ...reference, sourceHostId: session.hostId, viewId: input.view, released: true })
api.continuousProgress.pauseForInput = async control => { pauses.push(control) }
for (const method of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) {
  api.sessions[method] = async () => { controls.push(method); throw new Error(`Private preview forbids ${method}`) }
}
useAppStore.setState({ config, sessions: [session], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
  viewModes: { [id]: 'activity' }, timelines: { [id]: { agentSessionId: id, revision: 1, items: [{ id: 'live-annotation-original', agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Private message', createdAt: 1, updatedAt: 1, content: text }] } },
  agentNames: {}, agentComposerDrafts: { [id]: 'Keep this existing draft.' }, agentSteerQueues: {} })
const append = useAppStore.getState().appendAgentComposerDraft
let rejectNextDraft = false
useAppStore.setState({ appendAgentComposerDraft: (sessionId, quote) => {
  if (rejectNextDraft) {
    rejectNextDraft = false
    throw new Error('Private draft handoff rejected')
  }
  append(sessionId, quote)
} })
mountThemeRuntime(window, config.appearance ?? {})
Object.assign(window, { annotationPreview: { sessionId: id, runId: session.control.run.runId, controls, reads, pauses,
  draft: () => useAppStore.getState().agentComposerDrafts[id],
  theme(appearance: 'dark' | 'light') { updateThemeSelection({ ...config.appearance, appAppearance: appearance }) },
  failNextAdd() { rejectNextDraft = true }
} })
createRoot(document.getElementById('root')!).render(<main className="annotation-preview">
  <p className="annotation-preview__label">Private Source scene · actual SessionPane / Activity / History · no Agent Run</p>
  <div className="annotation-preview__pane"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'preview-project', tabGroupId: 'preview-group', tabId: 'preview-tab', regionId: 'preview-region' }} /></div>
</main>)
