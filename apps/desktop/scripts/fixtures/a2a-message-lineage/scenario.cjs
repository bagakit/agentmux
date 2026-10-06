const assert = require('node:assert/strict')
module.exports = async ({ win, read, settle, until, press, frame, result }) => {
  win.webContents.debugger.attach('1.3')
  const evaluate = expression => win.webContents.executeJavaScript(expression)
  const selector = '.agent-surface .composer-mailbox'
  const click = async target => {
    const point = await evaluate(`(() => {const n=document.querySelector(${JSON.stringify(target)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point }); await settle()
  }
  const button = text => evaluate(`(() => {const n=[...document.querySelectorAll('${selector} button')].find(n=>n.textContent==='${text}');n.dataset.nativeClick='current'})()`)
  const clickText = async text => { await button(text); await click('[data-native-click="current"]'); await evaluate('document.querySelector("[data-native-click]")?.removeAttribute("data-native-click")') }
  const geometry = async () => {
    const value = await evaluate(`(() => {const p=document.querySelector('${selector}'),c=document.querySelector('.composer'),b=p.querySelector('.composer-mailbox__content');const r=p.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,composerTop:c.getBoundingClientRect().top,bodyWidth:b.clientWidth,bodyScroll:b.scrollWidth,scroll:b.scrollTop}})()`)
    assert.ok(value.left >= -1 && value.right <= value.width + 1 && value.top >= -1 && value.bottom <= value.composerTop + 1)
    assert.ok(value.bodyScroll <= value.bodyWidth + 1); return value
  }
  await until(() => window.collaborationFixture && document.querySelector('.composer__mailbox'))
  const original = await read(() => window.collaborationFixture.facts())
  const colors = new Map()
  for (const width of [700, 390, 320]) {
    win.setContentSize(width, 860); await settle()
    for (const mode of ['dark', 'light']) {
      await evaluate(`window.collaborationFixture.theme('${mode}')`); await settle()
      assert.equal(await read(() => document.documentElement.dataset.appearance), mode)
      const color = await read(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1'))
      if (mode === 'dark') colors.set(width, color); else assert.notEqual(color, colors.get(width), 'Original theme tokens must actually change')
      if (!await evaluate(`document.querySelector('${selector}').matches(':popover-open')`)) await click('.composer__mailbox')
      await click(`${selector} [id$="-collaboration-tab"]`)
      await until(() => document.querySelector('[data-source-message="original-source-1"]'))
      assert.equal(await read(() => { const use=document.querySelector('.composer-mailbox [aria-label="Close mailbox"] svg use');return Boolean(use&&document.getElementById(use.getAttribute('href').slice(1))?.childElementCount&&use.getBBox().width>0) }), true)
      if (width === 700) { await geometry(); await frame(`collaboration-list-${mode}-${width}.png`) }
      await click('[data-source-message="original-source-1"]')
      await until(() => document.querySelector('[data-dispatch-source="original-source-1"]'))
      await click('[data-message-id="original-source-1"] > summary')
      await until(() => document.querySelector('[data-message-id="original-source-1"] .log-turn__body'))
      assert.notEqual(await read(() => getComputedStyle(document.querySelector('[data-message-id="original-source-1"] > summary'),'::before').maskImage), 'none')
      await geometry(); await frame(`collaboration-detail-${mode}-${width}.png`)
      await clickText('Back to collaboration')
      result.operations.push({ width, mode, originalWorkbenchSessionPaneComposerMailbox: true, nativeOriginalFolder: true, originalSourceDisclosure: true, withinAvailableSpace: true })
    }
  }
  await evaluate('window.collaborationFixture.failNextPage()'); await clickText('Load more collaboration records')
  await until(() => document.querySelector('[aria-label="Retry collaboration list"]'))
  await click('[aria-label="Retry collaboration list"]'); await until(() => document.querySelector('[data-source-message="original-source-25"]'))
  await click('[data-source-message="original-source-25"]'); await until(() => document.querySelector('[data-dispatch-source="original-source-25"]'))
  assert.equal(await evaluate(`document.querySelector('${selector} .composer-mailbox__content').scrollTop`), 0)
  await click('[data-message-id="original-source-25"] > summary')
  await until(() => document.querySelector('[data-message-id="original-source-25"] .log-turn__body'))
  await evaluate(`(() => {const d=document.querySelector('[data-message-id="original-source-25"]');window.originalCollaborationDetail=d;const r=document.createRange();r.selectNodeContents(d.querySelector('.log-turn__body'));getSelection().removeAllRanges();getSelection().addRange(r);window.originalCollaborationSelection=getSelection().toString()})()`)
  await evaluate('window.collaborationFixture.report()')
  await evaluate(`Array.from(document.querySelectorAll('${selector} button')).find(n=>n.textContent==='Refresh records').focus({preventScroll:true})`); await press('Enter')
  await until(() => document.querySelector('[data-message-id="original-report"]'))
  assert.equal(await read(() => document.querySelector('[data-message-id="original-source-25"]') === window.originalCollaborationDetail), true)
  assert.equal(await read(() => getSelection().toString() === window.originalCollaborationSelection && getSelection().toString().length > 0), true)
  await frame('collaboration-original-report-320.png')
  await evaluate('window.collaborationFixture.failNextDetail()'); await press('Enter')
  await until(() => document.querySelector('[aria-label="Retry original record"]'))
  assert.equal(await read(() => {const use=document.querySelector('[aria-label="Retry original record"] svg use');return Boolean(use&&document.getElementById(use.getAttribute('href').slice(1))?.childElementCount&&use.getBBox().width>0)}),true)
  assert.equal(await read(() => document.querySelector('[data-message-id="original-source-25"]') === window.originalCollaborationDetail), true)
  assert.equal(await read(() => getSelection().toString() === window.originalCollaborationSelection), true)
  await geometry(); await frame('collaboration-retained-read-failure-320.png')
  await click('[aria-label="Retry original record"]'); await until(() => !document.querySelector('[aria-label="Retry original record"]'))
  await clickText('Back to collaboration'); await until(() => document.querySelector('[data-source-message="original-source-25"]'))
  const cursorRetry = await read(() => window.collaborationFixture.reads.filter(item => item.kind === 'list' && item.options?.afterSourceMessageId === 'original-source-20').length)
  assert.ok(cursorRetry >= 2)
  await click(`${selector} [id$="-system-tab"]`); await evaluate(`document.querySelector('${selector} [id$="-system-tab"]').focus()`)
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await settle()
  assert.equal(await evaluate(`document.querySelector('${selector} [aria-selected="true"]').getAttribute('aria-label')`), 'Supervised collaboration')
  win.setContentSize(320, 540); await settle(); await geometry(); await frame('collaboration-short-window-320.png')
  await click('[aria-label="Close mailbox"]'); await settle()
  const after = await read(() => window.collaborationFixture.facts())
  for (const key of ['sessions', 'tab', 'layout', 'drafts', 'writes', 'pastes']) assert.deepEqual(after[key], original[key])
  result.operations.push({ nativePaginationRetry: true, retainedOriginalMessageNode: true, originalWorkerReportSeparateFromAcceptance: true, sameSourceFailureRecovery: true,
    originalDraftsSessionsRunsAndInputPreserved: true, nativeFolderKeyboard: true, shortWindowWithinAvailableSpace: true, facts: { before: original, after } })
}
