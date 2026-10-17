import { fixtureEpoch as _followupFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../../../src/shared/contracts'

const root = createRoot(document.getElementById('root')!)
let current = 'pasted-agent'
function mount(id: string) { current = id; root.render(<DesktopClientUiProvider><AgentSessionComposer key={id} sessionId={id} /></DesktopClientUiProvider>) }
Object.assign(window, { pastedProof: {
  setup(config: any) {
    const session = (id: string): Extract<SessionSnapshot, { kind: 'agent' }> => ({ id, kind: 'agent', hostId: 'local', executorId: 'codex', providerId: 'codex', label: 'Paste reader',
      workspacePath: config.workspaces[0].path, processState: 'running', createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1), latestOutputBytes: 0,
      promptSubmissionPredecessor: null, agentSessionUpdatedAt: _followupFixtureEpoch(0, 0, 1),
      status: { state: 'running', source: 'run-process', observedAt: _followupFixtureEpoch(0, 0, 1) },
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'presentation-only-' + id } } })
    useAppStore.setState({ config, sessions: [session('pasted-agent'), session('other-agent')], loading: false,
      agentComposerDrafts: { 'pasted-agent': 'Original draft', 'other-agent': 'Other draft' }, agentSteerQueues: {}, error: null })
    mount('pasted-agent')
  },
  paste(base64: string) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const file = new File([bytes], 'original.png', { type: 'image/png' })
    const transfer = new DataTransfer(); transfer.items.add(file)
    document.querySelector('.tiptap')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  },
  retry() {
    const button = document.querySelector<HTMLButtonElement>('.composer-mailbox .composer-notice__body button,.composer-feedback button')
    if (!button) throw new Error('The original paste retry is unavailable')
    button.click()
  },
  switch() { mount('other-agent') },
  facts() { return { current, drafts: useAppStore.getState().agentComposerDrafts,
    images: [...document.querySelectorAll<HTMLImageElement>('.composer-image img')].map(img => ({ src: img.src, width: img.naturalWidth })),
    failures: [...document.querySelectorAll('.composer-notice,.composer-feedback')].map(node => node.textContent),
    queues: useAppStore.getState().agentSteerQueues } },
  async read(path: string) { return await api.ui.readPastedImage(path) },
  dispose() { root.unmount() }
} })
