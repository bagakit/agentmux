// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Original file source" value={value} readOnly /> }))
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { api } from '../src/renderer/src/lib/api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM(), path = 'original.note.md', key = documentKey('workspace', path)
const surface = { kind: 'file' as const, regionId: 'original-note-region', workspaceId: 'workspace', path }, tab = createWorkbenchTab('original-note-tab', surface)
let rootPath: string, files: WorkspaceFiles, writer: NoteFileWriter, reason: string, external: string
beforeEach(async () => {
 rootPath = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-attribution-ui-')))
 const workspace = { id: 'workspace', hostId: 'local', path: rootPath, name: 'Original notes', kind: 'folder' as const }
 const metadata = new AgentMuxNotebookStore(join(rootPath, 'notebooks.sqlite'))
 files = new WorkspaceFiles(() => new LocalExecutionHost()); writer = new NoteFileWriter(files, undefined, metadata)
 const created = await writer.write(workspace, { path, expectedRevision: null, content: serializeNoteDocument(newNoteDocument('Original finding', 'original-note', 'original-block')) }, { actor: { kind: 'agent', id: 'original-creator' } })
 expect(created.status).toBe('written')
 external = serializeNoteDocument(newNoteDocument('Externally changed original', 'original-note', 'original-block'))
 await writeFile(join(rootPath, path), external)
 const read = await writer.read(workspace, path); if(read.status!=='read'||read.document.noteProvenance?.status!=='unconfirmed')throw Error('Actual original metadata must be unconfirmed after external editing')
 reason = read.document.noteProvenance.reason
 useNotebookLibrary.setState({ state: null, issue: null })
 useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) },
  documents: { [key]: read.document }, dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, editorRegionModes: { [surface.regionId]: 'preview' }, mainSurface: 'recall' })
 vi.spyOn(api.files, 'read').mockImplementation(async(id,requested)=>{expect(id).toBe('workspace');expect(requested).toBe(path);return writer.read(workspace,requested)})
 vi.spyOn(api.files, 'write').mockRejectedValue(new Error('Checking attribution must never write'))
 vi.spyOn(api.files, 'observe').mockResolvedValue();vi.spyOn(api.files, 'unobserve').mockResolvedValue()
 vi.spyOn(api.notesStorage, 'inspect').mockResolvedValue({ directory: rootPath, catalogPath: join(rootPath, 'notebooks.sqlite'), resourceChanges: [], directoryChanges: [], operation: null, conversionIssues: [] })
 vi.spyOn(api.notesStorage, 'onChange').mockImplementation(() => () => {})
})
afterEach(async()=>{await files.dispose();await rm(rootPath,{recursive:true,force:true})})
const presentation={active:true,survey:false,retainedRegionId:surface.regionId,tabHostId:'original-host',reference:{displayWorkspaceId:'workspace',groupId:'original-group',tabId:tab.id,regionId:surface.regionId}}
const notices=()=>[...dom.container.querySelectorAll<HTMLElement>('[role="status"]')].filter(node=>node.textContent?.startsWith('Block authorship '))
const editor=()=>(dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor
async function openRecovery() {
 expect(dom.container.querySelector('.note-recovery-summary')).toBeNull()
 const entry=dom.container.querySelector<HTMLButtonElement>('[aria-label="Open versions and recovery"]')!
 expect(entry.title).toContain('Authorship unconfirmed');expect(entry.textContent).toBe('History')
 expect(entry.getAttribute('aria-description')).toContain('Authorship unconfirmed')
 expect(entry.querySelector('.note-recovery-metadata')).not.toBeNull()
 await act(async()=>entry.click())
 expect(dom.container.querySelector('[role="dialog"]')!.textContent).toContain('Drafts & recovery')
}
it('keeps the actual read attribution reason and original creator visible in Recall, checks the original owner and preserves later rich input',async()=>{
 await dom.render(<WorkbenchPresentationContext.Provider value={presentation}><EditorPane tabId={tab.id} surface={surface} preview={<NoteFileSurfaceView tabId={tab.id} surface={surface}/>}/></WorkbenchPresentationContext.Provider>)
 expect(notices()).toHaveLength(0)
 const originalEditor=editor()
 await act(async()=>dom.container.querySelector<HTMLButtonElement>('[data-author-block="original-block"]')!.click())
 const authors=document.querySelector('[role="dialog"][aria-label="Block authors"]')!
 expect(authors).not.toBeNull()
 expect(authors.querySelector('dd code')!.textContent).toBe('agent · original-creator')
 expect(authors.textContent).toContain('Last edited byAuthor unconfirmed')
 await act(async()=>authors.querySelector<HTMLButtonElement>('[aria-label="Close block authors"]')!.click())
 await openRecovery()
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain(reason)
 expect(api.files.read).not.toHaveBeenCalled()
 const check=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Check original file')!
 expect(check).toBeDefined();expect(check.disabled).toBe(false)
 await act(async()=>{check.click();await vi.waitFor(()=>expect(useAppStore.getState().documentObservationGenerations[key]).toBe(1))})
 expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace',path)
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain(reason)
 expect(notices()[0]!.textContent).not.toContain('The Note was saved.')
 expect(useAppStore.getState().documents[key]!.noteWriteAttribution).toBeUndefined()
 expect(api.files.write).not.toHaveBeenCalled()
 await act(async()=>{originalEditor.view.focus();originalEditor.commands.insertContentAt(1,'Unsaved ')})
 const draft=useAppStore.getState().documents[key]!.content
 await act(async()=>{check.click();await vi.waitFor(()=>expect(useAppStore.getState().documentObservationGenerations[key]).toBe(2))})
 expect(api.files.read).toHaveBeenCalledTimes(2)
 expect(editor()).toBe(originalEditor);expect(editor().state.doc.textContent).toContain('Unsaved Externally changed original')
 expect(useAppStore.getState().documents[key]!.content).toBe(draft);expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain(reason)
 expect(notices()[0]!.textContent).not.toContain('The Note was saved.')
 expect(api.files.write).not.toHaveBeenCalled();expect(await readFile(join(rootPath,path),'utf8')).toBe(external)
})
it('discloses the original read attribution reason from a quiet reader footnote without replacing its body',async()=>{
 const original=useAppStore.getState().documents[key]!
 await dom.render(<NoteReader workspaceId="workspace" {...original}/>)
 const body=dom.container.querySelector('.mobile-note-body')!,details=dom.container.querySelector<HTMLDetailsElement>('.note-reader-metadata')!
 expect(body.textContent).toContain('Externally changed original')
 expect(details.open).toBe(false);expect(details.querySelector('summary')!.textContent).toBe('')
 expect(details.querySelector('summary')!.getAttribute('aria-label')).toBe('Authorship details: unconfirmed')
 expect(details.querySelector('summary svg')).not.toBeNull()
 expect(dom.container.querySelector('[data-note-id] > p[role="status"]')).toBeNull()
 await act(async()=>details.querySelector('summary')!.click())
 expect(details.open).toBe(true);expect(details.textContent).toContain(reason)
 expect(dom.container.querySelector('.mobile-note-body')).toBe(body)
 expect(api.files.read).not.toHaveBeenCalled();expect(api.files.write).not.toHaveBeenCalled()
 expect(await readFile(join(rootPath,path),'utf8')).toBe(external)
})
it('shows one attribution notice through the actual File preview and Source routes when read and write metadata are both unconfirmed',async()=>{
 await act(async()=>{useAppStore.setState(state=>({documents:{...state.documents,[key]:{...state.documents[key]!,noteWriteAttribution:{status:'unconfirmed',reason:'Original metadata recording is pending'}}}}))})
 await dom.render(<WorkbenchPresentationContext.Provider value={presentation}><FileSurfaceView tabId={tab.id} surface={surface}/></WorkbenchPresentationContext.Provider>)
 await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('.note-block-content')).not.toBeNull()})
 await openRecovery()
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain('last confirmed save');expect(notices()[0]!.textContent).toContain('Original metadata recording is pending')
 expect(notices()[0]!.textContent).not.toContain(reason)
 const originalWriteAttribution=useAppStore.getState().documents[key]!.noteWriteAttribution
 await act(async()=>useAppStore.getState().refreshDocument('workspace',path))
 expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace',path)
 expect(useAppStore.getState().documents[key]!.noteWriteAttribution).toBe(originalWriteAttribution)
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain('Original metadata recording is pending')
 await act(async()=>dom.container.querySelector<HTMLButtonElement>('[aria-label="Show source"]')!.click())
 await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('textarea[aria-label="Original file source"]')).not.toBeNull()})
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain('Original metadata recording is pending')
 expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace',path);expect(api.files.write).not.toHaveBeenCalled()
})
