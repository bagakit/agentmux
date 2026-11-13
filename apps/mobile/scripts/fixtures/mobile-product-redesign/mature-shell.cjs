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
  // One tap from the needs-you strip opens the exact waiting request.
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-needs-you-ticket")')
  await tap('.mobile-needs-you-ticket', 'Needs-you ticket')
  await until('!!document.querySelector("[data-request-id=request-original]")')
  assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-waiting', 'The ticket opens the exact waiting Agent')
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
    await capture(`mature-${label.toLowerCase()}-390-dark`)
  }
  result.matureShellBoundary = 'Actual MobileApp shell with controlled original catalog facts in private Chromium; physical phone, OS keyboard and live Host are not observed.'
}
