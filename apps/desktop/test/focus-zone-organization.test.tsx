// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { FocusScanLaneContent } from '../src/renderer/src/components/FocusScanLaneContent'
import { FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
import { FocusProjectPreferences } from '../src/renderer/src/components/FocusProjectPreferences'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { focusZoneContainerKey, parseFocusZonePresentations } from '../src/shared/focus-zone-presentation'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { FocusScanLane } from '../src/renderer/src/lib/focus-collection-lanes'
import type { AppConfig } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM(), projectKey = JSON.stringify(['local','root']), zoneKey = focusZoneContainerKey('project','local','root')
const card = (id: string) => dom.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)!
function button(label: string) { const b=document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label); expect(b,label).not.toBeNull(); return b! }
async function click(label: string) { await act(async()=>button(label).click()) }
async function mode(presentation: string) {
 const b=document.querySelector<HTMLButtonElement>(`button[data-focus-zone-presentation="${presentation}"]`); expect(b).not.toBeNull(); await act(async()=>b!.click())
}
function configSave() { return vi.spyOn(api.config,'save').mockImplementation(async(next,expected)=>applyConfigEdit(useAppStore.getState().config!,expected!,next)) }
async function scene() {
 const root={...composerConfig.workspaces[0]!,id:'root',name:'Original project',path:fixturePath('zone-scan/root')}
 const workspaces=[root,...['a','b'].map(id=>({...root,id,path:fixturePath('zone-scan/'+id),repoPath:root.path,branch:'feature/'+id}))]
 const sessions=workspaces.map(w=>({...composerSession('task-'+w.id),workspacePath:w.path,label:'Task '+w.id,status:{state:'working' as const,source:'native-hook' as const,observedAt:Date.now()}}))
 const tabs=Object.fromEntries(workspaces.map(w=>{const tab=createWorkbenchTab('tab-'+w.id,{kind:'agent',phase:'attached',regionId:'region-'+w.id,workspaceId:w.id,sessionId:'task-'+w.id});return [tab.id,tab]}))
 useAppStore.setState({config:{...composerConfig,workspaces,focus:{recentActivityHours:48,topicPresentation:'cards',projects:[{key:projectKey,pinned:true,note:'Original route',color:'blue',collapsed:null}]}},
 mainSurface:'agents',sessions,tabs,layouts:Object.fromEntries(workspaces.map(w=>[w.id,createWorkspaceLayout('group-'+w.id,['tab-'+w.id])])),
 agentNames:{},timelines:{},agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{'task-a':'Original unsent text'}})
 vi.spyOn(api.spatial,'read').mockResolvedValue({schemaVersion:1,revision:1,graph:desktopSpatialGraph(useAppStore.getState(),[])})
 vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
 await initializeSpatialControlFixture(); await dom.render(<GlobalFocusSurface workspaceOpen={false}/>); return useAppStore.getState()
}
it('actual project scan defaults to sections, shares one state rail and switches tags without replacing original bodies or drafts',async()=>{
 configSave(); const original=await scene(), frame=dom.container.querySelector<HTMLElement>('[data-project-group-key]')!
 expect(frame.dataset.focusZonePresentation).toBe('sections')
 expect(frame.querySelectorAll('.focus-project-lanes__status-rail')).toHaveLength(1)
 expect(frame.querySelectorAll('[data-focus-zone-section]')).toHaveLength(3)
 const a=card('task-a'), b=card('task-b'); expect(a).not.toBeNull(); expect(b).not.toBeNull()
 expect(frame.querySelector('[data-focus-zone-id] button[data-focus-project-scope-control]')).not.toBeNull()
 await click('Project preferences · Original project'); await mode('cards');
 expect(frame.dataset.focusZonePresentation).toBe('sections') // Explicit Save, not autosave.
 await click('Save project preferences')
 expect(frame.dataset.focusZonePresentation).toBe('cards'); expect(frame.querySelector('[data-focus-zone-section]')).toBeNull()
 expect(frame.querySelectorAll('[data-focus-zone-tags]')).toHaveLength(3)
 expect(card('task-a')).toBe(a); expect(card('task-b')).toBe(b)
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:zoneKey,presentation:'cards'}])
 expect(useAppStore.getState().config?.focus?.projects).toEqual(original.config?.focus?.projects)
 for(const key of ['sessions','tabs','layouts','agentFocus','agentComposerDrafts'] as const)expect(useAppStore.getState()[key]).toBe(original[key])
 await click('Project preferences · Original project'); await mode('sections'); await click('Save project preferences')
 expect(frame.dataset.focusZonePresentation).toBe('sections'); expect(card('task-a')).toBe(a)
})

