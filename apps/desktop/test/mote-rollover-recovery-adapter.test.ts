import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import ts from 'typescript'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { RuntimeController } from '../src/main/runtime-controller'
import { AgentMuxError, connectAgentMuxRpc } from '@agentmux/core'
import { parseMoteDialogueParams, parseMoteDialogueResult, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { sessionRecoveryOperationResult } from '../src/main/session-recovery-operation'
import { createRendererSessionRecovery } from '../src/renderer/src/lib/session-recovery-api'
import { isSessionRecoveryReplyUnconfirmed } from '../src/shared/session-recovery-result'
import { originalMoteRollover } from '../src/renderer/src/lib/mote-main-rollover'
import ipcSource from '../src/main/ipc.ts?raw'
import preloadSource from '../src/preload/index.ts?raw'
import type { SessionControl, SessionRecoveryResult } from '../src/shared/contracts'

vi.mock('electron', () => ({ app: { isPackaged: false }, nativeImage: {} }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const target = { spaceId: 'original-mote', zoneId: 'original-zone', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/private/original-mote-fixture' } }
const reference = { hostId: 'local', sessionId: 'original-main', displayWorkspaceId: 'scratch', groupId: 'group', tabId: 'tab', regionId: 'region' }
const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: reference.sessionId, run: { runId: 'original-ended-run' } }
const queryId = 'new-explicit-question', recoveryId = 'original-input-recovery', role = 'original-main-role'
const decision: MoteMainRolloverDecision = { target, reference, expectedRoleRevision: role,
  queryInputKey: { kind: 'prompt', agentSessionId: control.agentSessionId, expectedRun: control.run, submissionId: queryId },
  policy: { kind: 'continuity-unavailable', idleMs: 60000 }, continuity: { operationId: 'original-entry-receipt', previousRun: control.run,
    reason: 'native-handle-unavailable', evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } }, policyRevision: 'original-policy',
  evaluatedAt: 2, queryOperationId: queryId, creationOperationId: 'original-new-main-creation' }
const request = { trigger: 'input' as const, input: { submissionId: queryId, prompt: 'Only this separately new question.', authorHuman: true,
  sourceChannel: 'message-tool' as const, inputContextCapture: { hostId: 'local', operationId: 'original-capture' }, agentMuxNote: 'Original captured note' },
  moteMain: { target, expectedRoleRevision: role } }
const entry = { operationId: queryId, text: request.input.prompt, moteMain: request.moteMain, runId: control.run.runId } as Parameters<typeof originalMoteRollover>[1]
const due = () => ({ route: null, record: null, input: null, disposition: 'rollover-required', rollover: { status: 'due', decision: structuredClone(decision), issue: null } })
function fixture(reply: () => unknown = due) {
  const calls: unknown[] = [], wire = vi.fn(async (method: string, params: unknown, context: unknown) => {
    expect(method).toBe('space.mote.dialogue.input.submit'); calls.push({ method, params: structuredClone(params), context })
    const input = parseMoteDialogueParams('space.mote.dialogue.input.submit', params)
    const result = parseMoteDialogueResult('space.mote.dialogue.input.submit', reply(), input)
    if (process.env.MOTE_ADAPTER_FACTS) appendFileSync(process.env.MOTE_ADAPTER_FACTS, JSON.stringify({ kind: 'validated-original-Core-port', method, input, result }) + '\n')
    return result
  })
  const client = { forwardRpc: wire, connectRuntime: vi.fn(async () => {}), ensureAgentContinuity: vi.fn(), submitAgentPrompt: vi.fn(), stopAgent: vi.fn() }
  const mapped = { kind: 'agent', control: { ...control, run: { runId: 'original-resumed-run' } } }
  const sessionByTarget = vi.fn(async () => mapped)
  const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: new Map([['local', { client }]]), hostOperations: new Map(), hostReconfigurationReservations: new Set(), endpointWarnings: new Map(), sessionByTarget }) as RuntimeController
  return { runtime, client, calls, wire, sessionByTarget, mapped }
}
async function catchError(call: () => Promise<unknown>): Promise<Error & { code?: string; moteMainRollover?: MoteMainRolloverDecision }> {
  try { await call() } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error }
  throw Error('Expected an original typed result, never fabricated recovery success')
}
function callback(source: string, choose: (node: ts.Node) => ts.Expression | undefined, dependencies: Record<string, unknown>) {
  const ast = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true), found: ts.Expression[] = []
  const visit = (node: ts.Node): void => { const value = choose(node); if (value) found.push(value); ts.forEachChild(node, visit) }; visit(ast); expect(found).toHaveLength(1)
  const original = found[0]!.getText(ast)
  if (process.env.MOTE_ADAPTER_FACTS) appendFileSync(process.env.MOTE_ADAPTER_FACTS, JSON.stringify({ kind: source === ipcSource ? 'main-ipc-callback' : 'preload-callback',
    sourceSHA256: createHash('sha256').update(source).digest('hex'), callbackSHA256: createHash('sha256').update(original).digest('hex'), callbackText: original }) + '\n')
  const code = ts.transpileModule('const callback = ' + original, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(dependencies), code + ';return callback')(...Object.values(dependencies)) as (...args: any[]) => any
}
function bridge(runtime: RuntimeController, config: never = {} as never) {
  const accept = callback(ipcSource, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleWithEvent' &&
    node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'sessions:recover' ? node.arguments[1] : undefined,
  { args: { runtime }, config, sessionRecoveryOperationResult })
  const recover = callback(preloadSource, node => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'recover' ? node.initializer : undefined,
    { ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => {
      expect(channel).toBe('sessions:recover')
      const reply = structuredClone(await accept({}, ...structuredClone(args)))
      if (process.env.MOTE_ADAPTER_FACTS) appendFileSync(process.env.MOTE_ADAPTER_FACTS, JSON.stringify({ kind: 'recovery-ipc-reply', ok: reply.ok,
        ...(reply.ok ? { resultKind: reply.value.kind } : { reply: reply.reply, code: reply.error.code, decision: reply.error.moteMainRollover }) }) + '\n')
      return reply
    } } })
  return createRendererSessionRecovery(recover)
}

