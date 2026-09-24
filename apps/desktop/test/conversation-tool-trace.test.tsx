// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { describe, expect, it, vi } from 'vitest'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('conversation tool trace in the production message', () => {
  it('keeps observed identities/order and failure visible, with large payloads mounted only on demand', async () => {
    const input = JSON.stringify({ command: 'pnpm test', unneeded: 'raw-input-'.repeat(1000) })
    const output = 'raw-failure-'.repeat(1000)
    const parts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: 'Before tools' },
      { kind: 'tool-call', name: 'shell', input, callId: 'call-a' },
      { kind: 'tool-result', name: 'shell', output, callId: 'call-a', failed: true },
      { kind: 'tool-result', name: 'unknown_tool', output: 'opaque-result', callId: 'call-b' },
      { kind: 'text', text: 'After tools' }
    ]
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(ConversationMessage, { content: parts })))
      const traces = Array.from(host.querySelectorAll<HTMLElement>('.conversation-tool-trace'))
      expect(traces.map((row) => [row.dataset.traceKind, row.dataset.callId])).toEqual([
        ['tool-call', 'call-a'], ['tool-result', 'call-a'], ['tool-result', 'call-b']
      ])
      expect(traces.map((row) => row.dataset.status)).toEqual([undefined, 'failed', undefined])
      expect(traces[0]!.textContent).toContain('shell pnpm test')
      expect(traces[1]!.textContent).toContain('Failed')
      expect(traces[2]!.textContent).toContain('unknown_tool')
      expect(host.querySelectorAll('.conversation-tool-trace__payload')).toHaveLength(0)
      expect(host.textContent).not.toContain('raw-input-')
      expect(host.textContent).not.toContain('raw-failure-')
      const toggle = traces[0]!.querySelector<HTMLButtonElement>('button')!
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await act(async () => toggle.click())
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)).not.toBeNull()
      expect(traces[0]!.querySelector('pre')!.textContent).toBe(input)
      // A fresh native page changes object identities; callId keeps this disclosure attached to its call.
      await act(async () => root.render(createElement(ConversationMessage, { content: parts.map((part) => ({ ...part })) })))
      expect(host.querySelector('[data-call-id="call-a"] button')!.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector('pre')!.textContent).toBe(input)
      await act(async () => toggle.click())
      expect(host.querySelectorAll('.conversation-tool-trace__payload')).toHaveLength(0)
      const failed = host.querySelector<HTMLButtonElement>('[data-status="failed"] button')!
      await act(async () => failed.click())
      expect(host.querySelector('pre')!.textContent).toBe(output)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('does not summarize unknown inputs or invent result status', async () => {
    const content: AgentSessionHistoryContentPart[] = [
      { kind: 'tool-call', name: `mcp__unknown__${'long_name_'.repeat(12)}`, input: '{"description":"do not guess this"}' },
      { kind: 'tool-result', output: 'undetermined' }
    ]
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(ConversationMessage, { content })))
      const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.conversation-tool-trace__row'))
      expect(rows).toHaveLength(2)
      expect(rows[0]!.querySelector('.conversation-tool-trace__title')!.textContent!.length).toBeLessThanOrEqual(48)
      expect(rows[0]!.title).toBe(content[0]!.kind === 'tool-call' ? content[0]!.name : '')
      expect(host.textContent).not.toContain('do not guess this')
      expect(host.querySelector('[data-status]')).toBeNull()
      expect(rows[1]!.textContent).toContain('Tool result')
      await act(async () => rows[1]!.click())
      expect(host.querySelector('pre')!.textContent).toBe('undetermined')
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps disclosure on its observed call when reordered, without cross-expanding the result sharing its callId', async () => {
    const callA: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'shell', input: 'command A', callId: 'a' }
    const callB: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'shell', input: 'command B', callId: 'b' }
    const resultA: AgentSessionHistoryContentPart = { kind: 'tool-result', name: 'shell', output: 'result A', callId: 'a' }
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(ConversationMessage, { content: [callA, resultA, callB] })))
      expect([...host.querySelectorAll<HTMLElement>('.conversation-tool-trace')].map(row => [row.dataset.traceKind, row.dataset.callId])).toEqual([
        ['tool-call', 'a'], ['tool-result', 'a'], ['tool-call', 'b']
      ])
      await act(async () => host.querySelector<HTMLButtonElement>('[data-trace-kind="tool-call"][data-call-id="a"] button')!.click())
      await act(async () => root.render(createElement(ConversationMessage, { content: [{ ...callB }, { ...callA }, { ...resultA }] })))
      expect([...host.querySelectorAll<HTMLElement>('.conversation-tool-trace')].map(row => [row.dataset.traceKind, row.dataset.callId])).toEqual([
        ['tool-call', 'b'], ['tool-call', 'a'], ['tool-result', 'a']
      ])
      const expanded = [...host.querySelectorAll<HTMLElement>('.conversation-tool-trace')].filter(row => row.querySelector('button')!.getAttribute('aria-expanded') === 'true')
      expect(expanded).toHaveLength(1)
      expect(expanded[0]!.dataset.callId).toBe('a')
      expect(expanded[0]!.querySelector('pre')!.textContent).toBe('command A')
      expect(host.querySelector('[data-trace-kind="tool-result"] button')!.getAttribute('aria-expanded')).toBe('false')
      await act(async () => host.querySelector<HTMLButtonElement>('[data-trace-kind="tool-result"] button')!.click())
      expect([...host.querySelectorAll('pre')].map(item => item.textContent)).toEqual(['command A', 'result A'])
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
