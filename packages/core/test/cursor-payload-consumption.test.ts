import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxError } from '../src/errors.js'
import { captureExecutorInvocation } from '../src/agent-executor-invocation.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { cursorPromptPayloadConsumption } from '../src/providers/cursor-payload-consumption.js'
import { qualifyCursorPayloadProtocol } from '../src/providers/cursor-payload-protocol.js'
import { resolveCursorStorePath } from '../src/providers/cursor-history.js'
import { normalizePromptInputPlan } from '../src/prompt-submission-record.js'
import { parseAgentInputHandoff } from '../src/agent-input-handoff.js'
import { agentPromptSubmissionOutcome } from '../src/agent-input-wait.js'

// Only the current native process witness is controlled. Original physical source
// resolution, JSON data, Provider contribution, public Core/Store/journal and
// frozen Runtime input claims are production consumers.
vi.mock('../src/providers/cursor-payload-protocol.js', () => ({ qualifyCursorPayloadProtocol: vi.fn(async (context: { command: string; args: string[] }) => { expect(context.command).toBe('cursor-agent'); expect(context.args).toEqual(['--model', 'auto']); return 'original-qualified-native-protocol' }) }))
vi.mock('../src/agent-native-process.js', async importOriginal => ({ ...await importOriginal<object>(), nativeProcessBirth: vi.fn(async () => 'original-process-birth') }))
vi.mock('../src/providers/cursor-native-session.js', async importOriginal => ({ ...await importOriginal<object>(),
  discoverCursorNativeSession: vi.fn(async (context: { workspacePath: string; env?: Record<string, string> }) => {
    const path = await resolveCursorStorePath(context.workspacePath, nativeId, context.env)
    return { handle: { kind: 'provider', providerId: 'cursor', sessionId: nativeId, transcriptPath: path }, assertCurrent: async () => {} }
  }) }))
const nativeId = '019ff166-9788-4ace-b9eb-9a71a42f0af9'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(qualifyCursorPayloadProtocol).mockReset().mockImplementation(async context => { expect(context.command).toBe('cursor-agent'); expect(context.args).toEqual(['--model', 'auto']); return 'original-qualified-native-protocol' }) })

async function fixture() {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'cursor', executorId: 'cursor' }))
  const configRoot = join(f.root, 'private-config'), env = { CURSOR_CONFIG_DIR: configRoot }
  vi.stubEnv('CURSOR_CONFIG_DIR', join(f.root, 'unrelated-current-profile'))
  const path = await resolveCursorStorePath(f.root, nativeId, env), pastePath = join(dirname(path), 'pasted_text.json')
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'private native file identity')
  const initial = (await f.store.readMetadata('recipient'))!
  const original = captureExecutorInvocation('cursor', 'cursor', 'original-create', 'b'.repeat(64), { env })!
  await f.store.compareAndSwap(initial, { ...initial, creation: { createOperationId: 'original-create', intentDigest: 'b'.repeat(64), initialPrompt: 'not-requested', executorInvocationDigest: original.digest }, executorInvocation: original.value, nativeHandle: { kind: 'provider', providerId: 'cursor', sessionId: nativeId, transcriptPath: path },
    nativeBinding: { source: 'process-witness', run: initial.run, observedAt: initial.updatedAt + 1 }, updatedAt: initial.updatedAt + 1 })
  await f.inner.registry.load('local')
  const status = f.inner.kernel.status as (...args: unknown[]) => Promise<Record<string, unknown>>
  f.inner.kernel.status = vi.fn(async (...args: unknown[]) => ({ ...await status(...args), pid: 999, program: '/usr/bin/env', args: ['-u', 'AGENTMUX_WRAPPER_WITNESS', '--', 'cursor-agent', '--model', 'auto'] }))
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: initial.run, submissionId: id })
  const submit = (id: string, prompt = 'x'.repeat(950) + '\nSecond line') => f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: initial.run,
    operationId: id, prompt, execution: 'immediate', admissionIntent: { kind: 'session-conversation' }, authorHuman: true })
  return { ...f, path, pastePath, initial, key, submit,
    context: { command: 'cursor-agent', args: ['--model', 'auto'], processId: 999, workspacePath: f.root, env,
      nativeHandle: { kind: 'provider' as const, providerId: 'cursor', sessionId: nativeId, transcriptPath: path } },
    record: (id: string) => f.client.inspectAgentPromptSubmission(key(id)),
    stored: () => new AgentMuxFileAgentSessionStore(f.store.path).readMetadata('recipient') }
}

