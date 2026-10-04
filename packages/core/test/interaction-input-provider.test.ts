import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectCodexInteractionTarget } from '../src/providers/codex-interaction-target.js'
import { AgentProviderRegistry, type AgentProviderInteractionResponseContext } from '../src/agent-provider.js'
import type { AgentMuxInteractionRequest, AgentTerminalScreenSnapshot } from '../src/types.js'

const native = vi.hoisted(() => ({ owners: [22] as number[], birth: 'writer-birth', image: 'writer-descriptor', descriptor: '8', rootBirth: 'root-birth', path: '', device: 0n, inode: 0n, reads: 0, closed: 0 }))
vi.mock('../src/agent-native-process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agent-native-process.js')>(),
  nativeProcessBirth: async (pid: number) => pid === 11 ? native.rootBirth : native.birth,
  nativeProcessFiles: async () => { native.reads++; return native.owners.map(processId => ({ processId, path: native.path, device: native.device, inode: native.inode, descriptor: native.descriptor, access: 'w' })) },
  openNativeProcessImage: async () => ({ identity: native.image, assertCurrent: async () => {}, file: { close: async () => { native.closed++ } } })
}))
let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })
function pane(cmd = 'printf private') : AgentTerminalScreenSnapshot {
  const lines = ['', '  Would you like to run the following command?', '', '  Environment: local', '', `  $ ${cmd}`, '',
    '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again (p)", '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel', '', '']
  return { cols: 80, rows: lines.length, cursor: { row: 11, column: 80 }, lines: lines.map(text => ({ text, wrapped: false, cells: [] })) }
}
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'amux-interaction-source-')); const path = join(directory, 'native.jsonl')
  const invocation = { type: 'response_item', payload: { type: 'function_call', call_id: 'exact-call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf private', sandbox_permissions: 'require_escalated' }) } }
  await writeFile(path, [JSON.stringify({ type: 'session_meta', payload: { id: 'native-session' } }), JSON.stringify(invocation), ''].join('\n'))
  const source = await stat(path, { bigint: true })
  Object.assign(native, { owners: [22], birth: 'writer-birth', image: 'writer-descriptor', descriptor: '8', rootBirth: 'root-birth', path, device: source.dev, inode: source.ino, reads: 0, closed: 0 })
  const request: AgentMuxInteractionRequest = { kind: 'permission', id: 'exact-request', agentSessionId: 'agent', title: 'private approval', nativeToolCallId: 'exact-call', toolName: 'exec_command', toolInput: invocation.payload.arguments,
    options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }], evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run' }, hookReceiptId: 'hook' } }
  const response = { kind: 'permission' as const, requestId: request.id, decision: { outcome: 'selected' as const, optionId: 'allow-once' } }
  const context: AgentProviderInteractionResponseContext = { agentSessionId: 'agent', run: { runId: 'run' }, inputByte: 5, processId: 11, args: [], workspacePath: directory, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-session', transcriptPath: path }, signal: new AbortController().signal,
    observeTarget: async inspect => { if (!inspect(pane())) throw new Error('Synthetic pane does not qualify'); return { run: { runId: 'run' }, outputThroughByte: 100, geometryRevision: 1, evidenceGeneration: 1 } } }
  const prepare = new AgentProviderRegistry().get('codex').prepareInteractionResponse!
  expect(typeof prepare, 'public Provider definition lost its preparation contribution').toBe('function')
  return { context, request, response, prepare, path }
}

