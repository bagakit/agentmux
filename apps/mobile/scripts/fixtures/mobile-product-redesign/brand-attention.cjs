const assert = require('node:assert/strict')

// Actual Focus and the original permission consumer; no answer or lifecycle operation is sent.
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareFocusState()')
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-card .mobile-ticket-answer__choices button")')
  const start = await read('mobileProductScene.facts().calls.length')
  result.brandAttention = []
  for (const [width, height] of [[390, 844], [320, 760]]) for (const appearance of ['dark', 'light']) {
    await resize(width, height)
    await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    const facts = await read(`(() => {
      const style = n => { const s = getComputedStyle(n); return {shadow:s.boxShadow,left:s.borderLeftWidth} }
      const cards = [...document.querySelectorAll('.mobile-needs-you-card')]
      const rows = [...document.querySelectorAll('.mobile-focus-project .mobile-agent-row[data-needs-you] > .mobile-agent-row__open')]
      const choices = [...document.querySelectorAll('.mobile-ticket-answer__choices button')]
      return {cards:cards.map(style),rows:rows.map(style),states:[...document.querySelectorAll('.mobile-row-state')].map(n=>n.textContent),
        choices:choices.map(n=>({label:n.textContent,height:n.getBoundingClientRect().height})),title:document.querySelector('.mobile-ticket-answer__title')?.textContent}
    })()`)
    assert.ok(facts.cards.length && facts.rows.length, 'Real attention cards and their original directory rows are present')
    assert.ok(facts.cards.every(s => s.shadow === 'none' && s.left === '0px'), 'Focus attention cards have no decorative side rail')
    assert.ok(facts.rows.every(s => s.shadow === 'none' && s.left === '0px'), 'Focus attention rows have no decorative side rail')
    assert.ok(facts.states.some(s => s.includes('需要你') || s.includes('等待')), 'The original named attention state remains visible')
    assert.equal(facts.title, '请确认本次资料读取')
    assert.deepEqual(facts.choices.map(n => n.label), ['允许本次读取', '拒绝本次读取'])
    for (const choice of facts.choices) assert.ok(choice.height >= 44, 'Original answers retain touch targets')
    result.brandAttention.push({width, height, appearance, facts})
    await capture(`brand-focus-${width}-${appearance}`)
  }
  await resize(390, 844)
  await tap('.mobile-needs-you-ticket', 'Open the original waiting conversation')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) .agent-interaction")')
  await read(`window.brandOriginalEditor=document.querySelector('.mobile-conversation-panel:not([hidden]) [contenteditable=true]');window.brandOriginalEditor.focus()`)
  await win.webContents.insertText('品牌优化保留这份原对话草稿')
  for (const [width, height] of [[390, 844], [320, 760]]) for (const appearance of ['dark', 'light']) {
    await resize(width, height)
    await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    const facts = await read(`(() => {
      const n = document.querySelector('.mobile-conversation-panel:not([hidden]) .agent-interaction'), s = getComputedStyle(n)
      return {shadow:s.boxShadow,left:s.borderLeftWidth,request:n.dataset.requestId,
        actions:[...n.querySelectorAll('.agent-interaction__actions > button')].map(b=>({label:b.textContent,height:b.getBoundingClientRect().height})),
        draft:window.brandOriginalEditor.textContent,session:mobileProductScene.facts().record.selectedSessionId}
    })()`)
    assert.equal(facts.shadow, 'none', 'Interaction cards have no decorative side rail or duplicate outline')
    assert.equal(facts.left, '0px', 'Interaction cards have no decorative side rail or duplicate outline')
    assert.equal(facts.request, 'request-original')
    assert.equal(facts.session, 'session-waiting')
    assert.ok(facts.actions.length >= 3, 'Both decisions and dismiss remain available')
    for (const action of facts.actions) assert.ok(action.height >= 44, 'Original request actions retain touch targets')
    assert.equal(facts.draft, '品牌优化保留这份原对话草稿')
    result.brandAttention.push({width, height, appearance, facts})
    await capture(`brand-request-${width}-${appearance}`)
  }
  await button('Focus', '.mobile-navigation')
  await tap('.mobile-needs-you-ticket', 'Return to the same original waiting conversation')
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  assert.equal(await read('document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")===window.brandOriginalEditor'), true, 'The original Composer stays mounted')
  assert.equal(await read('window.brandOriginalEditor.textContent'), '品牌优化保留这份原对话草稿')
  const writes = await read(`mobileProductScene.facts().calls.slice(${start}).filter(c=>/submitAgentPrompt|respondAgentInteraction|signalAgent|resumeAgent|performAgentContinuity/.test(c.method)||['goal.create','goal.discuss','goal.confirm','goal.accept','agent.open','agent.resume'].includes(c.method))`)
  assert.deepEqual(writes, [], 'Visual inspection and navigation do not dispatch original inputs, answers or lifecycle actions')
}
