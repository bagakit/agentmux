import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxControlServer, requestAgentMuxControl } from '../src/control-host.js'
import type { AgentMuxControlHost, AgentMuxControlSendRequest } from '../src/control.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentMuxRunInputData } from '../src/types.js'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))

type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, operation: { operationId: string; expectedByte: number; data: AgentMuxRunInputData }): Promise<{
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
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({
    catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook, buildArgs: (_prompt, args) => [...args]
  })
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'receipt-agent', executorId: 'generic', providerId: 'generic',
    hostId: 'local', workspacePath: root, run: { runId: 'receipt-run' }, retiredRuns: [],
    hookBindingId: 'receipt-binding', hookToken: 'receipt-token', createdAt: 1, updatedAt: 1
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
    const writes: Array<{ operationId: string; data: AgentMuxRunInputData }> = []
    const stops: string[] = []
    let cursor = 0
    const run = (): CtxmuxAdapterRun => ({
      runId: stored.run.runId, lifecycleOperationId: null, program: 'generic', args: [],
      workspacePath: root, pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
      latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor
    })
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-daemon' })
    inner.kernel.status = async runId => { expect(runId).toBe(stored.run.runId); return run() }
    inner.kernel.input = async (runId, operation) => {
      expect(runId).toBe(stored.run.runId)
      expect(operation.expectedByte).toBe(cursor)
      writes.push({ operationId: operation.operationId, data: operation.data })
      cursor += typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength
      return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: cursor } }
    }
    inner.kernel.stop = async runId => { stops.push(runId) }
    const requests: AgentMuxControlSendRequest[] = []
    const failures: Array<{ code: string; message: string }> = []
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
          await owner.submitAgentPrompt({
            agentSessionId: stored.agentSessionId, ...request.promptCondition,
            prompt: request.text, operationId: request.message?.messageId ?? request.requestId,
            allowUncertainTurn: true
          })
        } catch (error) {
          const source = error as { code: string; message: string }
          failures.push({ code: source.code, message: source.message })
          throw error
        }
        return { operation: request.operation, agentSessionId: stored.agentSessionId }
      }
    }
    server = new AgentMuxControlServer(host, join(root, 'control.sock'))
    await server.start()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_')))
    async function failSend() {
      const result = await execute(process.execPath, [cli, 'send', '--to-session', stored.agentSessionId,
        '--text', '  original message\n第二行  ', '--message-id', 'original-message'], {
        env: { ...env, HOME: root, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
          AGENTMUX_AGENT_SESSION_STORE: store.path, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') },
        timeout: 10_000, maxBuffer: 256 * 1024
      }).then(() => { throw new Error('CLI unexpectedly accepted the blocked prompt.') }, error => {
        expect(error.code).toBe(1)
        expect(error.stdout).toBe('')
        expect(error.stderr.trim()).not.toBe('')
        // Node can print its own experimental-module warning before the NDJSON receipt.
        // Require exactly one actual envelope rather than accepting empty stderr or a warning.
        const receipts = error.stderr.split('\n').filter((line: string) => line.startsWith('{'))
        expect(receipts).toHaveLength(1)
        return JSON.parse(receipts[0]!) as {
          schemaVersion: number; requestId: string; operation: string; ok: boolean
          error: { code: string; message: string }
        }
      })
      return result
    }
    return { root, store, owner, writes, stops, requests, failures, run, failSend, async close() {
      try { await server!.stop() } finally { try { await owner.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
    } }
  } catch (error) {
    try { await server?.stop() } finally { try { await client?.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
    throw error
  }
}

describe('public Prompt errors through Control and built CLI', () => {
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
              const missingRead = vi.spyOn(h.store, 'load').mockResolvedValueOnce([])
              restoreMissingRead = () => missingRead.mockRestore()
              return await h.failSend()
            })()
        restoreMissingRead?.()
        expect(h.requests).toHaveLength(1)
        expect(h.failures).toHaveLength(1)
        expect(h.failures[0]!.code).toBe(code)
        expect(reply).toEqual({ schemaVersion: h.requests[0]!.schemaVersion,
          requestId: h.requests[0]!.requestId, operation: 'send', ok: false,
          error: { code, message: h.failures[0]!.message } })
        expect(h.failures[0]!.message.length).toBeGreaterThan(0)
        expect(h.requests[0]!.text).toBe('  original message\n第二行  ')
        expect(h.requests[0]!.message?.body).toBe(h.requests[0]!.text)
        expect(h.owner.agentSession('receipt-agent')).toEqual(beforeSession)
        expect((await readFile(h.store.path)).equals(beforeFile)).toBe(true)
        expect(h.writes).toEqual([])
        expect(h.stops).toEqual([])
        expect(h.run()).toMatchObject({ runId: 'receipt-run', pid: 123, state: { type: 'running' }, acceptedInputBytes: 0 })
        const recovered = await requestAgentMuxControl(h.requests[0]!, join(h.root, 'control.sock'))
        expect(recovered).toMatchObject({ ok: true, requestId: reply.requestId, operation: 'send', result: { agentSessionId: 'receipt-agent' } })
        const admitted = h.owner.agentSession('receipt-agent').promptCompletionAdmission
        expect(admitted).toMatchObject({ submissionId: 'original-message', acknowledged: true })
        expect(h.writes).toEqual([{ operationId: admitted!.operationId, data: '  original message\n第二行  \r' }])
        expect(h.owner.agentSession('receipt-agent').run).toEqual(beforeSession.run)
        expect(h.stops).toEqual([])
      } finally { restoreMissingRead?.(); await h.close() }
    }
  )
})
