const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
module.exports = async ({ win, read, until, resize, tap, button, capture, result, evidence, phase, openGoal }) => {
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await read('mobileProductScene.prepareWideWorkface()')
  const focusReady = () => until('document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length===mobileProductScene.facts().sessionIds.length&&document.querySelector(".mobile-focus-pane h1")?.textContent==="Focus"')
  const draft = '保留这段未发送的想法，旋转和重启后继续。'
  if (phase === 'restore') {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).wideOriginal
    await until(`document.querySelector('[contenteditable=true]')?.textContent===${JSON.stringify(draft)}`)
    const facts = await read('mobileProductScene.facts()')
    assert.equal(facts.record.recordId, original.recordId); assert.equal(facts.record.selectedSessionId, original.sid)
    assert.deepEqual(facts.record.conversation, original.conversation); assert.deepEqual(facts.record.presentation, original.presentation)
    assert.deepEqual(facts.sessionIds.find(item => item.sessionId === original.sid), original.run)
    await resize(951, 585); await focusReady(); await capture('wide-restored-original-agent-951-light')
    result.wideOriginal = original
  } else {
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Write an unsent original Mote draft')
    await win.webContents.insertText(draft)
    await until(`mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text===${JSON.stringify(draft)})`)
    await read(`window.originalCaptureEditor=document.querySelector('[contenteditable=true]');window.wideOriginalReading=document.querySelector('.mobile-conversation__reading');window.wideRecord=JSON.stringify(mobileProductScene.facts().record);window.wideCaret={node:getSelection().anchorNode,offset:getSelection().anchorOffset};true`)
    result.wideGeometry = []
    for (const [width,height,name,theme] of [[844,390,'wide-mote-landscape-844-dark','dark'],[390,844,'wide-original-portrait-390-dark','dark'],[768,900,'wide-mote-pad-768-light','light'],[1024,768,null,'light'],[382,580,null,'light'],[669,867,null,'light'],[385,571,null,'light'],[951,585,'wide-mote-duo-951-light','light']]) {
      await read(`mobileProductScene.setAppearance(${JSON.stringify(theme)})`); await resize(width,height)
      if (width >= 760) await focusReady()
      const facts = await read(`(()=>{const app=document.querySelector('.mobile-app'),left=document.querySelector('.mobile-focus-pane'),right=document.querySelector('.mobile-primary-pane'),editor=document.querySelector('[contenteditable=true]'),r=n=>n.getBoundingClientRect().toJSON();return {width:innerWidth,wide:app.hasAttribute('data-wide-workface'),sidebar:!!left.getClientRects().length,left:r(left),right:r(right),editor:r(editor),sameEditor:editor===window.originalCaptureEditor,sameReading:document.querySelector('.mobile-conversation__reading')===window.wideOriginalReading,sameRecord:JSON.stringify(mobileProductScene.facts().record)===window.wideRecord,sameCaret:getSelection().anchorNode===window.wideCaret.node&&getSelection().anchorOffset===window.wideCaret.offset,focused:document.activeElement===editor,overflow:app.scrollWidth>app.clientWidth}})()`)
      assert.equal(facts.wide, width >= 760); assert.equal(facts.sidebar, width >= 760)
      assert.equal(facts.sameEditor, true); assert.equal(facts.sameReading, true); assert.equal(facts.sameRecord, true); assert.equal(facts.sameCaret, true); assert.equal(facts.focused, true); assert.equal(facts.overflow, false)
      if (width >= 760) { assert.ok(facts.left.width >= 240); assert.ok(facts.right.width >= 440); assert.ok(facts.left.right <= facts.right.x + 1) }
      assert.ok(facts.editor.height >= 20 && facts.editor.bottom <= height + 1)
      result.wideGeometry.push(facts); if (name) await capture(name)
    }
    await button('收起会话列表')
    await until('document.querySelector(".mobile-header .mobile-session-view-toggle")?.getBoundingClientRect().height>=44&&document.querySelector(".mobile-header .mobile-conversation__goal")?.getBoundingClientRect().height>=44')
    result.collapsedControls = await read(`Array.from(document.querySelectorAll('.mobile-header button')).map(n=>({label:n.getAttribute('aria-label'),title:n.title,rect:n.getBoundingClientRect().toJSON(),html:n.outerHTML}))`)
    result.collapsedGlyphs = await read(`Array.from(document.querySelectorAll('.mobile-header .mobile-session-tool-slot svg use,.mobile-header .mobile-session-view-toggle svg use')).map(n=>{const href=n.getAttribute('href'),symbol=href?.startsWith('#')?document.getElementById(href.slice(1)):null,svg=n.ownerSVGElement,b=n.getBBox(),paint=[];for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')paint.push({tag:p.tagName,display:s.display,visibility:s.visibility,opacity:s.opacity})}return {href,symbolExists:!!symbol,spriteParent:symbol?.parentElement?.parentElement?.tagName,bbox:{width:b.width,height:b.height},paint}})`)
    await capture('wide-collapsed-951-light'); await button('展开会话列表')
    await button('手机设置与连接', '.mobile-focus-pane'); await until('!!document.querySelector("[role=dialog]")'); await button('关闭面板', '[role=dialog]')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    await tap('.mobile-header .mobile-session-view-toggle', 'Read the same Agent terminal beside Focus')
    await until('!!document.querySelector(".mobile-terminal-panel:not([hidden]) .xterm")')
    await resize(844,390); await capture('wide-original-terminal-844-dark')
    await tap('.mobile-header .mobile-session-view-toggle', 'Return to the same conversation')
    await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    await openGoal(); await until('!!document.querySelector(".mobile-goal-panel:not([hidden])")')
    await tap('.mobile-header [data-mobile-back]', 'Return from original Agent goal work')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    await resize(390,844)
    await tap('.mobile-header [data-mobile-back]', 'Return to the original Mote directory')
    await button('Focus', '.mobile-navigation')
    await until('document.querySelector(".mobile-focus-pane")?.getAttribute("role")==="main"')
    assert.equal(await read('document.querySelector("main")?.getAttribute("aria-hidden")'), 'true')
    // An explicit left Focus row, rather than the width change, chooses the ordinary Agent.
    await button('实验建议', '.mobile-focus-pane')
    await until('mobileProductScene.facts().record.selectedSessionId==="session-result"')
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Retain the ordinary Agent draft for the next OS process')
    await win.webContents.insertText(draft)
    await until(`mobileProductScene.facts().record.conversation.drafts.filter(([,text])=>text===${JSON.stringify(draft)}).length===2`)
    await resize(951,585); await focusReady()
    result.focusHeader = await read(`(()=>{const title=document.querySelector('.mobile-focus-pane h1'),range=document.createRange();range.selectNodeContents(title);return {title:title.getBoundingClientRect().toJSON(),text:range.getBoundingClientRect().toJSON(),actions:[...document.querySelectorAll('.mobile-focus-pane .mobile-section-actions > button,.mobile-focus-pane .mobile-avatar-notice-outlet summary[aria-label="图标外观未确认"]')].filter(n=>n.getClientRects().length).map(n=>({label:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON()}))}})()`)
    assert.ok(result.focusHeader.text.width<=result.focusHeader.title.width+1,'Focus title fits beside the original header actions')
    for(const action of result.focusHeader.actions) { assert.ok(action.rect.width>=44&&action.rect.height>=44); assert.ok(result.focusHeader.text.right<=action.rect.x+1,'Focus title must not overlap a notice or action') }
    await capture('wide-ordinary-agent-951-light')
    const facts = await read('mobileProductScene.facts()')
    result.wideOriginal = { recordId: facts.record.recordId, sid: facts.record.selectedSessionId, conversation: facts.record.conversation, presentation: facts.record.presentation, run: facts.sessionIds.find(item => item.sessionId === facts.record.selectedSessionId) }
    assert.equal(facts.record.presentation.primary, 'focus')
  }
  const calls = await read('mobileProductScene.facts().calls')
  assert.equal(calls.filter(call => ['agent.open','agent.input.submit','space.mote.dialogue.input.submit','sdk.ensureAgentContinuity','sdk.submitAgentPrompt','sdk.respondAgentInteraction','sdk.writeAgent','sdk.resizeAgent','sdk.signalAgent'].includes(call.method)).length, 0)
  result.wideBoundary = 'Same device userData in two distinct private Electron OS processes; original controlled Host/Session/Run/drafts retained without dispatch. 951/382/669/385 are published WebKit DUO viewport sizes, not a Duo hardware claim. Source: https://webkit.org/blog/18486/webkit-features-for-safari-27-1/ observed 2026-11-11.'
}
