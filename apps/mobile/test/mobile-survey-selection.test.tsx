// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import type {AgentMuxSpaceCatalog} from '@agentmux/core/control'
import {parseSpaceControlSuccessReceipt} from '../../../packages/core/src/space-control-parser'
import {readSurveyPresentation} from '../../desktop/src/renderer/src/lib/mobile-presentation'
import {MobileSurveyCatalog} from '../src/survey/MobileSurveySurface'

function originalCatalog(shape:'zone'|'page'|'none') {
 const reference={tabId:'tab-original',regionId:'agent-region-original'},page={regionId:'browser-region-original',browserId:'browser-original'}
 const catalog:AgentMuxSpaceCatalog={spaces:[],zones:[{zoneId:'zone-original',workspaceId:'resource-original',kind:'directory',hostId:'local',directoryPath:'/original',branch:null}],
  tabs:[{tabId:reference.tabId,zoneId:'zone-original',workspaceId:'resource-original',name:'Original Tab',regionIds:[reference.regionId,page.regionId]}],
  regions:[{regionId:reference.regionId,tabId:reference.tabId,kind:'agent',agentSessionId:'agent-original',runId:'run-original',execution:{hostId:'local',cwd:'/original'}},
   {regionId:page.regionId,tabId:reference.tabId,kind:'browser',browserId:page.browserId,agentSessionId:null,runId:null,execution:null}],bindings:[],
  locations:[{spaceId:null,zoneId:'zone-original',workspaceId:'resource-original',displayWorkspaceId:'display-original',groupId:'group-original',tabId:reference.tabId,regionId:reference.regionId}]}
 const selection:Parameters<typeof readSurveyPresentation>[0]['surveyZoneSelection']=shape==='zone'?{zoneId:'zone-original',selection:[reference],active:reference}:shape==='page'?{kind:'page',...page}:null
 const survey=readSurveyPresentation({surveyCollectedZones:{'zone-original':true},surveyPageReferences:[page],surveyExplorationNames:{'zone-original':'Original Zone'},surveyZoneSelection:selection,tabs:{}},catalog)
 const receipt=parseSpaceControlSuccessReceipt({schemaVersion:5,requestId:'mobile-original-survey-selection',ok:true,operation:'space.ls',result:{catalog:{...catalog,survey}}})
 if(!receipt.ok||receipt.operation!=='space.ls')throw Error('The original public parser must return the exact space.ls operation')
 return receipt.result.catalog
}
it.each(['zone','page','none'] as const)('the actual Mobile Catalog keeps original Zone navigation and data for %s selection',async shape=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const catalog=originalCatalog(shape),before=structuredClone(catalog),openSession=vi.fn(),element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 try{
  await act(async()=>root.render(<MobileSurveyCatalog catalog={catalog} openSession={openSession} refresh={()=>{}}/>))
  const list=element.querySelector('nav[aria-label="研究列表"]')!,labels=[...list.querySelectorAll('button strong')].map(node=>node.textContent),badges=[...list.querySelectorAll('small')].map(node=>node.textContent)
  expect(labels).toEqual(['Original Zone']);expect(badges).toEqual(shape==='zone'?['当前选择']:[])
  await act(async()=>list.querySelector<HTMLButtonElement>('button')!.click())
  const provenance=element.querySelector('.mobile-survey-provenance')!.textContent
  expect(provenance).toContain('zone-original')
  if(shape==='zone')expect(provenance).toContain('tab-original / agent-region-original · 当前选择')
  else expect(provenance).not.toContain('tab-original / agent-region-original')
  expect(element.querySelector('[aria-label="Tab 与 Region"]')?.textContent).toContain('Original Tab')
  const agent=element.querySelector<HTMLButtonElement>('.mobile-agent-row__open')!
  expect(agent.disabled).toBe(false);await act(async()=>agent.click())
  expect(openSession).toHaveBeenCalledExactlyOnceWith('agent-original',expect.objectContaining({context:catalog.locations[0]}))
  expect(catalog).toEqual(before)
  expect(catalog.regions[0]).toMatchObject({agentSessionId:'agent-original',runId:'run-original'})
 }finally{await act(async()=>root.unmount());element.remove();vi.unstubAllGlobals()}
})