it('actual Main recovery hands the validated new Query decision off with its original key and recovery operation', async () => {
  const f = fixture(), error = await catchError(() => f.runtime.recoverSession(control, {} as never, undefined, recoveryId, request))
  expect(error.code).toBe('MOTE_MAIN_ROLLOVER_REQUIRED'); expect(error.moteMainRollover).toEqual(decision)
  expect(originalMoteRollover(error, entry, control)).toEqual(decision)
  expect(f.calls).toEqual([{ method: 'space.mote.dialogue.input.submit', params: { ...request.moteMain, recovery: { operationId: recoveryId }, input: {
    agentSessionId: control.agentSessionId, operationId: queryId, prompt: request.input.prompt, expectedRun: control.run, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate',
    sourceChannel: 'message-tool', capturedContext: { reference: request.input.inputContextCapture, agentMuxNote: request.input.agentMuxNote } } }, context: { transport: 'unix' } }])
  expect(f.sessionByTarget).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.client.submitAgentPrompt).not.toHaveBeenCalled(); expect(f.client.stopAgent).not.toHaveBeenCalled()
  expect((f.runtime as any).hostOperations.size).toBe(0)
})

it('registered recovery IPC and preload preserve the same typed handoff for the real rollover consumer', async () => {
  const f = fixture(), error = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, structuredClone(request)))
  expect(error.code).toBe('MOTE_MAIN_ROLLOVER_REQUIRED'); expect(error.moteMainRollover).toEqual(decision)
  expect(isSessionRecoveryReplyUnconfirmed(error)).toBe(false)
  expect(originalMoteRollover(error, entry, control)).toEqual(decision)
  for (const changed of [{ ...entry, operationId: 'an-old-question' }, { ...entry, moteMain: { ...entry.moteMain!, expectedRoleRevision: 'later-role' } }])
    expect(originalMoteRollover(error, changed, control)).toBeNull()
  expect(f.wire).toHaveBeenCalledOnce(); expect(f.sessionByTarget).not.toHaveBeenCalled()
})

it('the received recovery serializer keeps the already-working send carrier without fabricating a resume', async () => {
  const f = fixture(), failure = await catchError(() => f.runtime.submitPrompt(control, request.input.prompt, queryId,
    { expectedRun: control.run, admissionIntent: { kind: 'manual-actor' } }, undefined, { moteMain: request.moteMain }, true))
  const envelope = await sessionRecoveryOperationResult(async () => { throw failure })
  expect(envelope.ok).toBe(false)
  if (envelope.ok) throw Error('Expected a received policy handoff')
  expect(envelope.reply).toBe('received'); expect(envelope.error).toMatchObject({ code: 'MOTE_MAIN_ROLLOVER_REQUIRED', moteMainRollover: decision })
  const decoded = await catchError(() => createRendererSessionRecovery(async () => structuredClone(envelope))(control, undefined, recoveryId, request))
  expect(originalMoteRollover(decoded, entry, control)).toEqual(decision)
})

