import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { normalizeSessionHistoryPage } from '../src/session-history.js'
import type { AgentProviderSessionHistoryPage, AgentSessionHistoryContentPart } from '../src/types.js'

const source = { providerId: 'codex', nativeSessionId: 'native-trace' }
const parts: AgentSessionHistoryContentPart[] = [
  { kind: 'text', text: 'Before' },
  { kind: 'reasoning', text: 'Observed reasoning' },
  { kind: 'tool-call', name: 'shell', input: '{"command":"check"}', callId: 'call-1' },
  { kind: 'tool-result', name: 'shell', output: 'failed output', callId: 'call-1', failed: true },
  { kind: 'resource', resourceType: 'image', reference: '/native/image.png' },
  { kind: 'text', text: 'After' }
]
const page = (contentParts: AgentSessionHistoryContentPart[] = parts): AgentProviderSessionHistoryPage => ({
  source, items: [{ id: 'mixed', kind: 'assistant-message', contentParts }], nextCursor: null
})

describe('native trace parts through the public history path', () => {
  it('retains an exact nonempty ordered mixed message without controlling its Run', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'trace-session', providerId: 'codex',
      executorId: 'codex', hostId: 'local', workspacePath: '/native', run: { runId: 'healthy-run' },
      retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'test', hookToken: 'test',
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId } })
    const before = await store.load()
    const base = new AgentProviderRegistry().get('codex')
    const client = new AgentMuxClient({ store, providers: [{ ...base, readSessionHistoryPage: async () => page() }] })
    try {
      // No connect/attach/start has occurred. Native history is a durable identity read.
      const result = await client.sessionHistoryPage('trace-session')
      expect(result.items).toEqual([{ id: 'mixed', kind: 'assistant-message', contentParts: parts }])
      expect(result.source).toEqual(source)
      expect(await store.load()).toEqual(before)
    } finally { await client.dispose() }
  })

  it('preserves absent native IDs and failure status instead of making them up', () => {
    const result = normalizeSessionHistoryPage(source, page([
      { kind: 'tool-call', name: 'check', input: '' },
      { kind: 'tool-result', output: '' },
      { kind: 'tool-result', output: 'ok', failed: false }
    ]), 10)
    expect(result.items[0]!.contentParts).toEqual([
      { kind: 'tool-call', name: 'check', input: '' },
      { kind: 'tool-result', output: '' },
      { kind: 'tool-result', output: 'ok', failed: false }
    ])
  })

  it.each([
    { kind: 'reasoning', text: 1 },
    { kind: 'tool-call', name: '', input: 'body' },
    { kind: 'tool-call', name: 'check', input: {} },
    { kind: 'tool-call', name: 'check', input: '', callId: '' },
    { kind: 'tool-result', output: 1 },
    { kind: 'tool-result', output: '', failed: 'true' },
    { kind: 'tool-result', output: '', name: '' }
  ])('rejects malformed trace part %j at the Core boundary', (part) => {
    expect(() => normalizeSessionHistoryPage(source, { ...page(),
      items: [{ id: 'bad', kind: 'activity', contentParts: [part] }] }, 10))
      .toThrow('invalid native history page')
  })
})
