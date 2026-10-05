import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentHookServer } from '../src/hook-server.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxHostedTransferReader } from '../src/hosted-value.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const exec = promisify(execFile)
const sessionId = 'tool-content', nativeSessionId = 'native-tool-content'

async function fixture() {
  const h = await rpcOwnerFixture([sessionId])
  // Only the process/native identity witness is synthetic. Provider normalization,
  // authenticated ingress, registry/CAS, file persistence and public consumers are real.
  const transcriptPath = join(h.root, ...Array.from({ length: 7 }, (_, i) => `${i}-${'p'.repeat(80)}`), 'rollout.jsonl')
  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(transcriptPath, '')
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: nativeSessionId, transcriptPath }
  Reflect.get(h.client, 'hookNativeWitnesses').set(`run-${sessionId}`, { candidate: JSON.stringify(nativeSessionId), handle: nativeHandle })
  h.inner.kernel.identity = () => ({ buildIdentity: 'hook-test', protocolVersion: 1, daemonInstanceId: 'isolated-daemon' })
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  Object.defineProperty(server, 'port', { value: 0 })
  await server.start()
  const binding = server.createBinding(sessionId, 'codex'); await binding.bindRun(`run-${sessionId}`)
  const events: AgentMuxClientEvent[] = []
  h.client.onEvent(event => { events.push(event) })
  const post = (receiptId: string, toolInput: unknown, toolName = 'Bash') => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, eventName: 'PreToolUse', payload: { hook_event_name: 'PreToolUse', session_id: nativeSessionId,
      turn_id: 'native-turn', transcript_path: transcriptPath, tool_use_id: receiptId, tool_name: toolName, tool_input: toolInput } })
  })
  return { ...h, events, post, nativeHandle }
}

