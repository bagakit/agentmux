const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
const conversationOnly = process.argv.includes('--conversation-only')
const evolutionOnly = process.argv.includes('--evolution-only')
if ((conversationOnly || evolutionOnly) && process.platform === 'darwin') app.setActivationPolicy('accessory')
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
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', ...(conversationOnly ? { conversation: '1' } : {}), ...(evolutionOnly ? { evolution: '1' } : {}) } })
    const input = nativeRendererInput(win, result.interactions, '')
    const { read, until, settle, click } = input
    await until('window.moteCooperationCapture?.ready', 'Original production App bootstrap')
    await read('window.__connectionsTrustedEvents=window.moteCooperationCapture.facts().trustedEvents')
    win.showInactive()
    // The conversation probe targets its private webContents. It never steals
    // the person's foreground window or uses global keyboard/mouse events.
    if (!conversationOnly && !evolutionOnly) { win.focus(); win.webContents.focus(); await until('document.hasFocus()') }
    const facts = () => read('window.moteCooperationCapture.facts()')
    const initial = result.initial = await facts()
    assert.ok(initial.runs.length >= 4)
    if (evolutionOnly) {
      await evolutionScenes({ input })
      result.final = await read('window.moteEvolutionCapture.facts()')
      assert.deepEqual(result.final.writes, []); result.passed = true
      return
    }
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
    await click('js:' + header + '.querySelector("[data-mote-conversation-switcher] .mote-cooperation__team")')
    await until('!!' + team + ' && ' + team + '.querySelectorAll("[data-mote-member]").length===1 && ' + team + '.querySelector("[data-mote-main-entry]")')
    await capture('04-cooperation-overlay-wide-dark')
    await click('js:' + team + '.querySelector(".mote-cooperation__popover-heading button")')
    await until('!' + team)
    await read('window.moteCooperationCapture.longNames()')
    win.setContentSize(640, 850); await settle()
    await page('Ideas'); await capture('05-ideas-long-name-narrow-dark')
    await page('Profile'); await capture('06-profile-long-name-narrow-dark')
    await read('window.moteCooperationCapture.theme(true)'); await page('Calendar'); await capture('07-calendar-narrow-light')
    await click('js:' + header + '.querySelector("[data-mote-conversation-switcher] .mote-cooperation__team")')
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

