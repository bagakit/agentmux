import { useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button } from '@agentmux/client-ui/components/Button'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import * as Modal from '@agentmux/client-ui/components/Modal'
import * as Menu from '@agentmux/client-ui/components/HoverDropdownMenu'
import { Textarea, TextInput } from '@agentmux/client-ui/input'
import { ClientUiOverlayProvider } from '@agentmux/client-ui/overlay-host'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import overlayCSS from '@agentmux/client-ui/styles/overlays.css?inline'
import buttonsCSS from '@agentmux/client-ui/styles/buttons.css?inline'
import inputCSS from '@agentmux/client-ui/input/styles.css?inline'
import locationCSS from '@agentmux/client-ui/patterns/agent-work-location.css?inline'
import iconsCSS from '@agentmux/client-ui/styles/semantic-icons.css?inline'
import paletteCSS from '@agentmux/client-ui/styles/palette.css?inline'
import exampleCSS from './examples/host.css?inline'
import fixtureCSS from './host.css?inline'
import { Locations } from './locations'

function installStyles(owner: Document) {
  const style = owner.createElement('style')
  style.textContent = [paletteCSS, exampleCSS, overlayCSS, buttonsCSS, inputCSS, locationCSS, iconsCSS, fixtureCSS].join('\n')
  owner.head.appendChild(style)
  mountThemeRuntime(owner.defaultView!)
}

function AttachedMenu({ owner }: { owner: Document }) {
  const container = Modal.useModalOverlayContainer(owner.body)
  return <Menu.Root>
    <Menu.Trigger asChild><Button id="open-menu">Board actions</Button></Menu.Trigger>
    <Menu.Portal container={container}>
      <Menu.Content className="fixture-menu" align="start" sideOffset={5}><Menu.Item>Rename board</Menu.Item></Menu.Content>
    </Menu.Portal>
  </Menu.Root>
}

function Board({ owner, name }: { owner: Document; name: string }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saved, setSaved] = useState(name)
  const [pressed, setPressed] = useState(false)
  return <ClientUiOverlayProvider host={{ ownerDocument: owner, overlayContainer: () => owner.body }}>
    <main className="fixture-board">
      <Modal.Root open={open} onOpenChange={setOpen}>
        <header className="board-header">
          <h1>{name}</h1>
          <div className="board-actions">
            <Button id="pin-board" aria-pressed={pressed} onClick={() => setPressed(!pressed)}>Pin board</Button>
            <Modal.Trigger asChild><Button id="open-board">Edit board</Button></Modal.Trigger>
          </div>
          <output id="saved-title" aria-label="Saved board title">{saved}</output>
        </header>
        <Modal.Portal>
          <Modal.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--scrim-2)' }} />
          <Modal.Content className="fixture-dialog">
            <header>
              <Modal.Title>Edit board</Modal.Title>
              <Modal.Description>Enter a title for this board.</Modal.Description>
            </header>
            <form onSubmit={event => { event.preventDefault(); setSaved(draft); setOpen(false) }}>
              <FormRow label="Title" layout="stacked" controlId="board-title">{field => <TextInput {...field}
                value={draft} onChange={event => setDraft(event.currentTarget.value)} />}</FormRow>
              <Button type="submit" variant="primary">Save title</Button>
            </form>
            <AttachedMenu owner={owner} />
          </Modal.Content>
        </Modal.Portal>
      </Modal.Root>
      {name === 'Primary board' ? <Locations /> : <>
        <label className="board-draft">Working draft
          <TextInput id="popup-draft" defaultValue="Keep the second board draft" />
        </label>
        <label className="board-draft">Review notes
          <Textarea id="popup-markdown" syntax="markdown" defaultValue={'# Review\nKeep the original `notes`.'} />
        </label>
      </>}
    </main>
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
