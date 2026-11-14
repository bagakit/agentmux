const assert = require('node:assert/strict')

module.exports = async function exerciseTaskLayout({win, read, until, settle, click, capture, result, restoreOnly}) {
  const root = '.global-focus-surface:not([hidden])'
  const control = root + ' [role="radiogroup"][aria-label="Task layout"]'
  const radio = value => control + ' [data-option="' + value + '"]'
  const layout = () => read('document.querySelector(' + JSON.stringify(root) + ')?.dataset.taskLayout')
  const expectLayout = async value => {
    await until('task layout ' + value, async () => await layout() === value)
    assert.equal(await read('document.querySelector(' + JSON.stringify(radio(value)) + ')?.getAttribute("aria-checked")'), 'true')
  }
  const key = async (value, code, virtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: value, code, ...(type==='keyDown' && value==='Enter' ? {text:'\r'} : {}), windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    })
    await settle()
  }
  const frame = async (name, caption) => {
    assert.equal(await read('document.documentElement.scrollWidth > innerWidth + 1'), false)
    await capture(name + '.png', caption)
  }
  await until('Focus task layout controls and original tasks', () => read('!!window.taskLayoutProof && document.querySelectorAll(".focus-context[data-session-id]").length >= 4 && !!document.querySelector(' + JSON.stringify(radio('list')) + ')'))
  if (restoreOnly) {
    await expectLayout('list')
    assert.equal(await read('window.taskLayoutProof.restored'), true)
    result.topology=await read('window.taskLayoutProof.topology()')
    result.layout = 'list'
    await frame('restored-list', 'The original private user document restores List in a second Electron process')
    result.passed = true
    return
  }

  await expectLayout('cards')
  assert.equal(await read('window.taskLayoutProof.restored'), false)
  const before = await read('window.unifiedFocusProof.facts()')
  const first = root + ' button.focus-context[data-session-id="working"]'
  const rowHeight = () => read('document.querySelector(' + JSON.stringify(first) + ').getBoundingClientRect().height')
  const cardsHeight = await rowHeight()
  await read('window.unifiedFocusProof.theme("dark")')
  await frame('cards-dark', 'Default Cards in the original Focus project')
  // Freeze one actual Chromium transition frame for independent visual review.
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
  const indicator = control + ' .segmented-control__indicator'
  await read(`document.querySelector(${JSON.stringify(indicator)}).addEventListener('transitionrun', event => {
    const animation=event.target.getAnimations().find(item=>item.transitionProperty==='transform')
    if (!animation) return
    animation.pause()
    animation.currentTime=animation.effect.getTiming().duration*0.35
  }, {once:true})`)
  await click(radio('list'))
  await expectLayout('list')
  await until('original segmented indicator in flight', () => read('document.querySelector(' + JSON.stringify(indicator) + ').getAnimations().some(a=>a.playState==="paused")'))
  await frame('layout-transition', 'Midpoint of the actual segmented indicator transition, sampled at 35% of its duration')
  await read('Promise.all(document.querySelector(' + JSON.stringify(indicator) + ').getAnimations().map(a=>{a.play();return a.finished}))')
  const listHeight = await rowHeight()
  assert.ok(listHeight < cardsHeight, 'The actual Agent layout becomes denser: ' + listHeight + ' vs ' + cardsHeight)
  await frame('list-dark', 'Compact project rows at desktop width')

  win.setContentSize(420, 800)
  await read('window.unifiedFocusProof.theme("light")')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]})
  await settle()
  assert.equal(await read('getComputedStyle(document.querySelector(' + JSON.stringify(indicator) + ')).transitionDuration'), '0s')
  await frame('list-narrow-light', 'Light 420px scan in reduced motion')
  win.setContentSize(1440, 900)
  await settle()
  await read('document.querySelector(' + JSON.stringify(first) + ').focus()')
  await key('ArrowDown', 'ArrowDown', 40)
  const next = await read('document.activeElement?.closest("[data-focus-card-key]")?.dataset.focusCardKey')
  assert.ok(next, 'Down moves focus to another original task')
  assert.notEqual(next, await read('document.querySelector(' + JSON.stringify(first) + ').closest("[data-focus-card-key]").dataset.focusCardKey'))
  await key('ArrowUp', 'ArrowUp', 38)
  assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(first) + ')'), true)
  await key(' ', 'Space', 32)
  await until('Space opens the original reader', () => read('!!document.querySelector(".agent-information-reader")'))
  await frame('quick-look', 'Explicit keyboard preview of the original Agent')
  await key('Escape', 'Escape', 27)
  await until('Escape returns to the original row', () => read('!document.querySelector(".agent-information-reader") && document.activeElement===document.querySelector(' + JSON.stringify(first) + ')'))
  await key('Enter', 'Enter', 13)
  const workface = '.global-session-workspace [data-fixture-session="working"]'
  await until('Enter opens the original Agent workface', () => read('!!document.querySelector(' + JSON.stringify(workface) + ')'))
  const draft = () => read('document.querySelector(' + JSON.stringify(workface + ' textarea') + ')?.value')
  assert.equal(await draft(), before.drafts.working)
  const originalKey = await read('document.querySelector(' + JSON.stringify(first) + ').closest("[data-focus-card-key]").dataset.focusCardKey')
  await frame('selected-workface', 'Original selection and draft with the list and workface open')
  win.setContentSize(1080, 480)
  await settle()
  const selectedVisible = () => read(`(() => {
    const row = document.querySelector('[data-focus-agent-selected="true"]')
    const port = row.closest('.focus-project-lanes__rows')
    const box = row.getBoundingClientRect(), viewport = port.getBoundingClientRect()
    return { key:row.dataset.focusCardKey, visible:box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1, scrollable:port.scrollHeight > port.clientHeight, scroll:port.scrollTop }
  })()`)
  await read('document.querySelector(' + JSON.stringify(first) + ').scrollIntoView({block:"center"})')
  const beforeSwitch = await selectedVisible()
  assert.ok(beforeSwitch.scrollable && beforeSwitch.visible, 'Selected task starts within a truly scrollable project list')
  await click(radio('cards'))
  await expectLayout('cards')
  const afterCards = await selectedVisible()
  assert.ok(afterCards.visible && afterCards.key === beforeSwitch.key, 'Card reflow preserves the visible original task')
  await key('ArrowRight', 'ArrowRight', 39)
  await expectLayout('list')
  assert.equal(await draft(), before.drafts.working)
  assert.equal(await read('document.querySelector("[data-focus-agent-selected=true]")?.dataset.focusCardKey'), originalKey)
  const afterList = await selectedVisible()
  assert.ok(afterList.visible && afterList.key === beforeSwitch.key, 'List reflow preserves the visible original task')
  result.scroll = {beforeSwitch, afterCards, afterList}
  const after = await read('window.unifiedFocusProof.facts()')
  assert.deepEqual(after.runs, before.runs)
  assert.deepEqual(after.drafts, before.drafts)
  result.topology=await read('window.taskLayoutProof.topology()')
  result.layout = await read('window.taskLayoutProof.checkpoint()')
  assert.equal(result.layout, 'list', 'Persisted preference must be the current List setting')
  result.scenes.push({cardsHeight,listHeight,selected:originalKey,keyboard:true,originalDraft:true})
  result.passed = true
}
