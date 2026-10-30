const assert=require('node:assert/strict')
module.exports=async({win,read,until,click,press,settle,layout,open,close,capture,details,dismiss,result})=>{
 const set=values=>read('Object.assign(window.channelEntryProof.receiver,'+JSON.stringify(values)+')')
 const button=name=>'[data-receiver-action="'+name+'"]'
 if(process.argv.includes('--receiver-review-delta')){
  await set({state:'ended'});await details('healthy','light',1380);await click(button('recover'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Reconnect requested")')
  assert.equal(await read('!!document.querySelector("[data-receiver-action=continue]")'),false);await capture('receiver-scheduled-wide-light');await dismiss()
  await set({state:'ready'});await details('healthy','light',520);await until('document.querySelector(".connector-traffic-summary").textContent.includes("Last message: Accepted by Agent")');await capture('receiver-restored-narrow-light');await dismiss()
  result.receiverScope='Only the two Root-requested information hierarchy frames recaptured; four accepted complete frames remain in the prior receipt.'
  return
 }
 const editor='[data-workbench-region-id="channel-preview-region"] [data-agent-composer] [role="textbox"][aria-label="Message Agent"]'
 await until('document.querySelector('+JSON.stringify(editor)+')')
 await click(editor);win.webContents.selectAll();await until('getSelection().toString()==="Keep this original research draft."')
 await win.webContents.insertText('Keep this original research draft.');await settle()
 await until('document.querySelector('+JSON.stringify(editor)+').textContent==="Keep this original research draft."')
 const beforeKey=await read('window.__connectionsTrustedEvents.length')
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'});await settle()
 const events=await read('window.__connectionsTrustedEvents.slice('+beforeKey+')')
 assert.ok(events.some(e=>e.type==='keydown'&&e.key==='ArrowLeft'&&e.trusted))
 const before=await read('(()=>{const e=document.querySelector('+JSON.stringify(editor)+');window.__receiverEditor=e;return {selection:e.editor.state.selection.toJSON(),text:e.textContent}})()')
 assert.equal(before.selection.anchor,before.selection.head)
 await set({state:'ended'});await details('healthy','dark',1380);await until('document.querySelector("[data-receiver-action=recover]")');await capture('receiver-stopped-wide-dark');await dismiss()
 const after=await read('(()=>{const e=document.querySelector('+JSON.stringify(editor)+');return {selection:e.editor.state.selection.toJSON(),text:e.textContent,sameNode:e===window.__receiverEditor}})()')
 assert.equal(after.sameNode,true);assert.deepEqual(after.selection,before.selection);assert.equal(after.text,before.text)
 result.composerPreservation={before,after,events}
 await set({state:'ended',longName:true});await details('healthy','light',520);await capture('receiver-stopped-narrow-light');await dismiss()
 await set({state:'ended',longName:false});await details('healthy','light',1380);await click(button('recover'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Reconnect requested")');await capture('receiver-scheduled-wide-light');await dismiss()
 await set({state:'ended',loseReply:true});await details('healthy','dark',520);await click(button('recover'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Recovery reply unconfirmed")');await capture('receiver-unknown-narrow-dark');await click(button('inspect'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Reconnect requested")');await dismiss()
 await set({state:'ready',refusal:true});await details('healthy','dark',1380);await until('document.querySelector(".connector-traffic-summary").textContent.includes("Message type not supported")');await capture('receiver-healthy-refusal-wide-dark');await dismiss()
 win.setContentSize(1380,980);await until('innerWidth===1380');await layout(true);await set({state:'ended',refusal:false});await read('window.channelEntryProof.setScenario("healthy")')
 await open('feishu');await until('document.querySelector(".connector-header-menu [data-direction=incoming]")?.textContent.includes("Receiver stopped")')
 result.compactHeader=await read('(()=>{const region=document.querySelector("[data-workbench-region-id=channel-preview-region]"),menu=document.querySelector(".connector-header-menu");return {region:region.getBoundingClientRect().toJSON(),regions:document.querySelectorAll("[data-workbench-region-id]").length,incoming:menu.querySelector("[data-direction=incoming]").textContent,html:menu.outerHTML}})()')
 assert.ok(result.compactHeader.regions>1&&result.compactHeader.region.width>=350&&result.compactHeader.region.width<=520)
 await press('Escape');await close()
 await set({state:'ready',refusal:false});await details('healthy','light',520);await until('document.querySelector(".connector-traffic-summary").textContent.includes("Receiver connected")');await capture('receiver-restored-narrow-light');await dismiss()
 result.receiverScope='Actual production Renderer/native input with typed visual leaves; no live SDK or management qualification.'
}
