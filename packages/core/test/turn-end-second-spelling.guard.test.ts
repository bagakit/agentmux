import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { hookResponseFor } from '../src/agent-hook-command.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxStoredAgentSession,
  AgentProviderId,
  NativeHookEnvelope
} from '../src/types.js'

// Synthetic Provider protocol names deliberately differ from every built-in dialect.
const TURN_END_RAW_NAMES = ['fixtureFinished', 'fixture_failed']
const SECOND_SPELLINGS = TURN_END_RAW_NAMES.slice(1)
const provider = defineAgentProvider({
  catalog: { id: 'fixture-provider', label: 'Fixture', executable: 'node', expectedProcess: 'node',
    readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, promptDelivery: 'positional-argv',
    hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
  hook: { rules: [{ events: TURN_END_RAW_NAMES, state: 'done', lifecycleEvent: 'turn-end' }],
    nativeHandle: { sessionIdKeys: ['session_id'] } },
  terminalPromptRender: { frameStart: 'frame', activeComposer: 'composer', frameEnd: 'end' },
  planPromptInput: prompt => ({ kind: 'render-then-submit', payload: prompt, renderedText: prompt, submit: '\r' }),
  buildArgs: (_prompt, args) => [...args]
})

function storedSession(providerId: AgentProviderId = 'fixture-provider'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: fixturePath("repo"),
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-turn-end-guard'.padEnd(43, 'A'),
    hookToken: 'token-turn-end-guard'.padEnd(43, 'B'),

    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-1' }
  }
}

function runningRun(): CtxmuxAdapterRun {
  return {
    nativeService: null,
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: fixturePath("repo"),
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 7,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

function hook(receiptId: string, eventName: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId: 'fixture-provider',
    eventName,
    payload: { hook_event_name: eventName, tool_name: 'shell', session_id: 'native-1' }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  promptSubmission: { observeReadiness(...args: unknown[]): void }
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}

async function driveTurnEnd(eventName: string): Promise<{
  readiness: AgentMuxStoredAgentSession['terminalPromptReadiness']
  observeReadinessCalls: number
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store, providers: [provider] })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => runningRun()
  // 只观察「site 2 是否被走到」，不让它真的去等屏幕证据（那是 fire-and-forget，会开着句柄）。
  const observeSpy = vi
    .spyOn(internals.promptSubmission, 'observeReadiness')
    .mockImplementation(() => {})
  try {
    await internals.acceptHookEvent(hook(`receipt-${eventName}`, eventName), AbortSignal.timeout(5_000))
    const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
    const session = sessions.find((s) => s.agentSessionId === 'agent-1')
    return {
      readiness: session?.terminalPromptReadiness,
      observeReadinessCalls: observeSpy.mock.calls.length
    }
  } finally {
    observeSpy.mockRestore()
    await client.dispose()
  }
}

describe('Provider-declared turn-end consumption', () => {
  it('keeps passive native responses scoped to their original Provider protocol', () => {
    expect(hookResponseFor('antigravity', 'Stop')).toBe('{"decision":""}\n')
    expect(hookResponseFor('antigravity', 'StopFailure')).toBe('{"decision":""}\n')
    for (const name of TURN_END_RAW_NAMES) expect(hookResponseFor('antigravity', name)).toBe('{}\n')
  })

  it('consumes each declared finalizer through the Core Hook owner without raw-name branching', async () => {
    expect(SECOND_SPELLINGS).toHaveLength(1)
    for (const name of TURN_END_RAW_NAMES) {
      const effect = await driveTurnEnd(name)
      expect(effect.readiness?.source).toBe('native-stop')
      expect(effect.observeReadinessCalls).toBeGreaterThan(0)
    }
  })
})
