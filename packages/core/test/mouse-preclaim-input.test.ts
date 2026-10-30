import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const user = { principal: { kind: 'user' as const, id: 'fixture-user' } }
const mouse = '\x1b[<0;12;34M'

/** Real Core/RPC and durable journal. Only Runtime IO and the held Store read are ports. */
async function fixture() {
  const h = await rpcOwnerFixture(['recipient'])
  const initial = h.client.agentSession('recipient')
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: initial.run, submissionId: 'original-mouse-input' }
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const request = { agentSessionId: key.agentSessionId, expectedRun: key.expectedRun,
    admissionIntent: { kind: 'manual-actor' as const }, operationId: key.submissionId, prompt: 'ORIGINAL_BODY', execution: 'immediate' as const }
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(done => { release = done }), reading = new Promise<void>(done => { entered = done })
  const read = h.store.readMetadata.bind(h.store)
  const coordinator = Reflect.get(h.client, 'promptSubmission')
  const submit = coordinator.submitInputPlan.bind(coordinator)
  let once = true
  coordinator.submitInputPlan = (...args: unknown[]) => {
    h.store.readMetadata = async id => {
      const value = await read(id)
      if (id === 'recipient' && once) { once = false; entered(); await held }
      return value
    }
    return submit(...args)
  }
  return { ...h, initial, key, rpc, request, reading, release,
    start: async () => { await rpc.call('agent.input.submit', request, user); await reading },
    raw: (data: string | Uint8Array = mouse) => h.client.writeAgent({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, data, source: 'user' }),
    receipt: () => h.client.inspectAgentInput({ key }),
    frames: () => vi.mocked(h.inner.kernel.input as (...args: any[]) => unknown).mock.calls.map(call => call[1].data),
    close: async () => { release(); await h.close() } }
}

