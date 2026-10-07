// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { useConversationTraceDisclosure, type ConversationTraceDisclosure } from '@agentmux/client-ui/conversation-trace-disclosure'

let host: HTMLDivElement, root: Root
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const page = (nativeSessionId = 'source-a'): AgentSessionHistoryPage => ({ agentSessionId: 'original-session',
  source: { providerId: 'reading-provider', nativeSessionId }, nextCursor: null, items: [
    { id: 'human', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Keep the original human input.' }] },
    { id: 'process', kind: 'activity', contentParts: [
      { kind: 'reasoning', text: 'Original private reasoning body.' },
      { kind: 'tool-result', name: 'inspect', callId: 'original-call', output: 'Original exact tool output.', failed: true }
    ] },
    { id: 'answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'The original answer remains readable.' }] }
  ] })
const activity = (source = page()) => <ActivityView sessionId={source.agentSessionId} executionHostId="original-host"
  nativeHistoryPage={source} items={[]} capability="complete-events" />
const render = async (node: ReactNode) => { await act(async () => root.render(node)); await tick() }
const click = async (node: HTMLElement) => { expect(node).not.toBeNull(); await act(async () => node.click()); await tick() }
const collapse = (scope: ParentNode = host) => scope.querySelector<HTMLButtonElement>('[aria-label="收起已展开的过程详情"]')!
async function expand(scope: ParentNode = host) {
  await click(scope.querySelector<HTMLButtonElement>('.wf-head')!)
  await click(scope.querySelector<HTMLButtonElement>('[data-observation-step-id]')!)
  const reasoning = scope.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  await act(async () => { reasoning.open = true; reasoning.dispatchEvent(new Event('toggle')) }); await tick()
  await click(scope.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!)
}

it('collapses the real Activity process payloads while keeping the original answers, failure summaries, Range and lazy reopen', async () => {
  const reads = vi.spyOn(api.sessions, 'historyPage')
  await render(activity()); expect((collapse().getAttribute('aria-disabled') === 'true')).toBe(true)
  expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull()
  await expand(); expect((collapse().getAttribute('aria-disabled') === 'true')).toBe(false)
  const answer = host.querySelector('[data-native-record-id="answer"] .log-turn__text p')!
  const text = answer.firstChild!, range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 12); getSelection()!.addRange(range)
  const pointer = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await act(async () => collapse().dispatchEvent(pointer)); expect(pointer.defaultPrevented).toBe(true)
  await click(collapse())
  expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull()
  expect(host.querySelector('.log-turn__trace-payload')).toBeNull()
  expect(host.querySelector('.conversation-tool-trace__failure')!.textContent).toBe('Failed')
  expect(host.querySelector('.wf-head')!.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('[data-native-record-id="answer"] .log-turn__text p')).toBe(answer)
  expect(host.textContent).toContain('Keep the original human input.')
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('original')
  expect((collapse().getAttribute('aria-disabled') === 'true')).toBe(true)
  await click(host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!)
  expect(host.querySelector('.conversation-tool-trace__payload pre')!.textContent).toBe('Original exact tool output.')
  expect(host.querySelector('.log-turn__trace-payload')).toBeNull()
  expect(reads).not.toHaveBeenCalled()
})

it('preserves current expansion and answer nodes on unrelated append, resetting only the exact source episode', async () => {
  const original = page(); await render(activity(original)); await expand()
  const payload = host.querySelector('.conversation-tool-trace__payload'), answer = host.querySelector('[data-native-record-id="answer"]')
  await render(activity({ ...original, items: [...original.items, { id: 'later', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Another loaded answer.' }] }] }))
  expect(host.querySelector('.conversation-tool-trace__payload')).toBe(payload); expect(host.querySelector('[data-native-record-id="answer"]')).toBe(answer)
  await render(activity(page('source-b')))
  expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull(); expect((collapse().getAttribute('aria-disabled') === 'true')).toBe(true)
  await render(activity(original)); expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull(); expect((collapse().getAttribute('aria-disabled') === 'true')).toBe(true)
})

it('prunes unmounted loaded disclosures and leaves another workface expanded', async () => {
  const original = page()
  const both = (first = original) => <><section id="first">{activity(first)}</section><section id="second">{activity(page('other-source'))}</section></>
  await render(both()); const first = host.querySelector('#first')!, second = host.querySelector('#second')!
  await expand(first); await expand(second); await click(collapse(first))
  expect(first.querySelector('.conversation-tool-trace__payload')).toBeNull(); expect(second.querySelector('.conversation-tool-trace__payload')).not.toBeNull()
  await click(first.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!)
  await render(both({ ...original, items: original.items.filter(item => item.id !== 'process') }))
  await render(both()); await click(first.querySelector<HTMLButtonElement>('.wf-head')!); await click(first.querySelector<HTMLButtonElement>('[data-observation-step-id]')!)
  expect(first.querySelector('.conversation-tool-trace__payload')).toBeNull()
  expect(second.querySelector('.conversation-tool-trace__payload')).not.toBeNull()
})

it('returns focus from the removed payload and rejects a late real clipboard acknowledgement after collapse and reopen', async () => {
  let acknowledge!: () => void
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
  await render(activity()); await expand()
  const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy tool output"]')!; copy.focus(); await click(copy)
  expect(copy.getAttribute('data-copy-state')).toBe('copying')
  await click(collapse()); expect(document.activeElement).toBe(collapse()); expect(copy.isConnected).toBe(false)
  await click(host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!)
  const next = host.querySelector<HTMLButtonElement>('[aria-label="Copy tool output"]')!; expect(next).not.toBe(copy)
  await act(async () => acknowledge()); expect(next.getAttribute('data-copy-state')).toBe('idle')
  expect(clipboard).toHaveBeenCalledExactlyOnceWith('Original exact tool output.')
})

it('keeps the original reading anchor and pauses follow before a loaded append', async () => {
  let height = 1200
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('activity-feed') ? height : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('activity-feed') ? 300 : 0 })
  const original = page(); await render(activity(original)); await expand()
  const feed = host.querySelector<HTMLElement>('.activity-feed')!; feed.scrollTop = 240
  vi.spyOn(feed, 'getBoundingClientRect').mockReturnValue({ top: 10, height: 300, bottom: 310 } as DOMRect)
  const answer = host.querySelector<HTMLElement>('[data-native-record-id="answer"]')!; let top = 40
  vi.spyOn(answer, 'getBoundingClientRect').mockImplementation(() => ({ top, height: 80, bottom: top + 80 } as DOMRect))
  // Closing preceding loaded details moves the retained answer; the original anchor restores its offset.
  const close = collapse(), key = Object.keys(close).find(key => key.startsWith('__reactProps$'))!
  const handler = (close as unknown as Record<string, { onClick(event: { currentTarget: HTMLElement }): void }>)[key]!.onClick
  await act(async () => { handler({ currentTarget: close }); top = 20 }); await tick()
  expect(feed.scrollTop).toBe(220)
  height = 1800; await render(activity({ ...original, items: [...original.items, { id: 'append', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Newly loaded original answer.' }] }] }))
  expect(feed.scrollTop).toBe(220)
})

it('rejects a retained disclosure handler across source A-B-A without preventing the current single toggle', async () => {
  let current!: ConversationTraceDisclosure
  function Reader({ source }: { source: string }) {
    current = useConversationTraceDisclosure(source)
    useLayoutEffect(() => {
      const owner = current, token = {}
      owner.register(token, ['original-trace'])
      return () => owner.register(token, null)
    }, [current.register])
    return <output>{current.expandedTraces.size}</output>
  }
  await render(<Reader source="a" />); const original = current, stale = current.onToggleTrace
  await act(async () => stale('original-trace', true)); expect(host.textContent).toBe('1')
  await render(<Reader source="b" />); await render(<Reader source="a" />)
  await act(async () => stale('original-trace', true)); expect(host.textContent).toBe('0')
  await act(async () => current.onToggleTrace('original-trace', true)); expect(host.textContent).toBe('1')
  await act(async () => { original.register({}, ['original-trace']); stale('original-trace', false) })
  expect(host.textContent).toBe('1')
})
