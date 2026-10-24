const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  const flush = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const editor = '.mobile-conversation [contenteditable=true]'
  const visiblePanel = kind => read(`!!document.querySelector('.mobile-${kind}-panel:not([hidden])')`)
  await read('mobileProductScene.prepareDensity()')
  result.controls = []
  for (const context of ['ordinary','mote']) {
    if (context === 'ordinary') {
      await button('Focus', '.mobile-navigation'); await button('实验建议', '.mobile-focus-project')
    } else {
      await button('Mote', '.mobile-navigation'); await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
      await button(await read('mobileProductScene.facts().menuAgentName'), '.mobile-mote-agents')
    }
    await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    await read(`window.originalCaptureEditor=document.querySelector(${JSON.stringify(editor)})`)
    const original = await read('(()=>{const f=mobileProductScene.facts();return {sid:f.record.selectedSessionId,identity:f.record.presentation.identity,run:f.sessionIds.find(v=>v.sessionId===f.record.selectedSessionId)}})()')
    await tap(editor,'Original draft editor'); win.webContents.insertText('顶部切换和浮动工具保留这份草稿。')
    await flush()
    for (const width of [320,390]) for (const appearance of ['dark','light']) {
      await resize(width,760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`); await flush()
      await read("(()=>{const feed=document.querySelector('.mobile-conversation__reading');feed.scrollTop=feed.scrollHeight})()")
      const geometry = await read(`(()=>{const tool=document.querySelector('.mobile-conversation__floating-tools'),composer=document.querySelector('.mobile-conversation__composer'),r=n=>n.getBoundingClientRect().toJSON();return {tools:r(tool),composer:r(composer),buttons:[...tool.querySelectorAll('button'),...document.querySelectorAll('.mobile-header .mobile-session-view-toggle')].map(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{label:n.getAttribute('aria-label'),rect:r(n),hit:hit===n||n.contains(hit)}}),triggers:document.querySelectorAll('.mobile-message-tools__trigger').length,terminalInHeader:document.querySelectorAll('.mobile-header .mobile-session-view-toggle').length}})()`)
      assert.equal(geometry.triggers,1); assert.equal(geometry.terminalInHeader,1)
      assert.ok(geometry.tools.bottom <= geometry.composer.top,'Floating controls remain above the original editor and attachments')
      for(const control of geometry.buttons) { assert.ok(control.rect.width>=44 && control.rect.height>=44,'Small visuals retain complete touch geometry');assert.ok(control.hit,'Every actual floating/top control remains touchable');assert.ok(control.rect.left>=0 && control.rect.right<=width) }
      result.controls.push({context,width,appearance,geometry})
      await capture(`controls-${context}-${width}-${appearance}`)
      await tap('.mobile-header .mobile-session-view-toggle','Top Terminal'); await flush()
      assert.equal(await visiblePanel('terminal'),true,'Actual top action switches the original panel to Terminal')
      await tap('.mobile-header .mobile-session-view-toggle','Top Conversation'); await flush()
      assert.equal(await visiblePanel('conversation'),true)
      await tap('.mobile-conversation__goal','Floating original Goal'); await flush()
      assert.equal(await visiblePanel('goal'),true,'Actual floating Goal action opens the original Goal owner')
      assert.equal(await read('mobileProductScene.facts().calls.filter(c=>c.method==="goal.ls").at(-1).params.agentSessionId'),original.sid)
      await tap('.mobile-header [data-mobile-back]','Return from original Goal'); await flush()
      assert.equal(await visiblePanel('conversation'),true)
      assert.equal(await read('document.activeElement===document.querySelector(".mobile-conversation__goal")'),true,'Goal returns focus to the original floating trigger')
      await tap('.mobile-conversation__floating-tools .mobile-message-tools__trigger','Floating original History')
      await until('!!document.querySelector("[role=dialog] .mobile-message-tools__records")')
      if(context==='mote'&&width===320&&appearance==='light') await capture('controls-history-narrow-light')
      await button('关闭通信记录','[role=dialog]'); await flush()
      assert.equal(await read('document.activeElement===document.querySelector(".mobile-message-tools__trigger")'),true)
      assert.equal(await read(`document.querySelector(${JSON.stringify(editor)})===window.originalCaptureEditor`),true)
      assert.ok(await read(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('保留这份草稿')`))
    }
    await resize(320,440)
    await tap('.mobile-conversation .composer-tool--mode','Show original tool row')
    await tap('.mobile-conversation .composer-tool--mode','Expand original editor')
    await flush()
    const compact = await read(`(()=>{const t=document.querySelector('.mobile-conversation__floating-tools').getBoundingClientRect(),e=document.querySelector(${JSON.stringify(editor)}).getBoundingClientRect();return{tools:t.toJSON(),editor:e.toJSON(),height:innerHeight}})()`)
    assert.ok(compact.tools.top>=0&&compact.tools.bottom<=compact.editor.top,'Short keyboard-sized viewport retains separated floating controls and editor')
    await capture(`controls-${context}-short-expanded`)
    await tap('.mobile-conversation .composer-tool--mode','Restore original compact editor')
    await resize(390,760)
    const final=await read('mobileProductScene.facts()')
    assert.equal(final.record.selectedSessionId,original.sid);assert.deepEqual(final.record.presentation.identity,original.identity)
    assert.deepEqual(final.sessionIds.find(v=>v.sessionId===original.sid),original.run)
  }
  const final=await read('mobileProductScene.facts()')
  assert.equal(final.calls.filter(c=>['sdk.submitAgentPrompt','sdk.ensureAgentContinuity','agent.open','goal.start'].includes(c.method)).length,0)
  result.controlsBoundary = 'Actual MobileApp and original owners; controlled original hosted facts. Short viewport approximates keyboard geometry; physical iOS/Android IME is not observed.'
}
