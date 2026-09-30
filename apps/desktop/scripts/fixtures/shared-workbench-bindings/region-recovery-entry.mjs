import {createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {createWorkspaceLayout, splitWorkbenchRegion} from '@agentmux/layout'
import {App} from '../../../src/renderer/src/App'
import {api} from '../../../src/renderer/src/lib/api'
import {useAppStore,prepareRendererUpdate} from '../../../src/renderer/src/store'
import {projectPersistedWorkbench} from '../../../src/renderer/src/lib/workbench-persistence'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import {workbenchProjectionSlotId,workbenchRegionProjectionSlotId} from '../../../src/renderer/src/lib/workbench-projection'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const resource = {...config.workspaces.find(item => item.id === 'workspace-demo'), path:'/private/resource-a', name:'Resource A'}
const display = {...resource, id:'display-b', path:'/private/display-b', name:'Display B'}
const session = {...snapshot.sessions.find(item => item.id === 'session-codex'), workspacePath:resource.path}
if (!session.control?.run?.runId || !resource.id) throw new Error('Existing typed preview facts must be nonempty')
const decoy = createWorkbenchTab('decoy-first-tab', {regionId:'decoy-region', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}, 'Inserted first')
const exact = createWorkbenchTab('explicit-exact-tab', {regionId:'exact-r1', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}, 'Exact occurrence')
exact.regions['exact-r2'] = {regionId:'exact-r2', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}
exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
const first = createWorkspaceLayout('display-first-group', [exact.id])
const displayLayout = {...first, root:{type:'split', direction:'horizontal', ratio:.5, first:first.root, second:{type:'leaf', groupId:'display-exact-group'}},
  groups:[...first.groups, {...first.groups[0], id:'display-exact-group'}], activeGroupId:first.activeGroupId}
const mode=new URLSearchParams(location.search).get('mode')
if(!['first','second'].includes(mode))throw new Error('Two ordinary private GUI modes are explicit')
const initialFocus={execution:{sessionId:session.id,reference:{displayWorkspaceId:display.id,groupId:'display-exact-group',tabId:exact.id,regionId:'exact-r2'},history:[]},pmo:{sessionId:null}}
const seed={version:1,state:{activeWorkspaceId:resource.id,mainSurface:'workbench',toolsOpen:false,projectRailOpen:false,
  restoredWorkbench:projectPersistedWorkbench({tabs:{[decoy.id]:decoy,[exact.id]:exact},layouts:{[resource.id]:createWorkspaceLayout('resource-home-group',[decoy.id,exact.id]),[display.id]:displayLayout}}),
  agentFocus:initialFocus,agentComposerDrafts:{[session.id]:'Unsent original draft'}}}
const savedBefore=localStorage.getItem('agentmux-workbench-v1')
if(mode==='first') {if(savedBefore!==null)throw new Error('First private profile must be empty');localStorage.setItem('agentmux-workbench-v1',JSON.stringify(seed))}
else if(savedBefore===null)throw new Error('Second ordinary GUI receives no seed and must restore the original record')
api.config.get=async()=>({...config,workspaces:[resource,display]})
api.sessions.snapshot=async()=>({...snapshot,sessions:[session]})
window.regionRecoveryProof={mode,seedWrites:mode==='first'?1:0,recordAtBoot:savedBefore?JSON.parse(savedBefore):null,prepareQuit:()=>prepareRendererUpdate('quit')}

window.presentationLeaves = {mounts:[],unmounts:[]}
window.regionRestoreErrors=[];window.addEventListener('error',event=>{window.regionRestoreErrors.push({name:event.error?.name,message:event.message})})
const calls = {stop:0,resume:0,launchAgent:0,write:0,interrupt:0}
for (const key of Object.keys(calls)) {const original=api.sessions[key]; api.sessions[key]=(...args)=>{calls[key]++;return original(...args)}}
const reads = {historyPage:0,timeline:0,historySources:0}
for (const key of Object.keys(reads)) {const original=api.sessions[key];api.sessions[key]=(...args)=>{reads[key]++;return original(...args)}}
createRoot(document.getElementById('root')).render(createElement(App))
const reference = {displayWorkspaceId:display.id,groupId:'display-exact-group',tabId:exact.id,regionId:'exact-r2'}
let primary, originalDraft, originalHost, originalRegionHost, originalReading, originalText, originalSibling
window.focusPresentationProof = {
  ready:true, reference,bootFacts(){const s=useAppStore.getState();return {workbench:projectPersistedWorkbench(s),focus:s.agentFocus,draft:s.agentComposerDrafts[session.id],loading:s.loading}},
  existingExactEntry(){useAppStore.getState().focusRegion(display.id,exact.id,reference.regionId,'pointer',reference.groupId);primary=useAppStore.getState()
    originalDraft=document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')
    originalHost=originalDraft?.closest('.retained-workbench-view')
    if (!originalDraft || !originalHost) throw new Error('Original Tab leaf must exist before Focus')
    originalDraft.setSelectionRange(7,15)
    originalRegionHost=originalDraft.closest('.retained-workbench-region');originalReading=originalRegionHost.querySelector('[data-original-reading]');originalText=originalReading.firstChild;originalSibling=document.querySelector('[data-owner-region=exact-r1]');
    const range=document.createRange();range.setStart(originalText,3);range.setEnd(originalText,18);document.getSelection().removeAllRanges();document.getSelection().addRange(range)
  },
  laterSelection(){window.regionLateSelection=()=>{delete window.regionLateSelection;document.querySelector('input[aria-label="Search contexts"]').focus();const text=document.querySelector('.focus-toolbar__identity strong').firstChild;window.expectedLaterSelection=text.textContent.slice(0,5);const range=document.createRange();range.setStart(text,0);range.setEnd(text,5);document.getSelection().removeAllRanges();document.getSelection().addRange(range)};},
  shortenReading(){window.regionTrace=[];window.regionShrink=true},
  originalReading(){originalText.data='Original selected reading passage'},
  resetReading(){const range=document.createRange();range.setStart(originalText,3);range.setEnd(originalText,18);document.getSelection().removeAllRanges();document.getSelection().addRange(range)},
  identityOnly(){useAppStore.getState().focusExecutionSession(session.id)},
  facts(){const state=useAppStore.getState(),slot=document.querySelector('.focused-tab-workspace'),selection=document.getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;return {
    regionHost:originalRegionHost?.parentElement?.id??null, expectedRegionHost:workbenchRegionProjectionSlotId('focus-workbench-slot',reference), sameRegionHost:originalDraft?.closest('.retained-workbench-region')===originalRegionHost, sameReading:originalRegionHost?.querySelector('[data-original-reading]')===originalReading, textRange:{text:selection?.toString(),sameStart:range?.startContainer===originalText,sameEnd:range?.endContainer===originalText,start:range?.startOffset,end:range?.endOffset}, siblingConnected:originalSibling?.isConnected,siblingPresented:originalSibling?.dataset.presented, trace:window.regionTrace,readingText:originalText?.textContent,restoreErrors:[...window.regionRestoreErrors],laterExpected:window.expectedLaterSelection,laterActive:document.activeElement===document.querySelector('input[aria-label="Search contexts"]'),projectedLeaves:slot?.querySelectorAll('[data-fixture-session]').length??0,durable:JSON.parse(localStorage.getItem('agentmux-workbench-v1')), recovery:{mode:window.regionRecoveryProof.mode,seedWrites:window.regionRecoveryProof.seedWrites,recordAtBoot:window.regionRecoveryProof.recordAtBoot},
    selectedTab:slot?.dataset.focusTabId??null, reference:state.agentFocus.execution.reference??null,
    expectedHost:workbenchProjectionSlotId('focus-workbench-slot',reference), actualHost:originalHost?.parentElement?.id??null,
    sameHost:originalDraft?.closest('.retained-workbench-view')===originalHost,
    sameDraftElement:document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')===originalDraft,
    draft:originalDraft?.value, range:[originalDraft?.selectionStart,originalDraft?.selectionEnd], connected:originalDraft?.isConnected,
    sameTabs:state.tabs===primary?.tabs,sameLayouts:state.layouts===primary?.layouts,sameSessions:state.sessions===primary?.sessions,
    sameDrafts:state.agentComposerDrafts===primary?.agentComposerDrafts,primaryWorkspace:state.activeWorkspaceId,
    originalRun:state.sessions[0]?.control.run.runId, mounts:[...window.presentationLeaves.mounts],unmounts:[...window.presentationLeaves.unmounts],
    calls:{...calls},reads:{...reads},choices:document.querySelectorAll('[aria-label="Choose Focus location"] button').length,
    settings:!!document.querySelector('.settings-page'),workspaceInert:document.querySelector('.app-shell__workspace')?.inert??false,
    originalSourceRect:originalHost?{width:originalHost.getBoundingClientRect().width,height:originalHost.getBoundingClientRect().height}:null
  }}
}
