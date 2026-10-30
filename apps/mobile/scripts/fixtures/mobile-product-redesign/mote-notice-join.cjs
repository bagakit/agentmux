const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, capture, result }) => {
  const draft = '主交流草稿保留：等核对原结果后，再决定下一步。'
  const inspectCalls = () => read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.inspectMoteInput").map(call=>call.params)')
  const original = '.conversation-mote-notice__original'
  const records = '.conversation-mote-notice__records'
  const protocol = '.conversation-a2a-notice__details'
  const geometry = result.noticeGeometry = []
  // Real reading gestures establish user scroll intent before touching an action
  // whose position changed when a retained original disclosure expanded.
  const reveal = async selector => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const state = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),feed=document.querySelector('.mobile-conversation__reading'),r=n.getBoundingClientRect(),v=feed.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{visible:r.top>=v.top&&r.bottom<=v.bottom&&r.left>=Math.max(0,v.left)&&r.right<=Math.min(innerWidth,v.right)&&(hit===n||n.contains(hit)),rect:r.toJSON(),viewport:v.toJSON(),before:feed.scrollTop}})()`)
      if (state.visible) return
      if (state.rect.left < state.viewport.left || state.rect.right > state.viewport.right) {
        result.noticeUnreachableAction = { selector, ...state, boxes: await read(`(()=>Object.fromEntries(['.conversation-a2a-notice','.conversation-mote-notice','.conversation-mote-notice__original','.conversation-mote-notice__body','.conversation-mote-notice__body blockquote','.conversation-mote-notice__records','.conversation-mote-notice__records .conversation-detail-actions','.conversation-mote-notice__records pre'].map(selector=>{const n=document.querySelector(selector),s=getComputedStyle(n);return[selector,{rect:n.getBoundingClientRect().toJSON(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,minWidth:s.minWidth,overflowX:s.overflowX,display:s.display}]})))()`) }
        throw Error('Original notice action is horizontally outside its actual reading viewport: ' + selector)
      }
      const x = state.viewport.x + state.viewport.width / 2
      const top = state.viewport.top + 30, bottom = state.viewport.bottom - 30
      const from = state.rect.top < state.viewport.top ? top : bottom
      const to = from === top ? bottom : top
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from, id: 1 }] })
      for (let frame = 1; frame <= 12; frame++) {
        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * frame / 12, id: 1 }] })
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      result.operations.push({ action: 'touch-scroll-notice-action', selector, attempt, before: state.before, after: await read('document.querySelector(".mobile-conversation__reading").scrollTop'), from, to })
    }
    throw Error('Original notice action not reachable with actual touch reading: ' + selector)
  }
  const touch = async (selector, label) => { await reveal(selector); await tap(selector, label, { scroll: false }) }
  const target = async selector => {
    await reveal(selector)
    const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n?.getClientRects().length)throw Error('Actual notice action unavailable');return n.getBoundingClientRect().toJSON()})()`)
    assert.ok(rect.width >= 44 && rect.height >= 44, 'Actual Mobile notice action must be at least 44px in both dimensions: ' + selector)
    const viewport = await read('document.querySelector(".mobile-conversation__reading").getBoundingClientRect().toJSON()')
    assert.ok(rect.left >= Math.max(0, viewport.left) && rect.right <= Math.min(await read('innerWidth'), viewport.right), 'The complete 44px Mobile notice action remains inside its actual horizontal reading viewport: ' + selector)
    geometry.push({ selector, viewport: await read('({width:innerWidth,height:innerHeight})'), rect })
  }
  await until('document.querySelector(".mobile-mote-team-summary")?.innerText.includes("团队 2")')
  await until('document.querySelector(".conversation-mote-notice__member")||document.querySelector(".mobile-conversation__notice")')
  const readIssue = await read('document.querySelector(".mobile-conversation__notice p")?.textContent')
  if (readIssue) { result.fixtureReadIssue = readIssue; throw Error('Controlled original conversation page: ' + readIssue) }
  await until('document.querySelector(".conversation-mote-notice__member")?.textContent==="资料整理"')
  const itemRef = await read('JSON.parse(document.querySelector(".conversation-a2a-notice[data-conversation-item-ref]").dataset.conversationItemRef)')
  assert.equal(itemRef.hostId, 'host-original')
  assert.equal(itemRef.agentSessionId, 'session-mote')
  const frame = await read('mobileProductScene.facts().calls.find(call=>call.method==="sdk.noticeFrameIdentity"&&call.params.recipientAgentSessionId==="session-mote").params')
  assert.deepEqual(frame, { routeHostId: 'local', sourceHostId: 'host-original', recipientAgentSessionId: 'session-mote' })
  assert.notEqual(frame.routeHostId, frame.sourceHostId)
  assert.deepEqual(await inspectCalls(), [], 'Collapsed visible notice does not inspect')
  assert.equal(await read(`document.querySelector('${original}').open`), false)
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Preserve original main draft while reading the member notice')
  win.webContents.insertText(draft)
  await until(`document.querySelector('[contenteditable=true]').textContent===${JSON.stringify(draft)}`)
  await capture('mote-notice-join-collapsed-390')

  await resize(320, 760)
  await target(original + ' > summary')
  await touch(original + ' > summary', 'Read exact original member decision and result')
  await until('document.querySelector(".conversation-mote-notice__body blockquote")?.textContent===mobileProductScene.facts().joinedNotice.inspection.inputText')
  const expectedRead = { agentSessionId: 'session-waiting', observationId: 'preview-mote-member-decision' }
  assert.deepEqual(await inspectCalls(), [expectedRead])
  await target(records + ' > summary')
  await touch(records + ' > summary', 'Expand original result references')
  await until(`document.querySelector('${records} [aria-label="Copy original result references"]')!==null`)
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const widths = await read(`(()=>{const feed=document.querySelector('.mobile-conversation__reading').getBoundingClientRect();return {viewport:feed.toJSON(),nodes:['.conversation-mote-notice__body','.conversation-mote-notice__body blockquote','.conversation-mote-notice__records','.conversation-mote-notice__records .conversation-detail-actions','.conversation-mote-notice__records pre'].map(selector=>{const n=document.querySelector(selector);return{selector,rect:n.getBoundingClientRect().toJSON(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth}})}})()`)
  result.noticeWidths = widths
  for (const node of widths.nodes) {
    assert.ok(node.rect.left >= Math.max(0, widths.viewport.left) && node.rect.right <= Math.min(320, widths.viewport.right), 'The complete original notice content fits its real reading width: ' + node.selector)
    assert.ok(node.scrollWidth <= node.clientWidth + 1, 'Original notice text wraps within its complete reading width: ' + node.selector)
  }
  await target(records + ' [aria-label="格式化 JSON"]')
  await touch(records + ' [aria-label="格式化 JSON"]', 'Format original result references for reading')
  await until(`document.querySelector('${records} [aria-label="格式化 JSON"]').getAttribute('aria-pressed')==='true'`)
  await target(records + ' [aria-label="Copy original result references"]')
  await touch(records + ' [aria-label="Copy original result references"]', 'Copy exact original result references')
  await until('mobileProductScene.facts().copiedTexts.length===1')
  await until(`document.querySelector('${records} [aria-label="Copy original result references"]')?.textContent.trim()==='已复制'`)
  assert.equal(await read('mobileProductScene.facts().copiedTexts[0]'), await read('JSON.stringify(mobileProductScene.facts().joinedNotice.observation.result.records,null,2)'))
  await target('.conversation-mote-notice__body > button')
  await touch('.conversation-mote-notice__body > button', 'Refresh only the same original observation')
  await until('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.inspectMoteInput").length===2')
  assert.deepEqual(await inspectCalls(), [expectedRead, expectedRead])
  await read(`document.querySelector('${original} > summary').scrollIntoView({block:'start'})`)
  await capture('mote-notice-join-original-records-320')

  await touch(original + ' > summary', 'Close original decision after reading')
  await target(protocol + ' > summary')
  await touch(protocol + ' > summary', 'Reveal retained original notification protocol')
  await until(`document.querySelector('${protocol} [aria-label="Copy notification protocol"]')!==null`)
  await target(protocol + ' [aria-label="格式化 JSON"]')
  await touch(protocol + ' [aria-label="格式化 JSON"]', 'Format original notification protocol for reading')
  await target(protocol + ' [aria-label="Copy notification protocol"]')
  await touch(protocol + ' [aria-label="Copy notification protocol"]', 'Copy exact original notification protocol')
  await until('mobileProductScene.facts().copiedTexts.length===2')
  await until(`document.querySelector('${protocol} [aria-label="Copy notification protocol"]')?.textContent.trim()==='已复制'`)
  assert.equal(await read('mobileProductScene.facts().copiedTexts[1]'), await read('mobileProductScene.facts().joinedNotice.item.content'))
  assert.deepEqual(await inspectCalls(), [expectedRead, expectedRead], 'Protocol disclosure and copy perform no extra original-observation IO')
  await read('mobileProductScene.setAppearance("light")')
  await read(`document.querySelector('${protocol} > summary').scrollIntoView({block:'start'})`)
  await capture('mote-notice-join-original-protocol-light-320')
  assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-mote')
  assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), draft)
  assert.equal(await read('mobileProductScene.facts().calls.filter(call=>["sdk.submitAgentPrompt","sdk.respondAgentInteraction","sdk.ensureAgentContinuity"].includes(call.method)).length'), 0)
  result.joinedNotice = { sourceAndRoute: frame, itemRef, collapsedInspectCount: 0, exactInspectCalls: await inspectCalls(), geometry, draftRetained: draft, exactCopies: await read('mobileProductScene.facts().copiedTexts'), memberName: await read('document.querySelector(".conversation-mote-notice__member").textContent'), noInputResponseOrContinuity: true }
}