it.each([null, { kind: 'pending', reason: 'operation-unconfirmed', operationId: 'old-unknown-recovery' }])('non-due original recovery %j stays unconfirmed without a policy carrier', async recovery => {
  const f = fixture(() => ({ route: null, record: null, input: null }))
  // This port models the unchanged Core refusal/unknown receipt, not a new due.
  f.wire.mockImplementation(async (_method, params) => { f.calls.push(structuredClone(params)); return { route: null, record: null, input: null, recovery } as never })
  const error = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, request))
  expect(error.code).toBe('MOTE_MAIN_INPUT_UNCONFIRMED'); expect(error.moteMainRollover).toBeUndefined(); expect(originalMoteRollover(error, entry, control)).toBeNull()
  expect(f.sessionByTarget).not.toHaveBeenCalled(); expect(f.wire).toHaveBeenCalledOnce()
})

it('an ordinary resumed receipt still projects only its exact original new Run', async () => {
  const f = fixture()
  f.wire.mockResolvedValue({ route: null, record: null, input: null, recovery: { kind: 'resumed', newRun: { runId: 'original-resumed-run' } } } as never)
  expect(await bridge(f.runtime)(control, undefined, recoveryId, request)).toEqual({ kind: 'resumed', session: f.mapped })
  expect(f.sessionByTarget).toHaveBeenCalledExactlyOnceWith(f.client, { kind: 'agent-session', agentSessionId: control.agentSessionId }, {})
  f.sessionByTarget.mockResolvedValue({ ...f.mapped, control: { ...control, run: { runId: 'another-run' } } })
  const changed = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, request)); expect(changed.code).toBe('STALE_AGENT_SESSION')
})

it('wrong original Query or Run in a purported Core decision cannot cross the validated transport as a handoff', async () => {
  const variants = [
    { ...decision, queryInputKey: { ...decision.queryInputKey!, expectedRun: { runId: 'another-run' } } },
    { ...decision, expectedRoleRevision: 'another-role' },
    { ...decision, queryOperationId: 'another-question' },
    { ...decision, target: { ...target, spaceId: 'another-mote' } }
  ]
  for (const value of variants) {
    const f = fixture(() => ({ ...due(), rollover: { ...due().rollover, decision: value } }))
    const error = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, request))
    expect(error.code).toBe('CONTROL_PROTOCOL_ERROR'); expect(originalMoteRollover(error, entry, control)).toBeNull(); expect(f.sessionByTarget).not.toHaveBeenCalled()
  }
})

it('an actual lost Core RPC reply remains original-operation unknown through the delivered recovery IPC envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mote-recovery-adapter-')), path = join(root, 'c.sock')
  if (process.env.MOTE_ADAPTER_FACTS) await appendFile(process.env.MOTE_ADAPTER_FACTS, JSON.stringify({ root }) + '\n')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const server = createServer(socket => socket.once('data', () => socket.destroy())); server.listen(path); await once(server, 'listening')
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const f = fixture(); f.wire.mockImplementation(async (method, params) => await rpc.call(method as never, params as never))
  const error = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, request))
  expect(isSessionRecoveryReplyUnconfirmed(error)).toBe(true); expect(error.code).toBe('SESSION_RECOVERY_REPLY_UNCONFIRMED')
  expect(error.moteMainRollover).toBeUndefined(); expect(originalMoteRollover(error, entry, control)).toBeNull()
  expect(f.wire).toHaveBeenCalledOnce(); expect(f.sessionByTarget).not.toHaveBeenCalled()
})

it('a received error code or prose alone never invents the original decision carrier', async () => {
  const f = fixture()
  f.wire.mockRejectedValue(Object.assign(new Error('MOTE_MAIN_ROLLOVER_REQUIRED: an observation is not a decision'), { code: 'MOTE_MAIN_ROLLOVER_REQUIRED' }))
  const error = await catchError(() => bridge(f.runtime)(control, undefined, recoveryId, request))
  expect(error.code).toBe('MOTE_MAIN_ROLLOVER_REQUIRED'); expect(isSessionRecoveryReplyUnconfirmed(error)).toBe(false)
  expect(error.moteMainRollover).toBeUndefined(); expect(originalMoteRollover(error, entry, control)).toBeNull(); expect(f.wire).toHaveBeenCalledOnce()
})