describe('Hook tool content through durable and public consumers', () => {
  it.each(['object', 'multiline'] as const)('retains complete %s arguments and a long path through HTTP, fresh-process storage and actual CLI', async shape => {
    const h = await fixture()
    const text = `python3 - <<'PY'\n${'# 中文 command arguments\n'.repeat(1500)}print('done')\nPY`
    const toolInput = shape === 'object' ? { command: text, description: 'complete tool input' } : text
    const expected = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
    const owner = new AgentMuxControlServer({ coreClients: h.coreClients, socketPath: join(h.root, 'owner.sock') })
    try {
      expect(Buffer.byteLength(expected)).toBeGreaterThan(32 * 1024)
      expect(Buffer.byteLength(h.nativeHandle.transcriptPath)).toBeGreaterThan(512)
      expect((await h.post(`long-${shape}`, toolInput)).status).toBe(204)
      expect((await h.post(`long-${shape}`, toolInput)).status).toBe(204)
      const stored = await h.store.load()
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ agentSessionId: sessionId, run: { runId: `run-${sessionId}` }, nativeHandle: h.nativeHandle,
        hookReceipt: { id: `long-${shape}`, toolInvocation: { toolInput: expected, nativeTranscriptPath: h.nativeHandle.transcriptPath } } })

      // Read the same durable file in another process, without reseeding or changing identity.
      const storeModule = new URL('../dist/agent-session-store.js', import.meta.url).href
      const reader = `import { AgentMuxFileAgentSessionStore, loadAgentSessions } from ${JSON.stringify(storeModule)};
        console.log(JSON.stringify(await loadAgentSessions(new AgentMuxFileAgentSessionStore(process.argv[1]))));`
      const fresh = await exec(process.execPath, ['--input-type=module', '-e', reader, h.store.path], { maxBuffer: 1024 * 1024 })
      expect(JSON.parse(fresh.stdout)).toEqual(stored)

      await owner.start()
      const env = { ...process.env }
      delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
      const cli = await exec(process.execPath, [new URL('../bin/amux', import.meta.url).pathname,
        '--endpoint', `unix:${owner.path}`, 'agent', 'inspect', '--session', sessionId], { env, maxBuffer: 1024 * 1024 })
      const result = JSON.parse(cli.stdout)
      expect(result).toMatchObject({ ok: true, operation: 'agent.inspect', result: { session: {
        agentSessionId: sessionId, run: { runId: `run-${sessionId}` }, nativeHandle: h.nativeHandle,
        hookReceipt: { toolInvocation: { toolInput: expected } }
      } } })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await owner.stop(); await h.close() }
  })

  it('preserves empty content and rejects malformed or excessive single-field data without loosening IDs', async () => {
    const h = await fixture()
    try {
      expect((await h.post('empty-input', '')).status).toBe(204)
      const original = normalizeStoredAgentSession((await h.store.load())[0])
      const invocation = original.hookReceipt!.toolInvocation!
      for (const toolInput of [42, 'x'.repeat(2 * 1024 * 1024)]) {
        expect(() => normalizeStoredAgentSession({ ...original, hookReceipt: { ...original.hookReceipt,
          toolInvocation: { ...invocation, toolInput } } })).toThrowError(expect.objectContaining({
          code: 'INVALID_AGENT_SESSION_STORE', message: 'hookReceipt.toolInvocation.toolInput is invalid.'
        }))
      }
      expect(() => normalizeStoredAgentSession({ ...original, hookReceipt: { ...original.hookReceipt,
        toolInvocation: { ...invocation, nativeToolCallId: 'x'.repeat(513) } } })).toThrowError(expect.objectContaining({
        code: 'INVALID_AGENT_SESSION_STORE', message: 'hookReceipt.toolInvocation.nativeToolCallId is invalid.'
      }))
      const boundaryPath = '/' + 'dir/'.repeat(1023) + 'end'
      expect(Buffer.byteLength(boundaryPath)).toBe(4096)
      const withPath = (nativeTranscriptPath: string) => ({ ...original, hookReceipt: { ...original.hookReceipt,
        toolInvocation: { ...invocation, nativeTranscriptPath } } })
      expect(normalizeStoredAgentSession(withPath(boundaryPath)).hookReceipt!.toolInvocation!.nativeTranscriptPath).toBe(boundaryPath)
      for (const path of ['relative/rollout.jsonl', fixturePath("tmp/rollout\u0001.jsonl"), fixturePath("tmp/rollout.jsonl"), (" " + (fixturePath("tmp/rollout.jsonl")) + " "), boundaryPath + 'x']) {
        expect(() => normalizeStoredAgentSession(withPath(path))).toThrowError(expect.objectContaining({
          code: 'INVALID_AGENT_SESSION_STORE', message: 'hookReceipt.toolInvocation.nativeTranscriptPath is invalid.'
        }))
      }
      expect(await h.store.load()).toEqual([original])
    } finally { await h.close() }
  })

  it('preserves the typed owner cause on the original HTTP receipt and RPC event while keeping raw input', async () => {
    const h = await fixture()
    const hosted = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
    const rpc = new AgentMuxRpcService({ coreClients: h.coreClients, hostedRuntime: () => hosted })
    const reader = new AgentMuxHostedTransferReader(), rpcEvents: AgentMuxClientEvent[] = []
    const subscription = await rpc.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'hook-cause-reader' }, event => {
      if (event.type !== 'snapshot') return
      const value = reader.accept(event.data) as { kind: string; event?: AgentMuxClientEvent } | undefined
      if (value?.kind === 'event' && value.event) rpcEvents.push(value.event)
    }, { principal: { kind: 'user', id: 'isolated-reviewer' } })
    await subscription.start?.()
    try {
      expect((await h.post('before-failure', { command: 'echo healthy' })).status).toBe(204)
      const original = normalizeStoredAgentSession((await h.store.load())[0])
      // Fault the real durability owner after normalization, not the Hook callback.
      const save = vi.spyOn(h.store, 'compareAndSwap').mockRejectedValue(new AgentMuxError(
        'hookReceipt.toolInvocation.toolInput is invalid.', 'INVALID_AGENT_SESSION_STORE'))
      const failure = await h.post('owner-failure', { command: 'echo still healthy' })
      expect(failure.status).toBe(503)
      const receipt = await failure.json()
      expect(receipt).toMatchObject({ error: 'INVALID_AGENT_SESSION_STORE', receiptId: 'owner-failure', stage: 'owner',
        accepted: 'unknown', message: 'hookReceipt.toolInvocation.toolInput is invalid.' })
      const again = await h.post('owner-failure', { command: 'echo still healthy' })
      expect(again.status).toBe(503); expect(await again.json()).toEqual(receipt)
      expect(save).toHaveBeenCalledTimes(1)
      const errors = () => rpcEvents.filter(e => e.type === 'agent-error' && e.code === 'INVALID_AGENT_SESSION_STORE')
      await vi.waitFor(() => expect(errors()).toHaveLength(2))
      expect(errors()).toEqual([expect.objectContaining({ agentSessionId: sessionId, message: expect.stringContaining(receipt.message),
        evidence: expect.objectContaining({ run: original.run }) }), expect.objectContaining({ message: expect.stringContaining(receipt.message) })])
      expect(await h.store.load()).toEqual([original])
      save.mockRestore()
      h.inner.kernel.input = vi.fn(async () => ({ run: h.run(original.run.runId), appliedByteRange: { startByte: 0, endByte: 1 } }))
      await expect(h.client.writeAgent({ agentSessionId: sessionId, expectedRun: original.run, source: 'user', data: 'x' }))
        .resolves.toMatchObject({ appliedByteRange: { endByte: 1 } })
      expect((await h.post('after-failure', { command: 'echo recovered' })).status).toBe(204)
      expect(h.client.agentSession(sessionId).run).toEqual(original.run)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); await subscription.dispose(); await hosted.dispose(); await h.close() }
  })

  it.each(['typed', 'untyped'] as const)('keeps arbitrary %s owner messages containing tool text or credentials out of receipts and events', async kind => {
    const h = await fixture()
    const secret = 'private-token-and-tool-body'
    try {
      const error = kind === 'typed'
        ? new AgentMuxError(`hookReceipt.toolInvocation.toolInput is invalid. ${secret}`, 'INVALID_AGENT_SESSION_STORE')
        : new Error(secret)
      vi.spyOn(h.store, 'compareAndSwap').mockRejectedValue(error)
      const response = await h.post(`unsafe-${kind}`, { command: 'echo healthy' })
      expect(response.status).toBe(503)
      const receipt = await response.json()
      expect(receipt).toMatchObject({ receiptId: `unsafe-${kind}`, stage: 'owner', accepted: 'unknown' })
      expect(receipt).not.toHaveProperty('message')
      expect(JSON.stringify(receipt)).not.toContain(secret)
      const errors = h.events.filter(event => event.type === 'agent-error')
      expect(errors).toHaveLength(1)
      expect(JSON.stringify(errors)).not.toContain(secret)
      expect(h.client.agentSession(sessionId).run).toEqual({ runId: `run-${sessionId}` })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); await h.close() }
  })
})
