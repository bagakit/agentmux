const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
const conversationOnly = process.argv.includes('--conversation-only')
if (conversationOnly && process.platform === 'darwin') app.setActivationPolicy('accessory')
app.setPath('userData', path.join(privateRoot, 'userData'))
app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', ...(conversationOnly ? { conversation: '1' } : {}) } })
    const input = nativeRendererInput(win, result.interactions, '')
    const { read, until, settle, click } = input
    await until('window.moteCooperationCapture?.ready', 'Original production App bootstrap')
    await read('window.__connectionsTrustedEvents=window.moteCooperationCapture.facts().trustedEvents')
    win.showInactive()
    // The conversation probe targets its private webContents. It never steals
    // the person's foreground window or uses global keyboard/mouse events.
    if (!conversationOnly) { win.focus(); win.webContents.focus(); await until('document.hasFocus()') }
    const facts = () => read('window.moteCooperationCapture.facts()')
    const initial = result.initial = await facts()
    assert.ok(initial.runs.length >= 4)
    if (conversationOnly) {
      await conversationScenes({ input, initial })
      result.final = await read('window.moteConversationCapture.facts()')
      assert.deepEqual(result.final.writes, []); result.passed = true
      return
    }
    const floating = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
    await click('js:' + floating + '.querySelector("[aria-label=\\"Open in Space\\"]")')
    const header = 'document.querySelector(".mote-space-frame__header:not([hidden])")'
    const details = 'document.querySelector("[data-mote-details][data-shared-navigation=\\"true\\"]")'
    const team = 'document.querySelector(".mote-cooperation__popover")'
    await until('!' + floating + ' && !!' + header, 'Original Space takes over the same Mote')
    const page = async name => {
      await click('js:[...' + header + '.querySelectorAll("[role=tab]")].find(n=>n.textContent===' + JSON.stringify(name) + ')')
      await until(header + '.querySelector("[role=tab][aria-selected=true]").textContent===' + JSON.stringify(name))
    }
    async function capture(name) {
      if (process.argv.includes('--unknown-only') && name !== '08-unknown-team-narrow-light') return
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await settle()
      const current = await facts()
      assert.deepEqual(current.identities, initial.identities, 'Original workface identities are kept')
      assert.deepEqual(current.drafts, initial.drafts, 'Every original unsent draft is kept')
      assert.deepEqual(current.writes, [], 'Read-only navigation performs no input or lifecycle effect')
      for (const run of current.runs) assert.deepEqual(run, initial.runs.find(item => item.id === run.id))
      const dom = await read(`({body:document.body.innerText,viewport:{width:innerWidth,height:innerHeight},header:${header}.getBoundingClientRect().toJSON(),identityCount:[...document.querySelectorAll('.mote-details__profile')].filter(n=>n.checkVisibility()).length})`)
      const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.images.push(file); result[name] = { dom, facts: current }
    }
    assert.equal(await read(header + '.querySelector(".mote-cooperation__identity")===null'), true)
    await page('Profile')
    await until('!!' + details + '?.querySelector(".mote-details__profile")')
    assert.equal(await read(details + '.querySelector(".mote-profile__preferences").open'), false)
    await capture('01-profile-wide-dark')
    await page('Ideas')
    assert.equal(await read(details + '.querySelector(".mote-details__profile").checkVisibility()'), false)
    await capture('02-ideas-wide-dark')
    await page('Calendar'); await capture('03-calendar-wide-dark')
    await click('js:' + header + '.querySelector("[aria-label=\\"团队协作\\"]")')
    await until('!!' + team + ' && ' + team + '.querySelectorAll("[data-mote-member]").length===2')
    await capture('04-cooperation-overlay-wide-dark')
    await click('js:' + team + '.querySelector("[aria-label=\\"关闭团队协作\\"]")')
    await until('!' + team)
    await read('window.moteCooperationCapture.longNames()')
    win.setContentSize(640, 850); await settle()
    await page('Ideas'); await capture('05-ideas-long-name-narrow-dark')
    await page('Profile'); await capture('06-profile-long-name-narrow-dark')
    await read('window.moteCooperationCapture.theme(true)'); await page('Calendar'); await capture('07-calendar-narrow-light')
    await click('js:' + header + '.querySelector("[aria-label=\\"团队协作\\"]")')
    await until('!!' + team)
    await read('window.moteCooperationCapture.unknown()')
    await until(team + '.textContent.includes("暂未确认") || ' + team + '.textContent.includes("状态未确认")')
    assert.equal((await read('document.body.innerText')).split('原 Mote 资料暂未确认；原成员、工作和输入保留。').length - 1, 1, 'One directory failure has one cause surface')
    assert.equal(await read(details + '.textContent.includes("No arrangements yet")'), false, 'Unknown scope is not confirmed empty')
    await capture('08-unknown-team-narrow-light')
    result.final = await facts()
    assert.ok(result.interactions.length >= 10 && result.interactions.every(item => item.events.some(event => event.trusted)))
    assert.deepEqual(result.final.writes, []); result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack, cause: error.cause?.message }
    if (win && !win.isDestroyed()) {
      result.failureState = await win.webContents.executeJavaScript('({body:document.body.textContent,setup:window.closedTabSetup,facts:window.moteCooperationCapture?.facts()})').catch(error => ({ error: error.message }))
      await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try { await win.webContents.executeJavaScript('window.closedTabProof?.dispose()') } catch (error) { result.cleanupError = error.message; result.passed = false }
    }
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})

