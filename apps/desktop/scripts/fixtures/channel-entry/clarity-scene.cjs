const assert = require('node:assert/strict')

/** Native controls on the actual four-tab consumer; fixture facts never dispatch an effect. */
module.exports = async function clarityScene({ win, read, until, click, settle, capture, details, dismiss, tab, member, result }) {
  const dialog = '.agent-connector-dialog'
  async function scenario(options = {}) {
    await read('void Object.assign(window.channelEntryProof,' + JSON.stringify({ clarityPaused: false, clarityRepliesOnly: false, clarityMulti: true, clarityNoAvatar: false, clarityJoinUnknown: false, ...options }) + ')')
  }
  async function context(name) {
    await click(tab(name)); await settle()
    const observed = await read(`(() => {const d=document.querySelector('${dialog}'),h=d.querySelector('.connector-group-details__header'),body=d.querySelector('.agent-connector-dialog__body'),boundary=d.closest('[role=dialog]');return {name:${JSON.stringify(name)},header:h.textContent,insideBody:body.contains(h),description:document.getElementById(boundary.getAttribute('aria-describedby'))?.textContent,rect:h.getBoundingClientRect().toJSON(),bodyHeight:body.clientHeight}})()`)
    assert.ok(observed.header.includes('Research Agent') && observed.header.includes('This conversation') && observed.header.includes('Bot connection'))
    assert.equal(observed.insideBody, false); assert.ok(observed.description.includes('Research Agent'))
    assert.ok(observed.bodyHeight >= 100, 'A usable original body remains below persistent context')
    await read('document.querySelector(".agent-connector-dialog__body").scrollTop=10000')
    const after = await read('document.querySelector(".connector-group-details__header").getBoundingClientRect().toJSON()')
    assert.deepEqual(after, observed.rect, 'The current relationship and tab navigation persist while body scrolls')
    await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0')
    result.interactions.push({ kind: 'persistent-group-context', ...observed })
  }
  if (process.argv.includes('--clarity-overview-only')) {
    await scenario(); await details('healthy', 'dark', 1380); await context('overview')
    await capture('clarity-overview-wide-dark'); await dismiss()
    await scenario({ clarityPaused: true, clarityRepliesOnly: true, clarityNoAvatar: true })
    await details('mixed', 'light', 390, true); await context('overview')
    await capture('clarity-overview-narrow-light')
    return
  }
  await scenario()
  await details('healthy', 'dark', 1380)
  for (const name of ['overview', 'members', 'sharing', 'joining']) {
    await context(name)
    if (name === 'sharing') {
      assert.equal(await read('document.querySelector(\'[aria-label="Connected audiences"]\').closest("details")'), null)
      assert.equal(await read('document.querySelectorAll(\'[aria-label="Connected audiences"] [data-sharing-audience]\').length'), 2)
    }
    if (name === 'joining') await until('document.querySelector(\'[data-connection-panel="joining"] [data-enrollment-code] svg\')')
    await capture('clarity-' + name + '-wide-dark')
  }
  await dismiss()

  await scenario({ clarityPaused: true, clarityRepliesOnly: true, clarityNoAvatar: true })
  await details('mixed', 'light', 390, true)
  await context('overview')
  assert.ok(await read('document.querySelector(".connector-group-details__configuration").textContent.includes("Paused · Agent replies only")'))
  await capture('clarity-overview-narrow-light'); await dismiss()

  await scenario({ clarityNoAvatar: true })
  await details('mixed', 'light', 390, true)
  await context('members')
  await click(member + ' [data-member-edit]'); await click(member + ' input[type="checkbox"]')
  for (const name of ['sharing', 'joining', 'overview']) await context(name)
  await click(tab('sharing'))
  const eventStart = await read('window.__connectionsTrustedEvents.length')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' }); await settle()
  assert.equal(await read('document.activeElement?.textContent'), 'Member access')
  const events = await read('window.__connectionsTrustedEvents.slice(' + eventStart + ')')
  assert.ok(events.some(event => event.key === 'ArrowLeft' && event.trusted))
  await until('document.querySelector(' + JSON.stringify(member) + ')?.textContent.includes("Unsaved changes")')
  await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0')
  result.interactions.push({ kind: 'keyboard-section-with-retained-member-draft', events })
  await capture('clarity-members-narrow-light')
  win.setContentSize(390, 600); await until('innerHeight===600'); await context('members')
  await click(member + ' [aria-label="Copy person name"]')
  assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Copy person name')
  result.interactions.push({ kind: 'short-window', height: 600, bodyHeight: await read('document.querySelector(".agent-connector-dialog__body").clientHeight') })
  await dismiss()

  await scenario({ clarityPaused: true, clarityRepliesOnly: true })
  await details('mixed', 'light', 390)
  await context('sharing')
  assert.equal(await read('document.querySelector(\'[aria-label="Connected audiences"]\').closest("details")'), null)
  await capture('clarity-sharing-narrow-light'); await dismiss()

  await scenario({ clarityJoinUnknown: true })
  await details('healthy', 'light', 390)
  await context('joining')
  await until('document.querySelector(\'[data-connection-panel="joining"]\').textContent.includes("Join link result not confirmed")')
  await capture('clarity-joining-narrow-light')
}
