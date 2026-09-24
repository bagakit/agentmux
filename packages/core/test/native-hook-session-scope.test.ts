import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AgentMuxFileAgentSessionStore,
  AgentProviderRegistry,
  AgentMuxClient,
  defineAgentProvider,
  defaultAgentMuxHookPort,
  type AgentProviderHookNormalizationContext,
  type AgentNativeSessionHandle,
  type AgentMuxStoredAgentSession,
  type NativeHookEnvelope,
  type AgentProvider,
  type AgentTimelineMutation
} from '../src/index.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import {
  normalizeNativeHook,
  releaseSubagentRoster,
  type AgentNativeHookSpecification
} from '../src/hook-normalizer.js'
import { HOOK_PAYLOAD_USAGE_KEY } from '../src/agent-usage-transcript.js'
import { createNumberedTerminalInteractionProtocol } from '../src/agent-interaction.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => isolation.homedir
}))

describe('Provider Native Hook Session Scope & Subject Contract', () => {
  let rootDir: string
  const cleanups: (() => Promise<void> | void)[] = []

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'amux-native-scope-test-'))
    isolation.homedir = join(rootDir, 'home')
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(rootDir, 'runtime'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(rootDir, 'durable'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(rootDir, 'queue.ndjson'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      if (cleanup) await cleanup()
    }
    await rm(rootDir, { recursive: true, force: true })
  })

  describe('Pure Normalizer Unit Contract', () => {
    const runId = 'unit-run-1'
    const agentSessionId = 'unit-session-1'

    afterEach(() => {
      releaseSubagentRoster(runId)
    })

    it('evaluates matchesNativeSession predicate at most once with unflattened raw payload, resolved eventName, and context', () => {
      const predicate = vi.fn(
        (eventName: string, rawPayload: Readonly<Record<string, unknown>>, context: AgentProviderHookNormalizationContext) => {
          expect(eventName).toBe('resolved_event')
          expect(rawPayload.extra).toEqual({ deep_key: 'nested_val' })
          expect(context.nativeHandle?.sessionId).toBe('expected-session-id')
          return true
        }
      )

      const spec: AgentNativeHookSpecification = {
        eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
        matchesNativeSession: predicate,
        rules: [{ events: ['resolved_event'], state: 'working' }]
      }

      const rawEnvelopePayload = {
        hook_event_name: 'resolved_event',
        extra: { deep_key: 'nested_val' }
      }

      const envelope: NativeHookEnvelope = {
        receiptId: 'rcpt-pred-1',
        agentSessionId,
        runId,
        providerId: 'codex',
        eventName: '',
        payload: rawEnvelopePayload
      }

      const context: AgentProviderHookNormalizationContext = {
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'expected-session-id' }
      }

      const normalized = normalizeNativeHook(spec, envelope, context)

      expect(predicate).toHaveBeenCalledTimes(1)
      expect(predicate.mock.calls[0]![0]).toBe('resolved_event')
      expect(predicate.mock.calls[0]![1]).toBe(rawEnvelopePayload)
      expect((predicate.mock.calls[0]![1] as Record<string, unknown>).deep_key).toBeUndefined()
      expect(predicate.mock.calls[0]![2]).toBe(context)
      expect(normalized.mainSubject).toBe(true)
      expect(normalized.semanticState).toBe('working')
    })

    it('foreign scope (matchesNativeSession = false) forces unknown state, null lifecycle, false mainSubject, and no nativeHandle or turnUsage', () => {
      const validUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        observedAt: 100
      }

      const rawPayload = {
        session_id: 'foreign-session-id',
        transcript_path: '/synthetic/foreign.jsonl',
        [HOOK_PAYLOAD_USAGE_KEY]: validUsage
      }

      const envelope: NativeHookEnvelope = {
        receiptId: 'rcpt-foreign-1',
        agentSessionId,
        runId,
        providerId: 'codex',
        eventName: 'turn_stop',
        payload: rawPayload
      }

      const context: AgentProviderHookNormalizationContext = {
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'legit-session-id' }
      }

      // 1. 同原数据 scope=true 正控：确认该 payload 在合法 scope 下确实能提取出非空实际 turnUsage
      const legitSpec: AgentNativeHookSpecification = {
        matchesNativeSession: () => true,
        rules: [
          { events: ['turn_start'], state: 'working', lifecycleEvent: 'turn-start' },
          { events: ['turn_stop'], state: 'done', lifecycleEvent: 'turn-end' }
        ],
        nativeHandle: { sessionIdKeys: ['session_id'], transcriptPathKeys: ['transcript_path'] }
      }
      const legitNormalized = normalizeNativeHook(legitSpec, envelope, context)
      expect(legitNormalized.mainSubject).toBe(true)
      expect(legitNormalized.turnUsage).toEqual(validUsage)
      expect(legitNormalized.nativeHandle).toBeDefined()

      // 2. scope=false 负例：同数据在 foreign scope 下被严格清空
      const foreignSpec: AgentNativeHookSpecification = {
        ...legitSpec,
        matchesNativeSession: () => false
      }
      const foreignNormalized = normalizeNativeHook(foreignSpec, envelope, context)

      expect(foreignNormalized.mainSubject).toBe(false)
      expect(foreignNormalized.semanticState).toBe('unknown')
      expect(foreignNormalized.lifecycleEvent).toBeNull()
      expect(foreignNormalized.nativeHandle).toBeUndefined()
      expect(foreignNormalized.turnUsage).toBeUndefined()
      expect(foreignNormalized.timeline.length).toBeGreaterThan(0)
    })

    it('foreign tool trace uses receipt-based append-only identity and does not upsert or overwrite with toolCallId', () => {
      const spec: AgentNativeHookSpecification = {
        matchesNativeSession: () => false,
        rules: [
          { events: ['PostToolUse'], state: 'working', lifecycleEvent: 'tool-use-end' }
        ]
      }

      const envelope: NativeHookEnvelope = {
        receiptId: 'rcpt-foreign-tool-1',
        agentSessionId,
        runId,
        providerId: 'codex',
        eventName: 'PostToolUse',
        payload: {
          tool_name: 'shell',
          tool_use_id: 'colliding-call-id',
          tool_input: { command: 'ls' },
          tool_output: 'file1.txt',
          status: 'error'
        }
      }

      const context: AgentProviderHookNormalizationContext = {
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'legit-session-id' }
      }

      const normalized = normalizeNativeHook(spec, envelope, context)

      expect(normalized.mainSubject).toBe(false)
      expect(normalized.timeline).toHaveLength(1)
      const mutation = normalized.timeline[0]!
      // Must NOT use 'upsert'
      expect(mutation.type).toBe('append')
      if (mutation.type === 'append') {
        // Must NOT use `${runId}:tool:${toolCallId}`
        expect(mutation.item.id).toBe(`${runId}:rcpt-foreign-tool-1:0`)
        expect(mutation.item.toolName).toBe('shell')
        expect(mutation.item.toolOutput).toBe('file1.txt')
        expect(mutation.item.status).toBe('failed')
      }
    })

    it('positive control: legitimate main scope and child scope retain toolCallId correlation and proper subject identity', () => {
      const spec: AgentNativeHookSpecification = {
        matchesNativeSession: (_event, payload) => payload.session_id === 'legit-main',
        subagentSubject: payload => payload.is_child === true,
        rules: [
          { events: ['PreToolUse'], state: 'working', lifecycleEvent: 'tool-use-start' },
          { events: ['PostToolUse'], state: 'working', lifecycleEvent: 'tool-use-end' },
          { events: ['Stop'], state: 'done', lifecycleEvent: 'turn-end' },
          { events: ['ChildStop'], state: 'unknown' }
        ],
        subagentTracking: {
          startEvents: ['ChildStart'],
          stopEvents: ['ChildStop'],
          mainStopEvents: ['Stop']
        },
        nativeHandle: { sessionIdKeys: ['session_id'] }
      }

      const context: AgentProviderHookNormalizationContext = {
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'legit-main' }
      }

      // 1. Legitimate main tool call
      const mainPre = normalizeNativeHook(spec, {
        receiptId: 'rcpt-m1', agentSessionId, runId, providerId: 'codex', eventName: 'PreToolUse',
        payload: { session_id: 'legit-main', tool_name: 'shell', tool_use_id: 'call-100' }
      }, context)

      expect(mainPre.mainSubject).toBe(true)
      expect(mainPre.nativeHandle).toEqual({ kind: 'provider', providerId: 'codex', sessionId: 'legit-main' })
      expect(mainPre.timeline).toHaveLength(1)
      expect(mainPre.timeline[0]!.type).toBe('append')
      if (mainPre.timeline[0]!.type === 'append') {
        expect(mainPre.timeline[0]!.item.id).toBe(`${runId}:tool:call-100`)
      }

      // 2. Legitimate child tool call
      const childPre = normalizeNativeHook(spec, {
        receiptId: 'rcpt-c1', agentSessionId, runId, providerId: 'codex', eventName: 'PreToolUse',
        payload: { session_id: 'legit-main', is_child: true, tool_name: 'shell', tool_use_id: 'call-child-200' }
      }, context)

      expect(childPre.mainSubject).toBe(false)
      expect(childPre.nativeHandle).toBeUndefined()
      expect(childPre.timeline).toHaveLength(1)
      expect(childPre.timeline[0]!.type).toBe('append')
      if (childPre.timeline[0]!.type === 'append') {
        expect(childPre.timeline[0]!.item.id).toBe(`${runId}:tool:call-child-200`)
      }

      // 3. Child termination settling parent completion
      // Start child
      normalizeNativeHook(spec, {
        receiptId: 'rcpt-cstart', agentSessionId, runId, providerId: 'codex', eventName: 'ChildStart',
        payload: { session_id: 'legit-main', is_child: true, agent_id: 'child-1' }
      }, context)

      // Main stop arrives while child is active -> pending parent end
      const pendingStop = normalizeNativeHook(spec, {
        receiptId: 'rcpt-stop', agentSessionId, runId, providerId: 'codex', eventName: 'Stop',
        payload: { session_id: 'legit-main' }
      }, context)
      expect(pendingStop.semanticState).toBe('working')
      expect(pendingStop.lifecycleEvent).toBe('turn-end')

      // Child finishes -> settles parent completion
      const childStop = normalizeNativeHook(spec, {
        receiptId: 'rcpt-cstop', agentSessionId, runId, providerId: 'codex', eventName: 'ChildStop',
        payload: { session_id: 'legit-main', is_child: true, agent_id: 'child-1' }
      }, context)
      expect(childStop.mainSubject).toBe(false)
      expect(childStop.semanticState).toBe('done')
      expect(childStop.lifecycleEvent).toBe('turn-end')
    })
  })

  describe('Public HTTP Ingestion and Client State Fencing', () => {
    async function setupHarness() {
      const storePath = join(rootDir, 'sessions.json')
      const workspacePath = join(rootDir, 'workspace')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const token = 's'.repeat(43)
      const agentSessionId = 'scoped-session-id'
      const runId = 'scoped-run-id'
      const legitSessionId = 'legit-native-session'
      const legitPath = join(workspacePath, 'legit.jsonl')

      const initialSession: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId,
        providerId: 'scoped-provider',
        executorId: 'scoped-provider',
        hostId: 'local',
        workspacePath,
        run: { runId },
        retiredRuns: [],
        hookBindingId: 'b'.repeat(43),
        hookToken: token,
        createdAt: 100,
        updatedAt: 100,
        turnUsage: { inputTokens: 500, outputTokens: 250, totalTokens: 750, observedAt: 100 },
        nativeHandle: {
          kind: 'provider',
          providerId: 'scoped-provider',
          sessionId: legitSessionId,
          transcriptPath: legitPath
        }
      }
      await store.compareAndSwap(null, initialSession)

      const hookSpec: AgentNativeHookSpecification = {
        matchesNativeSession: (_event, payload, context) => {
          const expected = context.nativeHandle?.sessionId
          return expected !== undefined && payload.session_id === expected
        },
        subagentSubject: payload => payload.is_child === true,
        rules: [
          { events: ['turn_start'], state: 'working', lifecycleEvent: 'turn-start' },
          { events: ['ask'], state: 'waiting' },
          { events: ['turn_end'], state: 'done', lifecycleEvent: 'turn-end' },
          { events: ['ChildStop'], state: 'unknown' }
        ],
        subagentTracking: {
          startEvents: ['ChildStart'],
          stopEvents: ['ChildStop'],
          mainStopEvents: ['turn_end'],
          idKeys: ['agent_id']
        },
        nativeHandle: {
          sessionIdKeys: ['session_id'],
          transcriptPathKeys: ['transcript_path']
        }
      }

      const provider = defineAgentProvider({
        catalog: {
          id: 'scoped-provider',
          label: 'Scoped Provider',
          executable: 'scoped-agent',
          expectedProcess: 'scoped-agent',
          promptDelivery: 'positional-argv',
          readySignal: { kind: 'foreground-process', expectedProcess: 'scoped-agent' },
          hookStrategy: { kind: 'native', installation: 'unmanaged' },
          resumeStrategy: { kind: 'none' },
          acpStrategy: { kind: 'none' },
          capabilities: {
            terminal: true,
            timeline: 'complete-events',
            permission: 'respond',
            providerResume: false,
            replyCorrelation: 'none'
          }
        },
        buildArgs: (_prompt, args) => [...args],
        hook: hookSpec,
        interaction: createNumberedTerminalInteractionProtocol({
          questionEvents: ['ask'],
          questionTools: ['select'],
          questionCompletionEvents: ['answer-observed'],
          permissionOptions: [
            { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' },
            { id: 'deny', label: 'Deny', kind: 'reject-once', input: '2' }
          ]
        })
      })

      const run = {
        id: runId,
        spec: { program: 'scoped-agent', args: [], cwd: workspacePath, env: {} },
        lineage: null,
        pid: 888,
        state: { type: 'running' as const },
        latest_output_bytes: 100,
        durable_output_bytes: 100,
        first_available_byte: 0,
        attachments: 0,
        applied_input_bytes: 0,
        current_size: { cols: 80, rows: 24 }
      }

      const client = new AgentMuxClient({ store, providers: [provider] })
      cleanups.push(() => client.dispose())

      const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter, {
        client: {
          list: async () => [{ id: runId }],
          status: async () => run,
          start: vi.fn(),
          stop: vi.fn(),
          input: vi.fn(),
          recoverableInput: vi.fn(async () => ({ run, receipt: { start_byte: 0, end_byte: 0, data: '' } }))
        },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })

      await client.connect()

      let receiptCounter = 0
      const feed = async (eventName: string, payload: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            receiptId: `rcpt-${++receiptCounter}`,
            eventName,
            payload
          })
        })
        return response.status
      }

      const stored = async (): Promise<AgentMuxStoredAgentSession> => {
        const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
        expect(sessions).toHaveLength(1)
        return sessions[0]!
      }

      return { client, feed, stored, runId, legitSessionId, legitPath, storePath }
    }

    it('foreign hook event fails to mutate semantic status, nativeHandle, pendingInteraction, or turnUsage', async () => {
      const h = await setupHarness()
      try {
        // Send foreign turn_start: claimed working + foreign session_id + foreign transcript
        const status = await h.feed('turn_start', {
          session_id: 'foreign-session',
          transcript_path: '/synthetic/foreign.jsonl'
        })
        expect(status).toBe(204)

        const s1 = await h.stored()
        // Foreign event must NOT set semanticStatus to working
        expect(s1.semanticStatus).toBeUndefined()
        // Foreign event must NOT replace nativeHandle
        expect(s1.nativeHandle).toEqual({
          kind: 'provider',
          providerId: 'scoped-provider',
          sessionId: h.legitSessionId,
          transcriptPath: h.legitPath
        })

        // Send foreign question interaction: 'ask' with tool_name: 'select'
        await h.feed('ask', {
          session_id: 'foreign-session',
          tool_name: 'select',
          tool_use_id: 'foreign-call-1',
          tool_input: {
            questions: [{ question: 'Foreign question?', options: [{ label: 'Yes' }, { label: 'No' }] }]
          }
        })
        const s2 = await h.stored()
        // Foreign event must NOT create a pending interaction
        expect(s2.pendingInteraction).toBeUndefined()

        // Send foreign turn_end without usage: should NOT clear the legitimate session's turnUsage
        await h.feed('turn_end', {
          session_id: 'foreign-session'
        })
        const s3 = await h.stored()
        expect(s3.turnUsage).toEqual({ inputTokens: 500, outputTokens: 250, totalTokens: 750, observedAt: 100 })
        expect(s3.terminalPromptReadiness).toBeUndefined()
      } finally {
        releaseSubagentRoster(h.runId)
      }
    })

    it('foreign child event does not mutate live child roster', async () => {
      const h = await setupHarness()
      try {
        // Foreign subagent start
        await h.feed('ChildStart', {
          session_id: 'foreign-session',
          is_child: true,
          agent_id: 'foreign-worker-99'
        })

        // Now legitimate main sends turn_end: if roster was corrupted by foreign worker,
        // it would be held pending and remain 'working'. With foreign fencing, it settles 'done' immediately!
        await h.feed('turn_end', {
          session_id: h.legitSessionId
        })

        const s = await h.stored()
        expect(s.semanticStatus?.state).toBe('done')
      } finally {
        releaseSubagentRoster(h.runId)
      }
    })

    it('positive control: legitimate main events transition status, handle, interaction, and usage correctly', async () => {
      const h = await setupHarness()
      try {
        // 1. Legit turn_start
        await h.feed('turn_start', {
          session_id: h.legitSessionId
        })
        let s = await h.stored()
        expect(s.semanticStatus?.state).toBe('working')

        // 2. Legit question interaction
        await h.feed('ask', {
          session_id: h.legitSessionId,
          tool_name: 'select',
          tool_use_id: 'legit-call-1',
          tool_input: {
            questions: [{ question: 'Legitimate question?', options: [{ label: 'A' }, { label: 'B' }] }]
          }
        })
        s = await h.stored()
        expect(s.pendingInteraction?.request).toMatchObject({
          kind: 'question',
          nativeToolCallId: 'legit-call-1'
        })

        // 3. Answer question
        await h.feed('answer-observed', {
          session_id: h.legitSessionId,
          tool_name: 'select',
          tool_use_id: 'legit-call-1'
        })
        s = await h.stored()
        expect(s.pendingInteraction).toBeUndefined()

        // 4. Legit child start + main turn_end + child stop: preserves parent usage
        await h.feed('ChildStart', {
          session_id: h.legitSessionId,
          is_child: true,
          agent_id: 'legit-child-1'
        })
        await h.feed('turn_end', {
          session_id: h.legitSessionId,
          agentmuxUsage: { inputTokens: 600, outputTokens: 300, totalTokens: 900, observedAt: 200 }
        })
        s = await h.stored()
        // Parent end is held pending child
        expect(s.semanticStatus?.state).toBe('working')
        // Fresh parent usage is accepted
        expect(s.turnUsage).toMatchObject({ inputTokens: 600, outputTokens: 300, totalTokens: 900 })

        // Child finishes without usage -> settles parent completion
        await h.feed('ChildStop', {
          session_id: h.legitSessionId,
          is_child: true,
          agent_id: 'legit-child-1'
        })
        s = await h.stored()
        expect(s.semanticStatus?.state).toBe('done')
        // Child resolution of parent turn-end preserved real parent usage!
        expect(s.turnUsage).toMatchObject({ inputTokens: 600, outputTokens: 300, totalTokens: 900 })
      } finally {
        releaseSubagentRoster(h.runId)
      }
    })
  })
})
