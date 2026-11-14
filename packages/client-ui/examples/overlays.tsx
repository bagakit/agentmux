import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import * as Menu from '@agentmux/client-ui/components/HoverDropdownMenu'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { TextInput } from '@agentmux/client-ui/input'
import { ClientUiOverlayProvider } from '@agentmux/client-ui/overlay-host'
import '@agentmux/client-ui/input/styles.css'
import '@agentmux/client-ui/styles/buttons.css'
import '@agentmux/client-ui/styles/overlays.css'

export default function Overlays() {
  const [title, setTitle] = useState('Review board')
  const host = {
    ownerDocument: typeof document === 'undefined' ? undefined : document,
    overlayContainer: () => document.body
  }
  return <ClientUiOverlayProvider host={host}>
    <Modal.Root>
      <Modal.Trigger>Edit the review board title</Modal.Trigger>
      <Modal.Portal>
        <Modal.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--scrim-2)' }} />
        <Modal.Content style={{ pointerEvents: 'auto', position: 'fixed', inset: '20% max(1rem, calc((100% - 32rem) / 2)) auto',
          display: 'grid', gap: '.75rem', padding: '1rem', background: 'var(--surface-1)', color: 'var(--text)', borderRadius: 'var(--radius)' }}>
          <Modal.Title style={{ margin: 0 }}>Review board</Modal.Title>
          <Modal.Description style={{ margin: 0 }}>Changes stay in this example until it is reloaded.</Modal.Description>
          <label style={{ display: 'grid', gap: '.25rem' }}>
            Title
            <TextInput value={title} onChange={event => setTitle(event.currentTarget.value)} />
          </label>
          <Modal.Close asChild><Button variant="primary" style={{ justifySelf: 'end' }}>Done</Button></Modal.Close>
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root>
    <Menu.Root>
      <Menu.Trigger>Review actions</Menu.Trigger>
      <Menu.Portal><Menu.Content style={{ background: 'var(--surface-2)', color: 'var(--text)',
        borderRadius: 'var(--radius)', padding: 'var(--sp-4)', zIndex: 'var(--layer-popover)' }}>
        <Menu.Item onSelect={() => setTitle('Review board')}>Reset title</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </ClientUiOverlayProvider>
}
