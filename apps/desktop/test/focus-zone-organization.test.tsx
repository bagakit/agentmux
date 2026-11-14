// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { FocusScanLaneContent } from '../src/renderer/src/components/FocusScanLaneContent'
import { FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
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
async function scene(presentation?: 'cards' | 'sections') {
 const root={...composerConfig.workspaces[0]!,id:'root',name:'Original project',path:fixturePath('zone-scan/root')}
 const workspaces=[root,...['a','b'].map(id=>({...root,id,path:fixturePath('zone-scan/'+id),repoPath:root.path,branch:'feature/'+id}))]
 const sessions=workspaces.map(w=>({...composerSession('task-'+w.id),workspacePath:w.path,label:'Task '+w.id,status:{state:'working' as const,source:'native-hook' as const,observedAt:Date.now()}}))
 const tabs=Object.fromEntries(workspaces.map(w=>{const tab=createWorkbenchTab('tab-'+w.id,{kind:'agent',phase:'attached',regionId:'region-'+w.id,workspaceId:w.id,sessionId:'task-'+w.id});return [tab.id,tab]}))
 useAppStore.setState({config:{...composerConfig,workspaces,focus:{recentActivityHours:48,topicPresentation:'cards',...(presentation ? {zonePresentations:[{key:zoneKey,presentation}]} : {}),projects:[{key:projectKey,pinned:true,note:'Original route',color:'blue',collapsed:null}]}},
 mainSurface:'agents',sessions,tabs,layouts:Object.fromEntries(workspaces.map(w=>[w.id,createWorkspaceLayout('group-'+w.id,['tab-'+w.id])])),
 agentNames:{},timelines:{},agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{'task-a':'Original unsent text'}})
 vi.spyOn(api.spatial,'read').mockResolvedValue({schemaVersion:1,revision:1,graph:desktopSpatialGraph(useAppStore.getState(),[])})
 vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
 await initializeSpatialControlFixture(); await dom.render(<GlobalFocusSurface workspaceOpen={false}/>); return useAppStore.getState()
}
it('actual project scan defaults to tags, shares one state rail and switches sections without replacing original bodies or drafts',async()=>{
 configSave(); const original=await scene(), frame=dom.container.querySelector<HTMLElement>('[data-project-group-key]')!
 expect(frame.dataset.focusZonePresentation).toBe('cards')
 expect(frame.querySelectorAll('.focus-project-lanes__status-rail')).toHaveLength(1)
 expect(frame.querySelectorAll('[data-focus-zone-tags]')).toHaveLength(3)
 expect(frame.querySelectorAll('[data-focus-zone-section]')).toHaveLength(0)
 const a=card('task-a'), b=card('task-b'); expect(a).not.toBeNull(); expect(b).not.toBeNull()
 expect(frame.querySelector('[data-focus-zone-id] button[data-focus-project-scope-control]')).not.toBeNull()
 expect(frame.querySelector('button[data-focus-zone-presentation="cards"]')?.getAttribute('aria-pressed')).toBe('true')
 expect(frame.querySelector('[aria-label="Default Zone layout · Original project"]')?.getAttribute('title')).toContain('Tags')
 await mode('sections')
 expect(frame.dataset.focusZonePresentation).toBe('sections'); expect(frame.querySelector('[data-focus-zone-tags]')).toBeNull()
 expect(frame.querySelectorAll('[data-focus-zone-section]')).toHaveLength(3)
 expect(card('task-a')).toBe(a); expect(card('task-b')).toBe(b)
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:zoneKey,presentation:'sections'}])
 expect(useAppStore.getState().config?.focus?.projects).toEqual(original.config?.focus?.projects)
 for(const key of ['sessions','tabs','layouts','agentFocus','agentComposerDrafts'] as const)expect(useAppStore.getState()[key]).toBe(original[key])
 await mode('cards')
 expect(frame.dataset.focusZonePresentation).toBe('cards'); expect(card('task-a')).toBe(a)
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
it('an unconfigured Collection uses sections and its original preferences present the same default',async()=>{
 const frame=await collection()
 expect(frame.dataset.focusZonePresentation).toBe('sections')
 expect(frame.querySelectorAll('[data-focus-topic-section]')).toHaveLength(2)
 expect(frame.querySelector('[data-focus-zone-footer]')).toBeNull()
 expect(frame.querySelector('button[data-focus-zone-presentation="sections"]')?.getAttribute('aria-pressed')).toBe('true')
 expect(frame.querySelector('[aria-label="Default Zone layout · Research"]')?.getAttribute('title')).toContain('Sections')
 expect(useAppStore.getState().config?.focus?.topicPresentation).toBeUndefined()
 expect(useAppStore.getState().config?.focus?.zonePresentations).toBeUndefined()
})
it('actual Collection retains authored global choice, then exact override and default reset use the same original Topic cards',async()=>{
 configSave(); const frame=await collection(true,false,'cards'); expect(frame.dataset.focusZonePresentation).toBe('cards')
 const a=card('task-Alpha'); expect(a).not.toBeNull(); expect(frame.querySelectorAll('[data-focus-zone-footer]')).toHaveLength(2)
 await mode('sections')
 expect(frame.dataset.focusZonePresentation).toBe('sections'); expect(card('task-Alpha')).toBe(a)
 expect(frame.querySelectorAll('[data-focus-topic-id]')).toHaveLength(2)
 expect(useAppStore.getState().config?.focus?.topicPresentation).toBe('cards')
 await click('Default Zone layout · Research')
 expect(frame.dataset.focusZonePresentation).toBe('cards'); expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([])
 expect(card('task-Alpha')).toBe(a)
})
it('unknown and multiple original Collections never save a guessed unique identity and keep original members available',async()=>{
 const frame=await collection(false,true)
 expect(frame.dataset.focusContainerKey).toBeUndefined(); expect(frame.dataset.focusZonePresentation).toBe('sections'); expect(card('task-Beta')).not.toBeNull()
 expect(frame.querySelector('button[data-focus-zone-presentation]')).toBeNull()
 expect(frame.querySelector('.focus-zone-layout__unavailable')?.getAttribute('title')).toContain('one confirmed Collection')
})
it('real mounted header merges another container and a concurrent project note without writing the unrelated fields',async()=>{
 await scene()
 const state=useAppStore.getState(), other={key:focusZoneContainerKey('collection','remote','other'),presentation:'sections' as const}
 vi.spyOn(api.config,'save').mockImplementationOnce(async(next,expected)=>{
  const current={...state.config!,focus:{...state.config!.focus!,zonePresentations:[other],projects:[{...state.config!.focus!.projects![0]!,note:'Concurrent note'}]}}
  useAppStore.setState({config:current})
  const saved=applyConfigEdit(current,expected!,next); useAppStore.setState({config:saved}); return saved
 })
 await mode('sections')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([other,{key:zoneKey,presentation:'sections'}]); expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('Concurrent note')
})
it('invalid identities or mode fields are refused without guessing another container',()=>{
 for(const value of [[{key:'["local","root"]',presentation:'cards'}],[{key:zoneKey,presentation:'tags'}],[{key:zoneKey,presentation:'cards',extra:1}],[{key:zoneKey,presentation:'cards'},{key:zoneKey,presentation:'sections'}]])expect(()=>parseFocusZonePresentations(value)).toThrow()
})