async function conversationScenes({ input, initial }) {
  const { read, until, settle, click } = input
  const floating = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const space = 'document.querySelector(".mote-space-frame[data-mote-space]")'
  const current = () => read('window.moteConversationCapture.facts()')
  const sourceCard = (kind, recordId) => `([...${floating}.querySelectorAll('.log-turn[data-conversation-item-ref]')].find(n=>{const r=JSON.parse(n.dataset.conversationItemRef);return r.source.kind===${JSON.stringify(kind)}&&r.source.recordId===${JSON.stringify(recordId)}}))`
  await until('window.moteConversationCapture?.ready && !!' + floating, 'Finite conversation source ports and original floating App')
  await until(floating + '.innerText.includes("我会一直在这里") && ' + floating + '.querySelector("[data-input-status=terminal-confirmed]")', 'Native reply and captured pending input in the real Reader')
  await settle()
  // Use the original resize gesture so the wide scene has the same useful
  // reading area as an expanded user workface, without overriding product CSS.
  const handle = await read(`(()=>{const r=${floating}.querySelector('[aria-label="Resize Mote window"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const beforeResize = await read('window.__connectionsTrustedEvents.length')
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(handle.x), y: Math.round(handle.y) })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1168, y: 38 })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 1168, y: 38 })
  await until(floating + '.getBoundingClientRect().width>1100', 'Actual Mote resize gesture expands the wide reading surface')
  result.interactions.push({ kind: 'native-renderer-resize', events: await read('window.__connectionsTrustedEvents.slice(' + beforeResize + ')') })
  const editor = '[role="textbox"][aria-label="Message Agent"]'
  const remember = async () => {
    await read(`window.__motePresenceRetained={reader:${floating}.querySelector('.activity-feed'),composer:${floating}.querySelector(${JSON.stringify(editor)}),body:${sourceCard('native', 'original-native-reply')}.querySelector('.log-turn__body')}`)
    assert.equal(await read('Object.values(window.__motePresenceRetained).every(n=>n?.isConnected)'), true, 'Real Reader, maintained editor and message body all exist')
  }
  const retained = () => read(`({reader:window.__motePresenceRetained.reader===${floating}.querySelector('.activity-feed'),composer:window.__motePresenceRetained.composer===${floating}.querySelector(${JSON.stringify(editor)}),body:window.__motePresenceRetained.body===${sourceCard('native', 'original-native-reply')}.querySelector('.log-turn__body'),selection:getSelection()?.toString()})`)
  const identity = selector => `(${selector}).querySelector('[data-mote-conversation-identity]')`
  async function photo(name, selector = floating) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await settle()
    const facts = await current()
    assert.deepEqual(facts.identities, initial.identities, 'Original Region/Session identities retained')
    assert.equal(facts.runs.length, initial.runs.length, 'No original Run disappears or extra Run appears')
    assert.deepEqual(Object.fromEntries(facts.runs.map(run => [run.id, run.control])), Object.fromEntries(initial.runs.map(run => [run.id, run.control])), 'Original exact Run controls retained independently of presentation order')
    assert.deepEqual(facts.drafts, initial.drafts, 'Every original unsent draft retained')
    assert.deepEqual(facts.writes, [], 'No input or lifecycle writes')
    const dom = await read(`(()=>{const root=${selector},id=${identity(selector)},r=id?.getBoundingClientRect();return{body:root?.innerText,viewport:{width:innerWidth,height:innerHeight},identity:{name:id?.textContent,title:id?.querySelector('[title]')?.title,visible:id?.checkVisibility(),bounds:r?.toJSON()},composers:[...root.querySelectorAll(${JSON.stringify(editor)})].filter(n=>n.checkVisibility()).map(n=>({value:n.textContent,bounds:n.getBoundingClientRect().toJSON()})),states:[...root.querySelectorAll('[role=status]')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,status:n.dataset.inputStatus})),details:[...root.querySelectorAll('.conversation-input-details__body')].filter(n=>n.checkVisibility()).map(n=>n.textContent)}})()`)
    assert.ok(dom.identity.visible && dom.identity.bounds.width > 0, 'Accurate identity is actually visible outside the Reader')
    assert.equal(dom.composers.length, 1, 'Exactly one original visible maintained Composer')
    if (name === '01-floating-conversation-wide-dark') {
      const titles = await read(`[...${selector}.querySelectorAll('.log-turn__system-title')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,width:n.clientWidth,completeWidth:n.scrollWidth}))`)
      assert.ok(titles.length > 0 && titles.every(title => title.completeWidth <= title.width + 1), 'Named system records use available width instead of clipping a title beside an absent preview')
      result.systemTitles = titles
    }
    const file = name + '.png'
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.images.push(file); result[name] = { facts, dom }
  }
  await remember()
  await photo('01-floating-conversation-wide-dark')
  result.messageCards = await read(`[...${floating}.querySelectorAll('.log-turn')].map(n=>({id:n.dataset.messageId,reference:n.dataset.conversationItemRef}))`)
  const nativeCard = sourceCard('native', 'native-human')
  const capturedCard = sourceCard('captured', 'original-captured-submission')
  for (const card of [nativeCard, capturedCard]) {
    assert.equal(await read(`!!(${card})`), true, 'Both actual native and captured cards mounted')
    assert.equal(await read(`[...(${card}).children].filter(n=>n.classList.contains('log-turn__meta')).map(n=>n.textContent).join('')`), '', 'Normal metadata stays out of the message face')
  }
  await click('js:' + capturedCard + '.querySelector("[aria-label=\\"Message details\\"]")')
  await until(capturedCard + '.querySelector(".conversation-input-details__body")?.textContent.includes("本机 Mac")', 'Captured original metadata remains in Info')
  assert.deepEqual(await retained(), { reader: true, composer: true, body: true, selection: '' })
  await photo('02-floating-captured-info-wide-dark')
  await click('js:' + capturedCard + '.querySelector("[aria-label=\\"Message details\\"]")')
  await click('js:' + nativeCard + '.querySelector("[aria-label=\\"Message details\\"]")')
  await until(nativeCard + '.querySelector(".conversation-input-details__body .conversation-submissions")', 'Joined native submission stays in the same Info')
  await click('js:' + nativeCard + '.querySelector(".conversation-submissions details > summary")')
  await until(nativeCard + '.querySelector(".conversation-submissions .message-disclosure__body")?.innerText.includes("original-native-submission")', 'Original joined submission facts and body are reachable')
  await photo('03-floating-native-info-wide-dark')
  await click('js:' + nativeCard + '.querySelector("[aria-label=\\"Message details\\"]")')
  await click('js:' + floating + '.querySelector(".mote-conversation__source > summary")')
  await until(floating + '.innerText.includes("原记录留在这段历史里")', 'Original earlier Main source is readable')
  await photo('04-floating-history-wide-dark')
  await click('js:' + floating + '.querySelector(".mote-conversation__source > summary")')
  // Exercise the original Composer with native input, restoring the exact draft
  // before taking a scene; nothing is submitted.
  const draftEditor = '[data-pmo-teams-topic-floating]:popover-open ' + editor
  const draft = await read('document.querySelector(' + JSON.stringify(draftEditor) + ').textContent')
  async function editDraft(value) {
    await click(draftEditor)
    await until('document.activeElement===document.querySelector(' + JSON.stringify(draftEditor) + ')', 'Exact original maintained editor focus')
    win.webContents.selectAll()
    const start = await read('window.__connectionsTrustedEvents.length')
    await win.webContents.insertText(value)
    await until('document.querySelector(' + JSON.stringify(draftEditor) + ').textContent===' + JSON.stringify(value), 'Actual native edit updates the maintained draft')
    const events = await read('window.__connectionsTrustedEvents.slice(' + start + ')')
    assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Native edit produces trusted input in the original editor')
    result.interactions.push({ kind: 'native-maintained-composer-edit', events })
  }
  await editDraft(draft + ' 临时编辑'); await editDraft(draft)
  assert.deepEqual((await current()).drafts, initial.drafts)
  await click('js:' + floating + '.querySelector("[aria-label=\\"Open Mote in Space\\"]")')
  await until('!' + floating + ' && !!' + space + '?.querySelector(".mote-space-frame__header:not([hidden])")', 'Original Mote full Space')
  await photo('05-space-conversation-wide-dark', space)
  // The primary Mote has a fixed brand name. Exercise real long-name truncation
  // on the already-existing custom Mote, with its own exact Main and source.
  await read('window.moteConversationCapture.longName()')
  await until('!!' + floating + ' && ' + floating + '.querySelector("[data-mote-conversation-identity]")?.textContent.includes("长期合作伙伴")', 'Original custom Mote has the accurate saved long name')
  await click('js:' + floating + '.querySelector("[aria-label=\\"Open Mote in Space\\"]")')
  await until('!' + floating + ' && ' + space + '?.querySelector("[data-mote-conversation-identity]")?.textContent.includes("长期合作伙伴")', 'Custom Mote full Space keeps that same identity')
  await read('window.moteCooperationCapture.theme(true)')
  win.setContentSize(640, 850); await settle()
  await photo('06-space-long-name-narrow-light', space)
  await read('window.moteConversationCapture.reopen()')
  await until('!!' + floating + ' && ' + floating + '.innerText.includes("我会一直在这里")', 'Same original Main in the floating view')
  win.setContentSize(760, 850); await settle(); await remember()
  await read(`(()=>{const body=window.__motePresenceRetained.body,p=body.querySelector('p'),r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);window.__motePresenceSelected=getSelection().toString()})()`)
  await read('window.moteConversationCapture.fail()')
  await until(floating + '.innerText.includes("Conversation reading interrupted") && ' + floating + '.innerText.includes("Agent process exited")', 'Real original Run exit and source-unavailable facts coexist')
  const afterFailure = await retained()
  assert.ok(afterFailure.reader && afterFailure.composer && afterFailure.body, 'Failure keeps the same original Reader/Composer/body DOM')
  assert.equal(afterFailure.selection, await read('window.__motePresenceSelected'), 'A source observation failure retains the original selection')
  result.preservation = { afterFailure, identities: true, runs: true, drafts: true, effects: [] }
  await read('getSelection().removeAllRanges()')
  await photo('07-floating-exit-unavailable-narrow-light')
  await click('js:' + floating + '.querySelector(".activity-feed__reading-service .service-disclosure__trigger")')
  await until('document.querySelector(".service-disclosure__details:popover-open")', 'Original reading failure details remain reachable')
  await photo('08-floating-reading-details-narrow-light')
  win.setContentSize(1180, 850)
  await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', conversation: '1', initialDelay: '1' } })
  await until('window.moteConversationCapture?.ready && !!' + floating, 'Original App loading scene')
  await read('window.__connectionsTrustedEvents=window.moteCooperationCapture.facts().trustedEvents')
  await until(floating + '.querySelector(".activity-feed__empty-reading.full-page-loading--loading")?.checkVisibility()', 'Original first conversation read remains pending')
  await photo('09-floating-initial-reading-wide-dark')
  await read('window.moteConversationCapture.release()')
  await until(floating + '.innerText.includes("我会一直在这里")', 'Original read completes without replacing the Session')
  assert.ok(result.interactions.length >= 10 && result.interactions.every(item => item.events.some(event => event.trusted)), 'Actual Chromium input drove the original controls')
}
