import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'
import { HostFolderDialog } from '../../../src/renderer/src/components/HostFolderDialog'
import { WindowOverlayPortal, resolveOverlayContainer } from '../../../src/renderer/src/components/WindowOverlayHost'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/agent.css'

const root = createRoot(document.getElementById('root')!)
let changes: boolean[] = [], additions: unknown[] = []
let sourceDocument = document, retained: HTMLInputElement | null = null, lastControl = true
let redraw: (() => void) | undefined, draft = 'Original unsent draft', open = true
const delay = () => new Promise(resolve => setTimeout(resolve, 80))
const platform = { copyText: async () => {}, overlayContainer: resolveOverlayContainer, ownerDocument: document }
api.workspaces.add = async input => { additions.push(input); return { id: 'isolated-workspace', name: 'Original folder', path: input.path, hostId: input.hostId } as any }
useAppStore.getState().selectWorkspace = async () => {}
function changed(value: boolean) { changes.push(value); open = value; redraw?.() }
function Content({ controls = true, attachment = false }: { controls?: boolean; attachment?: boolean }) {
  const [, setRevision] = useState(0)
  redraw = () => setRevision(value => value + 1)
  return <Modal.Root open={open} onOpenChange={changed}><Modal.Portal container={sourceDocument.body}>
    <Modal.Overlay className="dialog-scrim" /><Modal.Content className="confirmation-dialog dialog-surface">
      <Modal.Title>Original modal</Modal.Title><Modal.Description>Retain the original draft and input ownership.</Modal.Description>
      {controls && lastControl ? <input id="original-editor" defaultValue={draft} onChange={event => { draft = event.target.value }} /> : null}
      {attachment ? <WindowOverlayPortal><button id="attached-control">Original attached control</button></WindowOverlayPortal> : null}
    </Modal.Content></Modal.Portal></Modal.Root>
}
function state() {
  const boundary = sourceDocument.querySelector<HTMLElement>('[data-overlay-modal-boundary]'), content = sourceDocument.querySelector<HTMLElement>('[data-overlay-modal-part="content"]')
  const active = sourceDocument.activeElement
  return { active: active?.id || active?.getAttribute('data-overlay-modal-boundary') === '' && 'boundary' || active?.tagName,
    inside: !!boundary?.contains(active), boundaryFocused: active === boundary, role: boundary?.getAttribute('role'), tabIndex: boundary?.tabIndex,
    changes: [...changes], additions: [...additions], draft: sourceDocument.querySelector<HTMLInputElement>('#original-editor')?.value,
    sameInput: !retained || sourceDocument.querySelector('#original-editor') === retained, connected: content?.isConnected,
    selection: retained && [retained.selectionStart, retained.selectionEnd] }
}
async function render(kind: string) {
  flushSync(() => root.render(null)); await delay(); sourceDocument = document; changes = []; additions = []; lastControl = true; open = true; redraw = undefined; retained = null
  document.getElementById('outside')!.focus()
  let node
  if (kind === 'confirmation' || kind === 'busy') node = <ConfirmationDialog open title="Stop Agent Session?" description="Original pending confirmation" confirmLabel="Stop & Close" busy={kind === 'busy'} onCancel={() => changed(false)} onConfirm={() => {}} />
  else if (kind === 'hostfolder') node = <HostFolderDialog hostId="original-host" label="Original Host" onClose={() => changed(false)} />
  else node = <Content controls={kind !== 'empty'} attachment={kind === 'attachment'} />
  flushSync(() => root.render(<ClientUiProvider platform={platform as any}><WorkbenchDocumentContext.Provider value={{ document: sourceDocument, window: null }}>{node}</WorkbenchDocumentContext.Provider></ClientUiProvider>)); await delay(); return state()
}
async function removeLast() { lastControl = false; flushSync(() => redraw?.()); await delay(); return state() }
async function outsideFocus() { document.getElementById('outside')!.focus(); await delay(); return state() }
async function ime(key: string, marker: 'composing' | 'legacy') {
  const input = sourceDocument.querySelector<HTMLInputElement>('[data-overlay-modal-part="content"] input')!; input.focus()
  const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true,
    isComposing: marker === 'composing', keyCode: marker === 'legacy' ? 229 : key === 'Enter' ? 13 : 27 })
  input.dispatchEvent(event)
  // A synthetic KeyboardEvent has no native default submission; retain the exact
  // preventDefault receipt, then verify a real ordinary Enter through Chromium.
  await delay(); return { ...state(), defaultPrevented: event.defaultPrevented }
}
async function move(toChild: boolean) {
  let frame = document.querySelector<HTMLIFrameElement>('#destination-document')
  if (!frame) {
    frame = document.createElement('iframe'); frame.id = 'destination-document'; frame.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0'; document.body.append(frame)
    for (const style of document.querySelectorAll('link[rel="stylesheet"],style')) frame.contentDocument!.head.append(style.cloneNode(true))
  }
  retained ??= sourceDocument.querySelector<HTMLInputElement>('#original-editor')
  if (retained) { retained.value = 'Original preserved selection'; retained.setSelectionRange(3, 11) }
  sourceDocument = toChild ? frame.contentDocument! : document
  flushSync(() => root.render(<ClientUiProvider platform={{ ...platform, ownerDocument: sourceDocument } as any}><WorkbenchDocumentContext.Provider value={{ document: sourceDocument, window: null }}><Content /></WorkbenchDocumentContext.Provider></ClientUiProvider>))
  await delay(); return state()
}
Object.assign(window, { modalProof: { render, state, removeLast, outsideFocus, ime, move,
  focusEditor() { sourceDocument.querySelector<HTMLInputElement>('#original-editor')?.focus(); return state() },
  focusAttachment() { sourceDocument.querySelector<HTMLElement>('#attached-control')?.focus(); return state() },
  setFolder() { const input = document.querySelector<HTMLInputElement>('.project-group-dialog input')!; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, '/isolated/project'); input.dispatchEvent(new Event('input', { bubbles: true })); return state() }
} })
