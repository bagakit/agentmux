const assert = require('node:assert/strict')

module.exports = async function ({ win, evaluate, waitFor, visible, painted, click, key, seed, capture, result, surface }) {
  const composer = `${surface}.querySelector('.composer')`, editor = `${composer}.querySelector('[role="textbox"]')`
  const panel = `${composer}.querySelector('.composer-mailbox')`, trigger = `${composer}.querySelector('.composer__mailbox')`
  const content = `${panel}.querySelector('.composer-mailbox__content')`
  const tab = name => `${panel}.querySelector('[role="tab"][id$="-${name}-tab"]')`
  const folder = name => `${panel}.querySelector('[role="tabpanel"][id$="-${name}"]')`
  const rows = name => `${folder(name)}.querySelectorAll('button[data-record-key^="a2a:"]')`
  const opened = `${panel}.matches(':popover-open') && ${panel}.dataset.state==='open'`
  const draft = '保留这份原草稿。 Review the original message before acting.'
  result.mailboxLayout = []; result.captureOnly = true; result.aestheticReview = 'not-performed'
  async function enter() {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
      { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
  }
  async function reveal(target) {
    await evaluate(`${target}.scrollIntoView({block:'nearest',container:'nearest'})`); await painted()
    assert.equal(await evaluate(`(() => {const n=${target},r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return n===hit||n.contains(hit)})()`), true, 'The original mailbox action is visible and hit')
  }
  async function choose(name) { await click(tab(name)); await waitFor(`${tab(name)}.getAttribute('aria-selected')==='true'`); await painted() }
  async function frame(width, theme, state) {
    await painted(); const file = `${width}-mailbox-${theme}-${state}.png`, png = await capture(file.slice(0, -4))
    result.frames.push({ width, state: `${theme}-${state}`, file, png })
  }
  async function preserve(expected, expectedDraft = draft) {
    const observed = await evaluate(`({sameEditor:window.mailboxLayoutEditor===${editor},draft:identityMenu.facts().drafts[${JSON.stringify(expected.sessionId)}],terminal:identityMenu.terminal(),queues:identityMenu.facts().queues})`)
    assert.equal(observed.sameEditor, true, 'Mailbox reading keeps the same production editor node')
    assert.equal(observed.draft, expectedDraft, 'Mailbox reading keeps the original unsent draft')
    assert.deepEqual(observed.terminal, expected.terminal, 'Mailbox reading keeps the original terminal and geometry')
    assert.deepEqual(observed.queues, expected.queues, 'Mailbox reading never dispatches or reorders original pending inputs')
  }
  for (const theme of ['dark', 'light']) for (const width of [640, 380, 320]) {
    result.stage = { width, theme, phase: 'inbox' }
    await evaluate(`identityMenu.appearance(${JSON.stringify(theme)})`); await seed(width)
    const original = await evaluate(`identityMenu.mailboxLayout(${JSON.stringify(`${theme}-${width}`)})`)
    await evaluate("identityMenu.progress('inactive')")
    await waitFor(visible(editor)); await click(editor)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    await win.webContents.debugger.sendCommand('Input.insertText', { text: draft }); await waitFor(`${editor}.textContent===${JSON.stringify(draft)}`)
    await painted(); await evaluate(`window.mailboxLayoutEditor=${editor}`)
    const before = await evaluate(`({sessionId:${JSON.stringify(original.agentSessionId)},terminal:identityMenu.terminal(),queues:identityMenu.facts().queues})`)
    await evaluate(`${trigger}.focus()`); await enter(); await waitFor(opened); await painted(); await choose('inbox')
    await waitFor(`${rows('inbox')}.length===25`)
    const nav = await evaluate(`(() => {const p=${panel},n=p.querySelector('[role="tablist"]'),r=p.getBoundingClientRect();return {display:getComputedStyle(n).display,panel:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},tabs:[...n.querySelectorAll('[role="tab"]')].map(b=>{const l=b.querySelector('.composer-mailbox__folder-label'),r=b.getBoundingClientRect();return {label:l.textContent,width:r.width,left:r.left,top:r.top,right:r.right,bottom:r.bottom,complete:l.scrollWidth<=l.clientWidth+1}})}})()`)
    assert.deepEqual(nav.tabs.map(item => item.label).sort(), ['A2A Inbox', 'A2A Outbox', 'User Messages', 'Notices', 'Collaboration', 'Progress'].sort())
    assert.ok(nav.tabs.every(item => item.complete && item.left >= nav.panel.left && item.right <= nav.panel.right), 'All six full navigation labels fit their own cells')
    assert.ok(Math.max(...nav.tabs.map(item => item.width)) - Math.min(...nav.tabs.map(item => item.width)) <= 1, 'Mailbox navigation cells have consistent columns')
    const columns = new Set(nav.tabs.map(item => Math.round(item.left))).size
    assert.equal(columns, width === 320 ? 2 : 3, 'Mailbox navigation uses the original regular grid geometry at the available width')
    const calls = await evaluate('identityMenu.mailboxLayoutFacts().calls')
    assert.equal(calls.filter(item => item.action === 'read').length, 0, 'Metadata lists never read a full body per row')
    const top = `${folder('inbox')}.querySelector('button[data-record-key=${JSON.stringify('a2a:' + original.incoming)}]')`
    const card = await evaluate(`(() => {const row=${top},frame=row.parentElement;return {key:row.dataset.recordKey,text:row.textContent,preview:row.querySelector('.composer-mailbox__preview').textContent,avatar:row.querySelector('.composer-mailbox__row-head').firstElementChild.tagName,time:row.querySelector('time')?.dateTime,actions:frame.querySelectorAll('.composer-mailbox__record-footer button').length,nested:row.querySelectorAll('button,input,a').length}})()`)
    assert.ok(card.preview.length <= 240 && card.preview.startsWith('第27封'), 'A2A summary uses the bounded original metadata body')
    assert.ok(card.avatar !== 'STRONG' && card.time && card.actions >= 2 && card.nested === 0, 'Original avatar/time and independent record actions render')
    assert.ok(!card.text.includes(original.incoming), 'Full message IDs remain in original Info rather than the list')
    await frame(width, theme, 'inbox')
    const earlier = `([...${folder('inbox')}.querySelectorAll('button')].find(n=>n.textContent==='Read earlier messages'))`
    await reveal(earlier); await click(earlier); await waitFor(`${rows('inbox')}.length===27`)
    assert.equal((await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read').length, 0)
    await reveal(top); await evaluate(`${top}.focus()`); await enter()
    await waitFor(`${folder('inbox')}.querySelector('[data-message-id=${JSON.stringify(original.incoming)}] .log-turn__body')?.textContent.includes('原文唯一尾段')`)
    const reads = (await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read')
    assert.equal(reads.length, 1); assert.equal(reads[0].messageId, original.incoming); assert.deepEqual(reads[0].reference, { hostId: original.hostId, agentSessionId: original.agentSessionId })
    const details = `${folder('inbox')}.querySelector('[aria-label="Message details"]')`
    await reveal(details); await click(details); await waitFor(`${folder('inbox')}.querySelector('.conversation-input-details__body').textContent.includes(${JSON.stringify(original.incoming)})`)
    if (width === 380 && theme === 'dark') await frame(width, theme, 'a2a-info')
    const copy = `${folder('inbox')}.querySelector('[aria-label="Copy message"]')`
    await reveal(copy); await click(copy); await waitFor(`identityMenu.facts().clipboard.at(-1)===${JSON.stringify(original.body)}`)
    const back = `${panel}.querySelector('.composer-mailbox__back button')`
    await evaluate(`${back}.focus()`); await enter(); await waitFor(`${rows('inbox')}.length===27`)
    await waitFor(`document.activeElement===${top}`)
    await preserve(before)
    // Six pages are real consumers; keep Progress' first-mounted form and unsaved settings.
    await choose('progress')
    const settings = `${folder('progress')}.querySelector('[data-progress-details="interval"]')`
    await waitFor(visible(`${settings}.querySelector('summary')`))
    if (!await evaluate(`${settings}.open`)) await click(`${settings}.querySelector('summary')`)
    const minutes = `${folder('progress')}.querySelector('input[type="number"]')`
    await waitFor(visible(minutes)); await reveal(minutes); await click(minutes); win.webContents.selectAll(); await key('Backspace', 'Backspace', 8); await win.webContents.insertText('23')
    await waitFor(`${minutes}.value==='23'`); await evaluate(`window.mailboxLayoutProgress=${minutes}`)
    const subscribers = await evaluate('identityMenu.progressFacts().subscribers')
    for (const name of ['outbox', 'user', 'system', 'collaboration', 'progress']) {
      result.stage = { width, theme, phase: name }; await choose(name)
      if (name === 'outbox') await waitFor(`${rows(name)}.length===3`)
      if (name === 'user') {
        await waitFor(`${folder(name)}.querySelectorAll('[data-input-mailbox-key]').length===2`)
        assert.equal(await evaluate(`${folder(name)}.querySelectorAll('[data-input-mailbox-key] button[data-record-key][aria-expanded]').length`), 2, 'Desktop input journal consumes the shared compact record frame')
      }
      if (name === 'system') await waitFor(`${folder(name)}.querySelector('.composer-notice')`)
      if (name === 'collaboration') await waitFor(`${folder(name)}.querySelector('[data-source-message]')`)
      assert.equal(await evaluate(`${folder(name)}.hidden`), false)
      if (width === 380 && theme === 'dark') await frame(width, theme, name)
    }
    assert.equal(await evaluate(`window.mailboxLayoutProgress===${minutes} && ${minutes}.value==='23'`), true, 'Progress retains its original input node and unsaved value across all pages')
    assert.equal(await evaluate('identityMenu.progressFacts().subscribers'), subscribers, 'Page changes do not duplicate Progress observers')
    // Roving native keyboard navigation retains exact selected tab and the original editor.
    await evaluate(`${tab('progress')}.focus()`); await key('Home', 'Home', 36); await waitFor(`document.activeElement===${tab('inbox')}`)
    await key('End', 'End', 35); await waitFor(`document.activeElement===${tab('progress')}`)
    await preserve(before)
    if (width === 380 && theme === 'dark') {
      await choose('user')
      const journal = `${folder('user')}.querySelector('[data-input-mailbox-key]')`, disclosure = `${journal}.querySelector('button[data-record-key]')`
      await waitFor(visible(disclosure)); await reveal(disclosure); await click(disclosure)
      await waitFor(`${journal}.querySelector('.log-turn__body')?.textContent.includes('作者自己写下的原始标记')`)
      assert.equal(await evaluate(`${journal}.querySelector('.log-turn__body').textContent.includes('<amux>作者自己写下的原始标记，不能再次解包</amux>')`), true, 'Body-boundary authored tags remain literal text')
      assert.equal(await evaluate(`${disclosure}.getAttribute('aria-expanded')`), 'true')
      const journalCopy = `${journal}.querySelector('[aria-label="Copy message"]')`
      await reveal(journalCopy); await click(journalCopy); await waitFor('identityMenu.facts().clipboard.at(-1)===identityMenu.mailboxLayoutFacts().inputCopies[0]')
      await frame(width, theme, 'journal-detail')
      await reveal(disclosure); await click(disclosure); await waitFor(`!${journal}.querySelector('.log-turn__body')`)
      const wireJournal = `${folder('user')}.querySelectorAll('[data-input-mailbox-key]')[1]`, wireDisclosure = `${wireJournal}.querySelector('button[data-record-key]')`
      await reveal(wireDisclosure); await click(wireDisclosure)
      await waitFor(`${wireJournal}.querySelector('.log-turn__body')?.textContent.includes('原文唯一尾段-dark-380-202-完整保留')`)
      assert.equal(await evaluate(`${wireJournal}.querySelector('.log-turn__declared-context pre')?.textContent`), '<amux>原平台上下文-dark-380</amux>', 'Wire boundary retains its wrapper in the original context disclosure')
      const wireCopy = `${wireJournal}.querySelector('[aria-label="Copy message"]')`
      await reveal(wireCopy); await click(wireCopy); await waitFor('identityMenu.facts().clipboard.at(-1)===identityMenu.mailboxLayoutFacts().inputCopies[1]')
      await reveal(wireDisclosure); await click(wireDisclosure); await waitFor(`!${wireJournal}.querySelector('.log-turn__body')`)
      // Fill remains an explicit action on the same original MID, preserving existing draft text.
      await choose('inbox'); await reveal(top)
      const fill = `${top}.parentElement.querySelector('[aria-label="填入草稿"]')`
      await reveal(fill); await click(fill); await waitFor(`${editor}.textContent.includes('原文唯一尾段')`)
      const filled = await evaluate(`identityMenu.facts().drafts[${JSON.stringify(original.agentSessionId)}]`)
      assert.ok(filled.includes(draft) && filled.includes(original.body))
      assert.equal(await evaluate(`window.mailboxLayoutEditor===${editor}`), true, 'Explicit Fill keeps the original editor node')
      assert.equal((await evaluate('identityMenu.terminal()')).id, before.terminal.id, 'Explicit Fill keeps the original terminal while the longer draft may grow')
      assert.deepEqual(await evaluate('identityMenu.facts().queues'), before.queues)
    }
    if (width === 320 && theme === 'dark') {
      await choose('inbox')
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: 550, deviceScaleFactor: 1, mobile: false }); await painted()
      const short = await evaluate(`(() => {const p=${panel},body=${content},close=p.querySelector('[aria-label="Close mailbox"]'),row=${top};return {panel:p.getBoundingClientRect().toJSON(),content:body.getBoundingClientRect().toJSON(),close:close.getBoundingClientRect().toJSON(),row:row.getBoundingClientRect().toJSON()}})()`)
      assert.ok(short.content.height > 80 && short.close.top >= 0 && short.panel.bottom <= 550, 'The short mailbox keeps Close and a usable reading viewport')
      await evaluate(`${content}.scrollTop=0`); await frame(width, theme, 'short')
    }
    // Explicit Fill hands focus back to the editor; Escape belongs to the mailbox only inside it.
    await evaluate(`${panel}.querySelector('[aria-label="Close mailbox"]').focus()`)
    await key('Escape', 'Escape', 27); await waitFor(`!${panel}.matches(':popover-open')`)
    result.mailboxLayout.push({ width, theme, nav, card, original: { hostId: original.hostId, agentSessionId: original.agentSessionId, messageId: original.incoming }, calls: await evaluate('identityMenu.mailboxLayoutFacts().calls') })
  }
  assert.equal(result.mailboxLayout.length, 6)
}
