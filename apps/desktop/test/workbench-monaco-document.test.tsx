// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { monacoKeybindingConstants, editorPaneStoreState } from './helpers/editor-pane-store'
import { MONACO_THEME_ID } from '../src/renderer/src/lib/monaco-theme'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'

const fixture=vi.hoisted(()=>({state:{} as Record<string,any>,mount:null as null|((editor:any,monaco:any)=>void), widgets:[] as any[]}))
vi.mock('../src/renderer/src/monaco',()=>({}))
vi.mock('../src/renderer/src/store',()=>({useAppStore:Object.assign((select:(state:typeof fixture.state)=>unknown)=>select(fixture.state),{getState:()=>fixture.state})}))
vi.mock('@monaco-editor/react',()=>({default:({onMount}:{onMount:typeof fixture.mount})=>{fixture.mount=onMount;return null}}))
vi.mock('monaco-editor',async()=>{
 const {workfaceMonacoAdapter}=await import('./helpers/workface-monaco-fixture')
 const api=workfaceMonacoAdapter(), create=api.editor.createDiffEditor
 return {...api,editor:{...api.editor,createDiffEditor:(host:HTMLElement)=>{const widget=create(host), tracked=Object.assign(widget,{layout:vi.fn(),dispose:vi.fn(widget.dispose.bind(widget))});fixture.widgets.push(tracked);return tracked}}}
})
import { FileSourceEditor } from '../src/renderer/src/components/FileSourceEditor'
import { GitDiffCanvas } from '../src/renderer/src/features/git/diff/GitDiffCanvas'
import { workfaceMonacoModelCount } from './helpers/workface-monaco-fixture'

let host:HTMLDivElement, frame:HTMLIFrameElement, root:Root
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 host=document.createElement('div');frame=document.createElement('iframe');document.body.append(host,frame);root=createRoot(host)
 fixture.mount=null;fixture.widgets.length=0
 fixture.state={...editorPaneStoreState(),documents:{['workspace\0app.ts']:{path:'app.ts',content:'Original source',revision:'source-revision'}},regionCaretFocus:null}
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();frame.remove();vi.restoreAllMocks()})

it('moves the retained source consumer through public layout without recreating its widget or saving a replacement view state',async()=>{
 const viewState=createRef<any>(), field=<FileSourceEditor tabId="tab" viewState={viewState} surface={{regionId:'region',kind:'file',workspaceId:'workspace',path:'app.ts'}}/>
 const render=async(ownerDocument:Document)=>act(async()=>root.render(<WorkbenchDocumentContext.Provider value={{document:ownerDocument,window:null}}>{field}</WorkbenchDocumentContext.Provider>))
 await render(document)
 const node=document.createElement('div');host.append(node)
 const editor={layout:vi.fn(),focus:vi.fn(),getContainerDomNode:()=>node,addCommand:vi.fn(),addAction:vi.fn(),createContextKey:()=>({set:vi.fn()}),onDidChangeCursorSelection:vi.fn(),onDidDispose:vi.fn(),getModel:()=>({}),saveViewState:vi.fn()}
 await act(async()=>fixture.mount!(editor,monacoKeybindingConstants()))
 const child=frame.contentDocument!;child.body.append(child.adoptNode(host));await render(child)
 expect(editor.layout).toHaveBeenCalledOnce();expect(editor.saveViewState).not.toHaveBeenCalled();expect(editor.focus).not.toHaveBeenCalled();expect(viewState.current).toBeNull()
 await render(child);expect(editor.layout).toHaveBeenCalledOnce()
 // Public-widget behavior is covered by the separate native qualification; this
 // original consumer gate proves it is called without replacing the owned widget.
})

it('moves the actual diff consumer with the same two real models and cancels them only on original unmount',async()=>{
 const before=workfaceMonacoModelCount(), field=<GitDiffCanvas diff={{loading:false,error:null,diff:{path:'app.ts',binary:false,old:{present:true,binary:false,text:'before'},new:{present:true,binary:false,text:'after'},change:'modified'}}} wordWrap={false} language="typescript" theme={MONACO_THEME_ID}/>
 const render=async(ownerDocument:Document)=>act(async()=>root.render(<WorkbenchDocumentContext.Provider value={{document:ownerDocument,window:null}}>{field}</WorkbenchDocumentContext.Provider>))
 await render(document);expect(fixture.widgets).toHaveLength(1);expect(workfaceMonacoModelCount()).toBe(before+2)
 const original=fixture.widgets[0], child=frame.contentDocument!;child.body.append(child.adoptNode(host));await render(child)
 expect(fixture.widgets).toHaveLength(1);expect(fixture.widgets[0]).toBe(original);expect(original.layout).toHaveBeenCalledOnce();expect(original.dispose).not.toHaveBeenCalled();expect(workfaceMonacoModelCount()).toBe(before+2)
 await act(async()=>root.render(null));expect(original.dispose).toHaveBeenCalledOnce();expect(workfaceMonacoModelCount()).toBe(before)
})
