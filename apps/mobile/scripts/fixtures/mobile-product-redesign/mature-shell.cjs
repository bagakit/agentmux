const assert = require('node:assert/strict')
// The confirmed mature shell: five-tab bar, header menu, needs-you Focus home and 64px rows,
// exercised through the actual MobileApp with controlled original catalog facts.
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareFocusState()')
  await button('Focus', '.mobile-navigation')
  await until('document.querySelectorAll(".mobile-focus-project .mobile-agent-row").length >= 3')
  result.matureShell = []
  for (const [width, height] of [[390, 844], [320, 760]]) for (const appearance of ['dark', 'light']) {
    await resize(width, height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const facts = await read(`(()=>{
      const r=n=>n?n.getBoundingClientRect().toJSON():null
      const tabs=[...document.querySelectorAll('.mobile-navigation button')]
      const header=document.querySelector('.mobile-spatial-panel .mobile-page-header')
      const rows=[...document.querySelectorAll('.mobile-focus-project .mobile-agent-row__open')]
      return {tabs:tabs.map(t=>({label:t.getAttribute('aria-label'),rect:r(t)})),menuInBar:!!document.querySelector('.mobile-navigation-bar [aria-label="手机设置与连接"]'),
        menuLeadsHeader:header?.firstElementChild?.getAttribute('aria-label')==='手机设置与连接',title:getComputedStyle(header.querySelector('h1')).fontSize,
        rowHeights:rows.map(n=>Math.round(n.getBoundingClientRect().height)),nameSize:rows[0]&&getComputedStyle(rows[0].querySelector('.mobile-row-title strong')).fontSize,
        strip:!!document.querySelector('.mobile-needs-you'),overflow:document.querySelector('.mobile-app').scrollWidth>document.querySelector('.mobile-app').clientWidth}
    })()`)
    assert.deepEqual(facts.tabs.map(tab => tab.label), ['Goals', 'Topics', 'Mote', 'Focus', 'Space'])
    assert.equal(facts.menuInBar, false, 'The tab bar holds only the five workfaces')
    assert.equal(facts.menuLeadsHeader, true, 'The menu leads the directory header')
    const widths = facts.tabs.map(tab => Math.round(tab.rect.width))
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, 'Five equal tabs')
    const mote = facts.tabs[2].rect, centre = mote.left + mote.width / 2
    assert.ok(Math.abs(centre - width / 2) <= 8, 'Mote is centred')
    assert.equal(facts.title, '24px'); assert.equal(facts.nameSize, '15px')
    for (const height of facts.rowHeights) assert.ok(height >= 64, 'Rows keep the 64px rhythm')
    assert.equal(facts.overflow, false)
    result.matureShell.push({ width, height, appearance, facts })
    await capture(`mature-focus-${width}-${appearance}`)
  }
  await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
  // The platform marks the root while the soft keyboard is up; the browser's own cascade must fold the tab bar away.
  const keyboard = await read(`(()=>{const root=document.documentElement,original=root.dataset.browserKeyboard,display=()=>getComputedStyle(document.querySelector('.mobile-navigation-bar')).display
    root.dataset.browserKeyboard='shown';const shown=display();root.dataset.browserKeyboard='hidden';const hidden=display()
    if(original===undefined)delete root.dataset.browserKeyboard;else root.dataset.browserKeyboard=original;return {shown,hidden}})()`)
  assert.deepEqual(keyboard, { shown: 'none', hidden: 'block' }, 'The soft keyboard folds the tab bar away and restores it afterwards')
  result.operations.push({ action: 'tab-bar-soft-keyboard', ...keyboard })
  await tap('.mobile-spatial-panel .mobile-page-header [aria-label="手机设置与连接"]', 'Header menu')
  await until('!!document.querySelector(".mobile-drawer")')
  await capture('mature-drawer-390-dark')
  await tap('[aria-label="关闭面板"]', 'Close drawer')
  // A permission that fits one tap answers on the card, through the same original request and Core receipt.
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-card .mobile-ticket-answer__choices button")')
  const card = await read(`(()=>{const c=document.querySelector('.mobile-needs-you-card'),r=n=>n?n.getBoundingClientRect().toJSON():null
    const choices=[...c.querySelectorAll('.mobile-ticket-answer__choices button')]
    return {card:r(c),title:c.querySelector('.mobile-ticket-answer__title')?.textContent,choices:choices.map(b=>({label:b.textContent,primary:b.classList.contains('is-primary'),rect:r(b)}))}})()`)
  result.matureTicketAnswer = { card }
  assert.equal(card.title, '请确认本次资料读取')
  assert.deepEqual(card.choices.map(choice => [choice.label, choice.primary]), [['允许本次读取', true], ['拒绝本次读取', false]])
  for (const choice of card.choices) assert.ok(choice.rect.height >= 44 && choice.rect.right <= card.card.right, 'Choices are thumb-sized and inside the card')
  await capture('mature-ticket-answer-390-dark')
  await tap('.mobile-needs-you-card .mobile-ticket-answer__choices button.is-primary', 'Allow on the ticket')
  await until('document.querySelector(".mobile-ticket-answer")?.dataset.phase==="confirmed"')
  const answers = await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.respondAgentInteraction").map(call=>call.params)')
  assert.equal(answers.length, 1, 'One tap sends exactly one answer')
  assert.deepEqual(answers[0].response, { kind: 'permission', requestId: 'request-original', decision: { outcome: 'selected', optionId: 'allow-original' } })
  assert.equal(answers[0].agentSessionId, 'session-waiting')
  await capture('mature-ticket-answered-390-dark')
  await read('mobileProductScene.settleWaitingAnswer()')
  // The shell reads the directory after a confirmed answer; the strip leaves once that read lands.
  await until('!document.querySelector(".mobile-needs-you")')
  assert.equal(await read('document.querySelector(".mobile-navigation .mobile-tab-badge")'), null, 'The count clears once Core settles the request')
  await read('mobileProductScene.restoreWaitingRequest()')
  // The shared root catalog deliberately has one reader across directory tabs. Request its original
  // read explicitly instead of relying on the removed duplicate attention poll during Space/Focus.
  await button('刷新空间目录', '.mobile-spatial-panel')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  // One tap from the needs-you strip opens the exact waiting request.
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  await tap('.mobile-needs-you-ticket', 'Needs-you ticket')
  await until('!!document.querySelector("[data-request-id=request-next]")')
  assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-waiting', 'The ticket opens the exact waiting Agent')
  // The push motion is navigation-declared; measure the settled layer, not a frame mid-slide.
  assert.equal(await read('document.querySelector(".mobile-main")?.dataset.motion'), 'push', 'Opening the request pushed the conversation layer')
  const firstPush = await read(`(()=>{const main=document.querySelector('.mobile-main');return {kind:main.dataset.motion,phase:main.dataset.motionPhase,animation:getComputedStyle(main).animationName}})()`)
  await tap('.mobile-conversation__goal', 'Goals from the original conversation')
  await until('!!document.querySelector(".mobile-goal-panel:not([hidden])")')
  const secondPush = await read(`(()=>{const main=document.querySelector('.mobile-main');return {kind:main.dataset.motion,phase:main.dataset.motionPhase,animation:getComputedStyle(main).animationName}})()`)
  assert.equal(secondPush.kind, 'push', 'Conversation Goal callback declares its push')
  assert.notEqual(secondPush.phase, firstPush.phase, 'Consecutive pushes advance the original motion phase')
  assert.notEqual(secondPush.animation, firstPush.animation, 'The actual loaded stylesheet consumes the phase to restart its animation')
  assert.match(firstPush.animation, /^mobile-screen-push/)
  assert.match(secondPush.animation, /^mobile-screen-push/)
  result.matureConsecutiveMotion = { firstPush, secondPush }
  await button('返回对话', '.mobile-header')
  await until('!document.querySelector(".mobile-goal-panel:not([hidden])")')
  assert.equal(await read('document.querySelector(".mobile-main")?.dataset.motion'), 'pop', 'Goal returns through the same Back owner')
  await until('!document.querySelector(".mobile-main[data-motion]")')
  const reading = await read(`(()=>{const r=n=>n?n.getBoundingClientRect().toJSON():null
    const turns=[...document.querySelectorAll('.mobile-conversation .log-turn[data-message-bubble="true"]')]
    const last=turns.at(-1),composer=document.querySelector('.mobile-conversation__composer'),card=document.querySelector('[data-request-id=request-next]')
    return {turns:turns.map(n=>({role:n.dataset.speakerRole,rect:r(n),body:r(n.querySelector('.log-turn__body'))})),composer:r(composer),card:r(card),lastBottom:last?r(last).bottom:null,
      who:turns.map(n=>n.querySelector('.log-turn__who')?.textContent)}})()`)
  result.matureReading = { reading }
  const bodies = reading.turns.map(turn => Math.round(turn.body.left))
  const agentBodies = reading.turns.filter(turn => turn.role === 'agent').map(turn => Math.round(turn.body.left))
  assert.ok(new Set(agentBodies).size <= 1, 'Agent speech shares one reading column')
  for (const turn of reading.turns) assert.ok(turn.rect.left >= 15 && turn.rect.right <= 390 - 15, `Every message keeps the 16px gutter: ${JSON.stringify(turn.rect)}`)
  assert.ok((reading.card ? reading.card.top : reading.composer.top) - reading.lastBottom <= 48, 'Short conversation rests on the decision card and composer')
  assert.ok(!reading.who.includes('You'), 'The person reads as 我')
  const overlap = await read(`(()=>{const n=[...document.querySelectorAll('.mobile-conversation .log-turn[data-message-bubble="true"][data-speaker-role="human"]')].at(-1);if(!n)return null
    const body=n.querySelector('.log-turn__body').getBoundingClientRect(),actions=[...n.querySelectorAll('.log-turn__head button')].map(b=>b.getBoundingClientRect())
    const head=n.querySelector('.log-turn__head').getBoundingClientRect()
    return {hit:actions.some(a=>a.top<body.bottom-2&&a.bottom>body.top+2&&a.left<body.right-2&&a.right>body.left+2),body:body.toJSON(),head:head.toJSON(),actions:actions.map(a=>a.toJSON()),
      rows:getComputedStyle(n).gridTemplateRows,bodyRow:getComputedStyle(n.querySelector('.log-turn__body')).gridRowStart,headRow:getComputedStyle(n.querySelector('.log-turn__head')).gridRowStart}})()`)
  result.matureBubble = overlap
  assert.equal(overlap.hit, false, "Copy and details never cover the person's text")
  result.matureReading = { bodies, reading }
  await capture('mature-request-390-dark')
  await read('mobileProductScene.setAppearance("light")'); await capture('mature-request-390-light')
  await read('mobileProductScene.setAppearance("dark")')
  await tap('.mobile-header .mobile-session-view-toggle', 'Terminal toggle')
  await until('!!document.querySelector(".mobile-terminal-panel:not([hidden])")')
  await read('new Promise(resolve=>setTimeout(resolve,300))')
  await capture('mature-terminal-390-dark')
  await tap('.mobile-header .mobile-session-view-toggle', 'Conversation toggle')
  await tap('.mobile-session-origin', 'Back')
  await until('!!document.querySelector(".mobile-spatial-panel:not([hidden]) .mobile-page-header")')
  for (const label of ['Goals', 'Topics', 'Mote', 'Space']) {
    await button(label, '.mobile-navigation')
    await read('new Promise(resolve=>setTimeout(resolve,250))')
    await until('!document.querySelector(".mobile-main[data-motion]")')
    if (label === 'Mote') {
      const gap = await read(`(()=>{const turns=[...document.querySelectorAll('.mobile-conversation .log-turn[data-message-bubble="true"]')].filter(n=>n.getClientRects().length),composer=document.querySelector('.mobile-conversation__composer');return turns.length&&composer?composer.getBoundingClientRect().top-turns.at(-1).getBoundingClientRect().bottom:null})()`)
      result.matureMoteGap = gap
      assert.ok(gap !== null && gap <= 48, `A short Mote discussion rests on the composer (gap ${gap})`)
    }
    await capture(`mature-${label.toLowerCase()}-390-dark`)
  }
  // A lost attention observation changes the count's presentation, preserving the current workface.
  await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  await tap('.mobile-needs-you-ticket', 'Open the original waiting Agent for attention recovery')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  await until('!document.querySelector(".mobile-main[data-motion]")')
  await read(`window.matureAttentionEditor=document.querySelector('.mobile-conversation-panel:not([hidden]) [contenteditable=true]');matureAttentionEditor.focus()`)
  await win.webContents.insertText('保留这段未发送的讨论，核对需要你列表。')
  await until('mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text.includes("保留这段未发送的讨论"))')
  const originalAttention = await read(`(()=>{const f=mobileProductScene.facts();return {sid:f.record.selectedSessionId,
    run:f.sessionIds.find(value=>value.sessionId===f.record.selectedSessionId),conversation:f.record.conversation,
    effects:f.calls.filter(call=>['sdk.submitAgentPrompt','sdk.respondAgentInteraction','agent.open','file.upload'].includes(call.method)).length}})()`)
  await read('mobileProductScene.setDirectoryReadFailure(true);document.dispatchEvent(new Event("visibilitychange"))')
  // A conversation has no tab bar; Back carries the unconfirmed list until the person returns to a directory.
  await until('document.querySelector(".mobile-header [data-mobile-back] .mobile-back-badge[data-unconfirmed]")?.textContent==="?"&&!!document.querySelector(".mobile-attention-notice")')
  const attentionCollapsed = await read(`(()=>{const back=document.querySelector('.mobile-header [data-mobile-back]'),notice=document.querySelector('.mobile-attention-notice');return {
    bar:!!document.querySelector('.mobile-navigation'),back:back.querySelector('.mobile-back-badge')?.textContent,description:back.getAttribute('aria-description'),
    summary:notice.querySelector('.mobile-text-button')?.textContent,technicalVisible:notice.innerText.includes('DIRECTORY_READ_FAILED')}})()`)
  assert.equal(attentionCollapsed.bar, false); assert.equal(attentionCollapsed.back, '?')
  assert.ok(attentionCollapsed.description.includes('尚未确认')); assert.equal(attentionCollapsed.technicalVisible, false)
  await capture('mature-attention-unconfirmed-390-dark')
  await resize(320, 480); await read('mobileProductScene.setAppearance("light")')
  const attentionWorkface = await read(`(()=>{const stack=document.querySelector('.mobile-notice-stack'),main=document.querySelector('.mobile-main'),editor=matureAttentionEditor,send=document.querySelector('.mobile-conversation-panel:not([hidden]) .composer-send');
    const r=n=>n.getBoundingClientRect().toJSON(),hit=n=>{const q=n.getBoundingClientRect(),target=document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);return target===n||n.contains(target)};return {stack:r(stack),main:r(main),editor:r(editor),send:r(send),editorHit:hit(editor),sendHit:hit(send)}})()`)
  assert.ok(attentionWorkface.editor.height >= 24 && attentionWorkface.send.height >= 44, 'The original editor and Send remain usable')
  assert.ok(attentionWorkface.editor.bottom <= attentionWorkface.main.bottom + .5 && attentionWorkface.send.bottom <= attentionWorkface.main.bottom + .5, 'The full editor and Send stay above every reminder')
  assert.equal(attentionWorkface.editorHit, true, 'The retained editor is the actual hit target')
  assert.equal(attentionWorkface.sendHit, true, 'The original Send control is the actual hit target')
  assert.ok(attentionWorkface.stack.height <= 480 * .12 + 1, 'All reminders share one bounded short-phone scroller')
  await tap('.mobile-attention-notice .mobile-text-button', 'Open the original attention read explanation')
  await until('!!document.querySelector(".mobile-attention-details")')
  await read('Promise.all(document.querySelector(".mobile-attention-details").getAnimations().map(animation=>animation.finished))')
  await tap('.mobile-attention-details .mobile-directory-technical > summary', 'Read the original attention failure')
  const attentionExpanded = await read(`(()=>{const sheet=document.querySelector('.mobile-attention-details'),retry=sheet.querySelector('.mobile-text-button'),close=sheet.querySelector('[aria-label="关闭需要你列表信息"]'),r=n=>n.getBoundingClientRect().toJSON();return {sheet:r(sheet),retry:r(retry),close:r(close),text:sheet.innerText,overflow:document.querySelector('.mobile-app').scrollWidth>innerWidth}})()`)
  assert.ok(attentionExpanded.text.includes('DIRECTORY_READ_FAILED'), 'Complete original failure is readable in its named technical details')
  assert.ok(attentionExpanded.sheet.top >= 0 && attentionExpanded.sheet.bottom <= 481, 'The original detail sheet fits the short phone')
  assert.ok(attentionExpanded.retry.height >= 44 && attentionExpanded.close.width >= 44 && attentionExpanded.close.height >= 44, 'Named retry and close keep their complete touch targets')
  assert.equal(attentionExpanded.overflow, false)
  await capture('mature-attention-details-320-short-light')
  await read('mobileProductScene.setDirectoryReadFailure(false)')
  await button('重新读取需要你列表', '.mobile-attention-details')
  await until('!document.querySelector(".mobile-attention-details")&&!document.querySelector(".mobile-attention-notice")&&!document.querySelector(".mobile-header .mobile-back-badge[data-unconfirmed]")')
  const recoveredAttention = await read(`(()=>{const f=mobileProductScene.facts();return {sid:f.record.selectedSessionId,
    run:f.sessionIds.find(value=>value.sessionId===f.record.selectedSessionId),conversation:f.record.conversation,
    sameEditor:document.querySelector('.mobile-conversation-panel:not([hidden]) [contenteditable=true]')===matureAttentionEditor,
    effects:f.calls.filter(call=>['sdk.submitAgentPrompt','sdk.respondAgentInteraction','agent.open','file.upload'].includes(call.method)).length}})()`)
  assert.equal(recoveredAttention.sameEditor, true)
  assert.equal(recoveredAttention.sid, originalAttention.sid); assert.deepEqual(recoveredAttention.run, originalAttention.run)
  assert.deepEqual(recoveredAttention.conversation, originalAttention.conversation)
  assert.equal(recoveredAttention.effects, originalAttention.effects, 'Read recovery sends no input, answer, upload or creation')
  result.matureAttentionRecovery = { original: originalAttention, collapsed: attentionCollapsed, workface: attentionWorkface, expanded: attentionExpanded, recovered: recoveredAttention }
  result.matureShellBoundary = 'Actual MobileApp shell with controlled original catalog facts in private Chromium; physical phone, OS keyboard and live Host are not observed.'
}
