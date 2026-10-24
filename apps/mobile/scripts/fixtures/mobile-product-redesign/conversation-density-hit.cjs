const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareDensity()')
  await button('刷新空间目录', '.mobile-spatial-panel')
  await button('Mote', '.mobile-navigation')
  if (await read('document.querySelector(\'[data-space-id="mote-original"] .mobile-space-row\')?.getAttribute("aria-expanded")!=="true"')) await button('我的 Mote', '.mobile-spatial-panel')
  await button(await read('mobileProductScene.facts().menuAgentName'), '[data-space-id="mote-original"] .mobile-mote-agents')
  const editor = '.mobile-conversation .composer [contenteditable=true]', left = '.mobile-conversation .composer__toolbar > div:first-child'
  await until('!!document.querySelector(' + JSON.stringify(editor) + ')')
  const original = await read(`(()=>{window.originalCaptureEditor=document.querySelector(${JSON.stringify(editor)});const f=mobileProductScene.facts();return{sid:f.record.selectedSessionId,identity:f.record.presentation.identity,run:f.sessionIds.find(v=>v.sessionId===f.record.selectedSessionId)}})()`)
  for (let i=0;i<2;i++) await tap('.mobile-conversation .composer-tool--mode','Expand the original editor')
  await until('document.querySelector(".mobile-conversation .composer-tools").dataset.mode==="expanded"')
  result.expandedHits = []
  for (const width of [320,390]) for (const appearance of ['dark','light']) {
    await resize(width,760);await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    const draft = `实际点击核对 ${width} ${appearance}，保留原身份。`
    await tap(editor,'Original expanded editor')
    await read(`(()=>{const n=document.querySelector(${JSON.stringify(editor)}),r=document.createRange();r.selectNodeContents(n);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`)
    win.webContents.insertText(draft)
    await until(`document.querySelector(${JSON.stringify(editor)}).textContent===${JSON.stringify(draft)}`)
    await read(`document.querySelector(${JSON.stringify(left)}).scrollLeft=0`)
    const painted = await read(`(()=>{const c=document.querySelector('.mobile-conversation .composer'),l=c.querySelector('.composer__toolbar > div:first-child');return{left:l.getBoundingClientRect().toJSON(),editorHeight:c.querySelector('[contenteditable=true]').getBoundingClientRect().height,controls:['.composer-send','.mobile-message-tools__trigger'].map(selector=>{const n=c.querySelector(selector),s=n.querySelector('svg'),r=n.getBoundingClientRect(),g=s.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),glyphHit=document.elementFromPoint(g.x+g.width/2,g.y+g.height/2);return{selector,rect:r.toJSON(),glyph:g.toJSON(),hit:hit===n||n.contains(hit),glyphHit:glyphHit===n||n.contains(glyphHit),disabled:n.disabled,visibility:getComputedStyle(s).visibility,opacity:getComputedStyle(s).opacity,hitOwner:hit?.outerHTML.slice(0,180)}})}})()`)
    result.expandedHits.push({width,appearance,painted})
    assert.ok(painted.editorHeight>=200)
    for(const control of painted.controls){assert.ok(control.hit&&control.glyphHit&&!control.disabled,'Actual expanded control and its visible glyph are hit-testable: '+control.selector);assert.notEqual(control.visibility,'hidden');assert.notEqual(control.opacity,'0');assert.ok(painted.left.right<=control.rect.left+.5)}
    await capture(`density-hit-${width}-${appearance}-expanded`)
    await tap('.mobile-conversation .mobile-message-tools__trigger','Actual expanded History')
    await until('!!document.querySelector("[role=dialog] .mobile-message-tools__records")')
    if(appearance==='light') await capture(`density-hit-${width}-${appearance}-history`)
    await button('关闭通信记录','[role=dialog]')
    await until('!document.querySelector("[role=dialog]")')
    const before = await read('mobileProductScene.facts().calls.filter(c=>c.method==="sdk.submitAgentPrompt").length')
    await tap('.mobile-conversation .composer-send','Actual expanded Send into the controlled original SDK')
    await until(`mobileProductScene.facts().calls.filter(c=>c.method==='sdk.submitAgentPrompt').length===${before+1}`)
    const call = await read('mobileProductScene.facts().calls.filter(c=>c.method==="sdk.submitAgentPrompt").at(-1)')
    assert.equal(call.params.agentSessionId,original.sid);assert.equal(call.params.expectedRun.runId,original.run.runId);assert.equal(call.params.prompt,draft)
    await until(`document.querySelector(${JSON.stringify(editor)}).textContent===''`)
    assert.equal(await read(`document.querySelector(${JSON.stringify(editor)})===window.originalCaptureEditor`),true)
    result.expandedHits.at(-1).actualInput={method:call.method,agentSessionId:call.params.agentSessionId,runId:call.params.expectedRun.runId,prompt:call.params.prompt,operationId:call.params.operationId}
  }
  const final=await read('mobileProductScene.facts()')
  assert.equal(final.record.selectedSessionId,original.sid);assert.deepEqual(final.record.presentation.identity,original.identity)
  assert.deepEqual(final.sessionIds.find(v=>v.sessionId===original.sid),original.run)
  assert.equal(final.calls.filter(c=>c.method==='sdk.submitAgentPrompt').length,4)
  assert.equal(final.calls.filter(c=>c.method==='sdk.ensureAgentContinuity'||c.method==='agent.open').length,0)
}