const topic=(id:string):FocusScanLane=>({id,workspaceId:'topics',projectId:'topics',projectWorkspaceId:'topics',hostId:'local',name:id,labels:['Topics',id],path:fixturePath('topics/'+id),topicId:id,objectKind:'topic',recovery:null,summary:null,
 contextRefs:[{hostId:'local',id:'task-'+id}],activeAgentRefs:[{hostId:'local',id:'task-'+id}]})
async function collection(confirmed=true,multiple=false,global?:'cards'|'sections') {
 const topics=[topic('Alpha'),topic('Beta')], category={categoryId:'original-category',hostId:'local',directoryPath:fixturePath('category'),title:'Research',revision:'original',spaceId:'original-category-space'}
 const lane:FocusScanLane={...topic('aggregate'),id:'original-collection',name:'Research',labels:['Research'],topicId:null,collection:{confirmed,categories:multiple?[category,{...category,spaceId:'second-space'}]:[category],topics},contextRefs:topics.flatMap(t=>t.contextRefs),activeAgentRefs:topics.flatMap(t=>t.activeAgentRefs)}
 const contexts=topics.map(t=>agentContextForSession({...composerSession('task-'+t.topicId),label:'Task '+t.topicId,workspacePath:t.path,status:{state:'working',source:'native-hook',observedAt:Date.now()}},undefined,undefined,undefined,t.topicId))
 useAppStore.setState({config:{...composerConfig,focus:{recentActivityHours:48,...(global?{topicPresentation:global}:{})}}})
 await dom.render(<FocusProjectLanes resourceMenus lanes={[lane]} selectedProjectKey="" onSelect={()=>{}} renderLane={(scan,heading,compact)=><FocusScanLaneContent lane={scan} contexts={contexts} compact={compact} heading={heading} metrics={{width:600,padding:4,gap:2,cardGap:2}} renderCards={(rows,columns,tags,sections)=><FocusContextCards contexts={rows} columns={columns} topics={tags} sections={sections} visible scrollRef={{current:null}} selectedId={null} onSelect={()=>{}} goalLinks={new Map()} identities={new Map()}/>}/>}/> )
 return dom.container.querySelector<HTMLElement>('[data-focus-zone-presentation]')!
}
it('actual Collection retains authored global choice, then exact override and default reset use the same original Topic cards',async()=>{
 configSave(); const frame=await collection(true,false,'sections'); expect(frame.dataset.focusZonePresentation).toBe('sections')
 const a=card('task-Alpha'); expect(a).not.toBeNull(); expect(frame.querySelectorAll('[data-focus-topic-section]')).toHaveLength(2)
 await click('Container preferences · Research'); await mode('cards'); await click('Save container preferences')
 expect(frame.dataset.focusZonePresentation).toBe('cards'); expect(card('task-Alpha')).toBe(a)
 expect(frame.querySelectorAll('[data-focus-topic-id]')).toHaveLength(2)
 expect(useAppStore.getState().config?.focus?.topicPresentation).toBe('sections')
 await click('Container preferences · Research')
 const reset=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.startsWith('Default ·'))!; await act(async()=>reset.click()); await click('Save container preferences')
 expect(frame.dataset.focusZonePresentation).toBe('sections'); expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([])
 expect(card('task-Alpha')).toBe(a)
})
it('unknown and multiple original Collections never save a guessed unique identity and keep original members available',async()=>{
 const frame=await collection(false,true)
 expect(frame.dataset.focusContainerKey).toBeUndefined(); expect(frame.dataset.focusZonePresentation).toBe('cards'); expect(card('task-Beta')).not.toBeNull()
 await click('Container preferences · Research'); expect(document.querySelector('button[data-focus-zone-presentation]')).toBeNull()
 expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('one confirmed Collection')
})
it('real mounted project merges another container and unrelated project note while keeping same-container conflict and draft for explicit review',async()=>{
 configSave(); await scene(); await click('Project preferences · Original project'); await mode('cards')
 const state=useAppStore.getState(), other={key:focusZoneContainerKey('collection','remote','other'),presentation:'sections' as const}
 await act(async()=>useAppStore.setState({config:{...state.config!,focus:{...state.config!.focus!,zonePresentations:[other],projects:[{...state.config!.focus!.projects![0]!,note:'Concurrent note'}]}}}))
 await click('Save project preferences')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([other,{key:zoneKey,presentation:'cards'}]); expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('Concurrent note')
})
it('invalid identities or mode fields are refused without guessing another container',()=>{
 for(const value of [[{key:'["local","root"]',presentation:'cards'}],[{key:zoneKey,presentation:'tags'}],[{key:zoneKey,presentation:'cards',extra:1}],[{key:zoneKey,presentation:'cards'},{key:zoneKey,presentation:'sections'}]])expect(()=>parseFocusZonePresentations(value)).toThrow()
})

