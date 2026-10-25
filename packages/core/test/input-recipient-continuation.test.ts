import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentMuxStoredAgentSession, AgentNativeSessionHandle } from '../src/types.js'
import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'
import { quote } from './helpers/channel-quote-fixture.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import * as runner from '../src/process-runner.js'
import * as capabilities from '../src/agent-capability.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { ConnectionHost } from '../../connectors/src/connection-host.js'
import { RoomBindingHost } from '../../connectors/src/room-binding.js'
import { DurableIngressHost } from '../../connectors/src/durable-ingress.js'
import { createConnectionExternalInputAuthority } from '../../../apps/host/src/external-input-authority.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

// Source tests launch the actual endpoint worker, not a compiled stale copy.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanups: Array<() => Promise<void>> = []
const facts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_TEST_RECIPIENT_FACTS) await writeFile(process.env.AGENTMUX_TEST_RECIPIENT_FACTS,
  JSON.stringify({ schema: 'agentmux.recipient-continuation-consumer.v1', facts }, null, 2) + '\n') })
async function cleanupOwned() {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private carrier cleanup failed')
}
afterEach(async () => { try { await cleanupOwned() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

async function nativeFixture() {
  let capability = ''
  const issue = capabilities.issueAgentCapability
  const issued = vi.spyOn(capabilities, 'issueAgentCapability').mockImplementation(() => { capability = issue(); return capability })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-recipient-')))
  cleanups.push(() => rm(root, { recursive: true }))
  for (const name of ['runtime', 'state', 'native-home', 'bin']) await mkdir(join(root, name), { mode: 0o700 })
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !/^AGENTMUX_(TEST_|RECIPIENT_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const inputs: string[] = [], endpoint = await offlineEndpoint(join(root, 'native-home'), inputs, root)
  if (endpoint) cleanups.push(async () => { for (const socket of endpoint.sockets) socket.destroy(); await new Promise<void>(resolve => endpoint.endpoint.close(() => resolve())) })
  const provider = new AgentProviderRegistry().get('codex')
  const entry = join(root, 'managed-entry.mjs')
  const nativeCommand = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
  {
    expect(['codex-cli 0.163.0', 'codex-cli 0.165.0']).toContain((await runner.runProcess(nativeCommand, ['--version'], { timeoutMs: 5000 })).stdout.trim())
    const helper = join(root, 'native-process-proof')
    expect(await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', helper], { timeoutMs: 10_000 }))
      .toMatchObject({ exitCode: 0, stderr: '' })
    const run = runner.runProcess
    vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) =>
      run(command.endsWith('/native-socket-peer-darwin') ? helper : command, args, options))
    await build({ entryPoints: [fileURLToPath(new URL('../src/providers/codex-managed-run.ts', import.meta.url))], outfile: entry,
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      plugins: [{ name: 'actual-native-process-helper-path', setup(b) { b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8'), contents = path.endsWith('/agent-native-process.ts')
          ? original.replaceAll("fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))", JSON.stringify(helper)) : original
        const sha = (text: string) => createHash('sha256').update(text).digest('hex')
        if (process.env.AGENTMUX_TEST_RECIPIENT_LOADED) appendFileSync(process.env.AGENTMUX_TEST_RECIPIENT_LOADED,
          JSON.stringify({ path, consumer: 'native-worker', originalSHA256: sha(original), sha256: sha(contents), fixturePathMapping: original !== contents }) + '\n')
        return { contents, loader: 'ts' }
      }) } }]
    })
  }
  // Override only how the test opens its native process. Discovery, identity,
  // readiness, durable queue protocol and receipts remain the original Provider.
  const providers = [{ ...provider, planManagedHooks: () => null,
    prepareManagedLaunch: async (...args: Parameters<NonNullable<typeof provider.prepareManagedLaunch>>) => {
      const prepared = await provider.prepareManagedLaunch!(...args)
      if (!prepared.nativeActor) return prepared
      return { ...prepared, plan: { ...prepared.plan, args: [entry, ...prepared.plan.args.slice(1)] } }
    } }]
  const activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
    socketPath: join(root, 'runtime', 'ctxmux.sock'), stateDir: join(root, 'state', 'ctxmux'),
    env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, timeoutMs: 5000,
    childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
  cleanups.push(async () => {
    for (const run of await activation.client.list()) { if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id)); await activation.client.remove(run.id) }
    await activation.shutdown(); await activation.dispose()
  })
  const storePath = join(root, 'sessions.json'), store = () => new AgentMuxFileAgentSessionStore(storePath)
  let client = new AgentMuxClient({ store: store(), providers }); await client.connect()
  cleanups.push(() => client.dispose())
  const session = await client.createAgent({ agentSessionId: 'original', createOperationId: 'original-create', providerId: provider.id, executorId: provider.id,
    workspacePath: root, injectAgentMuxGuide: false, commandOverride: nativeCommand, prompt: 'PRIVATE_QUEUE_INITIAL_ORIGINAL', args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue'],
    env: { CODEX_HOME: join(root, 'native-home'), HOME: root } })
  const initial = await vi.waitFor(async () => {
    await client.refreshAgentSession('original', session.run)
    const status = await client.statusAgent('original')
    { expect(status.session.nativeHandle?.sessionId).toEqual(expect.any(String)); expect(status.session.semanticStatus?.state).toBe('done') }
    return status
  }, { timeout: 20_000, interval: 100 })
  issued.mockRestore()
  return { root, inputs, session, initial, store, get capability() { return capability }, storePath, get client() { return client },
    resume: async (operationId: string) => {
      const before = await client.readAgentSession('original')
      if (!before) throw Error('Original Session missing before resume')
      await activation.client.stop(await activation.client.prepareStop(before.run.runId))
      await vi.waitFor(async () => expect((await client.statusAgent('original')).run.state).not.toBe('running'))
      const issuing = vi.spyOn(capabilities, 'issueAgentCapability').mockImplementation(() => { capability = issue(); return capability })
      try {
        const resumed = await client.resumeAgent({ agentSessionId: 'original', operationId, prompt: 'PRIVATE_QUEUE_RESUMED_ORIGINAL',
          args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue'], commandOverride: nativeCommand,
          env: { CODEX_HOME: join(root, 'native-home'), HOME: root } })
        return await vi.waitFor(async () => {
          await client.refreshAgentSession('original', resumed.run)
          const status = await client.statusAgent('original')
          expect(status.session.nativeHandle?.sessionId).toBe(initial.session.nativeHandle!.sessionId)
          expect(status.session.semanticStatus?.state).toBe('done')
          expect(status.session.continuity).toMatchObject({ kind: 'resumed', previousRun: before.run, newRun: resumed.run })
          return status.session
        }, { timeout: 20_000, interval: 100 })
      } finally { issuing.mockRestore() }
    },
    reopen: async () => { const before = await client.statusAgent('original'); await client.dispose(); client = new AgentMuxClient({ store: store(), providers }); await client.connect();
      const current = await client.statusAgent('original'); expect(current.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' });
      expect(current.session.nativeHandle).toEqual(before.session.nativeHandle) },
    close: cleanupOwned }
}


