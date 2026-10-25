const assert = require('node:assert/strict')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await button('Mote', '.mobile-navigation')
  await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
  await button('日常协作', '.mobile-mote-agents')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await button('目标与结果')
  await button('查看目标 把两个想法变成一个小实验')
  await until('!!document.querySelector(".mobile-goal-panel:not([hidden]) .mobile-goal-evidence code")')
  for (const appearance of ['dark', 'light']) for (const width of [320, 390]) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-goal-evidence").scrollIntoView({block:"center"})')
    const rows = await read(`(()=>{const evidence=document.querySelector('.mobile-goal-panel:not([hidden]) .mobile-goal-evidence');return {
      listStyle:getComputedStyle(evidence).listStyleType, rows:[...evidence.querySelectorAll('li')].map(n=>({display:getComputedStyle(n).display,fileIcon:!!n.querySelector(':scope > svg')})),
      actions:[...evidence.querySelectorAll('button')].map(n=>({rect:n.getBoundingClientRect().toJSON(),background:getComputedStyle(n).backgroundColor}))}})()`)
    assert.equal(rows.listStyle, 'none', 'Both Goal consumers use unbulleted evidence rows')
    assert.ok(rows.rows.length && rows.rows.every(row => row.display === 'grid' && row.fileIcon), 'Every original evidence has one compact file row')
    assert.ok(rows.actions.length, 'Actual evidence copy actions are inspected')
    for (const action of rows.actions) {
      assert.ok(action.rect.width >= 44 && action.rect.height >= 44, 'Evidence copy retains a 44px touch target')
      assert.equal(action.background, 'rgba(0, 0, 0, 0)', 'Copy stays a light icon action')
    }
    result.operations.push({ action: 'shared-goal-evidence-row', appearance, width, ...rows })
    await capture(`polish-result-${width}-${appearance}`)
  }
  await button('返回对话')
  await button('Goals', '.mobile-navigation')
  await button('把两个想法变成一个小实验', '.mobile-goals-list')
  for (const appearance of ['light', 'dark']) {
    await resize(360, 740); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-goals .mobile-goal-evidence").scrollIntoView({block:"center"})')
    await capture(`polish-goal-detail-${appearance}`)
  }
  await button('Mote', '.mobile-navigation')
  await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
  await button('日常协作', '.mobile-mote-agents')
  await resize(320, 480); await read('mobileProductScene.setAppearance("dark")')
  if (!await read('Boolean(document.querySelector("[contenteditable=true]").textContent.trim())')) {
    await tap('[contenteditable=true]'); win.webContents.insertText('核对后继续编辑的草稿')
  }
  await read('mobileProductScene.unknownNext()'); await button('Send')
  await until('!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
  await tap('.mobile-send-status__diagnosis > summary', '发送详情')
  await tap('.mobile-send-status__diagnosis > details:nth-of-type(2) > summary', '技术信息')
  const diagnostic = '.mobile-send-status__diagnosis'
  const technicalVisibility = () => read(`(()=>{const n=document.querySelector(${JSON.stringify(diagnostic)}),p=n.querySelector('[role=alert]'),r=n.getBoundingClientRect(),a=p.getBoundingClientRect(),t=n.closest('.mobile-composer-feedback').getBoundingClientRect(),e=document.querySelector('[contenteditable=true]').getBoundingClientRect();return {visibleHeight:Math.max(0,Math.min(r.bottom,a.bottom,t.bottom,innerHeight)-Math.max(r.top,a.top,t.top,0)),editor:e.toJSON()}})()`)
  await capture('polish-technical-short-before-scroll')
  const initial = await read(`(()=>{const n=document.querySelector(${JSON.stringify(diagnostic)});return {scroll:n.scrollTop,total:n.scrollHeight,height:n.clientHeight,text:n.textContent}})()`)
  assert.ok(initial.text.includes('原 Host 已受理输入') && initial.text.includes('后来补充的草稿也保留'), 'The complete original failure stays in the original details')
  let moved = false, shown = await technicalVisibility()
  for (let swipe = 0; swipe < 5; swipe++) {
    const gesture = await read(`(()=>{const n=document.querySelector(${JSON.stringify(diagnostic)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,from:r.bottom-12,to:r.top+12,before:n.scrollTop,atEnd:n.scrollTop+n.clientHeight>=n.scrollHeight-2}})()`)
    if (gesture.atEnd) break
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gesture.x, y: gesture.from, id: 1 }] })
    for (let frame = 1; frame <= 12; frame++) {
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gesture.x, y: gesture.from + (gesture.to - gesture.from) * frame / 12, id: 1 }] })
      await pause(30)
    }
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await pause(100)
    const current = await read(`document.querySelector(${JSON.stringify(diagnostic)}).scrollTop`)
    moved ||= current > gesture.before
    const frame = await technicalVisibility()
    if (frame.visibleHeight > shown.visibleHeight) shown = frame
    result.operations.push({ action: 'touch-scroll-technical-details', swipe, before: gesture.before, after: current, ...frame })
    await capture(`polish-technical-short-scroll-${swipe}`)
  }
  assert.ok(initial.total <= initial.height || moved, 'Actual touch scrolling reads the retained technical content')
  assert.ok(shown.visibleHeight > 0, 'The original technical failure is actually visible after touch scrolling')
  assert.ok(shown.editor.height > 0 && shown.editor.bottom <= 480, 'Reading technical content keeps the short-screen editor available')
  result.operations.push({ action: 'technical-failure-visible', ...shown })
}
