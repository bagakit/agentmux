const assert = require('node:assert/strict')

module.exports = async ({ win, read, until, resize, tap, button, capture, result, openMote }) => {
  await button('Focus', '.mobile-navigation')
  await button('日常协作', '.mobile-focus-project')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await read('window.statusOriginalEditor=document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]");statusOriginalEditor.focus()')
  await win.webContents.insertText('保留这份草稿，状态变化不挤动阅读。')
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("状态变化"))')
  const start = await read('mobileProductScene.facts().calls.length')
  const geometry = () => read(`(() => {
    const r=s=>{const n=document.querySelector(s);return n?n.getBoundingClientRect().toJSON():null}
    return {header:r('.mobile-header'),reader:r('.mobile-conversation-panel:not([hidden]) .mobile-conversation__reading'),composer:r('.mobile-conversation-panel:not([hidden]) .mobile-conversation__composer'),action:r('[aria-label="当前对话操作"]'),
      editor:document.querySelector('.mobile-conversation-panel:not([hidden]) [contenteditable=true]')===statusOriginalEditor,draft:statusOriginalEditor.textContent,
      inline:!!document.querySelector('.mobile-conversation__connection,.mobile-conversation > .mobile-conversation__notice'),bottom:!!document.querySelector('.mobile-notice-stack .mobile-service-notice'),
      mark:document.querySelector('[aria-label="当前对话操作"]')?.getAttribute('aria-description'),placeholder:statusOriginalEditor.getAttribute('data-placeholder')}
  })()`)
  result.conversationStatus = []
  for (const [width, height] of [[390,844], [320,760], [390,480]]) for (const appearance of ['dark','light']) {
    await resize(width,height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('mobileProductScene.setConversationStatus("active")')
    await until(`!document.querySelector('[aria-label="当前对话操作"]').hasAttribute('data-conversation-status')`)
    await read('Promise.all(document.querySelector(".mobile-app").getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
    const normal = await geometry()
    assert.equal(normal.header.height,52,'The existing header remains 52px')
    assert.ok(normal.action.height>=44&&normal.action.width>=44,'The original action keeps a 44px touch target')
    for (const state of ['retired','unconfirmed','parallel']) {
      await read(`mobileProductScene.setConversationStatus(${JSON.stringify(state)})`)
      await until(`document.querySelector('[aria-label="当前对话操作"]').getAttribute('aria-description')===${JSON.stringify(state === 'retired' ? '历史对话' : state === 'parallel' ? 'Mac 连接需要查看' : '对话信息待确认')}`)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const current = await geometry()
      assert.equal(current.inline,false,'Connection diagnostics never insert a row above the original reader')
      assert.equal(current.bottom,false,'Metadata diagnostics never insert a bottom service row')
      result.geometryDebug = {normal,current,state,width,height,appearance}
      for (const part of ['header','reader','composer','action']) for (const key of ['x','y','width','height']) assert.ok(Math.abs(current[part][key]-normal[part][key])<1,`${part} ${key} remains stable when ${state}`)
      assert.equal(current.editor,true,'The original editor remains mounted across observation changes')
      assert.equal(current.draft,'保留这份草稿，状态变化不挤动阅读。')
      assert.equal(await read('document.activeElement===statusOriginalEditor'),true,'Status changes preserve editor focus')
      await capture(`conversation-status-${state}-${width}x${height}-${appearance}`)
      await button('当前对话操作')
      await until(`document.querySelector('.mobile-session-diagnostic')?.dataset.conversationStatus===${JSON.stringify(state === 'parallel' ? 'unconfirmed' : state)}`)
      const detail = await read(`(()=>{const n=document.querySelector('.mobile-session-diagnostic');return {text:n.textContent,rect:n.getBoundingClientRect().toJSON(),sheet:document.querySelector('[role=dialog]').getBoundingClientRect().toJSON()}})()`)
      if(state==='retired') {assert.ok(detail.text.includes('内容仍可阅读'));assert.equal(detail.text.includes('离线'),false)}
      if(state==='parallel') for(const reason of ['METADATA_POINT_READ_FAILED','HISTORY_READ_FAILED','CONNECTION_OBSERVATION_FAILED']) assert.ok(detail.text.includes(reason),'Separate source details retain the original reason: '+reason)
      assert.ok(detail.sheet.y>=0&&detail.sheet.y+detail.sheet.height<=height+1,'The existing detail sheet stays within the viewport')
      if (width===320 || height===480) await capture(`conversation-status-${state}-details-${width}x${height}-${appearance}`)
      await button('关闭面板','[role=dialog]')
      await until('!document.querySelector("[role=dialog]")')
      // Radix returns focus to the original 44px trigger; typing resumes in the same editor.
      await read('statusOriginalEditor.focus()')
      result.conversationStatus.push({width,height,appearance,state,normal,current,detail})
    }
  }
  await resize(390,844); await read('mobileProductScene.setAppearance("light");mobileProductScene.setConversationStatus("retired-reading")')
  await until(`document.querySelector('[aria-label="当前对话操作"]').getAttribute('aria-description')==='对话记录读取需要重试'`)
  await capture('conversation-status-retired-reading-390-light')
  await button('当前对话操作')
  await until('document.querySelector(".mobile-session-diagnostic")?.dataset.conversationStatus==="retired"')
  const retiredFailure = await read('document.querySelector(".mobile-session-diagnostic").textContent')
  assert.ok(retiredFailure.includes('历史对话') && retiredFailure.includes('HISTORY_READ_FAILED'),'A historical record retains its independent reading failure')
  await capture('conversation-status-retired-reading-details-390-light')
  await button('关闭面板','[role=dialog]')
  await read('mobileProductScene.setConversationStatus("active")')
  await button('当前对话操作')
  await button('重新读取对话','.mobile-session-diagnostic')
  await until('document.querySelector(".mobile-session-diagnostic")?.dataset.conversationStatus==="active"')
  assert.equal(await read('document.querySelector(".mobile-session-diagnostic").textContent.includes("METADATA_POINT_READ_FAILED")'),false,'Successful exact reread clears its stale metadata issue')
  const writes = await read(`mobileProductScene.facts().calls.slice(${start}).filter(c=>/submitAgentPrompt|respondAgentInteraction|signalAgent|ensureAgentContinuity|resumeAgent/.test(c.method)||['agent.open','agent.resume','file.upload'].includes(c.method))`)
  assert.deepEqual(writes,[],'Status disclosure and explicit reread never dispatch inputs, answers, uploads or recovery')
}
