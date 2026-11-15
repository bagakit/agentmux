const assert = require('node:assert/strict')
const { focus, taskLayoutControls } = require('./task-layout-controls.cjs')

const pinned = focus + ' section[aria-label="Pinned Agents"]'
const task = id => focus + ` button.focus-context[data-session-id=${JSON.stringify(id)}]`
const workface = '.global-session-workspace'
const menuItem = '.focus-context-menu [role="menuitem"]'
const search = focus + ' input[aria-label="Search contexts"]'
const exactPins = [
  JSON.stringify(['host', 'local', 'working']),
  JSON.stringify(['runtime', 'original-other-runtime', 'working']),
]

module.exports = async function exerciseAgentPins({ win, read, until, settle, click, capture, result, restoreOnly }) {
  const renderer = win.webContents.debugger
  const layouts = taskLayoutControls({ read, until, click })
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  const pinEntries = () => read(`Array.from(document.querySelectorAll(${JSON.stringify(pinned + ' [data-focus-agent-pin]')})).map(entry => {
    const open = entry.querySelector('.focus-agent-pin__open')
    return {name: open.querySelector('strong').textContent, detail: open.querySelector(':scope > span:last-child').textContent, actionable: open.tagName === 'BUTTON'}
  })`)
  const workfaceDraft = () => read(`${query(workface + ' [data-owner-tab="ordinary-tab"][data-owner-region="ordinary-region"] textarea')}?.value`)
  const selected = () => read('window.agentPinsProof.selection()')
  const graph = () => read('window.agentPinsProof.readGraph()')
  const rowCount = () => read(`document.querySelectorAll(${JSON.stringify(focus + ' .focus-context[data-session-id]')}).length`)
  const key = async (value, code, virtualKeyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await renderer.sendCommand('Input.dispatchKeyEvent', {
      type, key: value, code, modifiers, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
      ...(type === 'keyDown' && value === 'Enter' ? {text: '\r'} : {}),
    })
    await settle()
  }
  const frame = async (file, caption) => {
    assert.ok(await read('document.documentElement.scrollWidth <= innerWidth + 1'), 'Pinned layout fits the actual window')
    await capture(file + '.png', caption)
  }
  async function taskMenu(row, keyboard = false) {
    if (keyboard) {
      await read(`${query(row)}.focus()`)
      await key('F10', 'F10', 121, 8)
    } else {
      const point = await read(`(() => {
        const button = ${query(row)}
        button.scrollIntoView({block:'nearest'})
        const rect = button.getBoundingClientRect()
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}
      })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await renderer.sendCommand('Input.dispatchMouseEvent', {type, ...point, button:'right', clickCount:1})
    }
    await until('the real Agent menu offers its pin action', () => read(`Array.from(document.querySelectorAll(${JSON.stringify(menuItem)})).some(item => /^(Pin in|Unpin from) Focus$/.test(item.textContent.trim()))`))
    return read(`Array.from(document.querySelectorAll(${JSON.stringify(menuItem)})).find(item => /^(Pin in|Unpin from) Focus$/.test(item.textContent.trim())).textContent.trim()`)
  }
  async function choosePinAction() {
    const target = await read(`(() => {
      const item = Array.from(document.querySelectorAll(${JSON.stringify(menuItem)})).find(item => /^(Pin in|Unpin from) Focus$/.test(item.textContent.trim()))
      item.dataset.agentPinsFixtureAction = ''
      return '[data-agent-pins-fixture-action]'
    })()`)
    await click(target)
    await until('the Agent pin action closes its menu', () => read(`!${query(target)}`))
  }
  async function pinControl(name, control, keyboard = false) {
    const selector = await read(`(() => {
      const entry = Array.from(document.querySelectorAll(${JSON.stringify(pinned + ' [data-focus-agent-pin]')}))
        .find(item => item.querySelector('.focus-agent-pin__open strong')?.textContent === ${JSON.stringify(name)})
      const button = entry?.querySelector(${JSON.stringify(control)})
      if (!button) return null
      button.dataset.agentPinsFixtureControl = ''
      return '[data-agent-pins-fixture-control]'
    })()`)
    assert.ok(selector, `The original shortcut exposes ${control}`)
    if (keyboard) {
      await read(`${query(selector)}.focus()`)
      await key('Enter', 'Enter', 13)
    } else await click(selector)
    await read(`${query(selector)}?.removeAttribute('data-agent-pins-fixture-control')`)
  }
  async function filter(text) {
    await read(`${query(search)}.focus(); ${query(search)}.select()`)
    if (text) await renderer.sendCommand('Input.insertText', { text })
    else await key('Backspace', 'Backspace', 8)
    await settle()
  }

  await until('both synthetic Agents have actual Focus rows', () => read(`window.agentPinsProof && !!${query(task('working'))} && Array.from(document.querySelectorAll(${JSON.stringify(focus + ' .focus-context')})).some(row => row.querySelector('strong')?.textContent === window.unifiedFocusProof.foreignName)`))
  const { localName, foreignName } = await read('({localName:window.unifiedFocusProof.localName, foreignName:window.unifiedFocusProof.foreignName})')
  const bothNames = [localName, foreignName]
  const foreignTask = task(await read(`Array.from(document.querySelectorAll(${JSON.stringify(focus + ' .focus-context')})).find(row => row.querySelector('strong')?.textContent === window.unifiedFocusProof.foreignName).dataset.sessionId`))
  const originalPins = async () => {
    await until('both original pin shortcuts are usable', async () => {
      const entries = await pinEntries()
      return entries.length === bothNames.length && entries.every((entry,index) => entry.actionable && entry.name === bothNames[index])
    })
  }
  assert.equal(await read('window.agentPinsProof.restored'), restoreOnly)
  if (restoreOnly) {
    await originalPins()
    result.pins = await read('window.agentPinsProof.checkpoint()')
    assert.deepEqual(result.pins, exactPins)
    result.topology = await graph()
    result.layout = await read(`${query(focus)}.dataset.taskLayout`)
    assert.equal(result.layout, 'list')
    await frame('restored-pins', 'Both exact Agent pins are present after restarting the private Electron app')
    result.passed = true
    return
  }

  assert.deepEqual(await pinEntries(), [])
  const originalFacts = await read('window.unifiedFocusProof.facts()')
  await click(task('working'))
  await until('original local workface with its draft', async () => await workfaceDraft() === originalFacts.drafts.working)
  const localSelection = await selected()
  const originalRowCount = await rowCount()
  assert.equal(await taskMenu(task('working')), 'Pin in Focus')
  await frame('pin-menu-cards', 'The original Cards menu exposes the specific Agent pin action')
  await choosePinAction()
  await until('pin appears without replacing a task', async () => (await pinEntries()).length === 1)
  assert.deepEqual(await selected(), localSelection, 'Pinning does not select a new workface')
  assert.equal(await rowCount(), originalRowCount, 'Pinning leaves the original Task rows intact')

  await layouts.choose('list')
  assert.equal(await taskMenu(foreignTask, true), 'Pin in Focus', 'A same-SID Agent on another Runtime remains independently pinnable')
  await choosePinAction()
  await originalPins()
  assert.equal(await rowCount(), originalRowCount, 'Two shortcuts preserve the same Task rows')
  assert.deepEqual(await selected(), localSelection)
  await frame('both-pins-list', 'Two same-SID Agents have distinct shortcuts above their original task rows')

  await filter(foreignName)
  await until('the filter narrows the pin list to the original Source task', async () => {
    const entries = await pinEntries()
    return entries.length === 1 && entries[0].name === foreignName
  })
  await frame('pins-filtered', 'The original Focus search narrows the shortcuts without deleting preferences')
  assert.deepEqual(await read('window.agentPinsProof.checkpoint()'), exactPins)
  await filter('')
  await originalPins()

  await pinControl(foreignName, 'button.focus-agent-pin__open')
  const exactSourceRegions = ['source-region-3', 'source-region-5'].map(regionId =>
    JSON.stringify(['original-local-runtime', 'original-project-space', 'source-tab-3', regionId]))
  const shownSourceRegions = () => read(`Array.from(document.querySelectorAll(${JSON.stringify(workface + ' [data-source-region]')})).map(region => region.dataset.sourceRegion).sort()`)
  await until('Source pin opens both original Regions in its original mixed Tab', async () =>
    JSON.stringify(await shownSourceRegions()) === JSON.stringify(exactSourceRegions))
  await frame('pin-source-workface', 'The Source shortcut opens its original mixed workface')
  await pinControl(localName, 'button.focus-agent-pin__open')
  await until('local pin returns to the original local Region and unsent draft', async () => await workfaceDraft() === originalFacts.drafts.working)
  assert.deepEqual(await selected(), localSelection)
  result.navigation = {sourceTab: 'source-tab-3', sourceRegions: exactSourceRegions, localTab: 'ordinary-tab', localRegion: 'ordinary-region', originalDraft: true}

  assert.equal(await taskMenu(task('reading'), true), 'Pin in Focus')
  await choosePinAction()
  await until('third pin appears before its observation goes away', async () => (await pinEntries()).length === 3)
  await read('window.agentPinsProof.observeReading(false)')
  await until('temporarily unobserved original pin remains removable', async () =>
    (await pinEntries()).some(entry => entry.name === 'Agent · reading' && entry.detail === 'Unavailable' && !entry.actionable))
  assert.equal(await workfaceDraft(), originalFacts.drafts.working)
  win.setContentSize(440, 810)
  await read('window.unifiedFocusProof.theme("light")')
  const removeUnknown = 'button[aria-label="Unpin Agent · reading from Focus"]'
  await settle()
  const removeSource = pinned + ` button[aria-label=${JSON.stringify(`Unpin ${foreignName} from Focus`)}]`
  await read(`${query(removeSource)}.focus()`)
  await key('Tab', 'Tab', 9)
  const unknownControl = query(pinned + ' ' + removeUnknown)
  assert.ok(await read(`document.activeElement === ${unknownControl} && ${unknownControl}.matches(':focus-visible')`),
    'Tab visibly focuses the unavailable pin’s removal action')
  await frame('unavailable-pin-440', 'An unobserved pin retains a visible cancellation action and no substitute navigation')
  await pinControl('Agent · reading', removeUnknown, true)
  await originalPins()
  await until('removing a focused shortcut preserves keyboard navigation', () => read(`Boolean(document.activeElement?.closest(${JSON.stringify(pinned)})) || document.activeElement === ${query(search)}`))
  await read('window.agentPinsProof.observeReading(true)')
  await until('the original task can be observed after the pin is removed', () => read(`Boolean(${query(task('reading'))})`))
  win.setContentSize(1100, 850)
  await settle()
  assert.equal(await taskMenu(foreignTask, true), 'Unpin from Focus')
  await choosePinAction()
  await until('the exact Source preference is removed by its menu', async () => {
    const entries = await pinEntries()
    return entries.length === 1 && entries[0].name === localName
  })
  assert.equal(await taskMenu(foreignTask, true), 'Pin in Focus')
  await choosePinAction()
  await originalPins()
  await frame('pins-restored-filter', 'Restored shortcuts preserve their ordering and the original local workface')

  const after = await read('window.unifiedFocusProof.facts()')
  assert.deepEqual(after.runs, originalFacts.runs)
  assert.deepEqual(after.drafts, originalFacts.drafts)
  assert.deepEqual(await selected(), localSelection)
  assert.equal(await rowCount(), originalRowCount)
  result.pins = await read('window.agentPinsProof.checkpoint()')
  assert.deepEqual(result.pins, exactPins)
  result.topology = await graph()
  result.unavailable = { retained: true, removable: true, reobserved: true, keyboardFocusVisible: true, focusPreserved: true }
  result.filtered = { retainedOriginalPreferences: true, restoredExactShortcuts: true }
  result.layout = 'list'
  result.passed = true
}
