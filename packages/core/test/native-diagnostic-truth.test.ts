import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const text = 'Original caller body 原文\nKeep {"cancel":true,"saved":true} opaque.'
function assertDiagnostic(error: AgentMuxError & { cause?: unknown }) {
  expect(error.code).toBe('AGENT_NATIVE_INPUT_WAITING')
  expect(error.message).toContain('observation has ended before dispatch')
  expect(error.message).not.toMatch(/message is retained|waiting can be cancelled|durably saved/i)
  const detail = JSON.parse(error.detail!)
  expect(detail).not.toHaveProperty('cancellable')
  if (detail.cause?.detail) expect(JSON.parse(detail.cause.detail)).not.toHaveProperty('cancellable')
  let cause = error.cause, depth = 0
  while (cause && typeof cause === 'object' && depth++ < 8) {
    const original = cause as Error & { code?: string; cause?: unknown }
    if (original.code === 'AGENT_NATIVE_INPUT_WAITING') {
      expect(original.message).toContain('observation has ended before dispatch')
      expect(original.message).not.toMatch(/message is retained|waiting can be cancelled|durably saved/i)
    }
    cause = original.cause
  }
  expect(depth).toBeLessThan(8)
}

describe('Native preparation diagnostic truth through original Core SDK', () => {
  it('does not announce cancellable or saved intent for an unsupported Native preparation request', async () => {
    const h = await rpcOwnerFixture()
    try {
      const input = { agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')), operationId: 'sdk-unsupported-preparation',
        prompt: text, execution: 'immediate' as const, authorHuman: true, preparationRetry: { inputByte: 0, nativeSourceId: 'original-source' } }
      const error = await h.client.submitAgentPrompt(input).then(() => undefined, e => e)
      expect(error.code).toBe('AGENT_NATIVE_INPUT_WAITING')
      expect(error.message).toContain('attempt has ended before dispatch')
      expect(JSON.parse(error.detail)).toEqual({ phase: 'native-intent', reason: 'automatic-admission-unavailable' })
      expect(await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter(0)).toEqual([])
      expect(input.prompt).toBe(text)
      expect((await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')?.promptCompletionAdmission).toBeUndefined()
    } finally { await h.close() }
  })
  it.each(['missing-target', 'not-a-socket'] as const)('does not announce SDK durable save/cancel with %s', async mode => {
    const h = await rpcOwnerFixture(), writes: string[] = []
    h.inner.kernel.identity = () => ({ daemonInstanceId: 'private-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
    h.inner.kernel.input = async (id: string, operation: { expectedByte: number; data: string }) => {
      writes.push(operation.data)
      return { run: { ...h.run(id), acceptedInputBytes: Buffer.byteLength(operation.data) }, appliedByteRange: { startByte: 0, endByte: Buffer.byteLength(operation.data) } }
    }
    if (mode === 'not-a-socket') {
      const path = join(h.root, 'private-regular-file'); await writeFile(path, 'Original private regular file, not a Native actor.')
      const stored = (await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')!
      await h.store.compareAndSwap(stored, { ...stored, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'private-thread', transcriptPath: path } })
      await h.inner.registry.load('local')
      h.inner.kernel.status = async (id: string) => ({ ...h.run(id), pid: process.pid, args: ['--remote', 'unix://' + path] })
    }
    const input = { agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')), operationId: 'sdk-' + mode,
      prompt: text, agentMuxNote: 'Original platform note.', execution: 'immediate' as const, authorHuman: true }
    try {
      const error = await h.client.submitAgentPrompt(input).then(() => undefined, e => e)
      expect(error).toMatchObject({ code: 'AGENT_NATIVE_INPUT_WAITING' }); assertDiagnostic(error)
      expect(JSON.parse(error.detail).preclaimObservation.phase).toBe(mode === 'missing-target' ? 'native-target' : 'native-peer')
      expect(await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter(0)).toEqual([])
      expect((await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')?.promptCompletionAdmission).toBeUndefined()
      expect(input.prompt).toBe(text); expect(input.agentMuxNote).toBe('Original platform note.'); expect(writes).toEqual([])
      await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: h.client.agentSession('recipient').run, data: 'raw-kept', source: 'user' })
      expect(writes).toEqual(['raw-kept']); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps the real preclaim SDK Abort limited to the observer and original caller input', async () => {
    const h = await rpcOwnerFixture(), controller = new AbortController()
    const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
    const nativeProvider = provider as typeof provider & Required<Pick<typeof provider, 'prepareNativePromptInput'>>
    const prepare = vi.spyOn(nativeProvider, 'prepareNativePromptInput').mockImplementation(async context => {
      entered(); await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
      throw new Error('The controlled observation cannot dispatch.')
    })
    try {
      const input = { agentSessionId: 'recipient', ...agentPromptCondition(h.client.agentSession('recipient')), operationId: 'sdk-observation-abort', prompt: text,
        execution: 'immediate' as const, authorHuman: true, signal: controller.signal }
      const pending = h.client.submitAgentPrompt(input).then(() => undefined, e => e)
      await started; controller.abort(new AgentMuxError('Controlled original observer abort.', 'FIXTURE_OBSERVATION_ABORT'))
      const error = await pending; assertDiagnostic(error)
      expect(JSON.parse(error.detail).reason).toBe('observation-cancelled')
      expect(prepare).toHaveBeenCalledOnce(); expect(input.prompt).toBe(text)
      expect((await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')?.promptCompletionAdmission).toBeUndefined()
      expect(await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter(0)).toEqual([])
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { prepare.mockRestore(); await h.close() }
  })

  it('leaves the actual A2A body in its original journal without turning diagnostics into cancel authority', async () => {
    const h = await rpcOwnerFixture()
    const envelope = { schema: 'agentmux.a2a.v1' as const, messageId: 'original-a2a-message', operationId: 'original-a2a-control', createdAt: reshapeFixtureEpoch(0, 0, 1),
      threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, sender: { kind: 'agent-session' as const, agentSessionId: 'caller' },
      recipient: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, senderSessionId: 'caller', senderRunId: 'run-caller',
      recipientSessionId: 'recipient', recipientRunId: 'run-recipient', body: text }
    try {
      const error = await h.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition: agentPromptCondition(h.client.agentSession('recipient')),
        caller: h.credentials, execution: 'immediate' }).then(() => undefined, e => e)
      assertDiagnostic(error)
      const saved = await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter(0)
      expect(saved).toHaveLength(1); expect(saved[0]!.envelope).toMatchObject(envelope); expect(saved[0]!.delivery.state).toBe('queued')
      expect((await loadAgentSessions(h.store)).find(s => s.agentSessionId === 'recipient')?.promptCompletionAdmission).toBeUndefined()
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