it.each([mouse, '\x1b[<0;12;34m', '\x1b[<64;12;34M', '\x1b[M !!', mouse + mouse])(
  'continues the same unqualified manual input after an acknowledged complete mouse report %j', async report => {
    const h = await fixture()
    try {
      await h.start(); await h.raw(report)
      // The abandoned state read must not be needed to finish the original input.
      await expect.poll(async () => (await h.receipt())?.status,
        { message: 'A complete mouse report must not cancel an unclaimed manual input' }).toBe('terminal-confirmed')
      expect(h.rawInput).toHaveBeenCalledExactlyOnceWith(h.initial.run.runId, report)
      const plan = h.client.providers.get(h.initial.providerId).planPromptInput(h.request.prompt)
      expect(h.frames()).toEqual(plan.kind === 'single-phase' ? [plan.data] : [plan.payload, plan.submit])
      expect((await h.store.readPromptAdmission(h.key.agentSessionId, h.key.expectedRun, h.key.submissionId))?.admission)
        .toMatchObject({ submissionId: h.key.submissionId, acknowledged: true })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

it.each(['keyboard', 'mixed', 'truncated', 'invalid-coordinate', 'invalid-button', 'partial-ack', 'lost-ack', 'wrong-pid', 'foreign-gap'])(
  'keeps the original unclaimed input waiting after %s instead of treating it as a mouse ACK', async fault => {
    const h = await fixture()
    const raw = h.rawInput.getMockImplementation()!
    const channel = vi.mocked(h.inner.kernel.openInput as (...args: any[]) => Promise<any>).getMockImplementation()!
    if (fault === 'partial-ack') h.rawInput.mockImplementation(async (...args) => {
      const result = await raw(...args)
      return { appliedByteRange: { ...result.appliedByteRange, endByte: result.appliedByteRange.endByte - 1 } }
    })
    if (fault === 'lost-ack') h.rawInput.mockImplementation(async (...args) => { await raw(...args); throw new AgentMuxError('Original mouse ACK is unknown', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') })
    if (fault === 'wrong-pid') vi.mocked(h.inner.kernel.openInput as (...args: any[]) => Promise<any>).mockImplementation(async (...args) => {
      const value = await channel(...args); return { ...value, run: { ...value.run, pid: 1234 } }
    })
    if (fault === 'foreign-gap') h.rawInput.mockImplementation(async (...args) => { await raw(args[0], 'FOREIGN_INPUT'); return raw(...args) })
    const data = fault === 'keyboard' ? 'HUMAN_EDIT' : fault === 'mixed' ? mouse + 'EDIT' : fault === 'truncated' ? mouse.slice(0, -1)
      : fault === 'invalid-coordinate' ? '\x1b[<0;0;34M' : fault === 'invalid-button' ? '\x1b[<999;12;34M' : mouse
    try {
      await h.start(); await h.raw(data).catch(() => {})
      await expect.poll(async () => (await h.receipt())?.control.waiting?.failure?.code).toBeTruthy()
      expect(await h.receipt()).toMatchObject({ key: h.key, status: 'waiting' })
      expect(h.frames(), 'Unsafe or unconfirmed raw input must not authorize the original body').toEqual([])
      expect(await h.client.inspectAgentPromptSubmission(h.key)).toBeNull()
      expect(h.client.agentSession('recipient').run).toEqual(h.initial.run)
      // A failed observation cannot revoke the separate healthy terminal channel.
      h.rawInput.mockImplementation(raw)
      vi.mocked(h.inner.kernel.openInput as (...args: any[]) => Promise<any>).mockImplementation(channel)
      await h.raw('INDEPENDENT_EDIT')
      expect(h.rawInput.mock.calls.at(-1)?.[1]).toBe('INDEPENDENT_EDIT')
    } finally { await h.close() }
  })

it('exposes the same original receipt through the source CLI without another mouse or prompt write', async () => {
  const h = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  try {
    await server.start(); await h.start(); await h.raw()
    await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
    const frames = h.frames()
    const read = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'input', 'inspect', '--input', '-'],
      objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'recipient', AGENTMUX_AGENT_CAPABILITY: h.capability }), JSON.stringify({ key: h.key }))
    expect(read.code, read.stderr + read.stdout).toBe(0)
    expect(JSON.parse(read.stdout).result.input).toMatchObject({ key: h.key, status: 'terminal-confirmed' })
    expect(h.frames()).toEqual(frames); expect(h.rawInput).toHaveBeenCalledTimes(1)
  } finally { await server.stop(); await h.close() }
})

it.each(['open-input', 'capacity', 'second-capacity'])(
  'requires this report ACK when raw %s fails before dispatch', async fault => {
    const h = await fixture()
    let first: Promise<unknown> | undefined
    try {
      await h.start()
      if (fault === 'open-input') vi.mocked(h.inner.kernel.openInput as (...args: any[]) => Promise<any>)
        .mockRejectedValueOnce(new AgentMuxError('The original input channel read failed', 'CTXMUX_INPUT_UNCONFIRMED'))
      else {
        if (fault === 'second-capacity') h.waitWritable.mockResolvedValueOnce(undefined)
        h.waitWritable.mockRejectedValueOnce(new AgentMuxError('The original capacity read failed', 'CTXMUX_INPUT_UNCONFIRMED'))
      }
      if (fault === 'second-capacity') first = h.raw().catch(() => {})
      await h.raw().catch(() => {}); await first
      await expect.poll(async () => (await h.receipt())?.control.waiting?.failure?.code).toBeTruthy()
      expect(await h.receipt()).toMatchObject({ key: h.key, status: 'waiting' })
      expect(h.frames(), 'A pre-dispatch failure must not borrow an earlier mouse ACK').toEqual([])
      expect(await h.client.inspectAgentPromptSubmission(h.key)).toBeNull()
    } finally { await h.close() }
  })

it('cancels the original caller while its yielded mouse ACK remains unknown, without retiring that raw operation', async () => {
  const h = await fixture(), controller = new AbortController()
  const raw = h.rawInput.getMockImplementation()!
  let releaseAck!: () => void, rawEntered!: () => void
  const heldAck = new Promise<void>(done => { releaseAck = done }), writing = new Promise<void>(done => { rawEntered = done })
  h.rawInput.mockImplementation(async (...args) => { const result = await raw(...args); rawEntered(); await heldAck; return result })
  let sent: Promise<unknown> | undefined, report: Promise<unknown> | undefined
  const reason = new AgentMuxError('The original caller cancelled its observation', 'ORIGINAL_CALL_CANCELLED')
  try {
    sent = h.client.submitAgentPrompt({ agentSessionId: h.key.agentSessionId, expectedRun: h.key.expectedRun,
      afterSubmissionId: null, operationId: h.key.submissionId, prompt: h.request.prompt, execution: 'immediate', signal: controller.signal })
      .then(() => null, error => error)
    await h.reading
    report = h.raw(); await writing
    controller.abort(reason)
    // The original input observer must finish while Runtime still owns the raw ACK.
    await expect.poll(async () => Promise.race([sent!, Promise.resolve('pending')])).not.toBe('pending')
    expect(h.frames()).toEqual([])
    releaseAck(); await report; await Promise.resolve()
    expect(h.frames()).toEqual([])
    expect(await h.client.inspectAgentPromptSubmission(h.key)).toBeNull()
  } finally { releaseAck(); await Promise.allSettled([sent, report]); await h.close() }
})

it.each(['known', 'unknown'])(
  'does not re-enter a dispatch gate after its %s original receipt and a mouse report', async outcome => {
    const h = await fixture(), queue = Reflect.get(h.client, 'messageQueue')
    const authorize = queue.authorizeInputDispatch.bind(queue)
    let releaseGate!: () => void, entered!: () => void
    const held = new Promise<void>(done => { releaseGate = done }), gate = new Promise<void>(done => { entered = done })
    let mousePreempted!: () => void
    const mousePreemption = new Promise<void>(done => { mousePreempted = done })
    const cancel = Reflect.get(h.client, 'cancelPromptRenderObservation').bind(h.client)
    vi.spyOn(h.client as any, 'cancelPromptRenderObservation').mockImplementation((...args: unknown[]) => {
      const result = cancel(...args); mousePreempted(); return result
    })
    const calls = vi.spyOn(queue, 'authorizeInputDispatch').mockImplementation(async (...args: unknown[]) => {
      const result = await authorize(...args); entered(); await held
      if (outcome === 'unknown') throw new AgentMuxError('Original dispatch gate ACK was lost', 'ORIGINAL_DISPATCH_UNCONFIRMED')
      return result
    })
    let report: Promise<unknown> | undefined
    try {
      await h.start(); h.release(); await gate
      report = h.raw(); await mousePreemption
      releaseGate(); await report
      if (outcome === 'known') {
        await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
        expect(h.frames()).toHaveLength(2)
      } else {
        await expect.poll(async () => (await h.receipt())?.status).toBe('unknown')
        expect(await h.receipt()).toMatchObject({ key: h.key, control: { state: 'dispatch-authorized' } })
        expect(h.frames()).toEqual([])
      }
      expect(calls, 'A won or unknown gate must not be re-entered by a mouse yield').toHaveBeenCalledTimes(1)
    } finally { releaseGate(); await report; await h.close() }
  })

it.each([false, true])('preserves a different original native predecessor (acknowledged=%s) through manual mouse yielding', async acknowledged => {
  const h = await fixture()
  try {
    const previous = (await h.store.readMetadata('recipient'))!
    const plan = { kind: 'native-rpc' as const, protocolId: 'controlled-native-contract', operation: 'start-or-steer' as const,
      sourceId: 'original-native-source', actorId: 'original-native-actor', threadId: 'original-native-thread' }
    const originalKey = { ...h.key, submissionId: 'original-native-input' }
    await h.store.compareAndSwapMetadata(previous, { ...previous, updatedAt: previous.updatedAt + 1,
      promptCompletionAdmission: { transport: 'native', submissionId: originalKey.submissionId, operationId: originalKey.submissionId,
        inputKey: originalKey, acknowledged, native: { plan, outcome: acknowledged ? 'admitted' : 'unknown', ...(acknowledged ? { turnId: 'original-native-turn' } : {}) },
        intent: { run: previous.run, ownerInstanceId: 'fixture-runtime', prompt: 'ORIGINAL_NATIVE_BODY', plan,
          execution: 'immediate', message: { userContent: 'ORIGINAL_NATIVE_BODY' } } } })
    await Reflect.get(h.client, 'registry').load('local')
    const original = await h.store.readPromptAdmission(originalKey.agentSessionId, originalKey.expectedRun, originalKey.submissionId)
    await h.start(); await h.raw()
    await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
    expect(h.frames().every(data => !data.includes('ORIGINAL_NATIVE_BODY'))).toBe(true)
    expect(await h.store.readPromptAdmission(originalKey.agentSessionId, originalKey.expectedRun, originalKey.submissionId)).toEqual(original)
    expect(h.rawInput).toHaveBeenCalledTimes(1)
  } finally { await h.close() }
})

it.each(['manual', 'qualified-prefix'])(
  'keeps a complete mouse report received before the first %s status observation', async kind => {
    const h = await fixture(), screen = new AgentTerminalScreen(80, 24)
    let releaseStatus!: () => void, statusEntered!: () => void
    const held = new Promise<void>(done => { releaseStatus = done }), reading = new Promise<void>(done => { statusEntered = done })
    const status = vi.mocked(h.inner.kernel.status as (id: string) => Promise<any>).getMockImplementation()!
    let once = true, sent: Promise<unknown> | undefined
    vi.mocked(h.inner.kernel.status as (id: string) => Promise<any>).mockImplementation(async id => {
      if (once) { once = false; statusEntered(); await held }
      return status(id)
    })
    if (kind === 'qualified-prefix') {
      const provider = h.client.providers.get('codex')
      h.client.providers.replace({ ...provider, catalog: { ...provider.catalog, capabilities: { ...provider.catalog.capabilities,
        promptExecution: { immediate: 'interrupt-before-input' } } },
        readPromptExecutionEvidence: async () => ({ sourceId: 'controlled-native-source', id: 'controlled-idle', state: 'idle' }),
        preparePromptExecutionTransport: async () => ({ nativeSourceId: 'controlled-native-source', verifyCurrentTransport: async () => true }),
        verifyPromptExecutionTransport: async () => true,
        terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
        inspectPromptExecution: () => 'idle',
        planPromptInput: prompt => ({ kind: 'render-then-submit', payload: prompt, renderedText: prompt, submit: '\r',
          prepare: { interrupt: '\x1b', endEvent: 'controlled-turn-end' } }) })
      Reflect.get(h.client, 'screenEvidence').wait = async (_session: unknown, _boundary: unknown, _after: unknown, predicate: (screen: AgentTerminalScreen) => boolean) => {
        expect(predicate(screen)).toBe(true); return screen.throughByte
      }
      Reflect.get(h.client, 'screenEvidence').generation = () => 0
      const input = vi.mocked(h.inner.kernel.input as (id: string, value: any) => Promise<any>).getMockImplementation()!
      h.inner.kernel.input = vi.fn(async (id, value: any) => {
        const result = await input(String(id), value)
        if (value.data === h.request.prompt) {
          const bytes = Buffer.from('\x1b[?2026h\x1b[2J\x1b[10;1H> ' + h.request.prompt + '\x1b[10;' + (3 + h.request.prompt.length) + 'H\x1b[?2026l')
          await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
        }
        return result
      })
      h.inner.kernel.status = vi.fn(async id => ({ ...await status(String(id)), pid: 1234 }))
      const qualifiedStatus = h.inner.kernel.status as (id: string) => Promise<any>
      h.inner.kernel.status = vi.fn(async id => { if (once) { once = false; statusEntered(); await held }; return qualifiedStatus(String(id)) })
      const open = vi.mocked(h.inner.kernel.openInput as (id: string) => Promise<any>).getMockImplementation()!
      h.inner.kernel.openInput = vi.fn(async id => { const channel = await open(String(id)); return { ...channel, run: { ...channel.run, pid: 1234 } } })
    }
    try {
      h.release()
      if (kind === 'manual') await h.rpc.call('agent.input.submit', h.request, user)
      else sent = h.client.submitAgentPrompt({ agentSessionId: h.key.agentSessionId, expectedRun: h.key.expectedRun,
        afterSubmissionId: null, operationId: h.key.submissionId, prompt: h.request.prompt, execution: 'immediate' })
      await reading; await h.raw()
      releaseStatus()
      if (sent) await sent
      else await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
      expect(h.frames()).toHaveLength(2)
      expect(h.rawInput).toHaveBeenCalledTimes(1)
    } finally { releaseStatus(); await sent; screen.dispose(); await h.close() }
  })

it.each([false, true])('keeps preemption and ACK tracking on one authorized observer cohort (failure=%s)', async failure => {
  const h = await fixture()
  let releaseAuthor!: () => void, authorEntered!: () => void
  const held = new Promise<void>(done => { releaseAuthor = done }), author = new Promise<void>(done => { authorEntered = done })
  let first = true, report: Promise<unknown> | undefined
  try {
    report = h.client.writeAgent({ agentSessionId: h.key.agentSessionId, expectedRun: h.key.expectedRun, data: mouse, source: 'user' },
      { assertCurrent: async () => { if (first) { first = false; authorEntered(); await held } } }).catch(error => error)
    await author
    await h.rpc.call('agent.input.submit', h.request, user)
    // The prompt registers its observer while its predecessor's author is pending.
    await expect.poll(() => Reflect.get(h.client, 'agentInputLanes').get('recipient')?.renderObservations.size).toBeGreaterThan(0)
    if (failure) h.waitWritable.mockRejectedValueOnce(new AgentMuxError('The original raw channel was not confirmed', 'CTXMUX_INPUT_UNCONFIRMED'))
    h.release(); releaseAuthor(); await report
    if (failure) {
      await expect.poll(async () => (await h.receipt())?.control.waiting?.failure?.code).toBeTruthy()
      expect(h.frames()).toEqual([])
    } else {
      await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
      expect(h.frames()).toHaveLength(2)
    }
  } finally { releaseAuthor(); await report; await h.close() }
})

it('uses the first actual channel snapshot for current-terminal input without claiming a global no-edit interval', async () => {
  const h = await fixture()
  let entered!: () => void, release!: () => void
  const held = new Promise<void>(done => { release = done }), reading = new Promise<void>(done => { entered = done })
  const status = vi.mocked(h.inner.kernel.status as (id: string) => Promise<any>).getMockImplementation()!
  const open = vi.mocked(h.inner.kernel.openInput as (id: string) => Promise<any>).getMockImplementation()!
  const raw = h.rawInput.getMockImplementation()!
  let first = true, report: Promise<unknown> | undefined, snapshot: number | null = null
  h.inner.kernel.status = vi.fn(async id => { if (first) { first = false; entered(); await held }; return status(String(id)) })
  h.inner.kernel.openInput = vi.fn(async id => {
    // Another writer's bytes precede the first observable channel snapshot.
    await raw(String(id), 'EXTERNAL_DRAFT')
    const channel = await open(String(id)); snapshot = channel.run.acceptedInputBytes; return channel
  })
  try {
    h.release(); await h.rpc.call('agent.input.submit', h.request, user); await reading
    report = h.raw(); await report; release()
    await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
    expect(h.frames()).toHaveLength(2)
    expect(snapshot).toBe(Buffer.byteLength('EXTERNAL_DRAFT'))
    expect(h.rawInput).toHaveBeenCalledExactlyOnceWith(h.initial.run.runId, mouse)
  } finally { release(); await report; await h.close() }
})

it('keeps an explicit original predecessor condition after mouse yielding', async () => {
  const h = await fixture()
  const { admissionIntent: _directed, ...request } = h.request
  const condition = { expectedRun: h.initial.run, afterSubmissionId: 'original-predecessor' }
  let sent: Promise<unknown> | undefined
  try {
    sent = h.rpc.call('agent.input.submit', { ...request, ...condition }, user).then(() => null, error => error)
    await h.reading; await h.raw()
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED' })
    expect(h.frames()).toEqual([])
    expect(condition.afterSubmissionId).toBe('original-predecessor')
    expect(await h.client.inspectAgentPromptSubmission(h.key)).toBeNull()
  } finally { await sent; await h.close() }
})

it('uses an exact native ACK range when the first Run cursor was unavailable', async () => {
  const h = await fixture()
  const status = vi.mocked(h.inner.kernel.status as (id: string) => Promise<any>).getMockImplementation()!
  const open = vi.mocked(h.inner.kernel.openInput as (id: string) => Promise<any>).getMockImplementation()!
  h.inner.kernel.status = vi.fn(async id => {
    const run = await status(String(id)); return h.rawInput.mock.calls.length ? run : { ...run, acceptedInputBytes: null }
  })
  h.inner.kernel.openInput = vi.fn(async id => { const channel = await open(String(id)); return { ...channel, run: { ...channel.run, acceptedInputBytes: null } } })
  try {
    await h.start(); await h.raw()
    await expect.poll(async () => (await h.receipt())?.status).toBe('terminal-confirmed')
    expect(h.frames()).toHaveLength(2)
    expect(h.rawInput).toHaveBeenCalledTimes(1)
  } finally { await h.close() }
})
