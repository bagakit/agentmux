import React from 'react'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import { installUmd } from './xterm-instrumented'
import { createRoot } from 'react-dom/client'

const w = window as any
w.terminals=[]; w.writes=[]; w.wheels=[]; w.fixtureErrors=[]; w.observers=new Set()
document.addEventListener('wheel',e=>w.wheels.push({deltaY:e.deltaY,wheelDeltaY:(e as any).wheelDeltaY,deltaMode:e.deltaMode,isTrusted:e.isTrusted,shift:e.shiftKey,ctrl:e.ctrlKey,target:(e.target as HTMLElement).className}),true)
window.addEventListener('error',e=>w.fixtureErrors.push(e.message))
window.addEventListener('unhandledrejection',e=>w.fixtureErrors.push(String(e.reason)))
const session: Extract<SessionSnapshot, { kind: 'agent' }> ={id:'private-wheel-agent',hostId:'local',workspacePath:'/private-synthetic',label:'Private wheel',createdAt:1,updatedAt:1,processState:'running',status:{state:'working',source:'native-hook',observedAt:1},latestOutputBytes:0,kind:'agent',providerId:'codex',executorId:'codex',capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:'private-wheel-agent',run:{runId:'private-wheel-run'}}}
// This is a synthetic TUI program, not a terminal emulator, Runtime, Codex Agent or archive.
// Its response to each scroll report is three rows, matching the inspected native TUI class.
// The real xterm owns all mode parsing, pixel normalization and input protocol encoding.
const paint=()=> '\x1b[H'+Array.from({length:12},(_,i)=>`\x1b[${i+1};1Hprivate-TUI-row-${w.program.top+i}\x1b[K`).join('')
const output=(data:string)=>{
  const dataBytes=new TextEncoder().encode(data),startByte=w.outputByte;w.outputByte+=dataBytes.length
  const event={hostId:session.hostId,event:{type:'terminal-output',run:session.control.run,data,dataBytes,evidence:{outputByteRange:{startByte,endByte:w.outputByte}}}}
  for(const observer of w.observers)observer(event)
}
w.agentmux={control:{},ui:{requestStorageFlush:async()=>{},setAgentAttentionCount:async()=>false},system:{platform:'darwin'},sessions:{
  attach:async()=>{
    let data=Array.from({length:600},(_,i)=>'private-line-'+i+'\r\n').join('')
    if(w.fixture.mode==='alternate-mouse'||w.fixture.mode==='alternate-binary')data+='\x1b[?1049h\x1b[?1007l\x1b[?1000h\x1b[?1002h\x1b[?1003h'+(w.fixture.mode==='alternate-binary'?'\x1b[?1006l':'\x1b[?1006h')+paint()
    if(w.fixture.mode==='alternate-keys')data+='\x1b[?1049h\x1b[?1007h'+(w.fixture.applicationCursor?'\x1b[?1h':'\x1b[?1l')+paint()
    const bytes=new TextEncoder().encode(data);w.outputByte=bytes.length
    return {attachmentId:'private-attachment',currentSize:{cols:80,rows:24},gap:null,replay:[{startByte:0,endByte:bytes.length,dataBytes:bytes,data}]}
  },
  resize:async(_id:any,cols:number,rows:number)=>({cols,rows}),acknowledge:async()=>{},detach:async()=>{},redraw:async()=>true,replay:async()=>({replay:[],gap:null}),
  write:async(control:any,data:any)=>{
    const bytes=typeof data==='string'?new TextEncoder().encode(data):data
    const text=typeof data==='string'?data:''
    w.writes.push({control,bytes:Array.from(bytes),length:bytes.length,binary:typeof data!=='string',text})
    const reports=[...text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)]
    const keys=[...text.matchAll(/\x1b(?:\[|O)(A|B)/g)]
    let nativeReports=0
    for(const match of reports){const button=Number(match[1])&~28;if(button===64||button===65){w.program.reports++;w.program.top+=button===64?-3:3;nativeReports++}}
    for(const match of keys){w.program.reports++;w.program.top+=match[1]==='A'?-3:3;nativeReports++}
    if(typeof data!=='string')for(let i=0;i+5<bytes.length;i+=6){
      if(bytes[i]!==27||bytes[i+1]!==91||bytes[i+2]!==77)throw new Error('Unexpected synthetic native binary encoding')
      const button=bytes[i+3]-32
      if(button===64||button===65){w.program.reports++;w.program.top+=button===64?-3:3;nativeReports++}
    }
    if(nativeReports){w.program.paints++;output(paint())}
  },
  onEvent:(observer:any)=>{w.observers.add(observer);return()=>w.observers.delete(observer)},
  historyPage:async()=>({agentSessionId:session.id,source:{providerId:'codex',nativeSessionId:'synthetic'},items:[],nextCursor:null})
}}
const {useAppStore}=await import('../../../src/renderer/src/store')
const {SessionPane}=await import('../../../src/renderer/src/components/SessionPane')
const root=createRoot(document.getElementById('container')!);let generation=0
w.mount=async(mode:string,readOnly=false,pending=false,applicationCursor=false)=>{
  w.fixture={mode,applicationCursor};w.program={top:500,reports:0,paints:0};w.writes=[];w.wheels=[];w.terminals=[];w.outputByte=0
  useAppStore.setState({sessions:[{...session,...(pending?{pendingInteraction:{id:'private',kind:'permission' as const,agentSessionId:session.id,title:'Private synthetic permission',options:[],evidence:{source:'native-hook' as const,observedAt:1,run:session.control.run}}}:{})}],config:{version:9,appearance:{terminalTheme:'graphite'},executors:{},workspaces:[],hosts:[],browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null})
  root.render(<SessionPane key={++generation} sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible readOnly={readOnly} linkOrigin={{workspaceId:'private',tabGroupId:'private',tabId:'private',regionId:'private'}} />)
  for(let i=0;i<150;i++){
    const t=w.terminals.at(-1)
    if(t&&((mode==='normal'&&t.buffer.active.length>500)||(mode!=='normal'&&t.buffer.active.type==='alternate'&&t.buffer.active.getLine(0)?.translateToString(true).includes('private-TUI-row-500'))))return w.info()
    await new Promise(r=>setTimeout(r,20))
  }
  throw new Error('Actual TerminalView replay failed: '+JSON.stringify(w.info()))
}
w.info=()=>{
  const t=w.terminals.at(-1),r=document.querySelector('.xterm-screen')?.getBoundingClientRect()
  return {terminalCount:w.terminals.length,type:t?.buffer.active.type,baseY:t?.buffer.active.baseY,viewportY:t?.buffer.active.viewportY,length:t?.buffer.active.length,cols:t?.cols,rows:t?.rows,cellHeight:r&&t?.rows?r.height/t.rows:null,firstLine:t?.buffer.active.getLine(0)?.translateToString(true),wheels:w.wheels.slice(),mouse:t?.modes.mouseTrackingMode,writes:w.writes.slice(),program:{...w.program},errors:w.fixtureErrors.slice(),point:r?{x:r.left+(w.fixture.mode==='alternate-binary'?Math.min(120,t.cols-2)+0.5:t.cols/2)*r.width/t.cols,y:r.top+r.height/2}:null,screen:r?{left:r.left,top:r.top,width:r.width,height:r.height}:null,scrollSensitivity:t?.options.scrollSensitivity,fastScrollSensitivity:t?.options.fastScrollSensitivity,hit:r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.className:null}
}
w.setDistribution=async(distribution:string)=>{await installUmd(distribution)}
w.ready=true
