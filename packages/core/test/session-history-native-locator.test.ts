import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../src/types.js'

const roots: string[] = []
const clients: AgentMuxClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(reader: NonNullable<AgentProvider['readSessionHistoryPage']>, path?: string) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-locator-')); roots.push(root)
  const storePath = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'locator-session', providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: root, run: { runId: 'healthy-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main',
      ...(path === undefined ? {} : { transcriptPath: path }) }
  }
  await store.compareAndSwap(null, session)
  const provider = { ...new AgentProviderRegistry().get('claude'), readSessionHistoryPage: reader }
  const client = new AgentMuxClient({ store, providers: [provider] }); clients.push(client)
  return { client, store, storePath, session }
}

const result = (context: AgentProviderSessionHistoryContext) => ({ source: context.source, nextCursor: null,
  items: [{ id: 'actual-nonempty-history', kind: 'assistant-message' as const,
    contentParts: [{ kind: 'text' as const, text: 'existing native body' }] }] })

it('passes only the exact durable locator without Run actions or Store writes', async () => {
  const reader = vi.fn(async (context: AgentProviderSessionHistoryContext) => result(context))
  const { client, storePath, session } = await fixture(reader, '/private/exact-native.jsonl')
  const before = await readFile(storePath)
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) => vi.spyOn(kernel, name as 'start'))
  expect((await client.sessionHistoryPage(session.agentSessionId)).items).toHaveLength(1)
  expect(reader.mock.calls).toHaveLength(1)
  expect(reader.mock.calls[0]![0].transcriptPath).toBe('/private/exact-native.jsonl')
  for (const control of controls) expect(control).not.toHaveBeenCalled()
  expect(await readFile(storePath)).toEqual(before)
})

it('keeps a missing locator absent rather than deriving it from the workspace or home', async () => {
  const reader = vi.fn(async (context: AgentProviderSessionHistoryContext) => result(context))
  const { client, session } = await fixture(reader)
  expect((await client.sessionHistoryPage(session.agentSessionId)).items).toHaveLength(1)
  expect(reader.mock.calls[0]![0]).not.toHaveProperty('transcriptPath')
})

it('rejects a held page when only the durable transcript locator changed', async () => {
  let finish!: (value: ReturnType<typeof result>) => void
  let context!: AgentProviderSessionHistoryContext
  const { client, store, session } = await fixture(async (value) => {
    context = value
    return await new Promise((resolve) => { finish = resolve })
  }, '/private/original.jsonl')
  const request = client.sessionHistoryPage(session.agentSessionId)
  const rejected = expect(request).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const current = (await loadAgentSessions(store))[0]!
  await store.compareAndSwap(current, { ...current, updatedAt: 2,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main', transcriptPath: '/private/replaced.jsonl' } })
  finish(result(context))
  await rejected
})
