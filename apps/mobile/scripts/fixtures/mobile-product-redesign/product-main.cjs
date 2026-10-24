const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence, mode, phase] = process.argv.slice(2)
const baseline = mode === 'baseline'
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', physicalPhone: false,
  environment: { pid: process.pid, renderer: 'private Electron Chromium', pointer: 'CDP touchStart/touchEnd', keyboard: 'webContents.insertText', keyboardIme: 'not-observed' },
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
    if (mode === 'commands-entry' && !name.startsWith('commands-')) return
    if (mode === 'notice-center' && !name.startsWith('notices-')) return
    if (mode === 'notice-light' && !['notices-settings-light-short', 'notices-restored-light-short'].includes(name)) return
    if (mode === 'parity-final' && !['focus-overview-phone', 'space-directory-430', 'focus-result-conversation-narrow', 'unknown-details-short-viewport', 'offline-retained-short'].includes(name)) return
    if (mode === 'source-recovery' && !['navigation-offline-source-restored-narrow', 'navigation-reconnected-source-narrow'].includes(name)) return
    await pause(120)
    win.webContents.invalidate()
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await pause(40)
    const facts = await read(`(()=>{const n=document.querySelector('.mobile-app'),e=document.querySelector('[contenteditable=true]');return {text:n.innerText,overlay:document.querySelector('[role=dialog]')?.innerText,overflow:n.scrollWidth>n.clientWidth,root:n.getBoundingClientRect().toJSON(),structure:Object.fromEntries(['.mobile-header','.mobile-main','.mobile-conversation-panel','.mobile-conversation','.mobile-conversation__connection','.mobile-conversation__reading'].map(selector=>{const n=document.querySelector(selector);return[selector,n?{rect:n.getBoundingClientRect().toJSON(),scrollTop:n.scrollTop,position:getComputedStyle(n).position,overflow:getComputedStyle(n).overflowY}:null]})),viewport:{width:innerWidth,height:innerHeight,visualHeight:visualViewport.height,top:visualViewport.offsetTop},selectedSession:document.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id'),editor:{text:e?.textContent,visible:!!e?.getClientRects().length,rect:e?.getBoundingClientRect().toJSON(),sameOriginal:e===window.originalCaptureEditor,focused:document.activeElement===e},...mobileProductScene.facts()}})()`)
    await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
    result.images.push(name + '.png'); result.operations.push({ action: 'capture', name, ...facts })
    if (!baseline) assert.equal(facts.overflow, false, 'Actual mobile app does not overflow horizontally')
  }
  const gap = description => { if (!baseline) throw Error(description); result.gaps.push(description) }
  const openMote = async () => {
    await button('Mote', '.mobile-navigation')
    await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
    await button('日常协作', '.mobile-mote-agents')
    await until('!!document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), 'session-mote')
  }
  if (mode === 'conversation-spacing') {
    await require('./conversation-spacing.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'focus-state') {
    await require('./focus-state.cjs')({ win, read, until, resize, tap, button, capture, result, evidence })
    result.passed = true; return
  }
  if (mode === 'chat-start') {
    await require('./chat-start.cjs')({ win, read, until, resize, tap, button, capture, result, evidence, phase })
    result.passed = true; return
  }
  if (mode === 'conversation-controls') {
    await require('./conversation-controls.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'web-update') {
    await require('./web-update.cjs')({ win, read, until, resize, tap, button, capture, result, evidence })
    result.passed = true; return
  }
  if (mode === 'goal-recovery') {
    await require('./goal-recovery.cjs')({ win, read, until, resize, tap, button, capture, result, evidence, phase })
    result.passed = true; return
  }
  if (mode === 'attachment-upload-exit') {
    await require('./attachment-upload-exit.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'attachment-selection') {
    await require('./attachment-selection.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'goal-exit') {
    await require('./goal-exit.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'mote-home') {
    await button('Mote', '.mobile-navigation')
    await until('document.querySelectorAll(".mobile-mote-choice").length===2')
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.ensureAgentContinuity"||call.method==="agent.open").length'),0)
    assert.equal(await read('document.querySelectorAll(".mobile-mote-quick-open").length'),1)
    await capture('mote-home-selected-phone')
    await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
    await until('document.querySelectorAll(".mobile-mote-agents .mobile-agent-row__open").length===2')
    assert.equal(await read('document.querySelectorAll(".mobile-spatial-tab").length'),0)
    await button('选择 Mote · 资料协作', '.mobile-spatial-panel')
    assert.equal(await read('document.querySelectorAll(".mobile-spatial-tab").length'),0)
    assert.equal(await read('document.querySelectorAll(".mobile-mote-selected").length'),1)
    assert.equal(await read('document.querySelector(".mobile-mote-selected").dataset.spaceId'),'mote-resources')
    assert.equal(await read('!!document.querySelector(".mobile-mote-selected > header .mobile-mote-profile-action")'),true)
    for (const [width,height,label] of [[390,844,'phone'],[320,760,'narrow'],[840,900,'wide']]) {
      await resize(width,height); await capture('mote-home-expanded-'+label)
      const actions = await read('Array.from(document.querySelectorAll(".mobile-mote-quick-open")).map(node=>node.getBoundingClientRect().toJSON())')
      assert.ok(actions.every(rect=>rect.height>=44&&rect.left>=0&&rect.right<=width),'Permanent main actions retain original touch targets')
    }
    await resize(390,844); await button('设置主 Agent · 资料协作', '.mobile-spatial-panel')
    await until('!!document.querySelector(".mobile-mote-profile")'); await capture('mote-home-profile-phone')
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.ensureAgentContinuity"||call.method==="agent.open").length'),0)
    await button('关闭面板', '[role=dialog]')
    await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
    await button('继续主对话 · 我的 Mote', '.mobile-spatial-panel')
    await until('mobileProductScene.facts().calls.some(call=>call.method==="sdk.ensureAgentContinuity")')
    assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'),'session-mote')
    assert.equal(await read('mobileProductScene.facts().calls.find(call=>call.method==="sdk.ensureAgentContinuity").params.trigger'),'manual')
    await capture('mote-home-main-conversation-phone')
    await button('Focus', '.mobile-navigation')
    await until('document.querySelectorAll(".mobile-focus-project .agent-provider-icon").length>=4 && document.querySelector(".mobile-focus-project")?.getClientRects().length>0')
    for (const [width,height,label] of [[390,844,'phone'],[320,760,'narrow']]) {
      await resize(width,height)
      const marks = await read('Array.from(document.querySelectorAll(".mobile-focus-project .agent-provider-icon")).map(node=>({provider:node.dataset.agentProvider,rect:node.getBoundingClientRect().toJSON(),display:getComputedStyle(node).display,lineHeight:getComputedStyle(node).lineHeight,source:node.firstElementChild.getBoundingClientRect().toJSON()}))')
      result.operations.push({action:'shared-provider-artwork-geometry',width,marks})
      assert.ok(marks.length>=4); assert.ok(marks.some(mark=>mark.provider==='claude'))
      assert.ok(marks.every(mark=>mark.rect.width===14&&mark.rect.height===14&&mark.source.width===14&&mark.source.height===14&&['flex','inline-flex'].includes(mark.display)),'Original shared Provider artwork retains its compact geometry')
      const ids=await read('Array.from(document.querySelectorAll(".agent-avatar__filters filter")).map(node=>node.id)')
      assert.equal(new Set(ids).size,ids.length,'Every repeated original Agent artwork owns a distinct filter definition')
      result.operations.push({action:'shared-provider-filter-identities',width,filterIds:ids})
      await capture('provider-icons-'+label)
    }
    await read('mobileProductScene.unconfirmMoteBindings()')
    await button('Mote', '.mobile-navigation'); await button('刷新空间目录', '.mobile-spatial-panel')
    await button('选择 Mote · 我的 Mote', '.mobile-spatial-panel')
    await until('!!document.querySelector(".mobile-directory-notice")&&document.querySelector(\'[data-space-id="mote-original"] .mobile-mote-contents\')?.textContent.includes("原 Agent 绑定尚未确认")')
    assert.equal(await read('document.querySelector(\'[data-space-id="mote-original"] .mobile-mote-contents\').textContent.includes("尚无已绑定 Agent")'),false)
    await capture('mote-binding-unknown-narrow')
    await tap('.mobile-directory-notice summary', 'Expand original binding diagnostic')
    assert.equal(await read('document.querySelector(".mobile-directory-notice").open'),true)
    await capture('mote-binding-diagnostic-narrow')
    await tap('.mobile-directory-notice summary', 'Collapse original binding diagnostic')
    assert.equal(await read('document.querySelector(".mobile-directory-notice").open'),false)
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="agent.open"||call.method==="sdk.submitAgentPrompt").length'),0)
    result.passed=true; return
  }
  if (mode === 'spatial-resources' && phase === 'restore') {
    await until('typeof mobileProductScene!=="undefined"&&mobileProductScene.facts().record.agentCreates?.length===2')
    const saved = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).recoveryOriginal
    const retained = await read('mobileProductScene.facts().record')
    for (const key of ['selectedSessionId', 'presentation', 'agentCreates', 'conversation']) assert.deepEqual(retained[key], saved[key], `Original ${key} survives a real product process restart`)
    await until('document.querySelector("[contenteditable=true]")?.textContent.includes("原草稿在重启后保留")')
    await capture('spatial-recovery-draft-phone')
    await button('Mote', '.mobile-navigation')
    await button('Space', '.mobile-navigation'); await button('资料工作区', '.mobile-spatial-panel')
    await button('在此启动位新建 Agent', '.mobile-spatial-panel')
    await until('document.querySelectorAll(".mobile-create-receipt").length===2')
    await capture('spatial-recovery-intents-phone')
    await button('核对原创建操作', '[role=dialog]')
    await until('mobileProductScene.facts().calls.some(call=>call.method==="space.inspect"&&call.params.target?.operationId==="retained-new-tab")')
    await read(`(()=>{const row=[...document.querySelectorAll('.mobile-create-receipt')].find(node=>node.textContent.includes('retained-launcher'));const action=[...row.querySelectorAll('button')].find(node=>node.textContent==='核对原创建操作');action.setAttribute('data-retained-launcher-inspect','true')})()`)
    await tap('[data-retained-launcher-inspect="true"]', 'Inspect the retained original Launcher operation')
    await until('mobileProductScene.facts().calls.some(call=>call.method==="space.inspect"&&call.params.target?.operationId==="retained-launcher")')
    const facts = await read('mobileProductScene.facts()')
    assert.equal(facts.calls.filter(call=>call.method==='agent.open'||call.method==='sdk.submitAgentPrompt').length,0)
    assert.deepEqual(facts.record.agentCreates, saved.agentCreates)
    result.recoveryRestored = facts.record; result.passed = true; return
  }
  // Legacy directory probes enter their own source explicitly; startup now opens chat.
  await button('Space', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-spatial-panel .mobile-session-list button")')
  result.palette = await read(`(()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(['--surface-0','--surface-1','--green','--amber','--red','--fs-body'].map(k=>[k,s.getPropertyValue(k).trim()]))})()`)
  if (!baseline) {
    assert.equal(result.palette['--surface-1'], '#171b21', 'Original MobileApp consumes the shared Graphite palette')
    assert.equal(result.palette['--green'], '#8de3ae', 'Original MobileApp consumes the shared Mint action color')
    assert.equal(result.palette['--fs-body'], '13px', 'Mobile typography remains client-owned')
  }
  if (mode === 'conversation-attachments') {
    await require('./conversation-attachments.cjs')({ win, read, until, resize, tap, button, capture, result, evidence })
    result.passed = true; return
  }
  if (mode === 'conversation-density-hit') {
    await require('./conversation-density-hit.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'conversation-density') {
    await require('./conversation-density.cjs')({ win, read, until, resize, tap, button, capture, result })
    result.passed = true; return
  }
  if (mode === 'agent-menu' || mode === 'agent-menu-notice') {
    await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 4 })
    result.environment.cpuThrottlingRate = 4
    result.performance = []
    await read('mobileProductScene.prepareAgentMenu();mobileProductScene.seedMenuDirectory(20)')
    const agentName = await read('mobileProductScene.facts().menuAgentName')
    const draft = '这份原草稿在切换工作面时保留。'
    const flush = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const noDialog = '!document.querySelector("[role=dialog]")'
    const menuReady = `(()=>{const d=document.querySelector('[role=dialog]'),close=d?.querySelector('[aria-label="关闭面板"]'),copy=d?.querySelector('[aria-label="复制 Agent 身份链接"]');if(!close||!copy||close.disabled||copy.disabled)return false;const r=close.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>=44&&r.height>=44&&(hit===close||close.contains(hit))})()`
    const measure = async (count, label, ready, action, event = 'click') => {
      await flush()
      const before = await read('mobileProductScene.facts()')
      await read(`mobileProductScene.resetDirectoryWork();window.mobileFrameMeasure={label:${JSON.stringify(label)},event:${JSON.stringify(event)},started:null,ready:null,frames:0};document.addEventListener(${JSON.stringify(event)},()=>{const m=window.mobileFrameMeasure;m.started=performance.now();const check=()=>{m.frames++;if(${ready})m.ready=performance.now();else requestAnimationFrame(check)};requestAnimationFrame(check)},{capture:true,once:true})`)
      await action()
      await until('window.mobileFrameMeasure.ready!==null')
      const timing = await read('window.mobileFrameMeasure')
      await flush()
      const after = await read('mobileProductScene.facts()')
      const calls = after.calls.slice(before.calls.length)
      const sample = { count, label, event, milliseconds: timing.ready - timing.started, frames: timing.frames,
        sdkFullSnapshotCalls: calls.filter(call => call.method === 'sdk.agentSessions').length,
        appSnapshotCalls: calls.filter(call => call.method === 'app.snapshot').length,
        directoryComparisons: after.directoryComparisons, directoryFacts: after.directoryFacts, directoryScope: after.directoryScope }
      result.performance.push(sample)
      return sample
    }
    const enterOriginal = async () => {
      await button('Mote', '.mobile-navigation')
      if (await read('document.querySelector(\'[data-space-id="mote-original"] .mobile-space-row\')?.getAttribute("aria-expanded")!=="true"')) await button('我的 Mote', '.mobile-spatial-panel')
      await button(agentName, '[data-space-id="mote-original"] .mobile-mote-agents')
      await until('!!document.querySelector(' + JSON.stringify('.mobile-conversation-panel:not([hidden]) [data-native-record-id="session-mote-answer-original"] .log-turn__body') + ')')
    }
    await button('刷新空间目录', '.mobile-spatial-panel')
    // The initial workface may already show this Session's pre-fixture history.
    // Switch to another original Session so reopening reads the prepared page.
    await button('Focus', '.mobile-navigation')
    await button('实验建议', '.mobile-focus-project')
    await enterOriginal()
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Preserved original Composer')
    win.webContents.insertText(draft)
    await until(`mobileProductScene.facts().record.conversation.drafts.some(([,text])=>text===${JSON.stringify(draft)})`)
    await read('window.originalCaptureEditor=document.querySelector("[contenteditable=true]")')
    const originalFacts = await read('mobileProductScene.facts()')
    result.original = { selectedSessionId: originalFacts.record.selectedSessionId, identity: originalFacts.record.presentation.identity,
      run: originalFacts.sessionIds.find(session => session.sessionId === 'session-mote'), draft }
    const openMore = () => button(agentName + ' · 更多操作', '.mobile-focus-project')
    const close = () => button('关闭面板', '[role=dialog]')
    const escape = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await until(noDialog)
    }
    for (const count of mode === 'agent-menu-notice' ? [] : [20, 160]) {
      await read(`mobileProductScene.seedMenuDirectory(${count})`)
      await button('Focus', '.mobile-navigation')
      await button('刷新空间目录', '.mobile-spatial-panel')
      await until(`document.querySelectorAll('.mobile-focus-project .mobile-agent-row__more').length>=${count}`)
      await read('mobileProductScene.holdInspection()')
      await measure(count, 'More while inspect is pending', menuReady, openMore)
      const pending = await read('document.querySelector("[role=dialog] .mobile-agent-usage").textContent')
      assert.ok(pending.includes('正在核对') && pending.includes('原生 Session 累计'), 'The first actionable menu does not wait for remote inspect')
      assert.equal(await read('document.querySelector("[role=dialog] progress").value'), 52700)
      assert.equal(await read('document.querySelector("[role=dialog] progress").max'), 200000)
      await measure(count, 'Close menu', noDialog, close)
      await measure(count, 'More before Escape', menuReady, openMore)
      await measure(count, 'Escape menu', noDialog, escape, 'keydown')
      await measure(count, 'More before browser Back', menuReady, openMore)
      await read('history.back()'); await until(noDialog)
      await read('mobileProductScene.releaseInspection()')
      for (const workface of ['goals', 'topics', 'mote', 'space', 'focus', 'mote']) {
        const ready = `(()=>{const active=document.querySelector('.mobile-navigation [data-workface=${JSON.stringify(workface)}]');return active?.getAttribute('aria-current')==='page'&&active.getClientRects().length>0&&document.querySelector('.mobile-conversation-panel').hidden})()`
        await measure(count, 'Primary ' + workface, ready, () => tap(`.mobile-navigation [data-workface="${workface}"]`, 'Primary ' + workface))
      }
      await enterOriginal()
      assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true, 'Primary navigation retains the original Composer DOM')
      assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), draft)
      const restored = await read('mobileProductScene.facts()')
      assert.equal(restored.record.selectedSessionId, result.original.selectedSessionId)
      assert.deepEqual(restored.record.presentation.identity, result.original.identity)
      assert.deepEqual(restored.sessionIds.find(session => session.sessionId === 'session-mote'), result.original.run)
      result.operations.push({ action: 'primary-round-trip', count, sameComposer: true, originalDraft: true, exactSessionRunAndReading: true, directoryScope: restored.directoryScope })
    }
    // Cost assertions run after both populations are observed, before capture pauses or visual work.
    for (const sample of result.performance) {
      assert.ok(sample.appSnapshotCalls <= (sample.label === 'Primary goals' ? 1 : 0), 'Only the visible Goals owner may request its own app snapshot')
      assert.equal(sample.sdkFullSnapshotCalls, 0, 'Menu and primary navigation must not recopy unrelated Session snapshots')
      assert.ok(sample.directoryComparisons <= sample.directoryFacts * 16, 'Directory predicate work must stay within a linear facts budget')
    }
    await button('Focus', '.mobile-navigation')
    await read('mobileProductScene.holdInspection()')
    await openMore(); await until(menuReady)
    await capture('agent-menu-pending-390-dark')
    await button('复制 Agent 身份链接', '[role=dialog]')
    assert.equal(await read('mobileProductScene.facts().copiedTexts.at(-1)'), 'amux://agent/session-mote')
    await close(); await until(noDialog)
    // A real touch hold opens the same original row menu without selecting its conversation.
    const hold = await read(`(()=>{const n=[...document.querySelectorAll('.mobile-focus-project .mobile-agent-row__open')].find(n=>n.querySelector('strong')?.textContent===${JSON.stringify(agentName)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...hold, radiusX: 1, radiusY: 1, force: 1, id: 1 }] })
    await until(menuReady)
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    assert.equal(await read('mobileProductScene.facts().record.selectedSessionId'), result.original.selectedSessionId)
    await close(); await until(noDialog); await read('mobileProductScene.releaseInspection();mobileProductScene.failInspection(true);mobileProductScene.setAppearance("light")')
    await resize(320, 568); await openMore()
    await until('document.querySelector("[role=dialog] .mobile-agent-usage").textContent.includes("读取消耗未完成")')
    const notice = await read(`(()=>{const n=document.querySelector('.mobile-agent-usage > .mobile-notice'),c=document.querySelector('.mobile-agent-usage__context'),b=n.querySelector('button');return{warning:n.getBoundingClientRect().toJSON(),context:c.getBoundingClientRect().toJSON(),close:b.getBoundingClientRect().toJSON(),font:getComputedStyle(n).fontSize,text:n.textContent}})()`)
    result.operations.push({ action: 'failed-usage-notice-geometry', ...notice })
    assert.equal(notice.font, '13px', 'Failed read notice follows the same compact mobile body type')
    assert.ok(notice.warning.bottom + 8 <= notice.context.top + 0.5, 'Failed read notice leaves eight pixels before context usage')
    assert.ok(notice.close.width >= 44 && notice.close.height >= 44, 'Failed read notice keeps its full close target')
    await capture('agent-menu-failure-320-light-short')
    await button('复制 Agent 身份链接', '[role=dialog]')
    assert.equal(await read('mobileProductScene.facts().copiedTexts.at(-1)'), 'amux://agent/session-mote')
    await read('mobileProductScene.failInspection(false)'); await button('刷新消耗', '[role=dialog]')
    await until('!document.querySelector("[role=dialog] .mobile-agent-usage").textContent.includes("读取消耗未完成")&&document.querySelector("[role=dialog] .mobile-agent-usage").textContent.includes("原生观测")')
    await capture('agent-menu-320-light-short')
    await escape(); await resize(390, 480); await read('mobileProductScene.setAppearance("dark")'); await openMore(); await until(menuReady)
    await capture('agent-menu-390-dark-short'); await close(); await until(noDialog)
    await enterOriginal()
    const longUser = '[data-native-record-id="session-mote-user-original"] .log-turn'
    const shortUser = '[data-native-record-id="session-mote-user-short"] .log-turn'
    const reply = '[data-native-record-id="session-mote-answer-original"] .log-turn'
    const bubbleFacts = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=e=>e.getBoundingClientRect().toJSON();return{row:r(n),head:r(n.querySelector('.log-turn__head')),body:r(n.querySelector('.log-turn__body')),time:r(n.querySelector('.log-turn__time')),copy:r(n.querySelector('[title="Copy message"]')),info:r(n.querySelector('[aria-label="Message details"]')),avatar:r(n.querySelector('.log-turn__node')),clock:n.querySelector('.log-turn__time').textContent,sid:n.querySelector('.log-turn__sender-id code')?.textContent,sidText:n.querySelector('.log-turn__sender-id code')?r(n.querySelector('.log-turn__sender-id code')):null,idCopy:n.querySelector('.log-turn__id-copy')?r(n.querySelector('.log-turn__id-copy')):null,headScroll:n.querySelector('.log-turn__head').scrollWidth,headClient:n.querySelector('.log-turn__head').clientWidth}})()`)
    for (const [width, height, appearance] of [[390, 844, 'dark'], [320, 760, 'light']]) {
      await resize(width, height); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)});document.querySelector(${JSON.stringify(shortUser)}).scrollIntoView({block:'start'})`)
      await flush()
      const bubbles = []
      for (const selector of [shortUser, longUser, reply]) {
        const facts = await bubbleFacts(selector), middle = r => r.y + r.height / 2
        assert.match(facts.clock, /^\d{2}:\d{2}:\d{2}$/)
        assert.equal(facts.headScroll <= facts.headClient + 1, true)
        assert.ok(facts.copy.width >= 44 && facts.copy.height >= 44 && facts.info.width >= 44 && facts.info.height >= 44)
        assert.ok(Math.abs(middle(facts.time) - middle(facts.copy)) <= 1 && Math.abs(middle(facts.info) - middle(facts.copy)) <= 1)
        assert.ok(Math.abs(middle(facts.avatar) - middle(facts.copy)) <= 1)
        assert.equal(facts.avatar.width, selector === reply ? 32 : 20)
        assert.ok(facts.body.y >= facts.head.bottom - 1)
        bubbles.push(facts)
      }
      assert.equal(bubbles[2].sid, undefined, 'Compact header keeps identity in the existing details')
      await tap(reply + ' .conversation-input-details__toggle', 'Read exact sender identity')
      await until(`!!document.querySelector(${JSON.stringify(reply + ' .log-turn__id-copy')})`)
      const sender = await bubbleFacts(reply)
      assert.equal(sender.sid, 'session-mote')
      assert.ok(sender.idCopy.width >= 44 && sender.idCopy.height >= 44, 'Exact Agent identity Copy keeps its full 44px target')
      assert.ok(sender.sidText.width > 0 && Math.abs((sender.sidText.y + sender.sidText.height / 2) - (sender.idCopy.y + sender.idCopy.height / 2)) <= 1, 'Exact Agent identity and Copy must share a single flex row')
      await tap(reply + ' .conversation-input-details__toggle', 'Close sender details')
      result.operations.push({ action: 'actual-mobile-bubble-geometry', width, height, appearance, bubbles })
      await capture(`message-bubbles-${width}-${appearance}`)
    }
    await read(`document.querySelector(${JSON.stringify(reply)}).scrollIntoView({block:'start'});mobileProductScene.setCopyFailure(true)`)
    await tap(reply + ' [title="Copy message"]', 'Original response Copy failure')
    await until(`!!document.querySelector(${JSON.stringify(reply + ' .log-turn__copy-error')})`)
    await tap(reply + ' .conversation-input-details__toggle', 'Original response Info')
    await until(`!!document.querySelector(${JSON.stringify(reply + ' .conversation-input-details__body')})`)
    await capture('message-copy-failure-info-320-light')
    await read('mobileProductScene.setCopyFailure(false)')
    await tap(reply + ' [title="Copy message"]', 'Retry exact original response Copy')
    await until(`!document.querySelector(${JSON.stringify(reply + ' .log-turn__copy-error')})`)
    assert.ok(await read(`!!document.querySelector(${JSON.stringify(reply + ' .conversation-input-details__body')})`))
    assert.equal(await read('mobileProductScene.facts().copiedTexts.at(-1)===mobileProductScene.facts().expectedReply'), true, 'Retry copies the complete original response')
    await tap(reply + ' .conversation-input-details__toggle', 'Close original response Info')
    await tap(longUser + ' .conversation-input-details__toggle', 'Read complete original input source')
    await until(`!!document.querySelector(${JSON.stringify(longUser + ' .conversation-input-details__body')})`)
    const sourceDetails = await read(`(()=>{const n=document.querySelector(${JSON.stringify(longUser)}),d=n.querySelector('.conversation-input-details__body'),h=n.querySelector('.log-turn__head');return{text:d.textContent,details:d.getBoundingClientRect().toJSON(),head:h.getBoundingClientRect().toJSON()}})()`)
    assert.ok(sourceDetails.text.includes('-original-source-reference'.repeat(6)), 'The complete long native source reference remains readable')
    assert.ok(sourceDetails.details.left >= sourceDetails.head.left - 1 && sourceDetails.details.right <= sourceDetails.head.right + 1)
    await capture('message-user-source-info-320-light')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor&&document.querySelector("[contenteditable=true]").textContent===' + JSON.stringify(draft)), true)
    const final = await read('mobileProductScene.facts()')
    assert.equal(final.calls.filter(call => call.method === 'sdk.submitAgentPrompt' || call.method === 'sdk.respondAgentInteraction' || call.method === 'sdk.ensureAgentContinuity' || call.method === 'agent.open').length, 0, 'Presentation journey does not send input or recover/create an Agent')
    result.final = { selectedSessionId: final.record.selectedSessionId, run: final.sessionIds.find(session => session.sessionId === 'session-mote'), controlledCopy: final.controlledCopy, copiedTexts: final.copiedTexts }
    result.passed = true; return
  }
  if (mode === 'spatial-resources') {
    await button('Space', '.mobile-navigation'); await button('资料工作区', '.mobile-spatial-panel')
    await until('document.querySelectorAll(".mobile-spatial-tab").length===5')
    assert.equal(await read('document.querySelectorAll(".mobile-spatial-tab > h3").length'), 0)
    for (const [width,height,name] of [[390,844,'phone'],[320,760,'narrow'],[840,900,'wide']]) {
      await resize(width,height)
      const rows = await read(`Array.from(document.querySelectorAll('.mobile-spatial-tab button')).map(node=>({row:node.getBoundingClientRect().toJSON(),icon:node.querySelector('svg').getBoundingClientRect().toJSON(),copy:node.querySelector('span').getBoundingClientRect().toJSON(),arrow:node.querySelector('svg:last-child').getBoundingClientRect().toJSON()}))`)
      assert.equal(rows.length,5)
      for(const row of rows){assert.ok(row.icon.left-row.row.left<=12,'Leading resource icon stays in the left column');assert.ok(row.copy.left>=row.icon.right&&row.copy.left-row.icon.right<=16,'Resource copy follows its leading icon');assert.ok(row.arrow.right<=row.row.right&&row.row.right-row.arrow.right<=12,'Disclosure stays at the trailing edge');assert.ok(row.row.height>=44)}
      result.operations.push({action:'resource-row-geometry',width,rows})
      await capture('spatial-resources-'+name)
    }
    await resize(390,844); await button('在此启动位新建 Agent', '.mobile-spatial-panel')
    await until('!!document.querySelector(".mobile-create-target")')
    assert.equal(await read(`document.querySelector('[aria-label="新 Agent 空间"]').value`), "space-resources")
    assert.equal(await read(`document.querySelector('[aria-label="新 Agent Zone"]').value`), "zone-resources")
    await capture('spatial-launcher-phone'); await resize(320,760); await capture('spatial-launcher-narrow')
    await button('关闭新建 Agent', '[role=dialog]')
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="agent.open").length'),0)
    await resize(390,844); await openMote()
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Original draft before private process restart')
    win.webContents.insertText('原草稿在重启后保留')
    await until('mobileProductScene.facts().record.conversation?.drafts.some(([,text])=>text.includes("原草稿在重启后保留"))')
    await read('mobileProductScene.seedSpatialRecovery()')
    result.recoveryOriginal = await read('mobileProductScene.facts().record')
    await capture('spatial-recovery-before-phone')
    result.passed = true; return
  }
  await capture('mote-overview-phone')
  await openMote()
  await read('window.originalCaptureEditor=document.querySelector("[contenteditable=true]")')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Original shared Composer')
  win.webContents.insertText('先比较两种方案，保留原来的依据。')
  await capture('mote-conversation-phone')
  if (mode === 'notice-center' || mode === 'notice-light') {
    if (mode === 'notice-light') {
      await read('mobileProductScene.setAppearance("light")')
      await until('document.documentElement.dataset.appearance==="light"')
    }
    await resize(320, 568)
    await read('mobileProductScene.offline()')
    await until('!!document.querySelector(".mobile-conversation__connection .mobile-notice__dismiss")')
    await capture('notices-offline-narrow-short')
    await tap('.mobile-conversation__connection .mobile-notice__dismiss', 'Dismiss original connection notice')
    assert.equal(await visible('.mobile-conversation__connection'), false)
    await button('手机设置与连接')
    await capture('notices-menu-narrow-short')
    await button('提醒与诊断', '[role=dialog]')
    if (mode === 'notice-light') assert.equal(await read('document.documentElement.dataset.appearance'), 'light')
    await resize(430, 480)
    await capture(mode === 'notice-light' ? 'notices-settings-light-short' : 'notices-settings-short')
    await button('恢复已收起提醒', '[role=dialog]')
    assert.equal(await visible('.mobile-conversation__connection'), true)
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
    await capture(mode === 'notice-light' ? 'notices-restored-light-short' : 'notices-restored-short')
    if (mode === 'notice-light') {
      assert.equal(await read('document.documentElement.dataset.appearance'), 'light')
      result.passed = true
      return
    }
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length'), 0)
    await read('mobileProductScene.reconnect();mobileProductScene.unknownNext()')
    await until('!document.querySelector(".mobile-conversation__connection")')
    await button('Send')
    await until('!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
    const packet = await read('JSON.stringify(mobileProductScene.facts().record.conversation.attempts)')
    await button('关闭操作说明', '.mobile-send-status')
    assert.equal(await visible('.mobile-send-status--collapsed'), true)
    await button('手机设置与连接'); await button('提醒与诊断', '[role=dialog]'); await button('恢复已收起提醒', '[role=dialog]')
    await until('!document.querySelector(".mobile-send-status--collapsed")&&!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
    assert.equal(await read('JSON.stringify(mobileProductScene.facts().record.conversation.attempts)'), packet)
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length'), 1)
    await read('mobileProductScene.setAppearance("dark")'); await resize(390, 480)
    await capture('notices-unknown-restored-short')
    const target = result.operations.find(value => value.target === 'Dismiss original connection notice' && value.action === 'touch').observed.rect
    assert.ok(target.width >= 44 && target.height >= 44)
    result.passed = true
    return
  }
  if (mode === 'commands-entry') {
    assert.equal(await read('document.querySelector(".composer-tools").dataset.mode'), 'collapsed')
    await capture('commands-entry-phone')
    await resize(320, 568)
    await capture('commands-entry-narrow-short')
    await button('Choose a command')
    await until('!!document.querySelector(".mobile-command-menu")')
    await until('document.querySelector(".mobile-command-menu").innerText.includes("核对依据")')
    assert.ok(await read('document.querySelector(".mobile-command-menu").textContent.includes("Shortcuts")&&document.querySelector(".mobile-command-menu").textContent.includes("Agent commands")'))
    assert.equal(await read('document.querySelector(".mobile-command-menu").innerText.includes("另一 Provider 专用")'), false)
    await capture('commands-menu-narrow-short')
    await read('mobileProductScene.setAppearance("light")')
    await resize(430, 480)
    await capture('commands-menu-light-short')
    await tap('input[aria-label="查找命令"]', 'Search original Provider Commands')
    win.webContents.insertText('compact')
    await until('document.querySelectorAll(".mobile-command-menu [role=menuitem]").length>0')
    const command = await read('document.querySelector(".mobile-command-menu [role=menuitem] strong").textContent')
    await button(command, '.mobile-command-menu')
    assert.equal(await visible('.mobile-command-menu'), false)
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    const text = await read('document.querySelector("[contenteditable=true]").textContent')
    assert.ok(text.includes('先比较两种方案，保留原来的依据。') && text.includes(command))
    const target = result.operations.find(value => value.target === 'Choose a command' && value.action === 'touch').observed.rect
    assert.ok(target.width >= 44 && target.height >= 44)
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length'), 0)
    assert.equal(await read('document.querySelector("[contenteditable=true] [data-tool-reference]").title'), 'Expand prompt: 逐项核对原始依据，保留未知与引用。')
    await capture('commands-inserted-light-short')
    await resize(390, 844)
    await read('mobileProductScene.setAppearance("dark")')
    await capture('commands-custom-phone')
    await read('mobileProductScene.setPromptReadFailure(true)')
    await button('Choose a command')
    await until('document.querySelector(".mobile-command-menu").innerText.includes("重试读取 Commands")')
    await capture('commands-error-phone')
    await read('mobileProductScene.setPromptReadFailure(false)')
    await button('重试读取 Commands', '.mobile-command-menu')
    const retryTarget = result.operations.find(value => value.target === '重试读取 Commands' && value.action === 'touch').observed.rect
    assert.ok(retryTarget.width >= 44 && retryTarget.height >= 44, 'The actual retry action keeps its mobile touch target')
    await until('!document.querySelector(".mobile-command-menu").innerText.includes("重试读取 Commands")')
    await button('Choose a command')
    result.passed = true
    return
  }
  if (mode === 'input-history') {
    const before = await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length')
    assert.ok(await read('document.querySelector(".mobile-message-tools__trigger").getAttribute("aria-label").includes("输入历史")'))
    await capture('input-history-entry-phone')
    await tap('.mobile-conversation-panel .mobile-message-tools__trigger', 'Current Agent input history')
    await until('document.querySelector(".input-history__records")?.textContent.includes("Message Tool")')
    assert.ok(await read('document.querySelector("[role=dialog]").innerText.includes("入口未记录")'))
    await capture('input-history-phone')
    await resize(320, 760); await capture('input-history-narrow')
    await tap('.input-history input[type=search]', 'Search only this Agent')
    win.webContents.insertText('实验依据')
    await button('查询', '[role=dialog]')
    await until('document.querySelector(".input-history__empty")?.textContent.includes("可继续查找")')
    await capture('input-history-partial-narrow')
    await button('继续查找原生记录', '[role=dialog]')
    await until('document.querySelector(".input-history__records")?.textContent.includes("三份样本")')
    await capture('input-history-result-narrow')
    await tap('.input-history__records > li details > summary', 'Read the original input record')
    await until('!!document.querySelector(".input-history__records [data-message-id]")')
    await capture('input-history-original-narrow')
    const originalGeometry = await read(`(()=>{const sheet=document.querySelector('[role=dialog]'),record=document.querySelector('.input-history__records [data-message-id]');return {sheet:{width:sheet.clientWidth,scrollWidth:sheet.scrollWidth},record:{width:record.clientWidth,scrollWidth:record.scrollWidth},buttons:[...sheet.querySelectorAll('.input-history button')].map(n=>({label:n.getAttribute('aria-label')||n.textContent,rect:n.getBoundingClientRect().toJSON()}))}})()`)
    assert.ok(originalGeometry.sheet.scrollWidth <= originalGeometry.sheet.width, 'Original-record sheet remains readable at 320px')
    assert.ok(originalGeometry.record.scrollWidth <= originalGeometry.record.width, 'Original record does not create horizontal scrolling')
    for (const label of ['查询当前 Agent 输入历史', '填入草稿', '复制正文']) assert.ok(originalGeometry.buttons.some(target => target.label.trim() === label), `Original history action ${label} was actually inspected`)
    for (const target of originalGeometry.buttons) assert.ok(target.rect.width >= 44 && target.rect.height >= 44, `${target.label} keeps a 44px touch target`)
    result.operations.push({action:'original-record-geometry',...originalGeometry})
    await tap('.input-history__records > li details > summary', 'Close the original record reading')
    await button('填入草稿', '[role=dialog]')
    await until('document.querySelector("[role=dialog]")?.textContent.includes("尚未发送")')
    await button('关闭通信记录', '[role=dialog]')
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '更早的实验依据：先比较三份样本，再决定是否继续。')
    await tap('.mobile-conversation-panel [contenteditable=true]', 'Undo original draft fill')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] })
    await until('document.querySelector("[contenteditable=true]").textContent==="先比较两种方案，保留原来的依据。"')
    await capture('input-history-undo-narrow')
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length'), before)
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.respondAgentInteraction").length'), 0)
    result.passed = true
    return
  }
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
    await button('目标与结果', '.mobile-conversation__floating-tools')
    await until('!!document.querySelector(".mobile-goal-panel:not([hidden])")')
    await back(); await until('!!document.querySelector(".mobile-conversation-panel:not([hidden])")')
    await button('查看终端', '.mobile-header')
    await until('!!document.querySelector(".mobile-terminal-panel:not([hidden])")')
    await back(); await until('!!document.querySelector(".mobile-conversation-panel:not([hidden])")')
    await tap('.mobile-mote-heading', 'Profile before reload'); await button('合作方式 · BEHAVIOR.md')
    await until('mobileProductScene.facts().record.presentation?.profile?.sourcePath==="BEHAVIOR.md"')
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
  // Exercise real retained workfaces with nonempty original-owner data, not just navigation icons.
  await resize(360, 740)
  await button('Topics', '.mobile-navigation')
  await button('产品与研究', '.mobile-topics')
  await until('!!document.querySelector(".mobile-topics-topic")')
  await capture('topics-directory-360')
  await button('让小实验更容易开始', '.mobile-topics')
  await until('!!document.querySelector(".mobile-topic-workface:not([hidden]) button")')
  await capture('topics-discussion-360')
  await button('知识', '.mobile-topics-tabs')
  await until('document.querySelector(".mobile-topics").innerText.includes("第一周的实验依据")')
  await capture('topics-knowledge-360')
  await button('第一周的实验依据', '.mobile-topics')
  await until('document.querySelector(".mobile-topics").innerText.includes("从一个小实验开始")')
  await capture('topics-reading-360')
  await read('mobileProductScene.setAppearance("light")'); await resize(430, 740)
  await capture('topics-reading-light-430')
  await button('Goals', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-goals-list button")')
  await capture('goals-directory-light-430')
  await button('把两个想法变成一个小实验', '.mobile-goals-list')
  await until('document.querySelector(".mobile-goals").innerText.includes("目标与成功标准")')
  await capture('goals-detail-light-430')
  await read('mobileProductScene.setAppearance("dark")'); await resize(360, 480)
  await capture('goals-detail-short-360')
  await button('返回目标列表', '.mobile-goals')
  await capture('goals-directory-short-360')
  await button('手机设置与连接')
  await button('Survey', '[role=dialog]')
  await until('document.querySelector(".mobile-survey").innerText.includes("本周实验资料")')
  await capture('survey-directory-short-360')
  await button('本周实验资料', '.mobile-survey')
  await until('!!document.querySelector(".mobile-survey-tab")')
  await capture('survey-workface-short-360')
  await read('mobileProductScene.setAppearance("light")'); await resize(430, 740)
  await capture('survey-workface-light-430')
  await button('返回研究列表', '.mobile-survey')
  await capture('survey-directory-light-430')
  await button('Space', '.mobile-navigation')
  await capture('space-directory-light-430')
  await read('mobileProductScene.setAppearance("dark")'); await resize(390, 844)
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
    await read('mobileProductScene.setAppearance("light")')
    await capture('mote-profile-light-narrow')
    if (!baseline) assert.equal(await read('getComputedStyle(document.querySelector(".mobile-sheet")).backgroundColor'), 'rgb(238, 241, 239)', 'Profile reads the same light appearance role')
    await read('mobileProductScene.setAppearance("dark")')
    await button('合作方式 · BEHAVIOR.md')
    await until('document.querySelector(".mobile-mote-source").textContent.includes("我们围绕你的原始目标")')
    await capture('mote-original-source-narrow')
    await button('返回资料')
    await button('关闭面板')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
  } else gap('Mote main-conversation entry lost its original Mote context; avatar/Profile unavailable.')
  await resize(390, 844)
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
    const evidenceTargets = await read(`[...document.querySelectorAll('.mobile-goal-evidence button')].filter(n=>n.getClientRects().length).map(n=>({label:n.textContent,rect:n.getBoundingClientRect().toJSON()}))`)
    assert.ok(evidenceTargets.length > 0, 'Original result evidence actions were inspected')
    for (const target of evidenceTargets) assert.ok(target.rect.width >= 44 && target.rect.height >= 44, `${target.label} retains a 44px touch target`)
    if (!await hasButton('返回原对话') && await hasButton('当前对话操作')) await button('当前对话操作')
    await button('返回原对话')
    assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
    assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
  } else gap('Visible Mote context did not expose the original goal/result action.')
  await resize(390, 844)
  await button('Focus', '.mobile-navigation')
  await until('!!document.querySelector(".mobile-spatial-panel .mobile-session-list button")')
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
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Focus result Composer')
  win.webContents.insertText('好，先按方案 A 准备第一轮实验。')
  await button('Send')
  await until('document.querySelector("[contenteditable=true]").textContent===""')
  assert.equal(await visible('.message-delivery-failure'), false, 'Normal explicit Send converges quietly without a failure card')
  assert.equal(await visible('.mobile-send-status'), false, 'Normal explicit Send does not leave a persistent diagnostic banner')
  await capture('focus-confirmed-send-narrow')
  await openMote()
  assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
  assert.equal(await read('document.querySelector("[contenteditable=true]")===window.originalCaptureEditor'), true)
  await resize(360, 740)
  await button('Show the message tool row')
  await button('选择 Skill')
  await until('document.querySelector("[aria-label=Skills]")?.textContent.includes("review-evidence")')
  await capture('skills-picker-dark-360')
  await read('mobileProductScene.setAppearance("light")')
  await resize(430, 480); await capture('skills-picker-light-short-430')
  await button('review-evidence', '[aria-label=Skills]')
  await until('!!document.querySelector("[data-tool-reference=skill]")')
  assert.ok(await read('document.querySelector("[contenteditable=true]").textContent.includes("先比较两种方案，保留原来的依据。")'))
  await capture('skills-inserted-light-short-430')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Undo selected Skill')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] })
  await until('!document.querySelector("[data-tool-reference=skill]")')
  assert.equal(await read('document.querySelector("[contenteditable=true]").textContent'), '先比较两种方案，保留原来的依据。')
  await button('Grow the input box for long text')
  await button('Collapse the composer to one line')
  await read('mobileProductScene.setAppearance("dark")'); await resize(320, 760)
  await read('mobileProductScene.unknownNext()')
  await button('Send')
  await pause(120)
  assert.equal(await visible('.mobile-send-status[data-phase=unknown]'), true, 'Unknown delivery remains independently visible')
  await tap('.mobile-conversation-panel [contenteditable=true]', 'Continue later draft')
  await read('(()=>{const e=document.querySelector(".mobile-conversation-panel [contenteditable=true]"),s=window.getSelection(),r=document.createRange();r.selectNodeContents(e);r.collapse(false);s.removeAllRanges();s.addRange(r)})()')
  win.webContents.insertText(' 后来补充的文字也保留。')
  await capture('unknown-receipt-narrow')
  await button('关闭操作说明', '.mobile-send-status')
  await until('!!document.querySelector(".mobile-send-status--collapsed")')
  await capture('unknown-collapsed-narrow')
  await button('查看投递回执', '.mobile-send-status')
  await until('!document.querySelector(".mobile-send-status--collapsed")&&!!document.querySelector(".mobile-send-status[data-phase=unknown]")')
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
  await button('当前对话操作'); await capture('agent-actions-phone')
  await resize(320, 568); await capture('agent-actions-narrow-short')
  await button('关闭面板'); await button('Focus', '.mobile-navigation')
  await resize(390, 844); await button('新建 Agent'); await capture('agent-create-phone')
  await resize(320, 568); await capture('agent-create-narrow-short')
  await button('关闭新建 Agent')
  const calls = await read('mobileProductScene.facts().calls')
  assert.equal(calls.filter(call => call.method === 'sdk.submitAgentPrompt').length, 2, 'One normal explicit Send + one unknown Send without automatic replay')
  assert.equal(calls.filter(call => call.method === 'sdk.respondAgentInteraction').length, 1)
  result.passed = true
 } catch (error) {
  result.error = { name: error.name, message: error.message, stack: error.stack }
  if (win) { await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()); result.images.push('failed.png') }
 } finally {
  await fs.writeFile(path.join(evidence, phase === 'restore' ? 'renderer-result-restored.json' : 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
  win?.destroy(); app.exit(result.passed ? 0 : 1)
 }
})