it.each([['long-single-line', 'a'.repeat(1900), [1024]], ['multiline-three-reads', 'a'.repeat(950) + '\n' + 'b'.repeat(950), [500, 1200]]] as const)(
  'public Core submits %s only after exact native body consumption and preserves phase receipts', async (_name, prompt, partition) => {
    const f = await fixture(); const rpc = new AgentMuxRpcService({ coreClients: f.coreClients })
    try {
      const write = f.inner.kernel.input as (id: string, input: { data: string; expectedByte: number; operationId: string }) => Promise<unknown>
      const events: string[] = []; let consumedAt = 0, submittedAt = 0, body = '', nextId = 4, nativeCallbackAt = 0, rapidCallbacks = 0, nativeSubmissions = 0
      await writeFile(f.pastePath, JSON.stringify({ entries: { 3: 'old unrelated native paste' } }))
      f.inner.kernel.input = vi.fn(async (id: string, input: { data: string; expectedByte: number; operationId: string }) => {
        const ack = await write(id, input)
        if (input.data.endsWith('\u001b[201~')) {
          events.push('payload'); body = input.data.slice(6, -6).replace(/\r\n?/g, '\n').replaceAll('\t', '  ')
          // Two distinct stdin read partitions, with no artificial delay. A submit
          // batched with these would be the real native third rapid callback.
          const cuts = [0, ...partition, input.data.length]; for (let i = 1; i < cuts.length; i++) {
            expect(input.data.slice(cuts[i-1], cuts[i])).toBeTruthy(); const now = Date.now()
            rapidCallbacks = now - nativeCallbackAt < 35 ? rapidCallbacks + 1 : 1; nativeCallbackAt = now
          }
          const pending = await f.record('original'); expect(pending?.terminalPromptSubmission?.submit.acknowledged).toBe(false)
          await writeFile(f.pastePath, JSON.stringify({ entries: { 3: 'old unrelated native paste', [nextId++]: body } })); consumedAt = Date.now(); events.push('native-body')
        } else {
          events.push('submit'); submittedAt = Date.now(); rapidCallbacks = submittedAt - nativeCallbackAt < 35 ? rapidCallbacks + 1 : 1
          if (rapidCallbacks < 3) nativeSubmissions++
          expect(input.data).toBe('\u001b[13u')
          expect(JSON.parse(await readFile(f.pastePath, 'utf8')).entries[4]).toBe(body)
        }
        return ack
      })
      await f.submit('original', prompt)
      await vi.waitFor(async () => expect((await f.record('original'))?.terminalPromptSubmission?.submit.acknowledged).toBe(true))
      const record = (await f.record('original'))!
      expect(events).toEqual(['payload', 'native-body', 'submit']); expect(nativeSubmissions).toBe(1)
      expect(submittedAt - consumedAt).toBeGreaterThanOrEqual(35)
      expect(record.admission?.intent?.plan.kind).toBe('payload-then-submit')
      expect(record.terminalPromptSubmission?.payloadConsumption).toMatchObject({ baselineId: '3', receipt: { id: '4' } })
      expect(record.terminalPromptSubmission?.payload.acknowledged).toBe(true)
      expect(record.terminalPromptSubmission?.submit.acknowledged).toBe(true)
      expect(agentPromptSubmissionOutcome(record)).toBe('terminal-confirmed')
      expect((await f.stored())?.semanticStatus?.state).not.toBe('done')
      const reading = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })
      expect(reading.session?.terminalPromptSubmission?.payloadConsumption?.receipt?.id).toBe('4')
      const stored = await f.stored(); await f.inner.registry.load('local')
      expect((await f.stored())?.terminalPromptSubmission).toEqual(stored?.terminalPromptSubmission)
    } finally { await rpc.dispose(); await f.close() }
  })

