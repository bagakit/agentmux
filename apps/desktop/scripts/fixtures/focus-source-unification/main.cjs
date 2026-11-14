const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot,evidence,mode]=process.argv.slice(2)
const primaryOnly=mode==='--primary-only',memberState=mode==='--member-state',unconfirmed=mode==='--unconfirmed'
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const result={schema:'agentmux.focus-source-unification-actual.v1',passed:false,pid:process.pid,frames:[],scenes:[],rendererConsole:[],boundary:'Actual App/GlobalFocusSurface/unified source adapter/normal lane/card/Reader/filter/menu. Original source and Native IO are controlled typed preview leaves. No user Run, Runtime, restart or installation claim.'}
let win
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)result.rendererConsole.push(String(message).slice(0,2000))})
 const read=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(done=>setTimeout(done,ms))
 const until=async(label,predicate)=>{const end=Date.now()+15000;do{if(await predicate())return;await pause(40)}while(Date.now()<end);throw Error('Unified Focus did not settle: '+label)}
 await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 const settle=()=>read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
 const click=async selector=>{const r=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert.equal(r.hit,true,'Actual center hit '+selector);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button:'left',clickCount:1})}
 const captureMember=async(file,label)=>{await settle();await pause(160);await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.frames.push({file,label,viewport:await read('innerWidth')})}
 if(unconfirmed){
  await until('unconfirmed original member is visible',()=>read('window.unifiedFocusProof?.ready&&[...document.querySelectorAll(".focus-context")].some(e=>e.textContent.includes("Agent · 4iSNA9U2sBCU"))'))
  result.before=await read('window.unifiedFocusProof.facts()')
  for(const[width,height,theme]of[[1440,900,'dark'],[420,800,'dark'],[1440,900,'light'],[420,800,'light']]){
   win.setContentSize(width,height);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle()
   assert.equal(await read('document.documentElement.scrollWidth>innerWidth+1'),false)
   assert.equal(await read('[...document.querySelectorAll(".focus-context")].filter(e=>e.textContent.includes("Agent · 4iSNA9U2sBCU")).length'),2)
   assert.equal(await read('[...document.querySelectorAll(".focus-context")].filter(e=>e.textContent.includes("Position R6A39kP2s4Bd")||e.textContent.includes("Position B7C48mQ3t5Ce")).length'),2)
   await captureMember('unconfirmed-'+width+'-'+theme+'.png','original unconfirmed identity in the ordinary Focus list')
  }
  result.after=await read('window.unifiedFocusProof.facts()');assert.deepEqual(result.after.runs,result.before.runs);assert.deepEqual(result.after.drafts,result.before.drafts);result.passed=true;return
 }
 if(memberState){
  await until('real Global original missing source card',()=>read('window.unifiedFocusProof?.ready&&document.querySelectorAll(".global-focus-main .focus-context[data-session-id]").length===5'))
  result.before=await read('window.unifiedFocusProof.facts()')
  const selector=await read(`(()=>{const id=JSON.stringify(['source-agent',window.unifiedFocusProof.foreignRuntime,'working']);const cards=[...document.querySelectorAll('.focus-context[data-session-id]')];const e=cards.find(e=>e.dataset.sessionId===id);if(!e)throw Error('Missing original source card: '+cards.map(e=>e.dataset.sessionId).join(','));e.dataset.memberStateCard='true';return '[data-member-state-card="true"]'})()`)
  await click(selector)
  const stage=()=>read(`(()=>{const e=document.querySelector('.global-session-workspace .full-page-loading');return e&&{phase:e.dataset.loadingPhase,busy:e.getAttribute('aria-busy'),text:e.textContent,draft:e.querySelector('textarea')?.value,open:e.querySelector('.mounted-space-session-draft')?.open}})()`)
  await until('original missing shared parked page',async()=>{const s=await stage();return s?.phase==='parked'&&s.text.includes('Original session unavailable')})
  assert.equal((await stage()).busy,'false');assert.equal((await stage()).open,false)
  await captureMember('source-member-missing-1440-dark.png','actual missing original Session with an empty draft secondary')
  await click('.global-session-workspace .mounted-space-session-draft summary')
  const draft='原会话尚未确认时保留的未发送草稿。\n核对连接后再由我明确发送，不能自动补发。'
  await read(`(()=>{const e=document.querySelector('.global-session-workspace textarea[aria-label="Mounted Space task draft"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(draft)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  for(const[width,height,theme]of[[1440,900,'dark'],[420,800,'dark'],[1440,900,'light'],[420,800,'light']]){
   win.setContentSize(width,height);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle();assert.equal((await stage()).draft,draft);assert.equal((await stage()).open,true);assert.equal(await read('document.documentElement.scrollWidth>innerWidth+1'),false);await captureMember('source-member-draft-'+width+'-'+theme+'.png','original missing Session and preserved nonempty private draft')
   if(width===420){
    const point=await read(`(()=>{const r=document.querySelector('.global-session-workspace .surface-state').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:600})
    await until('narrow original draft and details scroll into view',()=>read(`(()=>{const s=document.querySelector('.global-session-workspace .surface-state'),d=s.querySelector('textarea'),details=s.querySelector('.surface-state__details');const r=s.getBoundingClientRect();return s.scrollTop>0&&d.getBoundingClientRect().top>=r.top&&d.getBoundingClientRect().bottom<=r.bottom+1&&details.getBoundingClientRect().bottom<=r.bottom+1})()`))
    result.narrowScroll??=[];result.narrowScroll.push(await read(`(()=>{const s=document.querySelector('.global-session-workspace .surface-state');return{width:innerWidth,scrollTop:s.scrollTop,clientHeight:s.clientHeight,scrollHeight:s.scrollHeight,draft:s.querySelector('textarea').value}})()`))
    await captureMember('source-member-draft-420-'+theme+'-scrolled.png','actual wheel makes original draft and connection details reachable in a narrow Region')
    await read(`document.querySelector('.global-session-workspace .surface-state').scrollTop=0`)
   }

  }
  win.setContentSize(900,800);await read('window.unifiedFocusProof.theme("dark");window.unifiedFocusProof.holdNextCheck()');const checks=await read('window.unifiedFocusProof.sourceChecks()')
  await click('.global-session-workspace .full-page-loading .primary-button')
  await until('actual source check reaches typed pending',async()=>{const s=await stage();return s?.phase==='loading'&&await read('window.unifiedFocusProof.sourceChecks()')>checks})
  assert.equal((await stage()).busy,'true');assert.equal((await stage()).draft,draft);await captureMember('source-member-pending-900-dark.png','Check again reads the original source with true typed pending')
  await read('window.unifiedFocusProof.failCheck()')
  await until('pending read failure becomes stationary unconfirmed',async()=>{const s=await stage();return s?.phase==='parked'&&s.text.includes('Session connection unconfirmed')})
  assert.equal((await stage()).busy,'false');assert.equal((await stage()).draft,draft);await captureMember('source-member-check-failed-900-dark.png','pending source failure is stationary with the original draft and recheck action')
  await click('.global-session-workspace .full-page-loading .primary-button')
  await until('same source rechecks after failure',async()=>{const s=await stage();return s?.phase==='loading'})
  await read('window.unifiedFocusProof.finishCheck()')
  await until('same original target terminal after observed',()=>read('!!document.querySelector(".global-session-workspace [data-fixture-source-terminal]")'))
  result.after=await read('window.unifiedFocusProof.facts()');assert.deepEqual(result.after.runs,result.before.runs);assert.deepEqual(result.after.drafts,result.before.drafts);assert.equal(result.after.sourceRegions,result.before.sourceRegions);assert.ok(JSON.stringify(result.after.source.drafts).includes(draft.split('\n')[0]))
  const calls=await read('window.unifiedFocusProof.memberCalls');assert.ok(calls.length>0);assert.ok(calls.every(call=>['read','conversationRead','conversationWatch','conversationUnwatch','conversationRelease'].includes(call.method)));result.memberState={checks:await read('window.unifiedFocusProof.sourceChecks()'),calls,originalDraftKept:true,observedOriginalTarget:true}
  await captureMember('source-member-observed-900-dark.png','original target returns without starting or sending');result.passed=true;return
 }
 await until('five ordinary task cards',()=>read('window.unifiedFocusProof?.ready&&document.querySelectorAll(".global-focus-main .focus-context[data-session-id]").length===5&&[...document.querySelectorAll(".focus-context")].some(e=>e.textContent.includes(window.unifiedFocusProof.foreignName))'))
 result.before=await read('window.unifiedFocusProof.facts()');const localReply=await read('window.unifiedFocusProof.localReply'),foreignName=await read('window.unifiedFocusProof.foreignName'),foreignReply=await read('window.unifiedFocusProof.foreignReply')
 await until('original bounded foreign recap',()=>read('[...document.querySelectorAll(".focus-context")].some(e=>e.textContent.includes(window.unifiedFocusProof.foreignReply))'))
 const capture=async(file,label)=>{if(primaryOnly&&file!=='unified-focus-source-primary.png')return;await settle();await pause(150);await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.frames.push({file,label,viewport:await read('innerWidth')})}
 const facts=()=>read(`(()=>{const cards=[...document.querySelectorAll('.global-focus-main .focus-context[data-session-id]')];return{cards:cards.map(e=>({id:e.dataset.sessionId,name:e.querySelector('strong')?.textContent,text:e.textContent,bucket:e.dataset.bucket,inLane:!!e.closest('.focus-project-lanes')})),overflow:document.documentElement.scrollWidth>innerWidth+1,special:document.querySelectorAll('[data-mounted-focus-source], [aria-label="Original project Agents"]').length}})()`)
 for(const[width,height,theme]of[[1440,900,'dark'],[900,800,'dark'],[420,800,'dark'],[1440,900,'light'],[420,800,'light']]){
  win.setContentSize(width,height);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle();const f=await facts();assert.equal(f.cards.length,5);assert.equal(f.special,0,'All tasks use the one ordinary product chain');assert.equal(f.overflow,false);assert.ok(f.cards.every(c=>c.inLane),'Every task is in an ordinary project lane');assert.equal(f.cards.filter(c=>c.name==='核对发布版本与业务数据').length,1,'The local task has one card across both paths');assert.ok(f.cards.find(c=>c.name==='核对发布版本与业务数据').text.includes(localReply),'Original canonical task recap stays readable');assert.ok(f.cards.find(c=>c.name===foreignName)?.text.includes(foreignReply),'Foreign task consumes its original bounded reading');assert.ok(!f.cards.find(c=>c.name===foreignName)?.text.includes(localReply),'Foreign same SID never borrows local recap');result.scenes.push({width,height,theme,...f});await capture('unified-focus-'+width+'-'+theme+'.png','one ordinary Focus with all original sources')
 }
 win.setContentSize(900,800);await read('window.unifiedFocusProof.theme("dark")');await settle();await click('[aria-label="Focus filters"]');await until('actual shared filter menu',()=>read('!!document.querySelector(".focus-filter-menu")'));await capture('unified-focus-shared-filters.png','common project/type/state facets over all sources')
 await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'})
 const selector=await read(`(()=>{const e=[...document.querySelectorAll('.focus-context[data-session-id]')].find(e=>e.textContent.includes(window.unifiedFocusProof.foreignName));e.dataset.fixtureForeignCard='true';return '[data-fixture-foreign-card="true"]'})()`)
 const point=await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await until('ordinary foreign Reader',()=>read('document.querySelector(".agent-information-reader")?.textContent.includes(window.unifiedFocusProof.foreignName)'));await until('original foreign body in shared Reader',()=>read('document.querySelector(".agent-information-reader")?.textContent.includes(window.unifiedFocusProof.foreignReply)'));await until('original input in common Recent inputs',()=>read('document.querySelector(".agent-information-reader")?.textContent.includes(window.unifiedFocusProof.foreignInput)'));await capture('unified-focus-original-reader.png','shared Reader using exact foreign source access')

 await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'})
 await click(selector)
 await until('ordinary Source primary workface',()=>read('document.querySelector(".global-session-workspace [data-focus-tab-id]")?.dataset.focusTabId==="source-tab-3"&&document.querySelectorAll(".global-session-workspace [data-source-region]").length===2'))
 result.primary=await read('({surface:document.querySelector(".global-focus-surface")?.hidden,tab:document.querySelector(".global-session-workspace [data-focus-tab-id]")?.dataset.focusTabId,regions:document.querySelectorAll(".global-session-workspace [data-source-region]").length,state:window.unifiedFocusProof.facts()})')
 assert.equal(result.primary.surface,false);assert.equal(result.primary.tab,'source-tab-3');assert.equal(result.primary.regions,2)
 await capture('unified-focus-source-primary.png','normal Focus primary keeps the complete original mixed Tab in its right workface')
 result.after=await read('window.unifiedFocusProof.facts()');assert.deepEqual(result.after.runs,result.before.runs);assert.deepEqual(result.after.drafts,result.before.drafts);assert.equal(result.after.sourceRegions,result.before.sourceRegions);result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
