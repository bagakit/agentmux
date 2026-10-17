// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

it('the real shared message displays standalone protocols and copies original wire', async () => {
  const wire = '<amux:future note="Long &amp; readable">Original &unknown; body.</amux:future>'
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); cleanup.push(() => { act(() => root.unmount()); host.remove() })
  const copy = vi.fn(async () => true)
  const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage content={wire} speaker={{ role: 'human', id: 'human' }} messageId="input" onCopy={copy} /></ClientUiProvider>))
  expect(host.querySelector('.conversation-protocol')?.getAttribute('data-protocol-kind')).toBe('generic')
  expect(host.querySelector('dd')?.textContent).toBe('Long & readable')
  expect(host.querySelector('.conversation-protocol__body')?.textContent).toBe('Original &unknown; body.')
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!
  expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(copy).toHaveBeenCalledWith(wire)
})
