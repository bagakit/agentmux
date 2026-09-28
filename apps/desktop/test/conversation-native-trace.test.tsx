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
    const labels = ['First answer', 'Reasoning', 'Tool call',
      'Tool result', 'Failed', '/native/image.png', 'Last answer']
    const positions = labels.map((label) => markup.indexOf(label))
    expect(positions).toHaveLength(7)
    expect(positions.every((value) => value >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(markup).not.toContain('Observed reasoning')
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

  it('renders reasoning disclosure for empty/redacted parts on DOM mount and omits signature and redacted content from copy', async () => {
    const contentParts: AgentSessionHistoryContentPart[] = [
      { kind: 'reasoning', text: '', signature: 'opaque-empty-sig' },
      { kind: 'reasoning', text: 'confidential thought', signature: 'opaque-redacted-sig', redacted: true },
      { kind: 'reasoning', text: 'Public thought' },
      { kind: 'text', text: 'Final message' }
    ]
    const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(ConversationMessage, { content: contentParts })))

      // All reasoning details disclosure elements exist in mounted DOM
      const detailsList = container.querySelectorAll<HTMLDetailsElement>('details[data-trace-kind="reasoning"]')
      expect(detailsList).toHaveLength(3)

      // Lazy contract: heavy payload is not mounted when closed
      expect(detailsList[0]!.querySelector('.log-turn__trace-payload')).toBeNull()
      expect(detailsList[1]!.querySelector('.log-turn__trace-payload')).toBeNull()
      expect(detailsList[2]!.querySelector('.log-turn__trace-payload')).toBeNull()

      // Item 0: empty text reasoning maintains disclosure; shows no reasoning recorded note; signature not displayed
      await act(async () => {
        detailsList[0]!.open = true
        detailsList[0]!.dispatchEvent(new Event('toggle'))
      })
      const pre0 = detailsList[0]!.querySelector('pre')
      expect(pre0).not.toBeNull()
      expect(pre0!.textContent).toBe('No reasoning text recorded.')
      expect(container.textContent).not.toContain('opaque-empty-sig')

      // Item 1: redacted reasoning shows redacted notice; confidential text and signature not displayed
      await act(async () => {
        detailsList[1]!.open = true
        detailsList[1]!.dispatchEvent(new Event('toggle'))
      })
      const pre1 = detailsList[1]!.querySelector('pre')
      expect(pre1).not.toBeNull()
      expect(pre1!.textContent).toBe('Reasoning content redacted.')
      expect(container.textContent).not.toContain('confidential thought')
      expect(container.textContent).not.toContain('opaque-redacted-sig')

      // Item 2: public thought renders Markdown
      await act(async () => {
        detailsList[2]!.open = true
        detailsList[2]!.dispatchEvent(new Event('toggle'))
      })
      const md2 = detailsList[2]!.querySelector('.log-turn__trace-body > p')
      expect(md2).not.toBeNull()
      expect(md2!.textContent).toBe('Public thought')
      expect(detailsList[2]!.querySelector('pre')).toBeNull()

      // Copy message: normal reasoning and text copied; signature and redacted content omitted
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')
      expect(button).not.toBeNull()
      await act(async () => button!.click())

      expect(write).toHaveBeenCalledOnce()
      const copiedText = write.mock.calls[0]![0]
      expect(copiedText).toContain('Public thought')
      expect(copiedText).toContain('Final message')
      expect(copiedText).not.toContain('confidential thought')
      expect(copiedText).not.toContain('opaque-empty-sig')
      expect(copiedText).not.toContain('opaque-redacted-sig')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      write.mockRestore()
    }
  })

  it('omits copy action for sole-empty or sole-redacted reasoning while preserving disclosure, and copies mixed content without placeholder dividers or trimming', async () => {
    const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      // 1. Sole empty reasoning: disclosure renders, but Copy button is absent, zero clipboard calls
      await act(async () => root.render(createElement(ConversationMessage, {
        content: [{ kind: 'reasoning', text: '', signature: 'opaque-sig' }]
      })))
      expect(container.querySelector('details[data-trace-kind="reasoning"]')).not.toBeNull()
      expect(container.querySelector('button[aria-label="Copy message"]')).toBeNull()

      // 2. Sole redacted reasoning: disclosure renders with redacted notice, Copy button absent, zero clipboard calls
      await act(async () => root.render(createElement(ConversationMessage, {
        content: [{ kind: 'reasoning', text: 'confidential', redacted: true }]
      })))
      const redactedDetails = container.querySelector<HTMLDetailsElement>('details[data-trace-kind="reasoning"]')
      expect(redactedDetails).not.toBeNull()
      await act(async () => {
        redactedDetails!.open = true
        redactedDetails!.dispatchEvent(new Event('toggle'))
      })
      expect(redactedDetails!.querySelector('pre')?.textContent).toBe('Reasoning content redacted.')
      expect(container.querySelector('button[aria-label="Copy message"]')).toBeNull()

      // 3. Mixture of empty and redacted reasoning with no readable text: Copy button absent
      await act(async () => root.render(createElement(ConversationMessage, {
        content: [
          { kind: 'reasoning', text: '', signature: 'sig1' },
          { kind: 'reasoning', text: 'hidden', redacted: true }
        ]
      })))
      expect(container.querySelectorAll('details[data-trace-kind="reasoning"]')).toHaveLength(2)
      expect(container.querySelector('button[aria-label="Copy message"]')).toBeNull()
      expect(write).not.toHaveBeenCalled()

      // 4. Mixed message with redacted reasoning and text preserving exact whitespace without empty divider
      await act(async () => root.render(createElement(ConversationMessage, {
        content: [
          { kind: 'reasoning', text: 'secret', redacted: true },
          { kind: 'text', text: '  preserved indented text  ' },
          { kind: 'reasoning', text: '' }
        ]
      })))
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')
      expect(button).not.toBeNull()
      await act(async () => button!.click())

      expect(write).toHaveBeenCalledOnce()
      expect(write).toHaveBeenCalledWith('  preserved indented text  ')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      write.mockRestore()
    }
  })
})
