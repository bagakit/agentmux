const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence, mode] = process.argv.slice(2)
const baseline = mode === 'baseline'
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', physicalPhone: false,
  environment: { renderer: 'private Electron Chromium', pointer: 'CDP touchStart/touchEnd', keyboard: 'webContents.insertText', keyboardIme: 'not-observed' },
  images: [], operations: [], gaps: [], errors: [] }
app.whenReady().then(async () => {
 let win
 try {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true,
    nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } })
  win.setContentSize(390, 844)
  result.environment.versions = process.versions
  win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
  await win.loadFile(html)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  console.log('mobile_product_stage=renderer-loaded')
  const read = code => win.webContents.executeJavaScript(code)
  const until = async code => { for (let i = 0; i < 150; i++) { if (await read(code)) return; await pause(30) }; throw Error('Renderer condition unavailable: ' + code) }
  const visible = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n?.getClientRects().length && n.getBoundingClientRect().height>0})()`)
  const resize = async (width, height) => { win.setContentSize(width, height); await until(`innerWidth===${width}&&innerHeight===${height}&&Math.round(document.querySelector('.mobile-app').getBoundingClientRect().height)===${height}`) }
  const tap = async (selector, label = selector) => {
    await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`)
    await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n?.getClientRects().length)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===n||n.contains(hit)})()`)
    const observed = await read(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(n=>n.getClientRects().length);if(nodes.length!==1)throw Error('Actual visible control must be unique: '+${JSON.stringify(selector)}+' ('+nodes.length+')');const n=nodes[0];n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(hit!==n&&!n.contains(hit))throw Error('Actual touch target is covered: '+${JSON.stringify(label)});window.mobileTapFacts={clicked:false,events:[]};window.mobileTapTarget=n;if(!window.mobileTapRecorder){window.mobileTapRecorder=true;for(const type of ['touchstart','touchend','click'])document.addEventListener(type,event=>{if(window.mobileTapTarget===event.target||window.mobileTapTarget?.contains(event.target)){window.mobileTapFacts.events.push({type,observedAt:performance.now()});if(type==='click')window.mobileTapFacts.clicked=true}},{capture:true})}return {x,y,label:n.getAttribute('aria-label')||n.textContent,tag:n.tagName,rect:r.toJSON(),disabled:!!n.disabled}})()`)
    assert.equal(observed.disabled, false, 'Selected actual control is enabled')
    result.operations.push({ action: 'touch', target: label, observed })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: observed.x, y: observed.y, radiusX: 1, radiusY: 1, force: 1, id: 1 }] })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until('window.mobileTapFacts.clicked')
    result.operations.push({ action: 'touch-receipt', target: label, ...await read('window.mobileTapFacts') })
  }
  const hasButton = (label, scope = 'body') => read(`(()=>{const ns=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].filter(n=>n.getClientRects().length);return ns.some(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}||n.textContent.trim().startsWith(${JSON.stringify(label)}))})()`)
  const button = async (label, scope = 'body') => {
    const selected = await read(`(()=>{const ns=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].filter(n=>n.getClientRects().length);const n=ns.find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)})||ns.find(n=>n.querySelector('strong')?.textContent.trim()===${JSON.stringify(label)})||ns.find(n=>n.textContent.trim().startsWith(${JSON.stringify(label)}));if(!n)throw Error('Actual named button unavailable '+${JSON.stringify(label)}+'; visible='+ns.map(n=>n.getAttribute('aria-label')||n.textContent.trim()).join(' / '));const marker='capture-control-'+Math.random().toString(36).slice(2);n.setAttribute('data-capture-control',marker);return marker})()`)
    await tap('[data-capture-control=' + JSON.stringify(selected) + ']', label)
  }
  const capture = async name => {
    if (mode === 'source-recovery' && !['navigation-offline-source-restored-narrow', 'navigation-reconnected-source-narrow'].includes(name)) return
    await pause(120)
    const facts = await read(`(()=>{const n=document.querySelector('.mobile-app'),e=document.querySelector('[contenteditable=true]');return {text:n.innerText,overlay:document.querySelector('[role=dialog]')?.innerText,overflow:n.scrollWidth>n.clientWidth,root:n.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight,visualHeight:visualViewport.height,top:visualViewport.offsetTop},selectedSession:document.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id'),editor:{text:e?.textContent,visible:!!e?.getClientRects().length,rect:e?.getBoundingClientRect().toJSON(),sameOriginal:e===window.originalCaptureEditor,focused:document.activeElement===e},...mobileProductScene.facts()}})()`)
    await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
    result.images.push(name + '.png'); result.operations.push({ action: 'capture', name, ...facts })
    if (!baseline) assert.equal(facts.overflow, false, 'Actual mobile app does not overflow horizontally')
  }
  const gap = description => { if (!baseline) throw Error(description); result.gaps.push(description) }
  const openMote = async () => {
    await button('Mote', '.mobile-navigation')
    await until('!![...document.querySelectorAll(".mobile-spatial-panel button")].find(n=>n.textContent.includes("我的 Mote"))')
    await button('我的 Mote', '.mobile-spatial-panel')
    if (!await visible('.mobile-conversation-panel')) {
      gap('Mote did not open the configured original main conversation; only a directory appeared.')
      await capture('mote-directory-baseline')
      await button('日常协作', '.mobile-spatial-panel')
    }
    await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-mote')
  }
  await until('!!document.querySelector(".mobile-spatial-panel .mobile-session-list button")')
  result.palette = await read(`(()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(['--surface-0','--surface-1','--green','--amber','--red','--fs-body'].map(k=>[k,s.getPropertyValue(k).trim()]))})()`)
  if (!baseline) {
    assert.equal(result.palette['--surface-1'], '#171b21', 'Original MobileApp consumes the shared Graphite palette')
    assert.equal(result.palette['--green'], '#8de3ae', 'Original MobileApp consumes the shared Mint action color')
    assert.equal(result.palette['--fs-body'], '13px', 'Mobile typography remains client-owned')
  }
  await capture('mote-overview-phone')
  await openMote()
  await read('window.originalCaptureEditor=document.querySelector("[contenteditable=true]")')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Original shared Composer')
  win.webContents.insertText('先比较两种方案，保留原来的依据。')
  await capture('mote-conversation-phone')
  if (mode === 'navigation' || mode === 'source-recovery') {
    const back = async () => { await read('history.back()'); await pause(150) }
    await tap('.mobile-mote-heading', 'Original Profile'); await resize(320, 760)
    await button('合作方式 · BEHAVIOR.md')
    await until('document.querySelector(".mobile-mote-source").textContent.includes("我们围绕你的原始目标")')
    await capture('navigation-source-narrow')
    await back(); await until('!document.querySelector(".mobile-mote-source")&&!!document.querySelector(".mobile-mote-profile")')
    await capture('navigation-back-profile-narrow')
    await back(); await until('!document.querySelector("[role=dialog]")')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    await capture('navigation-back-conversation-narrow')
    await button('当前对话操作'); await button('目标与结果')
    await until('!!document.querySelector(".mobile-goal-panel:not([hidden])")')
    await back(); await until('!!document.querySelector(".mobile-conversation-panel:not([hidden])")')
    await button('当前对话操作'); await button('查看终端')
    await until('!!document.querySelector(".mobile-terminal-panel:not([hidden])")')
    await back(); await until('!!document.querySelector(".mobile-conversation-panel:not([hidden])")')
    await tap('.mobile-mote-heading', 'Profile before reload'); await button('合作方式 · BEHAVIOR.md')
    const saved = await read('mobileProductScene.facts().record')
    assert.equal(saved.presentation.identity.context.regionId, 'region-mote')
    assert.equal(saved.presentation.profile.sourcePath, 'BEHAVIOR.md')
    await read("history.replaceState(history.state, '', '#fixture-offline')")
    win.webContents.reload()
    await until('!!window.mobileProductScene&&document.querySelector(".mobile-app")?.dataset.connection==="disconnected"&&!!document.querySelector(".mobile-mote-source")')
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
    assert.deepEqual(await read('mobileProductScene.facts().record.presentation'), saved.presentation)
    await capture('navigation-offline-source-restored-narrow')
    await read('mobileProductScene.reconnect()')
    await button('刷新原文件')
    await until('document.querySelector(".mobile-mote-source").textContent.includes("我们围绕你的原始目标")')
    await capture('navigation-reconnected-source-narrow')
    await back(); await until('!document.querySelector(".mobile-mote-source")')
    await back(); await until('!document.querySelector("[role=dialog]")')
    await resize(390, 844); await capture('navigation-restored-conversation-phone')
    assert.equal(await read('mobileProductScene.facts().record.presentation.identity.context.regionId'), 'region-mote')
    const calls = await read('mobileProductScene.facts().calls')
    assert.equal(calls.filter(call => call.method === 'sdk.submitAgentPrompt').length, 0)
    assert.equal(calls.filter(call => call.method === 'sdk.respondAgentInteraction').length, 0)
    result.operations.push({ action: 'browser-back-reload', originalDraftRetained: true, exactOccurrence: saved.presentation.identity.context,
      originalProfileSource: saved.presentation.profile, browserBack: true, nativeBack: 'mounted OS-port tests only', physicalPhone: false })
    result.passed = true; return
  }
  for (const label of ['Goals', 'Topics', 'Mote', 'Focus', 'Space']) {
    await button(label, '.mobile-navigation')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true, 'Five-entry roundtrip retains the original editor')
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
    assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-mote')
    result.operations.push({ action: 'primary-roundtrip', primary: label, originalEditorRetained: true, draftRetained: true })
  }
  await openMote()
  if (await visible('.mobile-mote-heading')) {
    await tap('.mobile-mote-heading', 'Mote avatar Profile')
    await capture('mote-profile-phone')
    await resize(320, 760); await capture('mote-profile-narrow')
    const profile = await read(`(()=>{const n=document.querySelector('.mobile-sheet');return {background:getComputedStyle(n).backgroundColor,minActionHeight:Math.min(...[...n.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect().height))}})()`)
    if (!baseline) {
      assert.equal(profile.background, 'rgb(23, 27, 33)', 'Profile uses the shared neutral sheet material')
      assert.ok(profile.minActionHeight >= 44, 'Profile actions preserve touch targets')
    }
    result.operations.push({ action: 'profile-material', ...profile })
    await read('document.documentElement.dataset.appearance="light"')
    await capture('mote-profile-light-narrow')
    if (!baseline) assert.equal(await read('getComputedStyle(document.querySelector(".mobile-sheet")).backgroundColor'), 'rgb(238, 241, 239)', 'Profile reads the same light appearance role')
    await read('document.documentElement.dataset.appearance="dark"')
    await button('合作方式 · BEHAVIOR.md')
    await until('document.querySelector(".mobile-mote-source").textContent.includes("我们围绕你的原始目标")')
    await capture('mote-original-source-narrow')
    await button('返回资料')
    await button('关闭面板')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
  } else gap('Mote main-conversation entry lost its original Mote context; avatar/Profile unavailable.')
  await resize(390, 844)
  if (!await hasButton('目标与结果') && await hasButton('当前对话操作')) await button('当前对话操作')
  if (await hasButton('目标与结果')) {
    await button('目标与结果')
    await until('!!document.querySelector(".mobile-goal-panel:not([hidden]) .mobile-goal-list button")')
    await button('查看目标 把两个想法变成一个小实验')
    await until('document.querySelector(".mobile-goal-panel").textContent.includes("成果与验收")')
    await capture('mote-result-phone')
    await resize(320, 760); await capture('mote-result-narrow')
    const resultScroll = await read(`(()=>{const n=document.querySelector('.mobile-main'),r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,before:n.scrollTop,height:n.clientHeight,total:n.scrollHeight}})()`)
    // Offscreen Chromium has no display-driven gesture animation. Deliver the same
    // trusted touch sequence frame by frame and observe the production scroll owner.
    for (let swipe = 0; swipe < 8; swipe++) {
      if (await read(`(()=>{const n=document.querySelector('.mobile-main');return n.scrollHeight-n.clientHeight-n.scrollTop<=2})()`)) break
      const gesture = await read(`(()=>{const r=document.querySelector('.mobile-main').getBoundingClientRect();return {x:r.x+r.width/2,from:r.bottom-50,to:r.top+50}})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gesture.x, y: gesture.from, id: 1 }] })
      for (let frame = 1; frame <= 12; frame++) {
        await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gesture.x, y: gesture.from+(gesture.to-gesture.from)*frame/12, id: 1 }] })
        await pause(30)
      }
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await pause(120)
      result.operations.push({ action: 'touch-swipe-result', swipe, gesture, scrollTop: await read("document.querySelector('.mobile-main').scrollTop") })
    }
    await until(`(()=>{const n=document.querySelector('.mobile-main');return n.scrollHeight-n.clientHeight-n.scrollTop<=2})()`)
    const resultBottom = await read(`(()=>{const n=document.querySelector('.mobile-main'),e=document.querySelector('.mobile-goal-result code'),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {after:n.scrollTop,height:n.clientHeight,total:n.scrollHeight,evidence:e.textContent,rect:r.toJSON(),visible:r.top>=n.getBoundingClientRect().top&&r.bottom<=n.getBoundingClientRect().bottom&&hit===e,kind:e.tagName}})()`)
    assert.equal(resultBottom.visible, true, 'Original result evidence reference remains readable above the navigation')
    assert.equal(resultBottom.evidence, '原资料/实验建议.md')
    result.operations.push({ action: 'touch-scroll-result-bottom', ...resultScroll, ...resultBottom, evidenceAction: 'read-only reference; product exposes no file-open button' })
    await capture('mote-result-bottom-narrow')
    if (!await hasButton('返回原对话') && await hasButton('当前对话操作')) await button('当前对话操作')
    await button('返回原对话')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
  } else gap('Visible Mote context did not expose the original goal/result action.')
  await resize(390, 844)
  await button('Focus', '.mobile-navigation')
  await until('document.querySelector(".mobile-spatial-panel").textContent.includes("需要处理")')
  await capture('focus-overview-phone')
  await resize(320, 760); await capture('focus-overview-narrow')
  await button('资料整理', '.mobile-spatial-panel')
  if (await read('mobileProductScene.facts().record.selectedSessionId!=="session-waiting"')) {
    gap('Focus row did not choose the exact original waiting Agent.')
  }
  await until('!!document.querySelector("[data-request-id=request-original]")')
  await capture('waiting-input-narrow')
  await button('允许本次读取')
  await capture('waiting-response-narrow')
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-spatial-panel")')
  await button('实验建议', '.mobile-spatial-panel')
  await capture('focus-result-conversation-narrow')
  await openMote()
  assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
  assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
  await read('mobileProductScene.unknownNext()')
  await button('Send')
  await pause(120)
  assert.equal(await visible('.mobile-send-status[data-phase=unknown]'), true, 'Unknown delivery remains independently visible')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Continue later draft')
  win.webContents.insertText(' 后来补充的文字也保留。')
  await capture('unknown-receipt-narrow')
  await resize(390, 480); await capture('unknown-short-viewport')
  await tap('.mobile-send-status__diagnosis > summary', '发送详情')
  await capture('unknown-details-short-viewport')
  const diagnostic = await read(`(()=>{const n=document.querySelector('.mobile-send-status__diagnosis'),e=document.querySelector('[contenteditable=true]'),r=e.getBoundingClientRect();return {text:n.innerText,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,overflow:getComputedStyle(n).overflowY,editor:r.toJSON(),editorFont:getComputedStyle(e).fontSize,readingHeight:document.querySelector('.mobile-conversation__reading').getBoundingClientRect().height}})()`)
  assert.ok(diagnostic.text.includes('原 Host 已受理输入') && diagnostic.text.includes('后来补充的草稿也保留'), 'Unknown diagnosis retains the full original explanation')
  assert.ok(diagnostic.scrollHeight <= diagnostic.clientHeight || diagnostic.overflow === 'auto', 'Long unknown diagnosis remains scrollable')
  assert.ok(diagnostic.editor.height > 0 && diagnostic.editor.top >= 0 && diagnostic.editor.bottom <= 480, 'Short-screen editor remains within the viewport while diagnosis is open')
  assert.equal(diagnostic.editorFont, '16px', 'Mobile editor preserves the non-zooming touch type size')
  result.operations.push({ action: 'short-unknown-diagnosis', ...diagnostic })
  await tap('.mobile-send-status__diagnosis > summary', '收起发送详情')
  await read('mobileProductScene.offline()')
  await capture('offline-retained-short')
  if (!baseline) {
    assert.equal(await visible('.mobile-conversation__connection'), true, 'Connection loss remains visible in the active conversation')
    assert.equal(await visible('.mobile-service-notice'), false, 'Same connection fact is not repeated in the shell')
    assert.equal(await visible('.mobile-send-status[data-phase=unknown]'), true, 'Connection loss does not erase unknown delivery')
  }
  assert.equal(await read('document.querySelector("[contenteditable=true]").getAttribute("contenteditable")'), 'true')
  await read('mobileProductScene.reconnect()')
  await resize(390, 844)
  await capture('reconnected-original-draft-phone')
  const calls = await read('mobileProductScene.facts().calls')
  assert.equal(calls.filter(call => call.method === 'sdk.submitAgentPrompt').length, 1, 'Unknown input is never automatically replayed')
  assert.equal(calls.filter(call => call.method === 'sdk.respondAgentInteraction').length, 1)
  result.passed = true
 } catch (error) {
  result.error = { name: error.name, message: error.message, stack: error.stack }
  if (win) { await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()); result.images.push('failed.png') }
 } finally {
  await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
  win?.destroy(); app.exit(result.passed ? 0 : 1)
 }
})
