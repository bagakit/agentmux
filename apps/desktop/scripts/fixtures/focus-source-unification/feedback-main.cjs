const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path')
module.exports=async({win,read,until,pause,settle,click,capture,captureIntermediate,result,privateRoot,restoreOnly})=>{
 await until('actual takeover card',()=>read('window.takeoverFeedbackProof?.ready&&!!document.querySelector(".focus-context-card:has(.focus-context[data-session-id=working]) > .agent-operation-feedback")'))
 const facts=()=>read('window.takeoverFeedbackProof.facts()')
 const card='.focus-context[data-session-id="working"]'
 const area='.focus-context-card:has('+card+') > .agent-operation-feedback:not(.agent-operation-feedback--compact)'
 const press=async(text,scope=area)=>{
  await read(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing actual button '+${JSON.stringify(text)});document.querySelector('[data-feedback-click]')?.removeAttribute('data-feedback-click');e.dataset.feedbackClick='true'})()`)
  await click('[data-feedback-click]')
 }
 const frame=async(name,label)=>capture('feedback-'+name+'.png',label)
 const sizes=[[1440,900,'dark'],[420,800,'dark'],[1440,900,'light'],[420,800,'light']]
 if(restoreOnly){
  const current=await facts(),saved=JSON.parse(await fs.readFile(path.join(privateRoot,'original-consumer-state.json'),'utf8'))
  assert.deepEqual(current.operation.cancellation,saved.facts.operation.cancellation)
  assert.equal(current.operation.message,saved.facts.operation.message)
  assert.deepEqual(current.drafts,saved.facts.drafts)
  assert.deepEqual(current.tabs,saved.facts.tabs);assert.deepEqual(current.layouts,saved.facts.layouts)
  assert.equal(current.calls.length,0)
  await frame('restored-consumer','A second real Electron process restores the original workface, draft and exact cancellation from the original saved user document')
  await click(card);await until('restored original draft workface',()=>read('!!document.querySelector(".global-session-workspace textarea")'))
  assert.equal(await read('document.querySelector(".global-session-workspace textarea").value'),saved.facts.drafts.working)
  await frame('restored-original-draft','Restored actual ordinary Focus workface retains the original draft without opening or sending an Agent')
  result.restoration={passed:true,firstProcessPid:saved.pid,secondProcessPid:process.pid,sameOriginalSerializedState:true,savedUserStateSHA256:createHash('sha256').update(saved.serialized).digest('hex'),originalDiagnosticKept:true,originalRequestAndCancelResultKept:true,workfaceAndDraftKept:true,noCancelOpenSendOrStop:true}
  assert.notEqual(saved.pid,process.pid);result.passed=true;return
 }
 result.before=await facts()
 for(const[w,h,theme]of sizes){
  win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle()
  assert.equal(await read(`document.querySelector(${JSON.stringify(area+' .agent-operation-feedback__technical')}).open`),false)
  await frame('unconfirmed-'+w+'-'+theme,'Original unconfirmed takeover: first-level check and cancellation; technical references folded')
 }
 win.setContentSize(1440,900);await read('window.unifiedFocusProof.theme("dark")');await settle()
 await press('取消接手')
 await until('exact pending cancellation reaches original owner leaf',()=>read('window.takeoverFeedbackProof.calls.some(c=>c.method==="cancel")'))
 await frame('pending-normal','Pending original cancellation preserves original Agent and draft')
 const pending=await facts();assert.notEqual(pending.operation.cancellation.input.operationId,pending.operation.operationId)
 assert.deepEqual(pending.operation.cancellation.input.request,pending.operation.takeoverSource.coreRequest)
 await read('window.takeoverFeedbackProof.complete()')
 await until('cancel outcome unconfirmed',()=>read('window.takeoverFeedbackProof.facts().operation.cancellation?.pending===false'))
 await press('检查取消结果')
 await until('read-only exact cancellation inspection',()=>read('window.takeoverFeedbackProof.checks()===1'))
 for(const[w,h,theme]of sizes){
  win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle()
  await frame('unknown-'+w+'-'+theme,'Unconfirmed original cancellation with explicit check and continue action')
 }
 await click(area+' .agent-operation-feedback__technical > summary')
 for(const[w,h,theme]of sizes){
  win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle()
  const text=await read(`document.querySelector(${JSON.stringify(area+' .agent-operation-feedback__technical')}).textContent`)
  assert.ok(text.includes('原接手反馈：'+result.before.operation.message))
  assert.ok(text.includes('取消检查：'))
  assert.equal((await facts()).operation.message,result.before.operation.message)
  await frame('technical-'+w+'-'+theme,'Original takeover feedback and cancellation inspection are separately labelled; opaque IDs remain complete')
 }
 await click(area+' [aria-label="复制原操作编号"]')
 await click(area+' [aria-label="复制取消操作编号"]')
 const copied=await facts();assert.deepEqual(copied.copied,[copied.operation.operationId,copied.operation.cancellation.input.operationId])
 await click(area+' .agent-operation-feedback__technical > summary')
 // The real card activates its original ordinary workface. Its actual Region
 // header independently reads the same retained cancellation.
 win.setContentSize(1440,900);await read('window.unifiedFocusProof.theme("dark")');await click(card)
 await until('real ordinary Region header with compact feedback',()=>read('!!document.querySelector(".global-session-workspace .agent-operation-feedback--compact button.agent-operation-feedback__label")'))
 const compact='.global-session-workspace .agent-operation-feedback--compact button.agent-operation-feedback__label'
 await click(compact)
 await until('actual nonmodal compact feedback',()=>read('!!document.querySelector(".agent-operation-feedback__popover")'))
 await captureIntermediate('feedback-compact-opening.png','Actual compact Region-header popover immediately after the opening pointer event')
 await pause(200);await frame('compact-normal-dark','Original cancellation details from ordinary Region header')
 await click('.agent-operation-feedback__popover [aria-label="关闭操作详情"]')
 assert.equal(await read('!!document.querySelector(".agent-operation-feedback__popover")'),false)
 for(const[w,h,theme]of[[420,800,'dark'],[1440,900,'light'],[420,800,'light']]){
  win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle();await click(compact)
  await frame('compact-'+w+'-'+theme,'Compact original cancellation popover within narrow and normal workface bounds')
  const bounds=await read('(()=>{const e=document.querySelector(".agent-operation-feedback__popover"),r=e.getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:e.scrollWidth>e.clientWidth+1}})()');assert.ok(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1);assert.equal(bounds.overflow,false)
  await click('.agent-operation-feedback__popover [aria-label="关闭操作详情"]')
 }
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
 await click(compact);await frame('compact-reduced-motion','Actual reduced-motion compact popover remains clear and reachable')
 await click('.agent-operation-feedback__popover [aria-label="关闭操作详情"]')
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
 await click('[aria-label="Close Focus workspace"]')
 const unknownSerialized=await read('window.takeoverFeedbackProof.checkpoint()')
 // Successful cancellation with unknown save ACK remains on the original card.
 await read('window.takeoverFeedbackProof.observe("cancelled")')
 await press('检查取消结果')
 await until('cancelled with unknown save ACK',()=>read('window.takeoverFeedbackProof.facts().operation.cancellation?.result?.outcome==="cancelled"'))
 for(const[w,h,theme]of sizes){win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await frame('cancelled-'+w+'-'+theme,'Cancelled original takeover with distinct unconfirmed save receipt')}
 await click(area+' .agent-operation-feedback__label');await click(area+' .agent-operation-feedback__label');await captureIntermediate('feedback-card-reopening.png','Actual card detail reopening between pointer activation and its settled reading')
 const savedState=await read('window.takeoverFeedbackProof.checkpoint()'),savedFacts=await facts();result.consumerCheckpoint={savedUserStateSHA256:createHash('sha256').update(savedState).digest('hex'),operation:savedFacts.operation,tabs:savedFacts.tabs,layouts:savedFacts.layouts,drafts:savedFacts.drafts};await fs.writeFile(path.join(privateRoot,'original-consumer-state.json'),JSON.stringify({pid:process.pid,serialized:savedState,facts:savedFacts}))
 // A separate alternative of the same unknown source checkpoint reports a created
 // Agent. A confirmed cancellation is never treated as subsequently created.
 await read(`window.takeoverFeedbackProof.restore(${JSON.stringify(unknownSerialized)})`)
 // Later original-owner observation reports the created target. It offers
 // navigation and the existing explicit Stop confirmation, never implicit Stop.
 await read('window.takeoverFeedbackProof.observe("created","confirmed")')
 await press('检查取消结果')
 await until('created exact receipt',()=>read('window.takeoverFeedbackProof.facts().operation.cancellation?.result?.outcome==="created"'))
 for(const[w,h,theme]of sizes){win.setContentSize(w,h);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await frame('created-'+w+'-'+theme,'Created takeover Agent retains exact View and explicit Stop actions')}
 await press('停止接手 Agent…')
 await until('original explicit Stop confirmation',()=>read('[...document.querySelectorAll("[role=dialog]")].some(e=>e.textContent.includes("Stop Agent?"))'))
 await frame('created-stop-narrow-light','Explicit Stop confirmation is bound to the created Agent and requires a separate decision')
 await press('Cancel','[role=dialog]')
 await press('查看接手 Agent')
 await until('exact created workface is visible',()=>read('[...document.querySelectorAll("[data-fixture-session=created-takeover-agent]")].some(e=>e.getBoundingClientRect().height>0)'))
 await frame('created-original-target','View reaches the exact created Agent workface from its original receipt without opening a new Agent')
 result.after=await facts();assert.deepEqual(result.after.drafts,result.before.drafts);assert.deepEqual(result.after.runs,result.before.runs)
 assert.equal(result.after.calls.filter(c=>c.method==='cancel').length,1)
 assert.equal(result.after.calls.filter(c=>['open','send','stop'].includes(c.method)).length,0)
 result.feedback={originalRequestKept:true,independentCancelId:true,fullReferencesCopied:true,ordinaryHeaderConsumer:true,noOpenSendOrStop:true}
 result.passed=true
}
