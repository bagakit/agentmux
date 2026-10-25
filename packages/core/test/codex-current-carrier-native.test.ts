import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { spawn } from 'node:child_process'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import { quotedEnvelope } from './helpers/channel-quote-fixture.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import * as runner from '../src/process-runner.js'

// Source tests launch the actual endpoint worker, not a compiled stale copy.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
function fact(kind: string, value: unknown) {
  if (process.env.AGENTMUX_CURRENT_CODEX_FACTS) appendFileSync(process.env.AGENTMUX_CURRENT_CODEX_FACTS, JSON.stringify({ kind, value }) + '\n')
}
const cleanups: Array<() => Promise<void>> = []
async function cleanupOwned() {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private carrier cleanup failed')
}
afterEach(async () => { try { await cleanupOwned() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

function fullQuote(repetitions = 2500): string {
  const channelQuote = structuredClone(quotedEnvelope.channelQuote!)
  channelQuote.records[0]!.content = '完整原文 <&> "换行"\n'.repeat(repetitions)
  const wire = renderAgentMuxMessageEnvelope({ ...quotedEnvelope, channelQuote, body: 'PRIVATE_QUEUE_CURRENT_REQUEST 原请求' })
  expect(parseAgentMuxMessagePrefix(wire)?.declaredChannelQuote?.quote).toEqual(channelQuote)
  expect(Buffer.byteLength(wire)).toBeGreaterThan(65_536)
  return wire
}

async function fixture(mode: 'managed' | 'queue') {
  const native = true, queue = mode === 'queue'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-current-codex-')))
  cleanups.push(() => rm(root, { recursive: true }))
  for (const name of ['runtime', 'state', 'native-home', 'bin']) await mkdir(join(root, name), { mode: 0o700 })
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !/^AGENTMUX_(TEST_CODEX_BINARY|CURRENT_CODEX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const inputs: string[] = [], endpoint = native ? await offlineEndpoint(join(root, 'native-home'), inputs, root) : undefined
  if (endpoint) cleanups.push(async () => { for (const socket of endpoint.sockets) socket.destroy(); await new Promise<void>(resolve => endpoint.endpoint.close(() => resolve())) })
  const provider = new AgentProviderRegistry().get(native ? 'codex' : 'pi')
  const entry = join(root, 'managed-entry.mjs')
  const nativeCommand = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
  if (native) {
    expect((await runner.runProcess(nativeCommand, ['--version'], { timeoutMs: 5000 })).stdout.trim()).toBe('codex-cli 0.165.0')
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
        if (process.env.AGENTMUX_CURRENT_CODEX_LOADED) appendFileSync(process.env.AGENTMUX_CURRENT_CODEX_LOADED,
          JSON.stringify({ path, consumer: 'native-worker', originalSHA256: sha(original), sha256: sha(contents), fixturePathMapping: original !== contents }) + '\n')
        return { contents, loader: 'ts' }
      }) } }]
    })
  }
  // Override only how the test opens its native process. Discovery, identity,
  // readiness, durable queue protocol and receipts remain the original Provider.
  const providers = [{ ...provider, planManagedHooks: () => null,
    ...(queue ? { buildLaunch: (context: Parameters<typeof provider.buildLaunch>[0]) => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-current-queue-worker.mjs', import.meta.url)), root, 'original', join(root, 'native-home')], env: { ...context.env } }) } : {}),
    prepareManagedLaunch: async (...args: Parameters<NonNullable<typeof provider.prepareManagedLaunch>>) => {
      const prepared = await provider.prepareManagedLaunch!(...args)
      if (queue) { expect(prepared.nativeActor).toBeUndefined(); return prepared }
      expect(prepared.nativeActor).toBeDefined()
      return { ...prepared, plan: { ...prepared.plan, args: [entry, ...prepared.plan.args.slice(1)] } }
    } }]
  const activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
    socketPath: join(root, 'runtime', 'ctxmux.sock'), stateDir: join(root, 'state', 'ctxmux'),
    env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, timeoutMs: 5000,
    childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
  cleanups.push(async () => {
    for (const run of await activation.client.list()) { if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id)); await activation.client.remove(run.id) }
    fact('cleanup', { remainingRuns: (await activation.client.list()).length })
    await activation.shutdown(); await activation.dispose()
  })
  const storePath = join(root, 'sessions.json'), store = () => new AgentMuxFileAgentSessionStore(storePath)
  let client = new AgentMuxClient({ store: store(), ...(providers ? { providers } : {}) }); await client.connect()
  cleanups.push(() => client.dispose())
  const output = join(root, 'input.jsonl')
  const session = await client.createAgent({ agentSessionId: 'original', createOperationId: 'original-create', providerId: provider.id, executorId: provider.id,
    workspacePath: root, injectAgentMuxGuide: false, commandOverride: native ? nativeCommand : process.execPath,
    ...(!queue ? { prompt: 'PRIVATE_QUEUE_INITIAL_ORIGINAL' } : {}),
    args: queue ? [] : ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue'],
    env: { AGENTMUX_TEST_INPUT_WITNESS: output, ...(native ? { CODEX_HOME: join(root, 'native-home'), HOME: root } : {}) } })
  const initial = await vi.waitFor(async () => {
    await client.refreshAgentSession('original', session.run)
    const status = await client.statusAgent('original')
    if (native) { expect(status.session.nativeHandle?.sessionId).toEqual(expect.any(String)); if (queue) expect((await store().readMetadata('original'))?.nativeActor).toBeUndefined(); else expect((await store().readMetadata('original'))?.nativeActor).toBeDefined(); expect(status.session.semanticStatus?.state).toBe('done') }
    else expect(status.run.pid).toBe(JSON.parse(await readFile(output + '.ready', 'utf8')).pid)
    return status
  }, { timeout: 20_000, interval: 100 })
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'original', expectedRun: session.run, submissionId: id })
  const input = (id: string, prompt: string) => ({ agentSessionId: 'original', expectedRun: session.run, operationId: id, prompt,
    execution: 'immediate' as const, authorHuman: true, admissionIntent: native ? { kind: 'session-conversation' as const } : { kind: 'manual-actor' as const } })
  let releaseResponse: (() => void) | undefined
  let responseGate: Promise<void> | undefined
  const originalHandler = endpoint!.endpoint.listeners('request')[0]!
  endpoint!.endpoint.removeAllListeners('request')
  endpoint!.endpoint.on('request', async (request, response) => { if (request.method !== 'GET') await responseGate; Reflect.apply(originalHandler, endpoint!.endpoint, [request, response]) })
  cleanups.push(async () => { releaseResponse?.() })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] }); await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  return { root, inputs, session, initial, key, input, store, rpc, server,
    finishOriginalRun: async () => { await activation.client.stop(await activation.client.prepareStop(session.run.runId)) },
    hold: () => { responseGate = new Promise<void>(resolve => { releaseResponse = resolve }); return () => { releaseResponse?.(); responseGate = undefined } }, get client() { return client },
    receipt: async (id: string, status: string, explicit = false) => vi.waitFor(async () => {
      const value = await client.inspectAgentInput({ key: key(id) })
      const detail = JSON.stringify({ status: value?.status, control: value?.control })
      expect(value?.status, detail).toBe(status)
      if (explicit) expect(value?.control.waiting?.wake, detail).toBe('explicit-rejoin')
      return value!
    }, { timeout: 15_000, interval: 100 }),
    terminalInputs: async () => (await readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text as string),
    reopen: async () => { await client.dispose(); client = new AgentMuxClient({ store: store(), ...(providers ? { providers } : {}) }); await client.connect();
      const current = await client.statusAgent('original'); expect(current.run).toMatchObject({ runId: initial.run.runId, pid: initial.run.pid, state: 'running' });
      expect(current.session.nativeHandle).toEqual(initial.session.nativeHandle) },
    close: cleanupOwned }
}


