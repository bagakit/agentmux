// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-private-terminal="true" /> }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentInteractionCard } from '../src/renderer/src/components/AgentInteractionCard'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice'
import { api } from '../src/renderer/src/lib/api'
import { summarizeAgentAttention } from '../src/renderer/src/lib/agent-attention'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const pending = () => ({ ...composerSession(), status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: 2 },
  pendingInteraction: { kind: 'permission' as const, id: 'permission-1', agentSessionId: 'agent-1', title: 'Allow a change?',
    options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }],
    evidence: { source: 'native-hook' as const, observedAt: 2, run: { runId: 'run-agent-1' }, hookReceiptId: 'receipt-1' } } })
const degraded = () => ({ ...composerSession(), terminalPromptDelivery: {
  state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-replaced' as const,
  submissionId: 'prompt-1', run: { runId: 'run-agent-1' }, observedAt: 2
} })

function Transient() {
  const state = useAppStore()
  return <TransientErrorNotice error={state.error} dismissed={state.errorDismissed} lastError={state.lastError}
    onDismiss={state.dismissError} onReopen={state.reopenError} />
}

it('projects the same persistent delivery cause locally and globally and locates its Session after acknowledgement', async () => {
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  useAppStore.setState({ sessions: [degraded()], loading: false, environmentWarning: undefined,
    runtimeOwnershipWarnings: [], displacedAgentSessionIds: [], noticeReadReceipts: {} })
  await dom.render(<><GlobalSystemNotices /><AgentSessionComposer sessionId="agent-1" /></>)
  const local = dom.container.querySelector('.composer-notice')
  const global = dom.container.querySelector('.global-system-notices__item')
  expect(local).not.toBeNull()
  expect(global).not.toBeNull()
  expect(global!.textContent).toContain(local!.querySelector('strong')!.textContent)
  await dom.click('.global-system-notices__action')
  expect(select).toHaveBeenCalledExactlyOnceWith('agent-1')
  const toggle = new Event('toggle')
  Object.defineProperty(toggle, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.global-system-notices__details')!.dispatchEvent(toggle))
  expect(dom.container.querySelector('.global-system-notices__trigger')?.getAttribute('data-unread')).toBe('false')
  expect(dom.container.querySelector('.global-system-notices__item')?.textContent).toContain('Screen confirmation was interrupted')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(dom.container.querySelector('.global-system-notices__item')).toBeNull()
})

it('the attention view consumes the same native-only response fact as the Session card', async () => {
  useAppStore.setState({ sessions: [{ ...pending(), interactionResponseUnavailableReason: 'Native answer is still being checked.' }] })
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  expect(dom.container.textContent).toContain('Native answer is still being checked.')
  expect(dom.container.querySelector('[aria-label="Agent permission request"]')).toBeNull()
  const terminal = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Open terminal')
  expect(terminal).toBeDefined()
  await act(async () => terminal!.click())
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(select).toHaveBeenCalledExactlyOnceWith('agent-1')
})

it('an answer from another view removes the stale Needs you wording and summary in this mounted view', async () => {
  useAppStore.setState({ sessions: [pending()] })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  expect(dom.container.querySelector('[aria-label="Agent permission request"]')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(summarizeAgentAttention(useAppStore.getState().sessions).needsYou).toBe(0)
  expect(dom.container.querySelector('[aria-label="Agent permission request"]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Needs you')
  expect(dom.container.textContent).toContain('No current request')
  expect(dom.container.querySelector('.attention-request-panel__empty')?.textContent).toContain('No current request')
})

it('a tool failure preserves body and existing attachment, then retries against the latest draft', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(new Error('Picker unavailable')).mockResolvedValueOnce(['/repo/new.png'])
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'Original body @/repo/kept.png' } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(dom.draft()).toBe('Original body @/repo/kept.png')
  expect(dom.container.querySelector('.composer-notice')?.textContent).toContain('Picker unavailable')
  expect(useAppStore.getState().error).toBeNull()
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'New body @/repo/kept.png'))
  await dom.click('.composer-notice__body button')
  expect(choose).toHaveBeenCalledTimes(2)
  expect(dom.draft()).toContain('New body @/repo/kept.png')
  expect(dom.draft()).toContain('@new.png')
  expect(dom.container.querySelector('.composer-notice')).toBeNull()
})

