import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { agentDiscoveryActivity } from '../src/agent-discovery.js'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { createHistoryQueryFixture } from './helpers/session-history-query.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(ids = ['caller', 'peer-a', 'peer-b']) {
  const h = await rpcOwnerFixture(ids); cleanup.push(h.close)
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'discovery.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
  cleanup.push(() => rpc.dispose())
  return { ...h, rpc }
}

it('the current CLI parser and real public owner page every identity without probing beyond the candidate budget', async () => {
  const h = await fixture(), status = vi.spyOn(h.client, 'statusAgent')
  const parsed = await parseAgentMuxCliInvocation(['agent', 'ls', '--provider', 'codex', '--limit', '1'])
  expect(parsed.command.method).toBe('agent.ls')
  const first = await h.rpc.call('agent.ls', parsed.params)
  expect(first.sessions.map(entry => entry.session.agentSessionId)).toEqual(['caller'])
  expect(status).toHaveBeenCalledExactlyOnceWith('caller')
  expect(first.nextCursor).not.toBeNull()
  const second = await h.rpc.call('agent.ls', { ...parsed.params, cursor: first.nextCursor! })
  const third = await h.rpc.call('agent.ls', { ...parsed.params, cursor: second.nextCursor! })
  expect([...first.sessions, ...second.sessions, ...third.sessions].map(entry => entry.session.agentSessionId)).toEqual(['caller', 'peer-a', 'peer-b'])
  expect(third.nextCursor).toBeNull()
  await expect(h.rpc.call('agent.ls', { providerId: 'another-provider', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_DISCOVERY_CURSOR_INVALID' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('exact metadata discovery uses point reads and preserves zero semantic matches with their continuation', async () => {
  const h = await fixture(), inventory = vi.spyOn(h.client, 'readAgentSessions'), history = vi.spyOn(h.client, 'sessionHistorySources')
  const status = vi.spyOn(h.client, 'statusAgent')
  const exact = await h.rpc.call('agent.ls', { agentSessionId: 'peer-b', executorId: 'codex', limit: 1 })
  expect(exact.sessions.map(entry => entry.session.agentSessionId)).toEqual(['peer-b'])
  expect(inventory).not.toHaveBeenCalled()
  expect(history).toHaveBeenCalledWith({ agentSessionId: 'peer-b' })
  expect(status).toHaveBeenCalledExactlyOnceWith('peer-b')
  const empty = await h.rpc.call('agent.ls', { semantic: 'active', limit: 1 })
  expect(empty.sessions).toEqual([])
  expect(empty.nextCursor).not.toBeNull()
  status.mockClear()
  expect((await h.rpc.call('agent.ls', { executorId: 'absent-executor' })).sessions).toEqual([])
  expect(status).not.toHaveBeenCalled()
})

it('failed status reads retain the original Session instead of claiming death or removing its usable identity', async () => {
  const h = await fixture(), original = h.client.statusAgent.bind(h.client)
  vi.spyOn(h.client, 'statusAgent').mockImplementation(async id => {
    if (id === 'peer-a') throw new AgentMuxError('Original Run observation unavailable', 'RUNTIME_UNAVAILABLE')
    return original(id)
  })
  const before = await h.store.load(), page = await h.rpc.call('agent.ls', {})
  expect(page.sessions).toHaveLength(2)
  expect(page.unavailableSessions).toMatchObject([{ session: { agentSessionId: 'peer-a', run: { runId: 'run-peer-a' } }, code: 'RUNTIME_UNAVAILABLE', lastActivity: null }])
  expect(page.errors).toContainEqual(expect.objectContaining({ agentSessionId: 'peer-a', code: 'RUNTIME_UNAVAILABLE' }))
  expect(await h.store.load()).toEqual(before)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('recent activity preserves the typed event clock and does not promote metadata, completion or polling into working', async () => {
  const h = await fixture(['caller']), stored = (await h.store.readMetadata('caller'))!
  await h.store.compareAndSwap(stored, { ...stored, updatedAt: Date.now(), semanticStatus: { state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 7) } })
  const first = await h.rpc.call('agent.ls', {})
  expect(first.sessions[0]!.lastActivity).toEqual({ state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 7), run: { runId: 'run-caller' } })
  expect(first.sessions[0]!.observation.semantic).toBe('idle')
  expect((await h.rpc.call('agent.ls', { activitySince: 8 })).sessions).toEqual([])
  expect((await h.rpc.call('agent.ls', { semantic: 'active' })).sessions).toEqual([])
  expect((await h.rpc.call('agent.ls', {})).sessions[0]!.lastActivity).toEqual(first.sessions[0]!.lastActivity)
  expect(agentDiscoveryActivity({ ...first.sessions[0]!.session, semanticStatus: { state: 'running', source: 'run-process', observedAt: Date.now() } })).toBeNull()
  expect(agentDiscoveryActivity({ ...first.sessions[0]!.session, semanticStatus: { state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 7),
    nativeTurnId: 'main-turn', aggregateActivityAt: _tailFixtureEpoch(0, 0, 9) } })).toEqual({ state: 'working', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 9), run: { runId: 'run-caller' } })
  const altered = structuredClone(first); altered.sessions[0]!.lastActivity!.observedAt++
  expect(() => parseRpcNativeResult('agent.ls', altered, {})).toThrow()
})

it('strict discovery receipts reject another scope, duplicated identities and a candidate count beyond the requested page', async () => {
  const h = await fixture(), page = await h.rpc.call('agent.ls', {})
  for (const input of [{ agentSessionId: 'absent' }, { executorId: 'absent' }, { providerId: 'absent' }, { since: Number.MAX_SAFE_INTEGER }, { semantic: 'active' }, { limit: 1 }])
    expect(() => parseRpcNativeResult('agent.ls', page, input)).toThrow()
  const duplicate = structuredClone(page); duplicate.sessions.push(duplicate.sessions[0]!)
  expect(() => parseRpcNativeResult('agent.ls', duplicate, {})).toThrow()
})

it('retired descriptors are visible without reviving or inventing their process and activity facts', async () => {
  const h = await fixture(['caller', 'retired'])
  const reservation = { kind: 'stop' as const, reservationId: 'retire-original', ownerId: 'private-owner', ownerPid: process.pid,
    agentSessionId: 'retired', operationId: 'retire-original', expectedRun: { runId: 'run-retired' }, expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-runtime', operationKey: 'retire-original', runId: 'run-retired' } }
  await h.store.reserveLifecycle(reservation)
  await h.store.commitLifecycle(reservation, null)
  const status = vi.spyOn(h.client, 'statusAgent'), page = await h.rpc.call('agent.ls', {})
  expect(page.retired).toMatchObject([{ agentSessionId: 'retired', state: 'retired', routeHostId: 'local' }])
  expect(page.retired[0]).not.toHaveProperty('observation')
  expect(page.retired[0]).not.toHaveProperty('lastActivity')
  expect(status).not.toHaveBeenCalledWith('retired')
  expect((await h.rpc.call('agent.ls', { semantic: 'active' })).retired).toEqual([])
  expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('module discovery teaches small original history windows, complete paging and the unchanged authorization boundary', () => {
  const skill = agentMuxModuleSkill('agent')!
  for (const entry of ['nextCursor=null', 'semantic=active', 'activity-since', 'agent conversation inspect --limit 3', 'agent history --source captured or native', 'message ls/read'])
    expect(skill).toContain(entry)
  expect(skill).toContain('Discovery never grants access')
  expect(skill).toContain('unknown authorship')
})

it('aggregate snapshots disclose their bounded discovery instead of presenting a truncated inventory as complete', async () => {
  const h = await fixture()
  const snapshot = await h.rpc.call('app.snapshot', { include: ['sessions'], limit: 1 })
  expect(snapshot.sessions).toHaveLength(1)
  expect(snapshot.unavailable).toContainEqual(expect.objectContaining({ source: 'sessions', code: 'AGENT_DISCOVERY_PARTIAL',
    recovery: expect.stringContaining('nextCursor') }))
})

it('the discovered original history commands page typed replies and original user inputs without operating a Run', async () => {
  const h = await createHistoryQueryFixture(cleanup)
  const rows = [
    { type: 'user', uuid: 'request-a', message: { role: 'user', content: 'Original request A' } },
    { type: 'assistant', uuid: 'reply-a', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning' }, { type: 'text', text: 'Original reply A' }] } },
    { type: 'user', uuid: 'request-b', message: { role: 'user', content: 'Original request B' } },
    { type: 'assistant', uuid: 'reply-b', message: { role: 'assistant', content: [{ type: 'text', text: 'Original reply B' }] } }
  ].map(row => ({ ...row, sessionId: 'original-native' }))
  await writeFile(h.transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'history-discovery.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const invocation = await parseAgentMuxCliInvocation(['agent', 'history', '--host', 'local', '--session', h.session.agentSessionId, '--source', 'native', '--limit', '1'])
  const replies: string[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page = await rpc.call('agent.history', { ...invocation.params, ...(cursor ? { cursor } : {}) } as any)
    for (const entry of page.items) if (entry.kind === 'item' && 'kind' in entry.item && entry.item.kind === 'assistant-message')
      replies.push(...entry.item.contentParts.filter(part => part.kind === 'text').map(part => part.text))
    cursor = page.nextCursor ?? undefined
    if (!cursor) break
  }
  expect(cursor).toBeUndefined(); expect(replies.sort()).toEqual(['Original reply A', 'Original reply B'])
  const inputs = await rpc.call('agent.history', { ...h.reference, source: 'native', kind: 'user-message' })
  expect(inputs.userMessages?.map(message => message.content).sort()).toEqual(['Original request A', 'Original request B'])
  expect(inputs.userMessages?.map(message => message.author.kind)).toEqual(['unknown', 'unknown'])
  const captured = await rpc.call('agent.history', { ...h.reference, source: 'captured', kind: 'user-message', limit: 1 })
  expect(captured.userMessages?.[0]?.source).toMatchObject({ kind: 'captured', channel: 'message-tool' })
  expect(captured.userMessages?.[0]?.author).toEqual({ kind: 'human' })
  expect(captured.nextCursor).not.toBeNull()
  for (const control of h.forbidden) expect(control).not.toHaveBeenCalled()
})
