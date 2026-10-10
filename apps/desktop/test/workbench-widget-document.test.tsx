import { fixturePath } from '../../../test/fixture-values.mjs'
import { AgentInformationPreviewHost, useAgentInformationPreview } from '../src/renderer/src/components/AgentInformationPreview'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { workbenchDocumentReturning, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { ComposerCompletionEditor } from '@agentmux/client-ui/components/ComposerCompletionEditor'
import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { newNoteDocument, readNoteDocument } from '../src/shared/note-document'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { SelectionField } from '../src/renderer/src/components/SelectionField'
import * as HoverMenu from '../src/renderer/src/components/HoverDropdownMenu'
import { WindowOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'

let host: HTMLDivElement, frame: HTMLIFrameElement, root: Root, releaseReadingDocument: (() => void) | undefined
beforeEach(() => {
  releaseReadingDocument = undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.getSelection()?.removeAllRanges()
  host = document.createElement('div'); frame = document.createElement('iframe')
  document.body.append(host, frame); root = createRoot(host)
})
afterEach(async () => { await act(async () => { const preview=agentInformationPreview.get();if(preview)agentInformationPreview.dismiss(preview.token,true);root.unmount() }); releaseReadingDocument?.(); host.remove(); frame.remove(); document.querySelector('#agentmux-window-overlay-host')?.remove(); vi.restoreAllMocks() })
const scope = (ownerDocument: Document, children: ReactNode) => <WorkbenchDocumentContext.Provider value={{document:ownerDocument, window:null}}>{children}</WorkbenchDocumentContext.Provider>
async function render(ownerDocument: Document, children: ReactNode) { await act(async () => root.render(scope(ownerDocument, children))) }
async function migrate(ownerDocument: Document, children: ReactNode) { ownerDocument.body.append(ownerDocument.adoptNode(host)); await render(ownerDocument, children) }
function editor(selector: string): Editor { return host.querySelector<HTMLElement & { editor: Editor }>(selector)!.editor }

it.each(['detach', 'return'])('%s retains the original composer view, selection, nonempty draft and undo through adoption', async direction => {
  const initialDocument = direction === 'detach' ? document : frame.contentDocument!
  const destinationDocument = direction === 'detach' ? frame.contentDocument! : document
  if (direction === 'return') { await act(async()=>root.unmount()); host.remove(); host = initialDocument.createElement('div'); initialDocument.body.append(host); root = createRoot(host) }
  function Composer({ ownerDocument }: { ownerDocument: Document }) {
    const [draft,setDraft]=useState('Original draft ')
    return <DesktopClientUiProvider document={ownerDocument}><InlineComposer value={draft} onValueChange={setDraft} disabled={false} placeholder="Message" aria-label="Draft" onKeyDown={() => {}} /></DesktopClientUiProvider>
  }
  await render(initialDocument,<Composer ownerDocument={initialDocument}/>); const original=editor('.tiptap'), view=original.view
  expect(view.root).toBe(initialDocument)
  await act(async () => { original.commands.setTextSelection(16); original.commands.insertContent('edited'); original.commands.setTextSelection({from:2,to:7}) })
  const state=original.state, content=original.getJSON(), child=destinationDocument
  await migrate(child,<Composer ownerDocument={child}/>)
  expect(editor('.tiptap')).toBe(original); expect(original.view).toBe(view); expect(view.root).toBe(child)
  expect(original.state).toBe(state); expect(original.getJSON()).toEqual(content); expect(original.state.selection).toMatchObject({from:2,to:7})
  await act(async () => original.view.focus()); expect(child.activeElement).toBe(view.dom)
  await act(async () => original.commands.undo()); expect(original.getText()).toBe('Original draft ')
  await act(async () => original.commands.redo()); expect(original.getJSON()).toEqual(content)
  expect(original.getJSON()).toEqual(content); expect(original.isDestroyed).toBe(false)
})

it.each(['detach', 'return'])('%s retains the original Note block identity, selection and undo rather than reloading its serialized draft', async direction => {
  const initialDocument = direction === 'detach' ? document : frame.contentDocument!
  const destinationDocument = direction === 'detach' ? frame.contentDocument! : document
  if (direction === 'return') { await act(async()=>root.unmount()); host.remove(); host = initialDocument.createElement('div'); initialDocument.body.append(host); root = createRoot(host) }
  function Note() {
    const [note,setNote]=useState(newNoteDocument('Original Note ', 'source-note','source-block'))
    return <NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={raw=>{const read=readNoteDocument(raw);if(read.status==='valid')setNote(read.note)}} onOpen={()=>{}} onSave={()=>{}} onIssue={()=>{}} />
  }
  await render(initialDocument,<Note/>); const original=editor('.note-block-content'), view=original.view
  expect(view.root).toBe(initialDocument)
  await act(async () => { original.commands.setTextSelection(15); original.commands.insertContent('edited'); original.commands.setTextSelection({from:2,to:6}) })
  const content=original.getJSON(), selection=original.state.selection.toJSON(), state=original.state, child=destinationDocument
  await migrate(child,<Note/>); expect(editor('.note-block-content')).toBe(original); expect(view.root).toBe(child)
  expect(original.state).toBe(state); expect(original.getJSON()).toEqual(content); expect(original.state.selection.toJSON()).toEqual(selection)
  await act(async () => original.commands.undo()); expect(original.getText()).toBe('Original Note ')
  await act(async () => original.commands.redo()); expect(original.getJSON()).toEqual(content)
  expect(original.getJSON().content![0]!.attrs!.blockId).toBe('source-block')
})

it('routes the actual selector menu and its keyboard selection to its workface document', async () => {
  const changed=vi.fn(), child=frame.contentDocument!
  const field=<SelectionField label="Model" value="first" options={[{value:'first',label:'First'},{value:'second',label:'Second'}]} onValueChange={changed}/>
  await render(document,field); const trigger=host.querySelector<HTMLButtonElement>('button')!
  await migrate(child,field)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})))
  await vi.waitFor(()=>expect(child.querySelector('[role=menu]')).not.toBeNull())
  expect(document.querySelector('[role=menu]')).toBeNull()
  const second=child.querySelector<HTMLElement>('[data-value=second][role=menuitemradio]')!
  await act(async()=>{second.focus();second.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})
  expect(changed).toHaveBeenCalledExactlyOnceWith('second')
})

