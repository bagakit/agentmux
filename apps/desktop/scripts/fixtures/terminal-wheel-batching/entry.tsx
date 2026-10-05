import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import React from 'react'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import { installUmd } from './xterm-instrumented'
import { createRoot } from 'react-dom/client'

const w = window as any
w.terminals=[]; w.writes=[]; w.wheels=[]; w.fixtureErrors=[]; w.observers=new Set()
document.addEventListener('wheel',e=>w.wheels.push({timeStamp:e.timeStamp,deltaY:e.deltaY,wheelDeltaY:(e as any).wheelDeltaY,deltaMode:e.deltaMode,isTrusted:e.isTrusted,shift:e.shiftKey,ctrl:e.ctrlKey,target:(e.target as HTMLElement).className}),true)
window.addEventListener('error',e=>w.fixtureErrors.push(e.message))
window.addEventListener('unhandledrejection',e=>w.fixtureErrors.push(String(e.reason)))
const session = await w.wheelNative.setup()
const {useAppStore}=await import('../../../src/renderer/src/store')
const {DesktopClientUiProvider}=await import('../../../src/renderer/src/components/DesktopClientUiProvider')
const {SessionPane}=await import('../../../src/renderer/src/components/SessionPane')
const root=createRoot(document.getElementById('container')!);let generation=0;w.remountNeeded=true
w.mount=async(mode:string,readOnly=false,pending=false,applicationCursor=false)=>{
  await w.wheelNative.configure({ mode, applicationCursor }); w.fixture={mode,applicationCursor};w.writes=[];w.wheels=[];w.inputEvents=[];if(w.remountNeeded){w.terminals=[];generation++;w.remountNeeded=false}
  useAppStore.setState({sessions:[{...session,...(pending?{pendingInteraction:{id:'private',kind:'permission' as const,agentSessionId:session.id,title:'Private synthetic permission',options:[],evidence:{source:'native-hook' as const,observedAt:_reshape_fixtureEpoch(0, 0, 1),run:session.control.run}}}:{})}],config:{version:9,appearance:{terminalTheme:'graphite'},executors:{},workspaces:[],hosts:[],browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null})
  root.render(<DesktopClientUiProvider><SessionPane key={generation} sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible readOnly={readOnly} linkOrigin={{workspaceId:'private',tabGroupId:'private',tabId:'private',regionId:'private'}} /></DesktopClientUiProvider>)
  for(let i=0;i<150;i++){
    const t=w.terminals.at(-1)
    if(t)t.options.cursorBlink=false;
    if(t&&((mode==='normal'&&t.buffer.active.length>500)||(mode!=='normal'&&t.buffer.active.type==='alternate'&&t.buffer.active.getLine(0)?.translateToString(true).includes('private-TUI-row-500'))))return w.info()
    await new Promise(r=>setTimeout(r,20))
  }
  throw new Error('Actual TerminalView replay failed: '+JSON.stringify(w.info()))
}
w.info=()=>{
  const t=w.terminals.at(-1),r=document.querySelector('.xterm-screen')?.getBoundingClientRect()
  return {dpr:devicePixelRatio,deviceCell:t?._core?._renderService?.dimensions?.device?.cell,partial:t?._core?._mouseService?._wheelPartialScroll,inputEvents:w.inputEvents?.slice()??[],terminalCount:w.terminals.length,type:t?.buffer.active.type,baseY:t?.buffer.active.baseY,viewportY:t?.buffer.active.viewportY,length:t?.buffer.active.length,cols:t?.cols,rows:t?.rows,cellHeight:r&&t?.rows?r.height/t.rows:null,firstLine:t?.buffer.active.getLine(0)?.translateToString(true),wheels:w.wheels.slice(),mouse:t?.modes.mouseTrackingMode,writes:w.writes.slice(),errors:w.fixtureErrors.slice(),point:r?{x:r.left+(w.fixture.mode==='alternate-binary'?Math.min(120,t.cols-2)+0.5:t.cols/2)*r.width/t.cols,y:r.top+r.height/2}:null,screen:r?{left:r.left,top:r.top,width:r.width,height:r.height}:null,scrollSensitivity:t?.options.scrollSensitivity,fastScrollSensitivity:t?.options.fastScrollSensitivity,hit:r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.className:null}
}
w.setDistribution=async(distribution:string)=>{await installUmd(distribution);w.remountNeeded=true}
w.nativeDrain=()=>w.wheelNative.drain()
w.ready=true
