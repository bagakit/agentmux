const assert = require('node:assert/strict')

/** Actual MobileApp/Surface/shared Composer; no fixture CSS or rewritten presentation DOM. */
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareDensity()')
  await button('Mote', '.mobile-navigation')
  await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
  await button(await read('mobileProductScene.facts().menuAgentName'), '.mobile-mote-agents')
  await until('!!document.querySelector(".mobile-conversation .composer [contenteditable=true]")')
  const readingIssue = await read('document.querySelector(".mobile-conversation__notice")?.textContent')
  assert.ok(!readingIssue, 'Actual original reading must exist: ' + readingIssue)
  const editor = '.mobile-conversation .composer [contenteditable=true]', composer = '.mobile-conversation .composer'
  const short = '保留原草稿。', full = '第一行保留原始输入。\n第二行确认工具与正文能完整阅读。\n第三行继续核对。'
  const original = await read(`(()=>{window.originalCaptureEditor=document.querySelector(${JSON.stringify(editor)});const f=mobileProductScene.facts();return{sid:f.record.selectedSessionId,identity:f.record.presentation.identity,run:f.sessionIds.find(v=>v.sessionId===f.record.selectedSessionId)}})()`)
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  async function fill(text) {
    await tap(editor, 'Original shared editor')
    await read(`(()=>{const n=document.querySelector(${JSON.stringify(editor)}),r=document.createRange();r.selectNodeContents(n);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`)
    win.webContents.insertText(text)
    await until(`document.querySelector(${JSON.stringify(editor)}).textContent===${JSON.stringify(text.replaceAll('\n', ''))}||document.querySelector(${JSON.stringify(editor)}).innerText===${JSON.stringify(text)}`)
    await settle()
  }
  async function mode(next) {
    for (let index = 0; index < 3; index++) {
      if (await read(`document.querySelector(${JSON.stringify(composer)}+' .composer-tools').dataset.mode===${JSON.stringify(next)}`)) return
      await read(`document.querySelector(${JSON.stringify(composer)}+' .composer__toolbar > div:first-child').scrollLeft=0`)
      await tap(composer + ' .composer-tool--mode', 'Change original Composer mode')
    }
    throw Error('Original Composer mode did not reach ' + next)
  }
  const geometry = () => read(`(()=>{const c=document.querySelector(${JSON.stringify(composer)}),e=c.querySelector('[contenteditable=true]'),l=c.querySelector('.composer__toolbar > div:first-child'),r=n=>n.getBoundingClientRect().toJSON(),s=getComputedStyle(e),h=document.querySelector('.mobile-conversation__floating-tools .mobile-message-tools__trigger'),range=document.createRange();range.selectNodeContents(e);const text=range.getClientRects()[0];return{width:innerWidth,phase:c.querySelector('.composer-tools').dataset.mode,composer:r(c),editor:r(e),font:s.fontSize,textLeft:text?.left??e.getBoundingClientRect().left+parseFloat(s.paddingLeft),left:r(l),leftClient:l.clientWidth,leftScroll:l.scrollWidth,controls:[...l.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(n=>({label:n.getAttribute('aria-label')||n.title||n.textContent,rect:r(n)})),send:r(c.querySelector('.composer-send')),history:r(h),historyIcon:r(h.querySelector('svg')),sameEditor:e===window.originalCaptureEditor,draft:e.textContent,documentWidth:document.documentElement.scrollWidth}})()`)
  const center = r => r.y + r.height / 2
  function check(g) {
    assert.equal(g.font, '16px', 'Original mobile editing type remains16px')
    assert.equal(g.sameEditor, true, 'Density changes retain the original Composer DOM')
    assert.ok(g.textLeft <= 18, 'Compact editor text avoids stacked page/container/editor padding')
    assert.ok(g.documentWidth <= g.width, 'Actual mobile document has no horizontal overflow')
    for (const { label, rect } of g.controls) {
      assert.ok(rect.width >= 44 && rect.height >= 44, 'Original tool keeps44px target: ' + label)
      assert.ok(Math.abs(center(rect) - center(g.send)) <= 1, 'All original tools share one control row: ' + label)
    }
    assert.ok(g.left.right <= g.send.left + 0.5, 'Scrollable tool strip must not overlap fixed Send')
    for (const rect of [g.send, g.history]) {
      assert.ok(rect.width >= 44 && rect.height >= 44)
      assert.ok(rect.left >= 0 && rect.right <= g.width, 'Send and floating History stay inside the viewport')
    }
    assert.ok(g.history.bottom <= g.composer.top, 'Floating History stays above the original Composer')
    assert.ok(Math.abs(center(g.historyIcon) - center(g.history)) <= 1, 'History glyph stays centered in its complete touch target')
    if (g.phase !== 'expanded' && !g.draft.includes('\n')) assert.ok(g.composer.height <= 78, 'Default short Composer removes unused padding rather than edit text')
    if (g.phase === 'expanded') assert.ok(g.editor.height >= 200, 'Explicit expanded editor retains its original large editing height')
  }
  result.density = { original, cases: [], bodyCases: [] }
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760)
    await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    for (const [phase, text] of [['collapsed', ''], ['collapsed', short], ['current', short], ['expanded', full]]) {
      await mode(phase); await fill(text)
      await read(`document.querySelector(${JSON.stringify(composer)}+' .composer__toolbar > div:first-child').scrollLeft=0`)
      await settle()
      const g = await geometry(); result.density.cases.push({ width, appearance, ...g }); check(g)
      const labels = g.controls.map(c => c.label)
      assert.ok(labels.includes('Show the message tool row') || labels.includes('Grow the input box for long text') || labels.includes('Collapse the composer to one line'))
      assert.ok(labels.includes('Choose a command'), 'Commands remain directly reachable')
      assert.ok(labels.includes('Reference files for the Agent to read'), 'Files retains its original tool')
      assert.ok(g.controls.some(c => c.label === 'Interrupt the current turn') || !text, 'A working Agent with a draft keeps its original Interrupt action')
      assert.ok(await read(`!!document.querySelector(${JSON.stringify(composer)}+' .mobile-posture-picker')`), 'Actual Provider posture control participates in the same row')
      if (phase === 'current') {
        await read(`[...document.querySelectorAll(${JSON.stringify(composer)}+' .composer__toolbar > div:first-child button')].at(-1).focus()`)
        await settle()
        const reachable = await read(`(()=>{const l=document.querySelector(${JSON.stringify(composer)}+' .composer__toolbar > div:first-child'),n=document.activeElement,a=l.getBoundingClientRect(),b=n.getBoundingClientRect();return{scroll:l.scrollLeft,target:n.getAttribute('aria-label'),inside:b.left>=a.left-1&&b.right<=a.right+1}})()`)
        result.operations.push({ action: 'density-last-tool-reachable', width, appearance, ...reachable })
        assert.ok(reachable.inside && (g.leftScroll <= g.leftClient || reachable.scroll > 0), 'Last real tool is keyboard-reachable, scrolling only when the original strip overflows')
        await read(`document.querySelector(${JSON.stringify(composer)}+' .composer__toolbar > div:first-child').scrollLeft=0`)
      }
      if (phase === 'collapsed' && text || phase === 'expanded') await capture(`density-${width}-${appearance}-${phase}`)
    }
    await mode('collapsed'); await fill(short)
    await read(`document.querySelector('[data-native-record-id="session-mote-user-short"]').scrollIntoView({block:'start'})`)
    const bodies = await read(`['session-mote-user-short','session-mote-answer-original','session-mote-progress','session-mote-report'].map(id=>{const n=document.querySelector('[data-native-record-id="'+id+'"] .log-turn');return{id,phase:n?.dataset.messagePhase,bubble:n?.dataset.messageBubble,text:n?.textContent,bodyFont:n?.querySelector('.log-turn__body')?getComputedStyle(n.querySelector('.log-turn__body')).fontSize:null,width:n?.getBoundingClientRect().width}})`)
    assert.equal(bodies.length,4); for (const body of bodies) { assert.ok(body.text?.length); if (body.bodyFont) assert.equal(body.bodyFont,'13px') }
    assert.equal(bodies[1].bubble,'true');assert.equal(bodies[2].phase,'progress')
    assert.ok(await read('!!document.querySelector("[data-native-record-id=session-mote-report] .log-turn__collaboration-toggle")'), 'Latest native report disclosure is the actual shared owner')
    result.density.bodyCases.push({width,appearance,bodies})
    await capture(`density-${width}-${appearance}-messages`)
    await tap('[data-native-record-id=session-mote-report] .log-turn__collaboration-toggle', 'Original native report disclosure')
    await until('!!document.querySelector("[data-native-record-id=session-mote-report] .log-turn__body")')
    await capture(`density-${width}-${appearance}-native-report`)
    await tap('[data-native-record-id=session-mote-report] .log-turn__collaboration-toggle', 'Close original native report')
  }
  const reply = '[data-native-record-id=session-mote-answer-original]'
  await tap(reply + ' .conversation-input-details__toggle', 'Original message Info')
  await until(`!!document.querySelector(${JSON.stringify(reply + ' .conversation-input-details__body')})`)
  await tap(reply + ' [title="Copy message"]', 'Copy the complete original response')
  assert.equal(await read('mobileProductScene.facts().copiedTexts.at(-1)===mobileProductScene.facts().expectedReply'), true)
  assert.ok(await read(`!!document.querySelector(${JSON.stringify(reply + ' .conversation-input-details__body')})`), 'Copy retains original opened Info')
  await capture('density-390-light-copy-info')
  const final = await read('mobileProductScene.facts()')
  assert.equal(final.record.selectedSessionId, original.sid);assert.deepEqual(final.record.presentation.identity,original.identity)
  assert.deepEqual(final.sessionIds.find(v=>v.sessionId===original.sid),original.run)
  assert.ok(final.record.conversation.drafts.some(([,text])=>text===short))
  assert.equal(final.calls.filter(c=>['sdk.submitAgentPrompt','sdk.respondAgentInteraction','sdk.ensureAgentContinuity','agent.open'].includes(c.method)).length,0)
  assert.deepEqual(result.errors,[])
  result.density.final={sid:final.record.selectedSessionId,run:original.run,draft:short,sameEditor:await read(`document.querySelector(${JSON.stringify(editor)})===window.originalCaptureEditor`)}
}
