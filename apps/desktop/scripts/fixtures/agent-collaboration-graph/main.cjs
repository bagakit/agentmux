const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence] = process.argv.slice(2)
for (const name of ['home', 'appData', 'userData', 'sessionData']) app.setPath(name, path.join(privateRoot, name))
const result = { schema: 'agentmux.collaboration-graph-actual.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed',
  frames: [], checks: [], failures: [], rendererErrors: [], rendererMessages: [],
  boundary: 'Actual current source Renderer App/Focus/Space/area owners/Graph/card/Reader/Store. Platform API uses only private typed synthetic facts. PTY and unused Monaco paint isolated. No Provider/Run/real message/restart/install proof.' }
let win, currentPhase = 'initialize'
const checkpoint = async () => { result.phase = currentPhase; const next = path.join(evidence, 'actual.next.json'); await fs.writeFile(next, JSON.stringify(result, null, 2) + '\n'); await fs.rename(next, path.join(evidence, 'actual.json')) }
const started = checkpoint()
app.whenReady().then(async () => {
  try {
    await started
    for (const name of ['home', 'appData', 'userData', 'sessionData']) assert.equal(app.getPath(name), path.join(privateRoot, name))
    win = new BrowserWindow({ width: 1440, height: 900, x: -10000, y: -10000, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') {
      result.rendererErrors.push(String(event.message).slice(0, 2000))
      result.rendererMessages.push({ phase: currentPhase, message: event.message, source: event.sourceId, line: event.lineNumber })
    } })
    const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
    const pause = ms => new Promise(done => setTimeout(done, ms))
    const until = async (label, predicate) => { const end = Date.now() + 12000; do { if (await predicate()) return; await pause(40) } while (Date.now() < end); throw Error('Scene did not settle: ' + label) }
    const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const rect = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    const move = async selector => { const r = await rect(selector); assert.ok(r.hit, 'Real pointer target ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }) }
    const click = async selector => { const r = await rect(selector); assert.ok(r.hit, 'Real click target ' + selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }) }
    const key = async value => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value }) }
    const frame = async (name, label = name) => {
      await settle()
      if (name !== 'graph-live') await until('finite entrance settled', () => read(`![...document.getAnimations()].some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().iterations)&&a.effect?.target?.closest?.('.collaboration-dialog,.agent-information-reader'))`))
      const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, viewport: win.getContentSize() }); await checkpoint()
    }
    const check = async (name, action) => { currentPhase = name; try { await action(); result.checks.push({ name, passed: true }) } catch (error) { result.checks.push({ name, passed: false }); result.failures.push({ name, message: error.message, stack: error.stack }); await frame('failure-' + name) } finally { await checkpoint() } }
    const facts = () => read('window.graphCapture.facts()')
    const intact = async () => { const state = await facts(); for (const field of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameFocus', 'sameSelection', 'draftMounted', 'sameDraft']) assert.equal(state[field], true, field); assert.equal(state.draft, 'Original unsent reply · retain this exact draft.'); assert.deepEqual(state.range, [4, 12]); assert.deepEqual(state.controls, result.before.controls); return state }
    const graph = async (minimum = 3) => {
      await click('[aria-label="Open Agent collaboration graph"]')
      await until('real Graph cards', () => read(`document.querySelectorAll('.collaboration-dialog .focus-context[data-session-id]').length>=${minimum}`))
      await until('original source read settled', () => read('!document.querySelector(".collaboration-dialog__footer")?.textContent.includes("Reading…")'))
      await until('connection result or visible recovery', () => read('Boolean(document.querySelector(".collaboration-canvas .react-flow__edge-path,.collaboration-canvas__issue"))'))
    }
    const closeReader = async () => { if (await read(`Boolean(document.querySelector('[aria-label="Close Agent reading"]'))`)) await click('[aria-label="Close Agent reading"]'); await until('Reader closed', () => read('!document.querySelector(".agent-information-reader")')) }
    currentPhase = 'load-original-app'; await checkpoint()
    await win.loadURL(url); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('actual App initialize', () => read('window.graphCapture?.ready&&!window.graphCapture.facts().loading&&window.graphCapture.facts().ids.includes("fixture-ui")'))
    await read('window.graphCapture.prepare()'); await until('original mounted workface', () => read(`Boolean(document.querySelector('[data-fixture-session="fixture-ui"] textarea'))`))
    await click('button.surface-navigation__focus'); await until('real Focus entry', () => read(`Boolean(document.querySelector('[aria-label="Open Agent collaboration graph"]'))`))
    await read('window.graphCapture.remember()'); result.before = await facts(); await frame('focus-entry')
    currentPhase = 'open-graph'; await graph(); await frame('graph-dark')
    await check('connection-path-card-clearance', async () => {
      result.routing = await read(`(()=>{const cards=[...document.querySelectorAll('.collaboration-canvas [data-collaboration-agent]')].map(e=>({id:e.dataset.collaborationAgent,rect:e.getBoundingClientRect()}));const paths=[...document.querySelectorAll('.collaboration-canvas .react-flow__edge-path')];const collisions=[];for(const path of paths){const matrix=path.getScreenCTM(),length=path.getTotalLength(),hit=new Set();if(!matrix||!length)continue;for(let at=1;at<100;at++){const p=path.getPointAtLength(length*at/100),point=new DOMPoint(p.x,p.y).matrixTransform(matrix);for(const card of cards){const r=card.rect;if(point.x>r.left+3&&point.x<r.right-3&&point.y>r.top+3&&point.y<r.bottom-3)hit.add(card.id)}}for(const card of hit)collisions.push({edge:path.closest('.react-flow__edge')?.dataset.id,card})}return{cards:cards.length,paths:paths.length,collisions}})()`)
      assert.ok(result.routing.cards >= 3 && result.routing.paths >= 3, 'Nonempty actual path and card geometry')
      assert.deepEqual(result.routing.collisions, [], 'Visible directed paths stay outside card interiors')
    })
    await check('read-only-opening', async () => { await intact(); assert.equal((await facts()).readers, 0); const reads = (await facts()).reads.filter(read => read.kind === 'events' || read.kind === 'spawns'); assert.ok(reads.length >= 3); assert.deepEqual([...new Set(reads.map(read => read.participant))], ['fixture-ui']); assert.ok(!(await facts()).reads.some(read => read.kind === 'body')) })
    await check('actual-area-folding', async () => {
      const original = await read('document.querySelectorAll(".collaboration-dialog .focus-context[data-session-id]").length')
      await click('.collaboration-area__heading'); await until('real area folded', () => read('document.querySelector(".collaboration-area__heading")?.getAttribute("aria-expanded")==="false"'))
      assert.ok(await read('document.querySelectorAll(".collaboration-dialog .focus-context[data-session-id]").length') < original); await frame('graph-folded')
      await click('.collaboration-area__heading'); await until('original area expanded', () => read('document.querySelectorAll(".collaboration-dialog .focus-context[data-session-id]").length>=3')); await intact()
    })
    await check('shared-hover-reader', async () => {
      await move('.collaboration-dialog [data-session-id="fixture-core"]')
      await until('original full Reader visible', () => read('(()=>{const r=document.querySelector(".agent-information-reader");return r&&getComputedStyle(r).visibility==="visible"&&r.textContent.includes("A2A delivery")})()'))
      assert.equal((await facts()).readers, 1); await intact(); await frame('graph-hover')
      await move('.agent-information-reader__reading'); await pause(250); assert.equal((await facts()).readers, 1)
      await click('[aria-label="Agent information: usage, Goals, message relationships and source"]'); await frame('graph-reader-details')
      await closeReader()
    })
    await check('keyboard-reader-and-return', async () => {
      await read(`document.querySelector('.collaboration-dialog [data-session-id="fixture-core"]').focus()`); await key('ArrowDown')
      await until('keyboard enters original reading', () => read('Boolean(document.activeElement?.closest(".agent-information-reader"))'))
      assert.equal((await facts()).readers, 1); await frame('graph-keyboard-reader'); await key('Escape')
      await until('Escape closes reading', () => read('!document.querySelector(".agent-information-reader")'))
      assert.equal(await read('document.activeElement?.getAttribute("data-session-id")'), 'fixture-core'); await intact()
    })
    await check('filter-and-source-evidence', async () => {
      await click('.collaboration-toolbar__kinds [data-kind="communication"]')
      assert.equal(await read('document.querySelector(".collaboration-toolbar__kinds [data-kind=communication]").getAttribute("aria-pressed")'), 'false'); await frame('graph-filtered')
      const metadataCount = state => state.reads.filter(item => item.kind === 'events' || item.kind === 'spawns').length
      const cardIds = () => read(`[...document.querySelectorAll('.collaboration-canvas [data-collaboration-agent]')].map(e=>e.dataset.collaborationAgent).sort()`)
      const pathIds = () => read(`[...document.querySelectorAll('.collaboration-canvas .react-flow__edge-path')].map(e=>e.closest('.react-flow__edge').dataset.id).sort()`)
      const originalCards = await cardIds(), originalPaths = await pathIds(), beforeEmpty = metadataCount(await facts())
      assert.ok(originalCards.length > 0); assert.ok(originalPaths.length > 0)
      for (const kind of ['creation', 'supervision']) await click('.collaboration-toolbar__kinds [data-kind="' + kind + '"]')
      await until('empty visible relation filters', () => read(`document.querySelector('.collaboration-dialog__footer')?.textContent.trim().startsWith('0 connections') && document.querySelectorAll('.collaboration-canvas .react-flow__edge-path').length === 0 && [...document.querySelectorAll('.collaboration-toolbar__kinds button')].every(e=>e.getAttribute('aria-pressed')==='false')`))
      const emptyCards = await cardIds()
      assert.ok(emptyCards.length > 0 && emptyCards.every(id => originalCards.includes(id)))
      assert.ok(await read(`Boolean(document.querySelector('.collaboration-dialog [data-session-id="fixture-ui"]'))`))
      assert.equal(metadataCount(await facts()), beforeEmpty)
      result.emptyFilters = { cardsBefore: originalCards.length, emptyCards: emptyCards.length, originalPaths: originalPaths.length, emptyPaths: (await pathIds()).length, readsBefore: beforeEmpty, readsAfter: metadataCount(await facts()) }
      await intact(); await frame('graph-empty-filtered')
      for (const kind of ['creation', 'supervision']) await click('.collaboration-toolbar__kinds [data-kind="' + kind + '"]')
      await until('original filtered paths restored', async () => JSON.stringify(await pathIds()) === JSON.stringify(originalPaths))
      assert.deepEqual(await cardIds(), originalCards); result.emptyFilters.restoredCards = (await cardIds()).length
      assert.equal(metadataCount(await facts()), beforeEmpty)
      await click('.collaboration-toolbar__kinds [data-kind="communication"]')
      await click('.collaboration-inspector .collaboration-relation[data-kind="communication"]')
      await until('source evidence selected', () => read('document.querySelectorAll(".collaboration-evidence article").length>0')); await frame('graph-source')
      const before = (await facts()).reads.filter(read => read.kind === 'body').length
      assert.equal(before, 0)
      const originalButton = await read('[...document.querySelectorAll(".collaboration-evidence button")].find(e=>e.textContent==="Read original message")?.outerHTML??null')
      assert.ok(originalButton, 'Explicit body action exists')
      await read('[...document.querySelectorAll(".collaboration-evidence button")].find(e=>e.textContent==="Read original message").setAttribute("data-capture-read-original","")')
      await click('[data-capture-read-original]'); await until('original body fetched', async () => (await facts()).reads.some(read => read.kind === 'body')); await frame('graph-original-message'); await intact()
    })
    await check('scope-and-light', async () => {
      await click('.collaboration-toolbar__scope button:last-child'); await until('broader participants read', async () => new Set((await facts()).reads.filter(read => read.kind === 'events').map(read => read.participant)).size === 4)
      await frame('graph-all-areas'); await read('window.graphCapture.appearance("light")'); await until('actual light theme', () => read('document.documentElement.dataset.appearance==="light"')); await frame('graph-light'); await intact()
      await read('window.graphCapture.appearance("dark")')
    })
    await check('finite-live-and-replay', async () => {
      await read('window.graphCapture.live(false)'); await pause(150); assert.equal(await read('document.querySelectorAll(".collaboration-edge__pulse").length'), 0, 'Replay is metadata only')
      await read('window.graphCapture.live(true)'); await until('live source pulse', () => read('document.querySelectorAll(".collaboration-edge__pulse").length>0')); await frame('graph-live')
      await pause(2100); assert.equal(await read('document.querySelectorAll(".collaboration-edge__pulse").length'), 0, 'Finite pulse removed'); await intact()
    })
    currentPhase = 'native-document-visibility'
    // Keep native visibility capability probing separate from the actual App's
    // compositor. The probe never takes focus or loads a user/Agent surface.
    const visibility = new BrowserWindow({ width: 160, height: 120, x: -10000, y: -10000, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true } })
    try {
      await visibility.loadURL('data:text/html,<title>Private visibility capability probe</title>')
      const samples = []
      for (const action of ['showInactive', 'hide', 'showInactive', 'minimize']) {
        visibility[action](); await pause(100)
        const evaluation = visibility.webContents.executeJavaScript('({hidden:document.hidden,visibility:document.visibilityState})').catch(error => ({ unavailable: error.message }))
        samples.push({ action, windowVisible: visibility.isVisible(), windowMinimized: visibility.isMinimized(), backgroundThrottling: visibility.webContents.getBackgroundThrottling(),
          document: await Promise.race([evaluation, pause(500).then(() => ({ unavailable: 'Native document evaluation did not settle' }))]) })
      }
      result.nativeVisibility = { status: samples.some(sample => sample.document.hidden === true) ? 'observed' : 'unavailable', samples,
        boundary: 'Separate native capability probe only; no DOM visibility property is replaced. Actual Focus departure is checked on the App separately; document-visibility input behavior belongs to component tests.' }
    } finally { visibility.destroy() }
    await checkpoint()
    await check('inactive-reading-cost', async () => {
      await read('window.graphCapture.surface("workbench")'); await until('Focus departure closes its Graph', () => read('!document.querySelector(".collaboration-dialog")'))
      const count = async () => (await facts()).reads.filter(read => read.kind === 'events' || read.kind === 'spawns').length
      const before = await count(); await read('window.graphCapture.live(true)'); await pause(200)
      assert.equal(await count(), before, 'Inactive Graph performs no event or creation reads')
      result.inactive = { readsBefore: before, readsAfter: await count() }; await intact()
      await read('window.graphCapture.surface("agents")'); await graph(2)
    })
    await check('error-and-explicit-retry', async () => {
      await read('window.graphCapture.fail(true)'); await click('[aria-label="Refresh graph sources"]'); await until('original source failure visible', () => read('document.querySelector(".collaboration-sources")?.textContent.includes("temporarily unavailable")'))
      await frame('graph-source-error'); await intact(); await read('window.graphCapture.fail(false)'); await click('[aria-label="Refresh graph sources"]')
      await until('explicit source refresh recovered', () => read('!document.querySelector(".collaboration-sources")?.textContent.includes("temporarily unavailable")')); await frame('graph-source-recovered')
    })
    await check('narrow-layout', async () => {
      win.setContentSize(390, 844)
      try {
        await settle(); await frame('graph-narrow-resized'); const bounds = await rect('[aria-label="Close collaboration graph"]'); assert.ok(bounds.hit); assert.ok(bounds.x < 390)
        await click('[aria-label="Close collaboration graph"]'); await graph(2); await frame('graph-narrow')
        await move('.collaboration-dialog [data-session-id="fixture-core"]'); await until('narrow original Reader', () => read('Boolean(document.querySelector(".agent-information-reader"))')); await frame('graph-narrow-reader'); await closeReader()
      } finally { win.setContentSize(1440, 900); await settle() }
    })
    await check('open-workface-separate-from-reading', async () => {
      await closeReader(); await move('.collaboration-dialog [data-session-id="fixture-core"]'); await until('original Reader for open action', () => read('Boolean(document.querySelector(".agent-information-reader"))'))
      await click('[aria-label="Open Agent"]'); await until('explicit workface opened', () => read(`!document.querySelector('.collaboration-dialog')&&document.querySelector('[data-fixture-session="fixture-core"]')`))
      assert.equal((await facts()).selectedSession, 'fixture-core'); assert.equal(await read('window.graphCapture.facts().draft'), 'Original unsent reply · retain this exact draft.'); await frame('opened-original-workface')
    })
    const areaGraph = async () => {
      await until('original Space collaboration entry', () => read(`Boolean(document.querySelector('[aria-label="Open area collaboration graph"]'))`))
      await click('[aria-label="Open area collaboration graph"]')
      await until('original area sources settled', () => read('Boolean(document.querySelector(".collaboration-dialog__footer"))&&!document.querySelector(".collaboration-dialog__footer").textContent.includes("Reading…")'))
      await until('nonempty area graph cards', () => read('document.querySelectorAll(".collaboration-dialog .focus-context[data-session-id]").length>0'))
    }
    const sourceReads = state => state.reads.filter(item => item.kind === 'events')
    const sameScope = state => { for (const field of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameFocus', 'sameSelection']) assert.equal(state[field], true, field); assert.deepEqual(state.controls, result.before.controls) }
    await check('space-project-original-membership', async () => {
      result.projectSelection = await read('window.graphCapture.area("project")')
      await read('window.graphCapture.remember()'); const before = sourceReads(await facts()).length
      await areaGraph(); const state = await facts(), calls = sourceReads(state).slice(before)
      assert.deepEqual(calls.map(item => item.participant).sort(), ['fixture-core', 'fixture-ui'])
      assert.ok(await read('[...document.querySelectorAll(".collaboration-area__heading")].some(e=>e.textContent.includes("Agent protocol"))'))
      assert.equal(await read('Boolean(document.querySelector(".collaboration-area-issues"))'), false)
      sameScope(state); await frame('space-project')
    })
    await check('overlapping-area-observation-once', async () => {
      await click('[aria-label="Close collaboration graph"]'); const before = sourceReads(await facts()).length
      await areaGraph(); await click('.collaboration-toolbar__scope button:last-child')
      await until('all exact area participants', () => read('document.querySelector(".collaboration-dialog__footer")?.textContent.includes("4 of 4 participants observed")'))
      const calls = sourceReads(await facts()).slice(before)
      assert.deepEqual(calls.map(item => item.participant).sort(), ['fixture-core', 'fixture-design', 'fixture-review', 'fixture-ui'])
      await click('[aria-label="Fit graph"]'); await settle()
      await until('same original Agent in two accurate areas', () => read(`document.querySelectorAll('.collaboration-dialog [data-session-id="fixture-core"]').length===2`))
      result.multiArea = await read(`({headings:[...document.querySelectorAll('.collaboration-area__heading')].map(e=>e.textContent),coreAppearances:document.querySelectorAll('.collaboration-dialog [data-session-id="fixture-core"]').length,connections:document.querySelectorAll('.collaboration-inspector .collaboration-relation').length})`)
      sameScope(await facts()); await frame('space-all-areas')
    })
    await check('fold-internal-original-relations', async () => {
      await click('.collaboration-sources summary')
      await read(`(()=>{const section=[...document.querySelectorAll('.collaboration-sources section')].find(e=>e.querySelector('strong')?.textContent==='fixture-ui');const button=[...section.querySelectorAll('button')].find(e=>e.textContent==='Earlier events');if(!button)throw Error('Original older source page required');button.setAttribute('data-capture-earlier','');button.scrollIntoView({block:'center'})})()`)
      const earlierBefore = sourceReads(await facts()).length
      await click('[data-capture-earlier]')
      await until('original history page loaded', () => read('document.querySelector(".collaboration-dialog__footer")?.textContent.includes("6 connections")&&!document.querySelector(".collaboration-dialog__footer")?.textContent.includes("Reading…")'))
      const older = sourceReads(await facts()).slice(earlierBefore)
      assert.equal(older.length, 1); assert.equal(older[0].participant, 'fixture-ui')
      assert.equal(older[0].options.beforeSequence, 6); assert.equal(older[0].options.throughSequence, 9)
      assert.equal(older[0].options.incarnation, 'fixture-collaboration-journal')
      await frame('space-history-loaded')
      const before = sourceReads(await facts()).length
      await click('.collaboration-area__heading')
      await until('internal original relation badge', () => read('Boolean(document.querySelector(".collaboration-area__internal"))'))
      await click('.collaboration-area__internal')
      await until('original grouped relations selected', () => read(`document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation').length===4`))
      await until('folded cross-area connections routed', () => read('document.querySelectorAll(".collaboration-canvas .react-flow__edge-path").length>0'))
      assert.equal(sourceReads(await facts()).length, before, 'Folding never rereads message sources')
      result.folded = await read(`({badge:document.querySelector('.collaboration-area__internal').textContent,groups:[...document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation')].map(e=>({kind:e.dataset.kind,text:e.textContent})),selfPaths:[...document.querySelectorAll('.react-flow__edge')].filter(e=>{const id=JSON.parse(e.dataset.id);return id[1]===id[2]}).length})`)
      assert.equal(result.folded.selfPaths, 0); sameScope(await facts()); await frame('space-folded-internal')
      await click('[aria-label="Close collaboration graph"]')
    })
    await check('topic-current-choice-snapshot', async () => {
      result.topicSelection = await read('window.graphCapture.area("topic")'); await read('window.graphCapture.remember()')
      const before = sourceReads(await facts()).length; await areaGraph()
      assert.deepEqual(sourceReads(await facts()).slice(before).map(item => item.participant), ['fixture-review'])
      assert.ok(await read('document.querySelector(".collaboration-dialog__header").textContent.includes("Read model notes")'))
      sameScope(await facts()); await frame('space-topic')
      const calls = sourceReads(await facts()).length
      result.laterSelection = await read('window.graphCapture.area("mote")')
      await settle(); await pause(100)
      assert.equal(sourceReads(await facts()).length, calls, 'A later selection does not retarget the open graph')
      assert.ok(await read('document.querySelector(".collaboration-dialog__header").textContent.includes("Read model notes")'))
      await frame('space-snapshot-retained'); await click('[aria-label="Close collaboration graph"]')
    })
    await check('mote-original-linked-zone', async () => {
      await read('window.graphCapture.remember()'); const before = sourceReads(await facts()).length
      await areaGraph(); assert.deepEqual(sourceReads(await facts()).slice(before).map(item => item.participant).sort(), ['fixture-core', 'fixture-design'])
      assert.ok(await read('document.querySelector(".collaboration-dialog__header").textContent.includes("Interaction design")'))
      sameScope(await facts()); await frame('space-mote'); await click('[aria-label="Close collaboration graph"]')
      result.linkedMoteSelection = await read('window.graphCapture.area("linked-mote")'); await read('window.graphCapture.remember()')
      const linkedBefore = sourceReads(await facts()).length; await areaGraph()
      assert.deepEqual(sourceReads(await facts()).slice(linkedBefore).map(item => item.participant).sort(), ['fixture-core', 'fixture-design'])
      assert.equal(result.linkedMoteSelection.space.workspaceId, 'fixture-worktree')
      assert.ok(await read('document.querySelector(".collaboration-dialog__header").textContent.includes("Interaction design")'))
      sameScope(await facts()); await frame('space-mote-linked-workface'); await click('[aria-label="Close collaboration graph"]')
    })
    await check('category-original-topic-membership', async () => {
      result.categorySelection = await read('window.graphCapture.area("category")'); await read('window.graphCapture.remember()')
      const before = sourceReads(await facts()).length; await areaGraph()
      assert.deepEqual(sourceReads(await facts()).slice(before).map(item => item.participant), ['fixture-review'])
      assert.ok(await read('document.querySelector(".collaboration-dialog__header").textContent.includes("Product quality")'))
      sameScope(await facts()); await frame('space-category'); await click('[aria-label="Close collaboration graph"]')
    })
    result.after = await facts(); assert.ok(result.frames.length >= 8, 'Nonempty actual product scenes'); assert.equal(result.rendererErrors.length, 0, 'Renderer errors remain visible')
    result.passed = result.failures.length === 0
  } catch (error) {
    result.failures.push({ name: 'scene', message: error.message, stack: error.stack })
    if (win && !win.isDestroyed()) {
      result.diagnostics = await win.webContents.executeJavaScript(`(()=>({facts:window.graphCapture?.facts(),flow:[...document.querySelectorAll('.collaboration-canvas,.react-flow,.react-flow__viewport,.react-flow__node')].map(e=>({class:e.className,inline:e.getAttribute('style'),text:e.textContent?.slice(0,180),rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},computed:{transform:getComputedStyle(e).transform,width:getComputedStyle(e).width,height:getComputedStyle(e).height}}))}))()`)
      await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  }
  finally { await checkpoint(); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) }
})
