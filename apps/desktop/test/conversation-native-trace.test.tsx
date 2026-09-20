// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentProviderRegistry, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage.js'
import { api } from '../src/renderer/src/lib/api.js'
import type { AgentSessionHistoryContentPart } from '@agentmux/core'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('shared conversation trace rendering', () => {
  it('preserves agent identity and exact block order in a mixed message', () => {
    const content: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: 'First answer' },
      { kind: 'reasoning', text: 'Observed reasoning' },
      { kind: 'tool-call', name: 'shell', input: 'check <input>', callId: 'native-call' },
      { kind: 'tool-result', name: 'shell', output: 'Failed <output>', failed: true },
      { kind: 'resource', resourceType: 'image', reference: '/native/image.png' },
      { kind: 'text', text: 'Last answer' }
    ]
    const markup = renderToStaticMarkup(createElement(ConversationMessage, {
      speaker: { role: 'agent', id: 'agent-one' }, name: 'Agent one', content
    }))
    expect(markup).toContain('data-speaker-role="agent"')
    expect(markup).toContain('Agent one')
    const labels = ['First answer', 'Reasoning', 'Observed reasoning', 'Tool call',
      'Tool result', 'Failed', '/native/image.png', 'Last answer']
    const positions = labels.map((label) => markup.indexOf(label))
    expect(positions).toHaveLength(8)
    expect(positions.every((value) => value >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(markup).toContain('data-trace-kind="tool-result" data-status="failed"')
    expect(markup).not.toContain('check &lt;input&gt;')
    expect(markup).not.toContain('Failed &lt;output&gt;')
    expect(markup).toContain('Copy message')
    expect(markup).not.toContain('log-turn__time')
  })

  it('does not fabricate success or failure for an outcome with no status', () => {
    const markup = renderToStaticMarkup(createElement(ConversationMessage, {
      content: [{ kind: 'tool-result', output: 'Native result' }]
    }))
    expect(markup).toContain('data-trace-kind="tool-result"')
    expect(markup).toContain('Tool result')
    expect(markup).not.toContain('Native result')
    expect(markup).not.toContain('data-status=')
    expect(markup).not.toContain('Failed')
  })

  it('copies the ordered public Client page through the actual message button', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'public-trace', providerId: 'codex',
      executorId: 'codex', hostId: 'local', workspacePath: '/native', run: { runId: 'healthy-run' },
      retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'test', hookToken: 'test',
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-main' } })
    const contentParts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: 'First' }, { kind: 'reasoning', text: 'Reason' },
      { kind: 'tool-call', name: 'shell', input: 'check' },
      { kind: 'tool-result', name: 'shell', output: 'result' },
      { kind: 'resource', resourceType: 'image', reference: '/native/image.png' },
      { kind: 'text', text: 'Last' }
    ]
    const client = new AgentMuxClient({ store, providers: [{ ...new AgentProviderRegistry().get('codex'),
      readSessionHistoryPage: async () => ({ source: { providerId: 'codex', nativeSessionId: 'native-main' },
        items: [{ id: 'mixed', kind: 'assistant-message', contentParts }], nextCursor: null }) }] })
    const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      const page = await client.sessionHistoryPage('public-trace')
      expect(page.items).toHaveLength(1)
      await act(async () => root.render(createElement(ConversationMessage, { content: page.items[0]!.contentParts })))
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')
      expect(button).not.toBeNull()
      await act(async () => button!.click())
      expect(write).toHaveBeenCalledExactlyOnceWith('First\nReason\nshell\ncheck\nshell\nresult\n/native/image.png\nLast')
      expect(container.querySelector('[aria-label="Message copied"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      write.mockRestore()
      await client.dispose()
    }
  })
})
