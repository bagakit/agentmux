import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import type { AgentProvider } from '../src/agent-provider.js'
import type { AgentMuxClient } from '../src/client.js'
import type { AgentMuxRunInputData } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'

const evidenceDirectory = process.env.AGENTMUX_T040_EVIDENCE
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type Input = { operationId: string; expectedByte: number; data: AgentMuxRunInputData }
async function fixture() {
  const h = await rpcOwnerFixture(['original']); cleanup.push(h.close)
  let cursor = 0
  const writes: Input[] = []
  const run = (id = 'run-original'): CtxmuxAdapterRun => ({ ...h.run(id), pid: 123, acceptedInputBytes: cursor })
  Object.assign(h.inner.kernel, { identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-fixture' }),
    status: async (id: string) => run(id), list: async () => [run()],
    input: async (_id: string, input: Input) => {
      expect(input.expectedByte).toBe(cursor); writes.push(input)
      const startByte = cursor
      cursor += typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength
      return { run: run(), appliedByteRange: { startByte, endByte: cursor } }
    } })
  const target = { agentSessionId: 'original', expectedRun: { runId: 'run-original' } }
  return { ...h, run, writes, target }
}
function preparation(h: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred<AbortSignal>()
  vi.spyOn(h.client.providers.get('codex') as Required<Pick<AgentProvider, 'readPromptExecutionEvidence'>>, 'readPromptExecutionEvidence').mockImplementation(context => {
    const signal = context.signal!; entered.resolve(signal)
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  return entered.promise
}
function claimedRefreshPreparation(h: Awaited<ReturnType<typeof fixture>>) {
  // Whole mouse reports now preserve preclaim qualification. Exercise the diagnostic
  // after a real refresh claim/ACK, while the real Screen owner awaits a later frame.
  const provider = h.client.providers.get('codex'), entered = deferred<AbortSignal>()
  const catalog = Object.getOwnPropertyDescriptor(provider, 'catalog')!
  Object.defineProperty(provider, 'catalog', { ...catalog, value: { ...provider.catalog, capabilities: {
    ...provider.catalog.capabilities, promptExecution: { immediate: 'interrupt-before-input' } } } })
  cleanup.push(async () => { Object.defineProperty(provider, 'catalog', catalog) })
  vi.spyOn(provider, 'planPromptInput').mockImplementation(prompt => ({ kind: 'render-then-submit',
    payload: prompt, renderedText: prompt, submit: '\r', prepare: { refresh: '\x0c', interrupt: '\x1b', endEvent: 'turn-end' } }))
  vi.spyOn(provider, 'readPromptExecutionEvidence').mockResolvedValue({ sourceId: 'private-refresh-source', id: 'private-idle', state: 'idle' })
  vi.spyOn(provider, 'preparePromptExecutionTransport').mockResolvedValue({ nativeSourceId: 'private-refresh-source', verifyCurrentTransport: async () => true })
  vi.spyOn(provider, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  const bytes = Buffer.from('\x1b[?2026h\x1b[2J\x1b[10;1H> \x1b[10;3H\x1b[?2026l')
  const run = () => ({ ...h.run(), latestOutputBytes: bytes.length })
  Object.assign(h.inner.kernel, { status: async () => run(), list: async () => [run()],
    observeOutput: async () => ({ run: run(), resizeRevision: 0, gap: null, terminal: { type: 'not-requested' },
      replay: [{ startByte: 0, endByte: bytes.length, dataBytes: bytes }], close: async () => {} }) })
  const screen = (h.client as unknown as { screenEvidence: AgentScreenEvidenceStore }).screenEvidence
  const wait = screen.wait.bind(screen)
  vi.spyOn(screen, 'wait').mockImplementation((session, boundary, after, predicate, options) => {
    const result = wait(session, boundary, after, predicate, options)
    if (options.requireFrameAfterBoundary) {
      const admission = h.client.agentSession('original').promptCompletionAdmission
      expect(admission).toMatchObject({ submissionId: 'original-prompt', frameRefresh: { acknowledged: true } })
      expect(h.writes.map(write => write.data)).toEqual(['\x0c'])
      expect(options.signal?.aborted).toBe(false)
      entered.resolve(options.signal!)
    }
    return result
  })
  return entered.promise
}
function submit(h: Awaited<ReturnType<typeof fixture>>, client: Pick<AgentMuxClient, 'submitAgentPrompt'> = h.client) {
  return client.submitAgentPrompt({ ...h.target, operationId: 'original-prompt', afterSubmissionId: null,
    prompt: 'private failed prompt body', execution: 'immediate', allowUncertainTurn: true })
    .then(() => { throw new Error('The cancelled preparation must fail') }, error => error as AgentMuxError)
}
function detail(error: AgentMuxError): { source: string; competingInput: Record<string, unknown> } {
  let value = JSON.parse(error.detail!)
  while (value.detail !== undefined) value = JSON.parse(value.detail)
  expect(value.source).toBe('terminal-user'); return value
}

it.each(['accepted', 'not_applied', 'unknown'] as const)('freezes cancellation before the lane independently of eventual %s', async outcome => {
  const h = await fixture(), firstEntered = deferred<void>(), release = deferred<void>()
  const originalInput = h.inner.kernel.input as (id: string, input: Input) => Promise<unknown>
  const failure = new AgentMuxError('Original raw transport result', 'FIXTURE_INPUT_RESULT', outcome)
  h.inner.kernel.input = async (id: string, input: Input) => {
    if (input.data === 'prior') { firstEntered.resolve(); await release.promise }
    if (input.data === '雪' && outcome !== 'accepted') { h.writes.push(input); throw failure }
    return await originalInput(id, input)
  }
  const prior = h.client.writeAgent({ ...h.target, data: 'prior', source: 'user' }); await firstEntered.promise
  const entered = preparation(h), prompt = submit(h), signal = await entered
  const raw = h.client.writeAgent({ ...h.target, data: '雪', source: 'user' }).then(value => value, error => error)
  try {
    const error = await prompt, snapshot = detail(error), frozen = JSON.stringify(snapshot)
    expect(h.writes).toEqual([]); expect(signal.aborted).toBe(true)
    expect(snapshot.competingInput).toEqual({ agentSessionId: 'original', runId: 'run-original',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u), inputKind: 'write', encoding: 'utf8', byteLength: 3,
      bytePattern: 'other', phase: 'before-input-lane', expectedByte: null,
      acknowledgementAtCancellation: 'not-attempted', confirmedInputBytesAtCancellation: 0, eventualOutcome: 'unknown' })
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    release.resolve(); await prior; const result = await raw
    expect(h.writes.map(write => write.data)).toEqual(['prior', '雪'])
    expect(h.writes[1]!.operationId).toBe(snapshot.competingInput.operationId); expect(h.writes[1]!.expectedByte).toBe(5)
    if (outcome === 'accepted') expect(result).toEqual({ runId: 'run-original', appliedByteRange: { startByte: 5, endByte: 8 }, acceptedThroughByte: 8 })
    else expect(result).toBe(failure)
    expect(JSON.stringify(detail(error))).toBe(frozen)
    const lookup = await h.client.readDeliveryAttempt(error.logId!)
    expect(lookup.availability).toBe('found'); expect(detail({ detail: lookup.record!.error.detail } as AgentMuxError)).toEqual(snapshot)
    expect(JSON.stringify(lookup)).not.toContain('private failed prompt body'); expect(frozen).not.toContain('雪')
  } finally { release.resolve(); await Promise.allSettled([prior, prompt, raw]) }
})

it('preserves the first cause across multiple competing inputs', async () => {
  const h = await fixture(), entered = preparation(h), prompt = submit(h), signal = await entered
  // Read the original boundary created by the public submit; do not inject an observation or cause.
  const lanes = (h.client as unknown as { agentInputTails: Map<string, { renderObservations: Set<{ protocolInput?: { cancelled?: Error } }> }> }).agentInputTails
  const boundary = [...lanes.get('original')!.renderObservations][0]!.protocolInput!
  const first = h.client.writeAgent({ ...h.target, data: 'first-private-body', source: 'user' })
  const firstReason = signal.reason as AgentMuxError, firstDetail = firstReason.detail
  const second = h.client.writeAgent({ ...h.target, data: '\x1b[<64;10;20M', source: 'user' })
  const error = await prompt; await Promise.all([first, second])
  expect(signal.reason).toBe(firstReason); expect(boundary.cancelled).toBe(firstReason); expect(firstReason.detail).toBe(firstDetail)
  expect(detail(error).competingInput.operationId).toBe(h.writes[0]!.operationId)
  expect(detail(error).competingInput.operationId).not.toBe(h.writes[1]!.operationId)
  expect(JSON.stringify(detail(error))).not.toContain('first-private-body')
})

it.each([
  ['SGR press', '\x1b[<0;10;20M', 'mouse-sgr'], ['SGR release', '\x1b[<0;10;20m', 'mouse-sgr'],
  ['SGR wheel', Uint8Array.from(Buffer.from('\x1b[<64;10;20M')), 'mouse-sgr'],
  ['legacy binary', Uint8Array.of(27, 91, 77, 96, 255, 32), 'mouse-legacy'], ['legacy ASCII', '\x1b[M !!', 'mouse-legacy'],
  ['legacy unicode', '\x1b[Mé ', 'other'], ['key', 'a', 'other'], ['arrow', '\x1b[A', 'other'],
  ['DA', '\x1b[?1;2c', 'other'], ['DSR', '\x1b[24;80R', 'other'], ['focus', '\x1b[I', 'other'],
  ['mixed', 'a\x1b[<64;10;20M', 'other'], ['split', '\x1b[<64;10;', 'other'],
  ['newline suffix', '\x1b[<64;10;20M\n', 'other'],
  ['binary high bit', Uint8Array.from([27, 91, 60, 176, 59, 49, 59, 49, 77]), 'other'],
  ['oversize', '\x1b[<' + '1'.repeat(100) + ';10;20M', 'other']
] as const)('reports bounded whole-byte syntax for %s without content or coordinates', async (_name, data, expectedPattern) => {
  const h = await fixture(), claimedMouse = ['SGR press', 'SGR release', 'SGR wheel', 'legacy ASCII'].includes(_name)
  const entered = claimedMouse ? claimedRefreshPreparation(h) : preparation(h), prompt = submit(h), signal = await entered
  if (claimedMouse) expect((await h.store.load())[0]).toMatchObject({ agentSessionId: 'original',
    promptCompletionAdmission: { submissionId: 'original-prompt', frameRefresh: { acknowledged: true,
      operationId: h.writes[0]!.operationId, inputByteRange: { startByte: 0, endByte: 1 } } } })
  const raw = h.client.writeAgent({ ...h.target, data, source: 'user' }), error = await prompt, snapshot = detail(error).competingInput; await raw
  expect(signal.aborted).toBe(true)
  if (claimedMouse) {
    expect(error.code).toBe('AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
    expect(error.controlFailure?.disposition).not.toBe('not_applied')
    expect(h.writes.map(write => write.data)).toEqual(['\x0c', data])
  }
  expect(snapshot.bytePattern).toBe(expectedPattern); expect(snapshot.encoding).toBe(typeof data === 'string' ? 'utf8' : 'binary')
  expect(snapshot.byteLength).toBe(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength)
  expect(snapshot.operationId).toBe(h.writes[claimedMouse ? 1 : 0]!.operationId)
  expect(Object.keys(snapshot).sort()).toEqual(['agentSessionId', 'runId', 'operationId', 'inputKind', 'encoding', 'byteLength',
    'bytePattern', 'phase', 'expectedByte', 'acknowledgementAtCancellation', 'confirmedInputBytesAtCancellation', 'eventualOutcome'].sort())
})

it.each(['paste', 'posture'] as const)('records the actual public %s entry and eventual exact bytes', async kind => {
  const h = await fixture(), entered = preparation(h), prompt = submit(h); await entered
  if (kind === 'posture') vi.spyOn(h.client.providers.get('codex'), 'planPostureSet').mockReturnValue({ data: '\x1b[Z' })
  const raw = kind === 'paste' ? h.client.pasteAgent({ ...h.target, text: 'private pasted 雪', terminalData: 'ignored terminal data' })
    : h.client.setAgentPosture({ ...h.target, modeId: 'fixture-declared-mode' })
  const snapshot = detail(await prompt).competingInput; await raw; const actual = h.writes[0]!
  expect(snapshot.inputKind).toBe(kind); expect(snapshot.operationId).toBe(actual.operationId)
  expect(snapshot.byteLength).toBe(typeof actual.data === 'string' ? Buffer.byteLength(actual.data) : actual.data.byteLength)
  expect(JSON.stringify(snapshot)).not.toContain('private pasted')
})

it('keeps empty/wrong-Run inputs and protocol handoff unchanged', async () => {
  const h = await fixture(), entered = preparation(h), prompt = submit(h), signal = await entered
  expect(await h.client.writeAgent({ ...h.target, data: '', source: 'user' })).toMatchObject({ appliedByteRange: { startByte: 0, endByte: 0 } })
  await expect(h.client.writeAgent({ ...h.target, expectedRun: { runId: 'another-run' }, data: 'wrong', source: 'user' }))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(signal.aborted).toBe(false); expect(h.writes).toEqual([])
  await h.client.writeAgent({ ...h.target, data: '\x1b[24;80R', source: 'terminal-protocol' }); expect(signal.aborted).toBe(false)
  await h.client.writeAgent({ ...h.target, data: 'z', source: 'user' })
  expect(detail(await prompt).competingInput.operationId).toBe(h.writes[1]!.operationId)
  expect(h.writes.map(write => write.data)).toEqual(['\x1b[24;80R', 'z'])
})

it('preserves actual detail/logid through Hosted SDK, Unix RPC and compiled CLI while offline', async () => {
  const h = await fixture(), root = await mkdtemp(fixturePath("tmp/amux-input-cause-cli-")); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client)); cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: h.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'owner.sock') } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  const entered = claimedRefreshPreparation(h), prompt = submit(h, hosted), signal = await entered
  expect((await h.store.load())[0]).toMatchObject({ agentSessionId: 'original', promptCompletionAdmission: {
    submissionId: 'original-prompt', frameRefresh: { acknowledged: true, operationId: h.writes[0]!.operationId,
      inputByteRange: { startByte: 0, endByte: 1 } } } })
  await hosted.writeAgent({ ...h.target, data: '\x1b[<64;10;20M', source: 'user' })
  const error = await prompt, snapshot = detail(error), first = await hosted.readDeliveryAttempt(error.logId!)
  expect(signal.aborted).toBe(true); expect(error.code).toBe('AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
  expect(error.controlFailure?.disposition).not.toBe('not_applied')
  expect(h.writes.map(write => write.data)).toEqual(['\x0c', '\x1b[<64;10;20M'])
  expect(detail({ detail: first.record!.error.detail } as AgentMuxError)).toEqual(snapshot)
  expect(snapshot.competingInput.operationId).toBe(h.writes[1]!.operationId)
  const connect = vi.spyOn(h.client, 'connect'); h.inner.connected = false
  expect((await hosted.readDeliveryAttempt(error.logId!)).record).toEqual(first.record); expect(connect).not.toHaveBeenCalled()
  const { build } = await import('esbuild'), output = join(root, 'agentmux.mjs')
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'))
  const built = await build({ entryPoints: [fileURLToPath(new URL('../src/agentmux.ts', import.meta.url))], outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', metafile: true })
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete env[key]
  const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [output, '--endpoint', `unix://${join(root, 'owner.sock')}`, 'message', 'delivery', 'inspect', '--logid', error.logId!], { env })
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr }))
  })
  expect(result.exit, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.record).toEqual(first.record)
  expect(result.stdout).not.toContain('private failed prompt body')
  const evidence = evidenceDirectory
  if (evidence) {
    await writeFile(join(evidence, 'public-cli.mjs'), await readFile(output)); await writeFile(join(evidence, 'public-cli.metafile.json'), JSON.stringify(built.metafile))
    await writeFile(join(evidence, 'public-consumer.json'), JSON.stringify({ error: { code: error.code, detail: error.detail, logId: error.logId,
      controlFailure: error.controlFailure }, snapshot, first, result, actualRawInputOperation: h.writes[1]!.operationId,
      refresh: h.client.agentSession('original').promptCompletionAdmission?.frameRefresh, offline: true }))
  }
}, 15_000)