describe('Provider exact native typed input target', () => {
  it('binds the actual authenticated Bash projection to its exec_command native invocation', async () => {
    const f = await fixture()
    const request = { ...f.request, toolName: 'Bash', toolInput: JSON.stringify({ command: 'printf private', description: 'Private approval' }) }
    await appendFile(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'exact-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'printf private', sandbox_permissions: 'require_escalated', justification: 'Private approval' }) } }) + '\n')
    const prepared = await f.prepare(f.context, request, f.response)
    expect(prepared?.target.nativeToolCallId).toBe('exact-call'); expect(prepared?.plan.data).toBe('1')
    await appendFile(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'exact-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'printf other', sandbox_permissions: 'require_escalated', justification: 'Private approval' }) } }) + '\n')
    expect(await prepared!.verifyCurrentTarget(f.context)).toBe(false)
    await appendFile(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'exact-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'printf private', justification: 'Different justification' }) } }) + '\n')
    expect(await prepared!.verifyCurrentTarget(f.context)).toBe(false)
  })
  it('binds the outstanding native call and current approval pane, and never caches completion authority', async () => {
    const f = await fixture(), prepared = await f.prepare(f.context, f.request, f.response)
    expect(prepared?.plan.data).toBe('1'); expect(prepared?.target).toMatchObject({ requestId: 'exact-request', nativeToolCallId: 'exact-call', inputByte: 5 })
    expect(native.closed).toBe(0)
    await appendFile(f.path, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'exact-call', output: 'complete' } }) + '\n')
    expect(await prepared!.verifyCurrentTarget({ ...f.context, nativeSourceId: prepared!.target.nativeSourceId })).toBe(false)
  })

  it('waits for the actual pane within original preparation instead of accepting an early Hook composer', async () => {
    const f = await fixture(); let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), ready = new Promise<void>(resolve => { release = resolve })
    const context: AgentProviderInteractionResponseContext = { ...f.context, observeTarget: async inspect => {
      const composer = pane(); composer.lines[1]!.text = 'Ordinary composer'; expect(inspect(composer)).toBe(false)
      enter(); await ready; expect(inspect(pane())).toBe(true)
      return { run: f.context.run, outputThroughByte: 200, geometryRevision: 1, evidenceGeneration: 1 }
    } }
    const result = f.prepare(context, f.request, f.response); await entered; release()
    expect((await result)?.target.frame.outputThroughByte).toBe(200)
  })

  it.each(['writer-pid', 'writer-birth', 'writer-descriptor', 'root-birth', 'multiple-writers', 'source'] as const)('refuses changed %s before any new typed input', async kind => {
    const f = await fixture(), prepared = await f.prepare(f.context, f.request, f.response)
    if (kind === 'writer-pid') native.owners = [33]
    if (kind === 'writer-birth') native.birth = 'changed'
    if (kind === 'writer-descriptor') native.descriptor = 'changed'
    if (kind === 'root-birth') native.rootBirth = 'changed'
    if (kind === 'multiple-writers') native.owners = [22, 33]
    if (kind === 'source') { await rm(f.path); await writeFile(f.path, JSON.stringify({ type: 'session_meta', payload: { id: 'other-session' } }) + '\n') }
    expect(await prepared!.verifyCurrentTarget({ ...f.context, nativeSourceId: prepared!.target.nativeSourceId })).toBe(false)
  })

  it.each(['ordinary-composer', 'wrong-command', 'inactive-menu', 'incomplete'] as const)('does not authorize a %s frame', async kind => {
    const f = await fixture(), screen = pane()
    if (kind === 'ordinary-composer') screen.lines[1]!.text = '› Ask a question'
    if (kind === 'wrong-command') screen.lines[5]!.text = '$ printf another'
    if (kind === 'inactive-menu') screen.lines[7]!.text = '  1. Yes, proceed (y)'
    if (kind === 'incomplete') screen.lines.pop()
    expect(inspectCodexInteractionTarget(screen, f.request)).toBe(false)
  })

  it('rejects a remote declaration without pretending that local source observation grants input', async () => {
    const f = await fixture(); expect(await f.prepare({ ...f.context, args: ['--remote=private'] }, f.request, f.response)).toBeNull(); expect(native.reads).toBe(0)
  })

  it('cannot bind a different exact call from the same observed Hook', async () => {
    const f = await fixture(), controller = new AbortController(); f.context.signal = controller.signal
    const pending = f.prepare(f.context, { ...f.request, nativeToolCallId: 'wrong-call' }, f.response)
    setTimeout(() => controller.abort(new Error('bounded private observation cancelled')), 10)
    await expect(pending).rejects.toThrow(); expect(controller.signal.aborted).toBe(true)
  })
})
