const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, button, capture, openGoal, result }) => {
  const flush = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const editor = '.mobile-conversation [contenteditable=true]'
  const trigger = '.mobile-conversation .mobile-posture-picker button'
  const menu = '.mobile-posture-menu[role=menu]'
  const menuItems = menu + ' [role=menuitem]'
  const find = selector => `document.querySelector(${JSON.stringify(selector)})`
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
    }
  }
  const enter = () => key('Enter', 'Enter', 13)
  const down = () => key('ArrowDown', 'ArrowDown', 40)
  const escape = () => key('Escape', 'Escape', 27)
  const calls = method => read(`mobileProductScene.facts().calls.filter(call => call.method === ${JSON.stringify(method)})`)
  const noActiveChoice = async () => assert.equal(await read(`!${find(menu)}.querySelector('[aria-checked],[aria-current],[aria-selected]')`), true,
    'An unavailable native current mode must not look selected')
  async function checkMenuFocus(index) {
    await flush()
    assert.equal(await read(`document.activeElement === document.querySelectorAll(${JSON.stringify(menuItems)})[${index}]`), true,
      'Arrow keys must move focus through the actual permission actions')
  }
  async function closedAtOriginalTrigger() {
    await until(`!${find(menu)}`)
    await flush()
    assert.equal(await read(`document.activeElement === ${find(trigger)}`), true, 'Dismissal restores the actual original trigger')
  }
  const visiblePanel = kind => read(`!!document.querySelector('.mobile-${kind}-panel:not([hidden])')`)
  const declaration = await read('mobileProductScene.prepareDensity()')
  await read('mobileProductScene.prepareLocalConversationControls()')
  assert.ok(declaration?.modes.length >= 2, 'At least two original Provider actions must be available')
  result.controls = []
  for (const context of ['mote','ordinary']) {
    if (context === 'ordinary') {
      await button('Focus', '.mobile-navigation'); await button('实验建议', '.mobile-focus-project')
    } else {
      await button('Focus', '.mobile-navigation')
      await button(await read('mobileProductScene.facts().menuAgentName'), '.mobile-focus-project')
      await until('mobileProductScene.facts().record.selectedSessionId === "session-mote"')
    }
    await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    await read(`window.originalCaptureEditor=document.querySelector(${JSON.stringify(editor)})`)
    const original = await read('(()=>{const f=mobileProductScene.facts();return {sid:f.record.selectedSessionId,identity:f.record.presentation.identity,run:f.sessionIds.find(v=>v.sessionId===f.record.selectedSessionId)}})()')
    await tap(editor,'Original draft editor'); win.webContents.insertText('顶部切换和浮动工具保留这份草稿。')
    await flush()
    if (context === 'mote') {
      await resize(320, 440)
      await read('mobileProductScene.setAppearance("dark")')
      await until(`!!${find(trigger)}`)
      const focusTrigger = () => read(`${find(trigger)}.focus()`)
      const selection = await read(`(()=>{const s=getSelection(), e=${find(editor)};return {offset:s.anchorOffset,text:s.anchorNode.textContent,inside:e.contains(s.anchorNode)}})()`)
      assert.ok(selection.inside, 'The original insertion point starts inside the editor')
      let startCalls = (await calls('sdk.setAgentPosture')).length
      for (const [open, label] of [[enter, 'Enter'], [() => key(' ', 'Space', 32), 'Space'], [down, 'ArrowDown']]) {
        await focusTrigger(); await open()
        await until(`!!${find(menu)}`)
        assert.equal(await read(`${find(trigger)}.getAttribute('aria-haspopup')`), 'menu', 'The permission action trigger names a menu')
        await noActiveChoice()
        await flush()
        await checkMenuFocus(0)
        await down()
        await checkMenuFocus(1)
        assert.equal((await calls('sdk.setAgentPosture')).length, startCalls, label + ' and browsing must not issue a request')
        if (label === 'ArrowDown') await capture('controls-posture-keyboard-short-dark')
        await escape(); await closedAtOriginalTrigger()
      }
      await read(`${find(editor)}.focus()`)
      assert.deepEqual(await read(`(()=>{const s=getSelection(),e=${find(editor)};return {offset:s.anchorOffset,text:s.anchorNode.textContent,inside:e.contains(s.anchorNode)}})()`),
        selection, 'Returning to the original editor preserves its text and exact insertion point')
      await focusTrigger(); await down(); await until(`!!${find(menu)}`); await checkMenuFocus(0)
      await down(); await checkMenuFocus(1); await enter(); await closedAtOriginalTrigger()
      await until('mobileProductScene.facts().calls.some(c => c.method === "sdk.postureReceipt")')
      let requests = await calls('sdk.setAgentPosture')
      assert.equal(requests.length, ++startCalls, 'Enter submits only one set request')
      assert.equal(requests.at(-1).params.modeId, declaration.modes[1].id)
      assert.equal(requests.at(-1).params.target.agentSessionId, original.sid)
      assert.deepEqual(requests.at(-1).params.target.expectedRun, { runId: original.run.runId })

      await resize(390, 760)
      await read('mobileProductScene.setAppearance("light")')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await tap(trigger, 'Original permission actions')
      await until(`!!${find(menu)}`)
      await noActiveChoice()
      assert.equal(await read('matchMedia("(prefers-reduced-motion: reduce)").matches'), true)
      await capture('controls-posture-touch-light-reduced')
      await tap(menuItems + ':first-child', 'Original first permission action')
      await until(`!${find(menu)}`)
      requests = await calls('sdk.setAgentPosture')
      assert.equal(requests.length, ++startCalls, 'A tap submits only one set request')
      assert.equal(requests.at(-1).params.modeId, declaration.modes[0].id)
      assert.equal(requests.at(-1).params.target.agentSessionId, original.sid)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      result.posture = { keyboardOpens: 3, verifiedRequests: requests.map(call => call.params), original }
    } else {
      await read('mobileProductScene.settlePosture()')
      await until('mobileProductScene.facts().calls.some(c => c.method === "sdk.postureReceipt" && c.params.outcome === "unknown")')
      await flush()
      const late = (await calls('sdk.postureReceipt')).find(call => call.params.outcome === 'unknown').params
      assert.equal(late.target.agentSessionId, result.posture.original.sid)
      assert.equal(late.target.expectedRun.runId, result.posture.original.run.runId)
      assert.notEqual(original.sid, late.target.agentSessionId)
      assert.ok(await read(`!${find('.mobile-conversation')}.textContent.includes('模式切换未完成')`), 'The previous Session result never paints on this conversation')
      result.posture.delayed = { receipt: late, visibleSession: original.sid }
    }
    for (const width of [320,390]) for (const appearance of ['dark','light']) {
      await resize(width,760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`); await flush()
      await read("(()=>{const feed=document.querySelector('.mobile-conversation__reading');feed.scrollTop=feed.scrollHeight})()")
      const geometry = await read(`(()=>{const tool=document.querySelector('.mobile-conversation__floating-tools'),composer=document.querySelector('.mobile-conversation__composer'),r=n=>n.getBoundingClientRect().toJSON();return {tools:r(tool),composer:r(composer),buttons:[...tool.querySelectorAll('button'),...document.querySelectorAll('.mobile-header .mobile-session-view-toggle')].filter(n=>n.getClientRects().length).map(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{label:n.getAttribute('aria-label'),rect:r(n),hit:hit===n||n.contains(hit)}}),triggers:document.querySelectorAll('.mobile-message-tools__trigger').length,terminalInHeader:document.querySelectorAll('.mobile-header .mobile-session-view-toggle').length}})()`)
      assert.equal(geometry.triggers,1); assert.equal(geometry.terminalInHeader,1)
      assert.ok(geometry.tools.bottom <= geometry.composer.top,'Floating controls remain above the original editor and attachments')
      for(const control of geometry.buttons) { assert.ok(control.rect.width>=44 && control.rect.height>=44,'Small visuals retain complete touch geometry');assert.ok(control.hit,'Every actual floating/top control remains touchable');assert.ok(control.rect.left>=0 && control.rect.right<=width) }
      result.controls.push({context,width,appearance,geometry})
      await capture(`controls-${context}-${width}-${appearance}`)
      await tap('.mobile-header .mobile-session-view-toggle','Top Terminal'); await flush()
      assert.equal(await visiblePanel('terminal'),true,'Actual top action switches the original panel to Terminal')
      await tap('.mobile-header .mobile-session-view-toggle','Top Conversation'); await flush()
      assert.equal(await visiblePanel('conversation'),true)
      await openGoal(); await flush()
      assert.equal(await visiblePanel('goal'),true,'Actual floating Goal action opens the original Goal owner')
      await until(`mobileProductScene.facts().calls.some(c=>c.method==="goal.ls"&&c.params.agentSessionId===${JSON.stringify(original.sid)})`)
      assert.equal(await read('mobileProductScene.facts().calls.filter(c=>c.method==="goal.ls").at(-1).params.agentSessionId'),original.sid)
      await tap('.mobile-header [data-mobile-back]','Return from original Goal'); await flush()
      assert.equal(await visiblePanel('conversation'),true)
      assert.equal(await read('document.activeElement===window.captureGoalReturn'),true,'Goal returns focus to the original floating trigger')
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
    if (context === 'mote') {
      await read('mobileProductScene.holdNextPosture()')
      await tap(trigger, 'Open original permission menu for delayed receipt')
      await tap(menuItems + ':first-child', 'Submit original permission intent before switching conversation')
      await until('mobileProductScene.facts().calls.filter(c => c.method === "sdk.setAgentPosture").length === 3')
    }
  }
  const final=await read('mobileProductScene.facts()')
  assert.equal(final.calls.filter(c=>['sdk.submitAgentPrompt','sdk.ensureAgentContinuity','agent.open','goal.start'].includes(c.method)).length,0)
  result.controlsBoundary = 'Actual MobileApp and original owners; controlled original hosted facts. Short viewport approximates keyboard geometry; physical iOS/Android IME is not observed.'
}
