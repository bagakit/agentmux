import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentProviderInteractionResponseContext } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import { CodexPromptTransportUnconfirmedError } from '../src/providers/codex-prompt-execution-evidence.js'
import { createCodexPromptTransportPreparation } from '../src/providers/codex-prompt-transport-preparation.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxInteractionRequest, AgentMuxStoredAgentSession } from '../src/types.js'

const native = vi.hoisted(() => ({ path: '', device: 0n, inode: 0n, owners: [22] as number[], descriptor: '8',
  rootBirth: 'root-birth', writerBirth: 'writer-birth', image: 'removed', imageReads: 0, fileReads: 0, changedAfterRead: '' }))
vi.mock('../src/agent-native-process.js', async original => ({
  ...await original<typeof import('../src/agent-native-process.js')>(),
  nativeProcessBirth: async (pid: number) => pid === 11 ? native.rootBirth : native.writerBirth,
  nativeProcessFiles: async () => { native.fileReads++; if (native.fileReads === 2 && native.changedAfterRead === 'root-birth') native.rootBirth = 'changed'; if (native.fileReads === 2 && native.changedAfterRead === 'writer-birth') native.writerBirth = 'changed'; return native.owners.map(processId => ({ processId, processGroup: 11,
    descriptor: native.descriptor, path: native.path, device: native.device, inode: native.inode, access: 'w' })) },
  openNativeProcessImage: async () => { native.imageReads++; throw new AgentMuxError(native.image === 'removed'
    ? 'No single current native entry image was confirmed.' : 'Mapped pathname now identifies replacement bytes.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE') }
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { try { while (cleanup.length) await cleanup.pop()!() } finally { vi.unstubAllEnvs() } })

async function fixture(image = 'removed') {
  const root = await mkdtemp(join(tmpdir(), 'amux-current-capability-')), path = join(root, 'native.jsonl')
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  // cli_version is deliberately unsupported creator metadata; it is not current capability evidence.
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'native-session', cli_version: '0.1.0' } }) + '\n')
  const source = await stat(path, { bigint: true })
  Object.assign(native, { path, device: source.dev, inode: source.ino, owners: [22], descriptor: '8',
    rootBirth: 'root-birth', writerBirth: 'writer-birth', image, imageReads: 0, fileReads: 0, changedAfterRead: '' })
  const provider = { ...new AgentProviderRegistry().get('codex') }
  const context = { processId: 11, args: [] as string[], workspacePath: root,
    nativeHandle: { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'native-session', transcriptPath: path },
    signal: new AbortController().signal }
  const evidence = await provider.readPromptExecutionEvidence!(context)
  return { root, path, provider, context: { ...context, nativeSourceId: evidence!.sourceId } }
}

async function publicMessage(image: string, fault?: string) {
  const f = await fixture(image), store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original', providerId: 'codex', executorId: 'native',
    hostId: 'local', workspacePath: f.root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token',
    nativeHandle: f.context.nativeHandle, createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store, providers: [f.provider] }), owner = client as any, screen = new AgentTerminalScreen(80, 24)
  const verifications: Promise<boolean>[] = []
  cleanup.push(async () => { screen.dispose(); await client.dispose(); await Promise.allSettled(verifications) })
  let cursor = 0, pid = 11, geometry = 0
  const writes: string[] = [], attempts: string[] = []
  const draw = async (body = '') => {
    const text = fault === 'unknown-pane' && !body ? 'UNKNOWN CURRENT PROFILE' : '› ' + body
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[13;1HReady\x1b[16;1H${text}${body ? '' : '\x1b[2mAsk Codex to do anything\x1b[22m'}\x1b[18;1H? for shortcuts\x1b[16;${body.length + 3}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw(); await owner.registry.load('local')
  const run = () => ({ runId: 'original-run', sessionId: 'runtime-session', runtimeId: 'runtime', role: 'agent', hostId: 'local', executorId: 'native',
    program: 'codex', args: fault === 'remote' ? ['--remote=private'] : [], workspacePath: f.root, pid, state: { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: cursor })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 1, buildIdentity: 'synthetic-runtime' })
  owner.kernel.status = async () => run()
  owner.kernel.input = async (_id: string, op: { expectedByte: number; data: string }) => {
    attempts.push(op.data); expect(op.expectedByte).toBe(cursor)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(op.data) }; cursor = range.endByte; writes.push(op.data)
    if (op.data !== '\r') await draw(op.data === '\x1b[I' ? '' : op.data.replace(/^\x1b\[200~|\x1b\[201~$/gu, ''))
    return { run: run(), appliedByteRange: range }
  }
  owner.screenEvidence.wait = async (_session: unknown, _through: number, _after: boolean, inspect: (screen: AgentTerminalScreen) => boolean) => {
    if (!inspect(screen)) throw new AgentMuxError('Current supported pane was not observed.', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }
  owner.screenEvidence.generation = () => geometry
  owner.connected = true
  const originalVerify = owner.providers.get('codex').verifyPromptExecutionTransport
  owner.providers.get('codex').verifyPromptExecutionTransport = (context: Parameters<typeof originalVerify>[0]) => {
    const pending = (async () => {
      if (fault === 'final-writer') native.changedAfterRead = 'writer-birth'
      const confirmed = await originalVerify(context)
      if (fault === 'final-cursor') cursor++
      if (fault === 'final-pid') pid++
      if (fault === 'final-geometry') geometry++
      return confirmed
    })()
    verifications.push(pending)
    return pending
  }
  if (fault === 'no-writer') native.owners = []
  if (fault === 'multiple-writers') native.owners = [22, 33]
  const submitted = client.submitAgentPrompt({ agentSessionId: 'original', expectedRun: stored.run, afterSubmissionId: null,
    operationId: 'original-operation', prompt: 'ORIGINAL_BODY', execution: 'immediate', signal: AbortSignal.timeout(2_000) })
  return { f, client, store, submitted, writes, attempts }
}

async function typed(image: string) {
  const f = await fixture(image), args = JSON.stringify({ cmd: 'printf private', sandbox_permissions: 'require_escalated' })
  await appendFile(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'exact-call', name: 'exec_command', arguments: args } }) + '\n')
  const request: AgentMuxInteractionRequest = { kind: 'permission', id: 'original-request', agentSessionId: 'original', title: 'approval',
    nativeToolCallId: 'exact-call', toolName: 'exec_command', toolInput: args, options: [{ id: 'allow-once', kind: 'allow-once', label: 'Allow' }],
    evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'original-run' }, hookReceiptId: 'hook' } }
  const lines = ['', '  Would you like to run the following command?', '', '  $ printf private', '', '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel', '']
  const context: AgentProviderInteractionResponseContext = { ...f.context, agentSessionId: 'original', run: { runId: 'original-run' }, inputByte: 0,
    observeTarget: async inspect => { expect(inspect({ cols: 80, rows: lines.length, cursor: { row: 0, column: 1 },
      lines: lines.map(text => ({ text, cells: [], wrapped: false })) })).toBe(true)
      return { run: { runId: 'original-run' }, outputThroughByte: 100, geometryRevision: 1, evidenceGeneration: 1 } } }
  const prepared = await f.provider.prepareInteractionResponse!(context, request,
    { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'allow-once' } })
  return { f, context, request, prepared }
}

