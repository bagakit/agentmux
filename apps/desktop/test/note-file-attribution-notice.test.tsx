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
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { api } from '../src/renderer/src/lib/api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
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
  documents: { [key]: read.document }, dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, editorRegionModes: {}, mainSurface: 'recall' })
 vi.spyOn(api.files, 'read').mockImplementation(async(id,requested)=>{expect(id).toBe('workspace');expect(requested).toBe(path);return writer.read(workspace,requested)})
 vi.spyOn(api.files, 'write').mockRejectedValue(new Error('Checking attribution must never write'))
 vi.spyOn(api.files, 'observe').mockResolvedValue();vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async()=>{await files.dispose();await rm(rootPath,{recursive:true,force:true})})
const presentation={active:true,survey:false,retainedRegionId:surface.regionId,tabHostId:'original-host',reference:{displayWorkspaceId:'workspace',groupId:'original-group',tabId:tab.id,regionId:surface.regionId}}
const notices=()=>[...dom.container.querySelectorAll<HTMLElement>('[role="status"]')].filter(node=>node.textContent?.includes('Block authorship is unconfirmed:'))
const editor=()=>(dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor
it('keeps the actual read attribution reason and original creator visible in Recall, checks the original owner and preserves later rich input',async()=>{
 await dom.render(<WorkbenchPresentationContext.Provider value={presentation}><NoteFileSurfaceView tabId={tab.id} surface={surface}/></WorkbenchPresentationContext.Provider>)
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain(reason)
 const originalEditor=editor(),block=dom.container.querySelector<HTMLElement>('[data-block-id="original-block"]')!
 expect(block.title).toContain('Created: Agent original-creator');expect(block.title).toContain('Last edited: Unknown')
 expect(api.files.read).not.toHaveBeenCalled()
 await act(async()=>{originalEditor.view.focus();originalEditor.commands.insertContentAt(1,'Unsaved ')})
 const draft=useAppStore.getState().documents[key]!.content
 const check=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Check original file')!
 expect(check).toBeDefined();expect(check.disabled).toBe(false)
 await act(async()=>check.click())
 await act(async()=>{await vi.waitFor(()=>expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace',path))})
 expect(editor()).toBe(originalEditor);expect(editor().state.doc.textContent).toContain('Unsaved Externally changed original')
 expect(useAppStore.getState().documents[key]!.content).toBe(draft);expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain(reason)
 expect(api.files.write).not.toHaveBeenCalled();expect(await readFile(join(rootPath,path),'utf8')).toBe(external)
})
it('shows one attribution notice through the actual File preview and Source routes when read and write metadata are both unconfirmed',async()=>{
 await act(async()=>{useAppStore.setState(state=>({documents:{...state.documents,[key]:{...state.documents[key]!,noteWriteAttribution:{status:'unconfirmed',reason:'Original metadata recording is pending'}}}}))})
 await dom.render(<WorkbenchPresentationContext.Provider value={presentation}><FileSurfaceView tabId={tab.id} surface={surface}/></WorkbenchPresentationContext.Provider>)
 await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('.note-block-content')).not.toBeNull()})
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain('The Note was saved.');expect(notices()[0]!.textContent).toContain('Original metadata recording is pending')
 expect(notices()[0]!.textContent).not.toContain(reason)
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()==='Source')!.click())
 await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('textarea[aria-label="Original file source"]')).not.toBeNull()})
 expect(notices()).toHaveLength(1);expect(notices()[0]!.textContent).toContain('Original metadata recording is pending')
 expect(api.files.read).not.toHaveBeenCalled();expect(api.files.write).not.toHaveBeenCalled()
})