it('refuses old identical text, other text and changed original native source without inventing a receipt', async () => {
  const f = await fixture()
  try {
    const body = 'a'.repeat(801)
    await writeFile(f.pastePath, JSON.stringify({ entries: { 1: body } }))
    const original = await cursorPromptPayloadConsumption.prepare(f.context, body)
    expect(await cursorPromptPayloadConsumption.read(f.context, original, body)).toBeNull()
    await writeFile(f.pastePath, JSON.stringify({ entries: { 1: body, 2: 'b'.repeat(801) } }))
    expect(await cursorPromptPayloadConsumption.read(f.context, original, body)).toBeNull()
    await writeFile(f.pastePath, '{"entries":')
    expect(await cursorPromptPayloadConsumption.read(f.context, original, body)).toBeNull()
    await writeFile(f.pastePath, JSON.stringify({ entries: { 1: body, 2: body } }))
    expect(await cursorPromptPayloadConsumption.read(f.context, original, body)).toEqual({ receiptId: '2' })
    await rename(f.path, f.path + '.original'); await writeFile(f.path, 'another native source')
    await expect(cursorPromptPayloadConsumption.read(f.context, original, body)).rejects.toMatchObject({ code: 'AGENT_PROMPT_PAYLOAD_CONSUMPTION_UNCONFIRMED' })
  } finally { await f.close() }
})

it('keeps accepted payload and original unknown when native consumption observation fails; healthy raw TTY still works', async () => {
  const f = await fixture()
  try {
    const write = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
    f.inner.kernel.input = vi.fn(async (...args: unknown[]) => { const ack = await write(...args); await rename(f.path, f.path + '.original'); await writeFile(f.path, 'replaced source'); return ack })
    await f.submit('original')
    await vi.waitFor(async () => expect((await f.stored())?.terminalPromptDelivery?.reason).toBe('input-unconfirmed'))
    const record = (await f.record('original'))!
    expect(record.terminalPromptSubmission?.submit.acknowledged).toBe(false)
    expect(record.terminalPromptSubmission?.payload.acknowledged).toBe(true)
    expect(record.terminalPromptSubmission?.payloadConsumption?.receipt).toBeUndefined()
    expect(agentPromptSubmissionOutcome(record)).toBe('unknown')
    expect((await f.stored())?.terminalPromptDelivery?.reason).toBe('input-unconfirmed')
    expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
    await f.inner.registry.load('local'); await f.record('original'); await f.record('original')
    expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
    await expect(f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: f.initial.run, operationId: 'original', prompt: 'x'.repeat(950) + '\nSecond line', execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, authorHuman: true })).rejects.toThrow()
    expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
    await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: f.initial.run, data: 'manual-original-TTY', source: 'user' })
    expect(f.rawInput).toHaveBeenCalledTimes(1)
    await f.client.pasteAgent({ agentSessionId: 'recipient', expectedRun: f.initial.run, text: 'explicit paste'.repeat(80), terminalData: 'unselected fallback bytes' })
    expect(f.rawInput).toHaveBeenCalledTimes(2)
    expect(f.rawInput.mock.calls[1]?.[1]).toBe('\u001b[200~' + 'explicit paste'.repeat(80) + '\u001b[201~')
  } finally { await f.close() }
})

