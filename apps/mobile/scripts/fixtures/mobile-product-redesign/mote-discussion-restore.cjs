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
    await verifyThreadLayout({ win, read, until, resize, tap, capture, result })
    await resize(390, 844)
    await read('document.querySelector(".mobile-mote-threads .mote-threads__views [aria-selected=true]").focus()')
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: 'End', code: 'End', windowsVirtualKeyCode: 35,
    })
    await until('!!document.querySelector(".mobile-mote-threads .mote-threads__members:not([hidden]) [data-mote-member=session-waiting] .mobile-mote-member-open")?.getClientRects().length')
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


async function verifyThreadLayout({ win, read, until, resize, tap, capture, result }) {
  const surface = '.mobile-mote-threads .mote-threads'
  const filters = surface + ' .mote-threads__filters'
  const box = selector => `document.querySelector(${JSON.stringify(selector)})`
  const body = box(surface + ' .mote-threads__body')
  const view = name => `Array.from(${box(surface + ' .mote-threads__views')}.querySelectorAll('button')).find(button=>button.textContent.startsWith('${name}'))`
  const press = async (key, code) => {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key, code: key, windowsVirtualKeyCode: code,
    })
  }
  await until(`${view('工作')}.getAttribute('aria-selected')==='true'`)
  await read(`${view('工作')}.focus()`)
  await press('ArrowRight', 39)
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await read(`document.activeElement===${view('成员')}&&${view('成员')}.getAttribute('aria-selected')==='true'`), true,
    'The real inner arrow focuses and activates Members')
  assert.equal(await read(`(() => {
    const tab = ${view('成员')}, panel = document.getElementById(tab.getAttribute('aria-controls'));
    return !panel.hidden && panel.getAttribute('aria-labelledby')===tab.id;
  })()`), true, 'The real inner tab selects and labels the original members panel')
  await press('ArrowLeft', 37)
  await until(`document.activeElement===${view('工作')}&&${view('工作')}.getAttribute('aria-selected')==='true'`)
  await until(`${box(filters)}.querySelector('[aria-label="已回报"]').dataset.count==='1'&&${box(filters)}.querySelector('[aria-label="含问题"]').dataset.count==='1'`)
  const geometry = await read(`(() => {
    const group = ${box(filters)}, bounds = group.getBoundingClientRect();
    return [...group.querySelectorAll('button')].map(button=>{
      const rect = button.getBoundingClientRect();
      const label = document.createRange();
      label.selectNode(button.firstChild);
      const labelRect = label.getBoundingClientRect(), count = button.querySelector('span');
      const countRect = count.getBoundingClientRect();
      return {name:button.getAttribute('aria-label'),count:count.textContent, width:rect.width,height:rect.height,
        intact:[rect,labelRect,countRect].every(part=>part.width>0&&part.left>=bounds.left&&part.right<=Math.min(innerWidth,bounds.right))};
    });
  })()`)
  assert.deepEqual(geometry.map(({ name, count }) => [name, count]), [['全部','2'],['含问题','1'],['已回报','1'],['待核对','0']])
  assert.ok(geometry.every(item => item.intact && item.width >= 44 && item.height >= 44), 'Every filter label and count fits its complete 44px hit area at 320px')
  result.operations.push({ action: 'thread-layout-complete-filters', geometry })
  await capture('mote-thread-layout-filters-and-focus-320')

  const secondary = '[data-mote-work-event="original-review-event"] .mote-work-event__summary'
  const primary = '[data-mote-work-event="original-research-event"] .mote-work-event__summary'
  const earlier = box('[data-mote-work-thread="original-review-event"]')
  const detail = box('[data-mote-work-thread="original-research-event"]')
  await resize(960, 800)
  await until(`getComputedStyle(${body}).display==='grid'`)
  await tap(secondary, 'Keep the other source expanded')
  await tap(primary, 'Read the original research thread')
  await until(`${detail}?.querySelectorAll('.mote-work-event__reply p').length>=12`)
  assert.equal(await read(`${earlier}.checkVisibility()&&${detail}.checkVisibility()&&${earlier}.closest('[data-mote-work-event]')!==null`), true,
    'The wide work list still shows the other expanded original thread')
  await capture('mote-thread-layout-both-original-threads-wide')

  await resize(320, 680)
  await until(`getComputedStyle(${body}).display!=='grid'`)
  assert.equal(await read(`!${earlier}.checkVisibility()&&${detail}.checkVisibility()`), true, 'The original selected thread fills the tight reading surface')
  const before = await read(`(() => {
    const thread = ${detail}, paragraph = [...thread.querySelectorAll('.mote-work-event__reply p')][8];
    paragraph.scrollIntoView({block:'center'});
    const focus = thread.querySelector('button');
    focus.focus({preventScroll:true});
    const text = paragraph.querySelector('strong').firstChild, range = document.createRange();
    range.setStart(text,0); range.setEnd(text,text.length);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    window.originalThreadLayout = {thread, paragraph, range, text, focus, earlier:${earlier}};
    return {text:range.toString(),top:range.getBoundingClientRect().top,
      reads:mobileProductScene.facts().calls.filter(call=>call.method==='message.dispatch.read').length};
  })()`)
  assert.ok(before.text.length > 0 && before.top > 0 && before.top < 680, 'The original reply starts from a real scrolled reading position')
  const remembered = async (width, height, name) => {
    await resize(width, height)
    const settled = await read(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve((()=>{
      const old = window.originalThreadLayout, selection = getSelection(), range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const rect = old.range.getBoundingClientRect();
      const scroller = document.querySelector('.mobile-mote-threads-panel'), toolbar = scroller.querySelector('.mote-threads__toolbar')
      const clip = scroller.getBoundingClientRect(), top = Math.max(clip.top, toolbar.getBoundingClientRect().bottom);
      return {thread:${detail}===old.thread, earlier:${earlier}===old.earlier, range:range===old.range,
        text:selection.toString(),focus:document.activeElement===old.focus, top:rect.top,
        visible:rect.top>=top&&rect.bottom<=Math.min(clip.bottom,innerHeight),
        reads:mobileProductScene.facts().calls.filter(call=>call.method==='message.dispatch.read').length};
    })()))))`)
    result.operations.push({ action: 'thread-layout-unchanged-original', width, ...settled })
    assert.ok(settled.thread && settled.earlier && settled.range && settled.focus, 'The original reply node, selection and focus survive a layout change')
    assert.equal(settled.text, before.text)
    assert.equal(settled.reads, before.reads, 'Changing width does not request original work again')
    assert.equal(settled.visible, true, 'The selected reply text stays in the reading viewport')
    await capture(name)
  }
  await remembered(960, 800, 'mote-thread-layout-reading-wide')
  await remembered(320, 680, 'mote-thread-layout-reading-narrow-return')
  await read(`(() => {
    getSelection().removeAllRanges();
    ${detail}.querySelectorAll('.mote-work-event__reply p')[12].scrollIntoView({block:'center'});
  })()`)
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const stored = await read(`(() => {
    const viewport = document.querySelector('.mobile-main').getBoundingClientRect();
    const pane = ${detail}.parentElement.getBoundingClientRect();
    const point = document.elementFromPoint((pane.left+pane.right)/2, viewport.top+viewport.height/3);
    window.originalThreadLayout.ordinary = point.closest('.md-paragraph, .mote-work-event__reply');
    return window.originalThreadLayout.ordinary?.textContent;
  })()`)
  assert.ok(stored?.includes('样本'), 'Ordinary reading starts in the actual scrolled reply')
  await resize(960, 800)
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const ordinary = await read(`(() => {
    const anchor = window.originalThreadLayout.ordinary, viewport = document.querySelector('.mobile-main').getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    return {same: ${detail}.contains(anchor), text: anchor.textContent, visible: rect.top>=viewport.top && rect.bottom<=viewport.bottom};
  })()`)
  assert.deepEqual(ordinary, {same: true, text: stored, visible: true}, 'An ordinary reader keeps its original visible paragraph without selecting text')
  result.operations.push({ action: 'thread-layout-ordinary-reading', ...ordinary })
}
