import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { join } from 'node:path'
import { rename, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

// One native compiled owner throughout: CLI, RPC, journal and same-owner locks.
const entry = (file: string, env: string) => process.env[env] ?? new URL('../dist/' + file, import.meta.url).href
const core = await import(/* @vite-ignore */ entry('index.js', 'AGENTMUX_TEST_QUERY_CORE')) as typeof import('../src/index.js')
const { AgentMuxControlServer } = await import(/* @vite-ignore */ entry('public-rpc-server.js', 'AGENTMUX_TEST_QUERY_SERVER')) as typeof import('../src/public-rpc-server.js')
const { connectAgentMuxRpc } = await import(/* @vite-ignore */ entry('public-rpc-client.js', 'AGENTMUX_TEST_QUERY_RPC')) as typeof import('../src/public-rpc-client.js')
const hostedServiceEntry = entry('hosted-runtime-service.js', 'AGENTMUX_TEST_QUERY_HOSTED_SERVICE')
const hostedClientEntry = entry('hosted-client.js', 'AGENTMUX_TEST_QUERY_HOSTED_CLIENT')
const cliEntry = process.env.AGENTMUX_TEST_OBJECT_CLI
const { DurableAgentMuxMessageQueue } = core

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function owner() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'stranger'], core)
  if (cliEntry) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', cliEntry)
  const path = join(h.root, 'queries.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
  return { ...h, path, server, rpc, queue: new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()),
    cli: (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix://' + path, ...args], env),
    close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}
function input(id: string, from = 'caller', to = 'recipient', body = 'original\n正文'): AgentMuxMessageAppendInput & { messageId: string } {
  return { messageId: 'msg-' + id, operationId: 'op-' + id, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: from }, recipient: { kind: 'agent-session', agentSessionId: to },
    senderSessionId: from, senderRunId: 'run-' + from, recipientSessionId: to, recipientRunId: null,
    threadId: 'thread-' + id, correlationId: 'correlation-' + id, replyTo: null, workspaceId: null,
    body, sourceChannel: 'cli' }
}
const outgoing = { direction: 'outgoing' as const }

