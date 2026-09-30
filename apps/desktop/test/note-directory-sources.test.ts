import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, WorkspaceDirectoryEntry } from '../src/shared/contracts'
import { newNoteDocument } from '../src/shared/note-document'
import { api } from '../src/renderer/src/lib/api'
import { noteDirectorySourceFacts, noteDirectorySourceKey } from '../src/renderer/src/lib/note-directory-sources'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
const initial=useAppStore.getState()
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Local'}],executors:{},workspaces:[{id:'r',name:'R',hostId:'local',path:'/scratch',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
const entry=(name:string):WorkspaceDirectoryEntry=>({name,path:`topic--a/${name}`,isDirectory:false,isSymlink:false})
const document=(path:string,noteId:string)=>({path,content:JSON.stringify(newNoteDocument(noteId,noteId,`${noteId}-block`)),revision:noteId})
function fixture(){
  let tab=createWorkbenchTab('mixed',{kind:'launcher',regionId:'launcher',workspaceId:'r'})
  tab=addWorkbenchRegion(tab,'launcher','right',{kind:'file',regionId:'a-file',workspaceId:'r',path:'topic--a/a.note.json'})
  tab=addWorkbenchRegion(tab,'a-file','right',{kind:'file',regionId:'b-file',workspaceId:'r',path:'topic--a/b.note.json'})
  useAppStore.setState({config,activeWorkspaceId:'r',tabs:{[tab.id]:tab},layouts:{r:createWorkspaceLayout('g',[tab.id])},documents:{[documentKey('r','topic--a/a.note.json')]:document('topic--a/a.note.json','a')},documentIssues:{},noteDirectorySources:{},workspaceFileRevisions:{},dirtyDocuments:{}})
  vi.spyOn(api.files,'observe').mockResolvedValue(undefined);vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined)
  return tab
}
afterEach(()=>{vi.restoreAllMocks();useAppStore.setState(initial,true)})
it('explicitly reads one original Note directory and retains closed sources as unread',async()=>{
  const tab=fixture(),before=useAppStore.getState()
  const directory=vi.spyOn(api.files,'readDirectory').mockResolvedValue([entry('a.note.json'),entry('b.note.json'),entry('closed.note.json'),{...entry('nested'),isDirectory:true},entry('ordinary.md')])
  const read=vi.spyOn(api.files,'read').mockImplementation(async(_workspace,path)=>({status:'read',document:document(path,'b')}))
  const scope=await useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  expect(directory).toHaveBeenCalledWith('r','topic--a');expect(read.mock.calls).toEqual([['r','topic--a/b.note.json']])
  expect(scope?.paths).toEqual(['topic--a/a.note.json','topic--a/b.note.json','topic--a/closed.note.json'])
  expect(scope?.status).toBe('listed');expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().documents[documentKey('r','topic--a/closed.note.json')]).toBeUndefined()
  expect(noteDirectorySourceFacts(scope!,useAppStore.getState())).toEqual({status:'partial',confirmedPaths:['topic--a/a.note.json','topic--a/b.note.json'],unreadPaths:['topic--a/closed.note.json'],unconfirmedPaths:[],issues:[]})
  directory.mockResolvedValue([entry('a.note.json'),entry('b.note.json')])
  const complete=await useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  expect(noteDirectorySourceFacts(complete!,useAppStore.getState()).status).toBe('complete');expect(read).toHaveBeenCalledTimes(1)
})
it('keeps duplicate Note identities unconfirmed rather than assigning a source',async()=>{
  const tab=fixture();useAppStore.setState(state=>({documents:{...state.documents,[documentKey('r','topic--a/b.note.json')]:document('topic--a/b.note.json','a')}}))
  vi.spyOn(api.files,'readDirectory').mockResolvedValue([entry('a.note.json'),entry('b.note.json')])
  const read=vi.spyOn(api.files,'read')
  const scope=await useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file'),facts=noteDirectorySourceFacts(scope!,useAppStore.getState())
  expect(facts.status).toBe('partial');expect(facts.confirmedPaths).toEqual([]);expect(facts.unconfirmedPaths).toEqual(['topic--a/a.note.json','topic--a/b.note.json']);expect(facts.issues).toHaveLength(1);expect(read).not.toHaveBeenCalled()
})
it('preserves the original Note when a directory listing is empty or fails',async()=>{
  const tab=fixture(),key=documentKey('r','topic--a/a.note.json'),before=useAppStore.getState().documents[key]
  useAppStore.setState({dirtyDocuments:{[key]:true}})
  const listing=vi.spyOn(api.files,'readDirectory').mockResolvedValue([]),write=vi.spyOn(api.files,'write')
  const empty=await useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  expect(noteDirectorySourceFacts(empty!,useAppStore.getState())).toMatchObject({status:'partial',unconfirmedPaths:['topic--a/a.note.json']})
  listing.mockRejectedValue(Object.assign(new Error('Permission denied'),{code:'EACCES'}))
  const failed=await useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  expect(failed?.status).toBe('unknown');expect(failed?.issue).toContain('Permission denied')
  expect(useAppStore.getState().documents[key]).toBe(before);expect(useAppStore.getState().dirtyDocuments[key]).toBe(true);expect(write).not.toHaveBeenCalled()
})
it('never reads a replacement resource after its pending directory observation',async()=>{
  const tab=fixture();let release!:(entries:WorkspaceDirectoryEntry[])=>void
  const listing=vi.spyOn(api.files,'readDirectory').mockImplementation(()=>new Promise(resolve=>{release=resolve})),read=vi.spyOn(api.files,'read')
  const refreshing=useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  expect(useAppStore.getState().noteDirectorySources[noteDirectorySourceKey('r','topic--a/a.note.json')]?.status).toBe('reading')
  useAppStore.setState({config:{...config,workspaces:config.workspaces.map(workspace=>({...workspace,path:'/replacement'}))}})
  release([entry('b.note.json')]);const result=await refreshing
  expect(result).toMatchObject({workspacePath:'/scratch',directory:'topic--a',status:'unknown',paths:[]});expect(listing).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled()
})
it('never attaches a source returned after its resource changed',async()=>{
  const tab=fixture(),before=useAppStore.getState();let release!:()=>void;const wait=new Promise<void>(yes=>{release=yes})
  vi.spyOn(api.files,'readDirectory').mockResolvedValue([entry('a.note.json'),entry('b.note.json')])
  const read=vi.spyOn(api.files,'read').mockImplementation(async(_workspace,path)=>{await wait;return{status:'read',document:document(path,'b')}})
  const refreshing=useAppStore.getState().refreshNoteDirectorySources(tab.id,'a-file')
  await vi.waitFor(()=>expect(read).toHaveBeenCalledWith('r','topic--a/b.note.json'))
  useAppStore.setState({config:{...config,workspaces:config.workspaces.map(workspace=>({...workspace,hostId:'other-host'}))}})
  release();const result=await refreshing
  expect(result?.status).toBe('unknown');expect(useAppStore.getState().documents).toBe(before.documents);expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().layouts).toBe(before.layouts)
})
