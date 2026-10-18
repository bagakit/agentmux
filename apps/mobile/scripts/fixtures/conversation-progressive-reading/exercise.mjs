import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const draft='保留这份移动端尚未发送的阅读反馈。'
export async function runMobile({BrowserWindow,setup,evidence,phase,scene,preload,appendDuringSelection}) {
  const mobile=setup.mobile??setup
  const result={passed:false,scene,phase,images:[],samples:[],operations:[],errors:[],boundary:'Actual MobileConversationSurface → original Hosted SDK → private IPC transport bridge → original authenticated HTTP RPC → shared Core and Run in private Chromium. No physical phone or Relay claim.'}
  const win=new BrowserWindow({width:390,height:844,show:false,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,partition:'persist:conversation-progressive-mobile'}})
  const channel='reading-mobile:rpc', controllers=new Map(), readers=new Map()
  let rpc
  const dispose=async()=>{for(const controller of controllers.values())controller.abort();controllers.clear();readers.clear();await rpc?.dispose();rpc=undefined}
  const failure=error=>({agentMux:error instanceof AgentMuxError,fields:{...error,name:error.name,message:error.message,stack:error.stack}})
  const dispatch=async(event,operation,...args)=>{
    assert.equal(event.sender.id,win.webContents.id,'Only the exact private Mobile renderer owns this transport')
    if(operation==='connect'){
      const [url,token]=args;assert.equal(url,mobile.url);assert.equal(token,mobile.token)
      await dispose();rpc=await connectAgentMuxRpc({endpoint:{transport:'http',url,token}});return
    }
    if(operation==='dispose')return dispose()
    if(operation==='cancel'){
      const [id]=args;controllers.get(id)?.abort();controllers.delete(id)
      const reader=readers.get(id);readers.delete(id);await reader?.dispose();return
    }
    assert.ok(rpc,'The original authenticated HTTP transport is connected')
    assert.ok(operation==='call'||operation==='subscribe','Known private transport operation')
    const [method,params,id,options]=args,controller=new AbortController();controllers.set(id,controller)
    if(operation==='call'){
      try{return await rpc.call(method,params,{...options,signal:controller.signal})}finally{controllers.delete(id)}
    }
    const send=(kind,value)=>{if(!win.isDestroyed())win.webContents.send('reading-mobile:rpc-event',id,kind,value)}
    try{const reader=await rpc.subscribe(method,params,{...options,signal:controller.signal,
      onInitial:value=>send('initial',value),onEvent:value=>send('event',value),onEnd:error=>send('end',error?failure(error):undefined)})
      readers.set(id,reader)
    }catch(error){controllers.delete(id);throw error}
  }
  ipcMain.handle(channel,async(...args)=>{
    try{return {ok:true,value:await dispatch(...args)}}catch(error){return {ok:false,error:failure(error)}}
  })
  const read=code=>win.webContents.executeJavaScript(code)
  const until=async(code,label=code)=>{for(let i=0;i<240;i++){if(await read(code))return;await pause(35)}throw Error('Original Mobile condition absent: '+label)}
  const sample=async name=>{await pause(80);const state=await read(`(()=>{const feed=document.querySelector('.mobile-conversation__reading'),bounds=feed.getBoundingClientRect();return {facts:mobileReading.facts(),nodes:feed.querySelectorAll('*').length,bodies:feed.querySelectorAll('.log-turn__body:not(.conversation-progressive-body__placeholder)').length,markdown:feed.querySelectorAll('[data-markdown-root],.md-paragraph').length,scroll:{top:feed.scrollTop,height:feed.scrollHeight,client:feed.clientHeight},visible:[...feed.querySelectorAll('[data-native-record-id]')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>bounds.top&&r.top<bounds.bottom}).map(n=>n.getAttribute('data-native-record-id')),editor:document.querySelector('[contenteditable=true]')?.textContent,overflow:document.querySelector('.mobile-app').scrollWidth>document.querySelector('.mobile-app').clientWidth}})()`);result.samples.push({name,...state});return state}
  const capture=async name=>{const file=`${scene}-${phase}-mobile-${name}.png`;await writeFile(join(evidence,file),(await win.webContents.capturePage()).toPNG());result.images.push(file)}
  const tap=async (selector,{skipDisabled=false}={})=>{
    await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`)
    const point=await read(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Original control missing');const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(hit!==node&&!node.contains(hit))throw Error('Original control covered');return{x,y,disabled:!!node.disabled}})()`)
    if(skipDisabled&&point.disabled)return false
    assert.equal(point.disabled,false)
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,radiusX:1,radiusY:1,force:1,id:1}]})
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(90)
    result.operations.push({type:'tap',selector});return true
  }
  const button=async (label,options)=>{const id=await read(`(()=>{const n=[...document.querySelectorAll('.mobile-conversation button')].find(n=>n.getClientRects().length&&(n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}));if(!n)throw Error('Original named button absent: '+${JSON.stringify(label)});n.dataset.mobileProofControl='active';return '[data-mobile-proof-control=active]'})()`);try{return await tap(id,options)}finally{await read(`document.querySelector('[data-mobile-proof-control=active]')?.removeAttribute('data-mobile-proof-control')`)}}
  const wheel=async dy=>{const p=await read(`(()=>{const r=document.querySelector('.mobile-conversation__reading').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaY:dy,deltaX:0});await pause(100)}
  try {
    win.webContents.on('console-message',event=>{if(event.level==='error')result.errors.push({kind:'console',message:event.message})})
    win.webContents.on('preload-error',(_event,_path,error)=>result.errors.push({kind:'preload',message:error.message,stack:error.stack}))
    await win.loadURL(new URL('mobile/index.html',mobile.url).href)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await until('typeof mountOriginalMobile==="function"')
    await read(`mountOriginalMobile(${JSON.stringify(mobile)})`)
    await until('!!document.querySelector(".mobile-conversation [contenteditable=true]")&&!!document.querySelector("[data-native-record-id]")','original Surface records and Composer')
    await until('mobileReading.facts().session?.agentSessionId==='+JSON.stringify(mobile.agentSessionId),'original SID')
    const initial=await sample('initial')
    const latestNativeId=await read(`[...document.querySelectorAll('.mobile-conversation__reading [data-native-record-id]')].at(-1)?.dataset.nativeRecordId`)
    assert.equal(typeof latestNativeId,'string','The original current window exposes its latest native record')
    assert.equal(initial.facts.owner.runtimeId,mobile.runtimeId)
    if(phase==='restore')assert.equal(initial.editor,draft,'The second real process restores the original device draft without refilling')
    else {
      await tap('.mobile-conversation [contenteditable=true]');win.webContents.insertText(draft)
      await until('document.querySelector("[contenteditable=true]").textContent==='+JSON.stringify(draft))
      await until('JSON.stringify(mobileReading.facts().device).includes('+JSON.stringify(draft)+')','durable device draft')
    }
    await capture('current')
    for(let demand=0;demand<3;demand++){
      const before=await read(`(()=>{const receipts=mobileReading.facts().conversationReads;return {ids:[...document.querySelectorAll('[data-native-record-id]')].map(n=>n.dataset.nativeRecordId),started:performance.now(),olderCursor:receipts.findLast(r=>r.complete)?.olderCursor,receiptCount:receipts.length}})()`)
      assert.equal(typeof before.olderCursor,'string','The original accepted source supplies the next older cursor')
      await wheel(-900);await wheel(-900)
      let clicked=false,progress=null
      for(let attempt=0;attempt<240;attempt++){
        const state=await read(`(()=>{
          const before=${JSON.stringify(before)},facts=mobileReading.facts(),ids=[...document.querySelectorAll('[data-native-record-id]')].map(n=>n.dataset.nativeRecordId);
          const own=r=>r.hostId==='local'&&r.agentSessionId===${JSON.stringify(mobile.agentSessionId)};
          const receipts=facts.conversationReads.slice(before.receiptCount);
          const receipt=receipts.find(r=>own(r)&&r.method==='readAgentConversation'&&r.requestCursor===before.olderCursor&&r.finished>before.started);
          const complete=receipt&&receipts.find(r=>own(r)&&r.windowId===receipt.windowId&&r.revision===receipt.revision&&r.complete);
          const originalId=receipt&&receipts.filter(r=>own(r)&&r.windowId===receipt.windowId&&r.revision===receipt.revision).flatMap(r=>r.nativeIds).find(id=>!before.ids.includes(id)&&ids.includes(id));
          const pending=facts.reads.filter(r=>!r.finished&&r.method==='runtime.invoke'&&['readAgentConversation','readConversationChanges'].includes(r.params?.invocation?.method)&&r.params.invocation.args[0].hostId==='local'&&r.params.invocation.args[0].agentSessionId===${JSON.stringify(mobile.agentSessionId)}).map(r=>({method:r.params.invocation.method,started:r.started}));
          const button=[...document.querySelectorAll('.mobile-reading-action')].find(n=>n.textContent==='更早消息');
          return {readable:!!complete&&!!originalId,receipt:complete&&originalId?{windowId:receipt.windowId,revision:receipt.revision,requestCursor:receipt.requestCursor,originalId}:null,pending,exists:!!button,disabled:button?button.disabled:null};
        })()`)
        result.earlierDemand={demand,before,clicked,state}
        if(state.readable){progress=state.receipt;break}
        assert.equal(state.exists,true,'The controlled original source provides three earlier pages')
        if(!clicked&&!state.pending.length&&!state.disabled)clicked=await button('更早消息',{skipDisabled:true})
        await pause(35)
      }
      assert.ok(progress,'This earlier demand must finish its original source read and present a new original native record')
      result.operations.push({type:'earlier-readable',demand,mode:clicked?'manual':'already-reading',receipt:progress,latency:await read('performance.now()')-before.started})
      await sample('earlier-'+demand)
    }
    await capture('earlier')
    const beforeCurrent=await read('({started:performance.now(),receiptCount:mobileReading.facts().conversationReads.length})')
    await tap('.mobile-reading-latest')
    const currentProgress=`(()=>{
      const before=${JSON.stringify(beforeCurrent)},receipts=mobileReading.facts().conversationReads.slice(before.receiptCount);
      const own=r=>r.hostId==='local'&&r.agentSessionId===${JSON.stringify(mobile.agentSessionId)};
      const request=receipts.find(r=>own(r)&&r.method==='readAgentConversation'&&r.requestCursor===null&&r.started>=before.started);
      if(!request)return null;
      const frame=receipts.filter(r=>own(r)&&r.windowId===request.windowId&&r.revision===request.revision),complete=frame.find(r=>r.complete);
      const presented=[...document.querySelectorAll('.mobile-conversation__reading [data-native-record-id]')].some(n=>n.dataset.nativeRecordId===${JSON.stringify(latestNativeId)});
      return complete&&presented&&frame.some(r=>r.nativeIds.includes(${JSON.stringify(latestNativeId)}))?{windowId:request.windowId,revision:request.revision,requestCursor:request.requestCursor,complete:complete.complete,nativeCut:complete.nativeCut,originalId:${JSON.stringify(latestNativeId)}}:null;
    })()`
    await until(`!!${currentProgress}`,'the actual Current action completes its original latest read and presents the original current native record')
    const current=await read(currentProgress)
    result.operations.push({type:'current-readable',receipt:current})
    await sample('current-before-selection')
    await read(`(()=>{const f=document.querySelector('.mobile-conversation__reading');const b=[...f.querySelectorAll('.log-turn__body:not(.conversation-progressive-body__placeholder)')].find(n=>n.closest('[data-native-record-id]')&&n.textContent.trim().length>14);if(!b)throw Error('No original readable body');b.scrollIntoView({block:'center'});const walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let t;while(t=walker.nextNode())if(t.textContent.trim().length>14)break;if(!t)throw Error('No original text');const range=document.createRange();range.setStart(t,0);range.setEnd(t,12);getSelection().removeAllRanges();getSelection().addRange(range);window.originalMobileSelection={node:t,body:b,text:getSelection().toString()}})()`)
    await pause(100)
    const selected=await read(`(()=>{const b=originalMobileSelection.body.getBoundingClientRect(),f=document.querySelector('.mobile-conversation__reading').getBoundingClientRect();return {text:originalMobileSelection.text,top:b.top,visible:b.bottom>f.top&&b.top<f.bottom}})()`)
    assert.equal(selected.visible,true,'The live selection belongs to a visible original body')
    assert.equal(typeof appendDuringSelection,'function','The original source append is required')
    const before=await read('({started:performance.now(),nativeCut:mobileReading.facts().conversationReads.at(-1)?.nativeCut})')
    const {recordId}=await appendDuringSelection()
    assert.equal(typeof recordId,'string','The append returns its original source record identity')
    const appendProgress=`(()=>{
      const receipts=mobileReading.facts().conversationReads,own=r=>r.hostId==='local'&&r.agentSessionId===${JSON.stringify(mobile.agentSessionId)};
      const receipt=receipts.findLast(r=>own(r)&&r.finished>${before.started}&&r.windowId===${JSON.stringify(current.windowId)}&&r.nativeCut!==${JSON.stringify(before.nativeCut)}&&r.nativeIds.includes(${JSON.stringify(recordId)}));
      const complete=receipt&&receipts.find(r=>own(r)&&r.windowId===receipt.windowId&&r.revision===receipt.revision&&r.complete);
      return complete?{receipt,complete}:null;
    })()`
    await until(`!!${appendProgress}`,'the live original Surface reader completes the appended source frame with its exact record identity and changed native cut')
    const {receipt:appendReceipt,complete:appendComplete}=await read(appendProgress)
    await sample('selection');await capture('selection')
    assert.equal(await read('getSelection().toString()'),selected.text)
    assert.equal(await read('originalMobileSelection.node.isConnected'),true)
    assert.equal(await read('originalMobileSelection.body.isConnected'),true)
    assert.ok(Math.abs(await read('originalMobileSelection.body.getBoundingClientRect().top')-selected.top)<=2,'The original selected Mobile anchor remains in place')
    result.operations.push({type:'selection-retained',appendReceipt,appendComplete,appendedRecordId:recordId,priorNativeCut:before.nativeCut,originalNode:true,originalText:true,originalAnchor:true})
    await read('getSelection().removeAllRanges()')
    await until(`[...document.querySelectorAll('.mobile-conversation__reading [data-native-record-id]')].some(n=>n.dataset.nativeRecordId===${JSON.stringify(recordId)})`,'the original appended native record is presented after the selection releases')
    result.operations.push({type:'append-presented',recordId,windowId:appendReceipt.windowId,revision:appendReceipt.revision})
    const copy=await read(`(()=>{const b=originalMobileSelection.body.closest('[data-message-id]')?.querySelector('[aria-label="Copy message"]');if(!b)return false;b.dataset.mobileProofCopy='true';return true})()`)
    assert.equal(copy,true,'An actual original message exposes whole-body Copy')
    await tap('[data-mobile-proof-copy=true]')
    await until(`document.querySelector('[data-mobile-proof-copy=true]')?.getAttribute('aria-label') === 'Message copied'`,'actual copy confirmation')
    const copied=await read('mobileReading.facts().copies.at(-1)');assert.ok(copied.includes(selected.text));result.operations.push({type:'copy',characters:copied.length,selectedOriginalIncluded:true,privateClipboardSink:true})
    const group=await read(`(()=>{const n=document.querySelector('.conversation-record-process .wf-head');if(!n)return false;n.dataset.mobileProofProcess='true';return true})()`)
    if(group){await tap('[data-mobile-proof-process=true]');await sample('expanded-process');await capture('expanded-process')}
    await tap('.mobile-reading-latest')
    await until(`(()=>{const feed=document.querySelector('.mobile-conversation__reading');return feed.scrollHeight-feed.clientHeight-feed.scrollTop<=2})()`,'the actual Current action returns the accepted live window to its tail')
    await sample('returned-current');await capture('returned-current')
    await read('mobileReading.disconnect()')
    await until('mobileReading.facts().connection.state==="disconnected"')
    const disconnected=await sample('disconnected')
    assert.equal(disconnected.facts.session,null,'Disconnected ownership is unknown, not a replacement Session')
    assert.equal(disconnected.facts.sessionError?.code,'RUNTIME_UNAVAILABLE')
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'),draft)
    await capture('disconnected')
    await read('mobileReading.reconnect()')
    await until('mobileReading.facts().connection.state==="connected"&&mobileReading.facts().session?.agentSessionId==='+JSON.stringify(mobile.agentSessionId))
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'),draft)
    const final=await sample('reconnected');await capture('reconnected')
    assert.equal(final.overflow,false,'The actual Mobile Surface remains inside its viewport')
    assert.equal(final.facts.session.run.runId,initial.facts.session.run.runId,'Reconnection preserves the original Run')
    assert.equal(final.facts.reads.filter(e=>e.method==='runtime.invoke'&&['submitAgentPrompt','submitAgentInput','respondAgentInteraction','replySessionQuestion'].includes(e.params.invocation?.method)).length,0,'Reading and reconnecting never invent an input')
    result.passed=true
  } catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};result.failureFacts=await read('mobileReading.facts()').catch(()=>null);result.failureText=await read('document.body.innerText').catch(()=>null);await capture('failure').catch(()=>{})}
  finally{await read('mobileReading.disconnect()').catch(()=>{});await dispose();ipcMain.removeHandler(channel);await win.webContents.session.flushStorageData();await writeFile(join(evidence,`${scene}-${phase}-mobile.json`),JSON.stringify(result,null,2));win.destroy()}
  assert.equal(result.passed,true,result.failure?.message)
  return result
}
