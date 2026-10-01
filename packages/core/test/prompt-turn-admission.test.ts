import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentTurnCompletionIdentity } from '../dist/agent-session-identity.js'
import {
  AgentMuxClient,
  AgentMuxError,
  AgentMuxFileAgentSessionStore,
  AgentProviderRegistry,
  agentPromptCondition,
  defineAgentProvider,
  renderAgentMuxMessageEnvelope,
  type AgentMuxAgentPromptInput,
  type AgentMuxClientEvent,
  type AgentMuxStoredAgentSession
} from '../dist/index.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => isolation.homedir
}))

type Mode = 'single-phase' | 'render-then-submit'
type Fault = 'none' | 'unknown-before' | 'not-applied-before' | 'unknown-after' | 'hold'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

async function reject(p: Promise<unknown>, code: string) {
  let error: unknown
  try {
    await p
  } catch (e) {
    error = e
  }
  assert.ok(error instanceof AgentMuxError)
  assert.equal(error.code, code, error.stack)
  return { code: error.code, detail: error.detail, message: error.message }
}

let seq = 0

async function harness(mode: Mode) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'amux-turn-adm-'))
  isolation.homedir = join(root, 'home')
  await fsp.mkdir(isolation.homedir, { recursive: true })
  const scope = join(root, 'scope')
  await fsp.mkdir(scope, { recursive: true })
  const dir = join(scope, `${mode}-${++seq}`)
  await fsp.mkdir(dir, { recursive: true })
  const runtimeDirectory = join(scope, `runtime-${seq}`)
  await fsp.mkdir(runtimeDirectory, { mode: 0o700, recursive: true })
  const sockPath = join(runtimeDirectory, 'ctxmux.sock')
  const storePath = join(dir, 'sessions.json')

  const id = `Q${randomBytes(12).toString('base64url').slice(0, 15)}`
  const runId = randomUUID()
  const daemonId = randomUUID()
  const runtimeId = randomUUID()

  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtimeDirectory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(scope, 'durable'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(scope, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath)

  let failNoticeOnce = false
  let noticeFailures = 0

  class NoticeFaultStore extends AgentMuxFileAgentSessionStore {
    override async compareAndSwap(
      expected: AgentMuxStoredAgentSession | null,
      next: AgentMuxStoredAgentSession | null,
      signal?: AbortSignal
    ): Promise<void> {
      if (
        failNoticeOnce &&
        (expected?.promptCompletionAdmission?.submissionId === 'two' || expected?.promptCompletionAdmission?.submissionId === 'second') &&
        (next?.promptCompletionAdmission?.submissionId === 'two' || next?.promptCompletionAdmission?.submissionId === 'second') &&
        !expected.promptCompletionAdmission.acknowledged &&
        !next.promptCompletionAdmission.acknowledged &&
        next.terminalPromptDelivery?.reason === 'turn-end-unconfirmed'
      ) {
        failNoticeOnce = false
        noticeFailures++
        throw new Error('private optional notice persistence failure after durable claim')
      }
      return await super.compareAndSwap(expected, next, signal)
    }
  }

  const store = new NoticeFaultStore(storePath)
  let planPrefix = ''
  const template = new AgentProviderRegistry().get('codex')

  function createProvider() {
    return defineAgentProvider({
      catalog: {
        ...template.catalog,
        id: 'admission-fixture',
        label: 'Admission Fixture',
        executable: process.execPath,
        expectedProcess: 'fixture',
        hookStrategy: { kind: 'native', installation: 'unmanaged' }
      },
      hook: template.hook,
      buildArgs: (_, args) => [...args],
      ...(mode === 'render-then-submit'
        ? {
            terminalPromptRender: template.terminalPromptRender!,
            planPromptInput: (p: string) => ({
              kind: 'render-then-submit' as const,
              payload: planPrefix + p,
              renderedText: planPrefix + p,
              submit: '\r'
            })
          }
        : planPrefix
          ? {
              planPromptInput: (p: string) => ({
                kind: 'single-phase' as const,
                data: planPrefix + p + '\r'
              })
            }
          : {})
    })
  }

  await store.compareAndSwap(null, {
    kind: 'agent',
    agentSessionId: id,
    providerId: 'admission-fixture',
    executorId: 'admission-fixture',
    hostId: 'local',
    workspacePath: dir,
    run: { runId },
    retiredRuns: [],
    hookBindingId: 'b'.repeat(43),
    hookToken: createHash('sha256').update(dir).digest('base64url'),
    createdAt: 1,
    updatedAt: 1
  })

  let cursor = 7
  let fault: Fault = 'none'
  let faultData: string | undefined
  let gate = deferred()
  let entered = deferred()
  let lossPredicate: ((op: any) => boolean) | null = null

  const dispatchRows: AgentMuxStoredAgentSession[] = []
  const ledger = new Map<string, { op: any; range: { start_byte: number; end_byte: number }; data: string }>()
  const calls: any[] = []
  const writes: { data: string; range: { start_byte: number; end_byte: number }; op?: any }[] = []
  const accepted: { op: any; range: { start_byte: number; end_byte: number } }[] = []
  const events: AgentMuxClientEvent[] = []
  const clients: AgentMuxClient[] = []
  const connections = new Set<Socket>()

  function run() {
    return {
      native_service: null,
      id: runId,
      spec: { program: process.execPath, args: [], cwd: dir, env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] },
      lineage: null,
      backend: { type: 'native' },
      capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: true, fork_level_b: true, replay: 'raw_from_start' },
      pid: null,
      state: { type: 'running' },
      latest_output_bytes: 0,
      durable_output_bytes: 0,
      first_available_byte: 0,
      attachments: connections.size,
      applied_input_bytes: cursor,
      current_size: null
    }
  }

  const runtime = {
    daemonInstanceId: daemonId,
    runtimeId,
    runtimeIdPersistence: 'state_dir',
    buildId: 'ctxmuxd/0.1.0',
    protocolGeneration: 18,
    platform: 'macos',
    arch: 'aarch64',
    capabilities: {
      'native.start': 1,
      'native.recoverable_input': 1,
      'native.recoverable_stop': 1,
      'services.persistent_state': 1,
      'services.planned_exec_upgrade_continuity': 1
    }
  }

  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => {})
    let pending = ''
    let tail = Promise.resolve()

    const send = (frame: any) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
    }
    const respond = (response: any) => send({ type: 'response', response })

    const processFrame = async (frame: any) => {
      if (frame.type === 'hello') {
        assert.equal(frame.hello.protocol, 18)
        send({ type: 'hello', runtime })
        return
      }
      if (frame.type === 'detach') {
        send({ type: 'detached' })
        return
      }
      assert.equal(frame.type, 'request')
      const req = frame.request
      if (req.type === 'list') {
        respond({
          type: 'runs',
          runs: [
            {
              id: runId,
              backend: 'native',
              pid: null,
              state: { type: 'running' },
              latest_output_bytes: 0,
              retained_output_bytes: 0,
              attachments: connections.size
            }
          ],
          next_cursor: null
        })
      } else if (req.type === 'status') {
        assert.equal(req.id, runId)
        respond({ type: 'status', run: run() })
      } else if (req.type === 'attach') {
        assert.equal(req.id, runId)
        send({
          type: 'attached',
          snapshot: {
            run: run(),
            replay: { first_available_byte: 0, latest_output_bytes: 0, truncated: false },
            terminal: { type: 'unknown', reason: 'origin_unknown' },
            resize_revision: 0
          }
        })
      } else if (req.type === 'recoverable_input') {
        const op = req.operation
        assert.equal(op.id, runId)
        assert.equal(op.daemon_instance, daemonId)
        assert.ok(op.data.length > 0)
        const dataBuf = Buffer.from(op.data)
        const dataStr = dataBuf.toString('utf8')
        const normalizedOp = {
          daemonInstance: op.daemon_instance,
          operationKey: op.operation_key,
          runId: op.id,
          expectedByte: op.expected_byte,
          data: dataStr
        }
        calls.push(normalizedOp)
        dispatchRows.push(await stored())

        const active = faultData === undefined || dataStr === faultData ? fault : 'none'
        if (active === 'hold') {
          entered.resolve()
          await gate.promise
        }
        if (active === 'unknown-before') {
          respond({
            type: 'control_rejected',
            failure: { error: { code: 'io', message: 'private SDK outcome unknown before observed write' }, disposition: 'unknown' }
          })
          return
        }
        if (active === 'not-applied-before') {
          respond({
            type: 'control_rejected',
            failure: { error: { code: 'io', message: 'private SDK confirms not_applied' }, disposition: 'not_applied' }
          })
          return
        }
        const old = ledger.get(op.operation_key)
        if (old) {
          assert.deepEqual(normalizedOp, old.op)
          assert.equal(op.expected_byte, old.range.start_byte)
          respond({ type: 'input_applied', run: run(), range: old.range })
          return
        }

        if (op.expected_byte !== cursor) {
          respond({
            type: 'control_rejected',
            failure: { error: { code: 'input_cursor_mismatch', message: 'private SDK expected-byte rejection' }, disposition: 'not_applied' }
          })
          return
        }

        const range = { start_byte: cursor, end_byte: cursor + dataBuf.length }
        cursor = range.end_byte
        ledger.set(op.operation_key, { op: normalizedOp, range, data: dataStr })
        writes.push({ data: dataStr, range, op: normalizedOp })
        accepted.push({ op: normalizedOp, range })

        if (active === 'unknown-after' || lossPredicate?.(op)) {
          socket.destroy()
          return
        }

        respond({ type: 'input_applied', run: run(), range })
      } else if (req.type === 'input') {
        const dataBuf = Buffer.from(req.data)
        const dataStr = dataBuf.toString('utf8')
        const range = { start_byte: cursor, end_byte: cursor + dataBuf.length }
        cursor = range.end_byte
        writes.push({ data: dataStr, range })
        respond({ type: 'input_applied', run: run(), range })
      } else if (req.type === 'signal') {
        respond({ type: 'signal_delivered', run: run() })
      } else {
        throw new Error(`Unexpected frame request: ${req.type}`)
      }
    }

    socket.on('data', (bytes) => {
      pending += bytes.toString('utf8')
      for (;;) {
        const idx = pending.indexOf('\n')
        if (idx < 0) break
        const line = pending.slice(0, idx)
        pending = pending.slice(idx + 1)
        tail = tail
          .then(() => processFrame(JSON.parse(line)))
          .catch(() => {
            socket.destroy()
          })
      }
    })
  })

  await new Promise<void>((resolveReady) => {
    server.listen(sockPath, () => resolveReady())
  })

  async function open() {
    const c = new AgentMuxClient({ providers: [createProvider()], store: new NoticeFaultStore(storePath) })
    clients.push(c)
    c.onEvent((e) => events.push(e))
    await c.connect()
    return c
  }

  let client = await open()

  function prepare(operationId: string, prompt: string, allowUncertainTurn = false, c = client): AgentMuxAgentPromptInput {
    return {
      ...agentPromptCondition(c.agentSession(id)),
      agentSessionId: id,
      operationId,
      prompt,
      allowUncertainTurn
    }
  }

  async function stored(): Promise<AgentMuxStoredAgentSession> {
    const rows = await store.load()
    assert.equal(rows.length, 1)
    const row = rows[0] as AgentMuxStoredAgentSession
    assert.equal(row.agentSessionId, id)
    assert.equal(row.run.runId, runId)
    return row
  }

  async function complete(at: number) {
    const previous = await stored()
    await store.compareAndSwap(previous, {
      ...previous,
      updatedAt: Math.max(previous.updatedAt, at),
      semanticStatus: { state: 'done', source: 'native-hook', observedAt: at }
    })
    await reopen()
  }

  async function reopen() {
    await client.dispose()
    client = await open()
    return client
  }

  return {
    id,
    runId,
    store,
    calls,
    writes,
    accepted,
    events,
    dispatchRows,
    failOptionalNoticeOnce() {
      failNoticeOnce = true
    },
    get noticeFailures() {
      return noticeFailures
    },
    prepare,
    stored,
    complete,
    reopen,
    open,
    setPlanPrefix(p: string) {
      planPrefix = p
    },
    get client() {
      return client
    },
    setFault(f: Fault, data?: string) {
      fault = f
      faultData = data
      gate = deferred()
      entered = deferred()
    },
    setLossPredicate(fn: ((op: any) => boolean) | null) {
      lossPredicate = fn
    },
    waitEntered: () => entered.promise,
    release: () => gate.resolve(),
    async close() {
      for (const c of clients) await c.dispose()
      for (const s of connections) s.destroy()
      await new Promise((r) => server.close(r))
      vi.unstubAllEnvs()
      await fsp.rm(root, { recursive: true, force: true })
    }
  }
}

