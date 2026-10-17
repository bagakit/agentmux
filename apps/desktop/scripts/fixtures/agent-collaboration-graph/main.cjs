const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence] = process.argv.slice(2)
for (const name of ['home', 'appData', 'userData', 'sessionData']) app.setPath(name, path.join(privateRoot, name))
const result = { schema: 'agentmux.collaboration-map-actual.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], checks: [], failures: [], rendererErrors: [], rendererMessages: [], performance: [],
  conditions: { nativeRenderer: true, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, privateWindowShown: false, backgroundThrottling: false, focusEmulated: true, viewport: [1440, 900], physicalDisplayRefreshQualified: false,
    instrumentation: 'Transparent real Worker traffic observer; counter in original context function; LongTask and rAF during finite windows; DOM census only at window boundaries. Callback, counter, Worker-observer and census costs are recorded. Clock-call and constructor-listener residual overhead is uncalibrated; these are instrumented results, not an uninstrumented product claim.' },
  boundary: 'Original current source App/Space/Focus/Map/Worker/cards/sole Reader/Store. Only typed platform facts and unrelated PTY/Monaco paint are controlled. No Provider, real message, user Run, installed package, durability or aesthetic qualification.' }
let win, controlHost, controlExit, pendingCli, phase = 'initialize'
const checkpoint = async () => { result.phase = phase; const next = path.join(evidence, 'actual.next.json'); await fs.writeFile(next, JSON.stringify(result, null, 2) + '\n'); await fs.rename(next, path.join(evidence, 'actual.json')) }
const started = checkpoint()
app.whenReady().then(async () => {
  try {
    await started
    win = new BrowserWindow({ width: 1440, height: 900, x: -10000, y: -10000, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') { result.rendererErrors.push(String(event.message).slice(0, 2000)); result.rendererMessages.push({ phase, message: event.message, source: event.sourceId, line: event.lineNumber }) } })
    const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
    const pause = ms => new Promise(done => setTimeout(done, ms))
    const until = async (label, predicate) => { const end = Date.now() + 12000; do { if (await predicate()) return; await pause(40) } while (Date.now() < end); throw Error('Scene did not settle: ' + label) }
    const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const rect = async selector => {
      const point = await read(`(()=>{const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})],visible=candidates.filter(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&style.visibility==='visible'&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight}),e=visible[0];if(!e)return{missing:true,matches:candidates.length,visible:visible.length};const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(hit),matches:candidates.length,visible:visible.length,hitTag:hit?.tagName,hitClass:hit?.getAttribute('class')}})()`)
      ;(result.pointerTargets ??= []).push({ selector, ...point }); assert.equal(point.missing, undefined, 'Missing actual visible control ' + selector); return point
    }
    const move = async selector => { const point = await rect(selector); assert.ok(point.hit, 'Real pointer target ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }) }
    const click = async selector => { const point = await rect(selector); assert.ok(point.hit, 'Real click target ' + selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }) }
    const key = async (value, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value === 'a' ? 'KeyA' : value, modifiers, ...(type === 'keyDown' && value === 'a' && modifiers === 4 ? { commands: ['selectAll'] } : {}) }) }
    const frame = async name => {
      await settle()
      if (!name.endsWith('-live')) await until('finite entrance settled', () => read(`![...document.getAnimations()].some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().iterations)&&a.effect?.target?.closest?.('.collaboration-map,.agent-information-reader'))`))
      const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label: name, viewport: win.getContentSize() }); await checkpoint()
    }
    const check = async (name, action) => { phase = name; try { await action(); result.checks.push({ name, passed: true }) } catch (error) { result.checks.push({ name, passed: false }); result.failures.push({ name, message: error.message, stack: error.stack }); await frame('failure-' + name) } finally { await checkpoint() } }
    const facts = () => read('window.graphCapture.facts()')
    const intact = async (selection = true) => { const state = await facts(); for (const field of ['sameTabs', 'layoutsPreserved', 'sameDrafts', 'sameFocus', ...(selection ? ['selectionPreserved'] : []), 'draftMounted', 'sameDraft']) assert.equal(state[field], true, field + ': ' + JSON.stringify(state.layoutDifference ?? state.selectionDifference ?? null)); assert.equal(state.draft, 'Original unsent reply · retain this exact draft.'); assert.equal(state.storedDraft, state.draft); assert.deepEqual(state.range, [4, 12]); assert.deepEqual(state.controls, result.before.controls); return state }
    const matrix = () => read(`document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style')`)
    const mapReady = async () => {
      await until('actual Focus Map', () => read(`Boolean(document.querySelector('.collaboration-map[data-desktop-focus-view="map"]:not([hidden])'))`))
      await until('native Worker world boxes', () => read(`window.graphCapture.workerSamples().some(sample=>sample.boxes?.agents>=8)`))
      await until('real visible nodes', () => read(`document.querySelectorAll('.collaboration-map:not([hidden]) [data-collaboration-agent]').length>0`))
      await until('original sources and layout settled', () => read(`!document.querySelector('.collaboration-map__reading')&&!document.querySelector('.collaboration-canvas__progress')`))
    }
    const closeReader = async () => { if (await read(`Boolean(document.querySelector('[aria-label="Close Agent reading"]'))`)) await click('[aria-label="Close Agent reading"]'); await until('Reader closed', () => read(`!document.querySelector('.agent-information-reader')`)) }
    const markByText = async (selector, text, attribute) => {
      assert.ok(await read(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent?.trim()===${JSON.stringify(text)});if(!e)return false;e.setAttribute(${JSON.stringify(attribute)},'');return true})()`), 'Actual named control ' + text)
      return '[' + attribute + ']'
    }
    const fillSearch = async value => {
      const selector = '[aria-label="Find Agent in map"]'
      await click(selector); const before = await read(`document.querySelector(${JSON.stringify(selector)}).value`)
      assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true,'Real search input owns keyboard focus')
      await key('a', 4); await win.webContents.debugger.sendCommand('Input.insertText', { text: value })
      await until('original search input equals requested text', () => read(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`))
      const focused = await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`); assert.equal(focused,true)
      ;(result.queryEdits ??= []).push({ before, requested: value, observed: await read(`document.querySelector(${JSON.stringify(selector)}).value`), focused, editingCommand: 'selectAll' })
    }
    const locate = async id => {
      await fillSearch(id)
      await until('exact original search result', () => read(`document.querySelector('[aria-label="Matching Agents"] [role="option"]')?.textContent.includes(${JSON.stringify(id)})`))
      await key('Enter')
      await until('original combobox committed', () => read(`document.querySelector('[aria-label="Find Agent in map"]').value===''&&!document.querySelector('[aria-label="Matching Agents"]')`))
      await until('located original card or mark', () => read(`Boolean(document.querySelector('.collaboration-map [data-session-id=${JSON.stringify(id)}]'))`))
      await settle(); const point = await rect(`.collaboration-map [data-session-id="${id}"]`); assert.ok(point.hit, 'Located Agent is actually actionable')
    }
    const measure = async (label, action) => { await read(`window.graphCapture.beginMeasurement(${JSON.stringify(label)})`); try { await action() } finally { result.performance.push(await read('window.graphCapture.endMeasurement()')); await checkpoint() } }
    const pan = async () => {
      const point = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas'),r=canvas.getBoundingClientRect();for(let row=2;row<7;row++)for(let col=2;col<7;col++){const x=r.left+r.width*col/9,y=r.top+r.height*row/9,e=document.elementFromPoint(x,y);if(e?.closest('.react-flow__pane')&&!e.closest('.react-flow__node,button'))return{x,y}}throw Error('No actual canvas background for a drag')})()`)
      const before = await matrix(); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      for (let at = 1; at <= 12; at++) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - at * 8, y: point.y + at * 3, buttons: 1 }); await pause(16) }
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x - 96, y: point.y + 36, button: 'left', clickCount: 1 }); await pause(150)
      assert.notEqual(await matrix(), before, 'Actual pointer drag changed the camera')
    }
    phase = 'load-original-app'; await checkpoint(); await win.loadURL(url); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('original App initialize', () => read(`window.graphCapture?.ready&&!window.graphCapture.facts().loading&&window.graphCapture.facts().ids.includes('fixture-ui')`))
    await read('window.graphCapture.prepare()'); await until('original mounted workface', () => read(`Boolean(document.querySelector('[data-fixture-session="fixture-ui"] textarea'))`)); await read('window.graphCapture.remember()'); result.before = await facts(); assert.deepEqual(result.before.controls, [], 'Initialization does not launch or operate a Run'); await frame('workbench-entry')
    await check('source-cli-original-app-admission-and-dom-inspect', async () => {
      const { fork } = require('node:child_process')
      assert.ok(process.env.COLLABORATION_CAPTURE_NODE, 'Original Node executable is required for source CLI')
      const nodeEnv = { ...process.env, AGENTMUX_DESKTOP_MAP_LOADED: path.join(evidence, 'control-loaded.jsonl') }; delete nodeEnv.ELECTRON_RUN_AS_NODE
      controlHost = fork(path.join(__dirname, 'server-host.mjs'), [privateRoot], { execPath: process.env.COLLABORATION_CAPTURE_NODE, execArgv: [], env: nodeEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      result.publicControl = { pid: controlHost.pid, sourceCli: true, originalAdmission: true, steps: [], stderr: '', exitConfirmed: false }
      controlHost.on('error', error => { result.publicControl.startError = error.message }); controlHost.stderr.setEncoding('utf8'); controlHost.stderr.on('data', text => { result.publicControl.stderr += text })
      controlExit = new Promise(resolve => controlHost.once('exit', (code, signal) => { Object.assign(result.publicControl, { exitConfirmed: true, exitCode: code, exitSignal: signal }); resolve() }))
      controlHost.on('message', message => {
        if (message?.kind === 'ready') result.publicControl.ready = true
        else if (message?.kind === 'execute') {
          const input = message.request
          read(`window.graphCapture.publicControl(${JSON.stringify(input)})`).then(result => controlHost.connected && controlHost.send({ kind: 'execute-result', id: input.requestId, result }), error => controlHost.connected && controlHost.send({ kind: 'execute-result', id: input.requestId, error: { message: error.message, code: error.code } }))
        } else if (message?.kind === 'cancel') void read(`window.graphCapture.cancelPublicControl(${JSON.stringify(message.id)})`)
        else if (message?.kind === 'cli-result' && pendingCli) { const receive = pendingCli; pendingCli = undefined; receive(message) }
      })
      await until('private source Core server ready', () => result.publicControl.ready)
      const cli = async step => {
        const outcome = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { pendingCli = undefined; reject(Error('Private source CLI result exceeded its boundary')) }, 12000); pendingCli = message => { clearTimeout(timeout); message.error ? reject(Error(message.error)) : resolve(message.result) }; controlHost.send({ kind: 'run', step }) })
        const output = JSON.parse(outcome.stdout); result.publicControl.steps.push({ step, ...outcome, output }); assert.equal(output.ok, true, outcome.stderr); assert.ok(outcome.code === 0 || outcome.code === 1)
        return output.result
      }
      const map = await cli('map'); await mapReady(); await read('window.graphCapture.rememberMap()'); assert.equal(map.navigation.selection.surface, 'focus'); assert.equal(map.navigation.selection.focusView, 'map'); assert.equal(map.presentation.state, 'main-visible'); assert.equal(map.presentation.tabId, null); assert.equal(map.presentation.regionId, null); assert.notEqual(map.input.outcome, 'preserved', 'Hidden workface input cannot be preserved')
      const inspectedMap = await cli('inspect'); assert.equal(inspectedMap.observation.desktop.selection.focusView, 'map'); assert.equal(inspectedMap.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedMap.observation.desktop.presentation.tabId, null); assert.equal(inspectedMap.observation.desktop.presentation.regionId, null); await intact(); await frame('public-cli-map')
      const list = await cli('list'); assert.equal(list.navigation.selection.surface, 'focus'); assert.equal(list.navigation.selection.focusView, 'list'); await until('public original Focus List visible', () => read(`window.graphCapture.facts().mainSurface==='agents'&&window.graphCapture.facts().focusView==='list'&&!window.graphCapture.facts().graph`))
      const inspectedList = await cli('inspect'); assert.equal(inspectedList.observation.desktop.selection.focusView, 'list'); assert.equal(inspectedList.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedList.observation.desktop.presentation.regionId, null); await intact(); await frame('public-cli-list')
      const space = await cli('space'); assert.equal(space.navigation.selection.surface, 'space'); assert.equal(space.navigation.selection.focusView, null); await until('public original Space visible', () => read(`window.graphCapture.facts().mainSurface==='workbench'&&!window.graphCapture.facts().graph`))
      const inspectedSpace = await cli('inspect'); assert.equal(inspectedSpace.observation.desktop.selection.focusView, null); assert.equal(inspectedSpace.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedSpace.observation.desktop.presentation.regionId, 'region-fixture-ui'); assert.equal((await facts()).publicRequests.length, 6); await intact(); await frame('public-cli-space')
    })
    await check('focus-list-map-and-original-return', async () => {
      await click('button.surface-navigation__focus'); await until('Focus remembers explicit List', () => read(`window.graphCapture.facts().mainSurface==='agents'&&window.graphCapture.facts().focusView==='list'`)); await frame('focus-entry')
      await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()')
      assert.equal(await read(`document.querySelectorAll('.collaboration-map').length`), 1); assert.equal(await read(`document.querySelectorAll('.collaboration-dialog').length`), 0); await intact(); await frame('map-dark')
      const camera = await matrix()
      await click('[aria-label="List"]'); await until('original Focus List returned', () => read(`window.graphCapture.facts().focusView==='list'&&!window.graphCapture.facts().graph`)); await intact(); await frame('focus-list-return')
      await click('[aria-label="Map"]'); await mapReady(); assert.equal((await facts()).sameMap, true); assert.equal(await matrix(), camera); await intact()
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original Space returned', () => read(`window.graphCapture.facts().mainSurface==='workbench'&&!window.graphCapture.facts().graph`)); assert.equal((await facts()).focusView,'map'); await intact(); await frame('workbench-return')
      await click('button.surface-navigation__focus'); await mapReady(); assert.equal((await facts()).sameMap,true); assert.equal(await matrix(),camera)
    })
    await check('focus-locates-in-the-same-map', async () => {
      await click('[aria-label="List"]'); await until('original Focus Locate entry', () => read(`Boolean(document.querySelector('[aria-label="Locate Agent in map"]'))`)); await frame('focus-locate-entry')
      await click('[aria-label="Locate Agent in map"]'); await mapReady(); assert.equal((await facts()).sameMap, true); assert.equal((await facts()).mapTarget.subject.agentSessionId, 'fixture-ui'); await intact()
    })
    await check('space-context-locates-in-retained-focus-map', async () => {
      await click('button[aria-label="Space: show terminal and file workbench"]'); await click('[aria-label="Show Space tools"]'); await click('[data-space-tool="agents"]'); await until('original Space context action', () => read(`Boolean(document.querySelector('[aria-label="Locate Space in Focus map"]'))`)); await frame('space-context-entry')
      await click('[aria-label="Locate Space in Focus map"]'); await mapReady(); const current = await facts(); assert.equal(current.mainSurface,'agents'); assert.equal(current.focusView,'map'); assert.equal(current.sameMap,true); assert.equal(current.mapTarget.kind,'focus'); assert.deepEqual(current.mapTarget.subject,{hostId:'local',agentSessionId:'fixture-ui'}); assert.equal(await read(`Boolean(document.querySelector('.collaboration-map [data-surface-tools-toggle]'))`),false); await intact(); await frame('space-context-in-focus-map')
      await click('button[aria-label="Space: show terminal and file workbench"]'); await click('[aria-label="Hide Space tools"]'); await click('button.surface-navigation__focus'); await mapReady(); await intact()
    })
    await check('compact-empty-areas-retain-closed-members', async () => {
      const sample = (await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input&&sample.boxes).at(-1), empty = sample.input.areas.filter(area=>area.members===0)
      assert.ok(empty.length>0,'Nonempty original empty-area sample'); const boxes = empty.map(area=>sample.boxes.areas.find(box=>box.id===area.id)); assert.ok(boxes.every(Boolean)); assert.ok(boxes.every(box=>box.height===40),'Actual empty areas use header-only world geometry')
      const closedIds = sample.boxes.ids.filter(id=>JSON.parse(JSON.parse(id)[1])[1].startsWith('fixture-retired-')); assert.equal(closedIds.length,4,'All original closed members retain actual boxes')
      await click('[aria-label="Fit graph"]'); await pause(350); await until('compact empty areas actually rendered', () => read(`document.querySelectorAll('.collaboration-area[data-empty="true"]').length>0&&document.querySelectorAll('.collaboration-agent__mark[data-tier="closed"]').length>0`))
      const rendered = await read(`[...document.querySelectorAll('.collaboration-area[data-empty="true"]')].map(e=>({name:e.querySelector('.collaboration-area__heading span')?.textContent,height:e.closest('.react-flow__node').style.height,heading:e.querySelector('.collaboration-area__heading')?.tagName,buttons:e.querySelectorAll('button').length,count:e.querySelector('small')?.textContent}))`)
      assert.ok(rendered.every(area=>area.height==='40px'&&area.heading==='DIV'&&area.buttons===0&&area.count==='0')); result.emptyAreas={boxes,rendered,closedIds}; await frame('map-overview-compact-areas'); await locate('fixture-core'); await intact()
    })
    await check('nonempty-native-path-clearance', async () => {
      result.routing = await read(`(()=>{const cards=[...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].map(e=>({id:e.dataset.collaborationAgent,r:e.getBoundingClientRect()})),paths=[...document.querySelectorAll('.collaboration-map .react-flow__edge-path')],collisions=[];for(const path of paths){const matrix=path.getScreenCTM(),length=path.getTotalLength(),hit=new Set();if(!matrix||!length)continue;for(let at=1;at<100;at++){const p=path.getPointAtLength(length*at/100),point=new DOMPoint(p.x,p.y).matrixTransform(matrix);for(const card of cards){const r=card.r;if(point.x>r.left+3&&point.x<r.right-3&&point.y>r.top+3&&point.y<r.bottom-3)hit.add(card.id)}}for(const card of hit)collisions.push({edge:path.closest('.react-flow__edge')?.dataset.id,card})}return{cards:cards.length,paths:paths.length,collisions}})()`)
      assert.ok(result.routing.cards>=2&&result.routing.paths>=1, 'Actual nonempty geometry'); assert.deepEqual(result.routing.collisions, [])
    })
    await check('shared-reader-hover-pin-keyboard', async () => {
      await locate('fixture-core'); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('original Reader', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); assert.equal((await facts()).readers, 1); await frame('map-hover')
      await move('.agent-information-reader__reading'); await pause(220); await click('[aria-label="Pin Agent bookmark"]'); await move('[aria-label="Find Agent in map"]'); await pause(250); assert.ok(await read(`Boolean(document.querySelector('[aria-label="Remove Agent bookmark"]'))`)); await frame('map-reader-pinned')
      await click('[aria-label="Agent information: usage, Goals, message relationships and source"]'); await frame('map-reader-details'); await click('[aria-label="Remove Agent bookmark"]'); await closeReader()
      await read(`document.querySelector('.collaboration-map [data-session-id="fixture-core"]').focus()`); await key('ArrowDown'); await until('keyboard enters original Reader', () => read(`Boolean(document.activeElement?.closest('.agent-information-reader'))`)); await frame('map-keyboard-reader'); await key('Escape'); await until('keyboard returns original anchor', () => read(`!document.querySelector('.agent-information-reader')&&document.activeElement?.getAttribute('data-session-id')==='fixture-core'`)); await intact()
    })
    await check('search-keyboard-candidates-and-explicit-location', async () => {
      const camera = await matrix(), workers = (await read('window.graphCapture.workerSamples()')).length, reads = (await facts()).reads.length
      await fillSearch('fixture-no-matching-member')
      await until('meaningful no-match result', () => read(`document.querySelector('.collaboration-map__results [role="status"]')?.textContent==='No matching Agent'&&document.querySelectorAll('[aria-label="Matching Agents"] [role="option"]').length===0`)); await frame('map-search-empty'); assert.equal(await matrix(),camera); assert.equal((await read('window.graphCapture.workerSamples()')).length,workers); assert.equal((await facts()).reads.length,reads)
      await fillSearch('fixture-')
      await until('multiple original candidates', () => read(`document.querySelectorAll('[aria-label="Matching Agents"] [role="option"]').length>1`))
      const selected = () => read(`document.querySelector('[aria-label="Matching Agents"] [aria-selected="true"] small')?.textContent`)
      const first = await selected(); await key('ArrowDown'); assert.notEqual(await selected(),first); await key('ArrowUp'); assert.equal(await selected(),first); await frame('map-search-candidates')
      await key('Escape'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').value`),'fixture-'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').getAttribute('aria-expanded')`),'false'); assert.equal(await matrix(),camera); assert.equal((await read('window.graphCapture.workerSamples()')).length,workers); assert.equal((await facts()).reads.length,reads)
      await key('ArrowDown'); assert.equal(await selected(),first); await key('Escape')
      // Commit a known original private SID through the real combobox. Candidate
      // labels include Host metadata and are deliberately not parsed as identity.
      await locate('fixture-core'); assert.equal(await read(`document.querySelector('.collaboration-identity code')?.textContent`),'fixture-core'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').value`),''); await intact()
    })
    await check('filters-original-body-and-pagination', async () => {
      await locate('fixture-core')
      const before = await matrix(); await click('[aria-label="Filter map relations"]'); await until('original relation menu', () => read(`Boolean(document.querySelector('.collaboration-filter-menu [role="menuitemcheckbox"][data-kind="communication"]'))`)); await frame('map-relation-menu')
      await click('.collaboration-filter-menu [data-kind="communication"]'); assert.equal(await read(`document.querySelector('.collaboration-filter-menu [data-kind="communication"]').getAttribute('aria-checked')`),'false'); await frame('map-filtered'); await click('.collaboration-filter-menu [data-kind="communication"]'); await key('Escape'); await until('filter routes settled', () => read(`!document.querySelector('.collaboration-canvas__progress')`)); assert.equal(await matrix(), before)
      await click('.collaboration-inspector .collaboration-relation[data-kind="communication"]'); await until('original evidence', () => read(`document.querySelectorAll('.collaboration-evidence article').length>0`)); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length, 0); await frame('map-source')
      await click(await markByText('.collaboration-evidence button', 'Read original message', 'data-capture-read-original')); await until('explicit original body rendered', () => read(`Boolean(document.querySelector('.collaboration-evidence .composer-mailbox__detail .log-turn__body'))`)); await frame('map-original-message')
      const body = await read('window.graphCapture.rememberBody()'), bodyReads = (await facts()).reads.filter(read=>read.kind==='body').length
      assert.ok(body.text&&body.selection&&body.messageId,'Nonempty original message and real text selection')
      await click('[aria-label="Map sources"]'); assert.equal(await read(`document.querySelector('[aria-label="Map sources"]').getAttribute('aria-expanded')`),'true'); await frame('map-sources-panel')
      assert.ok(await read(`(()=>{const section=[...document.querySelectorAll('.collaboration-sources section')].find(e=>e.querySelector('strong')?.textContent==='fixture-ui'),button=[...section?.querySelectorAll('button')??[]].find(e=>e.textContent==='Earlier events');if(!button)return false;button.setAttribute('data-capture-earlier','');return true})()`)); await click('[data-capture-earlier]')
      await until('original backward page requested', async () => (await facts()).reads.some(read=>read.kind==='events'&&read.options?.beforeSequence!==undefined)); await frame('map-earlier-events'); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length,bodyReads,'Hidden original Evidence does not read body')
      await click(await markByText('.collaboration-inspector button','Back to selection','data-capture-back-selection')); await until('original detail resumed', () => read(`document.querySelector('[aria-label="Map sources"]').getAttribute('aria-expanded')==='false'`)); await settle()
      const resumed = await read('window.graphCapture.bodyState()'); assert.equal(resumed.connected,true); assert.equal(resumed.sameBody,true); for(const field of ['text','selection','messageId'])assert.equal(resumed[field],body[field],'Original body '+field)
      result.sourceReading = { before:body, after:resumed, bodyReadsBefore:bodyReads, bodyReadsAfter:(await facts()).reads.filter(read=>read.kind==='body').length, boundary:'Hidden Evidence pauses reads. Returning preserves original DOM/MID/selection and permits the original Reader same-MID revalidation.' }; await frame('map-original-message-return'); await intact()
    })
    await check('folded-original-internal-relations', async () => {
      await locate('fixture-core')
      const heading = await markByText('.collaboration-area__heading span', 'Agent protocol', 'data-capture-project-heading')
      await click(heading); await until('actual internal relation badge', () => read(`Boolean(document.querySelector('.collaboration-area__internal'))`)); await click('.collaboration-area__internal')
      await until('all original internal relation IDs', () => read(`document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation').length===4`))
      result.folded = await read(`({badge:document.querySelector('.collaboration-area__internal').textContent,relations:[...document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation')].map(e=>({kind:e.dataset.kind,text:e.textContent})),selfPaths:[...document.querySelectorAll('.react-flow__edge')].filter(e=>{const id=JSON.parse(e.dataset.id);return id[1]===id[2]}).length})`)
      assert.equal(result.folded.selfPaths,0); await frame('map-folded'); await click(heading); await mapReady(); await locate('fixture-core'); await intact()
    })
    await check('finite-live-without-camera-or-layout-reset', async () => {
      const camera = await matrix(), workers = (await read('window.graphCapture.workerSamples()')).length
      await read('window.graphCapture.live(false)'); await pause(150); assert.equal(await read(`document.querySelectorAll('.collaboration-edge__pulse').length`), 0)
      await read('window.graphCapture.live(true)'); await until('actual finite source pulse', () => read(`document.querySelectorAll('.collaboration-edge__pulse').length>0`)); await frame('map-live'); await pause(2100); assert.equal(await read(`document.querySelectorAll('.collaboration-edge__pulse').length`), 0); assert.equal(await matrix(), camera); assert.equal((await read('window.graphCapture.workerSamples()')).length, workers); await intact()
    })
    await check('local-source-failure-and-explicit-retry', async () => {
      await click('[aria-label="Map sources"]')
      const before = (await facts()).census.nodes; await read('window.graphCapture.fail(true)'); await click('[aria-label="Refresh graph sources"]'); await until('one original source failure', () => read(`document.querySelector('.collaboration-sources')?.textContent.includes('temporarily unavailable')`)); assert.equal(await read(`document.querySelector('[aria-label="Map sources"]').dataset.issue`),'true'); assert.ok((await facts()).census.nodes>=before); await frame('map-local-source-error'); await intact()
      await read('window.graphCapture.fail(false)'); await click('[aria-label="Refresh graph sources"]'); await until('explicit recovery', () => read(`!document.querySelector('.collaboration-sources')?.textContent.includes('temporarily unavailable')`)); await frame('map-source-recovered')
    })
    await check('dark-light-narrow-original-reader', async () => {
      await click('[aria-label="Close map details"]'); await read('window.graphCapture.appearance("light")'); await until('actual light appearance', () => read(`document.documentElement.dataset.appearance==='light'`)); await frame('map-light'); await read('window.graphCapture.appearance("dark")')
      win.setContentSize(390,844); try { await settle(); await frame('map-narrow'); await locate('fixture-core'); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('narrow Reader', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); await frame('map-narrow-reader'); await closeReader() } finally { win.setContentSize(1440,900); await settle() }
      await intact()
    })
    await check('inactive-map-keeps-owner-and-does-no-reading', async () => {
      await click('[aria-label="List"]'); await until('Map is retained but inactive', () => read(`!window.graphCapture.facts().graph&&window.graphCapture.facts().sameMap`)); const count = async () => (await facts()).reads.filter(read=>read.kind==='events'||read.kind==='spawns').length
      const before = await count(); await read('window.graphCapture.live(true)'); await pause(200); assert.equal(await count(),before); result.inactive = { before, after: await count() }; await intact(); await click('[aria-label="Map"]'); await mapReady(); assert.equal((await facts()).sameMap,true)
    })
    await check('open-workface-is-a-separate-original-action', async () => {
      await locate('fixture-core'); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('Reader for original Open', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); await click('[aria-label="Open Agent"]'); await until('original workface opened', () => read(`!window.graphCapture.facts().graph&&Boolean(document.querySelector('[data-fixture-session="fixture-core"]'))`)); assert.equal((await facts()).selectedSession,'fixture-core'); assert.equal((await facts()).draft,'Original unsent reply · retain this exact draft.'); await frame('opened-original-workface')
      assert.equal((await facts()).mainSurface,'workbench'); assert.equal((await facts()).focusView,'map'); await click('button.surface-navigation__focus'); await mapReady(); await read('window.graphCapture.remember()')
    })
    await check('native-product-scale-and-viewport-consumption', async () => {
      for (const size of [240,480]) {
        await measure('grow-'+size, async () => { result['growth'+size]=await read(`window.graphCapture.grow(${size})`); await until('original snapshot membership '+size, () => read(`window.graphCapture.facts().ids.length===${size-4}`)); await until('full original Map world '+size, () => read(`document.querySelector('[aria-label="Map sources"]')?.title.includes('${size} Agents')`)); await until('all mixed world boxes '+size, () => read(`window.graphCapture.workerSamples().some(sample=>sample.input?.nodes>=${size}&&sample.boxes?.agents===sample.input.nodes)`)); await until('finite native layout '+size, () => read(`!document.querySelector('.collaboration-canvas__progress')`)); await pause(350) })
        const workers = await read('window.graphCapture.workerSamples()'), sample = workers.filter(sample=>sample.input?.nodes>=size&&sample.boxes?.agents===sample.input.nodes).at(-1)
        assert.ok(sample&&Object.keys(sample.input.sizes).length>=3,'Actual Worker places mixed sizes, including isolated/closed members'); const expected=result['growth'+size].expectedAgentKeys.slice().sort(), canonical=ids=>[...new Set(ids.map(id=>JSON.parse(id)[1]))].sort(); assert.deepEqual(canonical(sample.input.ids),expected,'Every original identity enters the real Worker'); assert.deepEqual(canonical(sample.boxes.ids),expected,'Every original identity receives actual world geometry'); result['world'+size]=sample
        await locate('fixture-core'); await measure('idle-'+size, () => pause(500)); await measure('pan-'+size, pan)
        const arranged = (await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input).length
        await measure('zoom-'+size, async () => { for(let at=0;at<4;at++){await click('[aria-label="Zoom out"]');await pause(90)}await pause(250) }); assert.equal((await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input).length,arranged,'Zoom does not change original world box sizes'); assert.equal((await facts()).census.fullCards,0)
        await measure('locate-isolated-'+size, async () => { await locate('fixture-isolated-'+String(size-9).padStart(3,'0')); await pause(350) }); await frame('map-scale-'+size)
        const measurements=result.performance.filter(sample=>sample.label.endsWith('-'+size)); assert.ok(measurements.length>=5); assert.ok(measurements.every(sample=>sample.frameCount>=8),'Nonempty native frame sampling'); assert.ok(measurements.filter(sample=>!sample.label.startsWith('grow-')).every(sample=>sample.builtContextIds.length<128),'Actual context work follows visible demand'); assert.ok((await facts()).census.fullCards<128); assert.equal((await facts()).sameMap,true); assert.deepEqual((await facts()).controls,result.before.controls)
      }
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original workface after isolated Map locate', () => read(`window.graphCapture.facts().mainSurface==='workbench'`)); const returned=await facts(); assert.equal(returned.focusView,'map'); assert.equal(returned.selectionPreserved,true); assert.equal(returned.selectedSession,'fixture-core'); assert.equal(returned.storedDraft,'Original unsent reply · retain this exact draft.'); await frame('workbench-after-scale')
    })
    phase = 'native-visibility-capability'; await checkpoint()
    const visibility = new BrowserWindow({ width:160,height:120,x:-10000,y:-10000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:true} })
    try {
      await visibility.loadURL('data:text/html,<title>Private visibility capability probe</title>'); const samples=[]
      for(const action of ['showInactive','hide','showInactive','minimize']){visibility[action]();await pause(100);samples.push({action,windowVisible:visibility.isVisible(),windowMinimized:visibility.isMinimized(),document:await Promise.race([visibility.webContents.executeJavaScript('({hidden:document.hidden,visibility:document.visibilityState})').catch(error=>({unavailable:error.message})),pause(500).then(()=>({unavailable:'Native document observation did not settle'}))])})}
      result.nativeVisibility={status:samples.some(sample=>sample.document.hidden===true)?'observed':'unavailable',samples,boundary:'Separate native capability probe only; no replaced visibility properties and no proof that the source Map window was natively hidden.'}
    } finally {visibility.destroy()}
    result.nativeWorkers = await read('window.graphCapture.workerSamples()'); result.after=await facts(); assert.ok(result.frames.length>=12); assert.equal(result.rendererErrors.length,0,'Original Renderer errors remain visible'); result.passed=result.failures.length===0
  } catch(error) {
    result.failures.push({name:'scene',message:error.message,stack:error.stack})
    if(win&&!win.isDestroyed()){result.diagnostics=await win.webContents.executeJavaScript(`({facts:window.graphCapture?.facts(),workers:window.graphCapture?.workerSamples(),map:document.querySelector('.collaboration-map')?.outerHTML.slice(0,14000)})`);await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
  } finally {
    if (controlHost && !result.publicControl?.exitConfirmed) {
      if (controlHost.connected) controlHost.send({ kind: 'stop' })
      await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))])
      if (!result.publicControl.exitConfirmed) { result.publicControl.stopSignal = 'SIGTERM'; controlHost.kill('SIGTERM'); await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))]) }
      if (!result.publicControl.exitConfirmed) { result.publicControl.stopSignal = 'SIGKILL'; controlHost.kill('SIGKILL'); await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))]) }
      if (!result.publicControl.exitConfirmed || result.publicControl.exitCode !== 0) { result.passed = false; result.failures.push({ name: 'private-control-host-exit', message: 'The original private control host did not exit cleanly' }) }
    }
    await checkpoint();if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)
  }
})
