const assert=require('node:assert/strict')
module.exports=async({win,read,until,resize,tap,button,capture,result,phase})=>{
  if(phase!=='restore'){
    const tabs = '.mobile-mote-sections'
    const selected = `document.querySelector('${tabs} [role="tab"][aria-selected="true"]')`
    const assertPanel = async label => {
      await until(`${selected}?.textContent==='${label}'`)
      assert.equal(await read(`(() => {
        const tab = ${selected}, panel = document.getElementById(tab.getAttribute('aria-controls'));
        return !panel.hidden && panel.getAttribute('aria-labelledby') === tab.id &&
          document.querySelectorAll('${tabs} [role="tab"][tabindex="0"]').length === 1;
      })()`), true, 'Each selected Mote tab labels its own visible panel and is the single keyboard entry')
    }
    await button('Mote', '.mobile-navigation')
    await assertPanel('Discussion')
    await resize(320, 680)
    await capture('mobile-mote-discussion-selection-narrow')
    await read(`${selected}.focus()`)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39,
    })
    await assertPanel('Threads')
    assert.equal(await read(`document.activeElement===${selected}`), true, 'The real keyboard moves focus into Threads')
    await capture('mobile-mote-threads-selection-narrow')
    await resize(390, 844)
    await button('成员','.mobile-mote-threads');await until('!!document.querySelector(".mobile-mote-threads [data-mote-member=session-waiting] .mobile-mote-member-open")?.getClientRects().length')
    await tap('.mobile-mote-threads .mobile-mote-team-section:last-of-type [data-mote-member=session-waiting] .mobile-mote-member-open','Open original member thread')
    await until('mobileProductScene.facts().record.selectedSessionId==="session-waiting"&&!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    await tap('.mobile-conversation-panel [contenteditable=true]','Retain original member draft')
    win.webContents.insertText('原 thread 草稿，重启后仍回到这里。')
    await until('mobileProductScene.facts().record.conversation.drafts.some(([key,text])=>key.includes("session-waiting")&&text.includes("重启后"))&&mobileProductScene.facts().record.presentation?.moteView?.directAgent===true')
    await capture('13-mobile-thread-before-process-restart')
  }else{
    await until('mobileProductScene.facts().record.selectedSessionId==="session-waiting"&&document.querySelector(".mobile-header [data-mobile-back]")?.getAttribute("aria-label")==="返回 Threads"&&!!document.querySelector(".mobile-mote-context[data-variant=member]")')
    await until('document.querySelector("[contenteditable=true]")?.textContent==="原 thread 草稿，重启后仍回到这里。"')
    const facts=await read('mobileProductScene.facts()')
    assert.deepEqual(facts.record.presentation.moteView,{spaceId:'mote-original',section:'threads',detail:true,directAgent:true})
    assert.equal(facts.calls.filter(call=>["agent.open","agent.input.submit","space.mote.dialogue.input.submit"].includes(call.method)).length,0)
    await capture('14-mobile-original-thread-after-process-restart')
    result.operations.push({action:'original-thread-identity-navigation-draft-restored-without-replay',selectedSessionId:facts.record.selectedSessionId,route:facts.record.presentation.moteView})
  }
}
