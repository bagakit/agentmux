// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-private-terminal="true" /> }))
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { summarizeAgentAttention } from '../src/renderer/src/lib/agent-attention'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const pending = () => ({ ...composerSession(), status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: 2 },
  pendingInteraction: { kind: 'permission' as const, id: 'permission-1', agentSessionId: 'agent-1', title: 'Allow a change?',
    options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }],
    evidence: { source: 'native-hook' as const, observedAt: 2, run: { runId: 'run-agent-1' }, hookReceiptId: 'receipt-1' } } })

it('a self answer does not claim caught up when Core clears the request but still reports waiting', async () => {
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
    vi.spyOn(api.sessions, 'respondInteraction').mockImplementation(async (_control, response) => {
      await client.respondAgentInteraction({ agentSessionId: 'agent-1', expectedRun: session.control.run, response })
    })
    await dom.click('.attention-request-panel .agent-interaction__actions button.is-primary')
    expect(published).toContain('agent-session')
    expect(writes).toEqual(['1'])
    expect(client.agentSession('agent-1').pendingInteraction).toBeUndefined()
    expect(useAppStore.getState().sessions).toHaveLength(1)
    const projected = useAppStore.getState().sessions[0]!
    expect(projected.kind).toBe('agent')
    if (projected.kind !== 'agent') throw new Error('The projected Agent was replaced')
    expect(projected.pendingInteraction).toBeUndefined()
    expect(projected.status.state).toBe('waiting')
    // This controlled transport has no newer Provider status. Clearing a request must not guess
    // working/done; the real native producer/restart proof covers the subsequent status event.
    expect(summarizeAgentAttention(useAppStore.getState().sessions).needsYou).toBe(1)
    expect(dom.container.querySelector('.attention-request-panel .agent-interaction')).toBeNull()
    expect(dom.container.querySelector('.agent-surface .agent-interaction')).toBeNull()
    expect(dom.container.querySelector('.attention-request-panel')?.textContent).toContain('Core has not exposed a typed request')
  } finally { unsubscribe(); await client.dispose() }
})
