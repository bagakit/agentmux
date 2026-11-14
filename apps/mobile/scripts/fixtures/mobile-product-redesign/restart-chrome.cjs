const assert = require('node:assert/strict')

/** Exercise the same original conversation through all three work panels in each OS process. */
module.exports = async ({ read, until, tap, capture, result, phase, prefix }) => {
  await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
  const original = await read('({sid:mobileProductScene.facts().record.selectedSessionId,editor:!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")})')
  const checks = []
  const check = async (root, panel) => {
    await until('!document.querySelector(".mobile-main[data-motion]")')
    const chrome = await read(`(()=>{const shown=n=>n.getClientRects().length>0;return {bar:[...document.querySelectorAll('.mobile-navigation-bar')].some(shown),headers:[...document.querySelectorAll('.mobile-header,.mobile-page-header')].filter(shown).map(n=>({className:n.className,height:n.getBoundingClientRect().height}))}})()`)
    assert.equal(chrome.bar, root, panel + ' owns the expected tab bar')
    assert.equal(chrome.headers.length, 1, panel + ' has exactly one visible header')
    assert.ok(chrome.headers[0].className.includes('mobile-header--session'))
    assert.equal(Math.round(chrome.headers[0].height), 52, panel + ' keeps one 52px header')
    checks.push({ panel, ...chrome })
    await capture(prefix + '-' + panel + '-' + (phase ?? 'initial'))
  }
  await check(true, 'mote-main')
  await tap('.mobile-conversation__goal', 'Open the original Goal work')
  await until('!!document.querySelector(".mobile-goal-panel:not([hidden])")')
  await check(false, 'goal-work')
  await tap('.mobile-header [data-mobile-back]', 'Return to the original conversation')
  await tap('.mobile-header .mobile-session-view-toggle', 'Read the original terminal')
  await until('!!document.querySelector(".mobile-terminal-panel:not([hidden])")')
  await check(false, 'terminal')
  await tap('.mobile-header .mobile-session-view-toggle', 'Return from the original terminal')
  assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), original.sid)
  result.restartChrome ??= []
  result.restartChrome.push({ phase: phase ?? 'initial', checks })
}
