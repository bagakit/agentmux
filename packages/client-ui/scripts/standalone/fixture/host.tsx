import { useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button } from '@agentmux/client-ui/components/Button'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import * as Modal from '@agentmux/client-ui/components/Modal'
import * as Menu from '@agentmux/client-ui/components/HoverDropdownMenu'
import { TextInput } from '@agentmux/client-ui/input'
import { ClientUiOverlayProvider } from '@agentmux/client-ui/overlay-host'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import overlayCSS from '@agentmux/client-ui/styles/overlays.css?inline'
import buttonsCSS from '@agentmux/client-ui/styles/buttons.css?inline'
import inputCSS from '@agentmux/client-ui/input/styles.css?inline'
import locationCSS from '@agentmux/client-ui/patterns/agent-work-location.css?inline'
import iconsCSS from '@agentmux/client-ui/styles/semantic-icons.css?inline'
import paletteCSS from '@agentmux/client-ui/styles/palette.css?inline'
import { Locations } from './locations'

function installStyles(owner: Document) {
  const style = owner.createElement('style')
  style.textContent = [overlayCSS, buttonsCSS, inputCSS, locationCSS, iconsCSS, paletteCSS,
    `body { margin: 0; padding: 16px; font: 1rem system-ui; background: var(--bg); color: var(--text); }
    section { display: grid; justify-items: start; gap: 8px; margin-block: 12px; }
    section[aria-label="Work locations"] { max-inline-size: 34rem; }
    .dialog { pointer-events: auto; position: fixed; inset: max(3rem, 20%) 12% auto; display: grid; gap: 12px;
      padding: 16px; color: var(--text); background: var(--surface-1); border-radius: var(--radius); }
    [role="menu"] { pointer-events: auto; background: var(--surface-1); color: var(--text); border: 1px solid var(--line);
      padding: 8px; z-index: var(--layer-popover); }
    [role="menuitem"]:focus-visible { outline: 2px solid var(--focus-line); }`
  ].join('\n')
  owner.head.appendChild(style)
  mountThemeRuntime(owner.defaultView!)
}

function AttachedMenu({ owner }: { owner: Document }) {
  const container = Modal.useModalOverlayContainer(owner.body)
  return <Menu.Root>
    <Menu.Trigger id="open-menu">Board actions</Menu.Trigger>
    <Menu.Portal container={container}>
      <Menu.Content><Menu.Item>Rename board</Menu.Item></Menu.Content>
    </Menu.Portal>
  </Menu.Root>
}

function Board({ owner, name }: { owner: Document; name: string }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saved, setSaved] = useState(name)
  const [pressed, setPressed] = useState(false)
  return <ClientUiOverlayProvider host={{ ownerDocument: owner, overlayContainer: () => owner.body }}>
    <h1>{name}</h1>
    <Button id="pin-board" aria-pressed={pressed} onClick={() => setPressed(!pressed)}>Pin board</Button>
    <output id="saved-title">{saved}</output>
    <Modal.Root open={open} onOpenChange={setOpen}>
      <Modal.Trigger id="open-board">Edit board</Modal.Trigger>
      <Modal.Portal>
        <Modal.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--scrim-2)' }} />
        <Modal.Content className="dialog">
          <Modal.Title>Edit board</Modal.Title>
          <Modal.Description>Enter a title for this board.</Modal.Description>
          <form onSubmit={event => { event.preventDefault(); setSaved(draft); setOpen(false) }}>
            <FormRow label="Title" layout="stacked" controlId="board-title">{field => <TextInput {...field}
              value={draft} onChange={event => setDraft(event.currentTarget.value)} />}</FormRow>
            <Button type="submit" variant="primary">Save title</Button>
          </form>
          <AttachedMenu owner={owner} />
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root>
    {name === 'Primary board' ? <Locations /> : <input id="popup-draft" aria-label="Popup working draft" defaultValue="Keep the second board draft" />}
  </ClientUiOverlayProvider>
}

const root = createRoot(document.getElementById('app')!)
const render = (second?: Document) => root.render(<>
  <Board owner={document} name="Primary board" />
  {second ? createPortal(<Board owner={second} name="Second board" />, second.body) : null}
</>)
installStyles(document)
render()
Object.assign(window, { openSecondDocument() {
  const popup = window.open('about:blank', '_blank', 'width=640,height=580')
  if (!popup) return false
  popup.document.title = 'Second board'
  installStyles(popup.document)
  render(popup.document)
  return popup.document !== document
} })
