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
  await read('Promise.all(document.querySelector(".mobile-drawer").getAnimations().map(animation=>animation.finished))')
  result.matureDrawer = []
  for (const [width, height] of [[390, 844], [320, 760]]) for (const appearance of ['dark', 'light']) {
    await resize(width, height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    // The connection card leads the drawer: brand, Mac address and the status dot, a full-width touch target.
    const drawer = await read(`(()=>{const d=document.querySelector('.mobile-drawer'),r=n=>n?n.getBoundingClientRect().toJSON():null
      const groups=[...d.children].filter(n=>!n.matches('.mobile-sheet-handle, .mobile-sheet-title, #mobile-sheet-description')),card=groups[0]
      const dot=card?.querySelector('.mobile-status-dot'),address=card?.querySelector('.mobile-drawer-connection__address')
      return {first:card?.className,drawer:r(d),card:r(card),icon:r(card?.querySelector('img.brand-icon')),dot:r(dot),dotColor:dot&&getComputedStyle(dot).backgroundColor,
        address:address?.textContent,addressClipped:address?address.scrollWidth>address.clientWidth+1:null,state:card?.querySelector('.mobile-drawer-connection__state')?.textContent,
        rows:[...d.querySelectorAll('.mobile-menu-row, .mobile-home-select')].map(n=>({text:n.innerText.split('\\n')[0],rect:r(n)})),overflow:d.scrollWidth>d.clientWidth}})()`)
    assert.equal(drawer.first, 'mobile-drawer-connection', 'The connection card is the first drawer group')
    assert.ok(drawer.card.height >= 64 && drawer.card.left >= drawer.drawer.left && drawer.card.right <= drawer.drawer.right, `Card fits the drawer: ${JSON.stringify(drawer.card)}`)
    assert.ok(drawer.icon && drawer.icon.width >= 32 && drawer.dot && drawer.dot.width >= 6, 'Brand and status dot are drawn')
    assert.equal(drawer.state, '已连接')
    assert.deepEqual(drawer.rows.map(row => row.text), ['Survey', '默认目录', '提醒与诊断'], 'Survey, the default directory and diagnostics stay reachable')
    for (const row of drawer.rows) assert.ok(row.rect.height >= 44, 'Drawer rows keep the touch target')
    assert.equal(drawer.overflow, false)
    result.matureDrawer.push({ width, height, appearance, drawer })
    await capture(`mature-drawer-${width}-${appearance}`)
  }
  await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
  await tap('.mobile-drawer-connection', 'Connection card')
  await until('[...document.querySelectorAll(".mobile-sheet .mobile-sheet-title h2")].some(n=>n.textContent==="连接与设备")')
  await tap('[aria-label="关闭面板"]', 'Close connection and devices')
  await until('!document.querySelector("[role=dialog]")')
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
  result.matureReading = { bodies, reading }
  // Touch has no hover: copy and details stay out of the reading until a message is chosen.
  const messageControls = () => read(`(()=>{const r=n=>n.getBoundingClientRect(),hit=n=>{const q=r(n);if(!q.width||!q.height)return false;const t=document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);return t===n||n.contains(t)}
    const turns=[...document.querySelectorAll('.mobile-conversation-panel:not([hidden]) .log-turn[data-message-bubble="true"]')]
    return {hoverNone:matchMedia('(hover: none)').matches,turns:turns.map(n=>{const controls=[...n.querySelectorAll(':scope > .log-turn__head :is(.log-turn__action, .conversation-input-details__toggle)')],body=n.querySelector(':scope > .log-turn__body'),b=r(body)
      return {role:n.dataset.speakerRole,target:n.dataset.captureTarget??null,revealed:n.hasAttribute('data-actions-revealed'),copyState:n.querySelector(':scope > .log-turn__head .log-turn__actions')?.dataset.copyState??null,
        controls:controls.length,shown:controls.filter(hit).length,focusable:controls.every(c=>c.tabIndex===0&&!c.disabled),rect:r(n).toJSON(),body:b.toJSON(),
        covered:controls.filter(hit).some(c=>{const a=r(c);return a.top<b.bottom-2&&a.bottom>b.top+2&&a.left<b.right-2&&a.right>b.left+2})}})}})()`)
  const person = turn => turn.role === 'human' || turn.role === 'external'
  const rest = await messageControls()
  assert.equal(rest.hoverNone, true, 'CDP touch emulation makes the page a no-hover device')
  assert.ok(rest.turns.some(person) && rest.turns.some(turn => !person(turn) && turn.controls > 0), 'The reading has both a person bubble and an Agent message with controls')
  for (const turn of rest.turns.filter(person)) {
    assert.equal(turn.shown, 0, "The person's bubble carries no icon row at rest")
    assert.ok(turn.rect.height - turn.body.height <= 22, "The person's bubble keeps no empty icon row at rest")
  }
  for (const turn of rest.turns) {
    assert.equal(turn.shown, 0, `An unchosen message shows no copy or details icons on touch: ${JSON.stringify(turn)}`)
    assert.equal(turn.focusable, true, 'Hidden copy and details stay in the keyboard order')
  }
  const decision = await read(`(()=>{const r=n=>n.getBoundingClientRect().toJSON(),actions=document.querySelector('[data-request-id=request-next] .agent-interaction__actions'),dismiss=actions.querySelector('.agent-interaction__dismiss')
    const status=[...document.querySelectorAll('.mobile-conversation-panel:not([hidden]) .mobile-send-status[data-original-response]')].filter(n=>!n.closest('.agent-interaction')).at(-1),line=status?.querySelector('.mobile-send-status__line')
    return {dismiss:{rect:r(dismiss),background:getComputedStyle(dismiss).backgroundColor},verdicts:[...actions.querySelectorAll(':scope > button:not(.agent-interaction__dismiss)')].map(b=>({primary:b.classList.contains('is-primary'),rect:r(b)})),
      status:status&&line?{rect:r(status),line:r(line),text:line.textContent,truncated:line.scrollWidth>line.clientWidth}:null}})()`)
  result.matureDecision = decision
  assert.ok(decision.verdicts.length >= 2, 'The request card offers its verdicts')
  const verdictsByPlace = [...decision.verdicts].sort((a, b) => a.rect.left - b.rect.left)
  assert.equal(verdictsByPlace[0].primary, true, 'The main verdict leads the row as Primary')
  for (const verdict of decision.verdicts) {
    assert.ok(verdict.rect.height >= 44, 'Verdicts are thumb-sized')
    assert.ok(Math.abs(verdict.rect.top - decision.verdicts[0].rect.top) <= 1, 'Verdicts share one row')
  }
  assert.ok(decision.dismiss.rect.height >= 44, 'Dismiss keeps a 44px touch target')
  assert.ok(decision.dismiss.rect.top >= Math.max(...decision.verdicts.map(verdict => verdict.rect.bottom)), 'Dismiss sits apart from the verdicts, on its own row')
  assert.equal(decision.dismiss.background, 'rgba(0, 0, 0, 0)', 'Dismiss reads as a text action, not a third verdict')
  assert.ok(decision.status, 'The answered request keeps its reply status in the conversation')
  const gutter = Math.min(...reading.turns.map(turn => turn.rect.left))
  assert.ok(decision.status.rect.height <= 48 && decision.status.truncated === false, `The kept reply status is one complete line: ${JSON.stringify(decision.status)}`)
  assert.ok(Math.abs(decision.status.line.left - gutter) <= 1, 'The kept reply status starts on the reading gutter')
  await capture('mature-request-390-dark')
  await read('mobileProductScene.setAppearance("light")'); await capture('mature-request-390-light')
  await read('mobileProductScene.setAppearance("dark")')
  // Choosing a message by tap, keyboard focus, an open details panel or a copy result shows its controls.
  await read(`(()=>{const turns=[...document.querySelectorAll('.mobile-conversation-panel:not([hidden]) .log-turn[data-message-bubble="true"]')]
    turns.findLast(n=>n.dataset.speakerRole==='human').dataset.captureTarget='person';const agent=turns.findLast(n=>n.dataset.speakerRole==='agent');agent.dataset.captureTarget='agent'
    agent.querySelector(':scope > .log-turn__head .log-turn__action').dataset.captureControl='agent-copy';agent.querySelector(':scope > .log-turn__head .conversation-input-details__toggle').dataset.captureControl='agent-details'})()`)
  const chosen = async target => (await messageControls()).turns.find(turn => turn.target === target)
  await tap('[data-capture-target=person]', "Choose the person's message")
  const personChosen = await chosen('person')
  assert.ok(personChosen.revealed && personChosen.shown > 0, "A tap shows the person's copy and details")
  assert.equal(personChosen.covered, false, "Copy and details never cover the person's text")
  assert.ok(personChosen.rect.right <= 390 - 15, "The chosen person's bubble keeps the 16px gutter")
  await tap('[data-capture-target=agent]', 'Choose the Agent message')
  assert.equal((await chosen('person')).shown, 0, 'Choosing another message hides the previous controls')
  assert.ok((await chosen('agent')).shown > 0, 'The chosen Agent message shows its controls')
  await tap('[data-capture-control=agent-copy]', 'Copy the Agent message')
  await tap('[data-capture-target=person]', "Choose the person's message while copy reports")
  const copying = await chosen('agent')
  assert.ok(copying.copyState !== 'idle' && copying.shown > 0, `A copy result stays visible after choosing elsewhere: ${copying.copyState}`)
  await until(`document.querySelector('[data-capture-control=agent-copy]').closest('.log-turn__actions').dataset.copyState==='idle'`)
  assert.equal((await chosen('agent')).shown, 0, 'Controls leave once the copy result ends')
  await tap('[data-capture-target=agent]', 'Choose the Agent message again')
  await tap('[data-capture-control=agent-details]', 'Open the Agent message details')
  await tap('[data-capture-target=person]', "Choose the person's message with details open")
  assert.ok((await chosen('agent')).shown > 0, 'Open details keep their toggle visible')
  await capture('mature-reading-chosen-390-dark')
  await tap('[data-capture-control=agent-details]', 'Close the Agent message details')
  await tap('[data-capture-target=person]', "Put the person's message down")
  const keyboardFocus = await read(`(()=>{const c=document.querySelector('[data-capture-control=agent-copy]');c.focus();const q=c.getBoundingClientRect(),t=document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);const facts={focused:document.activeElement===c,shown:t===c||c.contains(t)};c.blur();return facts})()`)
  assert.deepEqual(keyboardFocus, { focused: true, shown: true }, 'Keyboard focus reaches and shows the hidden copy action')
  for (const turn of (await messageControls()).turns) assert.equal(turn.shown, 0, 'Every message returns to rest')
  result.matureMessageControls = { rest, personChosen, copying, keyboardFocus }
  await tap('.mobile-header .mobile-session-view-toggle', 'Terminal toggle')
  await until('!!document.querySelector(".mobile-terminal-panel:not([hidden]) .mobile-terminal[data-reading=reading]")&&document.querySelectorAll(".mobile-terminal-canvas .xterm-rows > div").length>0')
  await until('!document.querySelector(".mobile-main[data-motion]")')
  const terminalCost = () => read('mobileProductScene.facts().calls.filter(call=>["sdk.resizeAgent","sdk.writeAgent","sdk.reattachAgent"].includes(call.method)).map(call=>call.method)')
  const terminalGrid = `(()=>{const screen=document.querySelector('.mobile-terminal-canvas .xterm-screen')
    return {rows:document.querySelectorAll('.mobile-terminal-canvas .xterm-rows > div').length,screen:{width:Math.round(screen.getBoundingClientRect().width),height:Math.round(screen.getBoundingClientRect().height)},
      first:document.querySelector('.mobile-terminal-canvas .xterm-rows > div')?.textContent}})()`
  const originalGrid = await read(terminalGrid), originalCost = await terminalCost()
  result.matureTerminal = []
  for (const [width, height] of [[390, 844], [320, 760]]) for (const appearance of ['dark', 'light']) {
    await resize(width, height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    // One header, then exactly one toolbar row, then the output; no Mote context strip or explanation row.
    const geometry = await read(`(()=>{const r=n=>n?n.getBoundingClientRect().toJSON():null,shown=n=>n.getClientRects().length>0
      const header=document.querySelector('.mobile-header'),section=document.querySelector('.mobile-terminal-panel:not([hidden]) .mobile-terminal'),canvas=section.querySelector('.mobile-terminal-canvas')
      const kids=[...section.children],above=kids.slice(0,kids.indexOf(canvas)).filter(shown),toolbar=section.querySelector('.mobile-terminal-toolbar')
      const chrome=[...document.querySelector('.mobile-app').children].filter(n=>shown(n)&&!n.matches('.mobile-main, .mobile-notice-stack'))
      return {header:r(header),toolbar:r(toolbar),canvas:r(canvas),above:above.map(n=>n.className),chrome:chrome.map(n=>n.className),strip:!!document.querySelector('.mobile-mote-context'),
        mode:toolbar.querySelector('.mobile-terminal-mode-state')?.textContent,state:r(toolbar.querySelector('.mobile-terminal-mode-state')),
        buttons:[...toolbar.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label')??b.textContent,rect:r(b)})),overflow:document.querySelector('.mobile-app').scrollWidth>innerWidth}})()`)
    assert.equal(geometry.strip, false, 'The terminal carries no Mote context strip')
    assert.deepEqual(geometry.chrome.map(name => name.includes('mobile-header--session')), [true], 'Only the conversation header sits above the terminal')
    assert.deepEqual(geometry.above, ['mobile-terminal-toolbar'], 'Exactly one toolbar row precedes the output')
    assert.ok(Math.abs(geometry.toolbar.top - geometry.header.bottom) <= 1 && Math.abs(geometry.canvas.top - geometry.toolbar.bottom) <= 1, `Header, toolbar and output stack without a gap: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.toolbar.height <= 46, 'The toolbar is one 44px row')
    assert.ok(geometry.mode.startsWith('只读查看'), 'Watching is named as read-only')
    for (const control of geometry.buttons) assert.ok(control.rect.height >= 44 && control.rect.width >= 44 && control.rect.right <= width + .5, `Toolbar control fits as a touch target: ${JSON.stringify(control)}`)
    assert.ok(geometry.state.width > 40, 'The mode state keeps readable room')
    assert.equal(geometry.overflow, false)
    // Local layout height changes leave the original Run grid and its reading as they were.
    const grid = await read(terminalGrid)
    assert.ok(grid.rows === originalGrid.rows && grid.screen.width === originalGrid.screen.width && grid.screen.height === originalGrid.screen.height, `The Run grid is not refitted to the local layout: ${JSON.stringify(grid)}`)
    result.matureTerminal.push({ width, height, appearance, geometry })
    await capture(`mature-terminal-${width}-${appearance}`)
  }
  await resize(390, 844); await read('mobileProductScene.setAppearance("dark")')
  assert.ok(originalGrid.rows === 40 && !originalGrid.first.includes('pnpm'), `The captured Run keeps its 40-row grid with history above: ${JSON.stringify(originalGrid)}`)
  // Read upward with a real touch drag on the output, as a thumb does.
  const start = await read(`(()=>{const r=document.querySelector('.mobile-terminal-canvas').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+60)}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
  for (let step = 1; step <= 12; step++) await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + step * 40, id: 1 }] })
  await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await until(`document.querySelector('.mobile-terminal-canvas .xterm-rows > div')?.textContent.includes('pnpm')`)
  for (const [width, height] of [[390, 640], [320, 760], [390, 844]]) {
    await resize(width, height)
    const grid = await read(terminalGrid)
    assert.equal(grid.rows, originalGrid.rows, 'A different phone viewport keeps the original row count')
    assert.deepEqual(grid.screen, originalGrid.screen, 'The xterm grid is not refitted to the local layout')
    assert.ok(grid.first.includes('pnpm'), 'The reading position above the live output survives the layout change')
  }
  assert.deepEqual(await terminalCost(), originalCost, 'Reading and layout changes send no resize, input or second attachment')
  result.matureTerminalReading = { originalGrid, cost: originalCost }
  await capture('mature-terminal-history-390-dark')
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

    if (label === 'Space') {
      for (const width of [320, 390]) {
        await resize(width, 760)
        const trigger = '.mobile-page-header .mobile-avatar-notice > .mobile-notice__body > details > summary'
        await tap(trigger, 'Read original appearance issues from the header')
        const notice = await read(`(()=>{const n=document.querySelector('.mobile-page-header .mobile-avatar-notice__list'),r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,originals:n.querySelectorAll('.mobile-avatar-notice__item').length,footer:!!document.querySelector('.mobile-notice-stack .mobile-avatar-notice')}})()`)
        assert.ok(notice.left >= 0 && notice.right <= width && notice.top >= 0 && notice.bottom <= 760, 'Original appearance details fit the phone')
        assert.ok(notice.originals > 0); assert.equal(notice.footer, false)
        await capture(`mature-space-appearance-${width}-dark`)
        await tap(trigger, 'Fold original appearance details')
      }
      await resize(390, 844)
    }
    if (label === 'Goals') {
      const entry = await read(`(()=>{const h=document.querySelector('.mobile-goals .mobile-page-header'),b=h.querySelector('[aria-label="新建目标"]');return {create:!!b,hit:b?.getBoundingClientRect().height,lookup:!!h.querySelector('.mobile-goal-lookup'),firstRow:!!document.querySelector('.mobile-goal-create__form:not([hidden])')}})()`)
      assert.equal(entry.create, true); assert.ok(entry.hit >= 44); assert.equal(entry.lookup, true); assert.equal(entry.firstRow, false)
      await tap('.mobile-goals-new', 'New Goal from the header')
      await until('!!document.querySelector(".mobile-goal-create__form:not([hidden])")')
      await capture('mature-goals-create-390-dark')
      await tap('.mobile-goals-new', 'Fold the original creation form')
    }

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
  // A fresh phone with no saved workface: the connect page shows progress from the typed connection state only.
  result.matureConnect = []
  const connectStates = [
    ['connecting', { state: 'connecting', message: '正在连接 Mac', paired: true }, ['done', 'done', 'current']],
    ['disconnected', { state: 'disconnected', message: '连接中断，正在自动重连。', paired: true }, ['done', 'done', 'attention']],
    ['unpaired', { state: 'unavailable', message: '请在 Mac 的手机连接中复制链接，在这台设备打开。', paired: false }, ['current', 'pending', 'pending']]]
  for (const appearance of ['dark', 'light']) {
    for (const [name, connection, steps] of connectStates) {
      await read(`mobileProductScene.showConnectScene(${JSON.stringify(connection)})`)
      await until(`document.querySelector('.mobile-connect-page')?.dataset.connectState===${JSON.stringify(name)}`)
      assert.equal(await read(`mobileProductScene.applyConnectAppearance(${JSON.stringify(appearance)})`), true, 'The observed theme applies before a connection')
      for (const [width, height] of [[390, 844], [320, 568]]) {
        await resize(width, height)
        const page = await read(`(()=>{const p=document.querySelector('.mobile-connect-page'),r=n=>n?n.getBoundingClientRect().toJSON():null,main=document.querySelector('.mobile-main')
          const header=document.querySelector('.mobile-header')
          return {header:[...header.querySelectorAll('button, .mobile-brand')].map(n=>n.getAttribute('aria-label')??n.className),steps:[...p.querySelectorAll('.mobile-connect-steps > li')].map(n=>n.dataset.stepState),icon:r(p.querySelector('img.brand-icon')),title:p.querySelector('h1')?.textContent,
            details:r([...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='连接详情')),main:r(main),scrollable:main.scrollHeight>main.clientHeight,
            dark:getComputedStyle(document.documentElement).colorScheme,overflow:document.querySelector('.mobile-app').scrollWidth>innerWidth}})()`)
        assert.deepEqual(page.steps, steps, `${name} progress follows the typed state`)
        assert.deepEqual(page.header, ['连接你的 Mac'], 'Before a connection the header holds only the menu; the page owns the brand')
        assert.ok(page.icon?.width >= 64, 'The App icon leads the page')
        assert.ok(page.details?.height >= 44, 'Connection details keeps its touch target')
        assert.equal(page.dark, appearance, 'The connect page renders the requested observed appearance')
        assert.equal(page.overflow, false)
        result.matureConnect.push({ name, width, height, appearance, page })
        await capture(`mature-connect-${name}-${width}-${appearance}`)
      }
    }
  }
  result.matureShellBoundary = 'Actual MobileApp shell with controlled original catalog facts in private Chromium; physical phone, OS keyboard and live Host are not observed.'
}
