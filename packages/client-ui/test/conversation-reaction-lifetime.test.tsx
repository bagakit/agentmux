// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationReplySource, PromptReactionDefinition } from '@agentmux/core/prompt-reaction'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationReactionActions, type ConversationReactionSend } from '../src/components/ConversationReactionActions.js'

const floating = vi.hoisted(() => ({ starts: 0, stops: 0, active: 0, computes: 0, held: 0,
  delay: null as (() => Promise<void>) | null }))
vi.mock('@floating-ui/dom', async importOriginal => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...actual,
    autoUpdate: (...args: Parameters<typeof actual.autoUpdate>) => {
      const dispose = actual.autoUpdate(...args)
      floating.starts++; floating.active++
      return () => { dispose(); floating.stops++; floating.active-- }
    },
    computePosition: async (...args: Parameters<typeof actual.computePosition>) => {
      floating.computes++
      const result = await actual.computePosition(...args)
      if (floating.delay) { floating.held++; await floating.delay() }
      return result
    }
  }
})

const definition: PromptReactionDefinition = { id: 'original-definition', keyword: 'ok', label: 'Acknowledge', body: 'Original saved meaning', reactionIcon: 'check' }
const source: ConversationReplySource = { kind: 'captured', agentSessionId: 'original-session', recordId: 'original-reply' }
const platform: ClientUiPlatform = { overlayContainer: () => document.body, copyText: async () => true,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
let location: HTMLDivElement, host: HTMLDivElement, root: Root
let onSend: ReturnType<typeof vi.fn<ConversationReactionSend>>
let releasePending: (() => void) | undefined

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.assign(floating, { starts: 0, stops: 0, active: 0, computes: 0, held: 0, delay: null })
  onSend = vi.fn<ConversationReactionSend>(async () => true)
  location = document.createElement('div'); host = document.createElement('div')
  location.append(host); document.body.append(location); root = createRoot(host)
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    <p data-original-body>Original retained reply</p>
    <textarea data-original-draft defaultValue="Original unsent draft" />
    <ConversationReactionActions definitions={[definition]} source={source} onSend={onSend} />
  </ClientUiProvider>))
})
afterEach(async () => {
  floating.delay = null; releasePending?.(); releasePending = undefined
  await act(async () => root.unmount()); location.remove()
  expect(floating.active).toBe(0)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function retained() {
  const body = host.querySelector<HTMLElement>('[data-original-body]')!, draft = host.querySelector<HTMLTextAreaElement>('[data-original-draft]')!
  const button = host.querySelector<HTMLButtonElement>('[aria-label="回复：Acknowledge"]')!
  draft.value = 'Original edited draft'
  return { body, draft, button }
}
function expectRetained(original: ReturnType<typeof retained>, connected = true) {
  expect(host.querySelector('[data-original-body]')).toBe(original.body)
  expect(host.querySelector('[data-original-draft]')).toBe(original.draft)
  expect(host.querySelector('[aria-label="回复：Acknowledge"]')).toBe(original.button)
  expect(original.body.isConnected).toBe(connected)
  expect(original.draft.value).toBe('Original edited draft')
  expect(original.button.disabled).toBe(false)
}
async function change(action: () => void) {
  await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function open(button: HTMLButtonElement, hover = false) {
  await act(async () => { if (hover) button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); else button.focus() })
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[role="tooltip"]')?.style.visibility).toBe('visible'))
  const hint = document.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(host.contains(hint)).toBe(false)
  expect(button.getAttribute('aria-describedby')).toBe(hint.id)
  expect(floating.active).toBe(1)
  return hint
}
async function expectClosed(original: ReturnType<typeof retained>, connected = true) {
  await vi.waitFor(() => {
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(floating.active).toBe(0)
  })
  expect(original.button.hasAttribute('aria-describedby')).toBe(false)
  expectRetained(original, connected)
  expect(onSend).not.toHaveBeenCalled()
}
async function reuse(original: ReturnType<typeof retained>, hover = false) {
  await act(async () => original.button.blur())
  await open(original.button, hover)
  await act(async () => original.button.click())
  expect(onSend).toHaveBeenCalledExactlyOnceWith(definition, source, expect.any(Function))
  expect(onSend.mock.calls[0]![1]).toBe(source)
  expectRetained(original)
}

it.each(['hidden', 'inert', 'aria-hidden'] as const)('an open reaction tooltip closes and releases positioning when its original ancestor becomes %s', async attribute => {
  const original = retained(), hover = attribute === 'inert'
  await open(original.button, hover)
  const starts = floating.starts, stops = floating.stops
  await change(() => location.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : ''))
  await expectClosed(original)
  expect(floating.stops).toBe(stops + 1)
  const computes = floating.computes
  await change(() => window.dispatchEvent(new Event('resize')))
  expect(floating.computes).toBe(computes)
  expect(floating.starts).toBe(starts)
  await change(() => location.removeAttribute(attribute))
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await reuse(original, !hover)
})

it('disconnecting the original retained location closes only its tooltip and permits reuse after reconnection', async () => {
  const original = retained()
  await open(original.button)
  await change(() => location.remove())
  await expectClosed(original, false)
  expect(floating.stops).toBe(1)
  await change(() => document.body.append(location))
  expectRetained(original)
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await reuse(original, true)
})

it('closed choices and unrelated DOM attributes perform no reaction geometry or sending', async () => {
  const original = retained(), unrelated = document.createElement('div'); document.body.append(unrelated)
  try {
    await change(() => { location.setAttribute('hidden', ''); unrelated.setAttribute('inert', '') })
    await change(() => { location.removeAttribute('hidden'); location.setAttribute('data-unrelated', 'closed') })
    expect(floating.starts).toBe(0); expect(floating.computes).toBe(0)
    await open(original.button)
    const computes = floating.computes, starts = floating.starts
    await change(() => { unrelated.setAttribute('aria-hidden', 'true'); location.setAttribute('data-unrelated', 'open') })
    expect(floating.computes).toBe(computes); expect(floating.starts).toBe(starts)
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
    await act(async () => original.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await expectClosed(original)
    await change(() => { location.setAttribute('aria-hidden', 'true'); unrelated.removeAttribute('inert') })
    expect(floating.computes).toBe(computes)
    expectRetained(original)
  } finally { unrelated.remove() }
})

it('a late real positioning result does not style the closed tooltip or replace the next open surface', async () => {
  const original = retained()
  const pending = new Promise<void>(resolve => { releasePending = resolve })
  floating.delay = () => pending
  await act(async () => original.button.focus())
  await vi.waitFor(() => expect(floating.held).toBe(1))
  const oldHint = document.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(oldHint).not.toBeNull(); expect(oldHint.style.visibility).toBe('hidden')
  await change(() => location.setAttribute('hidden', ''))
  await expectClosed(original)
  floating.delay = null
  await change(() => location.removeAttribute('hidden'))
  await act(async () => original.button.blur())
  const currentHint = await open(original.button)
  expect(currentHint).not.toBe(oldHint)
  const currentStyle = currentHint.getAttribute('style')
  await change(() => releasePending!())
  expect(oldHint.isConnected).toBe(false)
  expect(oldHint.style.visibility).toBe('hidden')
  expect(oldHint.style.left).toBe(''); expect(oldHint.style.top).toBe('')
  expect(document.querySelector('[role="tooltip"]')).toBe(currentHint)
  expect(currentHint.getAttribute('style')).toBe(currentStyle)
  expect(onSend).not.toHaveBeenCalled(); expectRetained(original)
})
