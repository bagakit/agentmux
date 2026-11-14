const assert = require('node:assert/strict')

module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  const row = '.mobile-focus-project .mobile-agent-row:has(.mobile-agent-row__more[aria-label^="日常协作 ·"])'
  const menu = '.mobile-sheet--agent'
  const entry = menu + ' .mobile-agent-locations-entry'
  const sheet = '.mobile-agent-locations-sheet'
  const list = '.mobile-agent-locations-list'
  const firstChoice = list + ' > .mobile-agent-location-group:first-child > .mobile-agent-location:first-of-type > button'
  const expected = { spaceId: 'other-space', zoneId: 'zone-other', workspaceId: 'workspace-original',
    displayWorkspaceId: 'display-original', groupId: 'group-other', tabId: 'tab-other', regionId: 'region-other' }
  const text = '保留草稿和当前阅读，查看原始展示位置。'
  const focus = '.mobile-focus-project'
  const openMenu = (scope = focus, name = '日常协作') => button(name + ' · 更多操作', scope)
  const closeMenu = () => button('关闭面板', menu)
  const prepare = async scene => {
    await read('mobileProductScene.prepareAgentLocations(' + JSON.stringify(scene) + ')')
    await button('刷新空间目录', '.mobile-spatial-panel')
  }
  await button('Focus', '.mobile-navigation')
  await prepare('multi')
  await button('日常协作', focus)
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await read('window.originalCaptureEditor=document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]"); originalCaptureEditor.focus()')
  await win.webContents.insertText(text)
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("查看原始展示位置"))')
  await button('返回 Focus', '.mobile-session-toolbar')
  const start = await read('mobileProductScene.facts().calls.length')
  const geometry = () => read('(()=>{const row=document.querySelector(' + JSON.stringify(row) + ');return {row:row.getBoundingClientRect().toJSON(),next:row.nextElementSibling?.getBoundingClientRect().toJSON(),inline:!!row.querySelector(".mobile-agent-locations-entry"),editor:document.querySelector("[contenteditable=true]")===originalCaptureEditor,draft:originalCaptureEditor.textContent}})()')
  const entryFacts = () => read('(()=>{const entry=document.querySelector(' + JSON.stringify(entry) + ');return {rect:entry.getBoundingClientRect().toJSON(),label:entry.getAttribute("aria-label")}})()')
  const open = async (count = '2 个位置') => {
    await until('document.querySelector(' + JSON.stringify(entry) + ')?.getAttribute("aria-label").endsWith(' + JSON.stringify(count) + ')')
    await tap(entry)
    await until('!!document.querySelector(' + JSON.stringify(list) + ')')
    await read('Promise.all(document.querySelector(' + JSON.stringify(sheet) + ').getAnimations().map(animation=>animation.finished.catch(()=>{})))')
  }
  const close = () => button('关闭位置选择', sheet)
  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await until('!document.querySelector(' + JSON.stringify(sheet) + ')&&document.activeElement===document.querySelector(' + JSON.stringify(entry) + ')')
  }
  result.agentLocations = []
  for (const [width, height, appearance] of [[320,760,'dark'],[390,844,'light'],[430,480,'dark'],[760,620,'light']]) {
    await resize(width,height)
    await read('mobileProductScene.setAppearance(' + JSON.stringify(appearance) + ')')
    await openMenu()
    const before = await geometry()
    const target = await entryFacts()
    assert.ok(target.rect.width>=44 && target.rect.height>=44)
    assert.equal(before.inline,false)
    if (width===320) await capture('agent-locations-menu-320-dark')
    await open()
    const after = await geometry()
    assert.equal(after.row.y,before.row.y)
    assert.equal(after.row.height,before.row.height)
    assert.deepEqual(after.next,before.next,'Opening the overlay does not push another Agent')
    const choices = await read('(()=>{const sheet=document.querySelector(' + JSON.stringify(sheet) + '),groups=[...sheet.querySelectorAll(".mobile-agent-location-group")];return {count:sheet.querySelectorAll(".mobile-agent-location").length,groups:groups.map(group=>group.getAttribute("aria-label")),inline:!!sheet.closest(".mobile-agent-row"),rect:sheet.getBoundingClientRect().toJSON(),hosts:sheet.innerText.split("\\n").filter(line=>/[端]|another-host/.test(line)),generic:[...sheet.querySelectorAll("strong")].some(n=>n.textContent==="Tab"||n.textContent==="Agent")}})()')
    assert.equal(choices.count,3)
    assert.equal(choices.inline,false)
    assert.equal(choices.generic,false)
    assert.equal(new Set(choices.groups).size,2, 'Two same-named physical positions remain distinguishable across three Space entries')
    assert.ok(choices.hosts.some(line=>line.includes('执行端 local')))
    assert.ok(choices.hosts.some(line=>line.includes('资源端 host-original')))
    assert.ok(!choices.hosts.some(line=>line.includes('another-host')))
    assert.ok(choices.rect.y>=0 && choices.rect.bottom<=height+1)
    result.agentLocations.push({ width,height,appearance,target,before,after,choices })
    await capture('agent-locations-alias-' + width + '-' + height + '-' + appearance)
    if (width===390) await escape(); else await close()
    await closeMenu()
  }
  await resize(320,760)
  await read('mobileProductScene.setAppearance("light")')
  for (const [scene,count] of [['zero','0 个位置'],['one','1 个位置'],['unknown','位置待确认']]) {
    await prepare(scene)
    await openMenu(); await open(count)
    await capture('agent-locations-' + scene + '-320-light')
    await close(); await closeMenu()
  }
  await prepare('long'); await resize(390,480)
  await openMenu(focus, '把保留完整来源的研究想法整理成下一步小实验'); await open()
  await capture('agent-locations-long-short-390-light'); await close(); await closeMenu()
  await prepare('multi'); await resize(390,844)
  await openMenu()
  await tap(entry)
  const moving = await read('(async()=>{for(let i=0;i<30;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const node=document.querySelector(' + JSON.stringify(sheet) + '),animation=node?.getAnimations().find(value=>value.effect?.getComputedTiming().iterations!==Infinity),progress=animation?.effect?.getComputedTiming().progress;if(typeof progress==="number"&&progress>0&&progress<1){document.getAnimations().filter(value=>value.effect?.getComputedTiming().iterations!==Infinity).forEach(value=>value.pause());return {progress,opacity:Number(getComputedStyle(node).opacity),translate:getComputedStyle(node).translate}}}return null})()')
  assert.ok(moving && moving.progress>0 && moving.progress<1, 'A naturally reached opening frame is required')
  assert.equal(moving.opacity,1, 'Opening location Sheet remains opaque so original rows cannot double-expose its text')
  result.operations.push({ action:'location-opening-frame',...moving })
  await capture('agent-locations-opening-390-light',{motion:true})
  await read('document.getAnimations().filter(value=>value.effect?.getComputedTiming().iterations!==Infinity).forEach(value=>value.play())')
  await close()
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await open(); await capture('agent-locations-reduced-390-light'); await close()
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})

  await open()
  await read('mobileProductScene.holdAgentLocation()')
  await tap(firstChoice)
  await until('mobileProductScene.agentLocationStatus()?.pending===true && !!document.querySelector(".mobile-agent-locations-issue")?.innerText.includes("正在核对这个位置")')
  await capture('agent-locations-checking-390-light')
  await escape()
  assert.equal(await read('mobileProductScene.agentLocationStatus()?.aborted'), true)
  await read('mobileProductScene.releaseAgentLocation()')
  await until('mobileProductScene.agentLocationStatus()?.pending===false')
  const cancelled = await read('({request:mobileProductScene.agentLocationStatus(),location:mobileProductScene.facts().record.presentation?.identity?.context,focus:document.activeElement?.className})')
  assert.equal(cancelled.location,undefined)
  assert.match(cancelled.focus,/mobile-agent-locations-entry/)
  result.operations.push({ action:'late-location-after-escape',...cancelled })
  await open(); await read('mobileProductScene.invalidateAgentLocation()')
  await tap(firstChoice)
  await until('document.querySelector(' + JSON.stringify(sheet) + ')?.innerText.includes("这个位置已变化或还没确认") || !document.querySelector(' + JSON.stringify(sheet) + ')')
  const invalid = await read('({issue:document.querySelector(".mobile-agent-locations-issue")?.innerText,context:mobileProductScene.facts().record.presentation?.identity?.context})')
  assert.match(invalid.issue ?? '', /这个位置已变化或还没确认/, 'Unconfirmed exact address stays on the original location chooser')
  assert.equal(invalid.context, undefined)
  await capture('agent-locations-invalid-390-light'); await close(); await closeMenu()

  await prepare('multi'); await button('Space','.mobile-navigation')
  await button('实验计划','.mobile-spatial-panel')
  await openMenu('.mobile-spatial-tab'); await open()
  await capture('agent-locations-space-390-light')
  await tap(firstChoice)
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  const end = await read('({same:document.querySelector("[contenteditable=true]")===originalCaptureEditor,draft:originalCaptureEditor.textContent,...mobileProductScene.facts()})')
  assert.equal(end.same,true)
  assert.equal(end.draft,text)
  assert.equal(end.record.selectedSessionId,'session-mote')
  assert.deepEqual(end.record.presentation.identity.context,expected)
  assert.equal(end.record.presentation.identity.member,undefined)
  const {workspaceId: _workspaceId, ...target} = expected
  const inspect = end.calls.slice(start).filter(call=>call.method==='space.inspect'&&call.params?.target?.regionId)
  assert.deepEqual(inspect.map(call=>call.params),Array.from({length:3},()=>({target,presentation:'status'})))
  assert.equal(end.calls.slice(start).filter(call=>call.method==='space.focus'||/sdk\.(submit|ensureAgentContinuity|signalAgent|resizeAgent)/.test(call.method)).length,0)
  result.operations.push({ action:'confirmed-device-location', target, selectedSessionId:end.record.selectedSessionId, draft:end.draft, sameEditor:end.same })
  await capture('agent-locations-selected-390-light')
  result.agentLocationsBoundary='Actual MobileApp Focus and Space with controlled original Catalog identities and public space.inspect in private Chromium. CDP touch, keyboard, viewport, theme and reduced motion are controlled. Physical phone, live Host, Relay, Run and Desktop focus are outside this fixture.'
}
