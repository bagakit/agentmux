import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

let root: Root, host: HTMLDivElement
const copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
async function render(props: Partial<ConversationMessageProps> = {}) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="message" content="Original body" {...props} /></ClientUiProvider>))
}
async function click(selector: string) { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
const collaboration = { kind: 'message', source: { providerId: 'codex', nativeSessionId: 'thread' }, sender: 'review/worker', recipient: 'review' } as const

it('keeps compact as a density choice for ordinary, system and collaboration cards with one Copy owner', async () => {
  for (const variant of [
    { speaker: { role: 'human', id: 'human' } },
    { speaker: { role: 'system', id: 'system' } },
    { nativeCollaboration: collaboration, recordedIdentity: true }
  ] satisfies Partial<ConversationMessageProps>[]) {
    await render({ ...variant, compact: true })
    expect(host.querySelector('.log-turn')?.getAttribute('data-compact')).toBe('true')
    expect(host.querySelectorAll('[title="Copy message"]')).toHaveLength(1)
    await click('[title="Copy message"]'); expect(copy).toHaveBeenLastCalledWith('Original body', expect.any(Function))
  }
})

it('resets system disclosure on the first frame of another source and keeps A-B-A isolated', async () => {
  const visible: boolean[] = []
  function Observed({ source }: { source: string }) {
    useLayoutEffect(() => { visible.push(host.querySelector('.log-turn__body') !== null) }, [source])
    return <ConversationMessage messageId="same-record" conversationSessionId={source} speaker={{ role: 'system', id: 'system' }} content="Original context" />
  }
  const show = async (source: string) => act(async () => root.render(<ClientUiProvider platform={platform}><Observed source={source} /></ClientUiProvider>))
  await show('source-a'); await click('.log-turn__system-toggle'); expect(host.querySelector('.log-turn__body')).not.toBeNull()
  await show('source-b'); await show('source-a')
  expect(visible).toEqual([false, false, false]); expect(host.querySelector('.log-turn__body')).toBeNull()
})

it('retains an opened collaboration body through folding and metadata changes, then drops it on a new source', async () => {
  const props = { nativeCollaboration: collaboration, recordedIdentity: true, conversationSessionId: 'source-a', content: '**Original** report' }
  await render(props); await click('.log-turn__collaboration-toggle')
  const body = host.querySelector('.log-turn__body')!, text = body.querySelector('strong')!, range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  await render({ ...props, status: 'complete', compact: true }); expect(host.querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.toString()).toBe('Original')
  await click('.log-turn__collaboration-toggle'); expect(body.closest('[hidden]')).not.toBeNull()
  await click('.log-turn__collaboration-toggle'); expect(host.querySelector('.log-turn__body')).toBe(body)
  await render({ ...props, conversationSessionId: 'source-b' }); expect(host.querySelector('.log-turn__body')).toBeNull()
  await render(props); expect(host.querySelector('.log-turn__body')).toBeNull()
  await render({ ...props, located: true }); expect(host.querySelector('.log-turn__body')).not.toBeNull()
  await click('.log-turn__collaboration-toggle'); expect(host.querySelector('.log-turn__collaboration-content')?.hasAttribute('hidden')).toBe(true)
})

it('places collaboration context once in Info when compact details and continuation overlap', async () => {
  await render({ nativeCollaboration: collaboration, compact: true, detailsOnlyMetadata: true, continuation: true, recordedIdentity: true,
    inputSource: { kind: 'native', providerId: 'codex', nativeSessionId: 'thread', recordId: 'message' } })
  await click('[aria-label="Message details"]')
  expect(host.querySelectorAll('.log-turn__input-source')).toHaveLength(1)
  expect(host.querySelector('.conversation-input-details__body .log-turn__input-source')).not.toBeNull()
  expect(host.querySelector('.log-turn__body')).toBeNull()
})
