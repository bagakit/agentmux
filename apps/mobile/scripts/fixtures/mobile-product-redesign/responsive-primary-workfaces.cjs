const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')

// One real MobileApp and its original controlled SDK. This scenario does not mount
// alternate Surfaces or change a presentation route through private state.
module.exports = async ({ win, read, until, resize, tap, button, capture, result, evidence, phase }) => {
  await until('typeof mobileProductScene?.prepareResponsiveWorkfaces==="function"')
  await read('mobileProductScene.prepareResponsiveWorkfaces();mobileProductScene.prepareWideWorkface()')
  const goalDraft = '保留两个原始想法，先核对证据，再决定下一步。\n\n' + Array.from({ length: 10 }, (_, i) => `${i + 1}. 本段仍是未保存的目标正文；宽窄变化与返回不改变原目标或发起保存。`).join('\n\n')
  const knowledgeDraft = '这份知识仍保留原始来源和未确认项。\n\n' + Array.from({ length: 8 }, (_, i) => `${i + 1}. 这是后来继续编辑的设备草稿，先读原文件，不自动保存或提交。`).join('\n\n')
  const conversationDraft = '继续保留这段未发送的想法，切换目录和重启后再决定。'
  const topic = '.mobile-topics-host:not([hidden]) .mobile-topics-primary'
  const knowledge = `${topic} .mobile-topics-knowledge-scope:not([hidden])`
  const goalEditor = '.mobile-goals-host:not([hidden]) .mobile-goals [aria-label="目标正文草稿"]'
  const knowledgeEditor = `${knowledge} [aria-label="知识正文"]`
  const sourceHost = '.mobile-topics-host:not([hidden]) > .mobile-source-host:not([hidden])'
  const sourceReader = `${sourceHost} .mobile-topic-source-reader:not([hidden])`
  const noBusiness = async () => {
    const calls = await read('mobileProductScene.facts().calls')
    const forbidden = new Set(['agent.open', 'agent.input.submit', 'space.mote.dialogue.input.submit', 'sdk.ensureAgentContinuity', 'sdk.submitAgentPrompt', 'sdk.respondAgentInteraction', 'sdk.writeAgent', 'sdk.resizeAgent', 'sdk.signalAgent', 'goal.create', 'goal.update', 'goal.delete', 'topic.create', 'topic.knowledge.write'])
    assert.deepEqual(calls.filter(call => forbidden.has(call.method)), [], 'Responsive navigation never dispatches or changes original business objects')
    return calls
  }
  const flush = () => read(`(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.allSettled(document.getAnimations().filter(animation=>animation.playState==='running'&&Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished));})()`)
  const appearance = mode => read(`mobileProductScene.setAppearance(${JSON.stringify(mode)})`)
  const rootGeometry = async label => {
    await flush()
    const actual = await read(`(()=>{const app=document.querySelector('.mobile-app'),visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden',r=n=>n.getBoundingClientRect().toJSON();return {label:${JSON.stringify(label)},viewport:{width:innerWidth,height:innerHeight},app:r(app),overflow:app.scrollWidth>app.clientWidth,tabs:[...document.querySelectorAll('.mobile-navigation button')].filter(visible).map(n=>({label:n.getAttribute('aria-label'),rect:r(n)}))}})()`)
    assert.equal(actual.overflow, false, `${label}: no horizontal overflow`)
    assert.ok(actual.app.right <= actual.viewport.width + 1)
    for (const tab of actual.tabs) assert.ok(tab.rect.width >= 44 && tab.rect.height >= 44, `${label}: original primary touch target ${tab.label}`)
    result.responsiveGeometry.push(actual)
    return actual
  }
  const split = async (label, leftSelector, rightSelector) => {
    await until(`(()=>{const l=document.querySelector(${JSON.stringify(leftSelector)}),r=document.querySelector(${JSON.stringify(rightSelector)});return l?.getBoundingClientRect().width>100&&r?.getBoundingClientRect().width>100})()`)
    await flush()
    const actual = await read(`(()=>{const l=document.querySelector(${JSON.stringify(leftSelector)}),r=document.querySelector(${JSON.stringify(rightSelector)}),rect=n=>n.getBoundingClientRect().toJSON();return {label:${JSON.stringify(label)},left:rect(l),right:rect(r),leftOverflow:getComputedStyle(l).overflowY,rightOverflow:getComputedStyle(r).overflowY,leftHorizontalOverflow:l.scrollWidth>l.clientWidth,rightHorizontalOverflow:r.scrollWidth>r.clientWidth}})()`)
    result.responsiveGeometry.push(actual)
    if (actual.rightHorizontalOverflow) result.responsiveOverflow = await read(`(()=>{const p=document.querySelector(${JSON.stringify(rightSelector)}),r=p.getBoundingClientRect();return {clientWidth:p.clientWidth,scrollWidth:p.scrollWidth,children:[...p.querySelectorAll('*')].filter(n=>n.getClientRects().length&&n.getBoundingClientRect().right>r.right+1).slice(0,20).map(n=>({tag:n.tagName,class:n.className,rect:n.getBoundingClientRect().toJSON(),overflow:getComputedStyle(n).overflowX}))}})()`)
    assert.ok(actual.left.width >= 200 && actual.left.width <= 300, `${label}: original navigation has usable width`)
    assert.ok(actual.right.width >= 320, `${label}: original content has usable width`)
    assert.ok(actual.left.right <= actual.right.x + 1, `${label}: navigation and content are actually side by side`)
    assert.ok(Math.abs(actual.left.y - actual.right.y) <= 2, `${label}: panes share the reading row`)
    assert.equal(actual.leftHorizontalOverflow, false, `${label}: navigation does not overflow horizontally`)
    assert.equal(actual.rightHorizontalOverflow, false, `${label}: content does not overflow horizontally`)
    await rootGeometry(label)
    return actual
  }
  const independentScroll = async (label, leftSelector, rightSelector) => {
    const observed = await read(`(()=>{const left=document.querySelector(${JSON.stringify(leftSelector)}),right=document.querySelector(${JSON.stringify(rightSelector)}),scroll=[right,...right.querySelectorAll('*')].find(n=>['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+8);if(!scroll)return null;const old=scroll.scrollTop,other=left.scrollTop;scroll.scrollTop=old===0?40:0;const actual={target:scroll.className,changed:scroll.scrollTop!==old,leftUnchanged:left.scrollTop===other,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight};scroll.scrollTop=old;return actual})()`)
    assert.ok(observed, `${label}: real content supplies a scrollable original reading pane`)
    assert.equal(observed.changed, true); assert.equal(observed.leftUnchanged, true)
    result.responsiveScroll.push({ label, ...observed })
  }
  const writeDraft = async (selector, text, marker) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`)
    await tap(selector, 'Edit the original retained draft')
    await read(`document.querySelector(${JSON.stringify(selector)}).select();true`)
    await win.webContents.insertText(text)
    await until(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`)
    await read(`window[${JSON.stringify(marker)}]=document.querySelector(${JSON.stringify(selector)});window[${JSON.stringify(marker)}].setSelectionRange(4,12);true`)
  }
  const sameEditor = async (selector, marker, text) => {
    const actual = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return {same:n===window[${JSON.stringify(marker)}],value:n?.value,start:n?.selectionStart,end:n?.selectionEnd}})()`)
    assert.equal(actual.same, true, 'Width changes retain the exact original editor node')
    assert.equal(actual.value, text); assert.equal(actual.start, 4); assert.equal(actual.end, 12)
  }
  const readCount = method => read(`mobileProductScene.facts().calls.filter(call=>call.method===${JSON.stringify(method)}).length`)
  const rotation = async (width, height, reduced) => {
    const frame = '.mobile-goals-host:not([hidden]) .mobile-goals-layout'
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
    await resize(390, 844); await flush()
    await read(`(()=>{const editor=document.querySelector(${JSON.stringify(goalEditor)}),frame=document.querySelector(${JSON.stringify(frame)});editor.focus();editor.setSelectionRange(4,12);editor.scrollTop=24;window.responsiveRotation={stopped:false,frames:[],editor,frame,before:{scrollTop:editor.scrollTop,focused:document.activeElement===editor}};const tick=time=>{const s=window.responsiveRotation;if(s.stopped)return;const css=getComputedStyle(s.frame),r=s.frame.getBoundingClientRect();s.frames.push({time,width:innerWidth,height:innerHeight,column:parseFloat(css.gridTemplateColumns),columns:css.gridTemplateColumns,frameWidth:r.width,focused:document.activeElement===s.editor,start:s.editor.selectionStart,end:s.editor.selectionEnd,scrollTop:s.editor.scrollTop});requestAnimationFrame(tick)};tick(performance.now());return true})()`)
    await resize(width, height)
    await read('new Promise(resolve=>setTimeout(resolve,220))')
    const actual = await read(`(()=>{const s=window.responsiveRotation;s.stopped=true;return {before:s.before,reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,frames:s.frames,transition:getComputedStyle(s.frame).transitionDuration}})()`)
    result.responsiveMotion.push({ width, height, ...actual })
    const first = actual.frames[0].column, last = actual.frames.at(-1).column
    assert.equal(actual.reduced, reduced)
    assert.ok(last >= 200 && last <= 300)
    const intermediate = actual.frames.filter(frame => frame.column > first + 1 && frame.column < last - 1)
    if (reduced) { assert.equal(actual.transition, '0s'); assert.equal(intermediate.length, 0, 'Reduced motion never interpolates the workface tracks') }
    else assert.ok(intermediate.length > 0, 'Real rotation paints intermediate grid track geometry')
    for (const frame of actual.frames) { assert.equal(frame.focused, true); assert.equal(frame.start, 4); assert.equal(frame.end, 12); assert.equal(frame.scrollTop, actual.before.scrollTop) }
    await sameEditor(goalEditor, 'responsiveGoalEditor', goalDraft)
    await split(`Goal rotation ${width}×${height}${reduced ? ' reduced' : ''}`, '.mobile-goals-host:not([hidden]) .mobile-goals-directory', '.mobile-goals-host:not([hidden]) .mobile-goals-work')
    const chrome = await read(`({short:document.querySelector('.mobile-app').hasAttribute('data-short'),header:document.querySelector('.mobile-goals-host:not([hidden]) .mobile-page-header').getBoundingClientRect().toJSON(),tabs:[...document.querySelectorAll('.mobile-navigation button')].map(n=>n.getBoundingClientRect().toJSON())})`)
    result.responsiveMotion.at(-1).chrome = chrome
    assert.equal(chrome.short, true); assert.equal(chrome.header.height, 44)
    for (const tab of chrome.tabs) assert.ok(tab.height >= 44)
  }
  // CDP changes the actual CSS env() values; no injected style or viewport mock.
  const safeArea = async (width, height, selector, expectedSplit) => {
    const insets = { top: 24, left: 44, right: 44, bottom: 16 }
    try { await win.webContents.debugger.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets }) }
    catch (error) { result.responsiveSafeArea.push({ supported: false, message: error.message }); throw error }
    await resize(width, height); await flush()
    const actual = await read(`(()=>{const root=document.documentElement,app=document.querySelector('.mobile-app'),n=document.querySelector(${JSON.stringify(selector)}),css=getComputedStyle(root);return {viewport:{width:innerWidth,height:innerHeight},available:parseFloat(root.style.getPropertyValue('--mobile-viewport-width')),left:parseFloat(css.getPropertyValue('--mobile-safe-left')),right:parseFloat(css.getPropertyValue('--mobile-safe-right')),split:app.hasAttribute('data-wide-shell'),rect:n.getBoundingClientRect().toJSON(),overflow:app.scrollWidth>app.clientWidth}})()`)
    result.responsiveSafeArea.push({ supported: true, insets, selector, ...actual })
    assert.equal(actual.left,44); assert.equal(actual.right,44); assert.equal(actual.available,width-88); assert.equal(actual.split,expectedSplit)
    assert.ok(Math.abs(actual.rect.left-44)<=1 && Math.abs(actual.rect.right-(width-44))<=1,'Original host applies each horizontal safe inset exactly once')
    assert.equal(actual.overflow,false)
    return actual
  }
  const clearSafeArea = async () => { await win.webContents.debugger.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } }) }
  const visibleKnowledge = async () => {
    await button('Topics', '.mobile-navigation')
    await button('产品与研究', topic)
    await button('让小实验更容易开始', topic)
    await button('知识', topic)
    await until(`Boolean(document.querySelector(${JSON.stringify(knowledge + ' .mobile-topics-list strong')}))`)
  }
  result.responsiveGeometry = []; result.responsiveScroll = []; result.responsiveMotion = []; result.responsiveSafeArea = []; result.responsiveReadCounts = []

  if (phase === 'restore') {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).responsiveOriginal
    assert.ok(original?.recordId && original.goalKey && original.knowledgeKey, 'First process retains nonempty original device/editor identities')
    await until(`document.querySelector(${JSON.stringify(goalEditor)})?.value===${JSON.stringify(goalDraft)}`)
    const restored = await read('mobileProductScene.facts()')
    assert.equal(restored.record.recordId, original.recordId)
    for (const field of ['selectedSessionId', 'presentation', 'conversation', 'goalDrafts', 'knowledgeDrafts', 'goalOperationRecords', 'agentCreates', 'fileUploads']) assert.deepEqual(restored.record[field], original.record[field], `Original ${field} survives a different private OS process`)
    assert.deepEqual(restored.sessionIds, original.sessionIds)
    await resize(951, 585); await appearance('light')
    await split('restored Goal editor', '.mobile-goals:not([hidden]) .mobile-goals-directory', '.mobile-goals:not([hidden]) .mobile-goals-work')
    await capture('responsive-restored-goal-edit-951-light')
    await button('Topics', '.mobile-navigation')
    await until(`document.querySelector(${JSON.stringify(knowledgeEditor)})?.value===${JSON.stringify(knowledgeDraft)}`)
    const after = await read('mobileProductScene.facts().record')
    assert.equal(after.presentation.topics.knowledge.draftKey, original.knowledgeKey)
    assert.deepEqual(after.knowledgeDrafts, original.record.knowledgeDrafts)
    assert.deepEqual(after.goalOperationRecords, original.record.goalOperationRecords)
    await split('restored knowledge editor', `${knowledge} .mobile-knowledge-directory`, `${knowledge} .mobile-knowledge-content`)
    await capture('responsive-restored-knowledge-951-light')
    await noBusiness()
    result.responsiveOriginal = original
    result.responsiveRestored = { recordId: restored.record.recordId, goalKey: original.goalKey, knowledgeKey: original.knowledgeKey, originalUnknownRetained: true, businessDispatches: 0 }
    return
  }

  // Existing Mote/Agent path, using the same Composer before visiting any new Surface.
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await tap('.mobile-conversation-panel:not([hidden]) [contenteditable=true]', 'Retain the original Mote draft')
  await win.webContents.insertText(conversationDraft)
  await until(`mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text===${JSON.stringify(conversationDraft)})`)
  await read('window.responsiveComposer=document.querySelector(".mobile-conversation-panel [contenteditable=true]");window.responsiveReading=document.querySelector(".mobile-conversation__reading");true')
  await resize(951, 585); await appearance('dark')
  await until('document.querySelector(".mobile-focus-pane h1")?.textContent==="Focus"&&document.querySelectorAll(".mobile-focus-pane .mobile-agent-row__open").length===mobileProductScene.facts().sessionIds.length')
  await split('Mote original Agent workface', '.mobile-focus-pane', '.mobile-primary-pane')
  await capture('responsive-mote-workface-951-dark')

  await button('Goals', '.mobile-navigation'); await resize(812, 600)
  await until('!!document.querySelector(".mobile-goals:not([hidden]) .mobile-goals-list button")')
  await split('Goals root', '.mobile-goals:not([hidden]) .mobile-goals-directory', '.mobile-goals:not([hidden]) .mobile-goals-work')
  assert.equal(await read('mobileProductScene.facts().record.presentation.goals?.goalId??null'), null)
  await capture('responsive-goals-root-812-dark')
  await button('把两个想法变成一个小实验', '.mobile-goals:not([hidden]) .mobile-goals-list')
  await until('!!document.querySelector(".mobile-goals:not([hidden]) article[aria-label=目标详情]")')
  await split('Goals selected', '.mobile-goals:not([hidden]) .mobile-goals-directory', '.mobile-goals:not([hidden]) .mobile-goals-work')
  await capture('responsive-goals-detail-812-dark')
  await button('编辑目标正文', '.mobile-goals:not([hidden])')
  await writeDraft(goalEditor, goalDraft, 'responsiveGoalEditor')
  await until(`mobileProductScene.facts().record.goalDrafts?.some(item=>item.description===${JSON.stringify(goalDraft)})`)
  const goalReads = await readCount('goal.inspect')
  for (const [width, height] of [[390, 844], [667, 375], [812, 375], [768, 1024], [320, 700], [1024, 768]]) {
    await resize(width, height); await sameEditor(goalEditor, 'responsiveGoalEditor', goalDraft); await rootGeometry(`Goal editor ${width}`)
    const nav = await read('!!document.querySelector(".mobile-goals:not([hidden]) .mobile-goals-directory").getClientRects().length')
    assert.equal(nav, width >= 600)
    if (nav) await split(`Goal editor ${width}`, '.mobile-goals-host:not([hidden]) .mobile-goals-directory', '.mobile-goals-host:not([hidden]) .mobile-goals-work')
    if (width === 390) { await appearance('light'); await capture('responsive-goal-edit-390-light') }
  }
  await rotation(667,375,false)
  await rotation(812,375,true)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width:667,height:375,deviceScaleFactor:2,mobile:false })
  await resize(667,375); await flush()
  result.responsiveDpr = await read('({ratio:devicePixelRatio,width:innerWidth,height:innerHeight})')
  assert.equal(result.responsiveDpr.ratio,2)
  await sameEditor(goalEditor,'responsiveGoalEditor',goalDraft)
  await split('Goal DPR2 landscape', '.mobile-goals-host:not([hidden]) .mobile-goals-directory', '.mobile-goals-host:not([hidden]) .mobile-goals-work')
  await capture('responsive-goal-landscape-667-dpr2-light')
  await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  await resize(1024,768)
  const goalReadsAfter = await readCount('goal.inspect')
  result.responsiveReadCounts.push({ owner:'original selected Goal',method:'goal.inspect',before:goalReads,after:goalReadsAfter })
  assert.equal(goalReadsAfter,goalReads,'Layout changes do not reopen the original selected Goal reader')
  await split('Goal editor 1024', '.mobile-goals:not([hidden]) .mobile-goals-directory', '.mobile-goals:not([hidden]) .mobile-goals-work')
  await capture('responsive-goal-edit-1024-light')

  await button('Topics', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-topics-primary:not([hidden]) .mobile-topics-tree")')
  await rootGeometry('Topics root 1024'); await capture('responsive-topics-root-1024-light')
  await button('产品与研究', topic); await button('让小实验更容易开始', topic)
  await until(`!!document.querySelector(${JSON.stringify(topic + ' .mobile-topic-workface:not([hidden]) .mobile-zone-workface')})`)
  await split('Topic selected', `${topic} .mobile-topics-directory`, `${topic} .mobile-topic-workface:not([hidden])`)
  await capture('responsive-topic-discussion-1024-light')
  await button('知识', topic)
  await button('第一周的实验依据', `${knowledge} .mobile-topics-list`)
  await until(`!!document.querySelector(${JSON.stringify(knowledge + ' .mobile-topic-reading h2')})`)
  await split('Knowledge reading', `${knowledge} .mobile-knowledge-directory`, `${knowledge} .mobile-knowledge-content`)
  await button('编辑知识', knowledge)
  await writeDraft(knowledgeEditor, knowledgeDraft, 'responsiveKnowledgeEditor')
  await until(`mobileProductScene.facts().record.knowledgeDrafts?.some(item=>item.content===${JSON.stringify(knowledgeDraft)})`)
  await resize(812, 375); await appearance('dark'); await sameEditor(knowledgeEditor, 'responsiveKnowledgeEditor', knowledgeDraft)
  await split('Knowledge editing', `${knowledge} .mobile-knowledge-directory`, `${knowledge} .mobile-knowledge-content`)
  await independentScroll('Knowledge editing', `${knowledge} .mobile-knowledge-directory`, `${knowledge} .mobile-knowledge-content`)
  await capture('responsive-knowledge-edit-812-dark')
  await button('返回阅读', knowledge)
  await tap(`${knowledge} .mobile-topic-reading:not([hidden]) .mobile-topic-source`, 'Read the exact original knowledge file source')
  await until(`document.querySelector(${JSON.stringify(sourceReader)})?.textContent.includes('原始协作资料')`)
  await until('mobileProductScene.facts().record.presentation.topics.sources.at(-1)?.content?.trail?.length===1')
  await resize(951, 585); await appearance('light')
  await read(`window.responsiveSourceReader=document.querySelector(${JSON.stringify(sourceReader)});true`)
  await split('Knowledge Source', '.mobile-topics-host:not([hidden]) > .mobile-topics-directory-host', sourceHost)
  await independentScroll('Knowledge Source', '.mobile-topics-host:not([hidden]) > .mobile-topics-directory-host', sourceHost)
  assert.equal(await read(`document.querySelector(${JSON.stringify(sourceReader)}).querySelector('.mobile-topics-workspace')===null`), true)
  await capture('responsive-knowledge-source-951-light')
  const sourceReads = await readCount('file.read')
  for (const [width, height] of [[390, 844], [320, 700], [667, 375], [812, 375], [951, 585]]) {
    await resize(width, height); await rootGeometry(`Source ${width}`)
    assert.equal(await read(`document.querySelector(${JSON.stringify(sourceReader)})===window.responsiveSourceReader`), true)
    assert.equal(await read('!!document.querySelector(".mobile-topics-host:not([hidden]) > .mobile-topics-directory-host").getClientRects().length'), width >= 600)
    if (width === 390) { await appearance('dark'); await capture('responsive-source-390-dark') }
  }
  await safeArea(667,375,'.mobile-topics-host:not([hidden])',false)
  assert.equal(await read('!!document.querySelector(".mobile-topics-host:not([hidden]) > .mobile-topics-directory-host").getClientRects().length'),false)
  await safeArea(812,375,'.mobile-topics-host:not([hidden])',true)
  await split('Source safe-area landscape', '.mobile-topics-host:not([hidden]) > .mobile-topics-directory-host',sourceHost)
  assert.equal(await read(`document.querySelector(${JSON.stringify(sourceReader)})===window.responsiveSourceReader`),true)
  const sourceChrome = await read(`(()=>{const h=document.querySelector(${JSON.stringify(sourceReader)}).querySelector('.mobile-source-header');return {rect:h.getBoundingClientRect().toJSON(),paddingTop:getComputedStyle(h).paddingTop,buttons:[...h.querySelectorAll('button')].map(n=>n.getBoundingClientRect().toJSON())}})()`)
  result.responsiveSafeArea.at(-1).sourceHeader=sourceChrome
  assert.equal(sourceChrome.paddingTop,'24px')
  for(const control of sourceChrome.buttons){assert.ok(control.top>=24);assert.ok(control.width>=44&&control.height>=44)}
  await capture('responsive-source-safe-area-812-dark')
  await clearSafeArea(); await resize(951,585); await flush()
  const sourceReadsAfter=await readCount('file.read')
  result.responsiveReadCounts.push({owner:'original Source file',method:'file.read',before:sourceReads,after:sourceReadsAfter})
  assert.equal(sourceReadsAfter,sourceReads,'Rotation preserves the same original Source reader without another file read')
  await button('返回知识', sourceReader)
  await until(`!document.querySelector(${JSON.stringify(sourceHost)})`)
  await button('继续编辑草稿', knowledge)
  await sameEditor(knowledgeEditor, 'responsiveKnowledgeEditor', knowledgeDraft)

  // A visible directory is an actual navigation surface while Source owns the right pane.
  // Selecting another entry or discussion must leave that Source, without overwriting drafts.
  await button('返回阅读', knowledge)
  await tap(`${knowledge} .mobile-topic-reading:not([hidden]) .mobile-topic-source`, 'Reopen original Source before choosing another entry')
  await until(`document.querySelector(${JSON.stringify(sourceReader)})?.textContent.includes('原始协作资料')`)
  await button('第二周的对照观察', '.mobile-topics-directory-host .mobile-knowledge-directory')
  await until(`!document.querySelector(${JSON.stringify(sourceHost)})&&document.querySelector(${JSON.stringify(knowledge + ' .mobile-topic-reading')})?.textContent.includes('这是另一个准确条目的正文')`)
  assert.equal(await read('mobileProductScene.facts().record.presentation.topics.sources.length'), 0)
  await capture('responsive-source-to-knowledge-951-light')
  await button('第一周的实验依据', `${knowledge} .mobile-knowledge-directory`)
  await until(`document.querySelector(${JSON.stringify(knowledge + ' .mobile-topic-reading')})?.textContent.includes('从一个小实验开始')`)
  await tap(`${knowledge} .mobile-topic-reading:not([hidden]) .mobile-topic-source`, 'Reopen original Source before choosing discussion')
  await until(`document.querySelector(${JSON.stringify(sourceReader)})?.textContent.includes('原始协作资料')`)
  await button('讨论', '.mobile-topics-directory-host .mobile-topics-tabs')
  await until(`!document.querySelector(${JSON.stringify(sourceHost)})&&document.querySelector(${JSON.stringify(topic + ' .mobile-topic-workface:not([hidden]) .mobile-zone-workface')})`)
  await capture('responsive-source-to-discussion-951-light')
  await button('知识', topic)
  await button('第一周的实验依据', `${knowledge} .mobile-knowledge-directory`)
  await button('继续编辑草稿', knowledge)
  await sameEditor(knowledgeEditor, 'responsiveKnowledgeEditor', knowledgeDraft)

  await button('Space', '.mobile-navigation'); await appearance('light')
  await until('!!document.querySelector(".mobile-space-navigation [data-space-id=space-resources]")')
  await split('Space root', '.mobile-spatial-panel:not([hidden]) .mobile-space-navigation', '.mobile-spatial-panel:not([hidden]) .mobile-space-content')
  await capture('responsive-space-root-951-light')
  if (await read('document.querySelector("[data-space-id=space-resources] .mobile-space-row").getAttribute("aria-expanded")!=="true"')) await button('资料工作区', '.mobile-space-navigation')
  await button('BEHAVIOR.md', '.mobile-space-navigation [data-space-id=space-resources]')
  await until('document.querySelector(".mobile-space-content .mobile-region-content")?.textContent.includes("原始协作资料")')
  await read('window.responsiveSpaceFile=document.querySelector(".mobile-space-content .mobile-region-content");true')
  await split('Space exact file', '.mobile-spatial-panel:not([hidden]) .mobile-space-navigation', '.mobile-spatial-panel:not([hidden]) .mobile-space-content')
  await independentScroll('Space exact file', '.mobile-space-navigation', '.mobile-space-content')
  await capture('responsive-space-file-951-light')
  const spaceReads=await readCount('file.read')
  await resize(390, 844); await appearance('dark'); await rootGeometry('Space file 390')
  assert.equal(await read('!!document.querySelector(".mobile-space-navigation").getClientRects().length'), false)
  assert.equal(await read('document.querySelector(".mobile-space-content .mobile-region-content")===window.responsiveSpaceFile'), true)
  await capture('responsive-space-file-390-dark')
  await resize(1024, 768)
  assert.equal(await read('document.querySelector(".mobile-space-content .mobile-region-content")===window.responsiveSpaceFile'), true)
  assert.equal(await read('document.querySelector("[data-space-id=space-resources] .mobile-space-row").getAttribute("aria-expanded")'), 'true')
  const spaceReadsAfter=await readCount('file.read')
  result.responsiveReadCounts.push({owner:'original Space file',method:'file.read',before:spaceReads,after:spaceReadsAfter})
  assert.equal(spaceReadsAfter,spaceReads,'Width changes preserve the original Space file reader without another read')

  await button('Focus', '.mobile-navigation'); await appearance('light')
  await until('document.querySelector(".mobile-focus-pane")?.getAttribute("role")==="main"')
  const groups = await read(`(()=>{const p=document.querySelector('.mobile-focus-projects');return {display:getComputedStyle(p).display,columns:getComputedStyle(p).gridTemplateColumns,groups:[...p.querySelectorAll('.mobile-focus-project')].map(n=>n.getBoundingClientRect().toJSON())}})()`)
  assert.equal(groups.display, 'grid'); assert.ok(groups.groups.length >= 2)
  assert.ok(groups.groups[0].x !== groups.groups[1].x, 'Wide Focus lays out original project groups in separate columns')
  result.responsiveFocusGroups = groups
  await rootGeometry('Focus root 1024'); await capture('responsive-focus-projects-1024-light')
  await safeArea(667,375,'.mobile-focus-facet',false)
  await safeArea(812,375,'.mobile-focus-facet',true)
  await clearSafeArea(); await resize(1024,768); await flush()
  await button('实验建议', '.mobile-focus-pane')
  await until('mobileProductScene.facts().record.selectedSessionId==="session-result"')
  await split('Ordinary Agent', '.mobile-focus-pane', '.mobile-primary-pane')
  assert.notEqual(await read('getComputedStyle(document.querySelector(".mobile-focus-pane .mobile-focus-projects")).display'), 'grid', 'The original 272px Agent sidebar stays one column')
  await capture('responsive-focus-agent-1024-light')
  await tap('.mobile-header [data-mobile-back]', 'Return to the same original Focus root')

  // Leave a real editable original Goal, both full drafts and an unknown local
  // operation for the second OS process. This seed never sends its request.
  await read('mobileProductScene.seedGoalRecovery()')
  await button('Goals', '.mobile-navigation'); await resize(951, 585)
  await until(`document.querySelector(${JSON.stringify(goalEditor)})?.value===${JSON.stringify(goalDraft)}`)
  await sameEditor(goalEditor, 'responsiveGoalEditor', goalDraft)
  const final = await read('mobileProductScene.facts()')
  const originalGoal = final.record.goalDrafts.find(item => item.description === goalDraft), originalKnowledge = final.record.knowledgeDrafts.find(item => item.content === knowledgeDraft)
  assert.ok(originalGoal?.goalId && originalKnowledge?.entryId)
  assert.ok(final.record.goalOperationRecords?.some(item => item.request.operationId === 'original-goal-operation'))
  assert.equal(await read('document.querySelector(".mobile-conversation-panel [contenteditable=true]")===window.responsiveComposer'), true)
  assert.equal(await read('document.querySelector(".mobile-conversation__reading")===window.responsiveReading'), true)
  assert.ok(final.record.conversation.drafts.some(([, text]) => text === conversationDraft))
  result.responsiveOriginal = { recordId: final.record.recordId, goalKey: { goalId: originalGoal.goalId, scope: originalGoal.scope }, knowledgeKey: final.record.presentation.topics.knowledge.draftKey, knowledgeEntryId: originalKnowledge.entryId, record: final.record, sessionIds: final.sessionIds }
  await noBusiness()
  result.responsiveBoundary = 'Actual MobileApp, original five primary owners and controlled public SDK leaves; geometry/pointer/scroll and retained real editing nodes. Same userData must be restarted by the parent capture in two distinct private Electron OS processes. No installed App/user Browser/real Session operation; no aesthetic verdict and no physical-device claim.'
}