async function adopted(h: Awaited<ReturnType<typeof fixture>>, key: ReturnType<Awaited<ReturnType<typeof fixture>>['key']>, correlation: string) {
  return await vi.waitFor(async () => {
    const page = await h.client.sessionHistoryPage('original', { limit: 100 })
    const item = page.items.find(item => item.conversation?.nativeInput?.clientCorrelation === correlation)
    expect(item?.conversation?.adoptedInput?.key).toEqual(key)
    expect(item?.turnId).toEqual(expect.any(String))
    return item!
  }, { timeout: 20_000, interval: 100 })
}
function publicInput(h: Awaited<ReturnType<typeof fixture>>, id: string, prompt: string) {
  const { authorHuman: _human, ...input } = h.input(id, prompt)
  return input
}

it.runIf(process.platform === 'darwin')('current native actor starts and steers the exact original turn, retains adoption and refuses a foreign source', async () => {
  const h = await fixture('managed')
  try {
    const wire = fullQuote(), release = h.hold()
    const intake = await h.rpc.call('agent.input.submit', publicInput(h, 'current-start', wire))
    expect(intake.key).toEqual(h.key('current-start'))
    const start = await h.receipt('current-start', 'admitted'), original = await h.client.inspectAgentPromptSubmission(start.key)
    expect(original?.admission).toMatchObject({ transport: 'native', acknowledged: true, intent: { prompt: wire },
      native: { outcome: 'admitted', plan: { protocolId: 'codex-app-server-v2-0.163', operation: 'start-or-steer' } } })
    const turn = original!.admission!.native!.turnId!, source = { providerId: 'codex', nativeSessionId: h.initial.session.nativeHandle!.sessionId }
    const steer = { ...publicInput(h, 'current-steer', 'PRIVATE_QUEUE_EXACT_STEER'), admissionIntent: { kind: 'native-conversation' as const, source, expectedTurnId: turn } }
    await h.rpc.call('agent.input.submit', steer)
    const receipt = await h.receipt('current-steer', 'admitted'), record = await h.client.inspectAgentPromptSubmission(receipt.key)
    expect(record?.admission?.native).toMatchObject({ outcome: 'admitted', turnId: turn, plan: { operation: 'steer', expectedTurnId: turn } })
    release()
    await vi.waitFor(() => expect(h.inputs.filter(text => text === wire)).toHaveLength(1), { timeout: 20_000, interval: 100 })
    const native = await adopted(h, h.key('current-start'), original!.admission!.native!.plan.clientCorrelation!)
    expect(native.turnId).toBe(turn)
    await adopted(h, h.key('current-steer'), record!.admission!.native!.plan.clientCorrelation!)
    await h.reopen()
    expect(await h.client.inspectAgentPromptSubmission(h.key('current-steer'))).toEqual(record)
    const cli = process.env.AGENTMUX_CURRENT_CODEX_CLI
    if (!cli) throw new Error('Qualified current carrier requires its compiled CLI')
    const cliResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--endpoint', 'unix://' + h.server.path, 'agent', 'input', 'inspect', '--input', '-'],
        { env: objectCliEnvironment(h.root), stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ key: h.key('current-steer') }))
    })
    expect(cliResult.code, cliResult.stderr).toBe(0)
    expect(JSON.parse(cliResult.stdout).result.record).toMatchObject({ admission: { submissionId: 'current-steer', transport: 'native', native: { turnId: turn, outcome: 'admitted' } } })
    const foreign = { ...publicInput(h, 'foreign-source', wire), admissionIntent: { kind: 'native-conversation' as const,
      source: { ...source, nativeSessionId: '00000000-0000-4000-8000-000000000099' } } }
    await h.rpc.call('agent.input.submit', foreign)
    expect(await h.receipt('foreign-source', 'waiting')).toMatchObject({ control: { state: 'enabled' } })
    expect(await h.client.inspectAgentPromptSubmission(h.key('foreign-source'))).toBeNull()
    expect((await h.client.sessionHistoryPage('original', { limit: 100 })).items.some(item =>
      item.conversation?.adoptedInput?.key.kind === 'prompt' && item.conversation.adoptedInput.key.submissionId === 'foreign-source')).toBe(false)
    expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
    expect((await h.client.statusAgent('original')).run.acceptedInputBytes).toBe(h.initial.run.acceptedInputBytes)
    fact('managed', { run: h.initial.run, source, start: original!.admission!.native, steer: record!.admission!.native, adopted: native.conversation?.adoptedInput, wireSHA256: createHash('sha256').update(wire).digest('hex'), wireBytes: Buffer.byteLength(wire), modelOccurrences: h.inputs.filter(text => text === wire).length, foreignAdmission: null, cli: JSON.parse(cliResult.stdout).result.record?.admission?.native })
  } finally { await h.close() }
})

