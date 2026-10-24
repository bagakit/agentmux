import './entry.mjs'
import {createWorkspaceLayout} from '@agentmux/layout'
import {useAppStore} from '../../../src/renderer/src/store'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import {spatialCatalog} from '../../../src/renderer/src/lib/space-agent-control'
import {readSurveyPresentation} from '../../../src/renderer/src/lib/mobile-presentation'
import {fixturePath} from '../../lib/fixture-values.mjs'
import {updateThemeSelection} from '@agentmux/client-ui/theme'
import {moveSurveyListItem} from '../../../src/renderer/src/hooks/useSurveyListOrganization'
import {api} from '../../../src/renderer/src/lib/api'

// Only the exact preview Browser history read has an empty transport. No write or durability is invented.
api.browser.listInputHistory=async target=>{const state=useAppStore.getState(),workspaceId=target.kind==='workspace'?target.workspaceId:Object.values(state.tabs).flatMap(tab=>Object.values(tab.regions)).find(region=>region.kind==='browser'&&region.browserId===target.browserId)?.workspaceId;if(!workspaceId)throw new Error('Exact preview Browser history resource is unknown');return{scope:{workspaceId,profileId:target.kind==='browser'?target.profileId:null},entries:[]}}

const before=useAppStore.getState(),first=before.config.workspaces[0]
const third={...first,id:'survey-third-workspace',path:fixturePath('private/survey-reading-list'),name:'Reading list source'}
const thirdTab=createWorkbenchTab('survey-c-file',{regionId:'survey-c-file-region',workspaceId:third.id,kind:'file',path:'reading-list.md'},'Source review')
useAppStore.setState({config:{...before.config,workspaces:[...before.config.workspaces,third]},tabs:{...before.tabs,[thirdTab.id]:thirdTab},layouts:{...before.layouts,[third.id]:createWorkspaceLayout('survey-c-group',[thirdTab.id])}})
const {zoneA,zoneB}=window.surveyItemProof,zoneC=spatialCatalog(useAppStore.getState(),[]).tabs.find(tab=>tab.tabId===thirdTab.id)?.zoneId,missing='saved-survey-missing-zone'
if(!zoneC||zoneC===zoneA||zoneC===zoneB)throw new Error('Three exact original research Zones required')
const organization={ungrouped:[zoneC],groups:[{groupId:'survey-reading-group',name:'Reading',collapsed:false,zoneIds:[zoneA,zoneB,missing]},{groupId:'survey-compare-group',name:'Compare',collapsed:false,zoneIds:[]}]}
useAppStore.setState({surveyCollectedZones:{...before.surveyCollectedZones,[zoneC]:true,[missing]:true},surveyExplorationNames:{...before.surveyExplorationNames,[zoneC]:'Source review'},surveyOrganization:organization})
const original=useAppStore.getState(),writes=[],owner=original.setSurveyOrganization,copy=value=>JSON.parse(JSON.stringify(value))
useAppStore.setState({async setSurveyOrganization(next,expected){const record={next:copy(next),expected:copy(expected),receipt:null};writes.push(record);const result=await owner(next,expected);record.receipt=copy(result);return result}})
let address,workface,addressDraft,originalSelection,publicRead=0
window.surveyGroupingProof={ready:true,zoneA,zoneB,zoneC,missing,groupA:organization.groups[0].groupId,groupB:organization.groups[1].groupId,
 holdAddress(){address=document.querySelector('.global-survey-surface input[aria-label="Browser address"]');if(!address)throw new Error('Original Browser address input required');workface=address.closest('.retained-workbench-view');addressDraft=address.value;originalSelection=copy(useAppStore.getState().surveyZoneSelection)},
 theme(mode){return updateThemeSelection({...useAppStore.getState().config.appearance,appAppearance:mode})},
 async publicFacts(){const state=useAppStore.getState();const result=await state.executeControl({schemaVersion:5,requestId:'survey-grouping-presentation-'+(++publicRead),operation:'space.ls',target:{},presentation:true});if(result.operation!=='space.ls')throw new Error('Actual public Survey presentation required');return result.catalog.survey},
 async moveOriginalForNameDraft(groupId){const state=useAppStore.getState();return await state.executeControl({schemaVersion:5,requestId:'survey-grouping-name-draft-'+(++publicRead),operation:'space.survey-list',organization:moveSurveyListItem(state.surveyOrganization,zoneA,groupId),expected:state.surveyOrganization})},
 facts(){const state=useAppStore.getState(),catalog=spatialCatalog(state,[]),presentation=readSurveyPresentation(state,catalog),base=window.surveyItemProof.facts();return{...base,
  originalTabs:Object.values(original.tabs).map(tab=>({id:tab.id,preserved:state.tabs[tab.id]===tab})),created:Object.keys(state.tabs).filter(id=>!original.tabs[id]),sameLayouts:state.layouts===original.layouts,
  organization:copy(state.surveyOrganization),writes:copy(writes),publicPresentation:presentation,originalSelection,
  sameAddress:address?document.querySelector('.global-survey-surface input[aria-label="Browser address"]')===address:null,addressConnected:address?.isConnected??null,sameWorkface:address?address.closest('.retained-workbench-view')===workface:null,addressDraft,addressValue:address?.value,
  groupRows:[...document.querySelectorAll('[data-survey-list-group]')].map(group=>({groupId:group.dataset.surveyListGroup,zoneIds:[...group.querySelectorAll('[data-survey-zone-id]')].filter(row=>row.getClientRects().length&&!row.closest('[hidden]')).map(row=>row.dataset.surveyZoneId)})),
  appearance:document.documentElement.dataset.appearance}}
}
