import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type {
  AgentMuxAgentSession,
  AgentMuxStoredAgentSession
} from '../src/types.js'

function session(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'readiness-1',
      run: { runId: 'run-1' },
      outputCursorBytes: 0,
      readyThroughByte: 12
    }
  }
}

function run(acceptedInputBytes = 0): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 42,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 12,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

async function coordinatorFixture(stored = session()) {
  const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
  await registry.put(stored)
  const currentRun = run()
  const kernel = {
    identity: () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' }),
    input: vi.fn(async (_runId: string, operation: { expectedByte: number; data: string }) => ({
      run: run(operation.expectedByte + Buffer.byteLength(operation.data)),
      appliedByteRange: {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      }
    }))
  }
  const screenEvidence = { wait: vi.fn(async () => 1) }
  const coordinator = new AgentPromptSubmissionCoordinator({
    kernel: kernel as never,
    providers: new AgentProviderRegistry(),
    registry,
    publisher: new AgentMuxClientEventPublisher(),
    agentInputCursors: new Map(),
    screenEvidence: screenEvidence as never,
    requireAgentSession: (agentSessionId: string) => registry.get(agentSessionId),
    assertAgentRun: () => {},
    updateExactAgentSession: async (agentSessionId, expectedRun, update) => (
      await registry.update(agentSessionId, expectedRun, update)
    )
  })
  return { registry, coordinator, currentRun, kernel, screenEvidence }
}

describe('prompt readiness refusal diagnostics', () => {
  it('reports the observed Run and pending epoch when no readiness can be consumed', async () => {
    const stored = session()
    delete stored.terminalPromptReadiness
    const { coordinator, currentRun, kernel } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('must remain private')

    const refusal = await coordinator.submitInputPlan(
      stored,
      currentRun,
      'submission-not-ready',
      'must remain private',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_NOT_READY',
      detail: expect.stringContaining('runId=run-1 readinessId=none readinessSource=none')
    })
    expect(refusal?.detail).toContain('reason=epoch-missing')
    expect(refusal?.message).not.toContain('must remain private')
    expect(kernel.input).not.toHaveBeenCalled()
  })

  it('reports the owner submission when a readiness epoch was already consumed', async () => {
    const stored = session()
    stored.terminalPromptReadiness = {
      ...stored.terminalPromptReadiness!,
      consumedBySubmissionId: 'submission-owner'
    }
    stored.terminalPromptSubmission = {
      run: { runId: 'run-1' },
      submissionId: 'submission-owner',
      promptDigest: 'a'.repeat(43),
      readinessSource: 'initial-composer',
      readinessId: 'readiness-1',
      readinessOutputCursorBytes: 0,
      readyThroughByte: 12,
      outputCursorBytes: 12,
      payload: {
        operationId: 'payload-owner',
        inputByteRange: { startByte: 0, endByte: 1 },
        acknowledged: true
      },
      submit: {
        operationId: 'submit-owner',
        inputByteRange: { startByte: 1, endByte: 2 },
        acknowledged: true
      }
    }
    const { coordinator, currentRun, kernel } = await coordinatorFixture(stored)
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('must remain private')

    const refusal = await coordinator.submitInputPlan(
      stored,
      currentRun,
      'submission-contender',
      'must remain private',
      plan
    ).then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_READINESS_CONSUMED',
      detail: expect.stringContaining('runId=run-1 readinessId=readiness-1')
    })
    expect(refusal?.detail).toContain('consumedBySubmissionId=submission-owner')
    expect(refusal?.message).not.toContain('must remain private')
    expect(kernel.input).not.toHaveBeenCalled()
  })

  it('reports non-sensitive submission facts when another two-phase prompt is in flight', async () => {
    const original = session()
    const fixture = await coordinatorFixture(original)
    const { registry, currentRun, kernel, coordinator } = fixture
    let releaseRender!: (value: number) => void
    const renderBlocked = new Promise<number>((resolve) => { releaseRender = resolve })
    let payloadAccepted!: () => void
    const payloadObserved = new Promise<void>((resolve) => { payloadAccepted = resolve })
    fixture.screenEvidence.wait.mockImplementation(async () => await renderBlocked)
    kernel.input.mockImplementation(async (_runId: string, operation: { expectedByte: number; data: string }) => {
      payloadAccepted()
      return {
        run: run(operation.expectedByte + Buffer.byteLength(operation.data)),
        appliedByteRange: {
          startByte: operation.expectedByte,
          endByte: operation.expectedByte + Buffer.byteLength(operation.data)
        }
      }
    })
    const current = original as AgentMuxAgentSession
    const plan = new AgentProviderRegistry().get('codex').planPromptInput('secret prompt must not leak')
    const first = coordinator.submitInputPlan(current, currentRun, 'submission-1', 'secret prompt must not leak', plan)
    await payloadObserved

    const refusal = await coordinator.submitInputPlan(current, currentRun, 'submission-2', 'another secret prompt', plan)
      .then(() => null, (error: unknown) => error as AgentMuxError)
    expect(refusal).toBeInstanceOf(AgentMuxError)
    expect(refusal).toMatchObject({
      code: 'AGENT_PROMPT_SUBMISSION_BUSY',
      detail: expect.stringContaining('runId=run-1 activeSubmissionId=submission-1')
    })
    expect(refusal?.detail).not.toContain('secret')
    expect(refusal?.message).not.toContain('secret')
    releaseRender(1)
    await first
    expect(kernel.input).toHaveBeenCalledTimes(2)
  })
})
