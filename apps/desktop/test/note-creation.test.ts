import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createNoteWithAvailableName } from '../src/renderer/src/lib/note-names'
const roots: string[] = []
const initial = useAppStore.getState()
afterEach(async () => { vi.restoreAllMocks(); useAppStore.setState(initial, true); useLauncherState.setState({drafts:{}}); await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true}))) })
describe('actual existing Note creation owner counterexamples', () => {
  it('does not turn permission failure into one hundred collision retries', async () => {
    let calls=0
    await createNoteWithAvailableName(new Date(2026,9,4),async()=>{ calls++; return {status:'error',code:'EACCES',message:'permission'} }).catch(()=>undefined)
    console.log(JSON.stringify({case:'noncollision',calls}))
    expect(calls).toBe(1)
  })
  it('creates a true home Note under the retained birth directory', async () => {
    const spaceId=directoryIdentity('local','/scratch/topic--a'), zoneId=homeZoneId(spaceId)
    const tab=createWorkbenchTab('home-launcher',{regionId:initialWorkbenchRegionId('home-launcher'),kind:'launcher',workspaceId:'__scratch__'})
    tab.space={spaceId,zoneId}; tab.topicId='a'
    const config: AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Local'}],executors:{},workspaces:[{id:'__scratch__',name:'Scratch',hostId:'local',path:'/scratch',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
    useAppStore.setState({config,activeWorkspaceId:'__scratch__',tabs:{[tab.id]:tab},layouts:{__scratch__:createWorkspaceLayout('g',[tab.id])},spaceZoneBindings:{[zoneId]:{spaceId,workspaceId:'__scratch__'}},documents:{}})
    vi.spyOn(api.scratch,'listTopics').mockResolvedValue([])
    const paths:string[]=[]
    vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{ paths.push(input.path); return {status:'written',revision:'created'} })
    useAppStore.setState({openFile:vi.fn(async()=>true)})
    await useAppStore.getState().createNote('g',{tabId:tab.id,regionId:initialWorkbenchRegionId(tab.id)},'draft')
    console.log(JSON.stringify({case:'retained-home-resource',paths}))
    expect(paths).toHaveLength(1); expect(paths[0]).toMatch(/^topic--a\/note-.*\.note\.json$/)
  })
})
