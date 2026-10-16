// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { NoteFileMutations } from '../src/main/note-file-mutations'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
const disposals: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0).reverse()) await dispose() })
it('serializes managed Note creation on the original durable lease while ordinary file creation remains available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'note-mutation-lease-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const workspace: WorkspaceRecord = { id: 'notes', name: 'Notes', hostId: 'local', kind: 'folder', path: root }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); disposals.push(() => files.dispose())
  const store = new AgentMuxNotebookStore(join(root, 'state', 'notebooks.sqlite')), mutations = new NoteFileMutations(files, store.runWithWriteLease.bind(store))
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), held = new Promise<void>(resolve => { entered = resolve })
  const blocker = store.runWithWriteLease(async () => { entered(); await gate }); await held
  const originalCreate = vi.spyOn(files, 'create'), note = mutations.create(workspace, { path: 'late.note.md', kind: 'file' })
  await mutations.create(workspace, { path: 'ordinary.txt', kind: 'file' })
  expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('')
  expect(originalCreate.mock.calls.some(([, input]) => input.path === 'late.note.md')).toBe(false)
  release(); await blocker; await note
  expect(await readFile(join(root, 'late.note.md'), 'utf8')).toBe('')
})

it('queues managed directory moves and Note deletion behind the same original Note lease',async()=>{
 const root=await mkdtemp(join(tmpdir(),'note-mutation-move-'));disposals.push(()=>rm(root,{recursive:true,force:true}));const workspace:WorkspaceRecord={id:'notes',name:'Notes',hostId:'local',kind:'folder',path:root},files=new WorkspaceFiles(()=>({id:'local',kind:'local'}) as never);disposals.push(()=>files.dispose());const store=new AgentMuxNotebookStore(join(root,'state','notes.sqlite')),mutations=new NoteFileMutations(files,store.runWithWriteLease.bind(store))
 await mkdir(join(root,'original'));await writeFile(join(root,'original','inside.note.md'),'knowledge');await writeFile(join(root,'deleted.note.md'),'selected')
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r}),blocker=store.runWithWriteLease(async()=>{entered();await gate});await held
 const move=vi.spyOn(files,'move'),del=vi.spyOn(files,'delete'),moving=mutations.move(workspace,workspace,{source:{workspaceId:'notes',path:'original'},destination:{workspaceId:'notes',path:'moved'}}),deleting=mutations.delete(workspace,'deleted.note.md')
 await files.readDirectory(workspace,'.');expect(move).not.toHaveBeenCalled();expect(del).not.toHaveBeenCalled();expect(await readFile(join(root,'original','inside.note.md'),'utf8')).toBe('knowledge');release();await blocker;expect(await moving).toMatchObject({status:'moved'});await deleting;expect(await readFile(join(root,'moved','inside.note.md'),'utf8')).toBe('knowledge');await expect(readFile(join(root,'deleted.note.md'),'utf8')).rejects.toMatchObject({code:'ENOENT'})
})
