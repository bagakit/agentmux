const assert = require('node:assert/strict')

// Native operations on the existing Workbench. Expectations come from the linked SSOT.
module.exports = async function mailboxProof({ win, evaluate, waitFor, visible, painted, click, key, point, seed, capture, result, surface }) {
  const composer = `${surface}.querySelector('.composer')`, editor = `${composer}.querySelector('[role="textbox"]')`
  const trigger = `${composer}.querySelector('.composer__mailbox')`, panel = `${composer}.querySelector('.composer-mailbox')`
  const tab = name => `${panel}.querySelector('[role="tab"][id$="-${name}-tab"]')`
  const folder = name => `${panel}.querySelector('[role="tabpanel"][id$="-${name}"]')`
  const opened = `${panel}.matches(':popover-open') && ${panel}.dataset.state==='open'`
  const closed = `!${panel}.matches(':popover-open') && ${panel}.dataset.state==='closed'`
  const mouse = async target => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target, buttons: 0 })
  const away = () => mouse({ x: 2, y: 735 })
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const focus = () => evaluate(`(()=>{const s=getSelection();return{editor:document.activeElement===${editor},anchor:s?.anchorOffset,focus:s?.focusOffset,text:${editor}.textContent}})()`)
  const unread = name => evaluate(`Boolean(${tab(name)}.querySelector('.composer-mailbox__dot'))`)
  const rows = name => evaluate(`Array.from(${folder(name)}.querySelectorAll('${name === 'outbox' ? '.composer-mailbox__history ' : ''}.composer-mailbox__row[data-record-key] > .composer-mailbox__preview')).map(e=>e.textContent)`)
  async function hover() {
    await away(); await mouse(await point(trigger))
    try { await waitFor(opened) } catch (error) { assert.fail('Actual Mailbox mouse hover opens the native panel: ' + error.message) }
    await painted()
  }
  async function close() { await key('Escape', 'Escape', 27); await waitFor(closed) }
  async function choose(name) { await evaluate(`${tab(name)}.scrollIntoView({block:'nearest'})`); await click(tab(name)); await waitFor(`${tab(name)}.getAttribute('aria-selected')==='true'`); await painted() }
  async function reveal(target) {
    await evaluate(`${target}.scrollIntoView({block:'nearest',container:'nearest'})`); await painted()
    assert.equal(await evaluate(`(()=>{const target=${target},r=target.getBoundingClientRect();return target.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),true,'The actual mailbox action is visible and hit before clicking')
  }
  async function frame(width, state) {
    await painted(); const file = `${width}-composer-${state}.png`, png = await capture(file.slice(0, -4))
    result.frames.push({ width, state, file, png })
  }
  result.mailboxBehavior = []
  for (const width of [640, 320]) {
    result.stage = { width, state: 'mailbox-hover' }
    await away(); await evaluate("identityMenu.progress('inactive')"); await seed(width)
    await evaluate(`identityMenu.mailbox(${JSON.stringify(String(width))})`)
    await waitFor(visible(editor)); await click(editor)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Keep this draft and caret while checking messages.' })
    await waitFor(`${editor}.textContent.includes('Keep this draft')`)
    await waitFor(`Boolean(${tab('inbox')}.querySelector('.composer-mailbox__dot')) && Boolean(${tab('system')}.querySelector('.composer-mailbox__dot'))`)
    // New owner facts change the terminal's service-window height before this comparison begins.
    await painted(); await delay(120); await painted()
    const before = { focus: await focus(), terminal: await evaluate('identityMenu.terminal()'), facts: await evaluate('identityMenu.facts()') }
    assert.equal(before.focus.editor, true)
    await hover()
    assert.deepEqual(await focus(), before.focus, 'Hover preview preserves the actual Composer focus and caret')
    assert.equal(await unread('inbox'), true, 'Passing the trigger does not read Inbox')
    assert.equal(await unread('system'), true, 'Passing the trigger does not read System')
    assert.deepEqual(await rows('inbox'), ['incoming-new', 'incoming-old'], 'Actual Inbox puts the recent message first')
    await frame(width, 'mailbox-hover-preview')
    const gap = await evaluate(`(()=>{const a=${trigger}.getBoundingClientRect(),b=${panel}.getBoundingClientRect();return{x:a.x+a.width/2,y:(a.top+b.bottom)/2}})()`)
    await mouse(gap); await delay(60); await mouse(await point(`${panel}.querySelector('.composer-mailbox__heading')`))
    await waitFor(`!${tab('inbox')}.querySelector('.composer-mailbox__dot')`)
    assert.equal(await unread('system'), true, 'Entering Inbox leaves System unread')
    assert.deepEqual(await focus(), before.focus, 'Crossing into preview content preserves the original editor')
    await away(); await waitFor(closed)
    await hover(); await away(); await delay(60); await mouse(await point(trigger)); await delay(230)
    assert.equal(await evaluate(opened), true, 'Returning during the grace period keeps the preview open')
    await close(); assert.deepEqual(await focus(), before.focus, 'Escape from a hover preview retains its editor focus')
    await hover(); await click(trigger); await away(); await delay(230)
    assert.equal(await evaluate(opened), true, 'Clicking an already hovered trigger pins its panel')
    await click(editor); await waitFor(closed)
    assert.equal((await focus()).editor, true, 'Outside click keeps its newly focused editor')

    // Exercise an actual native IME composition while the editor remains the focused owner.
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '继续', selectionStart: 2, selectionEnd: 2 })
    const composing = await focus(); await hover()
    assert.deepEqual(await focus(), composing, 'Hover preserves the active native composition and caret')
    await away(); await waitFor(closed)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '继续' })

    await evaluate(`${trigger}.focus()`)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
      { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
    await waitFor(opened)
    await choose('outbox')
    await waitFor(`${folder('outbox')}.textContent.includes('native-without-time')`)
    const outgoing = ['timeline-new', 'native-new', 'timeline-tie-a', 'timeline-tie-b', 'native-old', 'timeline-old', 'native-without-time']
    assert.deepEqual(await rows('outbox'), outgoing, 'Actual mixed-source history is uniformly newest first with stable ties and missing time last')
    const pending = await evaluate(`Array.from(${folder('outbox')}.querySelectorAll('.composer-outbox .composer-mailbox__row[data-record-key] > .composer-mailbox__preview')).map(e=>e.textContent)`)
    assert.deepEqual(pending, ['queue-first', 'queue-second'], 'Pending messages retain their actual delivery order')
    assert.equal(await evaluate(`(${folder('outbox')}.querySelector('.composer-outbox').compareDocumentPosition(${folder('outbox')}.querySelector('.composer-mailbox__history')) & Node.DOCUMENT_POSITION_FOLLOWING)!==0`), true)
    const earlier=`([...${folder('outbox')}.querySelectorAll('.composer-mailbox__history .composer-mailbox__boundary button')].find(button=>button.textContent==='Load earlier messages'))`
    await reveal(earlier);await click(earlier)
    await waitFor(`${folder('outbox')}.textContent.includes('native-earlier')`)
    const afterEarlier = [...outgoing.slice(0, -1), 'native-earlier', outgoing.at(-1)]
    assert.deepEqual(await rows('outbox'), afterEarlier, 'Earlier paging preserves newest-first display and original missing-time entry')
    await frame(width, 'mailbox-recent-outbox')
    const copy = `([...${folder('outbox')}.querySelectorAll('.composer-outbox > button')].find(button=>button.textContent==='Copy all'))`
    await reveal(copy); await click(copy)
    await waitFor(`identityMenu.facts().clipboard.at(-1)==='queue-first\\n\\nqueue-second'`)
    assert.deepEqual((await evaluate('identityMenu.facts()')).queues, before.facts.queues, 'Copying pending messages does not reorder or send them')

    await choose('system')
    await waitFor(`!${tab('system')}.querySelector('.composer-mailbox__dot')`)
    const system = await evaluate(`Array.from(${folder('system')}.querySelectorAll('.composer-mailbox__row[data-record-key]')).map(e=>({step:e.querySelector('strong').textContent,time:e.querySelector('time')?.dateTime??null,text:e.textContent}))`)
    assert.equal(system.length, 3, 'Native System observations contain both known owners and the unknown queue')
    assert.deepEqual(system.map(item => item.time), ['2026-10-03T10:20:00.000Z', '2026-10-03T10:10:00.000Z', null])
    assert.match(system[2].text, /Time not recorded/i, 'Unknown queue time is disclosed rather than inferred from enqueuedAt')
    await frame(width, 'mailbox-recent-system')
    await evaluate(`identityMenu.mailboxConnectionTime(Date.parse('2026-10-03T10:30:00Z'))`); await painted()
    assert.equal(await unread('system'), false, 'Changing display time alone does not mark a notice unread')
    assert.equal(await evaluate(`${folder('system')}.querySelector('.composer-mailbox__row[data-record-key] time').dateTime`), '2026-10-03T10:30:00.000Z')

    await choose('progress')
    const form = `${folder('progress')}.querySelector('form')`, minutes = `${form}.querySelector('input[type="number"]')`
    await evaluate(`${minutes}.scrollIntoView({block:'nearest'})`); await click(minutes); win.webContents.selectAll()
    await key('Backspace', 'Backspace', 8); await win.webContents.insertText('23')
    await waitFor(`${minutes}.value==='23'`); await away(); await delay(230)
    assert.equal(await evaluate(opened), true, 'Editing within the panel pins it after the mouse leaves')
    await frame(width, 'mailbox-hover-edit-pinned')
    await close(); assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Escape inside content returns to the same Mailbox entry')
    const p = await point(trigger)
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await waitFor(opened); await choose('progress'); assert.equal(await evaluate(`${minutes}.value`), '23', 'Touch open and page change preserve the original unsent settings')
    await away(); await delay(230); assert.equal(await evaluate(opened), true, 'Touch opening remains usable without hover')
    await close()
    const after = { focus: await focus(), terminal: await evaluate('identityMenu.terminal()'), facts: await evaluate('identityMenu.facts()') }
    assert.deepEqual(after.terminal, before.terminal, 'Mailbox hover, sorting and editing preserve the same xterm and geometry')
    assert.deepEqual(after.facts.tab, before.facts.tab, 'Mailbox operations preserve the original Tab/Region layout')
    assert.deepEqual(after.facts.queues, before.facts.queues)
    assert.match(await evaluate(`${editor}.textContent`), /Keep this draft/)
    result.mailboxBehavior.push({ width, before, outgoing, afterEarlier, pending, system, composing, after })
  }
  result.mailboxInputs = await evaluate('identityMenu.mailboxInputs()')
  assert.ok(result.mailboxInputs.length > 0, 'Actual input observations are nonempty')
  for (const pointerType of ['mouse', 'touch']) assert.ok(result.mailboxInputs.some(event => event.trusted && event.pointerType === pointerType), 'Trusted ' + pointerType + ' inputs reach the actual product')
  assert.ok(result.mailboxInputs.some(event => event.trusted && event.type === 'compositionstart'), 'Native composition actually started')
  assert.equal(result.mailboxBehavior.length, 2)
}
