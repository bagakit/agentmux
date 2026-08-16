import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const RUN_ID = 'ingress-run'
const AGENT_SESSION_ID = 'ingress-agent'
const WORKSPACE = '/tmp/ingress-agent'

function storedSession(
  extra: Partial<AgentMuxStoredAgentSession> = {}
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: WORKSPACE,
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-ingress',
    hookToken: 'token-ingress',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100,
    ...extra
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'claude',
    args: [] as string[],
    workspacePath: WORKSPACE,
    pid: 321,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

type Internals = {
  kernel: Record<string, unknown>
  registry: { load(hostId: string): Promise<void> }
}

async function ingressClient(
  extra: Partial<AgentMuxStoredAgentSession> = {}
): Promise<{ client: AgentMuxClient; store: AgentMuxFileAgentSessionStore; writes: string[]; setRunState(state: 'running' | 'exited'): void }> {
  const store = new AgentMuxFileAgentSessionStore(join(await mkdtemp(join(tmpdir(), 'agent-mailbox-')), 'sessions.json'))
  roots.push(dirname(store.path))
  await store.compareAndSwap(null, storedSession(extra))
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let cursor = 0
  let runState: 'running' | 'exited' = 'running'
  const writes: string[] = []
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  state.kernel.status = async () => ({
    ...runProjection(cursor),
    state: runState === 'running' ? { type: 'running' as const } : { type: 'exited' as const, exitCode: 0 }
  })
  state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return {
      run: runProjection(cursor),
      appliedByteRange: { startByte: operation.expectedByte, endByte: cursor }
    }
  }
  ;(client as unknown as { connected: boolean }).connected = true

  return { client, store, writes, setRunState: (s) => { runState = s } }
}


describe('durable mailbox attribution', () => {
  it('records actual input author only after delivery and retains it through store reopen', async () => {
    const { client, store, writes } = await ingressClient()
    await client.submitAgentPrompt({ agentSessionId: AGENT_SESSION_ID, operationId: 'agent-send', prompt: 'Review this', authorAgentSessionId: 'reviewer' })
    await client.submitAgentPrompt({ agentSessionId: AGENT_SESSION_ID, operationId: 'user-send', prompt: 'Continue' })
    expect(writes).toEqual(['Review this\r', 'Continue\r'])
    const reopened = new AgentMuxFileAgentSessionStore(store.path)
    const timeline = await reopened.loadTimeline(AGENT_SESSION_ID)
    expect(timeline.items.map(({ id, content, authorAgentSessionId, status }) => ({ id, content, authorAgentSessionId, status }))).toEqual([
      { id: 'prompt:agent-send', content: 'Review this', authorAgentSessionId: 'reviewer', status: 'complete' },
      { id: 'prompt:user-send', content: 'Continue', authorAgentSessionId: undefined, status: 'complete' }
    ])
    expect(await client.sessionTimeline(AGENT_SESSION_ID)).toEqual(timeline)
  })
  it('never claims delivery or creates an inbox item when submission fails', async () => {
    const { client, store, writes, setRunState } = await ingressClient()
    setRunState('exited')
    await expect(client.submitAgentPrompt({ agentSessionId: AGENT_SESSION_ID, operationId: 'failed', prompt: 'Late', authorAgentSessionId: 'reviewer' })).rejects.toThrow()
    expect(writes).toEqual([])
    expect((await store.loadTimeline(AGENT_SESSION_ID)).items).toEqual([])
  })
})
