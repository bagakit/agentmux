// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CapturedConversationMessage } from '../src/components/CapturedConversationMessage.js'
import { composeAgentPrompt, formatAmuxTriggerNote } from '@agentmux/core/agent-outbound-message'
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

it('reads a confirmed Capsule answer as its question and answer, links the original page and keeps the original wire', async () => {
  const { formatCapsuleAnswer } = await import('@agentmux/core/capsule')
  const wire = formatCapsuleAnswer({ capsuleId: 'Kd7mQ2xRb9Wp', interactionId: 'Q4nT8vHc2Jzs', question: 'Which icon?', answer: 'B, with a lighter shadow' })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); cleanup.push(() => { act(() => root.unmount()); host.remove() })
  const copy = vi.fn(async () => true)
  const links: string[] = []
  const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
    renderObjectLink: reference => { links.push(reference.uri); return <a data-object-link={reference.uri}>{reference.label}</a> } }
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage content={wire} speaker={{ role: 'human', id: 'human' }} messageId="input" onCopy={copy} /></ClientUiProvider>))
  const card = host.querySelector('.conversation-protocol')!
  expect(card.getAttribute('data-protocol-kind')).toBe('capsule-answer')
  expect(card.querySelector('.conversation-capsule-answer__question')?.textContent).toBe('Which icon?')
  expect(card.querySelector('.conversation-capsule-answer__answer')?.textContent).toBe('B, with a lighter shadow')
  expect(links).toEqual(['amux://capsule/Kd7mQ2xRb9Wp'])
  const visible = card.cloneNode(true) as HTMLElement
  visible.querySelector('details.conversation-protocol__original')?.remove()
  expect(visible.textContent).toContain('Which icon?')
  expect(visible.textContent).not.toMatch(/"capsuleId"|confirmed by|verified|approved/iu)
  expect(card.querySelector('details.conversation-protocol__original pre')?.textContent).toBe(wire)
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledWith(wire)
})

it.each(['heartbeat', 'calendar', 'automation'] as const)('reads the original %s from wire and from its captured public body', async kind => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); cleanup.push(() => { act(() => root.unmount()); host.remove() })
  const copy = vi.fn(async () => true)
  const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const body = 'Check the open requests.'
  const wire = composeAgentPrompt(body, formatAmuxTriggerNote(kind, 'Platform-only guidance.')).text
  const card = () => host.querySelector<HTMLElement>('[data-protocol-kind="' + kind + '"]')
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage content={wire} onCopy={copy} /></ClientUiProvider>))
  expect(card()?.textContent).toContain(body)
  expect(card()?.querySelector('details')?.open).toBe(false)
  expect(card()?.querySelector('details pre')?.textContent).toBe(wire)
  const item = { id: 'captured', agentSessionId: 'original', kind: 'user_message', status: 'complete', source: 'user',
    createdAt: 0, updatedAt: 0, title: 'Original input', publicContent: 'confirmed' } as const
  await act(async () => root.render(<ClientUiProvider platform={platform}><CapturedConversationMessage
    item={{ ...item, content: body, declaredTrigger: kind }} speaker={{ role: 'unknown' }} onCopy={copy} /></ClientUiProvider>))
  expect(card()?.textContent).toContain(body)
  expect(card()?.querySelector('.conversation-protocol__original')).toBeNull()
  expect(host.querySelector('.log-turn__who')?.textContent).toBe('自动触发')
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledWith(body)
  await act(async () => root.render(<ClientUiProvider platform={platform}><CapturedConversationMessage
    item={{ ...item, content: wire }} onCopy={copy} /></ClientUiProvider>))
  expect(card()).toBeNull()
})