it('dismissed transient replay stays dismissed while the persistent issue remains findable', async () => {
  useAppStore.setState({ sessions: [degraded()], loading: false, runtimeOwnershipWarnings: [], displacedAgentSessionIds: [],
    error: null, lastError: null, errorDismissed: false, environmentWarning: undefined })
  await dom.render(<><Transient /><GlobalSystemNotices /></>)
  await act(async () => useAppStore.getState().reportError(new Error('The receipt was not read'), { kind: 'process-degraded', subject: degraded().control }))
  await dom.click('.error-notice__close')
  await act(async () => useAppStore.getState().reportError(new Error('The receipt was not read'), { kind: 'process-degraded', subject: degraded().control }))
  expect(dom.container.querySelector('.error-notice')).toBeNull()
  expect(dom.container.querySelector('.error-notice__reopen')).not.toBeNull()
  expect(dom.container.querySelector('.global-system-notices__item')?.textContent).toContain('Screen confirmation was interrupted')
})

it('a failed answer stays on the exact card and retries without a window-level error or clearing Core facts', async () => {
  const session = pending()
  useAppStore.setState({ sessions: [session], error: null })
  const respond = vi.spyOn(api.sessions, 'respondInteraction').mockRejectedValueOnce(new Error('Connection receipt unavailable')).mockResolvedValueOnce(undefined)
  await dom.render(<AgentInteractionCard request={session.pendingInteraction}
    onRespond={response => useAppStore.getState().respondInteraction(session.id, response)} />)
  await dom.click('.agent-interaction__actions button.is-primary')
  expect(dom.container.querySelector('.agent-interaction__error')?.textContent).toContain('Connection receipt unavailable')
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().sessions[0]).toEqual(session)
  expect(dom.container.querySelector<HTMLButtonElement>('.agent-interaction__actions button.is-primary')!.disabled).toBe(false)
  await dom.click('.agent-interaction__actions button.is-primary')
  expect(respond.mock.calls).toEqual([[session.control, { kind: 'permission', requestId: 'permission-1', decision: { outcome: 'selected', optionId: 'once' } }],
    [session.control, { kind: 'permission', requestId: 'permission-1', decision: { outcome: 'selected', optionId: 'once' } }]])
  expect(dom.container.querySelector('.agent-interaction__error')).toBeNull()
  expect(useAppStore.getState().sessions[0]).toEqual(session)
})

it('an old rejection cannot release or paint over a new request already being answered', async () => {
  let rejectOld!: (error: Error) => void
  let resolveNew!: () => void
  vi.spyOn(api.sessions, 'respondInteraction').mockImplementationOnce(() => new Promise((_yes, no) => { rejectOld = no }))
    .mockImplementationOnce(() => new Promise(yes => { resolveNew = yes }))
  useAppStore.setState({ sessions: [pending()], error: null })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  await dom.click('.agent-interaction__actions button.is-primary')
  const next = pending()
  next.pendingInteraction.id = 'permission-2'
  await act(async () => useAppStore.setState({ sessions: [next] }))
  await dom.click('.agent-interaction__actions button.is-primary')
  await act(async () => rejectOld(new Error('Old answer rejected late')))
  expect(dom.container.textContent).not.toContain('Old answer rejected late')
  expect(dom.container.querySelector('.attention-request-panel__error')).toBeNull()
  expect(dom.container.querySelector('[data-request-id="permission-2"]')).not.toBeNull()
  expect(dom.container.querySelector<HTMLButtonElement>('.agent-interaction__actions button.is-primary')!.disabled).toBe(true)
  expect(useAppStore.getState().error).toBeNull()
  await act(async () => resolveNew())
  expect(dom.container.querySelector<HTMLButtonElement>('.agent-interaction__actions button.is-primary')!.disabled).toBe(true)
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(dom.container.querySelector('.agent-interaction')).toBeNull()
})

