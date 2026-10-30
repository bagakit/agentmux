import { preparedFixtureRun as defineRun } from '../../core/test/helpers/prepared-fixture-run.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './fixtures/ingress.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { createHostedIngressCorePort } from '../src/core-ingress-port.js'
import { AgentMuxError } from '../../core/src/errors.js'
import { AgentMuxHostedRuntimeService } from '../../core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../core/src/hosted-client.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { parseAgentInputSubmissionReceipt } from '../../core/src/agent-input-receipt-codec.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function recoveryFixture(hosted = false) {
  const f = await ingressFixture(true); closes.push(f.close)
  const core = f.inner as any, provider = f.client.providers.get('claude'), starts: any[] = []
  f.client.providers.replace({ ...provider, prepareManagedLaunch: async (plan: any) => ({ plan }) })
  const recovered = () => ({ ...f.run('recovered-run'), program: starts[0]?.program ?? 'claude', args: starts[0]?.args ?? [], lifecycleOperationId: starts[0]?.operationKey ?? null })
  core.kernel.launchIdentity = ({ program, args }: any) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  core.kernel.status = vi.fn(async (runId: string) => runId === f.session.run.runId
    ? { ...f.run(runId), state: { type: 'exited', code: 0, signal: null } } : recovered())
  core.kernel.list = vi.fn(async () => starts.length ? [recovered()] : [])
  core.kernel.inspectCreation = vi.fn(async (operationId: string) => starts[0]?.operationKey === operationId ? recovered() : null)
  core.kernel.start = vi.fn(async (request: any) => {
    const saved = await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })
    expect(saved.items.some((entry: any) => entry.kind === 'item' && entry.item.receipt.admission?.admission?.transport === 'launch')).toBe(true)
    expect(saved.items.find((entry: any) => entry.kind === 'item' && entry.item.receipt.admission?.admission?.transport === 'launch')).toMatchObject({ kind: 'item', item: { receipt: { control: { state: 'dispatch-authorized' }, admission: { admission: { transport: 'launch', launch: { outcome: 'claimed' } } } } } })
    starts.push(request); return recovered()
  })
  core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'original-fixture-runtime', instanceId: 'fixture-instance', buildIdentity: 'fixture', protocolVersion: 1 })
  core.kernel.prepareStart = (input: any) => defineRun(input.program, { args: input.args, cwd: input.cwd, env: input.env,
    initialSize: { cols: input.cols ?? 80, rows: input.rows ?? 24 } })
  core.kernel.startPrepared = vi.fn(async (request: any, operationKey: string) => core.kernel.start({ program: request.program, args: request.args,
    cwd: request.cwd, env: request.env, operationKey }))
  core.kernel.inspectPreparedStart = vi.fn(async (request: any, operationKey: string) => {
    const run = await core.kernel.inspectCreation(operationKey)
    if (run && (request.program !== run.program || JSON.stringify(request.args) !== JSON.stringify(run.args))) throw new Error('Another prepared launch was observed')
    return run
  })
  core.probePreparedAgent = vi.fn(async () => ({ providerId: 'claude', executable: 'claude', installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (session: any) => session
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = (_session: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(core.screenEvidence, 'wait').mockResolvedValue(1)
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  let ingress = f.ingress
  const authorChecks = vi.fn(async (author, intent) => {
    const current = await f.ingress.authority({ operationId: intent.operationId })
    if (current.authority !== 'current' || !current.ingress || current.ingress.kind === 'action') throw new Error('Original external authority changed')
    expect(current.ingress.input?.author).toEqual(author)
    const owner = f.ingress as unknown as { context(record: typeof current.ingress): { externalAuthor: { assertCurrent(intent: unknown): void } } }
    owner.context(current.ingress).externalAuthor.assertCurrent(intent)
  })
  if (hosted) {
    const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, { assertCurrent: authorChecks })
    closes.push(() => service.dispose())
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'recovery-host.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
    await server.start(); closes.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
    const remote = await connectHostedAgentMux({ rpc }); closes.push(() => remote.dispose())
    ingress = new DurableIngressHost({ ...f.options, core: createHostedIngressCorePort(() => [{ hostId: 'local', client: remote }]) })
  }
  return { ...f, ingress, core, starts, authorChecks }
}

it.each([false, true])('saves external input before recovery and carries its exact wire once through the real ingress owner (Hosted=%s)', async hosted => {
  const f = await recoveryFixture(hosted), received = await f.receive()
  const result = await f.ingress.dispatch(received.ingress.ingressId)
  expect(result.inputReceipt, JSON.stringify(result)).toMatchObject({ status: 'launch-carried', key: { kind: 'message', expectedRun: f.session.run }, admission: { run: f.session.run, admission: { transport: 'launch', launch: { receipt: { run: { runId: 'recovered-run' } } } } } })
  expect(parseAgentInputSubmissionReceipt(result.inputReceipt)).toEqual(result.inputReceipt)
  const claim = result.inputReceipt!.admission!.admission!
  expect(f.starts).toHaveLength(1); expect(f.starts[0].args).toContain(claim.intent!.prompt)
  expect(claim.intent!.prompt).toContain('Original external body\nEvery line is retained.')
  expect(claim.intent!.message?.authorExternal?.externalMessageId).toBe('original-message')
  expect(claim.inputKey).toEqual(result.inputReceipt!.key)
  expect(f.core.kernel.input).not.toHaveBeenCalled()
  await f.ingress.dispatch(received.ingress.ingressId); await f.ingress.rejoin(received.ingress.ingressId)
  expect(f.core.kernel.start).toHaveBeenCalledTimes(1)
  expect(f.core.kernel.input).not.toHaveBeenCalled()
  if (hosted) expect(f.authorChecks.mock.calls.length).toBeGreaterThan(2)
})

it('the receiver reconciles a lost settlement reply on the original Start without another Start or PTY delivery', async () => {
  const f = await recoveryFixture(), received = await f.receive()
  const settle = f.store.settlePromptAdmission.bind(f.store)
  const writes = vi.spyOn(f.store, 'settlePromptAdmission').mockRejectedValue(new Error('Original receipt store unavailable'))
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.inputReceipt?.status).toBe('unknown'); expect(f.starts).toHaveLength(1)
  writes.mockImplementation(settle)
  const next = await f.ingress.rejoin(received.ingress.ingressId)
  expect(next.inputReceipt?.status).toBe('launch-carried')
  expect(next.inputReceipt?.key).toEqual(first.inputReceipt?.key)
  expect(f.core.kernel.start).toHaveBeenCalledTimes(1); expect(f.core.kernel.input).not.toHaveBeenCalled()
})

it('a confirmed whole-Start refusal retries only through the original input owner new generation and lifecycle operation', async () => {
  const f = await recoveryFixture(), received = await f.receive(), start = f.core.kernel.start.getMockImplementation()
  f.core.kernel.start.mockImplementationOnce(async (spec: any) => { throw new AgentMuxError('Original Start not applied', 'CTXMUX_START_REJECTED', undefined, undefined, undefined,
    { operationId: spec.operationKey, disposition: 'not_applied' }) })
  const first = await f.ingress.dispatch(received.ingress.ingressId).catch(() => f.ingress.inspect({ ingressId: received.ingress.ingressId }))
  expect(first.inputReceipt?.status).toBe('not-applied')
  f.core.kernel.start.mockImplementation(start)
  const next = await f.ingress.rejoin(received.ingress.ingressId)
  expect(next.inputReceipt?.status).toBe('launch-carried')
  expect(next.inputReceipt!.ref.waitGeneration).toBeGreaterThan(first.inputReceipt!.ref.waitGeneration)
  expect(next.inputReceipt?.key).toEqual(first.inputReceipt?.key)
  expect(f.core.kernel.start.mock.calls[1][0].operationKey).not.toBe(f.core.kernel.start.mock.calls[0][0].operationKey)
  expect(f.core.kernel.input).not.toHaveBeenCalled()
})


it('keeps a confirmed launch receipt when delivery bookkeeping fails and repairs the original record on rejoin', async () => {
  const f = await recoveryFixture(), received = await f.receive(), events: any[] = []
  const unsubscribe = f.client.onEvent(event => events.push(event)); closes.push(async () => unsubscribe())
  const record = f.core.messageQueue.recordDelivery.bind(f.core.messageQueue)
  const writes = vi.spyOn(f.core.messageQueue, 'recordDelivery').mockRejectedValue(new Error('Delivery bookkeeping unavailable'))
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.inputReceipt?.status).toBe('launch-carried')
  expect((await f.store.readMetadata(f.input.agentSessionId))?.continuity?.kind).toBe('resumed')
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AGENT_INPUT_RECORDING_UNCONFIRMED' })]))
  writes.mockImplementation(record)
  await f.client.rejoinAgentInputWaiting({ ref: first.inputReceipt!.ref })
  expect((await f.core.messageQueue.readByOperationId(first.inputReceipt!.originalControlOperationId)).delivery.state).toBe('delivered')
  expect(f.core.kernel.start).toHaveBeenCalledTimes(1); expect(f.core.kernel.input).not.toHaveBeenCalled()
})

