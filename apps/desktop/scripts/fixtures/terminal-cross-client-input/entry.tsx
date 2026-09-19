import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/renderer/src/styles/index.css'
const w=window as any;w.terminals=[];w.wheels=[];w.errors=[]
document.addEventListener('wheel', e=>w.wheels.push({deltaY:e.deltaY,deltaMode:e.deltaMode,isTrusted:e.isTrusted,clientX:e.clientX,clientY:e.clientY,target:(e.target as HTMLElement).className}),true)
window.addEventListener('error',e=>w.errors.push(e.message));window.addEventListener('unhandledrejection',e=>w.errors.push(String(e.reason)))
const {useAppStore}=await import('../../../src/renderer/src/store')
const {SessionPane}=await import('../../../src/renderer/src/components/SessionPane')
const {readTerminalViewObservation}=await import('../../../src/renderer/src/lib/terminal-view-observation')
const session=await w.agentmux.sessions.refresh({kind:'agent',hostId:'local',agentSessionId:'private-wheel-agent',run:{runId:'private-placeholder'}})
useAppStore.setState({sessions:[session],config:{version:9,workspaces:[],hosts:[],executors:{},appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null})
createRoot(document.getElementById('container')!).render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'private',tabGroupId:'private',tabId:'private',regionId:'private'}} />)
w.info=()=>{const t=w.terminals.at(-1),r=t?.element?.querySelector('.xterm-screen')?.getBoundingClientRect(),point=r?{x:r.left+r.width/4,y:r.top+r.height/3}:null;return {terminalCount:w.terminals.length,observation:readTerminalViewObservation({regionId:'private',sessionId:session.id,runId:session.control.run.runId})??null,cols:t?.cols,rows:t?.rows,buffer:t?{type:t.buffer.active.type,baseY:t.buffer.active.baseY,viewportY:t.buffer.active.viewportY,length:t.buffer.active.length}:null,firstLines:t?Array.from({length:4},(_,i)=>t.buffer.active.getLine(i)?.translateToString(true)):[],point,hit:point?document.elementFromPoint(point.x,point.y)?.className:null,wheels:w.wheels.slice(),errors:w.errors.slice()}}
w.ready=true