it('a settled local answer error is removed when another view retires its exact request', async () => {
  vi.spyOn(api.sessions, 'respondInteraction').mockRejectedValueOnce(new Error('Answer was refused'))
  useAppStore.setState({ sessions: [pending()], error: null })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  await dom.click('.agent-interaction__actions button.is-primary')
  expect(dom.container.querySelector('.attention-request-panel__error')?.textContent).toContain('Answer was refused')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(dom.container.querySelector('.attention-request-panel__error')).toBeNull()
  expect(dom.container.textContent).not.toContain('Needs you')
  expect(dom.container.querySelector('.attention-request-panel__empty')?.textContent).toContain('No current request')
})

it('the actual Session caller gives a replacement card fresh local state and ignores the retired card failure', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api.sessions, 'respondInteraction').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
  useAppStore.setState({ sessions: [pending()], viewModes: { 'agent-1': 'activity' }, error: null })
  await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group' }} />)
  await dom.click('.agent-interaction__actions button.is-primary')
  const next = pending()
  next.pendingInteraction.id = 'permission-next'
  await act(async () => useAppStore.setState({ sessions: [next] }))
  expect(dom.container.querySelector('[data-request-id="permission-next"]')).not.toBeNull()
  expect(dom.container.querySelector<HTMLButtonElement>('.agent-interaction__actions button.is-primary')!.disabled).toBe(false)
  await act(async () => reject(new Error('Retired card failed late')))
  expect(dom.container.querySelector('.agent-interaction__error')).toBeNull()
  expect(useAppStore.getState().sessions[0]).toEqual(next)
  expect(useAppStore.getState().error).toBeNull()
})

it('a nonempty public Core publication clears both mounted cards without inventing a newer semantic status', async () => {
  const session = pending()
  session.pendingInteraction.options[0]!.id = 'allow-once'
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: session.id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    createdAt: 1, updatedAt: 2, run: session.control.run, retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token',
    pendingInteraction: { request: session.pendingInteraction }
  } as AgentMuxStoredAgentSession)
  const client = new AgentMuxClient({ store })
  // Only native transport is controlled here. Admission, Provider plan, claim, publication and
  // the mounted Store/consumers are real; upstream CLI/physical keyboard is not claimed.
  const internal = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown> }
  await internal.registry.load('local')
  let cursor = 0
  const writes: string[] = []
  const run = () => ({ runId: 'run-agent-1', lifecycleOperationId: null, program: 'codex', args: [], cwd: '/repo', env: {}, workspacePath: '/repo',
    pid: 999, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  internal.connected = true
  internal.kernel.isConnected = () => true
  internal.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 1, buildIdentity: 'private-transport' })
  internal.kernel.status = async () => run()
  internal.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: cursor } }
  }
  const published: string[] = []
  const unsubscribe = client.onEvent(event => {
    published.push(event.type)
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event })
  })
  try {
    useAppStore.setState({ sessions: [session] })
    await dom.render(<><AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />
      <SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible
        linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group' }} /></>)
    expect(dom.container.querySelectorAll('[data-request-id="permission-1"]')).toHaveLength(2)
    expect(summarizeAgentAttention(useAppStore.getState().sessions).needsYou).toBe(1)
    await act(async () => client.respondAgentInteraction({ agentSessionId: 'agent-1', expectedRun: session.control.run,
      response: { kind: 'permission', requestId: 'permission-1', decision: { outcome: 'selected', optionId: 'allow-once' } } }))
    expect(published).toContain('agent-session')
    expect(writes).toEqual(['1'])
    expect(client.agentSession('agent-1').pendingInteraction).toBeUndefined()
    expect(useAppStore.getState().sessions).toHaveLength(1)
    const projected = useAppStore.getState().sessions[0]!
    expect(projected.kind).toBe('agent')
    if (projected.kind !== 'agent') throw new Error('The projected Agent was replaced')
    expect(projected.pendingInteraction).toBeUndefined()
    // This controlled transport has no newer Provider status. Clearing a request must not guess
    // working/done; the real native producer/restart proof covers the subsequent status event.
    expect(summarizeAgentAttention(useAppStore.getState().sessions).needsYou).toBe(1)
    expect(dom.container.querySelector('.attention-request-panel .agent-interaction')).toBeNull()
    expect(dom.container.querySelector('.agent-surface .agent-interaction')).toBeNull()
    expect(dom.container.querySelector('.attention-request-panel')?.textContent).toContain('Core has not exposed a typed request')
  } finally { unsubscribe(); await client.dispose() }
})
