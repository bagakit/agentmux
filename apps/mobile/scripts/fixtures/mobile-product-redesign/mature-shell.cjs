const assert = require('node:assert/strict')
// The confirmed mature shell: five-tab bar, header menu, needs-you Focus home and 64px rows,
// exercised through the actual MobileApp with controlled original catalog facts.
module.exports = async ({ read, until, resize, tap, button, capture, result }) => {
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
  for (const choice of card.choices) assert.ok(choice.rect.height >= 40 && choice.rect.right <= card.card.right, 'Choices are thumb-sized and inside the card')
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
  await button('Space', '.mobile-navigation'); await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  // One tap from the needs-you strip opens the exact waiting request.
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  await tap('.mobile-needs-you-ticket', 'Needs-you ticket')
  await until('!!document.querySelector("[data-request-id=request-next]")')
  assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-waiting', 'The ticket opens the exact waiting Agent')
  // The push motion is navigation-declared; measure the settled layer, not a frame mid-slide.
  assert.equal(await read('document.querySelector(".mobile-main")?.dataset.motion'), 'push', 'Opening the request pushed the conversation layer')
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
  result.matureShellBoundary = 'Actual MobileApp shell with controlled original catalog facts in private Chromium; physical phone, OS keyboard and live Host are not observed.'
}
