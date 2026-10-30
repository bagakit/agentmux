const assert=require('node:assert/strict')
module.exports=async({win,read,until,click,press,settle,capture,details,dismiss,result})=>{
 const unknownOnly=process.argv.includes('--delivery-source-retry-unknown-only')
 const set=values=>read('(()=>{Object.assign(window.channelEntryProof.deliveryRetry,'+JSON.stringify(values)+');return true})()')
 const action=name=>'[data-delivery-action="'+name+'"]'
 const editor='[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
 await until('document.querySelector('+JSON.stringify(editor)+')');await click(editor);win.webContents.selectAll();await until('getSelection().toString()==="Keep this original research draft."')
 await win.webContents.insertText('Keep this original research draft.');await settle()
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'});await settle()
 const before=await read('(()=>{const e=document.querySelector('+JSON.stringify(editor)+');window.__retryEditor=e;return {selection:e.editor.state.selection.toJSON(),text:e.textContent}})()')
 async function select(operationId='preview-original-delivery'){
  await click('js:[...document.querySelectorAll(".agent-connector-receipt")].find(n=>n.querySelector("code")?.textContent==='+JSON.stringify(operationId)+')?.querySelector("button")')
  await until('document.querySelector("[data-selected-delivery]")?.dataset.selectedDelivery==='+JSON.stringify(operationId))
 }
 async function open(mode,theme,width,loseReply=false){
  await set({active:false,mode,state:mode==='unknown'?'unknown':'not-applied',loseReply,extraUnknown:false,continuation:null,sourceOverride:null})
  await details('healthy',theme,width);await set({active:true});await click('.connector-delivery-details > .agent-connector-section-title button')
  await until('document.querySelector(".connector-traffic-summary").textContent.includes('+JSON.stringify(mode==='unknown'?'Recent send results not confirmed':'No recent requests')+')||document.querySelector(".connector-traffic-summary").textContent.includes("not delivered")')
  await click('.connector-delivery-details__originals > summary');await select()
 }
 if(!unknownOnly){
 await open('message','dark',1380);await until('document.querySelector("[data-delivery-action=retry]")');await capture('delivery-source-message-wide-dark');await dismiss()
 const after=await read('(()=>{const e=document.querySelector('+JSON.stringify(editor)+');return {selection:e.editor.state.selection.toJSON(),text:e.textContent,sameNode:e===window.__retryEditor}})()')
 assert.equal(after.sameNode,true);assert.deepEqual(after.selection,before.selection);assert.equal(after.text,before.text);result.composerPreservation={before,after}
 await open('upload','light',520);await until('document.querySelector("[data-delivery-action=retry]")?.textContent==="Retry upload"');await capture('delivery-source-upload-narrow-light');await dismiss()
 }
 await open('message','dark',520,true);await click(action('retry'));await until('document.querySelector("[data-delivery-retry]").textContent.includes("Retry reply unconfirmed")')
 await read('window.channelEntryProof.deliveryRetry.submit({kind:"message",attempt:2})')
 await set({state:'not-applied',sourceOverride:{kind:'message',attempt:3},continuation:{source:{kind:'message',attempt:2},acceptedAt:2}});await click(action('inspect'))
 await click('[data-delivery-retry] details > summary');await until('document.querySelector('+JSON.stringify('[aria-label="Submitted retry source"]')+')?.selectedOptions[0]?.textContent.includes("attempt 1")')
 await capture('delivery-source-unknown-reply-narrow-dark');await dismiss()
 if(!unknownOnly){
 await open('message','light',1380);await click(action('retry'));await until('document.querySelector("[data-delivery-retry]").textContent.includes("Retry accepted")');await set({state:'confirmed',extraUnknown:true});await click(action('inspect'))
 await click('js:[...document.querySelectorAll("[data-receipt-section=receipts] > button")].find(n=>n.textContent==="Latest receipts")');await until('document.querySelector("[data-receipt-section=receipts]").textContent.includes("preview-unknown-message")');await select('preview-unknown-message')
 assert.equal(await read('!!document.querySelector("[data-delivery-action=retry]")'),false);await capture('delivery-source-result-wide-light');await dismiss()
 }
 result.deliveryRetryScope='Four changed original-delivery detail states only. Typed visual leaves/native Renderer input; actual Host continuation and qualification are proved separately by the mounted consumers.'
}