async function channel(h: { root: string; client: AgentMuxClient; storePath: string }, id: string, manual = false) {
  const config = { connectionId: 'original-connection', adapterId: 'sample', application: { domain: 'chat.example', appId: 'original-app' }, label: 'Team', enabled: true, credentialRef: 'original-credential' }
  const connections = new ConnectionHost({ databasePath: join(h.root, 'connections.sqlite'), secrets: { resolve: async () => 'private-credential' } })
  cleanups.push(() => { connections.close(); return Promise.resolve() })
  await connections.configure({ operationId: 'configure', expectedRevision: null, connection: config })
  const bindings = new RoomBindingHost({ connections, spatial: new AgentMuxSpatialStateStore(join(h.root, 'spatial.json')),
    session: ref => h.client.readAgentSession(ref.agentSessionId), checkpoint: ref => h.client.conversationCheckpoint(ref) })
  connections.bindings = bindings
  const page = await h.client.conversationCheckpoint({ hostId: 'local', agentSessionId: id })
  const source = page.checkpoint.frontier.cuts.find(c => c.kind === 'native')!
  if (source.kind !== 'native') throw Error('Original native source absent')
  const context = { actor: { kind: 'user' as const, id: 'original-user' } }
  expect(await bindings.bind({ operationId: 'bind', bindingId: 'original-binding', connectionId: config.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: id, externalConversationId: 'original-room',
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, expectedSource: source.checkpoint.source,
    ...(manual ? {} : { inputTarget: { kind: 'native-conversation' as const, source: source.checkpoint.source } }) }, context)).toMatchObject({ state: 'applied' })
  const actor = { application: config.application, idType: 'open_id', userId: 'original-external-user' }
  const grant = { bindingId: 'original-binding', expectedBindingRevision: 1, grantId: 'original-grant', actor, capabilities: ['input' as const] }
  expect(await bindings.grant({ ...grant, operationId: 'grant', expectedRevision: null, state: 'active' }, context)).toMatchObject({ state: 'applied' })
  const ingress = new DurableIngressHost({ connections, bindings, core: hostId => hostId === 'local' ? h.client : undefined,
    authenticators: [{ adapterId: 'sample', verify: async (_config, raw, proof) => { if (proof !== 'private-transport-proof') throw Error('Invalid proof'); return JSON.parse(raw) },
      readHistory: async (_config, request) => ({ ...structuredClone(quote), application: config.application, externalConversationId: request.externalConversationId,
        range: request.range, records: [{ messageId: 'previous', contentType: 'text', content: '完整群原文 <&>\n'.repeat(3000), author: { kind: 'unknown' } }] }) }] })
  connections.ingress = ingress; cleanups.push(async () => ingress.close())
  const external = createConnectionExternalInputAuthority({ ingress: async () => ingress, executionHostId: 'local' })
  let hosted: AgentMuxHostedRuntimeService, server: AgentMuxControlServer
  const path = join(h.root, 'recipient.sock')
  const start = async () => {
    hosted = new AgentMuxHostedRuntimeService(h.client, h.storePath, () => hostedTestOwner(h.client), undefined, external)
    server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: h.client }], hostedRuntime: () => hosted })
    await server.start()
  }
  await start(); cleanups.push(async () => { await server.stop(); await hosted.dispose() })
  return { ingress, connections, bindings, external, path,
    revoke: () => bindings.grant({ ...grant, operationId: 'revoke', expectedRevision: 1, state: 'revoked' }, context),
    receive: async (messageId: string) => {
      const received = await ingress.receive({ connectionId: config.connectionId, transportProof: 'private-transport-proof', raw: JSON.stringify({ eventId: messageId,
        messageId, externalConversationId: 'original-room', actor, body: 'Original request ' + messageId, selection: 'mention', conversationKind: 'group' }) }, () => {})
      await ingress.dispatch(received.ingress.ingressId)
      const inspection = await ingress.inspect({ ingressId: received.ingress.ingressId })
      const record = inspection.ingress
      if (!record || record.kind === 'action' || !record.input || !('messageId' in record.input)) throw Error('Original message was not claimed: ' + JSON.stringify(inspection))
      const key = { kind: 'message' as const, agentSessionId: id, expectedRun: record.input.expectedRun, messageId: record.input.messageId }
      return { record, claim: record.input, key, receipt: () => h.client.inspectAgentInput({ key }) }
    }, reopen: async (reopen: () => Promise<void>) => { await server.stop(); await hosted.dispose(); await reopen(); await start() } }
}

