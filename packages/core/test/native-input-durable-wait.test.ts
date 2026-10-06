import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentInputSubmissionReceipt, AgentMuxAgentPromptInput } from '../src/index.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService as SourceHostedService } from '../src/hosted-runtime-service.js'
import type { AgentMuxHostedInvocation } from '../src/hosted-client-contract.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import { encodeHostedValue as SourceEncode, decodeHostedValue as SourceDecode } from '../src/hosted-value.js'

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const moduleUrl = entry ? (entry.startsWith('file:') ? entry : pathToFileURL(entry).href) : null
const compiled = moduleUrl ? await import(moduleUrl) : null
const DurableAgentMuxMessageQueue: typeof SourceQueue = compiled?.DurableAgentMuxMessageQueue ?? SourceQueue
const AgentMuxControlServer: typeof SourceServer = moduleUrl ? (await import(new URL('./public-rpc-server.js', moduleUrl).href)).AgentMuxControlServer : SourceServer
const connectAgentMuxRpc: typeof SourceConnect = compiled?.connectAgentMuxRpc ?? SourceConnect
const AgentMuxHostedRuntimeService: typeof SourceHostedService = moduleUrl ? (await import(new URL('./hosted-runtime-service.js', moduleUrl).href)).AgentMuxHostedRuntimeService : SourceHostedService
const encodeHostedValue: typeof SourceEncode = moduleUrl ? (await import(new URL('./hosted-value.js', moduleUrl).href)).encodeHostedValue : SourceEncode
const decodeHostedValue: typeof SourceDecode = moduleUrl ? (await import(new URL('./hosted-value.js', moduleUrl).href)).decodeHostedValue : SourceDecode
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const text = 'Original text 原文\n{"stop":true,"saved":true} remains opaque.'
const note = 'Original platform note, separate from the body.'
function barrier() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

/** Actual Core/journal/RPC owners; only the existing Runtime byte port is controlled. */
async function fixture() {
  const h = await rpcOwnerFixture(), original = (await h.store.readMetadata('recipient'))!
  let connected = false
  h.inner.connected = false; h.inner.kernel.isConnected = () => connected
  const originalStatus = h.inner.kernel.status as (id: string) => Promise<ReturnType<typeof h.run>>
  let readPause: { entered: ReturnType<typeof barrier>; proceed: ReturnType<typeof barrier> } | undefined
  h.inner.kernel.status = vi.fn(async (id: string) => {
    const pause = readPause; readPause = undefined
    if (pause) { pause.entered.release(); await pause.proceed.pending }
    return await originalStatus(id)
  })
  const input = (id: string): AgentMuxAgentPromptInput => ({ agentSessionId: 'recipient', expectedRun: original.run,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', operationId: id, prompt: text, agentMuxNote: note,
    authorHuman: true, sourceChannel: 'message-tool' })
  const restore = () => {
    connected = true; h.inner.connected = true
    Reflect.get(h.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  }
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: original.run, submissionId: id })
  const read = async (id: string) => (await h.client.inspectAgentInput({ key: key(id) }))!
  return { ...h, input, key, read, restore,
    pauseRuntimeRead: () => { const pause = { entered: barrier(), proceed: barrier() }; readPause = pause; return pause },
    queue: new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')) }
}

it('SDK firstsaves original body/note while Runtime is unavailable, and Stop retains that exact generation without writing', async () => {
  const h = await fixture()
  try {
    const saved = await h.client.submitAgentPrompt(h.input('offline-stop')) as AgentInputSubmissionReceipt
    expect(saved).toMatchObject({ persistence: 'confirmed', status: 'waiting', key: h.key('offline-stop') })
    const stopped = await h.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'original-stop' })
    expect(stopped).toMatchObject({ ref: saved.ref, outcome: 'stopped-before-dispatch' })
    h.restore()
    const pending = Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
    if (pending) await pending
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: {
      key: saved.key, source: { prompt: text, agentMuxNote: note, authorHuman: true, sourceChannel: 'message-tool' } } })
    expect(await h.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'original-stop' })).toEqual(stopped)
  } finally { await h.close() }
})

it('the note-only SDK contract retains empty original body and reports current-terminal bytes', async () => {
  const h = await fixture()
  try {
    h.restore()
    const receipt = await h.client.submitAgentPrompt({ ...h.input('note-only'), prompt: '' }) as AgentInputSubmissionReceipt
    expect(receipt).toMatchObject({ persistence: 'confirmed' })
    await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
    expect(await h.read('note-only')).toMatchObject({ status: 'terminal-confirmed', ref: receipt.ref })
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: {
      source: { prompt: '', agentMuxNote: note } } })
    const bytes = (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.map(call => (call[1] as { data: string }).data).join('')
    expect(bytes).toContain(note)
    expect(receipt).not.toHaveProperty('native')
  } finally { await h.close() }
})