it('keeps actual hover disclosure coordination inside its document and cleans the old listener after migration', async () => {
  function Menu({name}:{name:string}) {return <HoverMenu.Root><HoverMenu.Trigger>{name}</HoverMenu.Trigger><HoverMenu.Portal><HoverMenu.Content aria-label={name}><HoverMenu.Item>Action</HoverMenu.Item></HoverMenu.Content></HoverMenu.Portal></HoverMenu.Root>}
  const child=frame.contentDocument!, scene=<Menu name="Original actions"/>
  await render(document,scene); const trigger=host.querySelector('button')!
  await migrate(child,scene)
  // React maps enter to pointerover; this is the original disclosure's public pointer path.
  await act(async()=>trigger.dispatchEvent(new PointerEvent('pointerover',{pointerType:'mouse',buttons:0,bubbles:true})))
  await vi.waitFor(()=>expect(child.querySelector('[role=menu]')).not.toBeNull())
  await act(async()=>window.dispatchEvent(new CustomEvent('agentmux:hover-menu-open',{detail:Symbol()})))
  expect(child.querySelector('[role=menu]')).not.toBeNull()
  await act(async()=>child.defaultView!.dispatchEvent(new CustomEvent('agentmux:hover-menu-open',{detail:Symbol()})))
  await vi.waitFor(()=>expect(child.querySelector('[role=menu]')).toBeNull())
})

it('routes custom tooltip primitives to the same document and returns them without a second React root', async () => {
 const content=<WindowOverlayPortal layer="tooltip"><span role="tooltip">Original hint</span></WindowOverlayPortal>, child=frame.contentDocument!
 await render(document,content);expect(document.querySelector('[role=tooltip]')?.textContent).toBe('Original hint')
 await render(child,content);expect(document.querySelector('[role=tooltip]')).toBeNull();expect(child.querySelector('[role=tooltip]')?.textContent).toBe('Original hint')
 await render(document,content);expect(child.querySelector('[role=tooltip]')).toBeNull();expect(document.querySelector('[role=tooltip]')?.textContent).toBe('Original hint')
})