it.runIf(process.platform === 'darwin')('original ingress crosses Hosted and recipient compiled CLI into one actual native input, retaining the frozen author and quote after reopen', async () => {
  const h = await nativeFixture(), c = await channel(h, 'original')
  const provider = h.client.providers.get('codex')
  const pause = vi.spyOn(provider as Required<Pick<AgentProvider, 'prepareNativeInput'>>, 'prepareNativeInput').mockRejectedValue(new AgentMuxError('Private native preparation unavailable', 'PRIVATE_NATIVE_UNAVAILABLE'))
  const original = await c.receive('native-original')
  const waiting = await vi.waitFor(async () => { const value = await original.receipt(); expect(value).toMatchObject({ status: 'waiting', control: { state: 'enabled', waiting: { wake: 'explicit-rejoin' } } }); return value! })
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()), saved = (await queue.inspectInput({ key: original.key }))!
  expect(saved.intent.source.kind).toBe('message')
  if (saved.intent.source.kind !== 'message') throw Error('Expected retained message')
  const wire = saved.intent.source.promptWire!
  expect(Buffer.byteLength(wire)).toBeGreaterThan(65_536)
  expect(parseAgentMuxMessagePrefix(wire)?.declaredChannelQuote?.quote).toEqual(original.claim.channelQuote)
  expect(await h.client.inspectAgentPromptSubmission(original.key)).toBeNull(); pause.mockRestore()
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'original', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const args = ['--endpoint', 'unix://' + c.path, 'agent', 'input']
  const inspect = await runCompiledObjectCli([...args, 'inspect', '--input', '-'], env, JSON.stringify({ key: original.key }))
  expect(inspect.code, inspect.stderr).toBe(0); expect(JSON.parse(inspect.stdout).result.input.ref).toEqual(waiting.ref)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: c.path } }); cleanups.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); cleanups.push(() => hosted.dispose())
  expect((await hosted.inspectAgentInput({ key: original.key }))?.ref).toEqual(waiting.ref)
  const results = await Promise.all([1, 2].map(() => runCompiledObjectCli([...args, 'rejoin', '--input', '-'], env, JSON.stringify({ ref: waiting.ref }))))
  for (const result of results) expect(result.code, result.stderr).toBe(0)
  await vi.waitFor(async () => expect(await original.receipt()).toMatchObject({ status: 'admitted', ref: waiting.ref }), { timeout: 20_000 })
  await vi.waitFor(() => expect(h.inputs.filter(text => text === wire)).toHaveLength(1), { timeout: 20_000 })
  const admission = await h.client.inspectAgentPromptSubmission(original.key)
  expect(admission?.admission).toMatchObject({ transport: 'native', acknowledged: true, intent: { prompt: wire }, inputDispatch: { ref: waiting.ref } })
  expect((await queue.inspectInput({ key: original.key }))?.intent).toEqual(saved.intent)
  await hosted.dispose(); await rpc.dispose()
  await c.reopen(h.reopen)
  expect(await h.client.inspectAgentPromptSubmission(original.key)).toEqual(admission)
  const again = await runCompiledObjectCli([...args, 'rejoin', '--input', '-'], env, JSON.stringify({ ref: waiting.ref }))
  expect(again.code, again.stderr).toBe(0); expect(JSON.parse(again.stdout).result.status).toBe('admitted')
  expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
  const unavailable = vi.spyOn(h.client.providers.get('codex') as Required<Pick<AgentProvider, 'prepareNativeInput'>>, 'prepareNativeInput').mockRejectedValue(new AgentMuxError('Private preparation unavailable', 'PRIVATE_NATIVE_UNAVAILABLE'))
  const revoked = await c.receive('native-revoked')
  const held = await vi.waitFor(async () => { const value = await revoked.receipt(); expect(value?.control.waiting?.wake).toBe('explicit-rejoin'); return value! })
  unavailable.mockRestore(); expect(await c.revoke()).toMatchObject({ state: 'applied' })
  const refused = await runCompiledObjectCli([...args, 'rejoin', '--input', '-'], env, JSON.stringify({ ref: held.ref }))
  expect(refused.code).toBe(1); expect(JSON.parse(refused.stderr).error.code).toBe('EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
  expect(await h.client.inspectAgentPromptSubmission(revoked.key)).toBeNull()
  await h.client.submitAgentPrompt({ agentSessionId: 'original', expectedRun: h.session.run, operationId: 'independent-short', prompt: 'PRIVATE_QUEUE_INDEPENDENT_LOCAL', authorHuman: true,
    execution: 'immediate', admissionIntent: { kind: 'session-conversation' } })
  await vi.waitFor(() => expect(h.inputs.filter(text => text === 'PRIVATE_QUEUE_INDEPENDENT_LOCAL')).toHaveLength(1), { timeout: 20_000 })
  facts.push({ case: 'actual-native-recipient', executableVersion: (await runner.runProcess(process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex', ['--version'])).stdout.trim(),
    key: original.key, ref: waiting.ref, author: original.claim.author, wireBytes: Buffer.byteLength(wire), wireSHA256: createHash('sha256').update(wire).digest('hex'),
    nativeExactInputs: h.inputs.filter(text => text === wire).length, receipt: { transport: admission?.admission?.transport, acknowledged: admission?.admission?.acknowledged, inputDispatch: admission?.admission?.inputDispatch }, reopenedReceiptEqual: true, revokedInput: { ref: held.ref, admission: null }, independentLocalInputs: 1 })
})

it.runIf(process.platform === 'darwin')('semantic continuation delivers the original external manual request once after real Core resume through recipient compiled CLI and preserves both keys after reopen', async () => {
  const h = await nativeFixture(), c = await channel(h, 'original', true)
  const pause = vi.spyOn(h.client.providers.get('codex') as AgentProvider, 'planPromptInput')
    .mockImplementation(() => { throw new AgentMuxError('Private input planning unavailable', 'PRIVATE_INPUT_UNAVAILABLE') })
  const original = await c.receive('semantic-original')
  const waiting = await vi.waitFor(async () => { const value = await original.receipt(); expect(value?.control.waiting?.wake).toBe('explicit-rejoin'); return value! })
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()), saved = (await queue.inspectInput({ key: original.key }))!
  expect(saved.intent.admissionIntent.kind).toBe('manual-actor')
  if (saved.intent.source.kind !== 'message') throw Error('Expected original external input')
  const wire = saved.intent.source.promptWire!, oldCapability = h.capability
  expect(Buffer.byteLength(wire)).toBeGreaterThan(65_536)
  expect(parseAgentMuxMessagePrefix(wire)?.declaredChannelQuote?.quote).toEqual(original.claim.channelQuote)
  pause.mockRestore()
  const resumed = await h.resume('semantic-recipient-resume')
  expect(resumed.run).not.toEqual(original.key.expectedRun)
  expect(h.inputs.filter(text => text === wire)).toHaveLength(0)
  expect(await original.receipt()).toMatchObject({ ref: waiting.ref, control: { state: 'enabled' }, admission: null })
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'original', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const args = ['--endpoint', 'unix://' + c.path, 'agent', 'input']
  const stale = await runCompiledObjectCli([...args, 'rejoin', '--input', '-'], { ...env, AGENTMUX_AGENT_CAPABILITY: oldCapability }, JSON.stringify({ ref: waiting.ref }))
  expect(stale.code).toBe(1); expect(JSON.parse(stale.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
  const results = await Promise.all([1, 2].map(() => runCompiledObjectCli([...args, 'rejoin', '--input', '-'], env, JSON.stringify({ ref: waiting.ref }))))
  for (const result of results) expect(result.code, result.stderr).toBe(0)
  const actualKey = { ...original.key, expectedRun: resumed.run }
  const delivered = await vi.waitFor(async () => { const value = await original.receipt(); expect(value).toMatchObject({ status: 'terminal-confirmed', key: original.key, ref: waiting.ref,
    control: { state: 'dispatch-authorized', deliveryKey: actualKey }, admission: { run: resumed.run } }); return value! }, { timeout: 20_000 })
  await vi.waitFor(() => expect(h.inputs.filter(text => text === wire)).toHaveLength(1), { timeout: 20_000 })
  expect(delivered.admission?.admission?.transport ?? 'terminal').toBe('terminal')
  expect(delivered.admission?.admission).toMatchObject({ intent: { prompt: wire }, inputDispatch: { ref: waiting.ref, deliveryKey: actualKey } })
  expect((await queue.inspectInput({ key: original.key }))?.intent).toEqual(saved.intent)
  expect(await queue.resolveInputOwnerKey(actualKey)).toEqual(original.key)
  await c.reopen(h.reopen)
  for (const key of [original.key, actualKey]) {
    const read = await runCompiledObjectCli([...args, 'inspect', '--input', '-'], env, JSON.stringify({ key }))
    expect(read.code, read.stderr).toBe(0)
    expect(JSON.parse(read.stdout).result.input).toMatchObject({ key: original.key, ref: waiting.ref, control: delivered.control, admission: delivered.admission })
  }
  const again = await runCompiledObjectCli([...args, 'rejoin', '--input', '-'], env, JSON.stringify({ ref: waiting.ref }))
  expect(again.code, again.stderr).toBe(0)
  expect(JSON.parse(again.stdout).result.admission).toEqual(delivered.admission)
  expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
  facts.push({ case: 'actual-semantic-recipient', executableVersion: (await runner.runProcess(process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex', ['--version'])).stdout.trim(),
    key: original.key, actualKey, ref: waiting.ref, continuity: resumed.continuity, author: original.claim.author,
    savedEnvironment: saved.intent.environment, wireBytes: Buffer.byteLength(wire), wireSHA256: createHash('sha256').update(wire).digest('hex'),
    nativeExactInputs: h.inputs.filter(text => text === wire).length, receipt: delivered, reopenedBothKeysEqual: true, staleCapabilityRejected: true })
})

function barrier() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  return { entered, release, pause: async () => { enter(); await waiting } }
}
async function controlled(nativeHandle?: AgentNativeSessionHandle, captureNative = true) {
  const h = await rpcOwnerFixture(['recipient', 'outsider', 'author'], undefined, () => ({ providerId: 'claude', executorId: 'claude' }))
  cleanups.push(h.close)
  if (nativeHandle) {
    const recipient = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(recipient, { ...recipient, nativeHandle }); await h.inner.registry.load('local')
  }
  vi.spyOn(h.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  const externalAuthor = { kind: 'external' as const, connectionId: 'connection', actor: { application: { domain: 'chat.example', appId: 'app' }, idType: 'open_id', userId: 'external-user' },
    externalConversationId: 'room', externalMessageId: 'external-original', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 }
  let allowed = true
  const author = { identity: externalAuthor, assertCurrent: vi.fn(async () => { if (!allowed) throw new AgentMuxError('Original grant unavailable', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED') }) }
  const context = { externalAuthor: author }
  const save = async (id: string, kind: 'external' | 'human' | 'agent' | 'prompt' = 'external', admissionKind: 'manual-actor' | 'session-conversation' = 'manual-actor') => {
    const expectedRun = { runId: 'run-recipient' }
    if (kind === 'prompt') return (await queue.savePromptInput({ key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun, submissionId: id }, admissionIntent: { kind: 'manual-actor', expectedRun },
      execution: 'immediate', environment: { providerId: 'claude', executorId: 'claude' }, source: { kind: 'prompt', prompt: 'Original local input', authorHuman: true } }))!
    const sender = kind === 'external' ? externalAuthor : kind === 'human' ? { kind: 'human' as const, principal: 'local-cli' as const } : { kind: 'agent-session' as const, agentSessionId: 'author' }
    await queue.append({ messageId: id, operationId: id + '-operation', createdAt: 1, sender, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: kind === 'agent' ? 'author' : null, senderRunId: kind === 'agent' ? 'run-author' : null, recipientSessionId: 'recipient', recipientRunId: expectedRun.runId,
      threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'Original ' + id, admissionIntent: { kind: admissionKind, expectedRun }, execution: 'immediate' },
      { inputEnvironment: { providerId: 'claude', executorId: 'claude', ...(captureNative && nativeHandle ? { nativeHandle } : {}) } })
    return (await queue.inspectInput({ key: { kind: 'message', agentSessionId: 'recipient', expectedRun, messageId: id } }))!
  }
  const inspect = (entry: Awaited<ReturnType<typeof save>>) => h.client.inspectAgentInput({ key: entry.intent.key })
  return { ...h, queue, context, save, inspect, caller: { agentSessionId: 'recipient', capability: h.capability },
    revoke: () => { allowed = false }, allow: () => { allowed = true } }
}

it('recipient eligibility preserves existing prompt, human, A2A, capability, Run, grant and uncertain-gate boundaries while independent input works', async () => {
  const h = await controlled(), saved = await h.save('restricted'), ref = saved.control.ref
  await expect(h.client.rejoinAgentInputWaiting({ ref, caller: { ...h.caller, agentSessionId: 'outsider' } }, h.context)).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  await expect(h.client.rejoinAgentInputWaiting({ ref, caller: { ...h.caller, capability: 'wrong' } }, h.context)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(h.client.rejoinAgentInputWaiting({ ref: { ...ref, waitGeneration: ref.waitGeneration + 1 }, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'AGENT_INPUT_WAIT_GENERATION_STALE' })
  h.revoke()
  await expect(h.client.rejoinAgentInputWaiting({ ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  h.allow()
  for (const kind of ['prompt', 'human', 'agent'] as const) {
    const original = await h.save(kind, kind)
    await expect(h.client.rejoinAgentInputWaiting({ ref: original.control.ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  }
  const metadata = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(metadata, { ...metadata, run: { runId: 'new-run' } })
  await expect(h.client.rejoinAgentInputWaiting({ ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await h.store.compareAndSwapMetadata((await h.store.readMetadata('recipient'))!, metadata)
  const unknown = await h.save('unknown-gate')
  expect(await h.queue.authorizeInputDispatch(unknown.control.ref)).not.toBeNull()
  expect(await h.client.rejoinAgentInputWaiting({ ref: unknown.control.ref, caller: h.caller }, h.context)).toMatchObject({ status: 'unknown', ref: unknown.control.ref })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: ref.key.expectedRun, operationId: 'independent', prompt: 'Independent local input', authorHuman: true, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })
  await vi.waitFor(() => expect(h.inner.kernel.input).toHaveBeenCalledOnce())
  expect(await h.client.inspectAgentPromptSubmission(ref.key)).toBeNull()
})

it('concurrent author Stop wins before the original recipient journal continuation without reopening it', async () => {
  const h = await controlled(), saved = await h.save('stop-race'), barrierAtJournal = barrier()
  const original = DurableAgentMuxMessageQueue.prototype.reenableInputWaiting
  vi.spyOn(DurableAgentMuxMessageQueue.prototype, 'reenableInputWaiting').mockImplementationOnce(async function(this: DurableAgentMuxMessageQueue, ref, mode) { await barrierAtJournal.pause(); return original.call(this, ref, mode) })
  const joining = h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context).then(value => ({ value }), error => ({ error }))
  await barrierAtJournal.entered
  expect(await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'author-stop' })).toMatchObject({ outcome: 'stopped-before-dispatch' })
  barrierAtJournal.release()
  expect(await joining).toMatchObject({ error: { code: 'AGENT_INPUT_WAIT_STOPPED' } })
  expect(await h.inspect(saved)).toMatchObject({ status: 'stopped', ref: saved.control.ref }); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('a late recipient cannot adopt the author next generation between its initial read and observer admission', async () => {
  const h = await controlled(), saved = await h.save('generation-race'), point = barrier()
  const inner = h.client as unknown as { acceptInputWaiting(...args: unknown[]): Promise<unknown> }, original = inner.acceptInputWaiting.bind(h.client)
  vi.spyOn(inner, 'acceptInputWaiting').mockImplementationOnce(async (...args) => { await point.pause(); return original(...args) })
  const joining = h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)
  await point.entered
  await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'author-stop' })
  const next = await h.queue.reenableInputWaiting(saved.control.ref)
  expect(next.waitGeneration).toBe(saved.control.ref.waitGeneration + 1)
  point.release(); await joining
  // Wait for the actual owner scheduler, not a sleep that can miss a late write.
  await (h.client as unknown as { scheduleInputWaiting(id: string): Promise<void> }).scheduleInputWaiting('recipient')
  expect(await h.inspect(saved)).toMatchObject({ status: 'waiting', ref: next, control: { state: 'enabled' } })
  expect(await h.client.inspectAgentPromptSubmission(saved.intent.key)).toBeNull(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('a late old recipient observer preserves the newer author observer across the awaited original-claim read', async () => {
  const h = await controlled(), saved = await h.save('observer-race'), oldRead = barrier(), newAuthority = barrier()
  const inner = h.client as unknown as { acceptInputWaiting(...args: unknown[]): Promise<unknown>; scheduleInputWaiting(id: string): Promise<void> }
  const accept = inner.acceptInputWaiting.bind(h.client), inspect = h.client.inspectAgentPromptSubmission.bind(h.client)
  vi.spyOn(inner, 'acceptInputWaiting').mockImplementationOnce(async (...args) => {
    vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockImplementationOnce(async key => { await oldRead.pause(); return inspect(key) })
    return accept(...args)
  })
  const joining = h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)
  await oldRead.entered
  await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'author-stop' })
  let count = 0
  const newer = await h.client.rejoinAgentInputWaiting({ ref: saved.control.ref }, { externalAuthor: { ...h.context.externalAuthor, assertCurrent: async () => { if (++count > 1) await newAuthority.pause() } } })
  await newAuthority.entered
  oldRead.release(); await joining
  expect(newer.ref.waitGeneration).toBe(saved.control.ref.waitGeneration + 1)
  newAuthority.release(); await inner.scheduleInputWaiting('recipient')
  await vi.waitFor(async () => expect(await h.inspect(saved)).toMatchObject({ status: 'terminal-confirmed', ref: newer.ref }))
  expect(h.inner.kernel.input).toHaveBeenCalledOnce()
})


/** Controlled counterexamples for target/generation races; the positive above
 * obtains its continuity from real Core resume and an actual Native process. */
async function semanticControlled(captureNative = true) {
  const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'original-native' }
  const h = await controlled(nativeHandle, captureNative)
  let serial = 0
  const resume = async (alter?: (next: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => {
    const previous = (await h.store.readMetadata('recipient'))!, run = { runId: 'resumed-recipient-' + ++serial }
    const operation: AgentMuxContinuityOperation = { operationId: 'semantic-resume-' + serial, agentSessionId: 'recipient', trigger: 'manual',
      policy: DEFAULT_AGENT_CONTINUITY_POLICY, previousRun: previous.run, newRun: run, nativeTarget: nativeHandle,
      admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'resumed', reason: 'run-ended', evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } }
    const next: AgentMuxStoredAgentSession = { ...previous, run, retiredRuns: [...previous.retiredRuns, previous.run],
      nativeBinding: { source: 'semantic-resume-target', run, observedAt: 1 }, continuity: operation,
      continuityOperations: { ...previous.continuityOperations, [operation.operationId]: operation } }
    delete next.promptCompletionAdmission; delete next.terminalPromptSubmission; delete next.terminalPromptDelivery
    await h.store.compareAndSwap(previous, alter ? alter(next) : next)
    await h.inner.registry.load('local')
    return next
  }
  const settled = () => (h.client as unknown as { scheduleInputWaiting(id: string): Promise<void> }).scheduleInputWaiting('recipient')
  return { ...h, resume, settled, nativeHandle }
}

it('semantic continuation refuses same native identity without an unambiguous Core recovery receipt and mismatched saved environments', async () => {
  const h = await semanticControlled(), saved = await h.save('target-boundary')
  const original = (await h.store.readMetadata('recipient'))!
  const variants: Array<[string, (next: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession]> = [
    ['no-receipt', next => { delete next.continuity; delete next.continuityOperations; return next }],
    ['ambiguous', next => ({ ...next, continuityOperations: { ...next.continuityOperations, conflicting: { ...next.continuity!, operationId: 'conflicting' } } })],
    ['provider', next => ({ ...next, providerId: 'codex', nativeHandle: { ...h.nativeHandle, providerId: 'codex' } })],
    ['executor', next => ({ ...next, executorId: 'codex' })],
    ['native', next => ({ ...next, nativeHandle: { ...h.nativeHandle, sessionId: 'another-native' } })],
    ['unknown-native', next => { delete next.nativeHandle; delete next.nativeBinding; return next }]
  ]
  for (const [name, alter] of variants) {
    await h.store.compareAndSwapMetadata((await h.store.readMetadata('recipient'))!, original)
    await h.resume(alter)
    await expect(h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context), name).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(await h.inspect(saved)).toMatchObject({ ref: saved.control.ref, control: { state: 'enabled' }, admission: null })
  }
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('semantic continuation retains nonmanual external and original author boundaries without creating cold or author-only replay permission', async () => {
  const h = await semanticControlled(), manual = await h.save('manual-author'), nonmanual = await h.save('not-manual', 'external', 'session-conversation')
  await h.resume()
  await expect(h.client.rejoinAgentInputWaiting({ ref: manual.control.ref, caller: { ...h.caller, agentSessionId: 'outsider' } }, h.context)).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  await expect(h.client.rejoinAgentInputWaiting({ ref: manual.control.ref, caller: { ...h.caller, capability: 'stale' } }, h.context)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(h.client.rejoinAgentInputWaiting({ ref: nonmanual.control.ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  h.revoke()
  await expect(h.client.rejoinAgentInputWaiting({ ref: manual.control.ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  h.allow()
  await h.client.rejoinAgentInputWaiting({ ref: manual.control.ref }, h.context)
  await h.settled()
  expect(await h.inspect(manual)).toMatchObject({ status: 'waiting', control: { state: 'enabled', waiting: { wake: 'explicit-rejoin' } }, admission: null })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const reopen = new AgentMuxClient({ store: h.store }); cleanups.push(() => reopen.dispose())
  await (Reflect.get(reopen, 'registry') as typeof h.inner.registry).load('local')
  await (reopen as unknown as { restoreInputWaiting(): Promise<void> }).restoreInputWaiting()
  expect((Reflect.get(reopen, 'inputWaitingContexts') as Map<string, unknown>).size).toBe(0)
  expect(await reopen.inspectAgentInput({ key: manual.intent.key })).toMatchObject({ ref: manual.control.ref, admission: null })
})

it('semantic continuation cannot adopt a new generation after its original observer admission awaits', async () => {
  const h = await semanticControlled(), saved = await h.save('semantic-generation'), point = barrier()
  await h.resume()
  const inner = h.client as unknown as { acceptInputWaiting(...args: unknown[]): Promise<unknown> }, original = inner.acceptInputWaiting.bind(h.client)
  vi.spyOn(inner, 'acceptInputWaiting').mockImplementationOnce(async (...args) => { await point.pause(); return original(...args) })
  const joining = h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)
  await point.entered
  expect(await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'stop-semantic-generation' })).toMatchObject({ outcome: 'stopped-before-dispatch' })
  const next = await h.queue.reenableInputWaiting(saved.control.ref)
  point.release(); await joining; await h.settled()
  expect(await h.inspect(saved)).toMatchObject({ ref: next, control: { state: 'enabled' }, admission: null })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['stop', 'run'] as const)('semantic continuation rechecks concurrent %s before its original dispatch gate', async change => {
  const h = await semanticControlled(), saved = await h.save('semantic-gate-' + change), point = barrier()
  await h.resume()
  const gate = DurableAgentMuxMessageQueue.prototype.authorizeInputDispatch
  vi.spyOn(DurableAgentMuxMessageQueue.prototype, 'authorizeInputDispatch').mockImplementationOnce(async function(this: DurableAgentMuxMessageQueue, ...args) {
    await point.pause(); return gate.apply(this, args)
  })
  await h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)
  await point.entered
  if (change === 'stop') expect(await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'stop-before-semantic-gate' })).toMatchObject({ outcome: 'stopped-before-dispatch' })
  else await h.resume()
  point.release(); await h.settled()
  const receipt = await h.inspect(saved)
  expect(receipt?.control.state).toBe(change === 'stop' ? 'stopped-before-dispatch' : 'enabled')
  expect(receipt?.admission).toBeNull(); expect(receipt?.control.deliveryKey).toBeUndefined()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('semantic continuation keeps the first actual delivery target after an uncertain gate and a further recovery', async () => {
  const h = await semanticControlled(), saved = await h.save('semantic-unknown'), resumed = await h.resume()
  const gate = DurableAgentMuxMessageQueue.prototype.authorizeInputDispatch
  vi.spyOn(DurableAgentMuxMessageQueue.prototype, 'authorizeInputDispatch').mockImplementationOnce(async function(this: DurableAgentMuxMessageQueue, ...args) {
    const link = await gate.apply(this, args); expect(link).not.toBeNull()
    throw Error('Original gate committed but its reply was lost')
  })
  await h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context); await h.settled()
  const before = await h.inspect(saved)
  expect(before).toMatchObject({ status: 'unknown', control: { state: 'dispatch-authorized', deliveryKey: { ...saved.intent.key, expectedRun: resumed.run } } })
  expect(before?.admission).toBeNull()
  await h.resume()
  const again = await h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)
  expect(again.control).toEqual(before?.control); expect(again.status).toBe('unknown')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const read = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  expect((await read.inspectInput({ key: saved.intent.key }))?.control).toEqual(before?.control)
  expect(await read.resolveInputOwnerKey(before!.control.deliveryKey!)).toEqual(saved.intent.key)
})

it('semantic continuation public result accepts only the exact original or frozen delivery selector', async () => {
  const h = await semanticControlled(), saved = await h.save('semantic-selector'), resumed = await h.resume()
  await h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context); await h.settled()
  const receipt = (await h.inspect(saved))!, actualKey = { ...saved.intent.key, expectedRun: resumed.run }
  expect(receipt.status).toBe('terminal-confirmed')
  await expect(h.client.inspectAgentInput({ key: actualKey }, { ...h.caller, agentSessionId: 'outsider' })).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  const result = { input: receipt, record: receipt.admission }
  for (const key of [saved.intent.key, actualKey]) expect(parseRpcNativeResult('agent.input.inspect', result, { key })).toEqual(result)
  for (const key of [{ ...actualKey, expectedRun: { runId: 'unrelated-run' } }, { ...actualKey, agentSessionId: 'outsider' },
    { ...actualKey, messageId: 'another-message' }, { kind: 'prompt', agentSessionId: actualKey.agentSessionId, expectedRun: actualKey.expectedRun, submissionId: 'semantic-selector' }]) {
    expect(() => parseRpcNativeResult('agent.input.inspect', result, { key })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  for (const change of [
    { control: { ...receipt.control, deliveryKey: { ...actualKey, expectedRun: { runId: 'invented-run' } } } },
    { control: { ...receipt.control, deliveryKey: { ...actualKey, messageId: 'another-message' } } },
    { key: { ...receipt.key, agentSessionId: 'outsider' } }
  ]) expect(() => parseRpcNativeResult('agent.input.inspect', { ...result, input: { ...receipt, ...change } }, { key: actualKey }))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseRpcNativeResult('agent.input.inspect', { ...result, record: null }, { key: actualKey }))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})


it('semantic continuation does not replace an unknown saved native environment with the current matching handle', async () => {
  const h = await semanticControlled(false), saved = await h.save('semantic-unknown-environment')
  expect(saved.intent.environment.nativeHandle).toBeUndefined()
  await h.resume()
  await expect(h.client.rejoinAgentInputWaiting({ ref: saved.control.ref, caller: h.caller }, h.context)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await h.inspect(saved)).toMatchObject({ ref: saved.control.ref, control: { state: 'enabled' }, admission: null })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})