it.each(['unix', 'http'] as const)('normal %s firstsave reply preserves the original Core input observer through real unary completion', async transport => {
  const h = await fixture(), paused = h.pauseRuntimeRead(), completed = barrier(), handled = barrier()
  const namespace = await lstat(h.root, { bigint: true }), cleanup: unknown[] = []
  let primary: unknown, completionError: boolean | undefined
  let originalChild: ChildProcess | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  const originalCall = service.call.bind(service)
  // Preserve the actual firstsave result; only fix the legal Runtime-observation/reply ordering.
  const call = vi.spyOn(service, 'call').mockImplementation(async (method, params, context) => {
    const result = await originalCall(method, params, context)
    if (method === 'runtime.invoke') await paused.entered.pending
    return result
  })
  const token = 'private-normal-reply-' + transport
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'normal-reply.sock'),
    coreClients: h.coreClients, hostedRuntime: () => service,
    ...(transport === 'http' ? { http: { host: '127.0.0.1', port: 0, token } } : {}) })
  try {
    h.restore(); await server.start()
    originalChild = Reflect.get(Reflect.get(server, 'publication'), 'current').child as ChildProcess
    if (transport === 'unix') {
      const accept = Reflect.get(server, 'accept') as (socket: Socket) => void
      Reflect.set(server, 'accept', function (this: InstanceType<typeof AgentMuxControlServer>, socket: Socket) {
        socket.once('close', hadError => { completionError = hadError; completed.release() })
        return accept.call(this, socket)
      })
    } else {
      const accept = Reflect.get(server, 'acceptHttp') as (request: IncomingMessage, response: ServerResponse) => Promise<void>
      Reflect.set(server, 'acceptHttp', async function (this: InstanceType<typeof AgentMuxControlServer>, request: IncomingMessage, response: ServerResponse) {
        response.once('finish', () => { completionError = !response.writableFinished; completed.release() })
        try { await accept.call(this, request, response) } finally { handled.release() }
      })
    }
    rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix'
      ? { transport, path: server.path }
      : { transport, url: 'http://127.0.0.1:' + server.httpAddress!.port + '/', token } })
    const id = 'normal-reply-' + transport
    const invocation: AgentMuxHostedInvocation = { method: 'submitAgentPrompt', args: [h.input(id)] }
    const response = await rpc.call('runtime.invoke', { consumerId: id, fence: hostedTestFence,
      invocation: encodeHostedValue(invocation) as AgentMuxHostedInvocation })
    const saved = decodeHostedValue(response.value) as AgentInputSubmissionReceipt
    expect(saved).toMatchObject({ status: 'waiting', persistence: 'confirmed', key: h.key(id), ref: { waitGeneration: 1 } })
    // This is the original Socket.close or ServerResponse.finish, before any explicit disposal.
    await completed.pending
    if (transport === 'http') await handled.pending
    const observer = Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending as Promise<void> | undefined
    expect(observer).toBeDefined()
    paused.proceed.release(); await observer
    const admitted = await h.read(id)
    expect(completionError).toBe(false)
    expect(admitted).toMatchObject({ status: 'terminal-confirmed', persistence: 'confirmed', ref: saved.ref })
    expect(admitted.admission?.admission?.inputDispatch?.ref).toEqual(saved.ref)
    expect(h.inner.kernel.input).toHaveBeenCalledTimes(2); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: {
      key: saved.key, source: { prompt: text, agentMuxNote: note, authorHuman: true, sourceChannel: 'message-tool' } } })
  } catch (error) { primary = error }
  finally {
    paused.proceed.release()
    const close = async (owner: string, release: () => unknown | Promise<unknown>) => {
      try { await release() } catch (cause) { cleanup.push(new Error('Original ' + owner + ' cleanup is unconfirmed', { cause })) }
    }
    if (rpc) await close('RpcClient', () => rpc!.dispose())
    await close('ControlServer', () => server.stop())
    await close('HostedRuntimeService', () => service.dispose())
    call.mockRestore()
    if (originalChild && ((originalChild.exitCode === null && originalChild.signalCode === null) || originalChild.connected)) {
      cleanup.push(new Error('The original listener ChildProcess exit or IPC release is unconfirmed'))
    }
    if (cleanup.length === 0) await close('fixture Core/store/namespace', async () => {
      const current = await lstat(h.root, { bigint: true })
      if (current.dev !== namespace.dev || current.ino !== namespace.ino) throw new Error('The original private namespace identity changed; it was retained')
      await h.close()
    })
    else await close('Core while private namespace is retained', () => h.client.dispose())
  }
  if (cleanup.length) throw new AggregateError([...(primary === undefined ? [] : [primary]), ...cleanup],
    'Original input observation and cleanup failures', { cause: primary })
  if (primary !== undefined) throw primary
}, 15_000)
