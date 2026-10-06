import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { join } from 'node:path'
import { rename, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxControlServer as ControlServer } from '../src/public-rpc-server.js'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import type { AgentMuxHostedRuntimeService as HostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '../src/public-rpc.js'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

// Native import of the one compiled package: mixed src/dist or Vitest/native
// owners have separate journal locks and cannot prove the actual input path.
const core = await import(/* @vite-ignore */ new URL('../dist/index.js', import.meta.url).href) as typeof import('../src/index.js')
const { AgentMuxControlServer } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-server.js', import.meta.url).href) as typeof import('../src/public-rpc-server.js')
const { connectAgentMuxRpc } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-client.js', import.meta.url).href) as typeof import('../src/public-rpc-client.js')
const { AgentMuxHostedRuntimeService } = await import(/* @vite-ignore */ new URL('../dist/hosted-runtime-service.js', import.meta.url).href) as typeof import('../src/hosted-runtime-service.js')
const { connectHostedAgentMux } = await import(/* @vite-ignore */ new URL('../dist/hosted-client.js', import.meta.url).href) as typeof import('../src/hosted-client.js')
const { DurableAgentMuxMessageQueue } = core

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function owner() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'stranger'], core)
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'run-fence-native', protocolVersion: 1, buildIdentity: 'private' })
  const phase = h.inner.kernel.input as ReturnType<typeof vi.fn>
  const provider = (h.client as any).providers.get('codex')
  vi.spyOn(provider, 'planPromptInput').mockImplementation((text: string) => ({ kind: 'single-phase', data: text + '\r' }))
  const path = join(h.root, 'owner.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix://' + path, ...args], env)
  return { ...h, path, server, rpc, cli, phase, queue: new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()),
    close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}
const send: AgentMuxRpcParams<'agent.send'> = { target: { kind: 'agent-session', agentSessionId: 'recipient' },
  text: 'Frozen delegation body\n原文', operationId: 'original-send-operation', messageId: 'original-send-message',
  sourceChannel: 'cli', execution: 'immediate', expectedRun: { runId: 'run-recipient' } }
function sendArgs(operationId = send.operationId, runId = 'run-recipient') {
  return ['agent', 'send', '--to-session', 'recipient', '--text', send.text, '--message-id', send.messageId!,
    '--operation-id', operationId, '--execution', 'immediate', '--expect-run', runId]
}
function intake(operationId = 'saved-before-input', runId: string | null = 'run-recipient'): AgentMuxMessageAppendInput {
  return { messageId: operationId + '-message', operationId, createdAt: reshapeFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: runId,
    threadId: operationId + '-thread', correlationId: operationId + '-correlation', replyTo: null, workspaceId: null,
    body: 'Frozen preclaim input', sourceChannel: 'cli', execution: 'immediate' }
}
async function advanceRun(h: Awaited<ReturnType<typeof owner>>, agentSessionId: string) {
  const previous = (await h.store.load()).find(session => session.agentSessionId === agentSessionId)!
  await h.store.compareAndSwap(previous, { ...previous, run: { runId: previous.run.runId + '-next' },
    retiredRuns: [...previous.retiredRuns, previous.run], updatedAt: previous.updatedAt + 1 })
  await h.inner.registry.load('local')
}

