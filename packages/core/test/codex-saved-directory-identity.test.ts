import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as sourceCore from '../src/index.js'
import * as sourceServer from '../src/public-rpc-server.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const selected = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const core = selected ? await import(/* @vite-ignore */ selected) as typeof sourceCore : sourceCore
const serverOwner = selected
  ? await import(/* @vite-ignore */ new URL('./public-rpc-server.js', selected).href) as typeof sourceServer : sourceServer
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(nativeUsesAlias = true) {
  const root = await mkdtemp(join(tmpdir(), 'amux-saved-directory-'))
  const physical = join(root, 'physical'), alias = join(root, 'alias'), other = join(root, 'other')
  await mkdir(physical); await mkdir(other); await symlink(physical, alias, 'dir')
  const path = join(root, 'original-native.jsonl'), storePath = join(root, 'sessions.json')
  const originalBody = 'Original native conversation body'
  const transcript = (cwd: string, nativeSessionId = 'original-native') => [
    { type: 'session_meta', payload: { id: nativeSessionId, cwd } },
    { type: 'response_item', payload: { id: 'original-record', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: originalBody }] } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  await writeFile(path, transcript(nativeUsesAlias ? alias : physical))
  const store = new core.AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: nativeUsesAlias ? physical : alias, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const client = new core.AgentMuxClient({ store }), kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach'].map(method => vi.spyOn(kernel, method as 'start'))
  const before = await readFile(storePath)
  const server = new serverOwner.AgentMuxControlServer({ socketPath: join(root, 'original.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  return { root, physical, alias, other, path, client, store, storePath, session, before, rpc, controls, originalBody, transcript,
    close: async () => { await rpc.dispose(); await server.stop(); await client.dispose(); await rm(root, { recursive: true, force: true }) } }
}

it.each([true, false])('reads the same physical execution directory through original SDK and public context without rewriting saved paths (native alias=%s)', async nativeUsesAlias => {
  const f = await fixture(nativeUsesAlias)
  try {
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
    expect(page.source).toEqual({ providerId: 'codex', nativeSessionId: 'original-native' })
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: f.originalBody }])
    const context = await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })
    expect(context.native!.items).toEqual(page.items)
    expect(context.unavailable.filter(item => item.source === 'native')).toEqual([])
    expect(context.descriptor.history!.workspacePath).toBe(f.session.workspacePath)
    expect(context.descriptor.history!.nativeHandle).toEqual(f.session.nativeHandle)
    expect(await readFile(f.storePath)).toEqual(f.before)
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('refuses another physical directory while preserving original identity, history and available work', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, f.transcript(f.other))
    await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    const context = await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })
    expect(context.native).toBeNull()
    expect(context.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'native', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })]))
    expect(context.session!.run).toEqual(f.session.run)
    expect(context.session!.nativeHandle).toEqual(f.session.nativeHandle)
    expect(await readFile(f.storePath)).toEqual(f.before)
    await writeFile(f.path, f.transcript(f.alias))
    expect((await f.client.sessionHistoryPage(f.session.agentSessionId)).items[0]!.contentParts).toEqual([{ kind: 'text', text: f.originalBody }])
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('keeps unreadable physical alias identity unknown without closing the original Agent or replacing its source', async () => {
  const f = await fixture()
  try {
    await rm(f.alias)
    await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    const context = await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })
    expect(context.native).toBeNull()
    expect(context.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'native', code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })]))
    expect(context.session!.run).toEqual(f.session.run)
    expect(await readFile(f.storePath)).toEqual(f.before)
    await symlink(f.physical, f.alias, 'dir')
    expect((await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })).native!.items[0]!.id).toBe('original-record')
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('does not use a directory alias to admit another native conversation', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, f.transcript(f.alias, 'another-native'))
    await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    expect(await readFile(f.storePath)).toEqual(f.before)
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})
