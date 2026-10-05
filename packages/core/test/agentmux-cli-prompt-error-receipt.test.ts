import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import type { AgentMuxControlHost, AgentMuxControlSendRequest } from '../src/control.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentMuxRunInputData } from '../src/types.js'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))

type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  messageQueue: DurableAgentMuxMessageQueue
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, operation: { ownerInstanceId: string; operationId: string; expectedByte: number; data: AgentMuxRunInputData }): Promise<{
      run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number }
    }>
    stop(runId: string): Promise<unknown>
  }
}

// Real File Store, registry, public Client, Unix Control and compiled CLI. Only the
// already-connected kernel is a fixture: these tests do not spawn or attest a Native Run,
// and do not replace Electron invoke's custom Error transport with a claimed real IPC.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-prompt-code-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const capability = issueAgentCapability()
  const template = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, promptExecution: _immediate, ...capabilities } = template.catalog.capabilities
  const provider = defineAgentProvider({
    catalog: { ...template.catalog, capabilities, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook, ...(template.planManagedHooks ? { planManagedHooks: template.planManagedHooks } : {}), buildArgs: (_prompt, args) => [...args]
  })
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'receipt-agent', executorId: 'generic', providerId: 'generic',
    hostId: 'local', workspacePath: root, run: { runId: 'receipt-run' }, retiredRuns: [],
    hookBindingId: 'receipt-binding', hookToken: 'receipt-token', capabilityHash: hashAgentCapability(capability), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1)
  }
  let client: AgentMuxClient | undefined
  let server: AgentMuxControlServer | undefined
  try {
    await store.compareAndSwap(null, stored)
    client = new AgentMuxClient({ store, providers: [provider] })
    const owner = client
    const inner = owner as unknown as Inner
    await inner.registry.load('local')
    inner.connected = true
    inner.messageQueue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
    const writes: Array<{ operationId: string; data: AgentMuxRunInputData }> = []
    const stops: string[] = []
    let cursor = 0
    let inputDisposition: 'ack' | 'unknown' | 'not_applied' = 'ack'
    const inputCalls: Array<Parameters<Inner['kernel']['input']>[1]> = []
    const nativeRequests = new Map<string, { operation: Parameters<Inner['kernel']['input']>[1]; endByte: number }>()
    const run = (): CtxmuxAdapterRun => ({
      nativeService: null,
      runId: stored.run.runId, lifecycleOperationId: null, program: 'generic', args: [],
      workspacePath: root, pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
      latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor
    })
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-daemon' })
    inner.kernel.status = async runId => { expect(runId).toBe(stored.run.runId); return run() }
    inner.kernel.input = async (runId, operation) => {
      expect(runId).toBe(stored.run.runId)
      inputCalls.push(structuredClone(operation))
      const previous = nativeRequests.get(operation.operationId)
      if (previous) expect(operation).toEqual(previous.operation)
      else {
        expect(operation.expectedByte).toBe(cursor)
        if (inputDisposition === 'not_applied') throw new AgentMuxError('Private Native refused the whole input.', 'CTXMUX_input_refused', 'not_applied')
        const length = typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength
        nativeRequests.set(operation.operationId, { operation: structuredClone(operation), endByte: cursor + length })
        writes.push({ operationId: operation.operationId, data: operation.data })
        // A deterministic Native fixture retains the original request after partial
        // acceptance. Rejoining it never creates another request or copies payload.
        if (inputDisposition === 'unknown') cursor += Math.min(3, length)
      }
      if (inputDisposition === 'unknown') throw new AgentMuxError('Private Native retains a partially accepted input without its final receipt.', 'CTXMUX_io', 'unknown')
      cursor = nativeRequests.get(operation.operationId)!.endByte
      return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: cursor } }
    }
    inner.kernel.stop = async runId => { stops.push(runId) }
    const requests: AgentMuxControlSendRequest[] = []
    const failures: Array<{ code: string; message: string; detail?: string; logId?: string }> = []
    const host: AgentMuxControlHost = {
      async execute(request) {
        if (request.operation === 'list.active-agents') {
          const current = owner.agentSession(stored.agentSessionId)
          return { operation: request.operation, agents: [{
            agentSessionId: current.agentSessionId, promptCondition: agentPromptCondition(current),
            projectId: null, projectName: null, workspacePath: current.workspacePath,
            providerId: current.providerId, executorId: current.executorId,
            processState: (await owner.statusAgent(current.agentSessionId)).run.state,
            status: 'unknown', updatedAt: current.updatedAt
          }] }
        }
        if (request.operation !== 'send') throw new Error(`Unexpected fixture operation: ${request.operation}`)
        requests.push(request)
        try {
          if (!request.caller?.capability) throw new Error('This fixture requires the issued managed caller capability.')
          await owner.submitAgentMessage({
            agentSessionId: stored.agentSessionId, condition: request.promptCondition,
            envelope: request.message, sourceChannel: request.sourceChannel,
            caller: { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability }
          })
        } catch (error) {
          const source = error as { code: string; message: string; detail?: string; logId?: string }
          failures.push({ code: source.code, message: source.message, detail: source.detail, logId: source.logId })
          throw error
        }
        return { operation: request.operation, agentSessionId: stored.agentSessionId }
      }
    }
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: owner }], execute: request => host.execute(request) })
    await server.start()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const send = (text = '  original message\n第二行  ') => execute(process.execPath, [cli, 'agent', 'send', '--operation-id', 'original-operation', '--to-session', stored.agentSessionId,
        '--text', text, '--message-id', 'original-message', '--execution', 'default'], {
        env: { ...env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
          AGENTMUX_RPC_ENDPOINT: `unix:${server!.path}`, AGENTMUX_ENV: '1',
          AGENTMUX_AGENT_SESSION_ID: stored.agentSessionId, AGENTMUX_AGENT_CAPABILITY: capability,
          AGENTMUX_AGENT_SESSION_STORE: store.path, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') },
        timeout: 10_000, maxBuffer: 256 * 1024
      })
    async function failSend(text?: string) {
      const result = await send(text).then(() => { throw new Error('CLI unexpectedly accepted the blocked prompt.') }, error => {
        expect(error.code).toBe(1)
        expect(error.stdout).toBe('')
        expect(error.stderr.trim()).not.toBe('')
        // Node can print its own experimental-module warning before the NDJSON receipt.
        // Require exactly one actual envelope rather than accepting empty stderr or a warning.
        const receipts = error.stderr.split('\n').filter((line: string) => line.startsWith('{'))
        expect(receipts).toHaveLength(1)
        return JSON.parse(receipts[0]!) as {
          operationId: string; operation: string; ok: boolean
          error: { code: string; message: string; detail?: string; logId?: string }
        }
      })
      return result
    }
    return { root, store, owner, writes, stops, requests, failures, run, send, failSend, inputCalls,
      inputDisposition: (value: typeof inputDisposition) => { inputDisposition = value }, async close() {
      try { await server!.stop() } finally { try { await owner.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
    } }
  } catch (error) {
    try { await server?.stop() } finally { try { await client?.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
    throw error
  }
}

describe('public Prompt errors through Control and built CLI', () => {
  it('reconciles partial unknown input with the original request instead of copying payload', async () => {
    const h = await fixture()
    try {
      h.inputDisposition('unknown')
      expect((await h.failSend()).error).toMatchObject({ code: 'CTXMUX_io', detail: 'unknown' })
      const original = h.inputCalls[0]!
      const before = h.owner.agentSession('receipt-agent').promptCompletionAdmission
      expect(before).toMatchObject({ submissionId: 'original-message', startByte: 0, acknowledged: false })
      expect(h.run().acceptedInputBytes).toBe(3)
      expect((await h.failSend()).error).toMatchObject({ code: 'CTXMUX_io', detail: 'unknown' })
      expect(h.inputCalls).toEqual([original, original])
      expect(h.writes).toHaveLength(1)
      expect(h.run().acceptedInputBytes).toBe(3)
      const calls = h.inputCalls.length
      expect((await h.failSend('conflicting body')).error.code).toBe('MESSAGE_ID_CONFLICT')
      expect(h.inputCalls).toHaveLength(calls)
      h.inputDisposition('ack')
      expect(JSON.parse((await h.send()).stdout)).toMatchObject({ ok: true, result: { delivery: { state: 'delivered' } } })
      expect(h.inputCalls).toEqual([original, original, original])
      expect(h.writes).toHaveLength(1)
      expect(h.owner.agentSession('receipt-agent').promptCompletionAdmission).toMatchObject({
        operationId: before!.operationId, startByte: before!.startByte, endByte: before!.endByte,
        intent: before!.intent, acknowledged: true
      })
      const accepted = h.run().acceptedInputBytes
      await h.send()
      expect(h.inputCalls).toHaveLength(3)
      expect(h.run().acceptedInputBytes).toBe(accepted)
      expect(h.stops).toEqual([])
    } finally { await h.close() }
  }, 20_000)

  it('keeps whole-input not-applied final through public retry and a fresh durable reader', async () => {
    const h = await fixture()
    try {
      h.inputDisposition('not_applied')
      expect((await h.failSend()).error).toMatchObject({ code: 'CTXMUX_input_refused', detail: 'not_applied' })
      const before = h.owner.agentSession('receipt-agent').promptCompletionAdmission
      expect(before).toMatchObject({ submissionId: 'original-message', notApplied: true, acknowledged: false })
      const reader = new AgentMuxFileAgentSessionStore(h.store.path)
      expect((await reader.readMetadata('receipt-agent'))?.promptCompletionAdmission).toEqual(before)
      h.inputDisposition('ack')
      expect((await h.failSend()).error).toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' })
      expect(h.requests).toHaveLength(2)
      expect(h.inputCalls).toHaveLength(1)
      expect(h.writes).toEqual([])
      expect(h.run()).toMatchObject({ runId: 'receipt-run', pid: 123, acceptedInputBytes: 0, state: { type: 'running' } })
      expect((await reader.readMetadata('receipt-agent'))?.promptCompletionAdmission).toEqual(before)
      expect(h.stops).toEqual([])
    } finally { await h.close() }
  }, 20_000)

  it('keeps the first condition after another explicit message replaces its predecessor', async () => {
    const h = await fixture()
    try {
      await h.store.withPromptSubmission('receipt-agent', h.failSend)
      const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
      const original = await queue.readByOperationId('original-operation')
      await h.owner.submitAgentPrompt({ ...agentPromptCondition(h.owner.agentSession('receipt-agent')),
        agentSessionId: 'receipt-agent', operationId: 'different-private-input', prompt: 'other private message', authorHuman: true })
      const before = h.run().acceptedInputBytes
      const calls = h.inputCalls.length
      expect((await h.failSend()).error.code).toBe('AGENT_PROMPT_CONDITION_CHANGED')
      expect(h.inputCalls).toHaveLength(calls)
      expect(h.run().acceptedInputBytes).toBe(before)
      expect(await queue.readByOperationId('original-operation')).toMatchObject({
        envelope: original!.envelope, promptCondition: original!.promptCondition, execution: original!.execution,
        delivery: { state: 'queued' }
      })
      expect(h.stops).toEqual([])
    } finally { await h.close() }
  }, 20_000)

  it.each(['AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'] as const)(
    'preserves %s from its actual producer, keeps the intent and allows exact retry', async code => {
      const h = await fixture()
      let restoreMissingRead: (() => void) | undefined
      try {
        const beforeSession = h.owner.agentSession('receipt-agent')
        const beforeFile = await readFile(h.store.path)
        const reply = code === 'AGENT_PROMPT_SUBMISSION_BUSY'
          ? await h.store.withPromptSubmission('receipt-agent', h.failSend)
          : await (async () => {
              const read = h.store.readMetadata.bind(h.store)
              const withPrompt = h.store.withPromptSubmission.bind(h.store)
              let producerEntered = false
              const producer = vi.spyOn(h.store, 'withPromptSubmission').mockImplementation((id, operation) =>
                withPrompt(id, async () => { producerEntered = true; return await operation() }))
              const missingRead = vi.spyOn(h.store, 'readMetadata').mockImplementation(async id =>
                producerEntered ? null : await read(id))
              restoreMissingRead = () => { missingRead.mockRestore(); producer.mockRestore() }
              return await h.failSend()
            })()
        restoreMissingRead?.()
        expect(h.requests).toHaveLength(1)
        expect(h.failures).toHaveLength(1)
        expect(h.failures[0]!.code).toBe(code)
        expect(reply).toEqual({ operationId: 'original-operation', operation: 'agent.send', ok: false,
          error: { code, message: h.failures[0]!.message, logId: h.failures[0]!.logId,
            ...(h.failures[0]!.detail === undefined ? {} : { detail: h.failures[0]!.detail }) } })
        expect(reply.error.logId).toEqual(expect.any(String))
        expect(h.failures[0]!.message.length).toBeGreaterThan(0)
        expect(h.requests[0]!.text).toBe('  original message\n第二行  ')
        expect(h.requests[0]!.message?.body).toBe(h.requests[0]!.text)
        expect(h.requests[0]!.caller).toMatchObject({ agentSessionId: 'receipt-agent', capability: expect.any(String) })
        expect(h.requests[0]!.message.sender).toEqual({ kind: 'agent-session', agentSessionId: 'receipt-agent' })
        expect(h.owner.agentSession('receipt-agent')).toEqual(beforeSession)
        expect((await readFile(h.store.path)).equals(beforeFile)).toBe(true)
        expect(h.writes).toEqual([])
        expect(h.stops).toEqual([])
        expect(h.run()).toMatchObject({ runId: 'receipt-run', pid: 123, state: { type: 'running' }, acceptedInputBytes: 0 })
        const original = await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).readByOperationId('original-operation')
        expect(JSON.parse((await h.send()).stdout)).toMatchObject({ ok: true, result: { messageId: 'original-message', delivery: { state: 'delivered' } } })
        expect(h.requests).toHaveLength(2)
        expect(h.requests[1]!.message).toEqual(h.requests[0]!.message)
        expect(h.requests[1]!.promptCondition).toEqual(h.requests[0]!.promptCondition)
        const delivered = await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).readByOperationId('original-operation')
        expect(delivered).toMatchObject({ envelope: original!.envelope, promptCondition: original!.promptCondition, execution: original!.execution, delivery: { state: 'delivered' } })
        const admitted = h.owner.agentSession('receipt-agent').promptCompletionAdmission
        expect(admitted).toMatchObject({ submissionId: 'original-message', acknowledged: true })
        expect(h.writes).toEqual([{ operationId: admitted!.operationId, data: renderAgentMuxMessageEnvelope(h.requests[0]!.message) + '\r' }])
        expect(h.owner.agentSession('receipt-agent').run).toEqual(beforeSession.run)
        expect(h.stops).toEqual([])
        const inputCalls = h.inputCalls.length
        await h.send()
        expect(h.requests).toHaveLength(2)
        expect(h.inputCalls).toHaveLength(inputCalls)
      } finally { restoreMissingRead?.(); await h.close() }
    }, 20_000
  )
})
