const assert = require('node:assert/strict')
const { focus: root, trigger, menu, taskLayoutControls } = require('./task-layout-controls.cjs')

module.exports = async function exerciseTaskLayout({win, read, until, settle, click, capture, result, restoreOnly}) {
  const layouts = taskLayoutControls({read, until, click})
  const map = '[data-desktop-focus-view="map"]:not([hidden])'
  const viewButton = (surface, value) => surface + ' .focus-view-switch [data-surface-mode="' + value + '"]'
  const layout = () => read('document.querySelector(' + JSON.stringify(root) + ')?.dataset.taskLayout')
  const task = id => root + ' button.focus-context[data-session-id="' + id + '"]'
  const expectLayout = value => until('task layout ' + value, async () => await layout() === value)
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
    const summary = button.querySelector('.focus-task-list__summary')
    const detail = button.querySelector('.focus-task-list__detail')
    const status = button.querySelector('.focus-task-list__state')
    const time = button.querySelector('.focus-task-list__time')
    const subagents = button.querySelector('.focus-task-list__subagents')
    const subagentStates = subagents?.querySelector('.focus-task-list__subagent-states')
    const subagentCount = subagents?.querySelector('.focus-task-list__subagent-count')
    const tag = row.querySelector('[data-focus-zone-footer]')
    const visible = node => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility === 'visible')
    const tagBounds = tag?.getBoundingClientRect()
    const listBounds = row.closest('.focus-project-lanes__rows').getBoundingClientRect()
    return {
      name: title?.textContent,
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      titleWidth: title?.getBoundingClientRect().width,
      titleFits: title?.scrollWidth <= title?.clientWidth + 1,
      summary: visible(summary) ? { text: summary.textContent.trim(), top: summary.getBoundingClientRect().top,
        emphasis: summary.querySelector('.markdown-excerpt strong')?.textContent } : null,
      titleTop: title?.getBoundingClientRect().top,
      hasDetail: visible(detail),
      mark: button.querySelector('[data-focus-state-icon]')?.dataset.focusStateIcon,
      bucket: button.dataset.bucket,
      activity: button.dataset.activity,
      status: visible(status) ? status.textContent : null,
      time: visible(time),
      subagents: subagents ? {states: visible(subagentStates) ? subagentStates.textContent.trim() : null,
        statesWidth: visible(subagentStates) ? subagentStates.clientWidth : null,
        statesContentWidth: visible(subagentStates) ? subagentStates.scrollWidth : null,
        count: visible(subagentCount) ? subagentCount.textContent.trim() : null, title: subagents.title} : null,
      tag: visible(tag) ? tag.textContent.trim() : null,
      tagInViewport: visible(tag) && tagBounds.top >= listBounds.top && tagBounds.bottom <= listBounds.bottom,
      accessibleName: button.getAttribute('aria-label'),
      accessibleDescription: button.getAttribute('aria-description'),
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
  await until('Focus task layout control and original tasks', () => read('!!window.taskLayoutProof && document.querySelectorAll(".focus-context[data-session-id]").length >= 4 && !!document.querySelector(' + JSON.stringify(trigger) + ')'))
  if (restoreOnly) {
    await expectLayout('list')
    assert.equal(await read('window.taskLayoutProof.restored'), true)
    await layouts.open()
    await layouts.checked('list')
    await key('Escape', 'Escape', 27)
    await layouts.close()
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
  assert.equal(await read(`Boolean(document.querySelector('.focus-task-toolbar button[aria-label="Task layout"]'))`), false)
  await motion('no-preference')
  await layouts.open()
  await layouts.checked('cards')
  await frame('layout-menu-dark', 'List owns the separate layout menu, with Cards selected')
  await key('Escape', 'Escape', 27)
  await layouts.close()
  await until('Escape returns to the layout trigger', () => read(`document.activeElement === document.querySelector(${JSON.stringify(trigger)})`))
  assert.equal(await layout(), 'cards', 'Dismissing the menu leaves the current layout')
  await layouts.choose('list')
  await expectLayout('list')
  const listHeight = await rowHeight()
  assert.ok(listHeight < cardsHeight, 'The actual Agent layout becomes denser: ' + listHeight + ' vs ' + cardsHeight)
  result.refinement = { wide: await checkList(), narrow: [] }
  const { ordinary } = result.refinement.wide
  assert.match(ordinary.summary?.text ?? '', /release-checklist\.md/, 'Working shows the actual observed activity on its title line')
  assert.ok(Math.abs(ordinary.summary.top - ordinary.titleTop) < 8 && !ordinary.hasDetail)
  assert.equal((await rowFacts('rollout'))?.subagents, null, 'A different Run cannot supply child observations to the current task')
  assert.equal((await rowFacts('retention'))?.subagents, null, 'A different native Session cannot supply child observations to the current task')
  const observedParent = await rowFacts('working')
  const summary = observedParent?.subagents
  assert.ok(summary, 'The exact original task displays its observed subagents')
  assert.ok(summary.states, 'The wide parent row shows its observed state mix')
  assert.ok(summary.statesWidth >= summary.statesContentWidth, 'All four states fit in the actual wide parent row')
  for (const expected of ['1 waiting', '1 running', '1 completed', '1 unknown']) {
    assert.ok(summary.title.includes(expected), `Original parent summary includes ${expected}`)
    assert.ok(observedParent.accessibleDescription?.includes(expected), `Original parent accessible description includes ${expected}`)
  }
  result.subagents = { initial: summary, differentRun: 'excluded', differentNativeSession: 'excluded' }
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
  await movePointer(trigger)
  await read(`Promise.allSettled(document.querySelector(${JSON.stringify(first)}).getAnimations().map(animation => {animation.play(); return animation.finished}))`)
  result.refinement.hoverStable = true

  const resultSelector = JSON.stringify(task('audit'))
  await read(`document.querySelector(${resultSelector}).scrollIntoView({block:'center'})`)
  await until('the visible result mounts its original recap', () => read(`document.querySelector(${resultSelector})?.closest('[data-focus-card-key]').dataset.focusCardBody === 'mounted'`))
  const [resultRow, recoveryRow, staleRow, withoutRoster] = await Promise.all(['audit','interrupted','reading','coverage'].map(rowFacts))
  assert.equal(resultRow.bucket, 'results')
  assert.equal(resultRow.activity, 'unknown', 'The completed Result has separate unconfirmed child activity')
  assert.equal(resultRow.status, null, 'A completed Result cannot grow a second line for Idle')
  assert.match(resultRow.accessibleName, /Idle/)
  assert.match(resultRow.summary?.text ?? '', /退款材料已复核/, 'Results reuse the original result excerpt')
  assert.equal(resultRow.summary.emphasis, '退款材料已复核')
  assert.match(resultRow.accessibleDescription, /退款材料已复核/)
  assert.ok(Math.abs(resultRow.summary.top - resultRow.titleTop) < 8 && !resultRow.hasDetail)
  assert.match(resultRow.subagents.title, /coverage unknown/i, 'An incomplete roster does not claim zero observed children as complete coverage')
  assert.equal(staleRow.bucket, 'idle')
  assert.match(staleRow.summary?.text ?? '', /Activity signal expired/)
  assert.match(staleRow.accessibleDescription, /Last confirmed working/)
  assert.equal(staleRow.hasDetail, false, 'An expired activity observation stays on one line')
  assert.equal(withoutRoster.subagents, null, 'A missing roster does not claim any child state')
  assert.match(recoveryRow.status, /Interrupted/)
  result.refinement.resultRow = resultRow
  result.refinement.recoveryRow = recoveryRow
  result.refinement.staleRow = staleRow
  await settle()
  await frame('list-results-dark', 'Results stay single-line with the rest of the Focus list')
  await read('document.querySelector(".focus-project-lanes__rows").scrollTop = 0')

  win.setContentSize(420, 800)
  await read('window.unifiedFocusProof.theme("light")')
  await motion('reduce')
  await settle()
  assert.equal(await read(`getComputedStyle(document.querySelector(${JSON.stringify(first)})).transitionDuration`), '0s')
  await frame('list-narrow-light', 'Light 420px scan in reduced motion')
  await layouts.open()
  await layouts.checked('list')
  await frame('layout-menu-420', 'At 420 px the layout menu lists two choices and checks Compact list')
  await key('Escape', 'Escape', 27)
  await layouts.close()
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
  const details = '.agent-information-reader details.agent-subagent-details'
  await until('Quick Look contains the parent’s subagent disclosure', () => read(`Boolean(document.querySelector(${JSON.stringify(details + ' > summary')}))`))
  await click(details + ' > summary')
  const childRows = () => read(`Array.from(document.querySelectorAll(${JSON.stringify(details + '[open] [data-subagent-id]')})).map(item => ({id: item.dataset.subagentId, state: item.dataset.subagentState, label: item.textContent.trim()}))`)
  const expectedChildren = new Map([
    ['compare-release-data', ['running', /Running/]],
    ['check-payment-access', ['waiting', /Waiting for permission/]],
    ['review-release-notes', ['completed', /Completed/]],
    ['verify-rollback-plan', ['unknown', /Status unknown/]],
  ])
  const children = await childRows()
  assert.equal(children.length, expectedChildren.size)
  for (const child of children) {
    assert.ok(expectedChildren.has(child.id), `Quick Look retained exact child ${child.id}`)
    const [state, label] = expectedChildren.get(child.id)
    assert.equal(child.state, state)
    assert.match(child.label, label)
  }
  assert.equal(await read(`Boolean(document.querySelector(${JSON.stringify(details + ' [data-subagent-id] button, ' + details + ' [data-subagent-id] a')}))`), false)
  result.subagents.details = children
  await frame('quick-look-subagents', 'Original Agent Quick Look expands the read-only subagent states')
  await read('window.taskLayoutProof.settleChild()')
  await until('open Quick Look reflects the original child completion', async () =>
    (await childRows()).some(child => child.id === 'compare-release-data' && child.state === 'completed'))
  const changedParent = await rowFacts('working')
  assert.equal(changedParent.mark, result.refinement.wide.ordinary.mark, 'A child-only completion keeps the otherwise working parent')
  assert.equal(changedParent.height, result.refinement.wide.ordinary.height, 'A child-only update preserves the parent row height')
  assert.match(changedParent.subagents.title, /2 completed/, 'The same parent row reflects the child-only change')
  assert.doesNotMatch(changedParent.subagents.title, /running/)
  result.subagents.completed = {summary: changedParent.subagents, details: await childRows(), unchangedParent: changedParent.mark}
  await key('Escape', 'Escape', 27)
  await until('Escape returns to the original row', () => read('!document.querySelector(".agent-information-reader") && document.activeElement===document.querySelector(' + JSON.stringify(first) + ')'))
  await key('Enter', 'Enter', 13)
  const workface = '.global-session-workspace [data-fixture-session="working"]'
  await until('Enter opens the original Agent workface', () => read('!!document.querySelector(' + JSON.stringify(workface) + ')'))
  const draft = () => read('document.querySelector(' + JSON.stringify(workface + ' textarea') + ')?.value')
  assert.equal(await draft(), before.drafts.working)
  const originalKey = await read('document.querySelector(' + JSON.stringify(first) + ').closest("[data-focus-card-key]").dataset.focusCardKey')
  await frame('selected-workface', 'Original selection and draft with the list and workface open')
  await click(viewButton(root, 'map'))
  await until('one Map action activates the original Map view', () => read(`Boolean(document.querySelector(${JSON.stringify(map)}))`))
  assert.equal(await read(`Boolean(document.querySelector(${JSON.stringify(map + ' button[aria-label="Task layout"]')}))`), false, 'Map does not offer a task layout control')
  await layouts.close()
  await frame('map-without-layout', 'Map is one click away and carries no task layout arrow')
  await click(viewButton(map, 'list'))
  await expectLayout('list')
  await until('returning from Map restores the original selected workface', async () => await draft() === before.drafts.working)
  assert.equal(await read('document.querySelector("[data-focus-agent-selected=true]")?.dataset.focusCardKey'), originalKey)
  result.menu = { escapeRestoredFocus: true, mapDirect: true, mapHasNoLayout: true, returnedLayout: 'list', restoredSelectedDraft: true }

  for (const width of [420, 360]) {
    const actual = await setSplitWidth(width)
    await read('document.querySelector(".focus-project-lanes__rows").scrollTop = 0')
    await settle()
    const rows = await checkList()
    assert.ok(rows.ordinary.titleFits, 'The original title remains readable in a narrow split')
    assert.equal(rows.ordinary.summary, null, 'Optional activity copy yields to the task and subagent count')
    assert.equal(rows.ordinary.subagents.count, '4', 'The narrow split keeps the exact observed subagent count visible')
    assert.equal(rows.ordinary.subagents.states, null, 'The narrow split reserves detailed state text for Quick Look')
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
  await layouts.choose('cards')
  await expectLayout('cards')
  const afterCards = await selectedVisible()
  assert.ok(afterCards.visible && afterCards.key === beforeSwitch.key, 'Card reflow preserves the visible original task')
  await read(`document.querySelector(${JSON.stringify(trigger)}).focus()`)
  await key('ArrowDown', 'ArrowDown', 40)
  await until('keyboard opens layout choices', () => read(`Boolean(document.querySelector(${JSON.stringify(menu)}))`))
  await layouts.checked('cards')
  await key('End', 'End', 35)
  await key('Enter', 'Enter', 13)
  await layouts.close()
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
