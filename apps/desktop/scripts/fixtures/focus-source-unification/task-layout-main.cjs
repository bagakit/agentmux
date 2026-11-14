const assert = require('node:assert/strict')

module.exports = async function exerciseTaskLayout({win, read, until, settle, click, capture, result, restoreOnly}) {
  const root = '.global-focus-surface:not([hidden])'
  const control = root + ' [role="radiogroup"][aria-label="Task layout"]'
  const radio = value => control + ' [data-option="' + value + '"]'
  const layout = () => read('document.querySelector(' + JSON.stringify(root) + ')?.dataset.taskLayout')
  const task = id => root + ' button.focus-context[data-session-id="' + id + '"]'
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
  const motion = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{name:'prefers-reduced-motion',value}],
  })
  const movePointer = async selector => {
    const point = await read(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}
    })()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',...point})
  }
  const rowFacts = id => read(`(() => {
    const button = document.querySelector(${JSON.stringify(task(id))})
    if (!button) return null
    const row = button.closest('[data-focus-card-key]')
    const title = button.querySelector('.focus-task-list__title')
    const status = button.querySelector('.focus-task-list__state')
    const time = button.querySelector('.focus-task-list__time')
    const tag = row.querySelector('[data-focus-zone-footer]')
    const visible = node => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility === 'visible')
    const tagBounds = tag?.getBoundingClientRect()
    const listBounds = row.closest('.focus-project-lanes__rows').getBoundingClientRect()
    return {
      name: title?.textContent,
      width: button.getBoundingClientRect().width,
      titleWidth: title?.getBoundingClientRect().width,
      mark: button.querySelector('[data-focus-state-icon]')?.dataset.focusStateIcon,
      status: visible(status) ? status.textContent : null,
      time: visible(time),
      tag: visible(tag) ? tag.textContent.trim() : null,
      tagInViewport: visible(tag) && tagBounds.top >= listBounds.top && tagBounds.bottom <= listBounds.bottom,
      accessibleName: button.getAttribute('aria-label'),
    }
  })()`)
  async function checkList() {
    const [ordinary, request, web, api] = await Promise.all(['working','permission','branch-web','branch-api'].map(rowFacts))
    assert.ok(ordinary?.titleWidth > 0 && ordinary.mark, 'The actual List consumer gives the original task its own visible title and state shape')
    assert.equal(ordinary.status, null, 'Ordinary state text does not occupy the title column')
    assert.ok(ordinary.accessibleName.includes('Working'), 'The original ordinary state remains in the accessible name')
    assert.ok(request?.status?.includes('Request pending'), 'A real request retains its visible state')
    assert.ok(web?.name && web.name === api?.name, 'The two independently placed tasks carry the same original title')
    assert.equal(web.tag, 'web', 'The first original worktree remains readable beside its task')
    assert.equal(api.tag, 'api', 'The second original worktree remains readable beside its task')
    return {ordinary, request, web, api}
  }
  const listWidth = () => read('document.querySelector(".global-focus-layout > .global-focus-main").getBoundingClientRect().width')
  async function setSplitWidth(target) {
    let width = 1140
    for (let attempt=0; attempt<5; attempt++) {
      win.setContentSize(width, 900)
      await settle()
      const actual = await listWidth()
      if (Math.abs(actual-target) <= 2) return actual
      width += Math.round((target-actual) / (1-0.618))
    }
    throw Error('Could not size real split List to ' + target + ' px')
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
  const first = task('working')
  const rowHeight = () => read('document.querySelector(' + JSON.stringify(first) + ').getBoundingClientRect().height')
  const cardsHeight = await rowHeight()
  await read('window.unifiedFocusProof.theme("dark")')
  await frame('cards-dark', 'Default Cards in the original Focus project')
  // Freeze one actual Chromium transition frame for independent visual review.
  await motion('no-preference')
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
  result.refinement = { wide: await checkList(), narrow: [] }
  await frame('list-dark', 'Compact project rows at desktop width')
  await read(`document.querySelector(${JSON.stringify(first)}).addEventListener('transitionrun', event => {
    if (event.propertyName !== 'background-color') return
    const animation = event.target.getAnimations().find(item => item.transitionProperty === 'background-color')
    if (animation) {
      animation.pause()
      animation.currentTime = animation.effect.getTiming().duration * 0.5
    }
  }, {once:true})`)
  const originalY = await read(`document.querySelector(${JSON.stringify(first)}).getBoundingClientRect().top`)
  await movePointer(first)
  await until('row color transition in flight', () => read(`document.querySelector(${JSON.stringify(first)}).getAnimations().some(item => item.playState === 'paused' && item.transitionProperty === 'background-color')`))
  assert.equal(await read(`document.querySelector(${JSON.stringify(first)}).getBoundingClientRect().top`), originalY, 'Pointer feedback leaves the original task position stable')
  await frame('row-hover-transition', 'Actual List row hover halfway through its background-color transition')
  await movePointer(radio('list'))
  await read(`Promise.allSettled(document.querySelector(${JSON.stringify(first)}).getAnimations().map(animation => {animation.play(); return animation.finished}))`)
  result.refinement.hoverStable = true

  win.setContentSize(420, 800)
  await read('window.unifiedFocusProof.theme("light")')
  await motion('reduce')
  await settle()
  assert.equal(await read('getComputedStyle(document.querySelector(' + JSON.stringify(indicator) + ')).transitionDuration'), '0s')
  assert.equal(await read(`getComputedStyle(document.querySelector(${JSON.stringify(first)})).transitionDuration`), '0s')
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

  for (const width of [420, 360]) {
    const actual = await setSplitWidth(width)
    await read('document.querySelector(".focus-project-lanes__rows").scrollTop = 0')
    await settle()
    const rows = await checkList()
    assert.ok(rows.ordinary.titleWidth > rows.ordinary.width / 2, 'The title takes most of the main row even in a narrow split')
    assert.ok(rows.web.tagInViewport && rows.api.tagInViewport, 'The actual split screenshot includes both worktree Tags')
    if (width === 360) assert.equal(rows.ordinary.time, false, 'Time yields at the most constrained List width')
    assert.equal(await draft(), before.drafts.working)
    result.refinement.narrow.push({width, actual, ...rows})
    await frame('split-list-'+width, 'Original workface and task List at an actual '+width+' px split, reduced motion')
  }
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