it.runIf(process.platform === 'darwin')('current native resume keeps the exact saved thread and effective original policy', async () => {
  const h = await fixture('managed')
  try {
    await h.finishOriginalRun()
    await vi.waitFor(async () => expect((await h.client.statusAgent('original')).run.state).not.toBe('running'))
    const resumed = await h.client.resumeAgent({ agentSessionId: 'original', operationId: 'current-resume', prompt: 'PRIVATE_QUEUE_RESUMED_ORIGINAL',
      args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue'],
      env: { CODEX_HOME: join(h.root, 'native-home'), HOME: h.root } })
    expect(resumed.run.runId).not.toBe(h.session.run.runId)
    await vi.waitFor(async () => {
      await h.client.refreshAgentSession('original', resumed.run)
      const status = await h.client.statusAgent('original')
      expect(status.session.nativeHandle?.sessionId).toBe(h.initial.session.nativeHandle!.sessionId)
      expect(status.session.semanticStatus?.state, JSON.stringify(status.session.terminalFrontend)).toBe('done')
      expect(status.session.terminalFrontend?.initialization?.native).toMatchObject({ state: 'confirmed', sessionId: h.initial.session.nativeHandle!.sessionId })
    }, { timeout: 20_000, interval: 100 })
    const saved = await h.store().readMetadata('original')
    const frozen = saved!.promptCompletionAdmission!.intent!
    expect(frozen.run).toEqual(resumed.run)
    expect(frozen.prompt).toContain('PRIVATE_QUEUE_RESUMED_ORIGINAL')
    expect(h.inputs.filter(text => text === frozen.prompt)).toHaveLength(1)
    expect(saved?.nativeActor?.protocolId).toBe('codex-app-server-v2-0.163')
    expect(saved?.nativeHandle).toEqual(h.initial.session.nativeHandle)
    fact('resume', { originalRun: h.initial.run, resumedRun: resumed.run, target: saved!.nativeHandle, native: saved!.promptCompletionAdmission!.native, wireSHA256: createHash('sha256').update(frozen.prompt).digest('hex'), modelOccurrences: h.inputs.filter(text => text === frozen.prompt).length })
  } finally { await h.close() }
})