describe('original message Run fence and intake reading', () => {
  it('refuses a mismatched new Run before intake while the actual CLI still admits healthy input', async () => {
    const h = await owner()
    try {
      const wrong = await h.cli(sendArgs(send.operationId, 'another-run'))
      expect(wrong.code, wrong.stderr).toBe(1)
      expect(JSON.parse(wrong.stderr).error.code).toBe('MESSAGE_RECIPIENT_MISMATCH')
      expect(await h.queue.readByOperationId(send.operationId)).toBeNull()
      expect(h.phase).not.toHaveBeenCalled()
      const accepted = await h.cli(sendArgs())
      expect(accepted.code, accepted.stderr).toBe(0)
      expect(JSON.parse(accepted.stdout).result.envelope).toMatchObject({ operationId: send.operationId,
        messageId: send.messageId, recipientRunId: 'run-recipient', body: send.text })
      await vi.waitFor(() => expect(h.phase).toHaveBeenCalledOnce())
      const originalInput = await h.rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: send.operationId })
      expect(originalInput.input).toMatchObject({ status: 'terminal-confirmed' })
      // The optional fence never becomes a global readiness or other-input gate.
      await h.rpc.call('agent.send', { ...send, expectedRun: undefined, operationId: 'unfenced-healthy-input', messageId: 'unfenced-healthy-message' })
      await vi.waitFor(() => expect(h.phase).toHaveBeenCalledTimes(2))
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('checks retries against the original Run and preserves the envelope after both participants advance', async () => {
    const h = await owner()
    try {
      const first = await h.rpc.call('agent.send', send)
      await vi.waitFor(() => expect(h.phase).toHaveBeenCalledOnce())
      await advanceRun(h, 'recipient'); await advanceRun(h, 'caller')
      const cli = await h.cli(sendArgs())
      expect(cli.code, cli.stderr).toBe(0)
      expect(JSON.parse(cli.stdout).result.envelope).toEqual(first.envelope)
      const byMessage = await h.rpc.call('agent.send', { ...send, operationId: 'read-same-message-operation' })
      expect(byMessage.envelope).toEqual(first.envelope)
      await expect(h.rpc.call('agent.send', { ...send, expectedRun: { runId: 'run-recipient-next' } })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
      await expect(h.rpc.call('agent.send', { ...send, operationId: 'same-id-wrong-run', expectedRun: { runId: 'run-recipient-next' } })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
      await expect(h.rpc.call('agent.send', { ...send, text: 'changed frozen body' })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
      const read = await h.rpc.call('message.read', { operationId: send.operationId })
      expect(read.message!.envelope).toEqual(first.envelope)
      expect(await h.queue.listAfter()).toHaveLength(1)
      expect(h.phase).toHaveBeenCalledOnce()
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('reads saved intake through actual CLI, SDK and Hosted owners before any input or dispatch exists', async () => {
    const h = await owner()
    let hosted: HostedRuntimeService | undefined
    let reader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
    let wire: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    let server: ControlServer | undefined
    try {
      const original = intake(), saved = await h.queue.append(original)
      const expected = await h.queue.readByOperationId(original.operationId)
      expect(await h.rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: original.operationId })).toEqual({ record: null, input: null })
      await expect(h.rpc.call('message.dispatch.read', { sourceMessageId: saved.messageId })).rejects.toMatchObject({ code: 'DISPATCH_NOT_FOUND' })
      const cli = await h.cli(['message', 'read', '--operation-id', original.operationId])
      expect(cli.code, cli.stderr).toBe(0)
      expect(JSON.parse(cli.stdout).result).toEqual({ hostId: 'local', message: expected })
      const direct = await h.client.readMessage({ operationId: original.operationId, caller: h.credentials })
      expect(direct).toEqual(expected)
      const identity = { runtimeId: 'private-semantic-owner', ownerInstanceId: 'private-owner-epoch', protocolVersion: 2 as const,
        processId: process.pid, ctxmux: h.client.runtimeIdentity(), availability: 'connected' as const }
      hosted = new AgentMuxHostedRuntimeService(h.client, join(h.root, 'sessions.json'), () => identity)
      const path = join(h.root, 'hosted.sock')
      server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => hosted! })
      await server.start(); wire = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      reader = await connectHostedAgentMux({ rpc: wire })
      vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Native readiness observation unavailable'))
      expect(await reader.readMessage({ operationId: original.operationId })).toEqual(expected)
      expect(await h.queue.readByOperationId(original.operationId)).toEqual(expected)
      expect(h.phase).not.toHaveBeenCalled()
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await reader?.dispose(); await wire?.dispose(); await server?.stop(); hosted?.dispose(); await h.close() }
  }, 20_000)

  it('limits managed reads to original participants and trusted reads to the exact Host', async () => {
    const h = await owner()
    const others: Array<Awaited<ReturnType<typeof connectAgentMuxRpc>>> = []
    try {
      const original = intake(); await h.queue.append(original)
      const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path },
        credentials: { ...h.credentials, agentSessionId: 'stranger' } }); others.push(stranger)
      await expect(stranger.call('message.read', { operationId: original.operationId })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(h.client.readMessage({ operationId: original.operationId, caller: { ...h.credentials, agentSessionId: 'stranger' } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      const recipient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path },
        credentials: { ...h.credentials, agentSessionId: 'recipient' } }); others.push(recipient)
      expect((await recipient.call('message.read', { operationId: original.operationId })).message!.envelope.body).toBe(original.body)
      const trusted = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); others.push(trusted)
      await expect(trusted.call('message.read', { operationId: original.operationId })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect((await trusted.call('message.read', { operationId: original.operationId, hostId: 'local' })).message!.envelope.body).toBe(original.body)
      await expect(trusted.call('message.read', { operationId: original.operationId, hostId: 'unknown-host' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      await expect(h.rpc.call('message.read', { operationId: original.operationId, hostId: 'another-host' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(h.client.readMessage({ operationId: 'absent', caller: { ...h.credentials, capability: 'not-current-capability' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(h.phase).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { for (const rpc of others) await rpc.dispose(); await h.close() }
  }, 20_000)

  it('returns null only for confirmed absence and keeps a failed journal read unknown and recoverable', async () => {
    const h = await owner()
    const queuePath = h.client.agentMessageQueuePath(), backup = queuePath + '.retained-proof'
    try {
      const original = intake(); await h.queue.append(original)
      const before = await h.queue.readByOperationId(original.operationId)
      expect(await h.rpc.call('message.read', { operationId: 'confirmed-absent' })).toEqual({ hostId: 'local', message: null })
      await rename(queuePath, backup); await writeFile(queuePath, 'invalid private journal bytes')
      try {
        const cli = await h.cli(['message', 'read', '--operation-id', original.operationId])
        expect(cli.code, cli.stderr).toBe(1)
        expect(JSON.parse(cli.stderr).error.code).toBe('MESSAGE_QUEUE_UNAVAILABLE')
        expect(cli.stdout).toBe('')
      } finally { await rm(queuePath); await rename(backup, queuePath) }
      expect((await h.rpc.call('message.read', { operationId: original.operationId })).message).toEqual(before)
      const admitted = await h.cli(sendArgs())
      expect(admitted.code, admitted.stderr).toBe(0)
      await vi.waitFor(() => expect(h.phase).toHaveBeenCalledOnce()); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('keeps an uncaptured original Run unknown and rejects extra Run fields without rewriting intake', async () => {
    const h = await owner()
    try {
      const original = intake('unknown-original-run', null); await h.queue.append(original)
      const before = await h.queue.readByOperationId(original.operationId)
      await expect(h.rpc.call('agent.send', { ...send, operationId: original.operationId, messageId: original.messageId, text: original.body })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      await expect(h.rpc.call('agent.send', { ...send, expectedRun: { runId: 'run-recipient', extra: 'wrong' } as any })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect(await h.queue.readByOperationId(original.operationId)).toEqual(before)
      expect(await h.queue.listAfter()).toHaveLength(1)
      expect(h.phase).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('forwards the declared Run and original operation to the exact remote semantic owner', async () => {
    const h = await owner()
    let server: ControlServer | undefined
    let outer: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    try {
      const forwarded: Array<{ method: string; params: unknown }> = []
      const remote = new Proxy(h.client, { get(target, property) {
        if (property === 'forwardRpc') return async (method: any, params: any) => { forwarded.push({ method, params }); return h.rpc.call(method, params) }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } }) as unknown as AgentMuxRpcCorePort
      const path = join(h.root, 'outer.sock')
      server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'exact-remote', client: remote }] })
      await server.start(); outer = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
      await expect(outer.call('agent.send', { ...send, expectedRun: { runId: 'wrong-remote-run' } })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
      expect(await h.queue.readByOperationId(send.operationId)).toBeNull()
      const sent = await outer.call('agent.send', send)
      const original = await outer.call('message.read', { operationId: send.operationId })
      expect(original.hostId).toBe('exact-remote'); expect(original.message!.envelope).toEqual(sent.envelope)
      expect(forwarded).toContainEqual({ method: 'message.read', params: { operationId: send.operationId, hostId: 'local' } })
      expect(forwarded[0]).toMatchObject({ method: 'agent.send', params: { expectedRun: { runId: 'wrong-remote-run' }, operationId: send.operationId } })
      await vi.waitFor(() => expect(h.phase).toHaveBeenCalledOnce()); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await outer?.dispose(); await server?.stop(); await h.close() }
  }, 20_000)

  it('rejects a forged send receipt that moves the declared Run through the actual compiled CLI codec', async () => {
    const h = await owner(), probe = new ObjectCliProbe(() => wire)
    let wire: AgentMuxRpcResult<'agent.send'>
    try {
      const saved = await h.rpc.call('agent.send', send)
      const { inputReceipt: _input, ...message } = saved
      wire = message; await probe.start()
      const args = ['--endpoint', 'unix://' + probe.socketPath, ...sendArgs()]
      const env = objectCliEnvironment(probe.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
      const accepted = await runCompiledObjectCli(args, env)
      expect(accepted.code, accepted.stderr).toBe(0)
      wire = { ...message, envelope: { ...message.envelope, recipientRunId: 'forged-run' },
        admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'forged-run' } } }
      const refused = await runCompiledObjectCli(args, env)
      expect(refused.code, refused.stderr).toBe(1)
      expect(JSON.parse(refused.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
      expect(probe.requests[0]!.params.expectedRun).toEqual({ runId: 'run-recipient' })
    } finally { await probe.stop(); await h.close() }
  }, 20_000)

  it('rejects mismatched message operation, Host and participant receipts through actual Unix decoding', async () => {
    const h = await owner()
    let wire: AgentMuxRpcResult<'message.read'>
    const probe = new ObjectCliProbe(() => wire)
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    try {
      const original = intake(); await h.queue.append(original)
      wire = await h.rpc.call('message.read', { operationId: original.operationId })
      const valid = wire
      await probe.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath }, credentials: h.credentials })
      const params = { operationId: original.operationId, hostId: 'local' }
      expect(await rpc.call('message.read', params)).toEqual(valid)
      wire = { ...valid, message: { ...valid.message!, envelope: { ...valid.message!.envelope, operationId: 'another-operation' } } }
      await expect(rpc.call('message.read', params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      wire = { ...valid, hostId: 'another-host' }
      await expect(rpc.call('message.read', params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      wire = { ...valid, message: { ...valid.message!, envelope: { ...valid.message!.envelope,
        senderSessionId: 'stranger', sender: { kind: 'agent-session', agentSessionId: 'stranger' } } } }
      await expect(rpc.call('message.read', params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    } finally { await rpc?.dispose(); await probe.stop(); await h.close() }
  }, 20_000)

  it('discovers the optional Run fence and original intake read in actual offline command help', async () => {
    const h = await owner()
    try {
      const sendHelp = await h.cli(['agent', 'send', '--help']), readHelp = await h.cli(['message', 'read', '--help'])
      expect(sendHelp.code, sendHelp.stderr).toBe(0); expect(readHelp.code, readHelp.stderr).toBe(0)
      expect(sendHelp.stdout).toContain('--expect-run'); expect(sendHelp.stdout).toContain('original message Run')
      expect(readHelp.stdout).toContain('--operation-id'); expect(readHelp.stdout).toContain('null means')
      expect(h.phase).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('saves a system-only future note through the original SDK without fabricating a human author', async () => {
    const h = await owner()
    try {
      const base = { agentSessionId: 'recipient', intentId: 'original-goal-notice', operationId: 'original-goal-notice-operation', active: true }
      const note = 'Original Goal has an actual worker report to collect.'
      await h.client.saveAgentFuturePromptIntent({ ...base, prompt: '', agentMuxNote: note })
      const reopened = new core.AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json'))
      const recipient = (await reopened.load()).find(session => session.agentSessionId === 'recipient')!
      const saved = recipient.futurePromptIntents![base.intentId]!
      expect(saved).toMatchObject({ operationId: base.operationId, active: true,
        prompt: '<amux from="amux">\n' + note + '\n</amux>', message: { systemContext: note } })
      expect(saved.message).not.toHaveProperty('userContent')
      expect(saved.message).not.toHaveProperty('authorHuman')
      expect(saved.message).not.toHaveProperty('authorAgentSessionId')
      await h.client.saveAgentFuturePromptIntent({ ...base, prompt: '', agentMuxNote: note })
      await expect(h.client.saveAgentFuturePromptIntent({ ...base, prompt: '', agentMuxNote: 'Changed source note' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      await h.client.saveAgentFuturePromptIntent({ ...base, intentId: 'plain-source-prompt', operationId: 'plain-source-operation', prompt: '  Exact original text\n' })
      const plain = await h.client.readAgentFuturePromptIntent('recipient', 'plain-source-prompt')
      expect(plain!.prompt).toBe('  Exact original text\n')
      expect(plain!.message).toEqual({ userContent: '  Exact original text\n' })
      await expect(h.client.saveAgentFuturePromptIntent({ ...base, intentId: 'empty-source', operationId: 'empty-source-operation', prompt: '', agentMuxNote: '  \n' })).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
      await expect(h.client.saveAgentFuturePromptIntent({ ...base, intentId: 'empty-source', operationId: 'empty-source-operation', prompt: '  \n' })).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
      expect(await h.client.readAgentFuturePromptIntent('recipient', 'empty-source')).toBeNull()
      // The original conditional Future path consumes the same source segments;
      // this is actual Core admission over a declared single-phase test transport.
      const previous = (await h.store.load()).find(session => session.agentSessionId === 'recipient')!
      await h.store.compareAndSwap(previous, { ...previous, semanticStatus: {
        state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 100), stateEnteredAt: reshapeFixtureEpoch(0, 0, 100) }, updatedAt: previous.updatedAt + 1 })
      await h.inner.registry.load('local')
      const provider = (h.client as any).providers.get('codex')
      vi.spyOn(provider, 'planPromptInput').mockImplementation((text: string) => ({ kind: 'single-phase', data: text + '\r' }))
      const writes: string[] = []; let cursor = 0
      const acknowledged = new Map<string, { run: ReturnType<typeof h.run>; appliedByteRange: { startByte: number; endByte: number } }>()
      h.inner.kernel.input = async (runId: string, input: { operationId: string; data: string; expectedByte: number }) => {
        const key = runId + ':' + input.operationId, previous = acknowledged.get(key)
        if (previous) return previous
        writes.push(input.data); cursor = input.expectedByte + Buffer.byteLength(input.data)
        const receipt = { run: { ...h.run(runId), acceptedInputBytes: cursor }, appliedByteRange: { startByte: input.expectedByte, endByte: cursor } }
        acknowledged.set(key, receipt); return receipt
      }
      h.inner.kernel.status = async (runId: string) => ({ ...h.run(runId), acceptedInputBytes: cursor })
      const future = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null,
        operationId: 'original-goal-note-occurrence', prompt: '', agentMuxNote: note, expectedInputByte: 0,
        expectedFutureIntent: { intentId: base.intentId, occurrenceAt: reshapeFixtureEpoch(0, 0, 1000) } }
      await h.client.submitAgentPrompt(future)
      expect(writes).toEqual([saved.prompt + '\r'])
      expect(h.client.agentSession('recipient').promptCompletionAdmission!.intent!.message).toEqual(saved.message)
      await h.client.submitAgentPrompt(future)
      expect(writes).toHaveLength(1)
      expect(h.phase).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
