import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { contentFixture, record } from './fixtures/native-history-content/content.js'

let root: Root, host: HTMLDivElement
const copy = vi.fn<ClientUiPlatform['copyText']>()
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockReset(); copy.mockResolvedValue(true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
async function click(label: string) { expect(button(label)).not.toBeNull(); await act(async () => button(label).click()) }
async function render(props: Partial<ConversationMessageProps> = {}) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="message" speaker={{ role: 'agent', id: 'original-agent' }} content="Original body" {...props} /></ClientUiProvider>))
}
function pending() {
  const attempts: { text: string; error(error: unknown): void; resolve(accepted: boolean): void }[] = []
  copy.mockImplementation((text, error) => new Promise<boolean>(resolve => attempts.push({ text, error, resolve })))
  return attempts
}
function deferredBody() {
  const fixture = contentFixture({ kind: 'text', text: 'Complete original body' })
  let release!: () => void
  const read = vi.fn(async (input: Parameters<typeof fixture.read>[0]) => { await new Promise<void>(resolve => { release = resolve }); return fixture.read(input) })
  return { part: fixture.part, read, release: () => release() }
}
function retained(label: string) {
  const node = button(label), key = Object.keys(node).find(key => key.startsWith('__reactProps$'))!
  return (node as unknown as Record<string, { onClick(): void }>)[key]!.onClick
}

it('keeps message and Agent ID feedback independent, including late failure and retry', async () => {
  const attempts = pending(); await render(); await click('Copy message'); await click('Copy Agent ID')
  expect(attempts.map(item => item.text)).toEqual(['Original body', 'original-agent'])
  await act(async () => attempts[1]!.resolve(true)); expect(button('Agent ID copied')).not.toBeNull()
  await act(async () => attempts[0]!.resolve(true)); expect(button('Message copied')).not.toBeNull(); expect(button('Agent ID copied')).not.toBeNull()
  await act(async () => attempts[0]!.error(new Error('Message clipboard refused')))
  expect(host.querySelector('.log-turn__actions')?.getAttribute('data-copy-state')).toBe('failed')
  expect(button('Agent ID copied')).not.toBeNull()
  await click('Copy message'); await act(async () => attempts[2]!.resolve(true))
  await act(async () => attempts[0]!.error(new Error('Obsolete failure')))
  expect(button('Message copied')).not.toBeNull(); expect(button('Agent ID copied')).not.toBeNull()
})

it('lets a later Agent ID intent cancel unfinished full-message preparation', async () => {
  const body = deferredBody(); await render({ content: [body.part], nativeResourceRecord: record, readHistoryResource: body.read })
  await click('Copy message'); expect(body.read).toHaveBeenCalledOnce(); expect(copy).not.toHaveBeenCalled()
  await click('Copy Agent ID'); await act(async () => body.release())
  expect(copy).toHaveBeenCalledExactlyOnceWith('original-agent', expect.any(Function))
  expect(button('Agent ID copied')).not.toBeNull(); expect(host.querySelector('.log-turn__actions')?.getAttribute('data-copy-state')).toBe('idle')
})

it('lets a nested part Copy cancel unfinished full-message preparation without clearing its own receipt', async () => {
  const body = deferredBody(); await render({ content: [{ kind: 'tool-call', name: 'inspect', input: 'Original tool input' }, body.part], nativeResourceRecord: record, readHistoryResource: body.read })
  await act(async () => host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!.click())
  await click('Copy message'); await click('Copy tool input'); await act(async () => body.release())
  expect(copy).toHaveBeenCalledExactlyOnceWith('Original tool input', expect.any(Function))
  expect(button('Copy tool input').textContent).toContain('Copied')
})

it('does not cancel already dispatched clipboard writes or let one action clear another result', async () => {
  const attempts = pending(); await render(); await click('Copy message'); await click('Copy Agent ID')
  await act(async () => attempts[1]!.resolve(true)); await act(async () => attempts[0]!.resolve(false))
  expect(button('Agent ID copied')).not.toBeNull(); expect(host.querySelector('.log-turn__actions')?.getAttribute('data-copy-state')).toBe('failed')
})

it('honors the original copy override and requires the host receipt to confirm success', async () => {
  const onCopy = vi.fn(async () => false)
  await render({ copyText: 'Exact wire', onCopy }); await click('Copy message')
  expect(onCopy).toHaveBeenCalledExactlyOnceWith('Exact wire'); expect(copy).not.toHaveBeenCalled()
  expect(host.querySelector('.log-turn__actions')?.getAttribute('data-copy-state')).toBe('failed')
  onCopy.mockResolvedValue(true); await click('Copy message'); expect(button('Message copied')).not.toBeNull()
})

it.each(['source', 'hidden', 'unmount'] as const)('discards pending preparation and retained handlers after %s', async change => {
  const body = deferredBody(), props = { content: [body.part], nativeResourceRecord: record, readHistoryResource: body.read }
  await render(props); const oldCopy = retained('Copy message'); await click('Copy message')
  if (change === 'unmount') await act(async () => root.render(null))
  else await render({ ...props, ...(change === 'source' ? { conversationSessionId: 'other-session' } : { active: false }) })
  await act(async () => { oldCopy(); body.release() })
  expect(copy).not.toHaveBeenCalled(); expect(body.read).toHaveBeenCalledOnce()
})

it('ignores stale receipts after identical message IDs move to a different source', async () => {
  const attempts = pending(); await render({ conversationSessionId: 'source-a' }); await click('Copy message'); await click('Copy Agent ID')
  await render({ conversationSessionId: 'source-b' }); expect(button('Copy message')).not.toBeNull(); expect(button('Copy Agent ID')).not.toBeNull()
  await act(async () => { attempts[0]!.resolve(true); attempts[1]!.resolve(true); attempts[0]!.error('Old source') })
  expect(button('Message copied')).toBeNull(); expect(button('Agent ID copied')).toBeNull(); expect(host.querySelector('[role="alert"]')).toBeNull()
})

it('keeps a failed full-text read visible when another action succeeds', async () => {
  const body = contentFixture({ kind: 'text', text: 'Complete original body' }); body.failNext()
  await render({ content: [body.part], nativeResourceRecord: record, readHistoryResource: body.read })
  await click('Copy message'); expect(host.querySelector('.log-turn__copy-error')?.textContent).toContain('temporarily unavailable')
  await click('Copy Agent ID')
  expect(button('Agent ID copied')).not.toBeNull(); expect(host.querySelector('.log-turn__copy-error')?.textContent).toContain('temporarily unavailable')
})

it('expires each success on its own timer without clearing another action or a newer failure', async () => {
  vi.useFakeTimers(); const attempts = pending(); await render(); await click('Copy message')
  await act(async () => attempts[0]!.resolve(true)); await act(async () => vi.advanceTimersByTime(800))
  await click('Copy Agent ID'); await act(async () => attempts[1]!.resolve(true))
  await act(async () => vi.advanceTimersByTime(800))
  expect(button('Copy message')).not.toBeNull(); expect(button('Agent ID copied')).not.toBeNull()
  await click('Copy message'); await act(async () => attempts[2]!.resolve(false))
  await act(async () => vi.advanceTimersByTime(800))
  expect(button('Copy Agent ID')).not.toBeNull(); expect(host.querySelector('.log-turn__actions')?.getAttribute('data-copy-state')).toBe('failed')
})