describe('original A2A bounded queries through the public product path', () => {
  it('uses compiled CLI list and msg-id read for the same pre-input identity; operation reads remain intact', async () => {
    const h = await owner()
    try {
      const original = { ...input('cli', 'caller', 'recipient', '原样\r\n<reminder>正文</reminder>\0尾文'), messageId: 'self' }
      await h.queue.append(original)
      const listing = await h.cli(['message', 'ls', '--direction', 'outgoing', '--limit', '1'])
      expect(listing.code, listing.stderr).toBe(0)
      const page = JSON.parse(listing.stdout).result
      expect(page).toMatchObject({ hostId: 'local', participantSessionId: 'caller', direction: 'outgoing', nextBeforeSequence: null,
        messages: [{ envelope: { messageId: original.messageId, operationId: original.operationId, recipientRunId: null }, bodyBytes: Buffer.byteLength(original.body) }] })
      expect(page.messages[0].envelope).not.toHaveProperty('body')
      const read = await h.cli(['message', 'read', '--message-id', page.messages[0].envelope.messageId])
      expect(read.code, read.stderr).toBe(0)
      const message = JSON.parse(read.stdout).result.message
      expect(message).toMatchObject({ envelope: { body: original.body } })
      expect((await h.rpc.call('message.read', { operationId: original.operationId })).message).toEqual(message)
      expect(await h.client.readMessage({ messageId: original.messageId, caller: h.credentials })).toEqual(message)
      expect(await h.rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: original.operationId })).toEqual({ record: null, input: null })
      expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('pages exact direction by immutable sequence without duplicate or loss after appends and delivery updates', async () => {
    const h = await owner()
    try {
      for (const id of ['old', 'middle', 'latest']) await h.queue.append(input(id))
      await h.queue.append(input('incoming', 'recipient', 'caller'))
      await h.queue.append(input('unrelated', 'stranger', 'recipient'))
      await h.queue.recordDelivery('msg-middle', 'failed', 2, 'original attempt failed')
      await h.queue.recordDeliveryIssue('msg-latest', 'original receipt unknown', 3)
      const pendingFirst = h.rpc.call('message.ls', { ...outgoing, limit: 2 })
      await expect(pendingFirst).resolves.toMatchObject({ messages: [
        { envelope: { messageId: 'msg-latest' } }, { envelope: { messageId: 'msg-middle' } } ] })
      const first = await pendingFirst
      expect(first.messages[0]!.delivery).toEqual({ state: 'queued', at: _tailFixtureEpoch(0, 0, 1), reason: 'original receipt unknown' })
      expect(first.messages[1]!.delivery).toEqual({ state: 'failed', at: _tailFixtureEpoch(0, 0, 2), reason: 'original attempt failed' })
      expect(first.nextBeforeSequence).toBe(first.messages[1]!.sequence)
      await h.queue.append(input('arrived-after-page'))
      await h.queue.recordDelivery('msg-old', 'failed', 4)
      const next = await h.rpc.call('message.ls', { ...outgoing, beforeSequence: first.nextBeforeSequence!, limit: 2 })
      expect(next.messages.map(m => m.envelope.messageId)).toEqual(['msg-old'])
      expect(next.nextBeforeSequence).toBeNull()
      const incoming = await h.rpc.call('message.ls', { direction: 'incoming', limit: 1 })
      expect(incoming.messages.map(m => m.envelope.messageId)).toEqual(['msg-incoming'])
      expect(incoming.nextBeforeSequence).toBeNull()
      expect((await h.rpc.call('message.read', { messageId: 'msg-old' })).message!.delivery.state).toBe('failed')
    } finally { await h.close() }
  })

  it('does not construct full bodies in JavaScript and uses participant indexes rather than unrelated history', async () => {
    const h = await owner()
    try {
      for (let n = 0; n < 12; n++) await h.queue.append(input('unrelated-' + n, 'stranger', 'recipient'))
      const hidden = 'BODY-MUST-NOT-CROSS-LIST-JS', body = '🙂'.repeat(240) + hidden + 'x'.repeat(30_000)
      await h.queue.append(input('large', 'caller', 'recipient', body))
      const { DatabaseSync } = await import('node:sqlite')
      const prepare = DatabaseSync.prototype.prepare, queries: string[] = []
      const sqlSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
        if (sql.includes('AS metadata')) queries.push(sql)
        return prepare.call(this, sql)
      })
      let constructedFullBody = false
      const parse = JSON.parse, parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((value: string, reviver?: any) => {
        // Metadata and bounded preview can cross JS; the full original body cannot.
        if (value.includes(hidden)) constructedFullBody = true
        return parse(value, reviver)
      })
      const page = await h.client.listMessages({ participantSessionId: 'caller', ...outgoing, limit: 1, caller: h.credentials })
      parseSpy.mockRestore(); sqlSpy.mockRestore()
      expect(constructedFullBody).toBe(false)
      expect(page.messages).toHaveLength(1)
      expect(page.messages[0]!.bodyPreview).toBe('🙂'.repeat(120))
      expect(page.messages[0]!.bodyBytes).toBe(Buffer.byteLength(body))
      expect(page.messages[0]!.envelope).not.toHaveProperty('body')
      expect(queries).toHaveLength(1)
      const db = new DatabaseSync(h.client.agentMessageQueuePath(), { readOnly: true })
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + queries[0]).all('caller', Number.MAX_SAFE_INTEGER, 2).map(row => String(row.detail)).join('\n')
        expect(plan).toMatch(/SEARCH original USING INDEX message_sender/u)
        expect(plan).not.toMatch(/SCAN (?:original|m)\b|USE TEMP B-TREE/u)
      } finally { db.close() }
    } finally { await h.close() }
  }, 20_000)

  it('confines managed reads to exact participants and Host; trusted user reads select both explicitly', async () => {
    const h = await owner(), readers: Array<Awaited<ReturnType<typeof connectAgentMuxRpc>>> = []
    try {
      await h.queue.append(input('auth'))
      await expect(h.rpc.call('message.ls', { ...outgoing, participantSessionId: 'stranger' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(h.client.listMessages({ ...outgoing, participantSessionId: 'recipient', caller: h.credentials })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(h.rpc.call('message.ls', { ...outgoing, hostId: 'other' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path }, credentials: { ...h.credentials, agentSessionId: 'stranger' } }); readers.push(stranger)
      await expect(stranger.call('message.read', { messageId: 'msg-auth' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      const trusted = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); readers.push(trusted)
      await expect(trusted.call('message.ls', outgoing)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      await expect(trusted.call('message.ls', { ...outgoing, hostId: 'local' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect((await trusted.call('message.ls', { direction: 'incoming', hostId: 'local', participantSessionId: 'recipient' })).messages[0]!.envelope.messageId).toBe('msg-auth')
      expect((await trusted.call('message.read', { messageId: 'msg-auth', hostId: 'local' })).message!.envelope.body).toBe('original\n正文')
      await expect(h.client.readMessage({ messageId: 'absent', caller: { ...h.credentials, capability: 'stale' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      await expect(h.client.listMessages({ ...outgoing, participantSessionId: 'caller', caller: { ...h.credentials, capability: 'stale' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { for (const r of readers) await r.dispose(); await h.close() }
  })

  it('reauthorizes both query and msg-id read inside the original journal transaction', async () => {
    const h = await owner()
    try {
      await h.queue.append(input('revoked'))
      const queue = (h.client as any).messageQueue, withLock = queue.withLock.bind(queue)
      const revokeAtLock = async () => {
        const previous = (await h.store.readMetadata('caller'))!
        await h.store.compareAndSwap(previous, { ...previous, capabilityHash: core.hashAgentCapability('replacement'), updatedAt: previous.updatedAt + 1 })
      }
      vi.spyOn(queue, 'withLock').mockImplementationOnce(async (operation: any) => { await revokeAtLock(); return withLock(operation) })
      await expect(h.client.listMessages({ participantSessionId: 'caller', ...outgoing, caller: h.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      const current = (await h.store.readMetadata('caller'))!
      await h.store.compareAndSwap(current, { ...current, capabilityHash: core.hashAgentCapability(h.capability), updatedAt: current.updatedAt + 1 })
      vi.spyOn(queue, 'withLock').mockImplementationOnce(async (operation: any) => { await revokeAtLock(); return withLock(operation) })
      await expect(h.client.readMessage({ messageId: 'msg-revoked', caller: h.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect((await h.queue.readByMessageId('msg-revoked'))!.envelope.body).toBe('original\n正文')
      expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps check/ack cursor separate from human browsing and reads without Runtime observation', async () => {
    const h = await owner()
    try {
      await h.queue.append(input('read-only', 'recipient', 'caller'))
      const batch = await h.queue.check({ consumerId: 'caller', readerRun: { runId: 'run-caller' }, limit: 1 }, async () => {})
      const journal = await h.queue.readJournal()
      vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Unrelated observation unavailable'))
      h.inner.kernel.status = vi.fn(async () => { throw new Error('Run observation unavailable') })
      await h.rpc.call('message.ls', { direction: 'incoming' })
      await h.rpc.call('message.read', { messageId: 'msg-read-only' })
      expect(await h.queue.readJournal()).toEqual(journal)
      expect(await h.queue.check({ consumerId: 'caller', readerRun: { runId: 'run-caller' }, limit: 1 }, async () => {})).toEqual(batch)
      const ack = await h.queue.ack({ consumerId: 'caller', readerRun: { runId: 'run-caller' }, generation: batch.generation }, async () => {})
      expect(ack.acknowledgedMessageIds).toEqual(['msg-read-only'])
      expect((await h.rpc.call('message.ls', { direction: 'incoming' })).messages).toHaveLength(1)
      expect(h.inner.kernel.status).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('returns absence only from the original journal and preserves recoverability on query failures and invalid requests', async () => {
    const h = await owner(), path = h.client.agentMessageQueuePath(), backup = path + '.retained'
    try {
      await h.queue.append(input('retained'))
      expect(await h.rpc.call('message.read', { messageId: 'absent' })).toEqual({ hostId: 'local', message: null })
      for (const params of [{}, { operationId: 'op-retained', messageId: 'msg-retained' }]) await expect(h.rpc.call('message.read', params as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      for (const params of [{ direction: 'wrong' }, { ...outgoing, limit: 101 }, { ...outgoing, beforeSequence: 0 }, { ...outgoing, extra: true }]) await expect(h.rpc.call('message.ls', params as any)).rejects.toBeDefined()
      const invalid = await h.cli(['message', 'read', '--message-id', 'msg-retained', '--operation-id', 'op-retained'])
      expect(invalid.code).toBe(1)
      await rename(path, backup); await writeFile(path, 'unreadable original journal')
      try {
        const failed = await h.cli(['message', 'ls', '--direction', 'outgoing'])
        expect(failed.code, failed.stderr).toBe(1)
        expect(JSON.parse(failed.stderr).error.code).toBe('MESSAGE_QUEUE_UNAVAILABLE')
      } finally { await rm(path); await rename(backup, path) }
      expect((await h.rpc.call('message.read', { messageId: 'msg-retained' })).message!.envelope.messageId).toBe('msg-retained')
      expect((await h.rpc.call('message.ls', outgoing)).messages).toHaveLength(1)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('exposes the same SDK read seam through the Hosted client without a connect prerequisite', async () => {
    const h = await owner()
    const { AgentMuxHostedRuntimeService } = await import(/* @vite-ignore */ hostedServiceEntry) as typeof import('../src/hosted-runtime-service.js')
    const { connectHostedAgentMux } = await import(/* @vite-ignore */ hostedClientEntry) as typeof import('../src/hosted-client.js')
    const identity = { runtimeId: 'query-owner', ownerInstanceId: 'query-owner-epoch', protocolVersion: 2 as const,
      processId: process.pid, ctxmux: h.client.runtimeIdentity(), availability: 'connected' as const }
    const hosted = new AgentMuxHostedRuntimeService(h.client, join(h.root, 'sessions.json'), () => identity)
    const path = join(h.root, 'hosted.sock')
    const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => hosted })
    let wire: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, reader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
    try {
      await h.queue.append(input('hosted')); await server.start()
      wire = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      reader = await connectHostedAgentMux({ rpc: wire })
      vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Observation unavailable'))
      const page = await reader.listMessages({ participantSessionId: 'caller', ...outgoing })
      expect(page.messages[0]!.envelope.messageId).toBe('msg-hosted')
      expect((await reader.readMessage({ messageId: 'msg-hosted' }))!.envelope.body).toBe('original\n正文')
      expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await reader?.dispose(); await wire?.dispose(); await server.stop(); hosted.dispose(); await h.close() }
  })

  it('forwards list scope, cursor and stable message ID to the exact remote semantic owner', async () => {
    const h = await owner()
    let outer: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, server: InstanceType<typeof AgentMuxControlServer> | undefined
    try {
      await h.queue.append(input('remote-old')); await h.queue.append(input('remote-new'))
      const forwarded: Array<{ method: string; params: unknown }> = []
      const remote = new Proxy(h.client, { get(target, property) {
        if (property === 'forwardRpc') return async (method: any, params: any) => { forwarded.push({ method, params }); return h.rpc.call(method, params) }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } }) as unknown as AgentMuxRpcCorePort
      const path = join(h.root, 'remote.sock')
      server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'remote', client: remote }] }); await server.start()
      outer = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
      const first = await outer.call('message.ls', { ...outgoing, limit: 1 })
      expect(first.hostId).toBe('remote')
      const next = await outer.call('message.ls', { ...outgoing, beforeSequence: first.nextBeforeSequence!, limit: 1 })
      expect(next.messages[0]!.envelope.messageId).toBe('msg-remote-old')
      expect((await outer.call('message.read', { messageId: 'msg-remote-new' })).hostId).toBe('remote')
      expect(forwarded).toContainEqual({ method: 'message.read', params: { messageId: 'msg-remote-new', hostId: 'local' } })
      expect(forwarded).toContainEqual({ method: 'message.ls', params: { ...outgoing, beforeSequence: first.nextBeforeSequence, limit: 1, hostId: 'local' } })
    } finally { await outer?.dispose(); await server?.stop(); await h.close() }
  })

  it('rejects response retargeting, full-body fields, invalid pagination and wrong msg-id through compiled public codecs', async () => {
    const h = await owner()
    let wire: any, rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    const probe = new ObjectCliProbe(() => wire)
    try {
      await h.queue.append(input('codec-old')); await h.queue.append(input('codec-new'))
      const valid = await h.rpc.call('message.ls', { ...outgoing, hostId: 'local', limit: 1 })
      wire = valid; await probe.start()
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath }, credentials: h.credentials })
      const params = { ...outgoing, hostId: 'local', limit: 1 }
      expect(await rpc.call('message.ls', params)).toEqual(valid)
      const entry = valid.messages[0]!
      for (const forged of [
        { ...valid, messages: [{ ...entry, envelope: { ...entry.envelope, sender: { ...entry.envelope.sender, body: 'leaked nested body' } } }] },
        { ...valid, hostId: 'other' }, { ...valid, participantSessionId: 'stranger' }, { ...valid, direction: 'incoming' },
        { ...valid, messages: [{ ...entry, envelope: { ...entry.envelope, body: 'leaked original body' } }] },
        { ...valid, messages: [{ ...entry, envelope: { ...entry.envelope, senderSessionId: 'stranger' } }] },
        { ...valid, messages: [{ ...entry, bodyPreview: 'x'.repeat(241) }] },
        { ...valid, nextBeforeSequence: entry.sequence + 1 }, { ...valid, messages: [entry, entry] }
      ]) {
        wire = forged
        await expect(rpc.call('message.ls', params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      }
      wire = { ...valid, participantSessionId: 'stranger', messages: [], nextBeforeSequence: null }
      const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + probe.socketPath, 'message', 'ls', '--direction', 'outgoing', '--host', 'local'],
        objectCliEnvironment(probe.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability }))
      expect(cli.code, cli.stderr).toBe(1); expect(JSON.parse(cli.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
      wire = await h.rpc.call('message.read', { messageId: 'msg-codec-new', hostId: 'local' })
      expect(await rpc.call('message.read', { messageId: 'msg-codec-new', hostId: 'local' })).toEqual(wire)
      wire = { ...wire, message: { ...wire.message, envelope: { ...wire.message.envelope, messageId: 'forged-message' } } }
      await expect(rpc.call('message.read', { messageId: 'msg-codec-new', hostId: 'local' })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    } finally { await rpc?.dispose(); await probe.stop(); await h.close() }
  }, 20_000)
})
