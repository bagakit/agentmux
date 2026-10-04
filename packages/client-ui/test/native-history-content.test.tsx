import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { contentFixture, originalBody, record } from './fixtures/native-history-content/content.js'

let root: Root, container: HTMLDivElement
const copy = vi.fn(async (_value: string) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text) || button.getAttribute('aria-label') === text)
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
it('preserves surrounding context, exact tool semantics, bounded chunks, and complete mixed-message Copy', async () => {
  const tool = contentFixture({ kind: 'tool-result', name: 'inspect', callId: 'exact-call', failed: true, output: originalBody })
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="original-record" name="Assistant"
    content={[{ kind: 'text', text: 'Before' }, tool.part, { kind: 'text', text: 'After' }]} status="complete" createdAt={1} nativeResourceRecord={record} readHistoryResource={tool.read} /></ClientUiProvider>))
  expect(tool.requests).toHaveLength(0); expect(container.textContent).toContain('Before'); expect(container.textContent).toContain('After')
  await click('Read complete content')
  expect(tool.requests.length).toBeGreaterThan(1)
  expect(tool.requests.every(request => request.maxBytes === 128 * 1024)).toBe(true)
  expect(container.querySelector('[data-trace-kind="tool-result"]')?.getAttribute('data-call-id')).toBe('exact-call')
  expect(container.textContent).toContain('Failed')
  await click('Tool result'); expect(container.querySelector('pre')?.textContent).toBe(originalBody)
  await click('Copy complete content'); expect(copy.mock.calls.at(-1)?.[0]).toBe(originalBody)
  await click('Copy message'); expect(copy.mock.calls.at(-1)?.[0] === 'Before\ninspect\n' + originalBody + '\nAfter').toBe(true)
})
it('keeps long text as speech, leaves short text directly visible, and retries failure without losing context', async () => {
  const text = contentFixture({ kind: 'text', text: 'BEGIN 中文🙂 ' + 'Original words. '.repeat(15_000) + ' END 原文' })
  text.failNext()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="original-record" content={[text.part]} status="complete" createdAt={1} nativeResourceRecord={record} readHistoryResource={text.read} /></ClientUiProvider>))
  expect(container.querySelector('.log-turn--trace-only')).toBeNull()
  await click('Read complete content'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Original source temporarily unavailable')
  await click('Retry complete content'); expect(container.querySelector('.log-turn__text')?.textContent).toContain('END 原文')
  await click('Close content'); expect(container.querySelector('.log-turn__text')).toBeNull()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="short" content="Original short answer" status="complete" createdAt={1} /></ClientUiProvider>))
  expect(container.textContent).toContain('Original short answer'); expect(container.querySelector('.conversation-resource-text')).toBeNull()
})
it('whole-message Copy never copies a resource reference when original content cannot be read', async () => {
  const text = contentFixture({ kind: 'text', text: 'Original body' }); text.failNext()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="original-record" content={[text.part]} status="complete" createdAt={1} nativeResourceRecord={record} readHistoryResource={text.read} /></ClientUiProvider>))
  await click('Copy message'); expect(copy).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporarily unavailable')
  await click('Copy message'); expect(copy).toHaveBeenLastCalledWith('Original body', expect.any(Function))
})
it('changing source while a fragment is pending stops later reads and prevents stale body publication', async () => {
  const text = contentFixture({ kind: 'text', text: originalBody }), first = vi.fn(text.read)
  let release: (() => void) | undefined
  const blocked = vi.fn(async (input: Parameters<typeof text.read>[0]) => { await new Promise<void>(resolve => { release = resolve }); return first(input) })
  const render = (id: string, reader = blocked) => <ClientUiProvider platform={platform}><ConversationMessage messageId={id} content={[text.part]} status="complete" createdAt={1} nativeResourceRecord={{ ...record, recordId: id }} readHistoryResource={reader} /></ClientUiProvider>
  await act(async () => root.render(render('original-record')))
  await act(async () => container.querySelector<HTMLButtonElement>('.conversation-resource-text button')!.click())
  expect(blocked).toHaveBeenCalledTimes(1)
  await act(async () => root.render(render('new-record')))
  await act(async () => release!())
  expect(blocked).toHaveBeenCalledTimes(1); expect(container.textContent).not.toContain('BEGIN 原文')
})
