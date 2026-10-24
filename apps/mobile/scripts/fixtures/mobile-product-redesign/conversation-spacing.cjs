const assert = require('node:assert/strict')
module.exports = async ({ read, until, resize, tap, button, capture, result }) => {
  await read('mobileProductScene.prepareDensity()')
  await button('Focus', '.mobile-navigation')
  await button('实验建议', '.mobile-focus-project')
  await button('Mote', '.mobile-navigation')
  await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
  await button(await read('mobileProductScene.facts().menuAgentName'), '.mobile-mote-agents')
  await until('document.querySelectorAll(".mobile-conversation__reading .log-turn").length >= 3')
  result.spacing = []
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-conversation__reading").scrollTop=0')
    const rows = await read(`Array.from(document.querySelectorAll('.mobile-conversation__reading .log-turn')).map(n=>{const rect=x=>x?.getBoundingClientRect().toJSON()??null;return{role:n.dataset.speakerRole,phase:n.dataset.messagePhase,turn:rect(n),head:rect(n.querySelector('.log-turn__head')),body:rect(n.querySelector('.log-turn__body')),text:n.innerText.slice(0,80),actions:[...n.querySelectorAll('.log-turn__action,.log-turn__id-copy,.conversation-input-details__toggle')].map(rect)}})`)
    assert.ok(rows.length >= 3, 'Original multi-message conversation is visible')
    const reply = rows.find(row => row.role === 'agent' && row.phase === 'final')
    assert.ok(reply && reply.head.height <= 64, 'Agent identity does not add a full second header row')
    assert.ok(reply.actions.every(action => action.width >= 44 && action.height >= 44), 'Message actions retain their touch targets')
    assert.equal(await read('!!document.querySelector(".log-turn[data-speaker-role=agent] .log-turn__head .log-turn__sender-id")'), false, 'Identity is not in the compact header')
    const bounds = await read(`(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return{reading:rect('.mobile-conversation__reading'),tools:rect('.mobile-conversation__floating-tools')}})()`)
    assert.ok(bounds.reading.bottom <= bounds.tools.top + 1, 'Floating tools do not cover the scrollable messages or their actions')
    result.spacing.push({ width, appearance, rows })
    await capture(`conversation-spacing-${width}-${appearance}`)
  }
  const reply = '.log-turn[data-speaker-role="agent"][data-message-phase="final"]'
  await tap(reply + ' .conversation-input-details__toggle', 'Open original sender details')
  await until(`!!document.querySelector(${JSON.stringify(reply + ' .conversation-input-details__body .log-turn__id-copy')})`)
  const identity = await read(`document.querySelector(${JSON.stringify(reply + ' .log-turn__sender-id code')}).textContent`)
  assert.ok(identity, 'Original sender identity remains available in details')
  await tap(reply + ' .log-turn__id-copy', 'Copy original sender identity')
  await until(`mobileProductScene.facts().copiedTexts.includes(${JSON.stringify(identity)})`)
  result.identity = { original: identity, copied: true }
  const report = '[data-native-record-id="session-mote-report"]'
  await tap(report + ' .conversation-input-details__toggle', 'Read the original Subagent report details')
  await until(`!!document.querySelector(${JSON.stringify(report + ' .conversation-input-details__body')})`)
}
