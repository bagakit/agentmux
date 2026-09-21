import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxClient,
  AgentMuxFileAgentSessionStore,
  agentPromptCondition,
  createNumberedTerminalInteractionProtocol,
  defineAgentProvider
} from '../dist/index.js'
import { normalizeStoredAgentSession } from '../dist/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { defaultAgentMuxHookPort } from '../dist/runtime-paths.js'
import { resolveHookEventName } from '../dist/agent-hook-event.js'
import type { AgentMuxStoredAgentSession, AgentProviderId } from '../src/types.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => isolation.homedir
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

const hookScriptPath = join(import.meta.dirname, '../bin/agentmux-hook.js')

describe('Hook event name source end-to-end integration', () => {
  async function createTestHarness(options: {
    mode?: 'single-phase' | 'render-then-submit'
    declaredSource?: { kind: 'payload'; payloadKey: 'hookEventName' | 'hook_event_name' | 'eventName' } | { kind: 'flag' } | { kind: 'generated-code' } | undefined
  }) {
    const root = await mkdtemp(join(tmpdir(), 'amux-evtsrc-'))
    const path = join(root, 'sessions.json')
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    isolation.homedir = join(root, 'home')
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'durable'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', path)

    const providerId = 'synthetic-evtsrc' as AgentProviderId
    const sessionId = 'session-evtsrc'
    const runId = 'run-evtsrc'
    const token = 'k'.repeat(43)

    const provider = defineAgentProvider({
      catalog: {
        id: providerId,
        label: 'Synthetic Event Name Source Provider',
        executable: process.execPath,
        expectedProcess: 'node',
        promptDelivery: 'positional-argv',
        readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
        hookStrategy: { kind: 'native', installation: 'explicit-managed' },
        resumeStrategy: { kind: 'none' },
        acpStrategy: { kind: 'none' },
        capabilities: {
          terminal: true,
          timeline: 'complete-events',
          permission: 'respond',
          providerResume: true,
          replyCorrelation: 'none'
        }
      },
      planManagedHooks: () => ({ providerId, mutations: [] }),
      buildArgs: (_prompt, args) => [...args],
      ...(options.mode === 'render-then-submit'
        ? {
            terminalPromptRender: { frameStart: '\u001b[?2026h', frameEnd: '\u001b[?2026l', activeComposer: '›' },
            planPromptInput: (prompt: string) => ({
              kind: 'render-then-submit' as const,
              payload: prompt,
              renderedText: prompt,
              submit: '\r'
            })
          }
        : {}),
      hook: {
        ...(options.declaredSource ? { eventNameSource: options.declaredSource } : {}),
        nativeHandle: { sessionIdKeys: ['session_id'] },
        rules: [
          { events: ['PreToolUse', 'pre_tool_use'], state: 'waiting', toolNames: ['askuserquestion', 'request_user_input'], lifecycleEvent: 'tool-use-start' },
          { events: ['PreToolUse', 'pre_tool_use'], state: 'working', lifecycleEvent: 'tool-use-start' },
          { events: ['PostToolUse', 'post_tool_use'], state: 'working', lifecycleEvent: 'tool-use-end' },
          { events: ['Stop'], state: 'unknown', matches: (p) => p.phase === 'provisional', lifecycleEvent: null },
          { events: ['Stop'], state: 'done', lifecycleEvent: 'turn-end' },
          { events: ['StopCancelled'], state: 'unknown', lifecycleEvent: 'turn-end' }
        ]
      },
      interaction: createNumberedTerminalInteractionProtocol({
        questionEvents: ['PreToolUse', 'pre_tool_use'],
        questionTools: ['askuserquestion', 'request_user_input'],
        questionCompletionEvents: ['PostToolUse', 'post_tool_use'],
        permissionOptions: [
          { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' },
          { id: 'deny', label: 'Deny', kind: 'reject-once', input: '2' }
        ]
      })
    })

    let cursor = 0
    let outputCursor = 0
    const chunks: OutputChunk[] = []
    const streams = new Set<{ push(event: RunEvent): void; close(): void }>()
    const capturedLaunchEnvs: Array<Record<string, string>> = []

    const run = () => ({
      id: runId,
      spec: { program: 'synthetic-agent', args: [], cwd: workspacePath, env: {} },
      lineage: null,
      pid: 456,
      state: { type: 'running' as const },
      latest_output_bytes: outputCursor,
      durable_output_bytes: outputCursor,
      first_available_byte: 0,
      attachments: streams.size,
      applied_input_bytes: cursor,
      current_size: { cols: 80, rows: 24 }
    })

    const knownRuns = new Map<string, ReturnType<typeof run>>()
    knownRuns.set(runId, run())
    let runCounter = 0
    const start = vi.fn(async (op: { env?: Record<string, string> }) => {
      if (op.env) capturedLaunchEnvs.push({ ...op.env })
      const newRunId = `run-started-${++runCounter}`
      const newRun = { ...run(), id: newRunId }
      knownRuns.set(newRunId, newRun)
      return newRun
    })
    const stop = vi.fn(async () => run())
    const status = vi.fn(async (id: string) => knownRuns.get(id) ?? { ...run(), id })
    const recoverableInput = vi.fn(async (op: { operationKey: string; expectedByte: number; data: string }) => {
      const receipt = { start_byte: cursor, end_byte: cursor + Buffer.byteLength(op.data), data: op.data }
      cursor = receipt.end_byte
      return { run: run(), receipt }
    })
    const attachTerminal = vi.fn(async () => {
      let closed = false
      let wake: (() => void) | undefined
      const queue: RunEvent[] = []
      const stream = {
        push(event: RunEvent) {
          queue.push(event)
          wake?.()
        },
        close() {
          closed = true
          wake?.()
          streams.delete(stream)
        }
      }
      streams.add(stream)
      return {
        snapshot: {
          run: run(),
          resize_revision: 0,
          terminal: { type: 'basic_vt', checkpoint: { run_id: runId, through_byte: 0, resize_revision: 0, size: { cols: 80, rows: 24 } }, resizes: [] },
          terminal_restore: new TextEncoder().encode('\u001bc'),
          replay: { chunks: [...chunks], first_available_byte: 0, latest_output_bytes: outputCursor, truncated: false }
        },
        async *events() {
          while (!closed) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>((res) => { wake = res })
          }
        },
        detach: async () => stream.close(),
        close: () => stream.close()
      }
    })

    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, {
      kind: 'agent',
      agentSessionId: sessionId,
      providerId,
      executorId: providerId,
      hostId: 'local',
      workspacePath,
      run: { runId },
      retiredRuns: [],
      hookBindingId: 'b'.repeat(43),
      hookToken: token,
      createdAt: 1,
      updatedAt: 1,
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 }
    })

    const clients: AgentMuxClient[] = []
    async function createClient() {
      const client = new AgentMuxClient({
        store: new AgentMuxFileAgentSessionStore(path),
        providers: [provider]
      })
      const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter, {
        client: {
          list: async () => [...knownRuns.values()],
          status,
          recoverableInput,
          attachTerminal,
          start,
          stop
        },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })
      clients.push(client)
      await client.connect()
      return client
    }

    const client = await createClient()

    async function runHookChild(
      payload: Record<string, unknown>,
      extraArgs: string[] = [],
      customEnv: Record<string, string> = {}
    ): Promise<{ stdout: string; stderr: string; code: number | null }> {
      const cleanEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('AGENTMUX_')) {
          cleanEnv[k] = v
        }
      }
      const hookUrl =
        (client as unknown as { hookServer: { getEndpoint(): { url: string } | null } }).hookServer.getEndpoint()?.url ??
        `http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`
      const childEnv: Record<string, string> = {
        ...cleanEnv,
        AGENTMUX_ENV: '1',
        AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
        AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
        AGENTMUX_HOOK_URL: hookUrl,
        AGENTMUX_HOOK_TOKEN: token,
        AGENTMUX_AGENT_SESSION_ID: sessionId,
        AGENTMUX_PROVIDER_ID: providerId,
        ...customEnv
      }

      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hookScriptPath, ...extraArgs], {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += d })
        child.stderr.on('data', (d) => { stderr += d })
        child.on('error', reject)
        child.on('close', (code) => { resolve({ stdout, stderr, code }) })
        child.stdin.end(JSON.stringify(payload))
      })
    }

    async function getStoredSession(): Promise<AgentMuxStoredAgentSession> {
      const rows = (await new AgentMuxFileAgentSessionStore(path).load()).map(normalizeStoredAgentSession)
      expect(rows).toHaveLength(1)
      return rows[0]!
    }

    const close = async () => {
      for (const c of clients) await c.dispose()
      for (const stream of streams) stream.close()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }

    return {
      client,
      createClient,
      providerId,
      sessionId,
      runId,
      token,
      path,
      workspacePath,
      capturedLaunchEnvs,
      runHookChild,
      getStoredSession,
      close
    }
  }

  it('launch and resume deliver declared payload key and clear inherited stale metadata across branches', async () => {
    const payloadHarness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'hookEventName' }
    })
    try {
      await payloadHarness.client.createAgent({
        providerId: payloadHarness.providerId,
        executorId: payloadHarness.providerId,
        workspacePath: payloadHarness.workspacePath,
        agentSessionId: 'sess-launch-payload',
        injectAgentMuxGuide: false,
        env: {
          AGENTMUX_HOOK_PAYLOAD_KEY: 'stale_inherited_key'
        }
      })
      expect(payloadHarness.capturedLaunchEnvs.length).toBeGreaterThan(0)
      const lastPayloadEnv = payloadHarness.capturedLaunchEnvs[payloadHarness.capturedLaunchEnvs.length - 1]!
      expect(lastPayloadEnv.AGENTMUX_HOOK_PAYLOAD_KEY).toBe('hookEventName')
    } finally {
      await payloadHarness.close()
    }

    const flagHarness = await createTestHarness({
      declaredSource: { kind: 'flag' }
    })
    try {
      await flagHarness.client.createAgent({
        providerId: flagHarness.providerId,
        executorId: flagHarness.providerId,
        workspacePath: flagHarness.workspacePath,
        agentSessionId: 'sess-launch-flag',
        injectAgentMuxGuide: false,
        env: {
          AGENTMUX_HOOK_PAYLOAD_KEY: 'stale_inherited_key'
        }
      })
      const lastFlagEnv = flagHarness.capturedLaunchEnvs[flagHarness.capturedLaunchEnvs.length - 1]!
      expect(lastFlagEnv).not.toHaveProperty('AGENTMUX_HOOK_PAYLOAD_KEY')
    } finally {
      await flagHarness.close()
    }

    const genCodeHarness = await createTestHarness({
      declaredSource: { kind: 'generated-code' }
    })
    try {
      await genCodeHarness.client.createAgent({
        providerId: genCodeHarness.providerId,
        executorId: genCodeHarness.providerId,
        workspacePath: genCodeHarness.workspacePath,
        agentSessionId: 'sess-launch-gencode',
        injectAgentMuxGuide: false,
        env: {
          AGENTMUX_HOOK_PAYLOAD_KEY: 'stale_inherited_key'
        }
      })
      const lastGenCodeEnv = genCodeHarness.capturedLaunchEnvs[genCodeHarness.capturedLaunchEnvs.length - 1]!
      expect(lastGenCodeEnv).not.toHaveProperty('AGENTMUX_HOOK_PAYLOAD_KEY')
    } finally {
      await genCodeHarness.close()
    }
  })

  it('child process resolves declared hookEventName despite conflicting hook_event_name and produces waiting question and completes with same resolved name', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'hookEventName' }
    })
    try {
      const conflictingPayload = {
        hook_event_name: 'Stop',
        hookEventName: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_input: { questions: [{ prompt: 'Proceed with changes?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
        tool_use_id: 'tool-question-1'
      }

      await harness.runHookChild(conflictingPayload, [], {
        AGENTMUX_HOOK_PAYLOAD_KEY: 'hookEventName'
      })

      const session = await harness.getStoredSession()
      expect(session.semanticStatus?.state).toBe('waiting')
      expect(session.semanticStatus?.detail).toBe('PreToolUse')

      const live = harness.client.agentSession(harness.sessionId)
      expect(live.pendingInteraction?.request).toMatchObject({
        kind: 'question',
        questions: [{ prompt: 'Proceed with changes?' }]
      })

      // Complete the question interaction using the same declared raw event name
      const completePayload = {
        hook_event_name: 'Stop',
        hookEventName: 'PostToolUse',
        tool_name: 'request_user_input',
        tool_use_id: 'tool-question-1'
      }
      await harness.runHookChild(completePayload, [], {
        AGENTMUX_HOOK_PAYLOAD_KEY: 'hookEventName'
      })

      const completedSession = await harness.getStoredSession()
      expect(completedSession.pendingInteraction?.request).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('child process resolves declared eventName despite conflicting hook_event_name', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'eventName' }
    })
    try {
      const conflictingPayload = {
        hook_event_name: 'StopCancelled',
        eventName: 'Stop'
      }

      await harness.runHookChild(conflictingPayload, [], {
        AGENTMUX_HOOK_PAYLOAD_KEY: 'eventName'
      })

      const session = await harness.getStoredSession()
      expect(session.semanticStatus?.state).toBe('done')
      expect(session.semanticStatus?.detail).toBe('Stop')
    } finally {
      await harness.close()
    }
  })

  it('F1: keeps receipt/trace when declared key is absent, blank, or non-string, omitting eventName from POST body and keeping session state unchanged', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'hookEventName' }
    })
    try {
      const initial = await harness.getStoredSession()
      expect(initial.semanticStatus?.state).toBe('working')

      for (const [name, badPayload] of [
        ['missing', { hook_event_name: 'Stop' }],
        ['blank', { hook_event_name: 'Stop', hookEventName: '   ' }],
        ['nonstring', { hook_event_name: 'Stop', hookEventName: 12345 }]
      ] as const) {
        const rawResolved = resolveHookEventName(undefined, badPayload, { kind: 'payload', payloadKey: 'hookEventName' })
        expect(rawResolved).toBeUndefined()

        const beforeReceiptId = (await harness.getStoredSession()).hookReceipt?.id
        const res = await harness.runHookChild(badPayload, [], {
          AGENTMUX_HOOK_PAYLOAD_KEY: 'hookEventName'
        })
        expect(res.code).toBe(0)
        expect(res.stdout).toBe('{}\n')

        const current = await harness.getStoredSession()
        expect(current.hookReceipt?.eventName).toBe('unknown')
        expect(current.hookReceipt?.id).not.toBe(beforeReceiptId)
        // 未知不能伪造 success/done，状态保持不变
        expect(current.semanticStatus?.state).toBe('working')
        expect(current.terminalPromptReadiness).toBeUndefined()
      }
    } finally {
      await harness.close()
    }
  })

  it('nested declared fields cannot manufacture an event missing from the raw child payload', async () => {
    const keys = ['hookEventName', 'eventName'] as const
    expect(keys).toHaveLength(2)
    for (const payloadKey of keys) {
      const harness = await createTestHarness({ declaredSource: { kind: 'payload', payloadKey } })
      try {
        const payload = { hook_event_name: 'Notification', extra: { [payloadKey]: 'Stop' } }
        expect(resolveHookEventName(undefined, payload, { kind: 'payload', payloadKey })).toBeUndefined()
        const beforeReceiptId = (await harness.getStoredSession()).hookReceipt?.id
        const result = await harness.runHookChild(payload, [], { AGENTMUX_HOOK_PAYLOAD_KEY: payloadKey })
        expect([result.code, result.stdout]).toEqual([0, '{}\n'])
        const session = await harness.getStoredSession()
        expect(session.hookReceipt?.id).toBeDefined()
        expect(session.hookReceipt?.id).not.toBe(beforeReceiptId)
        expect(session.hookReceipt?.eventName).toBe('unknown')
        expect(session.hookReceipt?.lifecycleEvent ?? null).toBeNull()
        expect(session.semanticStatus?.state).toBe('working')
        expect(session.pendingInteraction).toBeUndefined()
        expect(session.terminalPromptReadiness).toBeUndefined()
      } finally {
        await harness.close()
      }
    }
  })

  it('F1: flag missing explicit --event keeps receipt/trace with omitted eventName and does not fabricate Stop', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'flag' }
    })
    try {
      const payload = {
        hook_event_name: 'Stop',
        hookEventName: 'Stop'
      }

      const beforeReceiptId = (await harness.getStoredSession()).hookReceipt?.id
      const res = await harness.runHookChild(payload, [], {
        AGENTMUX_HOOK_EVENT_NAME_SOURCE: 'flag'
      })
      expect(res.code).toBe(0)
      expect(res.stdout).toBe('{}\n')

      const session = await harness.getStoredSession()
      expect(session.hookReceipt?.eventName).toBe('unknown')
      expect(session.hookReceipt?.id).not.toBe(beforeReceiptId)
      expect(session.semanticStatus?.state).toBe('working')
      expect(session.terminalPromptReadiness).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('F2: generated-code and absent sources without explicit name remain unknown and never guess Stop from payload', async () => {
    for (const source of [{ kind: 'generated-code' as const }, undefined]) {
      const harness = await createTestHarness({
        declaredSource: source
      })
      try {
        const payload = {
          hook_event_name: 'Stop',
          eventName: 'Stop'
        }

        const res = await harness.runHookChild(payload, [], {})
        expect(res.code).toBe(0)
        expect(res.stdout).toBe('{}\n')

        const session = await harness.getStoredSession()
        expect(session.hookReceipt?.eventName).toBe('unknown')
        expect(session.semanticStatus?.state).toBe('working')
        expect(session.hookReceipt?.lifecycleEvent ?? null).toBeNull()
        expect(session.terminalPromptReadiness?.source ?? null).toBeNull()
      } finally {
        await harness.close()
      }
    }
  })

  it('explicit flag --event takes priority over payload fields and manages passive stdout', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'flag' }
    })
    try {
      const payload = {
        hook_event_name: 'Stop',
        hookEventName: 'Stop'
      }

      const res = await harness.runHookChild(payload, ['--event', 'PreToolUse'], {})
      expect(res.stdout).toBe('{}\n')

      const session = await harness.getStoredSession()
      expect(session.semanticStatus?.detail).toBe('PreToolUse')
    } finally {
      await harness.close()
    }
  })

  it('provisional Stop with lifecycleEvent null does not invent main turn-end across restart', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'hook_event_name' }
    })
    try {
      const provisionalPayload = {
        hook_event_name: 'Stop',
        phase: 'provisional'
      }
      await harness.runHookChild(provisionalPayload, [], {
        AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name'
      })

      const session = await harness.getStoredSession()
      expect(session.semanticStatus?.state).toBe('working')
      expect(session.promptCompletionAdmission).toBeUndefined()
      expect(session.terminalPromptReadiness).toBeUndefined()

      const freshClient = await harness.createClient()
      const restored = freshClient.agentSession(harness.sessionId)
      expect(restored.semanticStatus?.state).toBe('working')
      expect(restored.promptCompletionAdmission).toBeUndefined()
      expect(restored.terminalPromptReadiness).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('non-success StopCancelled retains manual healthy next round and fresh Client native identity', async () => {
    const harness = await createTestHarness({
      declaredSource: { kind: 'payload', payloadKey: 'hook_event_name' }
    })
    try {
      const cancelledPayload = {
        hook_event_name: 'StopCancelled'
      }
      await harness.runHookChild(cancelledPayload, [], {
        AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name'
      })

      const session = await harness.getStoredSession()
      expect(session.semanticStatus?.detail).toBe('StopCancelled')

      const condition = agentPromptCondition(session)
      expect(condition.expectedRun.runId).toBe(harness.runId)

      const freshClient = await harness.createClient()
      const restored = freshClient.agentSession(harness.sessionId)
      expect(restored.run.runId).toBe(harness.runId)
      expect(restored.nativeHandle?.sessionId).toBeUndefined()
    } finally {
      await harness.close()
    }
  })
})
