const assert = require('node:assert/strict')

module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareLocalConversationControls(); mobileProductScene.prepareAuxiliaryDensity()')
  await button('Focus', '.mobile-navigation')
  await button('日常协作', '.mobile-focus-project')
  const editor = '.mobile-conversation-panel:not([hidden]) .composer [contenteditable=true]'
  const get = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
  const viewport = '.mobile-conversation__reading'
  const flush = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  await tap(editor, 'Write in the original draft before showing historical tool details')
  win.webContents.insertText('格式化工具只读取原内容，保留草稿。')
  await until(`${get(editor)}?.textContent.includes('保留草稿')`)
  const original = await read(`(() => {
    window.originalPressedEditor=${get(editor)}
    const data=mobileProductScene.facts()
    return { session:data.record.selectedSessionId, run:data.sessionIds.find(row=>row.sessionId===data.record.selectedSessionId), draft:originalPressedEditor.textContent }
  })()`)
  if (await read('document.querySelector(".conversation-detail-summary > button")?.getAttribute("aria-expanded")==="false"')) {
    await tap('.conversation-detail-summary > button', 'Show available original records')
  }
  const process = '.native-process-observation .wf-head'
  await until(`!!${get(process)}`)
  // Only the real process and first tool are expanded. The fixture never inserts UI in the reading area.
  await read(`${get(process)}.closest('.native-process-observation').setAttribute('data-capture-first-process','')`)
  await tap('[data-capture-first-process] .wf-head', 'Read original process')
  const firstTool = '[data-capture-first-process] .wf-tool-row--observation[data-expandable]'
  await until(`!!${get(firstTool)}`)
  await read(`${get(firstTool)}.setAttribute('data-capture-first-tool','')`)
  await tap('[data-capture-first-tool]', 'Read original tool details')
  const control = '.native-process-observation .conversation-tool-trace__format'
  await until(`!!${get(control)}`)
  const payload = `(${get(control)}.closest('.conversation-tool-payload__actions').nextElementSibling)`
  const sourceText = await read(`${payload}.querySelector('code').textContent`)
  assert.deepEqual(JSON.parse(sourceText), { path: 'original/group-1-1.md' })
  assert.equal(await read('document.querySelector(".native-process-observation").textContent.includes("第 1 组原工具输出，完整依据未删。")'), true)
  assert.equal(await read(`document.querySelectorAll(${JSON.stringify(control)}).length`), 1, 'Plain-text output has no Format JSON action')
  const facts = () => read(`(() => {
    const button=${get(control)},s=getComputedStyle(button),mark=getComputedStyle(button,'::after'),r=button.getBoundingClientRect()
    const reading=${get(viewport)}, bounds=reading.getBoundingClientRect()
    const record=document.querySelector('[data-capture-first-tool]')
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
    return {label:button.getAttribute('aria-label'),text:button.textContent,pressed:button.getAttribute('aria-pressed'),
      top:r.top, inside:r.top>=bounds.top && r.bottom<=bounds.bottom && (hit===button || button.contains(hit)),
      tailDistance:reading.scrollHeight-reading.clientHeight-reading.scrollTop, scrollTop:reading.scrollTop, jump:!!document.querySelector('.mobile-reading-latest'),
      source:button.closest('.conversation-tool-payload__actions').querySelector('.conversation-tool-payload__identity').textContent,
      record:record.getAttribute('data-observation-step-id'), running:button.getAnimations().length,
      background:s.backgroundColor,shadow:s.boxShadow,outline:s.outlineStyle,focus:button.matches(':focus-visible'),
      mark:mark.content,markWidth:mark.width,markHeight:mark.height,width:r.width,height:r.height,transition:s.transitionDuration,
      code:${payload}.querySelector('code').textContent}
  })()`)
  const instances = []
  for (const [width,mode,reduced] of [[390,'dark',false],[320,'light',true]]) {
    await resize(width, 760)
    await read(`mobileProductScene.setAppearance(${JSON.stringify(mode)})`)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:reduced?'reduce':'no-preference' }] })
    await read(`${get(control)}.blur()`)
    const idle = await facts()
    assert.equal(idle.pressed,'false')
    assert.equal(idle.focus,false)
    assert.equal(idle.outline,'none')
    assert.equal(idle.code,sourceText)
    assert.equal(idle.inside,true)
    assert.ok(idle.record && idle.source.includes('CLI 事件回报'), 'The original tool and source are present')
    if (!reduced) assert.ok(idle.tailDistance <= 1, 'The original visible tool starts while following the tail')
    await capture(`format-json-${width}-${mode}-off`)
    await tap(control, 'Original Format JSON action')
    await until(`${get(control)}.getAttribute('aria-pressed')==='true'`)
    await read(`${get(control)}.blur(); Promise.allSettled(${get(control)}.getAnimations().map(a=>a.finished))`)
    await flush()
    const selected = await facts()
    result.actionGeometry ??= []
    result.actionGeometry.push({ width, idle, selected })
    assert.equal(selected.inside,true,'The format action stays fully visible and immediately reachable after its code changes height')
    assert.ok(Math.abs(selected.top-idle.top)<=2,'The engaged reading action retains its position')
    assert.equal(selected.source,idle.source)
    assert.equal(selected.record,idle.record)
    assert.equal(selected.running,0)
    assert.equal(selected.focus,false)
    assert.equal(selected.outline,'none')
    assert.equal(selected.label,idle.label)
    assert.equal(selected.text,idle.text)
    assert.ok(selected.mark !== 'none' && parseFloat(selected.markWidth)>0 && parseFloat(selected.markHeight)>0, 'Shared persistent marker is visible on the formatted tool')
    assert.notEqual(selected.background,idle.background,'Filtered and unfiltered views have different resting surfaces')
    assert.ok(selected.width>=44 && selected.height>=44, 'The original format action remains touchable')
    assert.notEqual(selected.code,sourceText)
    assert.deepEqual(JSON.parse(selected.code),JSON.parse(sourceText))
    if (reduced) assert.equal(selected.transition,'0s')
    await capture(`format-json-${width}-${mode}-selected`)
    await tap(control, 'Switch the format off')
    await tap(control, 'Switch the format on again')
    assert.equal((await facts()).pressed,'true')
    await read(`${get(control)}.focus()`)
    for (const type of ['rawKeyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
    for (const type of ['rawKeyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    const focus = await facts()
    assert.equal(focus.focus,true)
    assert.equal(focus.outline,'solid')
    assert.equal(focus.pressed,'true')
    await capture(`format-json-${width}-${mode}`)
    await tap(control,'Return to exact raw input')
    assert.equal((await facts()).code,sourceText)
    instances.push({width,mode,idle,selected,focus})
  }
  await tap(control, 'Format before copying the original')
  const copy = '.native-process-observation .conversation-tool-payload__tools:has(.conversation-tool-trace__format) .content-copy'
  await tap(copy, 'Copy exact original tool input')
  await until(`mobileProductScene.facts().copiedTexts.at(-1)===${JSON.stringify(sourceText)}`)

  const latest = '.mobile-reading-latest'
  const append = async line => {
    assert.ok(await read(`mobileProductScene.appendAuxiliaryReply(${JSON.stringify(line)})`) > 0, 'The original window is observing its own source')
    await until(`${get(viewport)}.textContent.includes(${JSON.stringify(line)})`)
    await flush()
  }
  const readingGeometry = () => read(`(() => {
    const viewport=${get(viewport)}
    return {scrollTop:viewport.scrollTop, remaining:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop}
  })()`)
  const beforeAppend = await facts()
  await append('阅读旧记录时收到同一个来源的新回复。')
  const retained = await facts()
  assert.ok(retained.inside && Math.abs(retained.top-beforeAppend.top)<=2, 'Receiving an original reply keeps the historical action in place')
  assert.ok((await readingGeometry()).remaining > 1)
  assert.ok(await read(`Boolean(${get(latest)})`))
  await tap(latest, 'Return to the original latest reply')
  await until(`${get(viewport)}.scrollHeight-${get(viewport)}.clientHeight-${get(viewport)}.scrollTop <= 1`)
  const atTail = await readingGeometry()
  await append('回到最新之后，原会话继续跟随第二条回复。')
  await until(`${get(viewport)}.scrollHeight-${get(viewport)}.clientHeight-${get(viewport)}.scrollTop <= 1`)
  const following = await readingGeometry()
  assert.ok(following.scrollTop > atTail.scrollTop, 'A later reply grows the same followed viewport')
  assert.equal(await read(`Boolean(${get(latest)})`),false)
  result.readingFollow = { retained: retained.top, atTail, following }

  const nav = '.mobile-header .mobile-session-view-toggle'
  const browse = await read(`${get(nav)}.getAttribute('aria-label')`)
  assert.equal(browse,'查看终端')
  assert.equal(await read(`${get(nav)}.hasAttribute('aria-pressed')`),false)
  await tap(nav,'Open original Terminal')
  await until(`${get(nav)}.getAttribute('aria-label')==='查看对话' && !document.querySelector('.mobile-terminal-panel').hidden`)
  assert.equal(await read(`${get(nav)}.hasAttribute('aria-pressed')`),false)
  await tap(nav,'Return to original conversation')
  await until(`${get(nav)}.getAttribute('aria-label')===${JSON.stringify(browse)} && !document.querySelector('.mobile-conversation-panel').hidden`)
  const final = await read(`(() => {const data=mobileProductScene.facts(); return {
    session:data.record.selectedSessionId,run:data.sessionIds.find(row=>row.sessionId===data.record.selectedSessionId),
    draft:${get(editor)}.textContent,same:${get(editor)}===originalPressedEditor }
  })()`)
  assert.deepEqual(final,{...original,same:true})
  result.toolActionPressed = { sourceText, original, instances, final }
}
