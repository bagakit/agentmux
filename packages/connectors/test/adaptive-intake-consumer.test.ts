import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../../core/src/index.js'
import { channelContextFixture } from './fixtures/channel-context.js'
import { parseAgentMuxMessagePrefix } from '../../core/src/agent-message-render.js'
import { consumeJsonReadEntry, type JsonReadAssembly } from '../../core/src/json-read-fragments.js'
import type { AgentMuxMessageFieldPage, AgentMuxMessageField } from '../../core/src/agent-message-query.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const long = '前文原始内容🙂<&>\n'.repeat(1900)
const short = '  当前请求🙂\n<amux>this is user text</amux> & 保留尾空格  '

for (const channel of ['feishu', 'discord'] as const) for (const mode of ['native', 'terminal'] as const) {
  it(`${channel} ${mode}: native ingress → Hosted Core freezes short body / long quote and long body without changing the original message`, async () => {
    const f = await channelContextFixture(cleanup, mode, false, channel)
    const received = async (id: string, time: number, body: string) => {
      const ingress = await f.receive(id, time, body)
      const observed = await f.wait(ingress.ingressId, mode === 'native' ? 'admitted' : 'terminal-confirmed')
      const input = observed.ingress!.kind !== 'action' ? observed.ingress!.input! : undefined
      expect(input).toBeDefined()
      const original = (await f.rpc.call('message.read', { hostId: 'local', messageId: input!.messageId })).message!
      const wire = observed.inputReceipt!.admission!.admission!.intent!.prompt
      return { input: input!, original, wire, receipt: observed.inputReceipt!, ingress }
    }
    await f.receive('600', 600, 'original baseline', false)
    const small = await received('700', 700, short)
    expect(parseAgentMuxMessagePrefix(small.wire)).toMatchObject({ body: short, declaredChannel: { externalMessageId: '700' } })
    expect(small.original.envelope.body).toBe(short)
    expect(small.original.envelope.sender.kind).toBe('external')
    f.addHistory('750', 750, long)
    const mixed = await received('800', 800, short)
    const parsed = parseAgentMuxMessagePrefix(mixed.wire)
    expect(parsed).toMatchObject({ body: short, declaredChannel: { externalMessageId: '800' } })
    expect(parsed?.kind === 'content' && parsed.declaredChannelQuote).toBeUndefined()
    expect(mixed.wire).toContain(`--message-id '${mixed.input.messageId}' --field channelQuote`)
    expect(Buffer.byteLength(mixed.wire)).toBeLessThan(16 * 1024)
    expect(mixed.original.envelope.body).toBe(short)
    const containsOriginal = (value: unknown): boolean => {
      if (value === long) return true
      if (typeof value === 'string') { try { return containsOriginal(JSON.parse(value)) } catch { return false } }
      return !!value && typeof value === 'object' && Object.values(value).some(containsOriginal)
    }
    expect(containsOriginal(mixed.original.envelope.channelQuote)).toBe(true)
    expect(mixed.receipt.key).toMatchObject({ kind: 'message', messageId: mixed.input.messageId, expectedRun: mixed.input.expectedRun })
    const field = await f.rpc.call('message.read', { hostId: 'local', messageId: mixed.input.messageId, field: 'body', maxBytes: 4096 }, { credentials: f.credentials })
    expect(field.message).toBeNull(); expect(field.field!.entry).toEqual({ kind: 'item', item: short })
    expect(field.field!.envelope).not.toHaveProperty('channelQuote'); expect(field.field!.envelope).not.toHaveProperty('body')
    expect(field.field!.envelope).not.toHaveProperty('promptWire'); expect(field.field!.envelope).not.toHaveProperty('channelProfile')
    const beforeRead = await f.rpc.call('agent.input.inspect', { key: mixed.receipt.key })
    let cursor: string | undefined, pending: JsonReadAssembly | undefined, value: unknown, count = 0
    do {
      const page = (await f.rpc.call('message.read', { hostId: 'local', messageId: mixed.input.messageId, field: 'channelQuote', maxBytes: 4096, ...(cursor ? { cursor } : {}) }, { credentials: f.credentials })).field!
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096 - 1024)
      const assembled = consumeJsonReadEntry({ scopeKey: mixed.input.messageId + '/channelQuote', entry: page.entry, maxTotalBytes: 2_000_000, ...(pending ? { pending } : {}) })
      if (assembled.kind === 'complete') value = assembled.value
      else pending = assembled.pending
      cursor = page.nextCursor ?? undefined; ++count
    } while (cursor)
    expect(count).toBeGreaterThan(1); expect(value).toEqual(mixed.original.envelope.channelQuote)
    expect(await f.rpc.call('agent.input.inspect', { key: mixed.receipt.key })).toEqual(beforeRead)
    const huge = await received('900', 900, long + short)
    expect(parseAgentMuxMessagePrefix(huge.wire)).toMatchObject({ body: '' })
    expect(huge.wire).toContain('--field body'); expect(Buffer.byteLength(huge.wire)).toBeLessThan(16 * 1024)
    expect(huge.original.envelope.body).toBe(long + short)
    // Even a native admitted MID reference and complete field reading cannot claim the quote was provided inline.
    expect(huge.original.envelope.channelQuote!.range.from?.messageId).toBe(mode === 'native' ? '700' : '600')
    const history = await f.client.sessionTimeline('original-agent')
    const authored = history.items.filter(item => item.inputRef?.kind === 'message')
    const hugeCapture = authored.find(item => item.inputRef?.kind === 'message' && item.inputRef.messageId === huge.input.messageId)
    expect(hugeCapture?.authorExternal).toMatchObject({ kind: 'external', actor: f.actor, externalConversationId: huge.input.author.externalConversationId, externalMessageId: '900' })
    expect(hugeCapture!.content).toBe(long + short)
    expect(JSON.stringify(authored)).toContain('当前请求'); expect(JSON.stringify(authored)).not.toContain('Read it before acting')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    if (channel === 'feishu' && mode === 'native') {
      const page = (await f.rpc.call('message.read', { hostId: 'local', messageId: huge.input.messageId, field: 'body', maxBytes: 4096 })).field!
      expect(page.entry.kind).toBe('fragment')
      const read = (field: AgentMuxMessageField, messageId = huge.input.messageId) => f.rpc.call('message.read', { hostId: 'local', messageId, field, maxBytes: 4096, cursor: page.nextCursor! })
      await expect(read('channelQuote')).rejects.toMatchObject({ code: 'INVALID_MESSAGE_FIELD_CURSOR' })
      await expect(read('body', mixed.input.messageId)).rejects.toMatchObject({ code: 'INVALID_MESSAGE_FIELD_CURSOR' })
      await expect(f.rpc.call('message.read', { hostId: 'foreign-host', messageId: huge.input.messageId, field: 'body' })).rejects.toBeDefined()
      const original = (await f.store.readMetadata('original-agent'))!
      await f.store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'unrelated-agent', providerId: original.providerId, executorId: original.executorId, hostId: 'local', workspacePath: f.root, run: { runId: 'run-unrelated' }, retiredRuns: [], hookBindingId: original.hookBindingId, hookToken: original.hookToken, capabilityHash: original.capabilityHash, createdAt: 1, updatedAt: 1 })
      await expect(f.rpc.call('message.read', { hostId: 'local', messageId: huge.input.messageId, field: 'body' }, { credentials: { agentSessionId: 'unrelated-agent', capability: f.capability } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      const cliOutput = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'desktop.sock'), 'message', 'read', '--host', 'local', '--message-id', huge.input.messageId, '--field', 'body', '--max-bytes', '4096'],
        objectCliEnvironment(f.root, process.env.ADAPTIVE_INTAKE_LOADED ? { ADAPTIVE_INTAKE_LOADED: process.env.ADAPTIVE_INTAKE_LOADED } : {}), '', 20_000,
        pathToFileURL(resolve('packages/connectors/test/fixtures/adaptive-intake/source-loader.mjs')))
      expect(cliOutput.code, cliOutput.stderr).toBe(0)
      const cli = JSON.parse(cliOutput.stdout).result
      expect(cli.message).toBeNull(); expect(cli.field).toEqual(page)
      const quotePage = (await f.hosted.readMessage({ messageId: small.input.messageId, field: 'channelQuote', maxBytes: 16384 }))!
      expect(quotePage.entry.kind).toBe('item')
      const foreign = structuredClone(quotePage)
      if (foreign.entry.kind !== 'item' || typeof foreign.entry.item !== 'object' || !foreign.entry.item) throw Error('Expected original small quote')
      foreign.entry.item.externalConversationId = 'foreign-room'
      const reader = vi.spyOn(f.client, 'readMessage').mockResolvedValueOnce(foreign)
      await expect(f.hosted.readMessage({ messageId: small.input.messageId, field: 'channelQuote', maxBytes: 16384 })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      reader.mockRestore()
      const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
      const { channelQuote: _quote, ...saved } = huge.original.envelope
      await queue.append({ ...saved, messageId: 'metadata-heavy', operationId: 'metadata-heavy-op', body: '', threadId: 'identity'.repeat(1200) })
      const budgetRead = { hostId: 'local', messageId: 'metadata-heavy', field: 'body' as const }
      await expect(f.rpc.call('message.read', { ...budgetRead, maxBytes: 4096 })).rejects.toMatchObject({ code: 'MESSAGE_FIELD_READ_BUDGET' })
      const bounded = (await f.rpc.call('message.read', { ...budgetRead, maxBytes: 16384 })).field!
      expect(bounded.entry).toEqual({ kind: 'item', item: '' }); expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(16384)
      expect((await f.rpc.call('message.read', { ...budgetRead, field: 'channelQuote', maxBytes: 16384 })).field!.entry).toEqual({ kind: 'item', item: null })
      expect((await f.rpc.call('message.read', { hostId: 'local', messageId: 'metadata-heavy' })).message!.envelope.body).toBe('')
      const noQuote = await f.rpc.call('message.read', { hostId: 'local', messageId: 'absent-original', field: 'channelQuote' })
      expect(noQuote).toMatchObject({ message: null, field: null })
    }
  })
}
