const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { NOTES_WORKSPACE_ID } from '../src/shared/notes-library'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
const original = useAppStore.getState()
let release: (() => void) | undefined, dispose: (() => void) | undefined

afterEach(() => { release?.(); dispose?.(); release = undefined; dispose = undefined; vi.restoreAllMocks(); useAppStore.setState(original, true) })
it('publishes the restored workface and admits a later Notes event while the initial file watch is still reconnecting', async () => {
  const preview = await api.config.get(), from = {hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID,workspacePath:_hygiene_fixturePath("old"),path:'original.note.json'}, to = {...from,workspaceId:NOTES_WORKSPACE_ID,workspacePath:_hygiene_fixturePath("notes-one")}
  const note = createWorkbenchTab('original-tab',{kind:'file',regionId:'original-region',workspaceId:from.workspaceId,path:from.path})
  note.space = {spaceId:JSON.stringify(['local',_hygiene_fixturePath("old")]),zoneId:'original-zone'}
  const layout = createWorkspaceLayout('original-group',[note.id]), key = documentKey(from.workspaceId,from.path), mappedKey = documentKey(to.workspaceId,to.path)
  const config = {...preview,workspaces:[{id:from.workspaceId,hostId:'local',name:'Topics',path:from.workspacePath,kind:'folder' as const},{id:to.workspaceId,hostId:'local',name:'Recall',path:to.workspacePath,kind:'folder' as const}]}
  useAppStore.setState({...original,loading:true,config,restoredWorkbench:{tabs:{[note.id]:note},layouts:{[from.workspaceId]:layout}},tabs:{},layouts:{},
    documents:{[key]:{path:from.path,content:'ORIGINAL UNSAVED',revision:'disk'}},dirtyDocuments:{[key]:true},
    recallNotebookId:'original-book',recallNoteId:'original-note',recallZoneSelection:{zoneId:'original-zone',selection:[{tabId:note.id,regionId:'original-region'}],active:{tabId:note.id,regionId:'original-region'}},
    spaceZoneBindings:{'dedicated-zone':{workspaceId:NOTES_WORKSPACE_ID,spaceId:JSON.stringify(['local',_hygiene_fixturePath("notes-one")]),directoryPath:_hygiene_fixturePath("notes-one")}}})
  const first: NotesStorageSnapshot = {directory:_hygiene_fixturePath("notes-one"),catalogPath:_hygiene_fixturePath("notes-one/notebooks.json"),operation:null,resourceChanges:[{noteId:'original-note',from,to}],directoryChanges:[]}
  let listener!: (snapshot:NotesStorageSnapshot) => void
  vi.spyOn(api.config,'get').mockResolvedValue(config)
  vi.spyOn(api.providers,'list').mockResolvedValue({catalog:[],warnings:[]})
  vi.spyOn(api.sessions,'snapshot').mockResolvedValue({sessions:[],timelines:{},recoveryCandidates:[]})
  vi.spyOn(api.spatial,'read').mockResolvedValue(null)
  vi.spyOn(api.notesStorage,'inspect').mockResolvedValue(first)
  vi.spyOn(api.notesStorage,'onChange').mockImplementation(callback => {listener=callback;return ()=>{}})
  vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
  vi.spyOn(api.files,'observe').mockResolvedValue({status:'unavailable',code:'WATCH_UNAVAILABLE',message:'Observation unconfirmed'})
  let published = false
  const initializing = useAppStore.getState().initialize().then(value=>{dispose=value;published=true})
  await vi.waitFor(()=>expect(published).toBe(true))
  expect(release).toBeDefined()
  const beforeLater = useAppStore.getState()
  expect(beforeLater.tabs[note.id]?.regions['original-region']).toMatchObject({workspaceId:NOTES_WORKSPACE_ID,path:from.path})
  listener({...first,directory:_hygiene_fixturePath("notes-two"),catalogPath:_hygiene_fixturePath("notes-two/notebooks.json"),resourceChanges:[...first.resourceChanges,{noteId:'original-note',from:to,to:{...to,workspacePath:_hygiene_fixturePath("notes-two")}}],directoryChanges:[{from:_hygiene_fixturePath("notes-one"),to:_hygiene_fixturePath("notes-two")}]})
  expect(useAppStore.getState().spaceZoneBindings['dedicated-zone']?.directoryPath).toBe(_hygiene_fixturePath("notes-two"))
  expect(useAppStore.getState().documents[mappedKey]?.content).toBe('ORIGINAL UNSAVED')
  expect(useAppStore.getState().dirtyDocuments[mappedKey]).toBe(true)
  expect(useAppStore.getState().tabs[note.id]?.space).toEqual(note.space)
  expect(useAppStore.getState().layouts[from.workspaceId]).toEqual(layout)
  expect(useAppStore.getState().recallNoteId).toBe('original-note')
  release!(); await initializing
})
