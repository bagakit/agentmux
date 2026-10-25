import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
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

async function fixture(native: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-prompt-carrier-')))
  cleanups.push(() => rm(root, { recursive: true }))
  for (const name of ['runtime', 'state', 'native-home', 'bin']) await mkdir(join(root, name), { mode: 0o700 })
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !/^AGENTMUX_(TEST_CODEX_BINARY|PROMPT_CARRIER_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const inputs: string[] = [], endpoint = native ? await offlineEndpoint(join(root, 'native-home'), inputs, root) : undefined
  if (endpoint) cleanups.push(async () => { for (const socket of endpoint.sockets) socket.destroy(); await new Promise<void>(resolve => endpoint.endpoint.close(() => resolve())) })
  const provider = new AgentProviderRegistry().get(native ? 'codex' : 'pi')
  const entry = join(root, 'managed-entry.mjs')
  const nativeCommand = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
  if (native) {
    expect((await runner.runProcess(nativeCommand, ['--version'], { timeoutMs: 5000 })).stdout.trim()).toBe('codex-cli 0.163.0')
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
        if (process.env.AGENTMUX_PROMPT_CARRIER_LOADED) appendFileSync(process.env.AGENTMUX_PROMPT_CARRIER_LOADED,
          JSON.stringify({ path, consumer: 'native-worker', originalSHA256: sha(original), sha256: sha(contents), fixturePathMapping: original !== contents }) + '\n')
        return { contents, loader: 'ts' }
      }) } }]
    })
  }
  // Override only how the test opens its native process. Discovery, identity,
  // readiness, durable queue protocol and receipts remain the original Provider.
  const providers = native ? [{ ...provider, planManagedHooks: () => null,
    prepareManagedLaunch: async (...args: Parameters<NonNullable<typeof provider.prepareManagedLaunch>>) => {
      const prepared = await provider.prepareManagedLaunch!(...args)
      expect(prepared.nativeActor).toBeDefined()
      return { ...prepared, plan: { ...prepared.plan, args: [entry, ...prepared.plan.args.slice(1)] } }
    } }] : undefined
  const activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
    socketPath: join(root, 'runtime', 'ctxmux.sock'), stateDir: join(root, 'state', 'ctxmux'),
    env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, timeoutMs: 5000,
    childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
  cleanups.push(async () => {
    for (const run of await activation.client.list()) { if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id)); await activation.client.remove(run.id) }
    await activation.shutdown(); await activation.dispose()
  })
  const storePath = join(root, 'sessions.json'), store = () => new AgentMuxFileAgentSessionStore(storePath)
  let client = new AgentMuxClient({ store: store(), ...(providers ? { providers } : {}) }); await client.connect()
  cleanups.push(() => client.dispose())
  const output = join(root, 'input.jsonl')
  const session = await client.createAgent({ agentSessionId: 'original', createOperationId: 'original-create', providerId: provider.id, executorId: provider.id,
    workspacePath: root, injectAgentMuxGuide: false, commandOverride: native ? nativeCommand : process.execPath,
    ...(native ? { prompt: 'PRIVATE_QUEUE_INITIAL_ORIGINAL' } : {}),
    args: native ? [] : [fileURLToPath(new URL('./fixtures/prompt-carrier-terminal.mjs', import.meta.url))],
    env: { AGENTMUX_TEST_INPUT_WITNESS: output, ...(native ? { CODEX_HOME: join(root, 'native-home'), HOME: root } : {}) } })
  const initial = await vi.waitFor(async () => {
    await client.refreshAgentSession('original', session.run)
    const status = await client.statusAgent('original')
    if (native) { expect(status.session.nativeHandle?.sessionId).toEqual(expect.any(String)); expect((await store().readMetadata('original'))?.nativeActor).toBeDefined(); expect(status.session.semanticStatus?.state).toBe('done') }
    else expect(status.run.pid).toBe(JSON.parse(await readFile(output + '.ready', 'utf8')).pid)
    return status
  }, { timeout: 20_000, interval: 100 })
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'original', expectedRun: session.run, submissionId: id })
  const input = (id: string, prompt: string) => ({ agentSessionId: 'original', expectedRun: session.run, operationId: id, prompt,
    execution: 'immediate' as const, authorHuman: true, admissionIntent: native ? { kind: 'session-conversation' as const } : { kind: 'manual-actor' as const } })
  return { root, inputs, session, initial, key, input, store, get client() { return client },
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

it.runIf(process.platform === 'darwin')('real native Provider accepts the complete large quote and preserves its original claim after Core reopen', async () => {
  const h = await fixture(true)
  try {
    const wire = fullQuote()
    await h.client.submitAgentPrompt(h.input('native-large', wire))
    const receipt = await h.receipt('native-large', 'admitted')
    expect(receipt).toMatchObject({ status: 'admitted', key: h.key('native-large') })
    const before = await h.client.inspectAgentPromptSubmission(h.key('native-large'))
    expect(before?.admission).toMatchObject({ transport: 'native', acknowledged: true, intent: { prompt: wire }, native: { outcome: 'admitted', plan: { protocolId: 'codex-app-server-v2-0.163' } } })
    await vi.waitFor(() => expect(h.inputs.filter(text => text === wire), JSON.stringify(h.inputs.map(text => ({ bytes: Buffer.byteLength(text), contains: text.includes(wire), prefix: text.slice(0, 60), suffix: text.slice(-60) })))).toHaveLength(1), { timeout: 20_000, interval: 100 })
    await h.reopen()
    expect(await h.client.inspectAgentPromptSubmission(h.key('native-large'))).toEqual(before)
    expect(await h.client.submitAgentPrompt(h.input('native-large', wire))).toMatchObject({ status: 'admitted', key: h.key('native-large') })
    expect(h.inputs.filter(text => text === wire)).toHaveLength(1)
    expect((await h.client.statusAgent('original')).run.acceptedInputBytes).toBe(h.initial.run.acceptedInputBytes)
  } finally { await h.close() }
})

it.runIf(process.platform === 'darwin')('real terminal preserves a large original waiting ref across reopen and explicit rejoin', async () => {
  const h = await fixture(false)
  try {
    const wire = fullQuote(), input = h.input('terminal-large', wire)
    await h.client.submitAgentPrompt(input, { assertCurrent: () => { throw new AgentMuxError('Private author owner temporarily unavailable', 'PRIVATE_AUTHOR_UNAVAILABLE') } })
    const waiting = await h.receipt('terminal-large', 'waiting', true)
    expect(waiting).toMatchObject({ status: 'waiting', key: h.key('terminal-large'), control: { waiting: { wake: 'explicit-rejoin' } } })
    expect(await h.terminalInputs()).toEqual([])
    expect(await h.client.inspectAgentPromptSubmission(h.key('terminal-large'))).toBeNull()
    await h.reopen()
    const original = await h.client.inspectAgentInput({ key: h.key('terminal-large') })
    expect(original?.ref).toEqual(waiting!.ref)
    await h.client.rejoinAgentInputWaiting({ ref: original!.ref }, { assertCurrent: () => {} })
    const joined = await h.receipt('terminal-large', 'terminal-confirmed')
    expect(joined).toMatchObject({ status: 'terminal-confirmed', ref: original!.ref })
    await vi.waitFor(async () => expect(await h.terminalInputs()).toEqual([wire]), { timeout: 5000, interval: 50 })
    const claim = await h.client.inspectAgentPromptSubmission(h.key('terminal-large'))
    expect(claim?.admission).toMatchObject({ acknowledged: true, intent: { prompt: wire }, inputDispatch: { ref: original!.ref } })
    await h.reopen()
    expect(await h.client.inspectAgentPromptSubmission(h.key('terminal-large'))).toEqual(claim)
    expect(await h.client.rejoinAgentInputWaiting({ ref: original!.ref })).toMatchObject({ status: 'terminal-confirmed', ref: original!.ref })
    expect(await h.terminalInputs()).toEqual([wire])
  } finally { await h.close() }
})

it.runIf(process.platform === 'darwin')('actual record and encoded terminal limits reject only their operation while short input remains usable', async () => {
  const h = await fixture(false)
  try {
    await h.client.submitAgentPrompt(h.input('record-too-large', '中'.repeat(400_000)))
    const rejected = await h.receipt('record-too-large', 'waiting', true)
    expect(rejected).toMatchObject({ status: 'waiting', control: { state: 'enabled', waiting: { wake: 'explicit-rejoin' } } })
    expect(await h.client.inspectAgentPromptSubmission(h.key('record-too-large'))).toBeNull()
    expect(await h.terminalInputs()).toEqual([])
    await h.client.rejoinAgentInputWaiting({ ref: rejected.ref })
    expect(await h.receipt('record-too-large', 'waiting', true)).toMatchObject({ ref: rejected.ref, control: { state: 'enabled' } })
    expect(await h.client.inspectAgentPromptSubmission(h.key('record-too-large'))).toBeNull()
    expect(await h.terminalInputs()).toEqual([])
    await h.client.submitAgentPrompt(h.input('short-after-record', 'PRIVATE_QUEUE_SHORT_RECORD'))
    expect(await h.receipt('short-after-record', 'terminal-confirmed')).toMatchObject({ status: 'terminal-confirmed' })
    await h.client.submitAgentPrompt(h.input('carrier-too-large', '中'.repeat(100_000)))
    const carrier = await h.receipt('carrier-too-large', 'not-applied')
    expect(carrier).toMatchObject({ status: 'not-applied' })
    await h.client.submitAgentPrompt(h.input('short-after-carrier', 'PRIVATE_QUEUE_SHORT_CARRIER'))
    expect(await h.receipt('short-after-carrier', 'terminal-confirmed')).toMatchObject({ status: 'terminal-confirmed' })
    await vi.waitFor(async () => expect(await h.terminalInputs()).toEqual(['PRIVATE_QUEUE_SHORT_RECORD', 'PRIVATE_QUEUE_SHORT_CARRIER']), { timeout: 5000, interval: 50 })
    expect((await h.client.statusAgent('original')).run).toMatchObject({ runId: h.initial.run.runId, pid: h.initial.run.pid, state: 'running' })
  } finally { await h.close() }
})
