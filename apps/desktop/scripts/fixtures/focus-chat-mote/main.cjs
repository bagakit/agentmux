const assert=require('node:assert/strict')
const {readFile,writeFile}=require('node:fs/promises')
const {join}=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot,phase]=process.argv.slice(2)
assert.ok(['seed','restore'].includes(phase))
app.setPath('userData',join(privateRoot,'profile'));app.setPath('sessionData',join(privateRoot,'session'))
const result={passed:false,phase,pid:process.pid,scenes:[],images:[],operations:[],restartPreserved:false,preferenceRestored:false,selectionSideEffects:false,boundary:'Actual Global/Toolbar/floating/Store/menu/Workbench/CSS; two ordinary private GUI processes, same profile, no preference seed in either process. Typed Session/Run identities; no user App, real Run or shared Runtime controls.'}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const durable=facts=>Object.fromEntries(['tabs','layouts','drafts','focus','activeWorkspaceId','mainSurface','identities'].map(key=>[key,facts[key]]))
app.whenReady().then(async()=>{
 let win
 try{
  win=new BrowserWindow({width:1200,height:720,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}})
  result.consoleMessages=[];win.webContents.on('console-message',(_event,...details)=>result.consoleMessages.push(details))
  await win.loadFile(html,{query:{phase}});win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const evaluate=code=>win.webContents.executeJavaScript(code)
  const until=async code=>{for(let n=0;n<200;n++){if(await evaluate(code))return;await delay(25)}throw new Error('Actual Chat condition did not settle: '+code)}
  const paint=async()=>{await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await delay(150);await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')}
  const facts=()=>evaluate('chatMoteProbe.facts()'),geometry=()=>evaluate('chatMoteProbe.geometry()')
  const hit=async selector=>{
   const item=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Exact target unavailable');const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {selector:${JSON.stringify(selector)},rect:r.toJSON(),x,y,matched:n.contains(document.elementFromPoint(x,y)),disabled:n.disabled??false}})()`)
   assert.ok(item.rect.width>0&&item.rect.height>0,'Target is painted');assert.equal(item.matched,true,'Exact painted center hits target');assert.equal(item.disabled,false,'Exact target enabled');return item
  }
  const click=async selector=>{await paint();const item=await hit(selector);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:item.x,y:item.y,...(type==='mouseMoved'?{}:{button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})});await paint();return item}
  const key=async key=>{for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='Escape'?27:0});await paint()}
  const trigger='[aria-label="Choose Chat Mote"]', menu='.focus-chat-mote-menu', custom=await evaluate('chatMoteProbe.customMoteId')
  const openMenu=async()=>{await click(trigger);await until('!!document.querySelector(".focus-chat-mote-menu")')}
  const closeMenu=async()=>{await key('Escape');await until('!document.querySelector(".focus-chat-mote-menu")')}
  const assertControls=async()=>{
   const controls=[]
   for(const label of ['View in Space','Chat about this tab with Mote','Choose Chat Mote','Focus context actions','Close Focus workspace'])controls.push(await hit(`[aria-label="${label}"]`))
   const native=await evaluate('([...document.querySelectorAll(".focus-toolbar__region-slot button")]).map(node=>({label:node.getAttribute("aria-label"),rect:node.getBoundingClientRect().toJSON(),disabled:node.disabled}))')
   for(const item of native)if(!item.disabled&&item.label)await hit(`.focus-toolbar__region-slot [aria-label=${JSON.stringify(item.label)}]`)
   const g=await geometry();assert.equal(g.toolbar.height,36,'Original toolbar keeps 36px');assert.equal(g.horizontalOverflow,false,'Full toolbar/menu/document do not overflow horizontally');return{geometry:g,controls,native}
  }
  const shot=async(label)=>{await paint();const actual=await assertControls(),image=label+'.png';
   const menuColumns=await evaluate('([...document.querySelectorAll(".focus-chat-mote-menu__item")]).map(node=>({id:node.dataset.chatMoteId,check:node.querySelector(".focus-chat-mote-menu__check").getBoundingClientRect().toJSON(),avatar:node.querySelector(".focus-chat-mote-menu__icon").getBoundingClientRect().toJSON(),text:node.querySelector(".focus-chat-mote-menu__name").getBoundingClientRect().toJSON(),textAlign:getComputedStyle(node.querySelector(".focus-chat-mote-menu__name")).textAlign}))')
   for(const item of menuColumns){assert.equal(item.avatar.width,20,'Actual menu avatar slot stays 20px');assert.equal(item.avatar.height,20);assert.equal(item.check.width,12);assert.ok(item.check.x>=item.text.right,'Selection mark stays after the name');assert.equal(item.textAlign,'left','Actual recipient text aligns left');assert.ok(item.text.x-item.avatar.right>=0&&item.text.x-item.avatar.right<=10,'Actual avatar sits next to its readable name');assert.equal(item.avatar.x,menuColumns[0].avatar.x,'All avatars share one column');assert.equal(item.check.x,menuColumns[0].check.x,'Selection checks share one column');assert.equal(item.text.x,menuColumns[0].text.x,'Recipient names share one left column')}
   actual.menuColumns=menuColumns;await writeFile(join(privateRoot,image),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());result.images.push(image);result.scenes.push({label,width:await evaluate('innerWidth'),horizontalOverflow:actual.geometry.horizontalOverflow,...actual,image})}
  await until('window.chatMoteProbe?.ready&&document.querySelector(".focus-toolbar__identity strong")')
  result.seedCount=await evaluate('chatMoteProbe.seedCount');result.preferenceSeedCount=await evaluate('chatMoteProbe.preferenceSeedCount');assert.equal(result.preferenceSeedCount,0)
  result.start=await facts();assert.ok(result.start.tabs['chat-original-tab']);assert.equal(Object.keys(result.start.tabs['chat-original-tab'].regions).length,2)
  if(phase==='restore'){
   const expected=JSON.parse(await readFile(join(privateRoot,'expected.json'),'utf8'))
   assert.equal(result.seedCount,0,'Second ordinary process executes zero seed')
   assert.deepEqual(durable(result.start),expected.workface,'Original Store.initialize restores exact durable workface/drafts/Focus/typedRun identities')
   assert.equal(result.start.floating.focusChatTopicId,expected.choice,'Original floating owner rereads saved exact preference from same profile')
   assert.equal(result.start.persistedFloating.focusChatTopicId,expected.choice)
   assert.equal(await evaluate('document.querySelector("[aria-label=\\"Choose Chat Mote\\"]").dataset.focusChatTopic'),expected.choice)
   await until('(()=>{const r=document.querySelector(".focused-tab-workspace")?.getBoundingClientRect();return r&&r.width>0&&r.height>0})()')
   result.restartPreserved=true;result.preferenceRestored=true;result.restoreGeometry=await geometry()
  }else{
   assert.equal(result.seedCount,1);assert.equal(result.start.persistedFloating,null,'No seeded preference before real GUI choice')
   const before=durable(result.start)
   await openMenu();assert.equal(await evaluate('!!document.querySelector("[data-chat-mote-id=\\"launcher:ordinary\\"]")'),false)
   assert.equal(await evaluate('document.querySelector("[data-chat-mote-id=\\"launcher:quiet\\"]").textContent.includes("Archived")'),true)
   await click(`[data-chat-mote-id="${custom}"]`);await until('!document.querySelector(".focus-chat-mote-menu")')
   const selected=await facts();assert.deepEqual(durable(selected),before,'Actual menu selection changes no original workface or drafts');assert.deepEqual(selected.control,result.start.control,'Actual choice sends/launches/ensures nothing')
   assert.equal(selected.floating.focusChatTopicId,custom);assert.equal(selected.persistedFloating.focusChatTopicId,custom)
   assert.equal(selected.floating.open,false);assert.equal(selected.floating.preview,false)
   result.operations.push({label:'real-menu-selection-without-side-effects',selected:custom,passed:true})
   await openMenu();await shot('chat-mote-wide-long-name-archive')
   const preCost=await facts()
   await evaluate('window.originalChatItems=[...document.querySelectorAll("[data-chat-mote-id]")];chatMoteProbe.churn()');await paint()
   const afterCost=await facts();assert.deepEqual(afterCost.reads,preCost.reads,'200 unrelated outputs add no directory/history reads');assert.deepEqual(afterCost.identities,preCost.identities,'Typed Run controls remain exact')
   assert.equal(await evaluate('originalChatItems.length===document.querySelectorAll("[data-chat-mote-id]").length&&originalChatItems.every((node,i)=>node===document.querySelectorAll("[data-chat-mote-id]")[i])'),true,'Mounted menu identity nodes remain identical')
   result.operations.push({label:'200-unrelated-output-cost',before:preCost.reads,after:afterCost.reads,menuNodesRetained:true,passed:true})
   await closeMenu();assert.equal(await evaluate('document.activeElement===document.querySelector("[aria-label=\\"Choose Chat Mote\\"]")'),true,'Escape returns exact trigger')
   win.setContentSize(640,720);await until('innerWidth===640');await shot('chat-mote-narrow-split')
   await evaluate('chatMoteProbe.missingRecipient(true)');await until('document.querySelector(".focus-toolbar__mote-name").textContent==="Unconfirmed Mote"')
   await openMenu();await shot('chat-mote-640-unconfirmed')
   assert.equal(await evaluate('document.querySelector(".focus-chat-mote-menu [role=status]").textContent.includes("launcher:analyst")'),true,'Exact missing ID explained')
   await closeMenu();await evaluate('chatMoteProbe.missingRecipient(false)');await until('document.querySelector(".focus-toolbar__mote-name").textContent!=="Unconfirmed Mote"')
   result.final=await facts();assert.deepEqual(durable(result.final),before,'Choice/menu/directory observation/output preserve original workface');assert.deepEqual(result.final.control,result.start.control)
   await evaluate('chatMoteProbe.flush()');await delay(150);await win.webContents.session.flushStorageData()
   await writeFile(join(privateRoot,'expected.json'),JSON.stringify({workface:durable(result.final),choice:custom}))
  }
  result.end=await facts();assert.deepEqual(result.end.control,result.start.control,'Selection/menu/output do not add lifecycle/input/request controls after ordinary initialization')
  assert.deepEqual(Object.fromEntries(Object.entries(result.end.control).filter(([key])=>key!=='ensureMote')),{launchAgent:0,stop:0,resume:0,recover:0,write:0},'Ordinary private fixture invokes no Run lifecycle/input controls')
  result.initializationBaseline={ensureMote:result.start.control.ensureMote};result.selectionControlDelta=Object.fromEntries(Object.entries(result.end.control).map(([key,value])=>[key,value-result.start.control[key]]))
  assert.deepEqual(result.end.errors,[],'No hidden renderer failures');result.passed=true
 }catch(error){result.error={name:error.name,code:error.code,message:error.message,stack:error.stack};if(win)result.observationAtFailure=await win.webContents.executeJavaScript('({facts:window.chatMoteProbe?.facts(),geometry:window.chatMoteProbe?.geometry(),html:document.body.innerHTML.slice(0,14000)})').catch(()=>null)}
 finally{await writeFile(join(privateRoot,phase+'-result.json'),JSON.stringify(result,null,2)+'\n');win?.destroy();app.exit(result.passed?0:1)}
})
