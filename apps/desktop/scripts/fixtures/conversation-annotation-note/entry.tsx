import { createRoot } from 'react-dom/client'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

const id = 'private-annotation-agent'
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id, kind: 'agent', hostId: 'local', workspacePath: '/private-annotation', label: 'Annotation preview',
  providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
  createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'done', source: 'run-process', observedAt: 1 },
  latestOutputBytes: 0, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'private-annotation-run' } }
}
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private preview' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'preview-project', hostId: 'local', path: '/private-annotation', kind: 'folder', name: 'Private preview' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const text = `## Make the reading surface useful

The first repeated phrase is background. The second repeated phrase is the passage we want to discuss.

The annotation should stay attached to **the selected words**, with a light underline and a note beside the reading area. It must keep the original message, not guess the first matching phrase.

### A small, complete change

Keep the Markdown nodes and the actual selection. At narrow widths the note can sit below the reading area, leaving the passage visible and the reply draft available.

The user decides when to send. Adding the note only appends the original message ID, quote and note to the existing draft.

${Array.from({ length: 20 }, (_, n) => `Reading context ${n + 1}. Scroll this same message; its source identity and selected text remain unchanged.`).join('\n\n')}`
const page: AgentSessionHistoryPage = {
  agentSessionId: id, source: { providerId: 'codex', nativeSessionId: 'private-native-annotation' },
  items: [{ id: 'native-annotation-original', kind: 'assistant-message', contentParts: [
    { kind: 'reasoning', text: 'A preceding disclosure can move the actual text Range without resizing the reading viewport. '.repeat(8) },
    { kind: 'text', text }
  ] }], nextCursor: null
}
const controls: string[] = [], reads: unknown[] = [], pauses: unknown[] = []
api.sessions.historyPage = async (control, options) => { reads.push({ control, options }); return page }
api.continuousProgress.pauseForInput = async control => { pauses.push(control) }
for (const method of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) {
  api.sessions[method] = async () => { controls.push(method); throw new Error(`Private preview forbids ${method}`) }
}
useAppStore.setState({ config, sessions: [session], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
  viewModes: { [id]: 'activity' }, timelines: { [id]: { agentSessionId: id, revision: 1, items: [{ id: 'live-annotation-original', agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Private message', createdAt: 1, updatedAt: 1, content: text }] } },
  agentNames: {}, agentComposerDrafts: { [id]: 'Keep this existing draft.' }, agentSteerQueues: {} })
const append = useAppStore.getState().appendAgentComposerDraft
Object.assign(window, { annotationPreview: { sessionId: id, runId: session.control.run.runId, controls, reads, pauses,
  draft: () => useAppStore.getState().agentComposerDrafts[id],
  failNextAdd() {
    let failed = false
    useAppStore.setState({ appendAgentComposerDraft: (sessionId, quote) => {
      if (!failed) { failed = true; throw new Error('Private draft handoff rejected') }
      append(sessionId, quote)
    } })
  }
} })
createRoot(document.getElementById('root')!).render(<main className="annotation-preview">
  <p className="annotation-preview__label">Private Source scene · actual SessionPane / Activity / History · no Agent Run</p>
  <div className="annotation-preview__pane"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'preview-project', tabGroupId: 'preview-group', tabId: 'preview-tab', regionId: 'preview-region' }} /></div>
</main>)
