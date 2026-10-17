import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentInputContextCaptureRecord, parseAgentInputContextCaptureRead, type AgentInputContextCaptureReader } from '../src/agent-input-context-capture.js'
import { resolveAgentInputContextCapture } from '../src/agent-input-context-capture-resolve.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'
import { parseAgentInputSubmit } from '../src/agent-input-submit.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import { decodeHostedValue } from '../src/hosted-value.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { createDesktopInputContextCaptureReader } from '../../../apps/host/src/input-context-capture-reader.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { prepareContinuityLaunchInput, bindContinuityLaunchInput } from '../src/agent-session-continuity-input.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityLaunchInput, type AgentMuxContinuityOperation } from '../src/agent-session-continuity.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const context = () => ({ kind: 'browser' as const, version: 1 as const, capturedAt: _tailFixtureEpoch(0, 0, 10),
  browser: { hostId: 'local', browserId: 'original-browser', navigationId: 'original-navigation' },
  page: { url: 'https://page.invalid/original', title: 'Original page' },
  activity: { operationId: 'browser-operation', stepSequence: 2, phase: 'running', observedAt: _tailFixtureEpoch(0, 0, 9) } })
const reference = () => ({ hostId: 'local', operationId: 'original-input' })
const original = () => ({ reference: reference(), binding: { executionHostId: 'local', agentSessionId: 'recipient', originRun: { runId: 'run-recipient' } },
  prompt: '  Exact message\r\n<amux><a2a /></amux>', agentMuxNote: 'Original note', inputContext: context() })
