const assert = require('node:assert/strict')

/** Native navigation through the original bound-group dialog; only typed fixture facts vary. */
module.exports = async function sharingCraftScene({ win, read, until, click, settle, capture, captureReference, details, dismiss, tab, result }) {
  const panel = '[data-connection-panel="sharing"]'
  const choices = panel + ' [aria-label="Group input scope"]'
  const radio = value => choices + ' input[value="' + value + '"]'
  async function scenario(options = {}) {
    await read('void Object.assign(window.channelEntryProof,' + JSON.stringify({ clarityPaused: false, clarityRepliesOnly: false, clarityMulti: false, sharingMultipleBots: true, clarityNoAvatar: false, clarityJoinUnknown: false, ...options }) + ')')
  }
  async function show(scenarioName, theme, width) {
    await details(scenarioName, theme, width)
    await click(tab('sharing')); await settle()
    await until('document.querySelector(' + JSON.stringify(choices) + ')?.dataset.value==="mentions-and-replies"')
  }
  async function verify(name, audienceCount) {
    const facts = await read(`(() => {const p=document.querySelector('${panel}'),a=p.querySelector('[aria-label="Connected audiences"]'),b=p.querySelector('[aria-label="Context and sharing boundaries"]'),d=b?.matches('details')?b:b?.closest('details');return {scope:p.querySelector('[aria-label="Group input scope"]')?.dataset.value,audiences:[...a.querySelectorAll('[data-sharing-audience]')].map(n=>({id:n.dataset.sharingAudience,text:n.textContent})),boundariesOpen:d?.open,warning:[...p.querySelectorAll('p')].some(n=>n.checkVisibility()&&/existing (?:private )?context/.test(n.textContent)),overflows:[...p.querySelectorAll('fieldset,details,[data-sharing-audience]')].filter(n=>n.checkVisibility()&&n.getBoundingClientRect().right>innerWidth).map(n=>n.outerHTML),animations:document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.target instanceof Element&&p.contains(a.effect.target)).length,writes:window.channelEntryProof.requests.filter(n=>/configure|\\.bind$|\\.relink$|\\.pause$|\\.resume$|\\.detach$|\\.grant$|\\.create$|\\.retry$/.test(n.method))}})()`)
    assert.equal(facts.audiences.length, audienceCount)
    assert.equal(facts.boundariesOpen, false)
    assert.equal(facts.warning, true)
    assert.equal(await read('document.querySelector(' + JSON.stringify(panel) + ').textContent.includes("This preview does not execute")'), false)
    assert.deepEqual(facts.writes, [])
    assert.deepEqual(facts.overflows, [])
    assert.equal(facts.animations, 0, 'The resting Sharing surface does not imply continuous message traffic')
    result.interactions.push({ kind: 'sharing-state', name, ...facts })
    await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0')
    await capture(name)
  }

  await scenario(); await show('healthy', 'dark', 1380)
  await verify('sharing-wide-dark', 1)
  await click('js:document.querySelector(' + JSON.stringify(radio('mentions-and-replies')) + ').closest("label")')
  const before = await read('window.__connectionsTrustedEvents.length')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await settle()
  await until('document.querySelector(' + JSON.stringify(radio('all-messages')) + ')?.checked')
  const events = await read('window.__connectionsTrustedEvents.slice(' + before + ')')
  assert.ok(events.some(e => e.type === 'keydown' && e.key === 'ArrowRight' && e.trusted))
  result.interactions.push({ kind: 'native-radio-keyboard-selection', events })
  await click(tab('members')); await click(tab('sharing'))
  assert.equal(await read('document.querySelector(' + JSON.stringify(radio('all-messages')) + ').checked'), true)
  assert.equal(await read('[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent.trim()==="Save sharing")?.disabled'), true)
  await read('window.channelEntryProof.setTheme("light")')
  win.setContentSize(390, 844); await until('innerWidth===390'); await settle()
  await verify('sharing-narrow-light-draft', 1)
  await read('document.querySelector(".agent-connector-dialog__body").scrollTop=document.querySelector(".agent-connector-dialog__body").scrollHeight')
  await settle()
  const disconnect = 'js:[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent.trim()==="Disconnect group")'
  if (captureReference) await captureReference('sharing-narrow-light-actions')
  await click(disconnect)
  const confirmation = '[aria-label="Confirm group disconnection"]'
  assert.equal(await read('!!document.querySelector(' + JSON.stringify(confirmation) + ')'), true)
  await click('js:[...document.querySelectorAll(".agent-connector-dialog button")].find(n=>n.textContent.trim()==="Keep connected")')
  assert.equal(await read('!!document.querySelector(' + JSON.stringify(confirmation) + ')'), false)
  // Restore the draft with the real control before beginning an independent paused scene.
  await click('js:document.querySelector(' + JSON.stringify(radio('mentions-and-replies')) + ').closest("label")')
  assert.equal(await read('document.querySelector(' + JSON.stringify(radio('mentions-and-replies')) + ').checked'), true)
  await dismiss()

  await scenario({ clarityPaused: true, clarityRepliesOnly: true, clarityNoAvatar: true })
  await show('healthy', 'dark', 520)
  assert.ok(await read('document.querySelector("[data-partial-sharing]")?.textContent.includes("Resume two-way sync")'))
  await verify('sharing-paused-replies-dark', 1)
  await dismiss()

  await scenario({ clarityMulti: true })
  await show('mixed', 'light', 1380)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await until('matchMedia("(prefers-reduced-motion: reduce)").matches'); await settle()
  await verify('sharing-multiple-long-names-light', 2)
  result.interactions.push({ kind: 'reduced-motion', matched: true })
  win.webContents.debugger.detach()
}
