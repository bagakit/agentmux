import { afterEach, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { consumeConversationWindowPage, projectConversationWindow, type ConversationTimelineReadInput, type ConversationWindowAssembly, type AgentConversationReadPage, type ConversationWindowSnapshot } from '../src/conversation.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let i = 0; i < 200; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending; cursor = page.nextCursor!
  }
  throw new Error('The original frame did not finish within its bounded wire pages')
}

it('an older page keeps the live version of a captured record the window already accepted', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original-0', sessionId: 'native-main', message: { role: 'user', content: 'Native body' } }])); closes.push(f.close)
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, input = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const write = (index: number, status: 'streaming' | 'complete' = 'complete', content = 'Captured body ' + index) => store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId,
    item: { id: 'captured-' + index, agentSessionId: ref.agentSessionId, kind: 'tool_call', source: 'native-hook', status, title: 'Task', content, createdAt: index + 1, updatedAt: index + 1 } })
  for (let index = 0; index < 150; index++) await write(index, index === 40 ? 'streaming' : 'complete', index === 40 ? 'Running task' : undefined)
  const read = (cursor?: string) => complete(value => client.readAgentConversation(value), { ...input, ...(cursor ? { cursor } : {}) })
  const items = (snapshot: ConversationWindowSnapshot) => new Map(projectConversationWindow(snapshot).captured.items.map(item => [item.id, item]))
  const opened = await read()
  // A long-running tool call outside the first page finishes while the window is open.
  await write(40, 'complete', 'Task finished')
  const live = await complete(value => client.readConversationChanges({ ...value, checkpoint: opened.window.checkpoint, view: opened.window.view! }), input)
  expect(items(live).get('captured-40')).toMatchObject({ content: 'Task finished' })
  // The older page was frozen before the update, so it still holds the running version.
  const older = await read(live.window.navigation.older!)
  expect(items(older).get('captured-40')).toMatchObject({ content: 'Task finished' })
  expect(items(older).has('captured-0')).toBe(true)
  // Reading back down keeps the accepted version too.
  if (older.window.navigation.newer) expect(items(await read(older.window.navigation.newer)).get('captured-40')).toMatchObject({ content: 'Task finished' })
}, 60000)
