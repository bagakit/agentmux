// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown.js'
import type { PastedImage } from '../src/shared/contracts.js'

// T-005: the thumbnail enlarges in a lightbox. It uses @radix-ui/react-dialog (the in-repo overlay
// primitive) so the focus trap and Escape-to-close are the primitive's, not hand-rolled. Assert:
//   - clicking the thumbnail opens an enlarged view in a Radix Dialog portal;
//   - Escape closes it AND focus returns to the thumbnail that opened it (the a11y baseline);
//   - the enlarged image shows the same bytes.

const DATA_URL = 'data:image/png;base64,aGVsbG8='
const IMAGE: PastedImage = { dataUrl: DATA_URL }
const TOKEN = '@/Users/dev/.agentmux/pasted/paste-1.png'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderThumb() {
  await act(async () => {
    root.render(createElement(AgentMarkdown, {
      content: TOKEN,
      readPastedImage: vi.fn(async () => IMAGE),
      openWorkspaceFile: vi.fn(),
      workspaceRoot: '/Users/dev/proj'
    }))
  })
  await act(async () => { await Promise.resolve() })
  return container.querySelector<HTMLButtonElement>('.md-conversation-image')!
}

const lightbox = () => document.querySelector<HTMLElement>('.md-conversation-image__lightbox')

describe('conversation image lightbox', () => {
  it('opens an enlarged view in a portal when the thumbnail is clicked', async () => {
    const trigger = await renderThumb()
    expect(lightbox()).toBeNull()
    await act(async () => trigger.click())
    const box = lightbox()
    expect(box).not.toBeNull()
    const full = box!.querySelector<HTMLImageElement>('img.md-conversation-image__full')
    expect(full).not.toBeNull()
    expect(full!.getAttribute('src')).toBe(DATA_URL)
  })

  it('closes on Escape and returns focus to the thumbnail that opened it', async () => {
    const trigger = await renderThumb()
    // Focus the trigger before opening — Radix's focus scope captures the focused element at open time
    // and restores it on close. A real click/keyboard activation focuses the control; assert against
    // that contract rather than happy-dom's incidental click-focus behaviour.
    await act(async () => trigger.focus())
    await act(async () => trigger.click())
    expect(lightbox()).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(lightbox()).toBeNull()
    // Radix's FocusScope restores focus in a deferred `setTimeout(0)` on unmount (its documented
    // workaround for a React focus-on-unmount bug), which `act()` does not flush — so drain the
    // macrotask queue before asserting. This waits for the SAME restoration a real browser performs;
    // it is not a weakening of the assertion. Without it, activeElement is still <body> mid-restore.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // Focus restoration is the accessibility baseline the primitive gives us — assert it actually holds.
    expect(document.activeElement).toBe(trigger)
  })
})
