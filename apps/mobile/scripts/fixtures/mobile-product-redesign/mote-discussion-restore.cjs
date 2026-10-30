const assert=require('node:assert/strict')
module.exports=async({win,read,until,tap,button,capture,result,phase})=>{
  if(phase!=='restore'){
    await button('Mote','.mobile-navigation');await until('!!document.querySelector("[data-mote-discussion]")')
    await button('Threads');await until('!!document.querySelector(".mobile-mote-threads [data-mote-member=session-waiting]")')
    await tap('.mobile-mote-threads .mobile-mote-team-section:last-of-type [data-mote-member=session-waiting] .mobile-mote-member-open','Open original member thread')
    await until('mobileProductScene.facts().record.selectedSessionId==="session-waiting"&&!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    await tap('.mobile-conversation-panel [contenteditable=true]','Retain original member draft')
    win.webContents.insertText('原 thread 草稿，重启后仍回到这里。')
    await until('mobileProductScene.facts().record.conversation.drafts.some(([key,text])=>key.includes("session-waiting")&&text.includes("重启后"))&&mobileProductScene.facts().record.presentation?.moteView?.directAgent===true')
    await capture('13-mobile-thread-before-process-restart')
  }else{
    await until('mobileProductScene.facts().record.selectedSessionId==="session-waiting"&&document.querySelector(".mobile-mote-thread-return")?.innerText.includes("原 Agent 对话")')
    await until('document.querySelector("[contenteditable=true]")?.textContent==="原 thread 草稿，重启后仍回到这里。"')
    const facts=await read('mobileProductScene.facts()')
    assert.deepEqual(facts.record.presentation.moteView,{spaceId:'mote-original',section:'threads',detail:true,directAgent:true})
    assert.equal(facts.calls.filter(call=>["agent.open","agent.input.submit","space.mote.dialogue.input.submit"].includes(call.method)).length,0)
    await capture('14-mobile-original-thread-after-process-restart')
    result.operations.push({action:'original-thread-identity-navigation-draft-restored-without-replay',selectedSessionId:facts.record.selectedSessionId,route:facts.record.presentation.moteView})
  }
}
