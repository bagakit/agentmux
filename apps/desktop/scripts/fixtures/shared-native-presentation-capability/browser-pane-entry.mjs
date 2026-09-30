import { createElement as h, useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'
import './browser-pane.css'
Object.assign(api.browser, window.moteNative.browser)
Object.assign(api.ui, window.moteNative.ui)
const config = await api.config.get()
useAppStore.setState({ config, loading: false, toolsOpen: false })
const browserId='one-original-page'
const browser = await api.browser.create(browserId, window.moteNative.fixturePageUrl+'?owner='+browserId, null)
const surfaces = Object.fromEntries(['a','b'].map(id=>[id,{...browser,kind:'browser',regionId:'presentation-'+id,workspaceId:'private',browserId}]))
const state={captureAttempts:0,captureCount:0,buttonEvents:[],frames:{a:0,b:0},moves:[],hidden:[],native:'a'}
let stream,originalStream,viewport,setNative,setHidden,originalStages
const videos=()=>['a','b'].map(id=>document.getElementById('video-'+id))
async function start(event){
 state.buttonEvents.push({type:event.type,trusted:event.isTrusted,active:navigator.userActivation.isActive})
 state.captureAttempts++; state.failure=undefined
 try{
  stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:viewport.width,max:viewport.width},height:{ideal:viewport.height,max:viewport.height},frameRate:{max:30}},audio:false})
  originalStream ??= stream
  state.captureCount++;state.settings=stream.getVideoTracks()[0].getSettings()
  for(const v of videos())v.srcObject=stream
  await Promise.all(videos().map(v=>v.play()));state.ready=true
 }catch(e){state.failure={name:e.name,message:e.message}}
}
function Probe(){
 const [native,updateNative]=useState('a'),[hidden,updateHidden]=useState([])
 setNative=updateNative;setHidden=updateHidden
 return h('main',{className:'probe'},h('header',null,h('h1',null,'One original page · two BrowserPane stages'),
  h('button',{id:'start',onClick:start},'Start same-page capture'),
  ...['a','b'].map(id=>h('button',{id:'activate-'+id,onClick:e=>{state.moves.push({id,trusted:e.isTrusted});state.native=id;updateNative(id)}},'Native input '+id.toUpperCase())),
  h('button',{id:'passive',onClick:e=>{state.moves.push({id:null,trusted:e.isTrusted});state.native=null;updateNative(null)}},'Both stream only'),
  h('button',{id:'hide-a',onClick:e=>{state.hidden=['a'];updateHidden(['a'])}},'Hide only A')),
  h('div',{className:'probe-positions'},...['a','b'].map(id=>h('section',{key:id,className:'probe-host','data-binding':id,hidden:hidden.includes(id)},
   h('h2',null,'Presentation '+id.toUpperCase()+' · '+(native===id?'original Native input':'live stream')),
   h(BrowserPane,{tab:surfaces[id],visible:!hidden.includes(id),released:false,presentationTargetId:'private-presentation-'+id,
    researchPresentation:{native:native===id,body:h('video',{id:'video-'+id,autoPlay:true,muted:true,playsInline:true})}})))),
  h('p',{className:'probe-boundary'},'Private research seam; stream presentation is not registered product IPC. CDP input is not physical OS/IME/clipboard qualification.'))
}
createRoot(document.getElementById('root')).render(h(Probe))
window.paneProbe={browserId,browser,surfaces,ready:true,
 configure(v){viewport=v;originalStages=[...document.querySelectorAll('.browser-stage')]},
 facts(){return {...state,stages:[...document.querySelectorAll('.browser-stage')].map((e,i)=>({binding:['a','b'][i],same:originalStages?.[i]===e,bounds:e.getBoundingClientRect().toJSON()})),
  videos:videos().map(v=>({id:v.id,readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,hidden:v.closest('section').hidden,sameStream:!!stream&&v.srcObject===stream,trackIds:v.srcObject?.getTracks().map(t=>t.id)})),
  trackStates:stream?.getTracks().map(t=>({id:t.id,readyState:t.readyState,muted:t.muted}))}},
 color(label,expected,ids=['a','b']){
  const phase={label,expected,samples:{},matches:{},started:performance.now()}
  return new Promise((resolve,reject)=>{let done=false;const handles={},timer=setTimeout(()=>finish(new Error('No new pixel: '+label)),8000)
   function finish(error){if(done)return;done=true;clearTimeout(timer);for(const id of ids){if(handles[id]!==undefined)document.getElementById('video-'+id).cancelVideoFrameCallback(handles[id])}phase.elapsed=performance.now()-phase.started;error?reject(Object.assign(error,{phase})):resolve(phase)}
   for(const id of ids){const v=document.getElementById('video-'+id),c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d',{willReadFrequently:true});phase.samples[id]=[]
    const inspect=(_,m)=>{if(done)return;state.frames[id]++;ctx.drawImage(v,v.videoWidth*40/viewport.width,v.videoHeight*40/viewport.height,1,1,0,0,1,1);const pixel=Array.from(ctx.getImageData(0,0,1,1).data);phase.samples[id].push({pixel,presentedFrames:m.presentedFrames,mediaTime:m.mediaTime,width:m.width,height:m.height});if(expected.every((x,i)=>Math.abs(x-pixel[i])<=12))phase.matches[id]=true;if(ids.every(k=>phase.matches[k]))return finish();if(phase.samples[id].length>=90)return finish(new Error('90 frames exhausted: '+label));handles[id]=v.requestVideoFrameCallback(inspect)}
    handles[id]=v.requestVideoFrameCallback(inspect)
   }
  })
 },stop(){const handles=[...new Set([originalStream,stream].filter(Boolean))];for(const s of handles)for(const t of s.getTracks())t.stop();for(const v of videos()){v.pause();v.srcObject=null}return handles.flatMap(s=>s.getTracks().map(t=>({id:t.id,readyState:t.readyState})))}}