const intent = () => ({ reference: reference(), agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-input', prompt: original().prompt, agentMuxNote: original().agentMuxNote })
const proof = () => { const { schema: _schema, inputContext: _context, ...p } = createAgentInputContextCaptureRecord(original()); return p }
const frozen = () => ({ inputContext: context(), inputContextSource: 'host-capture' as const, inputContextCaptureProof: proof() })
const reader = () => ({ read: vi.fn(async () => ({ reference: reference(), record: createAgentInputContextCaptureRecord(original()), diskDurability: 'unconfirmed' as const })) })

it('binds stable original message and scene without publishing body, author, execution choices or grants', () => {
  const record = createAgentInputContextCaptureRecord(original())
  expect(JSON.stringify(record)).not.toContain(original().prompt)
  expect(JSON.stringify(record)).not.toContain(original().agentMuxNote)
  expect(Object.keys(record).sort()).toEqual(['binding', 'inputContext', 'intentDigest', 'reference', 'schema'])
  for (const change of [{ prompt: 'other' }, { agentMuxNote: 'other' }, { inputContext: { ...context(), capturedAt: _tailFixtureEpoch(0, 0, 11) } },
    { binding: { ...original().binding, originRun: { runId: 'other' } } }]) {
    expect(createAgentInputContextCaptureRecord({ ...original(), ...change }).intentDigest).not.toBe(record.intentDigest)
  }
  for (const field of ['condition', 'preparationRetry', 'authorHuman', 'verified', 'requestKind']) expect(() => createAgentInputContextCaptureRecord({ ...original(), [field]: true } as never)).toThrow()
  expect(() => parseAgentInputContextCaptureRead({ reference: reference(), record: { ...record, prompt: 'leak' }, diskDurability: 'confirmed' }, reference())).toThrow()
})

it('resolves only the exact original record and accepts truthful memory provenance independently of disk durability', async () => {
  const host = reader()
  expect(await resolveAgentInputContextCapture(intent(), async () => undefined, host)).toEqual({ inputContext: context(), inputContextCaptureProof: proof() })
  expect(host.read).toHaveBeenCalledOnce()
  await expect(resolveAgentInputContextCapture({ ...intent(), prompt: 'different' }, async () => undefined, host)).rejects.toMatchObject({ code: 'AGENT_INPUT_CONTEXT_CAPTURE_CONFLICT' })
  await expect(resolveAgentInputContextCapture({ ...intent(), expectedRun: { runId: 'new' } }, async () => undefined, host)).rejects.toMatchObject({ code: 'AGENT_INPUT_CONTEXT_CAPTURE_CONFLICT' })
  await expect(resolveAgentInputContextCapture({ ...intent(), reference: { ...reference(), hostId: 'remote' } }, async () => undefined, host)).rejects.toMatchObject({ code: 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED' })
})

it('reads saved provenance before Main and again after its await, without changing original operation identity', async () => {
  const host = reader()
  expect(await resolveAgentInputContextCapture(intent(), async () => frozen(), { read: async () => { throw new Error('Main is offline') } })).toEqual({ inputContext: context(), inputContextCaptureProof: proof() })
  const reads = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(frozen())
  host.read.mockResolvedValue({ reference: reference(), record: null, diskDurability: 'unconfirmed' })
  expect(await resolveAgentInputContextCapture(intent(), reads, host)).toEqual({ inputContext: context(), inputContextCaptureProof: proof() })
  expect(reads).toHaveBeenCalledTimes(2)
  await expect(resolveAgentInputContextCapture(intent(), async () => ({ inputContext: context(), inputContextSource: 'caller-declared' }), host)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
})

it('cancels only the read and never holds the ordinary input transaction while Main is pending', async () => {
  const controller = new AbortController(), host: AgentInputContextCaptureReader = { read: async () => new Promise(() => {}) }
  const waiting = resolveAgentInputContextCapture(intent(), async () => undefined, host, controller.signal)
  controller.abort(new Error('Reader detached'))
  await expect(waiting).rejects.toThrow('Reader detached')
})

it('keeps capture origin separate from a new continuity carrier and binds only the actual new Run input key', async () => {
  const operation: AgentMuxContinuityOperation = { operationId: 'recovery-operation', agentSessionId: 'recipient',
    trigger: 'input', previousRun: original().binding.originRun, policy: DEFAULT_AGENT_CONTINUITY_POLICY,
    admittedAt: _tailFixtureEpoch(0, 0, 10), observedAt: _tailFixtureEpoch(0, 0, 10), rechecks: 0, kind: 'pending', reason: 'runtime-unverified',
    evidence: { kind: 'run-unknown', observedAt: _tailFixtureEpoch(0, 0, 10), message: 'Original Run requires recovery' } }
  const input = { submissionId: reference().operationId, prompt: original().prompt, agentMuxNote: original().agentMuxNote, inputContextCapture: reference() }
  const captured = { inputContext: context(), inputContextCaptureProof: proof() }
  operation.launchInput = prepareContinuityLaunchInput(operation, new AgentProviderRegistry().get('codex').catalog, 'original-launch', input, 'host-capture', captured)
  expect(operation.launchInput?.input).toEqual(input)
  expect(operation.launchInput?.message).toMatchObject(frozen())
  expect(operation.launchInput?.key).toBeUndefined()
  bindContinuityLaunchInput(operation, { runId: 'actual-new-run' })
  const restored = normalizeAgentContinuityLaunchInput(JSON.parse(JSON.stringify(operation.launchInput)))
  expect(restored.key?.expectedRun).toEqual({ runId: 'actual-new-run' })
  expect(restored.message.inputContextCaptureProof?.binding.originRun).toEqual({ runId: 'run-recipient' })
  expect(restored.input.inputContextCapture).toEqual(reference())
  expect(restored.prompt.endsWith(original().prompt)).toBe(true)
  expect(parseAgentMuxMessagePrefix(restored.prompt)?.declaredContexts?.find(item => item.inputContext)?.inputContext).toEqual(context())
  expect(restored.message.systemContext).not.toContain(context().page.url)
})

it('freezes a trusted capture through the actual prompt journal; retry and rejoin reuse it with Main offline', async () => {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const host = reader(), input = { agentSessionId: 'recipient', operationId: 'original-input', expectedRun: { runId: 'run-recipient' },
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const,
    prompt: original().prompt, agentMuxNote: original().agentMuxNote, inputContextCapture: reference(), authorHuman: true }
  const receipt = await h.client.submitAgentPrompt(input, { captureReader: host })
  if (!receipt) throw new Error('Missing original waiting receipt')
  expect(receipt.status).toBe('waiting')
  host.read.mockRejectedValue(new Error('Main is offline'))
  // Controlled waiting retains its existing rule against preparation fences.
  await expect(h.client.submitAgentPrompt({ ...input, preparationRetry: { inputByte: 0, nativeSourceId: 'original-native' } }, { captureReader: host })).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
  await expect(h.client.submitAgentPrompt(input, { captureReader: host })).resolves.toMatchObject({ key: receipt.key })
  await h.client.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'original-stop' })
  await h.client.rejoinAgentInputWaiting({ ref: receipt.ref })
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(page.items[0]).toMatchObject({ kind: 'item', item: { intent: { source: { ...frozen(), authorHuman: true,
    promptWire: composeAgentPrompt(original().prompt, original().agentMuxNote, context()).text } } } })
  expect(host.read).toHaveBeenCalledOnce()
  await expect(h.client.submitAgentPrompt({ ...input, prompt: 'changed' }, { captureReader: host })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('publishes only the original read projection to an authenticated exact recipient and keeps public submit declared', async () => {
  const h = await rpcOwnerFixture(['recipient', 'another']); closes.push(h.close)
  const host = reader(), service = new AgentMuxRpcService({ coreClients: h.coreClients, inputContextCaptures: host })
  const result = await service.call('browser.input.inspect', reference(), { principal: { kind: 'user', id: 'local-user' } })
  expect(parseRpcNativeResult('browser.input.inspect', result, reference())).toEqual(result)
  await expect(service.call('browser.input.inspect', reference(), { caller: h.credentials })).resolves.toEqual(result)
  await expect(service.call('browser.input.inspect', reference(), {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('browser.input.inspect', { ...reference(), verified: true } as never, { caller: h.credentials })).rejects.toBeDefined()
  const foreign = createAgentInputContextCaptureRecord({ ...original(), binding: { ...original().binding, agentSessionId: 'another' } })
  host.read.mockResolvedValue({ reference: reference(), record: foreign, diskDurability: 'unconfirmed' })
  await expect(service.call('browser.input.inspect', reference(), { caller: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  for (const field of ['inputContextCapture', 'inputContextCaptureProof', 'inputContextSource']) expect(() => parseAgentInputSubmit({ agentSessionId: 'recipient', operationId: 'original-input', expectedRun: { runId: 'run-recipient' }, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: original().prompt, [field]: reference() })).toThrow()
})

it('passes only the Host-installed reader through Hosted prompt invocation and rejects wire producer context', async () => {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const host = reader(), service = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client), undefined, undefined, host)
  closes.unshift(() => service.dispose())
  const input = { agentSessionId: 'recipient', operationId: 'original-input', expectedRun: { runId: 'run-recipient' },
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, prompt: original().prompt, agentMuxNote: original().agentMuxNote, inputContextCapture: reference() }
  const call = (args: unknown[]) => service.call('runtime.invoke', { fence: hostedTestFence, consumerId: 'original-consumer', invocation: { method: 'submitAgentPrompt', args } })
  const result = await call([input]) as { value: unknown }
  expect(decodeHostedValue(result.value)).toMatchObject({ status: 'waiting' })
  expect(host.read).toHaveBeenCalledOnce()
  await expect(call([input, { inputContextSource: 'host-capture' }])).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(call([{ ...input, inputContextCaptureProof: proof() }])).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
})

it('consumes the public owner through the real local Host adapter and compiled CLI without exposing message bodies', async () => {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  const host = reader(), path = join(h.root, 'capture.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, inputContextCaptures: host })
  await server.start(); closes.unshift(() => server.stop())
  const adapter = createDesktopInputContextCaptureReader({ desktopSocketPath: path, captureHostId: 'local', executionHostId: 'local' })
  const read = await adapter.read(reference())
  expect(read.record).toEqual(createAgentInputContextCaptureRecord(original()))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const cli = await promisify(execFile)(process.execPath, [new URL('../bin/amux', import.meta.url).pathname, '--endpoint', `unix://${path}`, 'browser', 'input', 'inspect', '--host-id', 'local', '--operation-id', 'original-input'], { env })
  expect(JSON.parse(cli.stdout).result).toEqual(read)
  expect(cli.stdout).not.toContain(original().prompt)
  expect(cli.stdout).not.toContain(original().agentMuxNote)
  const foreign = createDesktopInputContextCaptureReader({ desktopSocketPath: path, captureHostId: 'remote', executionHostId: 'local' })
  await expect(foreign.read({ ...reference(), hostId: 'remote' })).rejects.toMatchObject({ code: 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED' })
})

it('bounds a stalled live capture owner read without stopping its original publication or ordinary input', async () => {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  const path = join(h.root, 'capture.sock'), requested = vi.fn(), server = new AgentMuxControlServer({ socketPath: path,
    coreClients: h.coreClients, inputContextCaptures: { read: async () => { requested(); return new Promise(() => {}) } } })
  await server.start(); closes.unshift(() => server.stop())
  const adapter = createDesktopInputContextCaptureReader({ desktopSocketPath: path, captureHostId: 'local', executionHostId: 'local' })
  await expect(resolveAgentInputContextCapture(intent(), async () => undefined, adapter)).rejects.toMatchObject({ code: 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED' })
  expect(requested).toHaveBeenCalledOnce()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  const service = new AgentMuxRpcService({ coreClients: h.coreClients })
  await expect(service.call('agent.input.inspect', { key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'ordinary-input' } }, { principal: { kind: 'user', id: 'local-user' } })).resolves.toMatchObject({ record: null })
})
