// @vitest-environment happy-dom
import { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { DocumentOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'
import { composerDOM } from './helpers/composer-dom-fixture'
import { OpenDestinationPopover } from '../src/renderer/src/components/OpenDestinationBar'

const dom = composerDOM()

it.each(['Escape', 'source close'])('retires the scoped destination picker on %s without closing another owner', async mode => {
  const parentOpenChange = vi.fn(), dismissed = vi.fn()
  function Picker() {
    const [request, setRequest] = useState<{ id: number; x: number; y: number; url: string } | null>({ id: 42, x: 20, y: 30, url: 'https://example.org/original' })
    return <OpenDestinationPopover request={request} canSplit onSelect={() => {}} onDismiss={id => { dismissed(id); setRequest(null) }} />
  }
  async function scene(open: boolean) {
    await dom.render(<Modal.Root open={open} onOpenChange={parentOpenChange}>
      <DocumentOverlayPortal component={Modal.Portal} forceMount>
        <Modal.Overlay className="dialog-scrim" /><Modal.Content className="dialog-surface" aria-describedby={undefined}>
          <Modal.Title>Original modal</Modal.Title><input defaultValue="Original draft" /><Picker />
        </Modal.Content>
      </DocumentOverlayPortal>
    </Modal.Root>)
  }
  await scene(true)
  const picker = document.querySelector<HTMLElement>('.open-destination-bar')!, input = document.querySelector<HTMLInputElement>('.dialog-surface input')!
  expect(picker.closest('[data-overlay-modal-slot]')).not.toBeNull()
  if (mode === 'Escape') await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  else await scene(false)
  expect(document.querySelector('.open-destination-bar')).toBeNull()
  expect(dismissed).toHaveBeenCalledExactlyOnceWith(42)
  expect(parentOpenChange).not.toHaveBeenCalled()
  expect(input.isConnected).toBe(true); expect(input.value).toBe('Original draft')
})

it('keeps the actual Avatar disclosure in its modal attachment scope outside scrolling content', async () => {
  const parentOpenChange = vi.fn()
  await dom.render(<Modal.Root open onOpenChange={parentOpenChange}>
    <DocumentOverlayPortal component={Modal.Portal}>
      <Modal.Overlay className="dialog-scrim" />
      <Modal.Content className="dialog-surface" aria-describedby={undefined}>
        <Modal.Title>Original modal</Modal.Title>
        <AgentAvatar label="Scoped Agent" providerId="codex" />
      </Modal.Content>
    </DocumentOverlayPortal>
  </Modal.Root>)
  const content = document.querySelector<HTMLElement>('.dialog-surface')!
  const scope = content.closest('[data-overlay-modal-scope]')!
  const avatar = content.querySelector<HTMLElement>('.agent-avatar')!
  await act(async () => avatar.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  const panel = document.querySelector<HTMLElement>('.agent-identity-popover')!
  expect(panel).not.toBeNull()
  expect(panel.closest('[data-overlay-modal-scope]')).toBe(scope)
  expect(panel.closest('[data-overlay-modal-slot]')).not.toBeNull()
  expect(content.contains(panel)).toBe(false)
  expect(panel.textContent).toContain('Scoped Agent')
  await act(async () => avatar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
  expect(document.querySelector('.dialog-surface')).toBe(content)
  expect(parentOpenChange).not.toHaveBeenCalled()
})

it('opening and closing an Avatar does not scan another Browser stage', async () => {
  const browser = document.createElement('div')
  browser.dataset.nativeBrowserStage = 'unrelated-original-browser'
  document.body.append(browser)
  const geometry = vi.spyOn(browser, 'getBoundingClientRect')
  try {
    await dom.render(<AgentAvatar label="Independent Agent" providerId="codex" />)
    await dom.hover('.agent-avatar')
    expect(document.querySelector('.agent-identity-popover')?.textContent).toContain('Independent Agent')
    expect(geometry).not.toHaveBeenCalled()
    await dom.render(null)
    expect(document.querySelector('.agent-identity-popover')).toBeNull()
    expect(browser.isConnected).toBe(true)
  } finally { browser.remove() }
})