describe('adapted original 10 owning prompt admission cases', { timeout: 30000 }, () => {
  it('keeps unknown turns honest and offers explicit continuation without weakening replay', async () => {
    const h = await harness('render-then-submit')
    try {
      const first = h.prepare('first', 'hello')
      await h.client.submitAgentPrompt(first)
      const firstRow = await h.stored()
      expect(firstRow.promptCompletionAdmission?.acknowledged).toBe(true)
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r'])
      await expect(h.client.submitAgentPrompt(h.prepare('second', 'next'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r'])
      const second = h.prepare('second', 'next', true)
      await h.client.submitAgentPrompt(second)
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r', 'next', '\r'])
      expect(h.client.agentSession(h.id).terminalPromptDelivery).toMatchObject({
        reason: 'turn-end-unconfirmed',
        submissionId: 'second'
      })
      expect((await h.store.loadTimeline(h.id)).items.find((item) => item.id === 'prompt:second')).toMatchObject({
        content: 'next',
        status: 'complete'
      })
      await h.client.submitAgentPrompt(second)
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r', 'next', '\r'])
      await expect(h.client.submitAgentPrompt({ ...second, prompt: 'changed' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    } finally {
      await h.close()
    }
  })

  it('uses each native completion once and does not let automation bypass a consumed turn', async () => {
    const h = await harness('render-then-submit')
    try {
      await h.client.submitAgentPrompt(h.prepare('first', 'hello'))
      await h.complete(200)
      await h.client.submitAgentPrompt(h.prepare('after-end', 'next'))
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r', 'next', '\r'])
      expect(h.client.agentSession(h.id).terminalPromptDelivery?.reason).not.toBe('turn-end-unconfirmed')
      await expect(h.client.submitAgentPrompt(h.prepare('unknown', 'later'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      const session = h.client.agentSession(h.id)
      const completion = agentTurnCompletionIdentity(session)
      const currentRun = (await h.client.listRuns()).find((r) => r.runId === h.runId)!
      await expect(
        h.client.submitAgentPrompt({
          ...agentPromptCondition(session),
          agentSessionId: h.id,
          operationId: 'auto',
          prompt: 'auto',
          allowUncertainTurn: true,
          ...(completion ? { expectedCompletionId: completion } : {}),
          expectedInputByte: currentRun.acceptedInputBytes!
        })
      ).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r', 'next', '\r'])
    } finally {
      await h.close()
    }
  })

  it('does not overwrite a partially accepted claim from a previous owner', async () => {
    const h = await harness('render-then-submit')
    try {
      const request = h.prepare('original', 'hello')
      h.setFault('hold', '\r')
      const first = h.client.submitAgentPrompt(request)
      await h.waitEntered()
      expect(h.writes.map((x) => x.data)).toEqual(['hello'])
      const secondClient = await h.open()
      const different = h.prepare('different', 'new text', true, secondClient)
      await reject(secondClient.submitAgentPrompt(different), 'AGENT_PROMPT_SUBMISSION_BUSY')
      expect(h.calls.length).toBe(2)
      h.release()
      await first
      expect(h.writes.map((x) => x.data)).toEqual(['hello', '\r'])
      const row = await h.stored()
      expect(row.terminalPromptSubmission?.submissionId).toBe('original')
      expect(row.terminalPromptSubmission?.submit.acknowledged).toBe(true)
      await secondClient.dispose()
    } finally {
      await h.close()
    }
  })

  it('applies the same one-message turn boundary to a generic default single-phase Provider', async () => {
    // Harness with empty planPrefix omits planPromptInput in defineAgentProvider,
    // exercising the generic default single-phase provider fallback path.
    const h = await harness('single-phase')
    try {
      await h.client.submitAgentPrompt(h.prepare('first', 'hello'))
      const firstRow = await h.stored()
      expect(firstRow.promptCompletionAdmission?.acknowledged).toBe(true)
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r'])
      await expect(h.client.submitAgentPrompt(h.prepare('second', 'next'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r'])
      const second = h.prepare('second', 'next', true)
      await h.client.submitAgentPrompt(second)
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r', 'next\r'])
      expect(h.client.agentSession(h.id).terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
      expect((await h.store.loadTimeline(h.id)).items.find((item) => item.id === 'prompt:second')).toMatchObject({ status: 'complete' })
      await h.client.submitAgentPrompt(second)
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r', 'next\r'])
      expect(h.client.agentSession(h.id).terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
      await expect(h.client.submitAgentPrompt(h.prepare('third', 'later'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await expect(h.client.submitAgentPrompt({ ...second, prompt: 'different' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      await h.complete(200)
      await h.client.submitAgentPrompt(h.prepare('after-end', 'after'))
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r', 'next\r', 'after\r'])
      expect(h.client.agentSession(h.id).terminalPromptDelivery).toBeUndefined()
      await expect(h.client.submitAgentPrompt(h.prepare('unknown', 'later'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    } finally {
      await h.close()
    }
  })

  it('keeps a partial single-phase claim exclusive and permits only zero-byte old-owner takeover', async () => {
    const h = await harness('single-phase')
    try {
      const request = h.prepare('old', 'hello')
      h.setFault('hold', 'hello\r')
      const first = h.client.submitAgentPrompt(request)
      await h.waitEntered()
      const second = await h.open()
      const other = h.prepare('new', 'next', true, second)
      await reject(second.submitAgentPrompt(other), 'AGENT_PROMPT_SUBMISSION_BUSY')
      expect(h.writes).toEqual([])
      h.release()
      await first
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r'])
      await second.dispose()
      await h.complete(200)
      const acceptedReq = h.prepare('accepted', 'sent')
      h.setFault('unknown-after', 'sent\r')
      await reject(h.client.submitAgentPrompt(acceptedReq), 'CTXMUX_io')
      h.setFault('none')
      await h.reopen()
      await expect(h.client.submitAgentPrompt(h.prepare('different', 'later'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.client.submitAgentPrompt(acceptedReq)
      expect(h.writes.map((x) => x.data)).toEqual(['hello\r', 'sent\r'])
    } finally {
      await h.close()
    }
  })

  it.each([false, true])('never lends a failed zero-byte operation its explicit choice to a different operation (single phase=%s)', async (singlePhase) => {
    const mode = singlePhase ? 'single-phase' : 'render-then-submit'
    const h = await harness(mode)
    try {
      await h.client.submitAgentPrompt(h.prepare('first', 'hello'))
      const second = h.prepare('second', 'next', true)
      h.setFault('not-applied-before', singlePhase ? 'next\r' : 'next')
      await reject(h.client.submitAgentPrompt(second), 'CTXMUX_io')
      const old = await h.stored()
      expect(old.promptCompletionAdmission?.notApplied).toBe(true)
      await expect(h.client.submitAgentPrompt(h.prepare('third', 'different'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes.map((x) => x.data)).toEqual(singlePhase ? ['hello\r'] : ['hello', '\r'])
      h.setFault('none')
      await h.client.submitAgentPrompt(second)
      expect(h.client.agentSession(h.id).terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
      expect(h.writes.map((x) => x.data)).toEqual(singlePhase ? ['hello\r', 'next\r'] : ['hello', '\r', 'next', '\r'])
      await expect(h.client.submitAgentPrompt(h.prepare('third', 'different'))).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.client.submitAgentPrompt(h.prepare('third', 'different', true))
      expect(h.writes.map((x) => x.data)).toEqual(singlePhase ? ['hello\r', 'next\r', 'different\r'] : ['hello', '\r', 'next', '\r', 'different', '\r'])
    } finally {
      await h.close()
    }
  })

  it('delivers a projected A2A body without trimming its original trailing bytes', async () => {
    const h = await harness('single-phase')
    try {
      const body = 'original body \n\n  '
      const prompt = renderAgentMuxMessageEnvelope({
        schema: 'agentmux.a2a.v1',
        messageId: 'msg',
        operationId: 'message-op',
        createdAt: 1,
        sender: { kind: 'agent-session', agentSessionId: 'sender' },
        recipient: { kind: 'agent-session', agentSessionId: h.id },
        threadId: 'thread',
        correlationId: 'correlation',
        replyTo: null,
        workspaceId: null,
        senderSessionId: 'sender',
        senderRunId: 'sender-run',
        recipientSessionId: h.id,
        recipientRunId: h.runId,
        body
      })
      await h.client.submitAgentPrompt(h.prepare('a2a-body', prompt))
      expect(h.writes.map((x) => x.data)).toEqual([`${prompt}\r`])
      expect((await h.store.loadTimeline(h.id)).items.find((item) => item.id === 'prompt:a2a-body')).toMatchObject({ content: prompt })
      await expect(h.client.submitAgentPrompt(h.prepare('blank', ' \n\t'))).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
    } finally {
      await h.close()
    }
  })

  it.each([false, true])('durably keeps the scoped uncertainty notice before first input even if publication is interrupted (single phase=%s)', async (singlePhase) => {
    const mode = singlePhase ? 'single-phase' : 'render-then-submit'
    const h = await harness(mode)
    try {
      await h.client.submitAgentPrompt(h.prepare('first', 'hello'))
      h.failOptionalNoticeOnce()
      const second = h.prepare('second', 'next', true)
      await h.client.submitAgentPrompt(second)
      expect(h.noticeFailures).toBe(1)
      const dispatch = h.dispatchRows.find((r) => r.promptCompletionAdmission?.submissionId === 'second')
      expect(dispatch).toBeDefined()
      expect(dispatch!.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
      expect(dispatch!.promptCompletionAdmission?.acknowledged).toBe(false)
      const row = await h.stored()
      expect(row.promptCompletionAdmission?.acknowledged).toBe(true)
      expect(row.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
      const diagnostics = h.events.filter((e: any) => e.type === 'agent-error' && e.code === 'AGENT_PROMPT_DELIVERY_PERSIST_FAILED')
      expect(diagnostics.length).toBe(1)
      expect((diagnostics[0] as { agentSessionId?: string }).agentSessionId).toBeUndefined()
      expect(h.writes.map((x) => x.data)).toEqual(singlePhase ? ['hello\r', 'next\r'] : ['hello', '\r', 'next', '\r'])
    } finally {
      await h.close()
    }
  })
})

describe('durable prompt input recovery (24 frozen research behaviors)', { timeout: 30000 }, () => {
  for (const mode of ['single-phase', 'render-then-submit'] as const) {
    describe(mode, () => {
      it('acknowledged exact replay survives fresh Client', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'original  ')
          await h.client.submitAgentPrompt(request)
          const before = h.writes.length
          const row = await h.stored()
          expect(row.promptCompletionAdmission?.acknowledged).toBe(true)
          expect(row.promptCompletionAdmission?.intent?.prompt).toBe('original  ')
          expect(row.promptCompletionAdmission?.uncertainTurn).toBeUndefined()
          expect((row.promptCompletionAdmission?.intent as any)?.uncertainTurn).toBeUndefined()
          await h.reopen()
          await h.client.submitAgentPrompt(request)
          expect(h.writes.length).toBe(before)
          expect(h.writes.map((x) => x.data)).toEqual(mode === 'single-phase' ? ['original  \r'] : ['original  ', '\r'])
          await reject(h.client.submitAgentPrompt({ ...request, prompt: 'changed' }), 'AGENT_PROMPT_OPERATION_CONFLICT')
        } finally {
          await h.close()
        }
      })

      it('live cross-Client scope is BUSY, released unknown rejoins exact tuple', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'held')
          h.setFault('hold', mode === 'single-phase' ? 'held\r' : 'held')
          const first = h.client.submitAgentPrompt(request)
          await h.waitEntered()
          const second = await h.open()
          const other = h.prepare('two', 'different', true, second)
          await reject(second.submitAgentPrompt(other), 'AGENT_PROMPT_SUBMISSION_BUSY')
          expect(h.calls.length).toBe(1)
          h.release()
          await first
          expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
          await second.dispose()
        } finally {
          await h.close()
        }
      })

      it('unknown zero-cursor is never negative proof and new intent cannot overtake', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'unknown')
          h.setFault('unknown-before', mode === 'single-phase' ? 'unknown\r' : 'unknown')
          await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
          expect(h.writes.length).toBe(0)
          const first = (await h.stored()).promptCompletionAdmission!
          expect(first.notApplied).toBeUndefined()
          expect((await h.stored()).terminalPromptDelivery?.reason).toBe('input-unconfirmed')
          await h.reopen()
          const different = h.prepare('two', 'different', true)
          await reject(h.client.submitAgentPrompt(different), 'CTXMUX_io')
          expect(h.writes.length).toBe(0)
          expect(h.calls.length).toBe(2)
          expect(h.calls[1]).toEqual(h.calls[0])
          expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('one')
          h.setFault('none')
          await h.client.submitAgentPrompt(request)
          expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
        } finally {
          await h.close()
        }
      })

      it('typed not_applied does not lend its explicit choice', async () => {
        const h = await harness(mode)
        try {
          await h.client.submitAgentPrompt(h.prepare('prior', 'prior'))
          const second = h.prepare('two', 'new', true)
          h.setFault('not-applied-before', mode === 'single-phase' ? 'new\r' : 'new')
          await reject(h.client.submitAgentPrompt(second), 'CTXMUX_io')
          const old = await h.stored()
          expect(old.promptCompletionAdmission?.notApplied).toBe(true)
          const before = h.writes.length
          await h.reopen()
          await reject(h.client.submitAgentPrompt(h.prepare('three', 'other')), 'AGENT_TURN_END_UNCONFIRMED')
          expect(h.writes.length).toBe(before)
          h.setFault('none')
          await h.client.submitAgentPrompt(second)
          expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
        } finally {
          await h.close()
        }
      })

      it('lost ACK recovers receipt without duplicate body then allows own explicit intent', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'lost')
          h.setFault('unknown-after', mode === 'single-phase' ? 'lost\r' : '\r')
          await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
          const before = h.writes.length
          expect(before).toBeGreaterThan(0)
          expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(false)
          await h.reopen()
          h.setFault('none')
          await h.client.submitAgentPrompt(h.prepare('two', 'next', true))
          expect(h.writes.map((x) => x.data)).toEqual(
            mode === 'single-phase' ? ['lost\r', 'next\r'] : ['lost', '\r', 'next', '\r']
          )
          expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('two')
        } finally {
          await h.close()
        }
      })

      it('optional notice persistence failure cannot block healthy input after durable claim', async () => {
        const h = await harness(mode)
        try {
          await h.client.submitAgentPrompt(h.prepare('prior', 'prior'))
          h.failOptionalNoticeOnce()
          const request = h.prepare('two', 'next', true)
          await h.client.submitAgentPrompt(request)
          expect(h.noticeFailures).toBe(1)
          const dispatch = h.dispatchRows.find((r) => r.promptCompletionAdmission?.submissionId === 'two')
          expect(dispatch).toBeDefined()
          expect(dispatch!.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
          expect(dispatch!.promptCompletionAdmission?.acknowledged).toBe(false)
          const row = await h.stored()
          expect(row.promptCompletionAdmission?.acknowledged).toBe(true)
          expect(row.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
          const diagnostics = h.events.filter(
            (e: any) => e.type === 'agent-error' && e.code === 'AGENT_PROMPT_DELIVERY_PERSIST_FAILED'
          )
          expect(diagnostics.length).toBe(1)
          expect((diagnostics[0] as { agentSessionId?: string }).agentSessionId).toBeUndefined()
          expect(h.writes.map((x) => x.data)).toEqual(
            mode === 'single-phase' ? ['prior\r', 'next\r'] : ['prior', '\r', 'next', '\r']
          )
        } finally {
          await h.close()
        }
      })

      it('explicit uncertainty survives retry after unknown SDK reply', async () => {
        const h = await harness(mode)
        try {
          await h.client.submitAgentPrompt(h.prepare('prior', 'prior'))
          const request = h.prepare('two', 'new', true)
          h.setFault('unknown-after', mode === 'single-phase' ? 'new\r' : '\r')
          await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
          const unconfirmed = await h.stored()
          expect(unconfirmed.terminalPromptDelivery?.reason).toBe('input-unconfirmed')
          expect(unconfirmed.promptCompletionAdmission?.acknowledged).toBe(false)
          expect(unconfirmed.promptCompletionAdmission?.uncertainTurn).toBe(true)
          expect((unconfirmed.promptCompletionAdmission?.intent as any)?.uncertainTurn).toBeUndefined()
          const before = h.writes.length
          await h.reopen()
          h.setFault('none')
          await h.client.submitAgentPrompt({ ...request, allowUncertainTurn: false })
          expect(h.writes.length).toBe(before)
          const row = await h.stored()
          expect(row.promptCompletionAdmission?.acknowledged).toBe(true)
          expect(row.promptCompletionAdmission?.uncertainTurn).toBe(true)
          expect((row.promptCompletionAdmission?.intent as any)?.uncertainTurn).toBeUndefined()
          expect(row.terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
          expect(row.terminalPromptDelivery?.submissionId).toBe('two')
          // Assert that exactly one uncertainTurn fact exists in the durable stored session
          const matches = JSON.stringify(row).match(/"uncertainTurn":\s*true/g)
          expect(matches?.length).toBe(1)
        } finally {
          await h.close()
        }
      })

      it('missing outer uncertainTurn is not masked by legacy or spurious intent property', async () => {
        const h = await harness(mode)
        try {
          await h.client.submitAgentPrompt(h.prepare('prior', 'prior'))
          const request = h.prepare('two', 'new', true)
          h.setFault('unknown-after', mode === 'single-phase' ? 'new\r' : '\r')
          await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')

          // Inject a spurious intent.uncertainTurn while removing outer uncertainTurn
          const current = await h.stored()
          const corrupted: any = structuredClone(current)
          delete corrupted.promptCompletionAdmission.uncertainTurn
          corrupted.promptCompletionAdmission.intent.uncertainTurn = true
          await h.store.compareAndSwap(current, corrupted)

          // Normalizer does not retain or accept intent.uncertainTurn
          const reloaded = await h.stored()
          expect((reloaded.promptCompletionAdmission?.intent as any)?.uncertainTurn).toBeUndefined()
          expect(reloaded.promptCompletionAdmission?.uncertainTurn).toBeUndefined()

          // Fresh client reopens and settles lost ACK without allowUncertainTurn
          await h.reopen()
          h.setFault('none')
          await h.client.submitAgentPrompt({ ...request, allowUncertainTurn: false })

          // Because outer uncertainTurn was missing and intent copy is ignored, notice is cleared
          const finalRow = await h.stored()
          expect(finalRow.promptCompletionAdmission?.acknowledged).toBe(true)
          expect(finalRow.promptCompletionAdmission?.uncertainTurn).toBeUndefined()
          expect(finalRow.terminalPromptDelivery).toBeUndefined()
        } finally {
          await h.close()
        }
      })

      it('stale predecessor refuses without overwriting later admission', async () => {
        const h = await harness(mode)
        try {
          const one = h.prepare('one', 'one')
          const stale = h.prepare('stale', 'stale', true)
          await h.client.submitAgentPrompt(one)
          const before = await h.stored()
          const n = h.writes.length
          await reject(h.client.submitAgentPrompt(stale), 'AGENT_PROMPT_INPUT_UNCONFIRMED')
          expect(h.writes.length).toBe(n)
          expect((await h.stored()).promptCompletionAdmission).toEqual(before.promptCompletionAdmission)
          await reject(
            h.client.submitAgentPrompt({ ...h.prepare('wrong-run', 'wrong', true), expectedRun: { runId: 'other' } }),
            'STALE_AGENT_SESSION'
          )
          expect(h.writes.length).toBe(n)
        } finally {
          await h.close()
        }
      })

      it('fresh Provider plan cannot reconstruct or change the frozen original tuple', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'frozen')
          h.setFault('unknown-before', mode === 'single-phase' ? 'frozen\r' : 'frozen')
          await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
          const original = structuredClone(h.calls[0])
          h.setFault('none')
          h.setPlanPrefix('CHANGED ')
          await h.reopen()
          await h.client.submitAgentPrompt(request)
          expect(h.calls[1]).toEqual(original)
          expect(h.writes.map((x) => x.data)).toEqual(
            mode === 'single-phase' ? ['frozen\r'] : ['frozen', '\r']
          )
        } finally {
          await h.close()
        }
      })

      it('missing captured predecessor and pre-admission abort perform zero Input', async () => {
        const h = await harness(mode)
        try {
          const request = h.prepare('one', 'one')
          const missing = { ...request }
          delete (missing as Partial<AgentMuxAgentPromptInput>).afterSubmissionId
          await reject(h.client.submitAgentPrompt(missing), 'AGENT_PROMPT_INPUT_UNCONFIRMED')
          expect(h.calls.length).toBe(0)
          expect((await h.stored()).promptCompletionAdmission).toBeUndefined()
          const controller = new AbortController()
          controller.abort()
          await reject(h.client.submitAgentPrompt({ ...request, signal: controller.signal }), 'AGENT_PROMPT_CANCELLED')
          expect(h.calls.length).toBe(0)
          expect((await h.stored()).promptCompletionAdmission).toBeUndefined()
        } finally {
          await h.close()
        }
      })

      if (mode === 'render-then-submit') {
        it('partial payload receipt is recovered before new explicit bytes', async () => {
          const h = await harness(mode)
          try {
            const request = h.prepare('one', 'partial')
            h.setFault('unknown-before', '\r')
            await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
            expect(h.writes.map((x) => x.data)).toEqual(['partial'])
            const old = await h.stored()
            expect(old.promptCompletionAdmission?.acknowledged).toBe(false)
            expect(old.promptCompletionAdmission?.notApplied).not.toBe(true)
            await h.reopen()
            h.setFault('none')
            await h.client.submitAgentPrompt(h.prepare('two', 'next', true))
            expect(h.writes.map((x) => x.data)).toEqual(['partial', '\r', 'next', '\r'])
            expect(h.calls[2]).toEqual(h.calls[0])
            expect(h.calls[3]).toEqual(h.calls[1])
          } finally {
            await h.close()
          }
        })

        it('actual raw input terminalizes the old submit range without losing accepted body', async () => {
          const h = await harness(mode)
          try {
            const request = h.prepare('one', 'partial')
            h.setFault('unknown-before', '\r')
            await reject(h.client.submitAgentPrompt(request), 'CTXMUX_io')
            h.setFault('none')
            await h.client.writeAgent({ agentSessionId: h.id, expectedRun: { runId: h.runId }, data: 'h', source: 'user' })
            await h.reopen()
            await reject(h.client.submitAgentPrompt(request), 'CTXMUX_input_cursor_mismatch')
            const old = await h.stored()
            expect(old.terminalPromptSubmission?.payload.acknowledged).toBe(true)
            expect(old.terminalPromptSubmission?.submit.notApplied).toBe(true)
            expect(old.promptCompletionAdmission?.notApplied).not.toBe(true)
            await h.client.submitAgentPrompt(h.prepare('two', 'next', true))
            expect(h.writes.map((x) => x.data)).toEqual(['partial', 'h', 'next', '\r'])
            expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('two')
          } finally {
            await h.close()
          }
        })
      }

      it('automatic human-byte fence is actual public Run and cannot be bypassed', async () => {
        const h = await harness(mode)
        try {
          await h.client.submitAgentPrompt(h.prepare('one', 'one'))
          await h.complete(200)
          const session = h.client.agentSession(h.id)
          const completion = agentTurnCompletionIdentity(session)
          expect(completion).toBeDefined()
          const current = (await h.client.listRuns()).find((r) => r.runId === h.runId)!
          expect(Number.isSafeInteger(current.acceptedInputBytes)).toBe(true)
          const request = {
            ...h.prepare('auto', 'automatic'),
            expectedCompletionId: completion!,
            expectedInputByte: current.acceptedInputBytes!
          }
          await h.client.writeAgent({ agentSessionId: h.id, expectedRun: { runId: h.runId }, data: 'h', source: 'user' })
          const n = h.writes.length
          await reject(h.client.submitAgentPrompt({ ...request, allowUncertainTurn: true }), 'AGENT_COMPLETION_CHANGED')
          expect(h.writes.length).toBe(n)
          await h.complete(300)
          const ready = h.client.agentSession(h.id)
          const fence = (await h.client.listRuns()).find((r) => r.runId === h.runId)!
          await h.client.submitAgentPrompt({
            ...h.prepare('auto-new', 'automatic'),
            expectedCompletionId: agentTurnCompletionIdentity(ready)!,
            expectedInputByte: fence.acceptedInputBytes!
          })
          expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
        } finally {
          await h.close()
        }
      })
    })
  }
})