it('refuses submit after competing human input and retains the original applied prefix', async () => {
  const f = await fixture()
  try {
    const write = f.inner.kernel.input as (id: string, input: { data: string; expectedByte: number; operationId: string }) => Promise<unknown>
    let competed = false
    f.inner.kernel.input = vi.fn(async (id: string, input: { data: string; expectedByte: number; operationId: string }) => {
      if (!input.data.endsWith('\u001b[201~')) throw new AgentMuxError('Original byte cursor was occupied by human input.', 'CTXMUX_input_cursor_mismatch', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
      const ack = await write(id, input)
      await writeFile(f.pastePath, JSON.stringify({ entries: { 1: input.data.slice(6, -6) } }))
      await f.rawInput(id, 'new human bytes'); competed = true
      return ack
    })
    await f.submit('original')
    await vi.waitFor(async () => expect((await f.stored())?.terminalPromptDelivery?.reason).toBe('input-unconfirmed'))
    expect(competed).toBe(true)
    const record = (await f.record('original'))!
    expect(record.terminalPromptSubmission?.payload.acknowledged).toBe(true)
    expect(record.terminalPromptSubmission?.submit.acknowledged).toBe(false)
    expect(record.admission?.notApplied).not.toBe(true)
    expect(agentPromptSubmissionOutcome(record)).toBe('unknown')
  } finally { await f.close() }
})

it('keeps short typed plans and explicit paste healthy and validates frozen native phase protocol through public decoding', () => {
  const provider = new AgentProviderRegistry().get('cursor')
  expect(provider.planPromptInput('short\nbody').kind).toBe('single-phase')
  const plan = provider.planPromptInput('s'.repeat(801))
  expect(plan).toMatchObject({ kind: 'payload-then-submit', minimumSubmitDelayMs: 35 })
  expect(normalizePromptInputPlan(plan)).toEqual(plan)
  expect(parseAgentInputHandoff({ version: 1, storeScope: 'original', carrier: { kind: 'pty', plan } }).carrier).toEqual({ kind: 'pty', plan })
  expect(() => normalizePromptInputPlan({ ...plan, minimumSubmitDelayMs: -1 })).toThrow()
})


it('keeps unqualified protocol as a read-only preparation failure before input while retaining original input and raw TTY', async () => {
  const f = await fixture()
  try {
    vi.mocked(qualifyCursorPayloadProtocol).mockRejectedValueOnce(new AgentMuxError('Original writer protocol is unconfirmed.', 'AGENT_PROMPT_PAYLOAD_PROTOCOL_UNCONFIRMED'))
    await f.submit('unqualified-source')
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key('unqualified-source') }))?.control.waiting).toMatchObject({
      failure: { code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } }))
    expect(await f.record('unqualified-source')).toBeNull()
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
    await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: f.initial.run, data: 'explicit original terminal input', source: 'user' })
    expect(f.rawInput).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})


it('keeps an explicit current-terminal typed input on its original plain plan when optional native protocol is unknown', async () => {
  const f = await fixture()
  try {
    vi.mocked(qualifyCursorPayloadProtocol).mockClear().mockRejectedValueOnce(new AgentMuxError('Optional native protocol unknown.', 'AGENT_PROMPT_PAYLOAD_PROTOCOL_UNCONFIRMED'))
    await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: f.initial.run, operationId: 'explicit-tty', prompt: 'human current editor body'.repeat(80),
      execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, authorHuman: true })
    await vi.waitFor(async () => expect((await f.record('explicit-tty'))?.admission?.acknowledged).toBe(true))
    const record = (await f.record('explicit-tty'))!
    expect(record.admission?.intent?.plan.kind).toBe('single-phase')
    expect(record.terminalPromptSubmission).toBeUndefined()
    expect(qualifyCursorPayloadProtocol).not.toHaveBeenCalled()
    expect(agentPromptSubmissionOutcome(record)).toBe('terminal-confirmed')
  } finally { await f.close() }
})
