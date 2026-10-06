import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentProviderInteractionResponseContext } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { CodexPromptTransportUnconfirmedError } from '../src/providers/codex-prompt-execution-evidence.js'
import { createCodexPromptTransportPreparation } from '../src/providers/codex-prompt-transport-preparation.js'
import type { AgentMuxInteractionRequest } from '../src/types.js'

const native = vi.hoisted(() => ({ path: '', device: 0n, inode: 0n, owners: [22] as number[], descriptor: '8',
  rootBirth: 'root-birth', writerBirth: 'writer-birth', fileReads: 0, changedAfterRead: '' }))
vi.mock('../src/agent-native-process.js', async original => ({
  ...await original<typeof import('../src/agent-native-process.js')>(),
  nativeProcessBirth: async (pid: number) => pid === 11 ? native.rootBirth : native.writerBirth,
  nativeProcessFiles: async () => { native.fileReads++; if (native.fileReads === 2 && native.changedAfterRead === 'root-birth') native.rootBirth = 'changed'; if (native.fileReads === 2 && native.changedAfterRead === 'writer-birth') native.writerBirth = 'changed'; return native.owners.map(processId => ({ processId, processGroup: 11,
    descriptor: native.descriptor, path: native.path, device: native.device, inode: native.inode, access: 'w' })) }
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { try { while (cleanup.length) await cleanup.pop()!() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

async function fixture() {
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const root = await mkdtemp(join(tmpdir(), 'amux-current-capability-')), path = join(root, 'native.jsonl')
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  // cli_version is deliberately unsupported creator metadata; it is not current capability evidence.
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'native-session', cli_version: '0.1.0' } }) + '\n')
  const source = await stat(path, { bigint: true })
  Object.assign(native, { path, device: source.dev, inode: source.ino, owners: [22], descriptor: '8',
    rootBirth: 'root-birth', writerBirth: 'writer-birth', fileReads: 0, changedAfterRead: '' })
  const provider = { ...new AgentProviderRegistry().get('codex') }
  const context = { processId: 11, args: [] as string[], workspacePath: root,
    nativeHandle: { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'native-session', transcriptPath: path },
    signal: new AbortController().signal }
  const evidence = await provider.readPromptExecutionEvidence!(context)
  return { root, path, provider, context: { ...context, nativeSourceId: evidence!.sourceId } }
}

async function typed() {
  const f = await fixture(), args = JSON.stringify({ cmd: 'printf private', sandbox_permissions: 'require_escalated' })
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
  it('prepares the exact supported typed target from its original protocol source and writer', async () => {
    const f = await typed()
    expect(f.prepared?.plan.data).toBe('1'); expect(f.prepared?.target.nativeToolCallId).toBe('exact-call')
    expect(await f.prepared!.verifyCurrentTarget(f.context)).toBe(true)
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
})
