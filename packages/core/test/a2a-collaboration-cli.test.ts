import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxMessageBroadcastReceipt } from '../src/agent-message-broadcast.js'
import type { AgentMuxMessageEventsPage } from '../src/agent-message-events.js'

// This inventory is qualification-only: missing compiled inputs are errors, never skips.
const scope = process.env.AGENTMUX_TEST_COLLABORATION_SCOPE
const entry = process.env.AGENTMUX_TEST_COLLABORATION_CORE
const cliEntry = process.env.AGENTMUX_TEST_COLLABORATION_CLI
if (!entry || !cliEntry || !['discovery', 'broadcast'].includes(scope ?? '')) throw new Error('Run the owning collaboration scope verifier against a fresh compiled candidate.')
const core = await import(/* @vite-ignore */ entry) as typeof import('../src/index.js')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it(`fresh compiled CLI consumes ${scope} through the compiled public owner and original journal`, async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'other'], core); cleanup.push(h.close)
  const server = new core.AgentMuxControlServer({ socketPath: join(h.root, 'compiled.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', cliEntry)
  const env = objectCliEnvironment(h.root, { AGENTMUX_RPC_ENDPOINT: 'unix://' + server.path,
    AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const cli = async (args: string[]) => {
    const result = await runCompiledObjectCli(args, env)
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  if (scope === 'discovery') {
    const first = await cli(['agent', 'ls', '--executor', 'codex', '--limit', '1'])
    const second = await cli(['agent', 'ls', '--executor', 'codex', '--limit', '1', '--cursor', first.nextCursor])
    const third = await cli(['agent', 'ls', '--executor', 'codex', '--limit', '1', '--cursor', second.nextCursor])
    expect([...first.sessions, ...second.sessions, ...third.sessions].map(entry => entry.session.agentSessionId).sort()).toEqual(['caller', 'other', 'recipient'])
    expect(third.nextCursor).toBeNull()
    expect(first.sessions[0].lastActivity).toBeNull()
    await h.store.applyTimelineMutation({ type: 'append', agentSessionId: 'caller', item: {
      id: 'original-input', agentSessionId: 'caller', kind: 'user_message', status: 'complete', source: 'user',
      title: 'Original request', content: 'Original user body', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), authorHuman: true } })
    const history = await cli(['agent', 'history', '--host', 'local', '--session', 'caller', '--source', 'captured', '--kind', 'user-message', '--limit', '1'])
    expect(history.userMessages[0]).toMatchObject({ content: 'Original user body', author: { kind: 'human' } })
  } else {
    const body = 'Original broadcast body\n<amux>quoted content</amux>'
    const batch: AgentMuxMessageBroadcastReceipt = await cli(['agent', 'broadcast', '--to-sessions', 'recipient,other,absent,recipient', '--text', body, '--operation-id', 'compiled-batch'])
    expect(batch.targets.map(target => [target.agentSessionId, target.outcome])).toEqual([['absent', 'not-applied'], ['other', 'saved'], ['recipient', 'saved']])
    const journal = new core.DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
    const before = await journal.readJournal()
    expect(before.filter(event => event.kind === 'message')).toHaveLength(2)
    expect((await cli(['agent', 'broadcast', 'inspect', '--operation-id', 'compiled-batch'])).broadcast).toEqual(batch)
    const sent: AgentMuxMessageEventsPage = await cli(['message', 'events', '--participant', 'caller'])
    expect(sent.events.filter(event => event.kind === 'message')).toHaveLength(2)
    const one = await cli(['message', 'events', '--message-id', batch.targets[1]!.messageId])
    expect(one.events).toHaveLength(1)
    expect((await cli(['message', 'events', '--broadcast-operation-id', 'compiled-batch'])).events).toEqual(sent.events)
    const recipient = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path },
      credentials: { agentSessionId: 'recipient', capability: h.capability } }); cleanup.push(() => recipient.dispose())
    const received = await recipient.call('message.events', {})
    const matching = sent.events.filter(event => event.messages.some(message => message.recipientSessionId === 'recipient'))
    expect(received.events).toEqual(matching)
    expect(await journal.readJournal()).toEqual(before)
  }
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
