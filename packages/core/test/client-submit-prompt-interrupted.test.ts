import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type {
  AgentMuxStoredAgentSession
} from '../src/types.js'

// Drive the real client/coordinator/evidence store; only ctxmux I/O is replaced.
const RUN_ID = 'submit-run'
const AGENT_SESSION_ID = 'submit-agent'
const WORKSPACE = '/tmp/submit-agent'

// initial-composer readiness normalization requires readyThroughByte to be strictly greater than the
// epoch's outputCursorBytes, so it cannot be 0.
const READY_READINESS = {
  source: 'initial-composer' as const,
  id: 'submit-epoch-1',
  run: { runId: RUN_ID },
  outputCursorBytes: 0,
  readyThroughByte: 7
}

// The pass-through fixture: an epoch present but never observed (no readyThroughByte). `claimPromptReadiness`
// refuses it synchronously with AGENT_PROMPT_NOT_READY — a fail-closed refusal that must survive unmapped.
const UNOBSERVED_READINESS = {
  source: 'initial-composer' as const,
  id: 'submit-epoch-1',
  run: { runId: RUN_ID },
  outputCursorBytes: 0
}

function storedSession(
  readiness: NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']>
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: WORKSPACE,
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-submit',
    hookToken: 'token-submit',
    outputCursorBytes: 0,
    terminalPromptReadiness: readiness,
    createdAt: 100,
    updatedAt: 100
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
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
  screenEvidence: AgentScreenEvidenceStore
}

async function submitClient(
  readiness: NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']>
): Promise<{
  client: AgentMuxClient
  state: Internals
  observeCalls: () => number
  discardEvidence: () => void
  writes: string[]
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession(readiness))
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let observeCalls = 0
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  // serializeAgentInput reads the authoritative Run through kernel.status; keep it running with a byte
  // cursor of 0 so the two-phase claim starts its payload at byte 0.
  let cursor = 0
  const writes: string[] = []
  state.kernel.status = async () => runProjection(cursor)
  state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return {
      run: runProjection(cursor),
      appliedByteRange: { startByte: operation.expectedByte, endByte: cursor }
    }
  }
  // Empty replay ⇒ the screen has no composer text ⇒ the render predicate never matches ⇒ the wait parks.
  // That parked wait is exactly what a discard cancels.
  state.kernel.observeOutput = async () => {
    observeCalls += 1
    return { run: runProjection(0), replay: [], gap: null, close: async () => {} }
  }
  ;(client as unknown as { connected: boolean }).connected = true

  return {
    client,
    state,
    writes,
    observeCalls: () => observeCalls,
    // The production trigger of this exact CANCELLED: discarding the long-lived evidence out from under
    // the parked render wait — precisely what resizeAgent/handleConnectionLost do.
    discardEvidence: () => { state.screenEvidence.discard(AGENT_SESSION_ID) }
  }
}

describe('submitAgentPrompt during screen replacement', () => {
  it('finishes the original accepted prompt and persists a visible degradation instead of leaving it busy', async () => {
    const fixture = await submitClient(READY_READINESS)
    const input = { agentSessionId: AGENT_SESSION_ID, operationId: 'op-1', prompt: 'ship it' }
    const submitted = fixture.client.submitAgentPrompt(input)
    await vi.waitFor(() => expect(fixture.observeCalls()).toBe(1))
    fixture.discardEvidence()
    await expect(submitted).resolves.toBeUndefined()
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes[1]).toBe('\r')
    const session = fixture.client.agentSessions()[0]!
    expect(session.terminalPromptSubmission).toMatchObject({
      submissionId: 'op-1', payload: { acknowledged: true }, submit: { acknowledged: true }
    })
    expect(session.terminalPromptDelivery).toMatchObject({
      reason: 'screen-evidence-replaced', submissionId: 'op-1', run: { runId: RUN_ID }
    })
    // The same operation can be retried without duplicating either phase.
    await fixture.client.submitAgentPrompt(input)
    expect(fixture.writes).toHaveLength(2)
  })

  it.each(['exited', 'unknown'] as const)('does not send Enter if the authoritative Run becomes %s', async (state) => {
    const fixture = await submitClient(READY_READINESS)
    const submitted = fixture.client.submitAgentPrompt({
      agentSessionId: AGENT_SESSION_ID, operationId: 'op-dead', prompt: 'ship it'
    }).then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(fixture.observeCalls()).toBe(1))
    fixture.state.kernel.status = async () => {
      if (state === 'unknown') throw new AgentMuxError('Connection lost', 'CTXMUX_DISCONNECTED')
      return { ...runProjection(0), state: { type: 'exited', exitCode: 1 } }
    }
    fixture.discardEvidence()
    expect(await submitted).toBeInstanceOf(AgentMuxError)
    expect(fixture.writes).toHaveLength(1)
    expect(fixture.client.agentSessions()[0]!.terminalPromptDelivery).toBeUndefined()
  })

  it('preserves readiness refusal and its diagnostics before any input is sent', async () => {
    const fixture = await submitClient(UNOBSERVED_READINESS)
    await expect(fixture.client.submitAgentPrompt({
      agentSessionId: AGENT_SESSION_ID, operationId: 'op-2', prompt: 'ship it'
    })).rejects.toMatchObject({ code: 'AGENT_PROMPT_NOT_READY', detail: expect.stringContaining('observation-pending') })
    expect(fixture.writes).toEqual([])
  })
})
