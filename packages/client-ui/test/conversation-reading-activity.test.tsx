// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'

const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
const path = fixturePath('home/.agentmux/pasted/original.png')
let root: Root, host: HTMLDivElement, later: HTMLTextAreaElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); later = document.createElement('textarea')
  document.body.append(host, later); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); later.remove()
  window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals()
})
async function render(props: Partial<ConversationMessageProps>) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="original"
    speaker={{ role: 'agent', id: 'original-agent' }} content="Original body" {...props} /></ClientUiProvider>))
}

it.each(['text', 'reasoning', 'answer'] as const)('closes an embedded %s image on inactivity without replacing prose, rereading bytes or stealing later focus', async kind => {
  const text = `Original **selected** body @${path}`
  const read = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,original' }))
  const props: Partial<ConversationMessageProps> = { readPastedImage: read, content: kind === 'reasoning'
    ? [{ kind: 'reasoning', text }] : text, ...(kind === 'answer' ? { questionAnswers: [{ questionId: 'original-question', answer: text }] } : {}) }
  await render(props)
  if (kind === 'reasoning') {
    const details = host.querySelector<HTMLDetailsElement>('.log-turn__trace')!
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  }
  const prose = host.querySelector('strong')!, image = host.querySelector('.md-conversation-image__thumb')!
  expect(prose.textContent).toBe('selected'); expect(image).not.toBeNull(); expect(read).toHaveBeenCalledOnce()
  const range = document.createRange(); range.selectNodeContents(prose); window.getSelection()!.addRange(range)
  await act(async () => host.querySelector<HTMLButtonElement>('.md-conversation-image')!.click())
  expect(document.querySelector('.md-conversation-image__lightbox')).not.toBeNull()
  await render({ ...props, active: false })
  expect(document.querySelector('.md-conversation-image__lightbox')).toBeNull()
  later.focus()
  await render({ ...props, active: true })
  expect(document.querySelector('.md-conversation-image__lightbox')).toBeNull()
  expect(document.activeElement).toBe(later); expect(host.querySelector('strong')).toBe(prose)
  expect(host.querySelector('.md-conversation-image__thumb')).toBe(image)
  expect(window.getSelection()!.toString()).toBe('selected'); expect(read).toHaveBeenCalledOnce()
})

it('does not publish an inactive late image or start a new read until the reader is visible again', async () => {
  let finish!: (value: { dataUrl: string }) => void
  const read = vi.fn(() => new Promise<{ dataUrl: string }>(resolve => { finish = resolve }))
  const props = { content: `Original body @${path}`, readPastedImage: read }
  await render(props); expect(read).toHaveBeenCalledOnce()
  await render({ ...props, active: false })
  await act(async () => finish({ dataUrl: 'data:image/png;base64,late' }))
  expect(host.querySelector('img')).toBeNull(); expect(read).toHaveBeenCalledOnce()
  await render(props); expect(read).toHaveBeenCalledTimes(2)
  await act(async () => finish({ dataUrl: 'data:image/png;base64,current' }))
  expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,current')
})