it('a same-container conflicting save keeps the selected draft and explicit review retries only that choice',async()=>{
 configSave(); await scene(); await click('Project preferences · Original project'); await mode('cards')
 const state=useAppStore.getState()
 await act(async()=>useAppStore.setState({config:{...state.config!,focus:{...state.config!.focus!,zonePresentations:[{key:zoneKey,presentation:'sections'}]}}}))
 await click('Save project preferences')
 expect(document.querySelector('[data-focus-project-preferences] [role="status"]')?.textContent).toContain('changed since')
 expect(document.querySelector('button[data-focus-zone-presentation="cards"]')?.getAttribute('aria-pressed')).toBe('true')
 await click('Review current project preferences'); await click('Save project preferences')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:zoneKey,presentation:'cards'}])
})
it('an older Zone save cannot close a reopened panel or overwrite its later mode and focused note',async()=>{
 let resolve!:(value:AppConfig)=>void
 const pending=new Promise<AppConfig>(done=>{resolve=done})
 vi.spyOn(api.config,'save').mockImplementation(async()=>pending)
 await scene(); const before=useAppStore.getState().config!
 await click('Project preferences · Original project'); await mode('cards'); await click('Save project preferences')
 await click('Cancel'); await click('Project preferences · Original project'); await mode('sections')
 const input=document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!; await act(async()=>input.focus())
 await act(async()=>resolve({...before,focus:{...before.focus!,zonePresentations:[{key:zoneKey,presentation:'cards'}]}}))
 expect(document.querySelector('[data-focus-project-preferences]')).not.toBeNull()
 expect(document.querySelector('button[data-focus-zone-presentation="sections"]')?.getAttribute('aria-pressed')).toBe('true')
 expect(document.activeElement).toBe(input)
})
it('one original Context in two worktree Zones keeps both exact actionable labels and another Host does not borrow the override',async()=>{
 const contexts=[agentContextForSession({...composerSession('shared'),label:'One original task',status:{state:'working',source:'native-hook',observedAt:Date.now()}},undefined,undefined,undefined,null)]
 const lane=(id:string,hostId='local'):FocusScanLane=>({...topic(id),hostId,projectId:'root',workspaceId:id,projectWorkspaceId:'root',topicId:null,objectKind:undefined,labels:['Original project',id],contextRefs:[{hostId,id:'shared'}],activeAgentRefs:[{hostId,id:'shared'}]})
 useAppStore.setState({config:{...composerConfig,focus:{recentActivityHours:48,zonePresentations:[{key:zoneKey,presentation:'cards'}]}}})
 await dom.render(<FocusProjectLanes resourceMenus lanes={[lane('first'),lane('second'),lane('third','remote')]} selectedProjectKey={projectKey} currentLaneId="second" onSelect={()=>{}} renderLane={(scan,heading)=><FocusScanLaneContent lane={scan} contexts={scan.hostId==='local'?contexts:[]} heading={heading} metrics={{width:600,padding:4,gap:2,cardGap:2}}
 renderCards={(rows,columns,tags,sections)=><FocusContextCards contexts={rows} columns={columns} topics={tags} sections={sections} visible scrollRef={{current:null}} selectedId={null} onSelect={()=>{}} goalLinks={new Map()} identities={new Map()}/>}/>}/> )
 const frames=[...dom.container.querySelectorAll<HTMLElement>('[data-project-group-key]')]
 expect(frames.map(f=>f.dataset.focusZonePresentation)).toEqual(['cards','sections'])
 expect(frames[0]!.querySelectorAll('button.focus-context')).toHaveLength(1)
 expect([...frames[0]!.querySelectorAll<HTMLElement>('[data-focus-zone-tags] [data-focus-zone-id]')].map(node=>node.dataset.focusZoneId)).toEqual(['first','second'])
 const current=frames[0]!.querySelector('[data-focus-zone-id="second"] button')!
 expect(current.getAttribute('aria-current')).toBe('location'); expect(current.hasAttribute('data-focus-project-scope-control')).toBe(true)
 expect(current.getAttribute('title')).toContain('/second')
})
