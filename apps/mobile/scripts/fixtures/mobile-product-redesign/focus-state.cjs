const assert = require('node:assert/strict')
module.exports = async ({ read, until, resize, button, capture, result }) => {
  await read('mobileProductScene.prepareFocusState()')
  await button('Focus', '.mobile-navigation')
  await until('document.querySelectorAll(".mobile-focus-project .mobile-session-state .focus-state-mark").length >= 2')
  result.focusState = []
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    const facts = await read(`(()=>{const rows=[...document.querySelectorAll('.mobile-focus-project .mobile-agent-row__open')];return rows.map(row=>{const label=row.querySelector('.mobile-session-state > span[title]'),icon=row.querySelector('.mobile-session-state .semantic-icon'),name=row.querySelector('.mobile-session-copy strong'),more=row.parentElement.querySelector('.mobile-agent-row__more'),r=n=>n?.getBoundingClientRect().toJSON();return {name:name?.textContent,status:label?.textContent,accessible:label?.title,icon:r(icon),nameRect:r(name),row:r(row),more:r(more),visual:icon?.getAttribute('width')}})})()`)
    const long = facts.find(row => row.status === 'Activity not confirmed'), working = facts.find(row => row.name === '日常协作')
    assert.ok(long && working, 'Original working and long unknown status remain visible')
    assert.equal(long.accessible, long.status); assert.equal(long.visual, '12'); assert.equal(working.visual, '12')
    assert.ok(long.nameRect.width >= 95, 'Long status preserves readable Agent name space')
    assert.ok(long.more.width >= 44 && long.more.height >= 44, 'Agent actions retain the full touch target')
    result.focusState.push({ width, appearance, facts }); await capture(`focus-state-${width}-${appearance}`)
  }
  result.focusStateBoundary = 'Real MobileApp Focus row and shared themed icons in private Chromium with controlled original catalog facts; physical phone and live Host are not observed.'
}
