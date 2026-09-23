import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import {
  AgentMuxFileAgentSessionStore,
  AgentProviderRegistry,
  AgentMuxClient,
  loadAgentSessions,
  agentPromptCondition,
  defaultAgentMuxHookPort,
  type AgentProviderHookNormalizationContext,
  type AgentNativeSessionHandle,
  type AgentMuxStoredAgentSession,
  type NativeHookEnvelope,
  type AgentProvider
} from '../src/index.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { OPENCODE_HOOKS } from '../src/providers/opencode.js'

describe('Trusted Hook normalization context (T-039)', () => {
  let rootDir: string
  const cleanups: (() => Promise<void> | void)[] = []

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'amux-trusted-hook-test-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      if (cleanup) await cleanup()
    }
    await rm(rootDir, { recursive: true, force: true })
  })

  describe('Core context handoff and immutability via public HTTP Ingest', () => {
    it('Core client supplies a frozen projection of durable nativeHandle and prevents mutation', async () => {
      const storePath = join(rootDir, 'sessions-frozen.json')
      const workspacePath = join(rootDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true })

      vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(rootDir, 'runtime'))
      vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(rootDir, 'durable'))
      vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(rootDir, 'queue.ndjson'))

      const store = new AgentMuxFileAgentSessionStore(storePath)
      const token = 't'.repeat(43)

      const seedSession: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'sess-frozen-1',
        providerId: 'opencode',
        executorId: 'opencode',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-frozen-1' },
        retiredRuns: [],
        hookBindingId: 'b'.repeat(43),
        hookToken: token,
        createdAt: 100,
        updatedAt: 100,
        nativeHandle: {
          kind: 'provider',
          providerId: 'opencode',
          sessionId: 'oc-durable-frozen-root'
        }
      }
      await store.compareAndSwap(null, seedSession)

      let receivedContext: AgentProviderHookNormalizationContext | undefined
      let receivedEnvelope: NativeHookEnvelope | undefined
      const baseOpenCode = new AgentProviderRegistry().get('opencode')
      const recordingProvider: AgentProvider = {
        ...baseOpenCode,
        normalizeHook(envelope, context) {
          receivedContext = context
          receivedEnvelope = envelope
          return baseOpenCode.normalizeHook(envelope, context)
        }
      }

      const run = {
        id: 'run-frozen-1',
        spec: { program: 'opencode', args: [], cwd: workspacePath, env: {} },
        lineage: null,
        pid: 777,
        state: { type: 'running' as const },
        latest_output_bytes: 100,
        durable_output_bytes: 100,
        first_available_byte: 0,
        attachments: 0,
        applied_input_bytes: 0,
        current_size: { cols: 80, rows: 24 }
      }

      const client = new AgentMuxClient({ store, providers: [recordingProvider] })
      cleanups.push(() => client.dispose())

      const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter, {
        client: {
          list: async () => [{ id: 'run-frozen-1' }],
          status: async () => run,
          start: vi.fn(),
          stop: vi.fn(),
          input: vi.fn(),
          recoverableInput: vi.fn(async () => ({ run, receipt: { start_byte: 0, end_byte: 0, data: '' } }))
        },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })

      // Real public connect
      await client.connect()

      const rawPayload = {
        sessionID: 'oc-durable-frozen-root',
        status: { type: 'busy' },
        spoofedHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'forged' }
      }

      const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          receiptId: 'rcpt-frozen-test-1',
          eventName: 'session.status',
          payload: rawPayload
        })
      })
      expect(response.status).toBe(204)

      // Verified: Context was constructed by Core client.ts and delivered to recordingProvider
      expect(receivedContext).toBeDefined()
      expect(Object.isFrozen(receivedContext)).toBe(true)
      expect(Object.isFrozen(receivedContext?.nativeHandle)).toBe(true)
      expect(receivedContext?.nativeHandle?.sessionId).toBe('oc-durable-frozen-root')

      // Immutable: Attempting to mutate throws in strict mode
      expect(() => {
        // @ts-expect-error mutating frozen context
        receivedContext!.nativeHandle = undefined
      }).toThrow()

      expect(() => {
        // @ts-expect-error mutating readonly property
        receivedContext!.nativeHandle!.sessionId = 'tampered'
      }).toThrow()

      // Distinct from raw payload: Context was NOT constructed from raw HTTP envelope fields
      expect(receivedContext?.nativeHandle).not.toBe(rawPayload.spoofedHandle)
      expect(receivedContext?.nativeHandle).toEqual(seedSession.nativeHandle)
    })

    it('withholds nativeHandle from raw HTTP payload when context does not authorize it (unknown lineage)', () => {
      const providers = new AgentProviderRegistry()
      const opencode = providers.get('opencode')

      // An unauthenticated/unresumed session has no trusted nativeHandle in context
      const emptyContext: AgentProviderHookNormalizationContext = Object.freeze({})

      // Even if the raw HTTP envelope claims to have a sessionID or forged nativeHandle
      const spoofedEnvelope: NativeHookEnvelope = {
        receiptId: 'rcpt-spoof',
        agentSessionId: 'sess-fresh',
        runId: 'run-fresh',
        providerId: 'opencode',
        eventName: 'session.status',
        payload: {
          sessionID: 'self-declared-unauthorized-id',
          status: { type: 'busy' },
          nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'self-declared-unauthorized-id' }
        }
      }

      const normalized = opencode.normalizeHook(spoofedEnvelope, emptyContext)
      // Unknown lineage: strictly fenced from contributing to main turn or status!
      expect(normalized.nativeHandle).toBeUndefined()
      expect(normalized.lifecycleEvent).toBeNull()
      expect(normalized.semanticState).toBe('unknown')
      expect(normalized.status.state).toBe('running')
      // Non-empty trace is preserved for diagnostics
      expect(normalized.timeline.length).toBeGreaterThan(0)
    })
  })

  describe('Provider OpenCode Session lineage fencing & task tool', () => {
    const providers = new AgentProviderRegistry()
    const opencode = providers.get('opencode')

    const trustedRootHandle: AgentNativeSessionHandle = {
      kind: 'provider',
      providerId: 'opencode',
      sessionId: 'root-session-42'
    }
    const trustedContext: AgentProviderHookNormalizationContext = Object.freeze({
      nativeHandle: Object.freeze({ ...trustedRootHandle })
    })

    it('authorizes the authentic root session and maps status predicates accurately', () => {
      const baseEnvelope = {
        receiptId: 'rcpt-root',
        agentSessionId: 'sess-main',
        runId: 'run-main',
        providerId: 'opencode' as const
      }

      // session.status(busy) -> working with turn-start
      const busy = opencode.normalizeHook({
        ...baseEnvelope,
        eventName: 'session.status',
        payload: { sessionID: 'root-session-42', status: { type: 'busy' } }
      }, trustedContext)
      expect(busy.semanticState).toBe('working')
      expect(busy.lifecycleEvent).toBe('turn-start')
      expect(busy.nativeHandle).toEqual(trustedRootHandle)

      // session.status(retry) -> working without turn reopening
      const retry = opencode.normalizeHook({
        ...baseEnvelope,
        eventName: 'session.status',
        payload: { sessionID: 'root-session-42', status: { type: 'retry', attempt: 1 } }
      }, trustedContext)
      expect(retry.semanticState).toBe('working')
      expect(retry.lifecycleEvent).toBeUndefined()
      expect(retry.nativeHandle).toEqual(trustedRootHandle)

      // session.status(idle) -> neutral unknown without turn-end
      const idle = opencode.normalizeHook({
        ...baseEnvelope,
        eventName: 'session.status',
        payload: { sessionID: 'root-session-42', status: { type: 'idle' } }
      }, trustedContext)
      expect(idle.semanticState).toBe('unknown')
      expect(idle.lifecycleEvent).toBeNull()
      expect(idle.nativeHandle).toEqual(trustedRootHandle)
    })

    it('main agent calling task tool is normal root tool lifecycle, not misidentified as child', () => {
      const taskEnvelope: NativeHookEnvelope = {
        receiptId: 'rcpt-root-task',
        agentSessionId: 'sess-main',
        runId: 'run-main',
        providerId: 'opencode',
        eventName: 'message.part.updated',
        payload: {
          sessionID: 'root-session-42',
          part: { type: 'tool', tool: 'task', callID: 'task-call-1', state: { status: 'running' } }
        }
      }

      const normalized = opencode.normalizeHook(taskEnvelope, trustedContext)
      expect(normalized.nativeHandle?.sessionId).toBe('root-session-42')
      expect(normalized.lifecycleEvent).toBeUndefined()
      expect(normalized.semanticState).toBe('working')
    })

    it('fences child sessions in format A (parentID directly in payload) without leaking usage/interaction', () => {
      const childEnvelope: NativeHookEnvelope = {
        receiptId: 'rcpt-child-a',
        agentSessionId: 'sess-main',
        runId: 'run-main',
        providerId: 'opencode',
        eventName: 'permission.updated',
        payload: {
          sessionID: 'subtask-session-a',
          parentID: 'root-session-42',
          id: 'child-perm',
          permission: 'bash'
        }
      }

      const normalized = opencode.normalizeHook(childEnvelope, trustedContext)
      expect(normalized.nativeHandle).toBeUndefined()
      expect(normalized.lifecycleEvent).toBeNull()
      expect(normalized.semanticState).toBe('unknown')
      expect(normalized.status.state).toBe('running')
      expect(normalized.interaction).toBeUndefined()
      expect(normalized.turnUsage).toBeUndefined()
    })

    it('fences child sessions in format B (info.parentID with same sessionID as root)', () => {
      const childEnvelope: NativeHookEnvelope = {
        receiptId: 'rcpt-child-b',
        agentSessionId: 'sess-main',
        runId: 'run-main',
        providerId: 'opencode',
        eventName: 'session.status',
        payload: {
          sessionID: 'root-session-42',
          info: { parentID: 'root-session-42', title: 'Subagent Search' },
          status: { type: 'busy' }
        }
      }

      const normalized = opencode.normalizeHook(childEnvelope, trustedContext)
      expect(normalized.nativeHandle).toBeUndefined()
      expect(normalized.lifecycleEvent).toBeNull()
      expect(normalized.semanticState).toBe('unknown')
      expect(normalized.status.state).toBe('running')
      expect(normalized.turnUsage).toBeUndefined()
    })

    it('fences foreign sessions whose sessionID does not match the trusted root handle', () => {
      const foreignEnvelope: NativeHookEnvelope = {
        receiptId: 'rcpt-foreign',
        agentSessionId: 'sess-main',
        runId: 'run-main',
        providerId: 'opencode',
        eventName: 'session.status',
        payload: {
          sessionID: 'concurrent-other-session',
          status: { type: 'busy' }
        }
      }

      const normalized = opencode.normalizeHook(foreignEnvelope, trustedContext)
      expect(normalized.nativeHandle).toBeUndefined()
      expect(normalized.lifecycleEvent).toBeNull()
      expect(normalized.semanticState).toBe('unknown')
      expect(normalized.status.state).toBe('running')
      expect(normalized.turnUsage).toBeUndefined()
    })
  })

  describe('Real public Core HTTP Ingest, durable FileStore, and Prompt availability', () => {
    async function setupPublicCoreHarness() {
      const storePath = join(rootDir, 'sessions.json')
      const workspacePath = join(rootDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true })

      vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(rootDir, 'runtime'))
      vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(rootDir, 'durable'))
      vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(rootDir, 'queue.ndjson'))

      const store = new AgentMuxFileAgentSessionStore(storePath)
      const token = 't'.repeat(43)

      const seedSession: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'sess-trusted-1',
        providerId: 'opencode',
        executorId: 'opencode',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-live-1' },
        retiredRuns: [],
        hookBindingId: 'b'.repeat(43),
        hookToken: token,
        createdAt: 100,
        updatedAt: 100,
        nativeHandle: {
          kind: 'provider',
          providerId: 'opencode',
          sessionId: 'oc-durable-root-id'
        }
      }
      await store.compareAndSwap(null, seedSession)

      const run = {
        id: 'run-live-1',
        spec: { program: 'opencode', args: [], cwd: workspacePath, env: {} },
        lineage: null,
        pid: 777,
        state: { type: 'running' as const },
        latest_output_bytes: 100,
        durable_output_bytes: 100,
        first_available_byte: 0,
        attachments: 0,
        applied_input_bytes: 0,
        current_size: { cols: 80, rows: 24 }
      }

      let cursor = 0
      const writes: string[] = []
      let currentRun = { ...run, accepted_input_bytes: cursor, applied_input_bytes: cursor }
      const recoverableInput = vi.fn(async (op: {
        daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
      }) => {
        expect(op.expectedByte).toBe(cursor)
        const receipt = { start_byte: cursor, end_byte: cursor + Buffer.byteLength(op.data), data: op.data }
        cursor = receipt.end_byte
        writes.push(op.data)
        currentRun = { ...run, accepted_input_bytes: cursor, applied_input_bytes: cursor }
        return { run: currentRun, receipt }
      })
      const input = vi.fn(async (op: { operationKey: string; expectedByte: number; data: string }) => {
        return { accepted_byte: op.data.length }
      })
      const start = vi.fn(async () => { throw new Error('Unexpected Run start') })
      const stop = vi.fn(async () => { throw new Error('Unexpected Run stop') })
      const status = vi.fn(async (id: string) => currentRun)

      const opencode = new AgentProviderRegistry().get('opencode')
      const client = new AgentMuxClient({ store, providers: [opencode] })
      cleanups.push(() => client.dispose())

      const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter, {
        client: { list: async () => [{ id: 'run-live-1' }], status, start, stop, input, recoverableInput },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })

      // Public connect starts real HTTP hook server and restores binding from disk store
      await client.connect()

      let receiptIndex = 0
      const feed = async (eventName: string, payload: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            receiptId: `rcpt-${++receiptIndex}`,
            eventName,
            payload
          })
        })
        return response.status
      }

      return { store, client, feed, workspacePath, storePath, token, run, input, recoverableInput, writes, opencode }
    }

    it('authentically supplies durable nativeHandle to normalizer and gates state updates over HTTP', async () => {
      const h = await setupPublicCoreHarness()

      // 1. Post a valid root turn-start event over real HTTP ingest
      const rootStatus = await h.feed('session.status', {
        sessionID: 'oc-durable-root-id',
        status: { type: 'busy' }
      })
      expect(rootStatus).toBe(204)

      // Verified: Root event updated session state in the durable store
      const sessionsAfterRoot = await loadAgentSessions(h.store)
      expect(sessionsAfterRoot.length).toBeGreaterThan(0)
      const sessionAfterRoot = sessionsAfterRoot.find((s) => s.agentSessionId === 'sess-trusted-1')
      expect(sessionAfterRoot).toBeDefined()
      expect(sessionAfterRoot?.semanticStatus?.state).toBe('working')
      expect(sessionAfterRoot?.nativeHandle?.sessionId).toBe('oc-durable-root-id')

      // 2. Post a child session event over real HTTP ingest (format A: parentID with SAME sessionID as root)
      // This proves child fencing is load-bearing even when sessionID matches the root handle!
      const childStatusA = await h.feed('session.status', {
        sessionID: 'oc-durable-root-id',
        parentID: 'oc-durable-root-id',
        status: { type: 'busy' }
      })
      expect(childStatusA).toBe(204)

      // Child event did NOT overwrite the root session handle or hijack turn state
      const sessionsAfterChildA = await loadAgentSessions(h.store)
      const sessionAfterChildA = sessionsAfterChildA.find((s) => s.agentSessionId === 'sess-trusted-1')
      expect(sessionAfterChildA?.nativeHandle?.sessionId).toBe('oc-durable-root-id')
      expect(sessionAfterChildA?.semanticStatus?.state).toBe('working')

      // 3. Post a child session event over real HTTP ingest (format B: info.parentID with SAME sessionID)
      const childStatusB = await h.feed('session.status', {
        sessionID: 'oc-durable-root-id',
        info: { parentID: 'oc-durable-root-id' },
        status: { type: 'busy' }
      })
      expect(childStatusB).toBe(204)

      const sessionsAfterChildB = await loadAgentSessions(h.store)
      const sessionAfterChildB = sessionsAfterChildB.find((s) => s.agentSessionId === 'sess-trusted-1')
      expect(sessionAfterChildB?.nativeHandle?.sessionId).toBe('oc-durable-root-id')

      // 4. Post a foreign session event over real HTTP ingest
      const foreignStatus = await h.feed('session.status', {
        sessionID: 'foreign-id-999',
        status: { type: 'busy' }
      })
      expect(foreignStatus).toBe(204)

      const sessionsAfterForeign = await loadAgentSessions(h.store)
      const sessionAfterForeign = sessionsAfterForeign.find((s) => s.agentSessionId === 'sess-trusted-1')
      expect(sessionAfterForeign?.nativeHandle?.sessionId).toBe('oc-durable-root-id')
    })

    it('fresh Client and fresh Provider instance recover same authoritative handle from disk Store via public connect', async () => {
      const h = await setupPublicCoreHarness()
      await h.client.dispose()

      // Fresh instance: brand new Client and Provider reading the same filesystem directory
      const store2 = new AgentMuxFileAgentSessionStore(h.storePath)
      const freshOpenCode = new AgentProviderRegistry().get('opencode')
      const client2 = new AgentMuxClient({ store: store2, providers: [freshOpenCode] })
      cleanups.push(() => client2.dispose())

      const adapter2 = (client2 as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter2, {
        client: { list: async () => [{ id: 'run-live-1' }], status: async () => h.run, start: vi.fn(), stop: vi.fn(), input: h.input },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })
      await client2.connect()

      const recovered = client2.agentSession('sess-trusted-1')
      expect(recovered).toBeDefined()
      expect(recovered.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'opencode',
        sessionId: 'oc-durable-root-id'
      })

      // Send event to public ingress; Core supplies restored nativeHandle into context
      const feed2 = async (eventName: string, payload: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${h.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            receiptId: `rcpt-fresh-${Date.now()}`,
            eventName,
            payload
          })
        })
        return response.status
      }

      const res = await feed2('session.status', { sessionID: 'oc-durable-root-id', status: { type: 'busy' } })
      expect(res).toBe(204)

      const current = client2.agentSession('sess-trusted-1')
      expect(current.semanticStatus?.state).toBe('working')
      expect(current.nativeHandle?.sessionId).toBe('oc-durable-root-id')
    })

    it('honest inspectHookActivation does not gate public Prompt and public typed writeAgent input', async () => {
      const h = await setupPublicCoreHarness()

      // Create managed plugin on disk
      mkdirSync(join(h.workspacePath, 'plugin'), { recursive: true })
      writeFileSync(join(h.workspacePath, 'plugin', 'agentmux.js'), 'export async function server() {}', 'utf-8')

      // inspectHookActivation returns honest NEEDS_EVIDENCE
      const inspectResult = await h.opencode.inspectHookActivation!({
        plan: { providerId: 'opencode', mutations: [{ path: join(h.workspacePath, 'plugin', 'agentmux.js'), content: '', mode: 0o600 }] },
        workspacePath: h.workspacePath,
        command: 'opencode',
        args: ['--session', 'some-id'],
        env: {},
        signal: new AbortController().signal
      })
      expect(inspectResult.active).toBe(false)
      expect(inspectResult.code).toBe('HOOK_ACTIVATION_NEEDS_EVIDENCE')

      // 1. Normal prompt condition is satisfied and prompt submission is NOT blocked by diagnostic
      const session = h.client.agentSession('sess-trusted-1')
      const condition = agentPromptCondition(session)
      expect(condition.expectedRun.runId).toBe('run-live-1')

      await h.client.submitAgentPrompt({
        agentSessionId: 'sess-trusted-1',
        operationId: 'op-prompt-admission-check',
        prompt: 'investigate failure',
        ...condition
      })
      expect(h.recoverableInput).toHaveBeenCalledWith(expect.objectContaining({ data: 'investigate failure\r' }))
      expect(h.writes).toContain('investigate failure\r')

      // 2. Public writeAgent typed input is NOT blocked and executes through controlled adapter
      const ack = await h.client.writeAgent({
        agentSessionId: 'sess-trusted-1',
        expectedRun: session.run,
        data: 'echo typed-input\n',
        source: 'user'
      })
      expect(ack.runId).toBe('run-live-1')
      expect(ack.acceptedThroughByte).toBeGreaterThan(0)
      expect(h.writes).toContain('echo typed-input\n')
    })

    it('independent private Node child process reads Store and verifies context supply without leakage', async () => {
      const h = await setupPublicCoreHarness()
      await h.client.dispose()

      const childRootDir = join(rootDir, 'child-proc-root')
      mkdirSync(join(childRootDir, 'runtime'), { recursive: true })
      mkdirSync(join(childRootDir, 'durable'), { recursive: true })
      mkdirSync(join(childRootDir, 'home'), { recursive: true })
      mkdirSync(join(childRootDir, 'tmp'), { recursive: true })

      const childScriptPath = join(childRootDir, 'verify-context-worker.mjs')
      const scriptCode = `
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
os.homedir = () => '${join(childRootDir, 'home')}'
os.tmpdir = () => '${join(childRootDir, 'tmp')}'
syncBuiltinESMExports()

const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, defaultAgentMuxHookPort } = await import('${join(process.cwd(), 'packages/core/dist/index.js')}')

const store = new AgentMuxFileAgentSessionStore('${h.storePath}')
const opencode = new AgentProviderRegistry().get('opencode')
const client = new AgentMuxClient({ store, providers: [opencode] })
const run = ${JSON.stringify(h.run)}
const adapter = client.kernel
Object.assign(adapter, {
  client: {
    list: async () => [{ id: 'run-live-1' }],
    status: async () => run,
    start: async () => { throw new Error('no start') },
    stop: async () => { throw new Error('no stop') },
    recoverableInput: async () => ({ run, receipt: { start_byte: 0, end_byte: 1, data: '' } })
  },
  runtime: { daemonInstanceId: 'child-proc-daemon' }
})

await client.connect()

const session = client.agentSession('sess-trusted-1')
if (!session || session.nativeHandle?.sessionId !== 'oc-durable-root-id') {
  process.exit(10)
}

const port = defaultAgentMuxHookPort()
const feed = async (eventName, payload) => {
  const res = await fetch(\`http://127.0.0.1:\${port}/v1/events\`, {
    method: 'POST',
    headers: { authorization: 'Bearer ${h.token}', 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: 'r-child-' + Date.now(), eventName, payload })
  })
  return res.status
}

const rootStatus = await feed('session.status', { sessionID: 'oc-durable-root-id', status: { type: 'busy' } })
if (rootStatus !== 204) process.exit(11)

const childStatus = await feed('session.status', { sessionID: 'oc-durable-root-id', parentID: 'oc-durable-root-id', status: { type: 'busy' } })
if (childStatus !== 204) process.exit(12)

const currentSession = client.agentSession('sess-trusted-1')
if (currentSession.nativeHandle?.sessionId !== 'oc-durable-root-id' || currentSession.semanticStatus?.state !== 'working') {
  process.exit(13)
}

await client.dispose()
process.exit(0)
`
      writeFileSync(childScriptPath, scriptCode, 'utf-8')

      const cleanEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('AGENTMUX_') && !k.startsWith('CTXMUX_') && k !== 'NODE_OPTIONS' && k !== 'NODE_PATH') {
          cleanEnv[k] = v
        }
      }
      Object.assign(cleanEnv, {
        AGENTMUX_RUNTIME_DIRECTORY: join(childRootDir, 'runtime'),
        AGENTMUX_STATE_DIRECTORY: join(childRootDir, 'durable'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(childRootDir, 'queue.ndjson')
      })

      const exitCode = await new Promise<number>((resolve, reject) => {
        const proc = fork(childScriptPath, [], {
          env: cleanEnv,
          stdio: 'inherit'
        })
        proc.on('error', reject)
        proc.on('exit', (code) => resolve(code ?? -1))
      })

      expect(exitCode).toBe(0)
    })
  })
})
