import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const core = await import(/* @vite-ignore */ new URL('../dist/index.js', import.meta.url).href) as typeof import('../src/index.js')
const { AgentMuxControlServer } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-server.js', import.meta.url).href) as typeof import('../src/public-rpc-server.js')
const { connectAgentMuxRpc } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-client.js', import.meta.url).href) as typeof import('../src/public-rpc-client.js')
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
function message(id: string, sender = 'caller', recipient = 'recipient', replyTo: string | null = null, threadId = 'original-thread'): AgentMuxMessageAppendInput {
  return { messageId: id, operationId: 'operation-' + id, createdAt: reshapeFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'run-' + sender, recipientSessionId: recipient, recipientRunId: 'run-' + recipient,
    replyTo, threadId, correlationId: id, workspaceId: null, body: 'Original ' + id }
}
async function fixture() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'stranger'], core)
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'reply-chain-native', protocolVersion: 1, buildIdentity: 'private' })
  const queue = new core.DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  const path = join(h.root, 'owner.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const cli = (args: string[], session = 'caller') => runCompiledObjectCli(['--endpoint', 'unix://' + path, ...args], { ...env, AGENTMUX_AGENT_SESSION_ID: session })
  const open = async () => { await queue.append(message('source')); await h.client.openDispatch({ capability: h.capability, callerAgentSessionId: 'caller', sourceMessageId: 'source' }) }
  return { ...h, queue, rpc, cli, open, close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}

describe('original Dispatch reply lineage', () => {
  it('reads the actual CLI reply after native send ACK loss before any worker_done and preserves its original author', async () => {
    const h = await fixture()
    try {
      await h.open()
      const provider = (h.client as any).providers.get('codex')
      const native = vi.fn(async () => { throw new core.AgentMuxError('Native report ACK was lost.', 'AGENT_PROMPT_INPUT_UNCONFIRMED') })
      vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({
        plan: { kind: 'native-rpc', protocolId: 'private-steer', sourceId: 'source', actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' },
        assertCurrent: async () => {}, dispatch: native, close: async () => {}
      })
      const submit = h.client.submitAgentMessage.bind(h.client)
      vi.spyOn(h.client, 'submitAgentMessage').mockImplementation(async input => {
        await submit(input)
        await vi.waitFor(() => expect(native).toHaveBeenCalledOnce())
        throw new core.AgentMuxError('Reply was journaled; native send receipt is unconfirmed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      })
      const body = JSON.stringify({ schema: 'isolated.report.v1', goalId: 'original-goal', evidence: ['actual-reply'] })
      const failed = await h.cli(['agent', 'send', '--to-session', 'caller', '--text', body,
        '--operation-id', 'original-report-operation', '--message-id', 'actual-report', '--reply-to', 'source',
        '--thread', 'original-thread', '--execution', 'immediate', '--expect-run', 'run-caller'], 'recipient')
      expect(failed.code, failed.stderr).toBe(1)
      expect(JSON.parse(failed.stderr).error.code).toBe('AGENT_PROMPT_INPUT_UNCONFIRMED')
      const original = await h.queue.readByOperationId('original-report-operation')
      expect(original!.envelope).toMatchObject({ operationId: 'original-report-operation', messageId: 'actual-report',
        senderSessionId: 'recipient', senderRunId: 'run-recipient', recipientSessionId: 'caller', recipientRunId: 'run-caller',
        threadId: 'original-thread', replyTo: 'source', body })
      const observed = await h.cli(['message', 'dispatch', 'read', '--source-message', 'source'])
      expect(observed.code, observed.stderr).toBe(0)
      const result = JSON.parse(observed.stdout).result
      expect(result.replies.map((item: any) => item.envelope)).toEqual([original!.envelope])
      expect(result.dispatch).toMatchObject({ originAwaits: true, events: [] })
      expect((await h.queue.readJournal()).filter(record => record.kind === 'dispatch-event')).toEqual([])
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('includes owner answers and nested late replies with exact original participants and retained Runs', async () => {
    const h = await fixture()
    try {
      await h.open()
      await h.queue.append(message('question', 'recipient', 'caller', 'source'))
      await h.client.recordDispatchEvent({ capability: h.capability, callerAgentSessionId: 'recipient', sourceMessageId: 'source', replyMessageId: 'question', kind: 'question' })
      await h.queue.append(message('answer', 'caller', 'recipient', 'question'))
      await h.queue.append(message('late-report', 'recipient', 'caller', 'answer'))
      await h.queue.append(message('alien', 'stranger', 'caller', 'source'))
      await h.queue.append(message('wrong-thread', 'recipient', 'caller', 'source', 'another-thread'))
      await h.queue.append(message('unrooted', 'recipient', 'caller', 'not-this-source'))
      await h.queue.append({ ...message('human', 'recipient', 'caller', 'source'), sender: { kind: 'human', principal: 'local-cli' }, senderSessionId: null, senderRunId: null })
      for (const id of ['caller', 'recipient']) {
        const previous = (await h.store.load()).find(session => session.agentSessionId === id)!
        await h.store.compareAndSwap(previous, { ...previous, run: { runId: 'continued-' + id }, retiredRuns: [previous.run], updatedAt: reshapeFixtureEpoch(0, 0, 2) })
      }
      const first = await h.rpc.call('message.dispatch.read', { sourceMessageId: 'source' })
      expect(first.replies.map(item => item.envelope.messageId)).toEqual(['question', 'answer', 'late-report'])
      expect(first.identityDiagnostics).toEqual([])
      expect(first.dispatch).toMatchObject({ originAwaits: true, events: [expect.objectContaining({ kind: 'question', replyMessageId: 'question' })] })
      // A new queue reader finds the same records, without replacing the original identities or events.
      expect((await new core.DurableAgentMuxMessageQueue(h.queue.path).readDispatch({ sourceMessageId: 'source' }, async () => [])).replies).toEqual(first.replies)
      expect((await h.queue.append(message('late-report', 'recipient', 'caller', 'answer'))).envelope).toEqual(first.replies[2]!.envelope)
      expect((await h.rpc.call('message.dispatch.read', { sourceMessageId: 'source' })).replies).toEqual(first.replies)
      const unknown = vi.spyOn(h.store, 'readMetadata'), read = core.AgentMuxFileAgentSessionStore.prototype.readMetadata
      unknown.mockImplementation(async id => { if (id === 'recipient') throw new Error('Participant history unavailable'); return read.call(h.store, id) })
      const recorded = await h.rpc.call('message.dispatch.read', { sourceMessageId: 'source' })
      expect(recorded.replies).toEqual(first.replies)
      expect(recorded.identityDiagnostics).toEqual([expect.objectContaining({ agentSessionId: 'recipient', runId: 'run-recipient', code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })])
      const denied = await h.cli(['message', 'dispatch', 'read', '--source-message', 'source'], 'stranger')
      expect(denied.code).toBe(1); expect(JSON.parse(denied.stderr).error.code).toBe('DISPATCH_PARTICIPANT_MISMATCH')
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps new reply indexing out of append and open and bounds actual query rows despite unrelated journal growth', async () => {
    const h = await fixture()
    const indexes = () => {
      const db = new DatabaseSync(h.queue.path, { readOnly: true })
      try { return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='message_reply_chain'").all() }
      finally { db.close() }
    }
    try {
      await h.queue.append(message('source')); expect(indexes()).toEqual([])
      await h.client.openDispatch({ capability: h.capability, callerAgentSessionId: 'caller', sourceMessageId: 'source' }); expect(indexes()).toEqual([])
      await h.queue.append(message('reply', 'recipient', 'caller', 'source')); expect(indexes()).toEqual([])
      const prepare = DatabaseSync.prototype.prepare
      const rows: number[] = [], queries: Array<{ sql: string; parameters: unknown[] }> = []
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql)
        if (/^SELECT sequence, json FROM records/u.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = ((...parameters: any[]) => { const result = all(...parameters); rows.push(result.length); queries.push({ sql, parameters }); return result }) as typeof statement.all
        }
        return statement
      })
      const observe = async () => {
        rows.length = 0; queries.length = 0
        const result = await h.rpc.call('message.dispatch.read', { sourceMessageId: 'source' })
        expect(result.replies.map(item => item.envelope.messageId)).toEqual(['reply'])
        expect(rows.length).toBeGreaterThan(0); expect(rows.reduce((sum, count) => sum + count, 0)).toBe(1)
        const db = new DatabaseSync(h.queue.path, { readOnly: true })
        try {
          for (const query of queries) {
            const plan = db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.parameters as any[])
            expect(plan.map(row => row.detail).join(' ')).toMatch(/SEARCH records USING INDEX message_reply_chain/u)
          }
        } finally { db.close() }
        return [...rows]
      }
      const first = await observe(); expect(indexes()).toHaveLength(1)
      for (let index = 0; index < 20; index++) {
        await h.queue.append(message('alien-' + index, 'stranger', 'caller', 'source'))
        await h.queue.append(message('other-thread-' + index, 'recipient', 'caller', 'source', 'unrelated-' + index))
        await h.queue.append(message('other-parent-' + index, 'recipient', 'caller', 'unrelated-parent-' + index))
      }
      expect(await observe()).toEqual(first)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 60_000)

  it.each(['dangling', 'cycle', 'participant', 'thread', 'event', 'author'] as const)('rejects forged %s reply lineage at the actual CLI native codec', async fault => {
    const source = { sequence: 1, envelope: { ...message('source'), schema: 'agentmux.a2a.v1' }, delivery: { state: 'queued', at: reshapeFixtureEpoch(0, 0, 1) } }
    const reply = { sequence: 2, envelope: { ...message('reply', 'recipient', 'caller', 'source'), schema: 'agentmux.a2a.v1' }, delivery: { state: 'queued', at: reshapeFixtureEpoch(0, 0, 1) } }
    const other = { sequence: 3, envelope: { ...message('other', 'caller', 'recipient', 'reply'), schema: 'agentmux.a2a.v1' }, delivery: { state: 'queued', at: reshapeFixtureEpoch(0, 0, 1) } }
    const wire = { hostId: 'local', source, replies: [reply, other], identityDiagnostics: [], dispatch: { sourceMessageId: 'source', ownerAgentSessionId: 'caller', workerAgentSessionId: 'recipient', threadId: 'original-thread', openedAt: reshapeFixtureEpoch(0, 0, 1), originAwaits: true, events: [] as any[] } }
    if (fault === 'dangling') reply.envelope.replyTo = 'unrelated-parent'
    if (fault === 'cycle') reply.envelope.replyTo = 'other'
    if (fault === 'participant') { reply.envelope.senderSessionId = 'stranger'; reply.envelope.sender = { kind: 'agent-session', agentSessionId: 'stranger' } }
    if (fault === 'thread') reply.envelope.threadId = 'another-thread'
    if (fault === 'event') wire.dispatch.events = [{ kind: 'worker_done', replyMessageId: 'not-an-actual-reply', at: reshapeFixtureEpoch(0, 0, 1) }]
    if (fault === 'author') reply.envelope.sender = { kind: 'human', principal: 'local-cli' } as any
    const probe = new ObjectCliProbe(() => wire)
    await probe.start()
    try {
      const result = await probe.run(['--endpoint', 'unix://' + probe.socketPath, 'message', 'dispatch', 'read', '--host', 'local', '--source-message', 'source'])
      expect(result.code, result.stdout).toBe(1)
      expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
    } finally { await probe.stop() }
  })
})