async function evolutionScenes({ input }) {
  const { read, until, factsOf } = input
  const floating = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const space = 'document.querySelector(".mote-space-frame[data-mote-space]")'
  const popup = 'document.querySelector(".mote-cooperation__popover")'
  const visible = expression => `(${expression})?.checkVisibility()`
  let surface = floating
  const trigger = () => `${surface}.querySelector('[data-mote-conversation-switcher] .mote-cooperation__team')`
  const current = () => read('window.moteEvolutionCapture.facts()')
  result.scenes = []; result.motion = []; result.preservation = []
  // Hidden retained workfaces intentionally pause their finite avatar motion.
  // Waiting for every document animation would wait forever on healthy hidden
  // content. Only currently visible, running finite effects can delay a photo.
  async function settle() {
    const observation = read(`Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.target instanceof Element&&a.effect.target.checkVisibility()&&a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    let timer
    try { await Promise.race([observation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Visible transition did not settle; this ends only the private capture observation')), 6000) })]) }
    catch (error) {
      result.waitDiagnostic = await read(`document.getAnimations().map(a=>({name:a.animationName??a.id,state:a.playState,time:a.currentTime,progress:a.effect?.getComputedTiming().progress,iterations:a.effect?.getTiming().iterations,target:a.effect?.target?.className,visible:a.effect?.target instanceof Element&&a.effect.target.checkVisibility()}))`)
      throw error
    } finally { clearTimeout(timer) }
  }
  async function click(selector) { await nativeClickWithoutSettle(selector.startsWith('js:') ? selector.slice(3) : 'document.querySelector(' + JSON.stringify(selector) + ')'); await settle() }
  async function type(selector, value) {
    await click(selector); await until('document.activeElement===document.querySelector(' + JSON.stringify(selector) + ')', 'Exact original search input focus')
    win.webContents.selectAll()
    const before = await read('window.__connectionsTrustedEvents.length')
    await win.webContents.insertText(value)
    await until('document.querySelector(' + JSON.stringify(selector) + ').value===' + JSON.stringify(value), 'Original native search edit')
    const events = await read('window.__connectionsTrustedEvents.slice(' + before + ')')
    assert.ok(events.some(event => event.type === 'input' && event.trusted))
    result.interactions.push({ kind: 'native-search-edit', events }); await settle()
  }
  async function press(key) {
    const before = await read('window.__connectionsTrustedEvents.length')
    const beforeKeys = await read('window.moteEvolutionCapture.facts().nativeKeys.length')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    await until('window.moteEvolutionCapture.facts().nativeKeys.slice(' + beforeKeys + ').some(event=>event.key===' + JSON.stringify(key) + '&&event.trusted)', 'Trusted native keyboard action')
    result.interactions.push({ kind: 'native-renderer-key', key, events: await read('window.__connectionsTrustedEvents.slice(' + before + ')'),
      keys: await read('window.moteEvolutionCapture.facts().nativeKeys.slice(' + beforeKeys + ')') }); await settle()
  }
  await until('window.moteEvolutionCapture?.ready && !!' + floating, 'Finite evolution sources and complete App')
  await until(floating + '.innerText.includes("把协作体验补完整")', 'Original Main Reader is ready')
  await settle()
  const baseline = result.evolutionInitial = await current()
  assert.ok(baseline.runs.some(run => run.id === 'mote-research'))
  const checkFacts = facts => {
    assert.deepEqual(facts.identities, baseline.identities, 'Every exact original Region/Session is preserved')
    assert.deepEqual(Object.fromEntries(facts.runs.map(run => [run.id, run.control])), Object.fromEntries(baseline.runs.map(run => [run.id, run.control])), 'Exact original Run controls are preserved independently of list ordering')
    assert.deepEqual(facts.drafts, baseline.drafts, 'All original unsent drafts are preserved')
    assert.deepEqual(facts.writes, [], 'Navigation, observation and local presentation have no input/lifecycle writes')
  }
  const dom = () => read(`(()=>{const root=${surface},p=${popup},id=root?.querySelector('[data-mote-conversation-identity]');return{
    now:performance.now(),body:root?.innerText,popup:p?.innerText,viewport:{width:innerWidth,height:innerHeight},
    identity:{text:id?.textContent,visible:id?.checkVisibility(),bounds:id?.getBoundingClientRect().toJSON()},
    switcher:root?.querySelector('[data-mote-conversation-switcher]')?.innerText,
    focus:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')},
    visibleComposers:[...root.querySelectorAll('[role="textbox"][aria-label="Message Agent"]')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,bounds:n.getBoundingClientRect().toJSON()})),
    members:[...(p?.querySelectorAll('[data-mote-member]')??[])].map(n=>({id:n.dataset.moteMember,host:n.dataset.memberHost,current:n.querySelector('[aria-current]')?.getAttribute('aria-current'),text:n.innerText})),
    actions:[...root.querySelectorAll('[data-mote-main-entry],[data-mote-threads-entry],.mote-cooperation__team')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,label:n.getAttribute('aria-label'),bounds:n.getBoundingClientRect().toJSON()}))}})()`)
  async function photo(name, scene, settled = true) {
    if (settled) await settle()
    const facts = await current(); checkFacts(facts)
    const view = await dom()
    assert.ok(view.identity.visible && view.identity.bounds.width > 0, 'Persistent accurate Mote identity is visible')
    const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    result.images.push(file); if (scene) result.scenes.push(scene); result[name] = { facts, dom: view }
  }
  async function remember(id) {
    const saved = await read(`(()=>{const root=${surface},reader=[...root.querySelectorAll('.activity-feed')].find(n=>n.checkVisibility()),composer=[...root.querySelectorAll('[role="textbox"][aria-label="Message Agent"]')].find(n=>n.checkVisibility()),body=reader?.querySelector('.log-turn__body');
      window.__moteEvolutionRetained??={};window.__moteEvolutionRetained[${JSON.stringify(id)}]={reader,composer,body,scroll:reader?.scrollTop,draft:composer?.textContent};return{reader:!!reader,composer:!!composer,body:!!body}})()`)
    assert.deepEqual(saved, { reader: true, composer: true, body: true }, 'Original Reader/Composer/body mounted for ' + id)
  }
  async function retained(id, scroll = false) {
    const facts = await read(`(()=>{const root=${surface},old=window.__moteEvolutionRetained[${JSON.stringify(id)}],reader=[...root.querySelectorAll('.activity-feed')].find(n=>n.checkVisibility()),composer=[...root.querySelectorAll('[role="textbox"][aria-label="Message Agent"]')].find(n=>n.checkVisibility());return{reader:reader===old.reader,composer:composer===old.composer,body:old.body?.isConnected,draft:composer?.textContent===old.draft,scroll:Math.abs((reader?.scrollTop??0)-old.scroll)<=1,expectedScroll:old.scroll,actualScroll:reader?.scrollTop,scrollHeight:reader?.scrollHeight,clientHeight:reader?.clientHeight}})()`)
    result.preservation.push({ id, ...facts })
    assert.ok(facts.reader && facts.composer && facts.body && facts.draft, 'The same original ' + id + ' subtree and draft survive local navigation')
    if (scroll) assert.equal(facts.scroll, true, 'Original reading position survives the round trip')
  }
  const animationFacts = () => read(`(()=>{const p=${popup};return{now:performance.now(),present:!!p,state:p?.dataset.state,animations:document.getAnimations().filter(a=>a.effect?.target instanceof Element&&p?.contains(a.effect.target)).map(a=>({name:a.animationName??a.id,target:a.effect.target.className,state:a.playState,time:a.currentTime,progress:a.effect.getComputedTiming().progress,iterations:a.effect.getTiming().iterations,duration:a.effect.getComputedTiming().duration}))}})()`)
  async function nativeClickWithoutSettle(expression) {
    await read(`(${expression})?.scrollIntoView({block:'nearest',inline:'nearest'})`); await settle()
    const target = await read(factsOf('js:' + expression))
    assert.ok(target?.connected && target.visible && target.cssHit && target.bounds.width > 0 && target.bounds.height > 0 && !target.disabled, 'Exact actual local transition target is operable')
    const before = await read('window.__connectionsTrustedEvents.length')
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(target.x), y: Math.round(target.y) })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(target.x), y: Math.round(target.y) })
    await until('window.__connectionsTrustedEvents.slice(' + before + ').some(e=>e.type==="click"&&e.trusted)', 'Trusted original local transition click')
    result.interactions.push({ kind: 'native-transition-click', target, events: await read('window.__connectionsTrustedEvents.slice(' + before + ')') })
  }
  async function transition(name, scene, expression, opening) {
    const before = await dom(); await nativeClickWithoutSettle(expression)
    if (opening) {
      await until('!!' + popup, 'Original shared Dialog opened')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const sampled = await animationFacts()
    const active = sampled.animations.filter(animation => animation.state === 'running' && animation.iterations !== Infinity && animation.progress > 0 && animation.progress < 1)
    if (opening) assert.ok(active.length > 0, 'An opening intermediate frame must observe the actual production animation in progress')
    const image = (await win.webContents.capturePage()).toPNG(), after = await animationFacts()
    const file = name + '.png'; await fs.writeFile(path.join(evidence, file), image)
    result.images.push(file); result.scenes.push(scene)
    result.motion.push({ phase: opening ? 'opening' : 'closing', mode: active.length ? 'animated' : 'instant', image: file, before, sampled, active, after,
      boundary: 'Natural production animation at normal timing; no CSS override, pause, seek or replacement UI. Closing may be intentionally immediate and is reported as such.' })
    checkFacts(await current()); await settle()
  }
  async function openPicker() { await click('js:' + trigger()); await until('!!' + popup, 'Original conversation switcher') }
  async function choose(id) {
    if (!await read('!!' + popup)) await openPicker()
    assert.equal(await read(`${popup}.querySelectorAll('[data-mote-member="custom-mote"]').length`), 0, 'A different Mote member is not mixed into this directory')
    await click('js:' + popup + '.querySelector(' + JSON.stringify('[data-mote-member="' + id + '"] button') + ')')
    await until('!' + popup, 'Exact member selection closes the picker')
    await until('window.moteEvolutionCapture.facts().' + (surface === floating ? 'floating?.reference' : 'selection') + '?.tabId===' + JSON.stringify(id + '-tab'), 'Exact selected original member reference')
    await until(surface + '.querySelector("[data-mote-workface]")?.dataset.moteSection==="threads"', 'Explicit member navigation intent')
    await settle()
  }
  async function main() {
    await click('js:' + surface + '.querySelector("[data-mote-main-entry]")')
    await until(surface + '.querySelector("[data-mote-workface]")?.dataset.moteSection==="discussion"', 'Main navigation remains Main intent')
    await until(surface + '.innerText.includes("把协作体验补完整")', 'Original Main is readable again')
  }
  // Native resize of this private floating surface; original layout and CSS own the geometry.
  const handle = await read(`(()=>{const r=${floating}.querySelector('[aria-label="Resize Mote window"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(handle.x), y: Math.round(handle.y) })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1168, y: 38 }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 1168, y: 38 })
  await until(floating + '.getBoundingClientRect().width>1100', 'Actual resize opens a wide reading area')
  await remember('main'); await photo('e01-floating-main-wide-dark', 'floating-main')
  await transition('e02-switcher-opening-mid', 'switcher-opening', trigger(), true)
  assert.equal(await read(`${popup}.querySelectorAll('[data-mote-member]').length`), 2, 'Accurate same-Mote directory contains two original work members')
  assert.equal(await read(`${popup}.querySelectorAll('[data-mote-main-entry]').length`), 1, 'The original Main has its own fixed entry')
  await retained('main'); await photo('e03-switcher-open-wide-dark', 'switcher-open')
  await choose('mote-neighbor'); await until(surface + '.innerText.includes("引用和原操作身份已经整理好")', 'Original member A body')
  await remember('member-a'); await photo('e04-member-a-waiting', 'member-a')
  await choose('mote-research'); await until(surface + '.innerText.includes("第 9 条研究记录")', 'Original member B body')
  await remember('member-b')
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  await read(`document.addEventListener('wheel',event=>window.__connectionsTrustedEvents.push({type:'wheel',trusted:event.isTrusted,label:'original-reader'}),true)`)
  const wheel = await read(`(()=>{const n=window.__moteEvolutionRetained['member-b'].reader,r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),before:n.scrollTop}})()`)
  const beforeWheel = await read('window.__connectionsTrustedEvents.length')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheel.x, y: wheel.y, deltaX: 0, deltaY: -300 })
  await until(`(()=>{const n=window.__moteEvolutionRetained['member-b'].reader;return n.scrollTop<${wheel.before}-1&&n.scrollHeight-n.clientHeight-n.scrollTop>100})()`, 'Actual upward reading leaves the existing tail-follow zone')
  await settle()
  await read(`window.__moteEvolutionRetained['member-b'].scroll=window.__moteEvolutionRetained['member-b'].reader.scrollTop`)
  const wheelEvents = await read('window.__connectionsTrustedEvents.slice(' + beforeWheel + ')')
  assert.ok(wheelEvents.some(event => event.type === 'wheel' && event.trusted), 'Actual native wheel establishes the original upward reading intent')
  result.interactions.push({ kind: 'native-original-reader-wheel', events: wheelEvents, before: wheel.before })
  await photo('e05-member-b-research', 'member-b')
  result.retainedAnimationsBeforeReturn = await read(`document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>({state:a.playState,progress:a.effect?.getComputedTiming().progress,target:a.effect?.target?.className,visible:a.effect?.target instanceof Element&&a.effect.target.checkVisibility()}))`)
  await choose('mote-neighbor'); await retained('member-a'); await choose('mote-research'); await retained('member-b', true)
  await main(); await retained('main'); await photo('e06-main-direct-return', 'main-return')
  await openPicker()
  await transition('e07-switcher-closing', 'switcher-closing', popup + '.querySelector(".mote-cooperation__popover-heading button")', false)
  await until('!' + popup, 'Original picker fully closed'); await retained('main')
  assert.equal(await read(`document.activeElement===${trigger()}`), true, 'Shared Dialog returns local focus to the actual trigger')
  await photo('e08-switcher-closed-focus', 'switcher-closed')
  await openPicker(); await type('.mote-cooperation__popover input[aria-label="查找对话"]', '没有这个原成员')
  await until(popup + '.innerText.includes("没有匹配")', 'Search result is independently empty')
  await photo('e09-no-search-results', 'no-search-results')
  await type('.mote-cooperation__popover input[aria-label="查找对话"]', '')
  await read(`(()=>{const body=window.__moteEvolutionRetained.main.body,p=body.querySelector('p')??body,r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);window.__moteEvolutionSelection=getSelection().toString()})()`)
  await read('window.moteEvolutionCapture.unknown(true)')
  await until(popup + '.innerText.includes("未确认") || ' + popup + '.innerText.includes("最后确认")', 'Original directory observation unknown is visible')
  assert.ok(await read(popup + '.querySelectorAll("[data-mote-member]").length>=2'), 'Last confirmed members remain available')
  assert.equal(await read('getSelection()?.toString()'), await read('window.__moteEvolutionSelection'), 'Directory observation failure preserves the original reading selection')
  await retained('main')
  await photo('e10-directory-unknown-retained', 'unknown-retained')
  await choose('mote-neighbor'); await read('window.moteEvolutionCapture.unknown(false)'); await main()
  await click('js:' + surface + '.querySelector("[data-mote-threads-entry]")')
  await until(surface + '.querySelector(".mote-work-event__summary")', 'Original sourced Threads remains reachable')
  await click('js:' + surface + '.querySelector(".mote-work-event__summary")')
  await until(surface + '.innerText.includes("主对话和 Threads 已分开")', 'Actual original dispatch result is readable')
  await photo('e11-original-thread-detail', 'thread-detail'); await main()
  await click('js:' + floating + '.querySelector("[aria-label=\\"Open Mote in Space\\"]")')
  await until('!' + floating + ' && ' + visible(space), 'Same original Mote opens full Space'); surface = space
  await openPicker(); await choose('mote-neighbor'); await main()
  await photo('e12-space-shared-conversation', 'space-conversation')
  await read('window.moteEvolutionCapture.longNames();window.moteEvolutionCapture.theme(true)')
  win.setContentSize(640, 650); await settle()
  await photo('e13a-main-navigation-narrow-light', null)
  result.narrowMainPage = await read(`(()=>{const tabs=${space}.querySelector('.mote-space-frame__navigation .surface-mode-switch'),n=tabs.querySelector('[aria-selected="true"]'),r=tabs.getBoundingClientRect(),b=n?.getBoundingClientRect();return{text:n?.textContent,visible:!!b&&b.left>=r.left-1&&b.right<=r.right+1}})()`)
  assert.deepEqual(result.narrowMainPage, { text: 'Discussion', visible: true }, 'The actual current Discussion page stays visible at narrow width')
  await choose('mote-neighbor'); await openPicker()
  await photo('e13-narrow-long-name-light', 'narrow-long-light')
  result.narrowHeader = await read(`(()=>{const root=${space},tabs=root.querySelector('.mote-space-frame__navigation .surface-mode-switch'),r=tabs.getBoundingClientRect();return[...tabs.querySelectorAll('[role=tab]')].map(n=>{const b=n.getBoundingClientRect();return{text:n.textContent,current:n.getAttribute('aria-selected'),visible:b.left>=r.left-1&&b.right<=r.right+1,bounds:b.toJSON(),viewport:r.toJSON()}})})()`)
  assert.ok(result.narrowHeader.length === 5 && result.narrowHeader.every(tab => tab.visible), 'Narrow full Space keeps its pages and the selected page discoverable beside the current conversation')
  await press('Escape'); await until('!' + popup, 'Native Escape closes the original picker')
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await until('matchMedia("(prefers-reduced-motion: reduce)").matches', 'Actual browser reduced-motion setting')
  await openPicker(); await choose('mote-neighbor'); await main(); await openPicker()
  const reduced = result.reducedMotion = await animationFacts()
  assert.deepEqual(reduced.animations.filter(animation => animation.state === 'running' && animation.iterations !== 1), [], 'Reduced motion has no looping picker animation')
  assert.deepEqual(reduced.animations.filter(animation => animation.state === 'running'), [], 'Reduced motion has no residual picker animation')
  assert.equal(await read(`getComputedStyle(${popup}).animationName`), 'none', 'The original reduced-motion rule removes opening animation rather than waiting for it to finish')
  await photo('e14-reduced-motion-switcher', 'reduced-motion')
  await press('Escape'); await until('!' + popup)
  await click('js:' + surface + '.querySelector("[data-mote-threads-entry]")')
  await until(surface + '.querySelector(".mote-work-event__summary")', 'Original reduced-motion thread detail')
  if (!await read(surface + '.querySelector(".mote-work-event__thread")?.checkVisibility()')) await click('js:' + surface + '.querySelector(".mote-work-event__summary")')
  result.reducedThread = await read(`[...${surface}.querySelectorAll('.mote-work-event__thread')].filter(n=>n.checkVisibility()).map(n=>({animation:getComputedStyle(n).animationName,layout:getComputedStyle(n.closest('.mote-threads')?.querySelector('.mote-threads__body') ?? n).display==='grid'?'split':'stack'}))`)
  assert.ok(result.reducedThread.length > 0 && result.reducedThread.every(item => item.animation === 'none'), 'Actual narrow thread detail also respects reduced motion')
  await main()
  await click('js:' + surface + '.querySelector(".mote-main-actions__trigger")')
  await until('document.querySelector(".mote-main-actions__menu")', 'Original Main actions dialog')
  await click('js:[...document.querySelectorAll(".mote-main-actions__menu button")].find(n=>n.textContent.includes("开始新一轮"))')
  await until(surface + '.querySelector(".mote-start")?.checkVisibility()', 'Original new-round preparation, without submitting')
  await photo('e15-new-round-draft-kept', 'new-round')
  await read('window.moteEvolutionCapture.empty()'); surface = floating
  await until(floating + '.querySelector(".mote-start")?.checkVisibility()', 'Confirmed zero-member Mote welcome')
  await openPicker()
  assert.equal(await read(popup + '.querySelectorAll("[data-mote-member]").length'), 0, 'A truly empty Mote does not borrow another Mote members')
  await photo('e16-confirmed-empty-mote', 'confirmed-empty')
  assert.ok(result.interactions.length >= 15 && result.interactions.every(item => item.events.some(event => event.trusted)), 'Every recorded interaction uses native trusted Renderer input')
  result.evolutionFinal = await current(); checkFacts(result.evolutionFinal)
}