it.runIf(process.platform === 'darwin')('current existing native queue admits the original public message once without another writer or immediate fallback', async () => {
  const h = await fixture('queue')
  try {
    const identity = JSON.parse(await readFile(join(h.root, 'original-identity.json'), 'utf8'))
    const caller = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.server.path }, credentials: { agentSessionId: 'original', capability: identity.capability } })
    cleanups.push(() => caller.dispose())
    await caller.call('agent.send', { target: { kind: 'self' }, operationId: 'current-queue-send', messageId: 'current-original-mid', text: 'PRIVATE_QUEUE_CURRENT_BODY' })
    const record = await vi.waitFor(async () => {
      const message = await h.client.readMessage({ messageId: 'current-original-mid' })
      expect(message?.notification?.state).toBe('submitted')
      const record = await h.client.inspectAgentPromptSubmission(message!.notification!.key!)
      expect(record?.admission).toMatchObject({ transport: 'native', acknowledged: true,
        native: { outcome: 'admitted', queuedSubmissionId: expect.any(String), plan: { protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle' } } })
      return record!
    }, { timeout: 20_000, interval: 100 })
    const native = await vi.waitFor(async () => {
      const item = (await h.client.sessionHistoryPage('original', { limit: 100 })).items.find(item =>
        item.conversation?.nativeInput?.clientCorrelation === record.admission!.native!.plan.clientCorrelation)
      expect(item?.conversation?.adoptedInput?.key).toEqual(record.admission!.inputKey)
      return item!
    }, { timeout: 20_000, interval: 100 })
    expect(native.turnId).toEqual(expect.any(String))
    const wire = record.admission!.intent!.prompt
    expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
    expect(wire).not.toContain('PRIVATE_QUEUE_CURRENT_BODY')
    await h.reopen()
    expect(await h.client.inspectAgentPromptSubmission(record.admission!.inputKey!)).toEqual(record)
    expect((await h.store().readMetadata('original'))?.nativeActor).toBeUndefined()
    const immediate = publicInput(h, 'unmanaged-immediate', 'PRIVATE_QUEUE_EXPLICIT_NATIVE')
    await h.rpc.call('agent.input.submit', immediate)
    expect(await h.receipt('unmanaged-immediate', 'waiting')).toMatchObject({ control: { state: 'enabled' } })
    expect(await h.client.inspectAgentPromptSubmission(h.key('unmanaged-immediate'))).toBeNull()
    expect((await h.client.statusAgent('original')).run.acceptedInputBytes).toBe(h.initial.run.acceptedInputBytes)
    expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
    fact('queue', { run: h.initial.run, target: h.initial.session.nativeHandle, inputKey: record.admission!.inputKey, native: record.admission!.native, adopted: native.conversation?.adoptedInput, wireSHA256: createHash('sha256').update(wire).digest('hex'), modelOccurrences: h.inputs.filter(text => text === wire).length, nativeActor: null, immediateAdmission: null })
  } finally { await h.close() }
})