it('reads the launch receipt through the real source CLI and socket RPC without reissuing input', async () => {
  const f = await recoveryFixture(), received = await f.receive(), result = await f.ingress.dispatch(received.ingress.ingressId)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: f.coreClients })
  await server.start(); closes.push(() => server.stop())
  const read = await runSourceObjectCli(['agent', 'input', 'inspect', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ key: result.inputReceipt!.key }))
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout)).toMatchObject({ ok: true, result: { input: { key: result.inputReceipt!.key, status: 'launch-carried' } } })
  expect(f.core.kernel.start).toHaveBeenCalledTimes(1); expect(f.core.kernel.input).not.toHaveBeenCalled()
})

it('keeps two messages waiting on one old Run under distinct recovery operations', async () => {
  const f = await recoveryFixture(), first = await f.receive(), second = await f.receive({ eventId: 'second-event', messageId: 'second-message', body: 'Second independent input' })
  let release!: () => void, entered!: () => void, secondEntered!: () => void
  const paused = new Promise<void>(resolve => { release = resolve }), entering = new Promise<void>(resolve => { entered = resolve })
  const secondEntering = new Promise<void>(resolve => { secondEntered = resolve })
  const start = f.core.kernel.start.getMockImplementation(), ensure = f.client.ensureAgentContinuity.bind(f.client)
  const ensureCalls: any[] = []
  vi.spyOn(f.client, 'ensureAgentContinuity').mockImplementation((...args) => {
    ensureCalls.push(args[0]); if (ensureCalls.length === 2) secondEntered()
    return ensure(...args)
  })
  f.core.kernel.start.mockImplementationOnce(async (request: any) => { entered(); await paused; return start(request) })
  const firstDispatch = f.ingress.dispatch(first.ingress.ingressId)
  await entering
  const secondDispatch = f.ingress.dispatch(second.ingress.ingressId).then(() => null, error => error)
  try {
    await secondEntering
    expect(ensureCalls[0].operationId).not.toBe(ensureCalls[1].operationId)
    expect(ensureCalls[0].messageInputRef.key).not.toEqual(ensureCalls[1].messageInputRef.key)
  } finally { release() }
  const settled = await firstDispatch, otherResult = await secondDispatch
  expect(otherResult?.code).not.toBe('AGENT_PROMPT_OPERATION_CONFLICT')
  expect(settled.inputReceipt?.status).toBe('launch-carried')
  const other = await f.ingress.inspect({ ingressId: second.ingress.ingressId })
  expect(other.inputReceipt!.key).not.toEqual(settled.inputReceipt!.key)
  expect(other.inputReceipt?.admission?.admission?.transport).not.toBe('launch')
  expect(f.core.kernel.start).toHaveBeenCalledTimes(1)
})
