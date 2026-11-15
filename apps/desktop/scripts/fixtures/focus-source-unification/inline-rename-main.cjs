const assert = require('node:assert/strict')
const { focus, taskLayoutControls } = require('./task-layout-controls.cjs')

module.exports = async function exerciseInlineRename({ win, read, until, settle, click, capture, result }) {
  const card = focus + ' button.focus-context[data-session-id="working"]'
  const editor = focus + ' .focus-context__rename'
  const search = focus + ' input[aria-label="Search contexts"]'
  const draft = 'Mote 恢复与界面改进'
  const original = '另一个编辑者确认的名称'
  const finalListName = 'Mote 恢复与界面改进 · Focus'
  const laterName = 'Mote 窗口与检索体验'
  const pendingCloseName = 'Mote 原名称仍可追踪'
  const renderer = win.webContents.debugger
  const pointer = (type, point, button) => renderer.sendCommand('Input.dispatchMouseEvent', {
    type, ...point, button, clickCount: 1
  })
  const key = async (value, code, virtualKeyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await renderer.sendCommand('Input.dispatchKeyEvent', {
      type, key: value, code, modifiers, windowsVirtualKeyCode: virtualKeyCode,
      ...(type === 'keyDown' && value === 'Enter' ? { text: '\r' } : {}),
    })
  }
  const setSize = async (width, theme, motion) => {
    win.setContentSize(width, 820)
    await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`)
    await renderer.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:motion}] })
    await settle()
  }
  const control = async name => {
    const selector = await read(`(() => {
      const row = document.querySelector(${JSON.stringify(editor)})?.closest('.focus-context--renaming')
      const target = [...(row?.querySelectorAll('button') ?? []),...document.querySelectorAll('.workbench-tab-rename-feedback button')].find(button =>
        button.getAttribute('aria-label') === ${JSON.stringify(name)} || button.textContent.trim() === ${JSON.stringify(name)})
      if (!target) return null
      target.dataset.inlineRenameFixtureControl = ''
      return '[data-inline-rename-fixture-control]'
    })()`)
    assert.ok(selector, 'Actual inline name control ' + name)
    await click(selector)
    await read("document.querySelector('[data-inline-rename-fixture-control]')?.removeAttribute('data-inline-rename-fixture-control')")
  }
  const open = async () => {
    const point = await read(`(() => {
      const button = document.querySelector(${JSON.stringify(card)})
      button.scrollIntoView({block:'nearest'})
      const r = button.getBoundingClientRect()
      return {x:r.x+r.width/2,y:r.y+r.height/2}
    })()`)
    for (const type of ['mousePressed','mouseReleased']) await pointer(type, point, 'right')
    await until('original Agent name action', () => read(`(() => {
      const item = [...document.querySelectorAll('.focus-context-menu [role="menuitem"]')]
        .find(item => item.textContent.trim() === 'Rename Agent')
      if (!item) return false
      item.dataset.inlineRenameFixtureMenu = ''
      return true
    })()`))
    await click('[data-inline-rename-fixture-menu]')
    await until('name editor owns the original focus', () => read(`document.activeElement === document.querySelector(${JSON.stringify(editor)})`))
  }
  const writeDraft = async value => {
    await key('a', 'KeyA', 65, 4)
    await renderer.sendCommand('Input.insertText', { text: value })
    await until('original edit keeps the exact draft', () => read(`document.querySelector(${JSON.stringify(editor)})?.value === ${JSON.stringify(value)}`))
  }
  const facts = () => read('window.inlineRenameProof.facts()')
  const awaitRequest = async count => {
    await until('name owner receives the intended write ' + count, async () => (await facts()).requests.length >= count)
    const requests = (await facts()).requests
    assert.equal(requests.length, count, 'Each explicit edit dispatches once')
    assert.deepEqual(requests.at(-1).target, {kind:'agent-session',id:'working'})
    return requests.at(-1)
  }
  const visibleText = text => read(`document.body.innerText.includes(${JSON.stringify(text)})`)
  const release = result => read(`window.inlineRenameProof.release(${JSON.stringify(result)})`)
  const focusedCard = () => read(`!document.querySelector(${JSON.stringify(editor)}) && document.activeElement === document.querySelector(${JSON.stringify(card)})`)
  const frame = async (file, label) => {
    assert.equal(await read('document.documentElement.scrollWidth > innerWidth + 1'), false)
    await capture(file + '.png', label)
  }

  await until('private name owner and original card', () => read(`window.inlineRenameProof && !!document.querySelector(${JSON.stringify(card)})`))
  await setSize(960, 'dark', 'no-preference')
  const initial = await facts()
  assert.ok(initial.sessions.some(session => session.agentSessionId === 'working' && session.runId === 'original-run-working'))
  assert.ok(initial.workface.regions.some(region => region.id === 'ordinary-region' && region.sessionId === 'working'))
  assert.equal(initial.originalDraft, '原未发送草稿')
  await open()
  await writeDraft('仅取消此编辑')
  await control('Cancel rename')
  await until('Cancel returns focus to the same Agent', focusedCard)
  assert.equal((await facts()).requests.length, 0)

  await open()
  await writeDraft(draft)
  await control('Save name')
  const attempt = await awaitRequest(1)
  assert.equal(attempt.value, draft)
  await until('pending edit announces the wait', () => visibleText('Saving name…'))
  assert.equal((await facts()).name, initial.name)
  await frame('rename-saving-cards', 'Pending original name change, keep editable draft and visible exit')
  await release('unavailable')
  await until('original failure appears in place', () => visibleText('The original name store did not respond.'))
  assert.equal(await read(`document.querySelector(${JSON.stringify(editor)}).value`), draft)
  await frame('rename-failed-cards', 'Original name owner failure and local draft beside its recovery control')

  await setSize(360, 'light', 'reduce')
  await read(`window.inlineRenameProof.competingName(${JSON.stringify(original)})`)
  const beforeCheck = await facts()
  await control('Check current name')
  await until('check reads the original owner', async () => (await facts()).readCount > beforeCheck.readCount)
  await until('check discloses the current name', () => read(`document.querySelector(${JSON.stringify(focus + ' .focus-context__rename-feedback')})?.textContent.includes(${JSON.stringify(original)})`))
  assert.equal((await facts()).requests.length, 1, 'Check did not replay the unknown attempt')
  assert.equal(await read(`document.querySelector(${JSON.stringify(editor)}).value`), draft)
  await frame('rename-reviewed-360', 'Narrow room for current name, original draft and explicit save')

  await control('Save name')
  const second = await awaitRequest(2)
  assert.equal(second.value, draft)
  assert.equal(second.expectedNameRevision, beforeCheck.label.nameRevision)
  assert.notEqual(second.operationId, attempt.operationId)
  await release('unconfirmed')
  await until('the applied name offers exact confirmation', () => visibleText('Confirm saved name'))
  await frame('rename-confirm-360', 'Applied name with a precise durability confirmation action')
  assert.equal((await facts()).requests.length, 2)
  await control('Confirm saved name')
  await until('original receipt restores focus to its card', focusedCard)
  const confirmed = await facts()
  assert.equal(confirmed.name, draft)
  assert.deepEqual(confirmed.confirms, [second.operationId])
  assert.equal(confirmed.requests.length, 2)
  await frame('rename-confirmed-360', 'Original Agent row restored with its confirmed name and focus')

  await setSize(420, 'light', 'reduce')
  await taskLayoutControls({ read, until, click }).choose('list')
  await until('actual list row enabled', () => read(`document.querySelector(${JSON.stringify(card)})?.classList.contains('focus-context--list')`))
  await open()
  await writeDraft(finalListName)
  await key('Enter','Enter',13)
  const third = await awaitRequest(3)
  assert.equal(third.value, finalListName)
  await until('List editor announces its pending save', () => visibleText('Saving name…'))
  await frame('rename-saving-list-420', 'One expanded List row while the original owner is responding')
  await release('confirmed')
  await until('keyboard save returns to its original List row', focusedCard)
  const saved = await facts()
  assert.equal(saved.name, finalListName)
  assert.equal(saved.label.value, finalListName)
  assert.equal(saved.originalDraft, initial.originalDraft)
  assert.deepEqual(saved.sessions, initial.sessions)
  assert.deepEqual(saved.workface, initial.workface)
  await frame('rename-saved-list-420', 'Real List rename by keyboard and original task focus')

  await open()
  await writeDraft(laterName)
  await click(search)
  await until('blur retains the draft and transfers focus to Search', () => read(`document.activeElement === document.querySelector(${JSON.stringify(search)}) && document.querySelector(${JSON.stringify(editor)})?.value === ${JSON.stringify(laterName)}`))
  assert.equal((await facts()).requests.length, 3, 'Moving focus did not save')
  await control('Save name')
  const fourth = await awaitRequest(4)
  assert.equal(fourth.value, laterName)
  await click(search)
  await release('confirmed')
  await until('the later save reaches the original List row', () => read(`!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(card)})?.textContent.includes(${JSON.stringify(laterName)})`))
  const later = await facts()
  assert.equal(later.name, laterName)
  assert.equal(await read(`document.activeElement === document.querySelector(${JSON.stringify(search)})`), true)
  await frame('rename-kept-search-focus-420', 'Confirmed rename leaves the later explicit Search focus intact')

  await open()
  await writeDraft(pendingCloseName)
  await key('Enter','Enter',13)
  const fifth = await awaitRequest(5)
  assert.equal(fifth.value, pendingCloseName)
  await control('Close rename editor')
  await until('closing the pending editor returns to its original List row', focusedCard)
  assert.equal((await facts()).name, laterName)
  await release('confirmed')
  await until('the original save can still settle after the editor closes', () => read(`!document.querySelector(${JSON.stringify(editor)}) && document.querySelector(${JSON.stringify(card)})?.textContent.includes(${JSON.stringify(pendingCloseName)})`))
  const closed = await facts()
  assert.equal(closed.name, pendingCloseName)
  assert.deepEqual(closed.sessions, initial.sessions)
  assert.deepEqual(closed.workface, initial.workface)
  assert.equal(closed.originalDraft, initial.originalDraft)
  result.rename = { before: initial, failed: beforeCheck, confirmed, saved, later, closed, exactFocus: true, laterFocusKept: true, automaticReplay: false }
  result.passed = true
}
