const assert = require('node:assert/strict')

module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  const entry = '.mobile-focus-project .mobile-agent-locations-entry:is([aria-label^="日常协作 ·"],[aria-label^="把保留完整来源的研究想法整理成下一步小实验 ·"])'
  const sheet = '.mobile-agent-locations-sheet'
  const list = '.mobile-agent-locations-list'
  await button('Focus', '.mobile-navigation')
  await button('日常协作', '.mobile-focus-project')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await read('window.originalCaptureEditor=document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]"); originalCaptureEditor.focus()')
  await win.webContents.insertText('保留草稿和当前阅读，查看原始展示位置。')
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("查看原始展示位置"))')
  await button('返回 Focus', '.mobile-session-toolbar')
  const start = await read('mobileProductScene.facts().calls.length')
  const settle = () => read('Promise.all([...document.querySelectorAll(".mobile-main")].flatMap(node=>node.getAnimations({subtree:true})).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))')
  const prepare = async (scene, expected) => {
    await read(`mobileProductScene.prepareAgentLocations(${JSON.stringify(scene)})`)
    await button('刷新空间目录', '.mobile-spatial-panel')
    await until(`document.querySelector(${JSON.stringify(entry)}).getAttribute('aria-label').includes(${JSON.stringify(expected)})`)
  }
  const geometry = () => read(`(()=>{const entry=document.querySelector(${JSON.stringify(entry)}),r=entry.getBoundingClientRect(),row=entry.closest('.mobile-agent-row');return {entry:r.toJSON(),label:entry.getAttribute('aria-label'),row:row.getBoundingClientRect().toJSON(),next:row.nextElementSibling?.getBoundingClientRect().toJSON(),inline:!!row.querySelector('details.mobile-session-locations'),editor:document.querySelector('[contenteditable=true]')===originalCaptureEditor,draft:originalCaptureEditor.textContent}})()`)
  const open = async () => {
    await tap(entry); await until(`!!document.querySelector(${JSON.stringify(list)})`)
    await read(`Promise.all(document.querySelector(${JSON.stringify(sheet)}).getAnimations().map(animation=>animation.finished.catch(()=>{})))`)
  }
  const close = () => button('关闭位置选择', sheet)
  result.agentLocations = []
  await prepare('multi', '2 个位置')
  for (const [width, height, appearance] of [[320,760,'dark'],[390,844,'light'],[430,480,'dark']]) {
    await resize(width,height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await settle()
    const before = await geometry()
    result.operations.push({ action:'location-geometry',width,height,appearance,before })
    assert.ok(before.entry.width>=44 && before.entry.height>=44)
    assert.equal(before.inline,false)
    if (width===320) await capture('agent-locations-compact-320-dark')
    await open()
    const after = await geometry()
    assert.equal(after.row.y,before.row.y); assert.equal(after.row.height,before.row.height)
    assert.deepEqual(after.next,before.next,'Opening the overlay does not push another Agent')
    const choices = await read(`(()=>{const sheet=document.querySelector(${JSON.stringify(sheet)});return {count:sheet.querySelectorAll('.mobile-agent-location').length,groups:sheet.querySelectorAll('.mobile-agent-location-group').length,inline:!!sheet.closest('.mobile-agent-row'),rect:sheet.getBoundingClientRect().toJSON(),hostOther:sheet.innerText.includes('another-host'),generic:[...sheet.querySelectorAll('strong')].some(n=>n.textContent==='Tab'||n.textContent==='Agent')}})()`)
    assert.equal(choices.count,3); assert.equal(choices.inline,false); assert.equal(choices.hostOther,false); assert.equal(choices.generic,false)
    assert.equal(choices.groups,2, 'Two physical positions group all three Space context choices')
    assert.ok(choices.rect.y>=0 && choices.rect.bottom<=height+1)
    result.agentLocations.push({ width,height,appearance,before,after,choices })
    await capture(`agent-locations-alias-${width}-${height}-${appearance}`); await close()
  }
  await resize(320,760); await read('mobileProductScene.setAppearance("light")')
  for (const [scene,expected] of [['zero','0 个位置'],['one','1 个位置'],['unknown','位置待确认']]) {
    await prepare(scene,expected); await open()
    await capture(`agent-locations-${scene}-320-light`); await close()
  }
  await prepare('long','2 个位置'); await resize(390,480); await open()
  await capture('agent-locations-long-short-390-light'); await close()
  await prepare('multi','2 个位置'); await resize(390,844)
  await tap(entry)
  const moving = await read(`(async()=>{for(let i=0;i<30;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const node=document.querySelector(${JSON.stringify(sheet)}),animation=node?.getAnimations().find(value=>value.effect?.getComputedTiming().iterations!==Infinity),progress=animation?.effect?.getComputedTiming().progress;if(typeof progress==='number'&&progress>0&&progress<1){document.getAnimations().filter(value=>value.effect?.getComputedTiming().iterations!==Infinity).forEach(value=>value.pause());return {progress,opacity:Number(getComputedStyle(node).opacity),translate:getComputedStyle(node).translate}}}return null})()`)
  assert.ok(moving && moving.progress>0 && moving.progress<1, 'A naturally reached opening frame is required')
  assert.equal(moving.opacity,1, 'Opening location Sheet remains opaque so original rows cannot double-expose its text')
  result.operations.push({ action:'location-opening-frame',...moving })
  await capture('agent-locations-opening-390-light',{motion:true})
  await read('document.getAnimations().filter(value=>value.effect?.getComputedTiming().iterations!==Infinity).forEach(value=>value.play())')
  await close()
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await open(); await capture('agent-locations-reduced-390-light'); await close()
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
  await open(); await read('mobileProductScene.invalidateAgentLocation()')
  await tap('.mobile-agent-locations-list > .mobile-agent-location-group:first-child > .mobile-agent-location:first-of-type > button')
  await until(`document.querySelector(${JSON.stringify(sheet)}).innerText.includes('这个位置已变化或还没确认')`)
  await capture('agent-locations-invalid-390-light'); await close()
  await prepare('multi','2 个位置'); await button('Space','.mobile-navigation')
  await button('实验计划','.mobile-spatial-panel')
  await until('!!document.querySelector(".mobile-spatial-tab .mobile-agent-locations-entry")')
  await capture('agent-locations-space-390-light')
  const end = await read('({same:document.querySelector("[contenteditable=true]")===originalCaptureEditor,draft:originalCaptureEditor.textContent,calls:mobileProductScene.facts().calls})')
  assert.equal(end.same,true); assert.ok(end.draft.includes('查看原始展示位置'))
  assert.equal(end.calls.slice(start).filter(call=>call.method==='space.focus'||/sdk\.(submit|ensureAgentContinuity|signalAgent|resizeAgent)/.test(call.method)).length,0)
  result.agentLocationsBoundary='Actual MobileApp Focus and Space with original Catalog identities and public space.inspect in private Chromium. CDP touch/viewport/theme/reduced motion are controlled; no physical phone, live Host, Relay, Run or Desktop focus is claimed.'
}