it('a conflicting header save keeps its intent for explicit review and retry instead of silently overwriting the original container',async()=>{
 await scene()
 const save=configSave(), implementation=save.getMockImplementation()!
 save.mockImplementationOnce(async(next,expected)=>{
  const state=useAppStore.getState(); useAppStore.setState({config:{...state.config!,focus:{...state.config!.focus!,zonePresentations:[{key:zoneKey,presentation:'cards'}]}}})
  return implementation(next,expected)
 })
 await mode('sections')
 const status=dom.container.querySelector('.focus-zone-layout__status')!
 expect(status.textContent).toContain('changed since'); expect(status.textContent).toContain('Requested: Sections')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:zoneKey,presentation:'cards'}])
 await click('Review current layout'); await click('Retry layout')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:zoneKey,presentation:'sections'}])
})
it('one original Context in two worktree Zones keeps both exact actionable labels and another Host does not borrow the override',async()=>{
 const contexts=[agentContextForSession({...composerSession('shared'),label:'One original task',status:{state:'working',source:'native-hook',observedAt:Date.now()}},undefined,undefined,undefined,null)]
 const lane=(id:string,hostId='local'):FocusScanLane=>({...topic(id),hostId,projectId:'root',workspaceId:id,projectWorkspaceId:'root',topicId:null,objectKind:undefined,labels:['Original project',id],contextRefs:[{hostId,id:'shared'}],activeAgentRefs:[{hostId,id:'shared'}]})
 useAppStore.setState({config:{...composerConfig,focus:{recentActivityHours:48,zonePresentations:[{key:zoneKey,presentation:'sections'}]}}})
 await dom.render(<FocusProjectLanes resourceMenus lanes={[lane('first'),lane('second'),lane('third','remote')]} selectedProjectKey={projectKey} currentLaneId="second" onSelect={()=>{}} renderLane={(scan,heading)=><FocusScanLaneContent lane={scan} contexts={scan.hostId==='local'?contexts:[]} heading={heading} metrics={{width:600,padding:4,gap:2,cardGap:2}}
 renderCards={(rows,columns,tags,sections)=><FocusContextCards contexts={rows} columns={columns} topics={tags} sections={sections} visible scrollRef={{current:null}} selectedId={null} onSelect={()=>{}} goalLinks={new Map()} identities={new Map()}/>}/>}/> )
 const frames=[...dom.container.querySelectorAll<HTMLElement>('[data-project-group-key]')]
 expect(frames.map(f=>f.dataset.focusZonePresentation)).toEqual(['sections','cards'])
 expect(frames[0]!.querySelectorAll('button.focus-context')).toHaveLength(1)
 expect([...frames[0]!.querySelectorAll<HTMLElement>('[data-focus-zone-section] [data-focus-zone-id]')].map(node=>node.dataset.focusZoneId)).toEqual(['first','second'])
 const current=frames[0]!.querySelector('[data-focus-zone-id="second"] button')!
 expect(current.getAttribute('aria-current')).toBe('location'); expect(current.hasAttribute('data-focus-project-scope-control')).toBe(true)
 expect(current.getAttribute('title')).toContain('/second')
 const rootOnly={...lane('single'),labels:['Original project'],summary:'Original retained root explanation'}
 await dom.render(<FocusProjectLanes resourceMenus lanes={[rootOnly]} selectedProjectKey={projectKey} onSelect={()=>{}}
   origins={new Map([['single',{kind:'mixed',label:'Project · Survey',locations:['Original survey'],addresses:['amux://space/original-source']}]])}
   renderLane={(_scan,heading)=>heading}/> )
 const originalTitle=dom.container.querySelector('.focus-project-frame__heading button[data-focus-project-scope-control]')!.getAttribute('title')!
 expect(originalTitle).toContain('Original retained root explanation'); expect(originalTitle).toContain('Original survey'); expect(originalTitle).toContain('amux://space/original-source')
})