it('places the original Agent disclosure in its workface and listens for dismissal there', async () => {
 const child=frame.contentDocument!, face=<AgentAvatar label="Original Agent" />
 await render(document,face);await migrate(child,face)
 await act(async()=>host.querySelector<HTMLElement>('.agent-avatar')!.focus())
 await vi.waitFor(()=>expect(child.querySelector('.agent-identity-popover')).not.toBeNull())
 expect(document.querySelector('.agent-identity-popover')).toBeNull()
 await act(async()=>child.querySelector('.agent-identity-popover')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
 await vi.waitFor(()=>expect(child.querySelector('.agent-identity-popover')).toBeNull())
})

it.each(['reading', 'metadata', 'hidden'])('keeps the pinned original reading DOM, scroll, Range and focus when its actual native document returns: %s', async mode => {
 const child=frame.contentDocument!
 releaseReadingDocument=registerWorkbenchDocument(child,{windowId:'original-reading-window',documentGeneration:'original-reading-document'})
 await act(async()=>root.unmount());host.remove();host=child.createElement('div');child.body.append(host);root=createRoot(host)
 const context: FocusContext={id:'original-source',name:'Original Agent',detail:'Original source',state:'running',stateLabel:'Running',processState:'running',bucket:'working',kind:'terminal',providerId:null,hostId:'local',topicId:null,workspaceId:'workspace',workspaceName:'Workspace',workspacePath:fixturePath('workbench'),liveAgent:false,actionable:true,lastActivityAt:null,runId:'original-run',workingEnteredAt:null,workspace:undefined,recap:{text:'Original reading text',reading:{text:'Original reading text',truncated:false},source:'Last assistant message',origin:'timeline'},detailIsRecap:true}
 function Trigger(){const preview=useAgentInformationPreview(context,true,undefined,undefined,()=>{});return <button ref={preview.anchor} {...preview.triggerEvents}>Read original source</button>}
 await render(child,<><AgentInformationPreviewHost/><Trigger/></>)
 await act(async()=>host.querySelector<HTMLButtonElement>('button')!.focus())
 await vi.waitFor(()=>expect(child.querySelector('.agent-information-reader')).not.toBeNull())
 const panel=child.querySelector<HTMLElement>('.agent-information-reader')!,reading=panel.querySelector<HTMLElement>('.agent-information-reader__reading')!
 await act(async()=>host.querySelector<HTMLButtonElement>('button')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})))
 expect(child.activeElement).toBe(reading)
 await act(async()=>panel.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
 expect(agentInformationPreview.get()?.pinned).toBe(true)
 reading.scrollTop=37
 await act(async()=>reading.focus())
 const text=panel.querySelector('.focus-context-hover__prose p')!.firstChild!,range=child.createRange();range.setStart(text,2);range.setEnd(text,10);child.getSelection()!.removeAllRanges();child.getSelection()!.addRange(range)
 const selected=child.getSelection()!.toString()
 if(mode==='metadata') { await act(async()=>panel.querySelector<HTMLButtonElement>('.agent-information-reader__service button')!.click());expect(reading.inert).toBe(true);child.getSelection()!.removeAllRanges();expect(child.getSelection()!.rangeCount).toBe(0) }
 if(mode==='hidden') { Object.defineProperty(child,'visibilityState',{configurable:true,value:'hidden'});await act(async()=>child.dispatchEvent(new Event('visibilitychange')));expect(panel.hidden).toBe(true) }
 document.body.append(document.adoptNode(host))
 await act(async()=>workbenchDocumentReturning(child,document))
 expect(document.querySelector('.agent-information-reader')).toBe(panel);expect(child.querySelector('.agent-information-reader')).toBeNull()
 expect(panel.querySelector('.agent-information-reader__reading')).toBe(reading);expect(reading.scrollTop).toBe(37);expect(panel.hidden).toBe(false)
 if(mode==='metadata') { expect(reading.inert).toBe(true);await act(async()=>panel.querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!.click()) }
 expect(document.getSelection()!.toString()).toBe(selected);expect(document.getSelection()!.anchorNode).toBe(text);expect(document.getSelection()!.focusNode).toBe(text);expect(document.getSelection()!.anchorOffset).toBe(2);expect(document.getSelection()!.focusOffset).toBe(10);expect(document.activeElement).toBe(reading)
 expect(agentInformationPreview.get()?.pinned).toBe(true)
 expect(panel.textContent).toContain('Original Run or source is no longer confirmed')
 // A closed source document cannot keep dismissing the returned reading.
 await act(async()=>child.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
 expect(document.querySelector('.agent-information-reader')).toBe(panel)
})


it('routes an already open completion panel and its original keyboard choice after its document changes', async () => {
  function Completion({ ownerDocument }: { ownerDocument: Document }) {
    const [draft, setDraft] = useState('')
    return <DesktopClientUiProvider document={ownerDocument}><ComposerCompletionEditor value={draft} onValueChange={setDraft} disabled={false} placeholder="Message" aria-label="Draft" onKeyDown={() => {}} commands={[{ text: '/first', description: 'First original command' }, { text: '/second', description: 'Second original command' }]} /></DesktopClientUiProvider>
  }
  await render(document, <Completion ownerDocument={document}/>)
  const original = editor('.tiptap'), view = original.view
  await act(async () => { original.commands.insertContent('/'); original.view.focus() })
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.composer-completion-popover')?.style.visibility).toBe('visible'))
  const child = frame.contentDocument!
  await migrate(child, <Completion ownerDocument={child}/>)
  expect(editor('.tiptap')).toBe(original); expect(original.view).toBe(view); expect(view.root).toBe(child)
  expect(document.querySelector('.composer-completion-popover')).toBeNull()
  await vi.waitFor(() => expect(child.querySelector<HTMLElement>('.composer-completion-popover')?.style.visibility).toBe('visible'))
  const options = [...child.querySelectorAll<HTMLButtonElement>('[role=option]')]
  expect(options).toHaveLength(2)
  await act(async () => options[0]!.focus())
  await act(async () => options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(child.activeElement).toBe(options[1])
  await act(async () => options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(original.getText()).toBe('/second ')
})