describe('current source/writer capability without an executable pathname gate', () => {
  it.each(['removed', 'replacement'])('runs the actual public message preparation and final pane with %s image pathname', async image => {
    const f = await publicMessage(image)
    await expect(f.submitted).resolves.toBeUndefined()
    expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
    expect(f.attempts).toEqual(f.writes); expect(native.imageReads).toBe(0); expect(native.fileReads).toBeGreaterThanOrEqual(2)
    const admission = (await loadAgentSessions(f.store))[0]!.promptCompletionAdmission!
    expect(admission.submissionId).toBe('original-operation'); expect(admission.acknowledged).toBe(true)
    expect(admission.intent?.prompt).toBe('ORIGINAL_BODY')
  })
  it.each(['unknown-pane', 'remote', 'final-cursor', 'final-pid', 'final-writer'])('preserves the actual public message/final %s refusal', async fault => {
    const f = await publicMessage('removed', fault)
    await expect(f.submitted).rejects.toBeDefined()
    expect(f.attempts.filter(data => data.includes('ORIGINAL_BODY') || data === '\r')).toEqual([])
    expect(native.imageReads).toBe(0)
  })
  it.each(['removed', 'replacement'])('prepares the exact supported typed target with %s image pathname', async image => {
    const f = await typed(image)
    expect(f.prepared?.plan.data).toBe('1'); expect(f.prepared?.target.nativeToolCallId).toBe('exact-call')
    expect(await f.prepared!.verifyCurrentTarget(f.context)).toBe(true); expect(native.imageReads).toBe(0)
  })
  it.each(['pid', 'birth', 'root-birth', 'descriptor', 'multiple', 'source', 'handle', 'remote'])('refuses changed %s in the actual prompt final verifier', async fault => {
    const f = await fixture(), prepared = await f.provider.preparePromptExecutionTransport!(f.context)
    expect(prepared).not.toBeNull()
    if (fault === 'pid') native.owners = [33]
    if (fault === 'birth') native.writerBirth = 'changed'
    if (fault === 'root-birth') native.rootBirth = 'changed'
    if (fault === 'descriptor') native.descriptor = '9'
    if (fault === 'multiple') native.owners = [22, 33]
    if (fault === 'source') await writeFile(f.path, JSON.stringify({ type: 'session_meta', payload: { id: 'other' } }) + '\n')
    const current = { ...f.context, ...(fault === 'handle' ? { nativeHandle: { ...f.context.nativeHandle, sessionId: 'other' } } : {}),
      ...(fault === 'remote' ? { args: ['--remote=private'] } : {}) }
    if (fault === 'remote') await expect(prepared!.verifyCurrentTransport(current)).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED' })
    else expect(await prepared!.verifyCurrentTransport(current)).toBe(false)
  })
  it.each([
    ['no-writer', 'native-source-writer-missing'], ['multiple', 'native-source-writer-ambiguous'],
    ['remote', 'unsupported-launch'], ['unknown-native', 'native-header-mismatch'],
    ['root-birth', 'runtime-process-changed'], ['writer-birth', 'native-writer-process-changed']
  ])('retains the direct local transport %s refusal', async (fault, reason) => {
    const f = await fixture()
    if (fault === 'no-writer') native.owners = []
    if (fault === 'multiple') native.owners = [22, 33]
    if (fault === 'root-birth' || fault === 'writer-birth') native.changedAfterRead = fault
    if (fault === 'unknown-native') await writeFile(f.path, JSON.stringify({ type: 'unknown-profile', payload: { id: 'native-session' } }) + '\n')
    const error = await f.provider.verifyPromptExecutionTransport!({ ...f.context, ...(fault === 'remote' ? { args: ['--remote=private'] } : {}) })
      .then(() => null, error => error as AgentMuxError)
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED', message: 'The native input transport is unconfirmed.', detail: expect.any(String) })
    expect(JSON.parse(error!.detail!)).toMatchObject({ providerId: 'codex', reason, processId: 11, nativeSourceId: f.context.nativeSourceId })
    expect(error!.detail).not.toContain('private')
    expect(native.imageReads).toBe(0)
  })
  it('refuses a native source changed during transport verification', async () => {
    const f = await fixture(), original = native.fileReads
    const birth = native.rootBirth
    // An exact source mismatch must not pass solely because its local writer exists.
    await expect(f.provider.verifyPromptExecutionTransport!({ ...f.context, nativeSourceId: 'foreign-source' })).rejects.toMatchObject({
      code: 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED', detail: expect.stringContaining('native-source-mismatch') })
    expect(native.fileReads).toBe(original); expect(native.rootBirth).toBe(birth)
  })
  it('keeps the original startup observation wait after a transient verifier refusal', async () => {
    const f = await fixture(); let attempts = 0
    const prepare = createCodexPromptTransportPreparation(async context => {
      attempts++
      if (attempts === 1) throw new CodexPromptTransportUnconfirmedError(context, 'native-source-writer-missing', 0)
      return await f.provider.verifyPromptExecutionTransport!(context)
    })
    const preparing = prepare({ ...f.context, signal: AbortSignal.timeout(2_000) })
    await expect(preparing).resolves.toMatchObject({ nativeSourceId: f.context.nativeSourceId })
    const prepared = await preparing
    expect(attempts).toBe(2); expect(prepared?.nativeSourceId).toBe(f.context.nativeSourceId)
    native.owners = []
    expect(await prepared!.verifyCurrentTransport(f.context)).toBe(false)
  })
  it('does not swallow a different verifier error or its cancellation provenance', async () => {
    const f = await fixture(), original = new AgentMuxError('Original observation cancelled.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED', 'original-cancellation')
    const prepare = createCodexPromptTransportPreparation(async () => { throw original })
    await expect(prepare({ ...f.context, signal: AbortSignal.timeout(2_000) })).rejects.toBe(original)
  })
  it.each([
    ['no-writer', 'native-source-writer-missing', 0], ['multiple-writers', 'native-source-writer-ambiguous', 2]
  ] as const)('preserves %s refusal through public submission, original delivery RPC and compiled CLI', async (fault, reason, ownerCount) => {
    const f = await publicMessage('removed', fault)
    const error = await f.submitted.then(() => null, error => error as AgentMuxError)
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    const cause = JSON.parse(error!.detail!)
    expect(cause).toMatchObject({ detail: expect.any(String) })
    const observation = JSON.parse(cause.detail)
    expect(cause.code).toBe('AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED')
    expect(observation).toEqual({ providerId: 'codex', reason, processId: 11, nativeSourceId: f.f.context.nativeSourceId, ownerCount })
    expect(f.attempts).toEqual([])
    const original = await f.client.readDeliveryAttempt(error!.logId!)
    expect(original.record).toMatchObject({ agentSessionId: 'original', expectedRunId: 'original-run', operationId: 'original-operation', afterSubmissionId: null,
      error: { detail: error!.detail, controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } })
    expect((await loadAgentSessions(f.store))[0]!.run).toEqual({ runId: 'original-run' })
    expect(JSON.stringify(original.record)).not.toContain('ORIGINAL_BODY')
    const server = new AgentMuxControlServer({ socketPath: join(f.f.root, 'owner.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      expect((await rpc.call('message.delivery.inspect', { logId: error!.logId!, hostId: 'local' })).record).toEqual(original.record)
      const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'delivery', 'inspect', '--logid', error!.logId!, '--host-id', 'local'], objectCliEnvironment(f.f.root))
      expect(cli.code, cli.stderr).toBe(0)
      expect(JSON.parse(cli.stdout).result.record).toEqual(original.record)
      expect(f.attempts).toEqual([])
    } finally { rpc.dispose(); await server.stop() }
  }, 20_000)
})
