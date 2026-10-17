// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MailboxNavigation } from '../src/renderer/src/components/MailboxNavigation'

it('keeps keyboard navigation in the original workbench document when another window has the same tab id', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frame = document.createElement('iframe'), decoy = document.createElement('button')
  decoy.id = 'mailbox-outbox-tab'
  document.body.append(frame, decoy)
  const owner = frame.contentDocument!, mount = owner.createElement('div')
  owner.body.append(mount)
  const root = createRoot(mount), select = vi.fn()
  try {
    await act(async () => root.render(<MailboxNavigation id="mailbox" selected="inbox" onSelect={select}
      items={['inbox', 'outbox'].map(key => ({ key, label: key, description: key, count: 0, icon: null }))} />))
    const first = owner.getElementById('mailbox-inbox-tab')!, next = owner.getElementById('mailbox-outbox-tab')!
    first.focus()
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(select).toHaveBeenCalledExactlyOnceWith('outbox')
    expect(owner.activeElement).toBe(next)
    expect(document.activeElement).not.toBe(decoy)
  } finally {
    await act(async () => root.unmount())
    frame.remove(); decoy.remove(); vi.unstubAllGlobals()
  }
})
