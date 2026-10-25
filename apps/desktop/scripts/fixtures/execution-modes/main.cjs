const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), { mkdirSync } = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const [html, profile, directory, phase = 'journey', coreFile, stylesheetFile, restartExpectedFile] = process.argv.slice(2)
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(path.join(profile, key), { recursive: true }); app.setPath(key, path.join(profile, key)) }
const receipt = { schema: 'agentmux.execution-modes.renderer-proof.v1', phase, passed: false, captureOnly: true, pid: process.pid, frames: [], interactions: [], console: [],
  boundary: 'Real isolated Electron Renderer, production Workbench/Launcher/Store and persistence, controlled external Host/config/Session/API inputs. No native Agent execution, SSH, user App or physical OS menu claim.' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, spatial, unsubscribe
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const { AgentMuxSpatialStateStore } = await import(pathToFileURL(coreFile).href)
  spatial = new AgentMuxSpatialStateStore(path.join(profile, 'spatial-state.json'))
  receipt.coreOwner = { path: coreFile, sha256: createHash('sha256').update(await fs.readFile(coreFile)).digest('hex'), stateFile: spatial.path }
  receipt.spatialBefore = await spatial.readForLayout()
  ipcMain.handle('execution-modes:spatial', async (event, operation, input) => {
    assert.equal(event.sender, win.webContents, 'Only this isolated Renderer uses its spatial owner')
    if (operation === 'read') return spatial.readForLayout()
    if (operation === 'commit') return spatial.commit(input)
    if (operation === 'retain-labels') return spatial.retainDisplayLabels(input)
    throw new Error('Unknown private spatial operation: ' + operation)
  })
  unsubscribe = spatial.subscribe(state => { if (win && !win.isDestroyed()) win.webContents.send('execution-modes:spatial-changed', state) })
  win = new BrowserWindow({ width: 1180, height: 850, show: false, title: 'Execution arrangements · private review',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, _level, message) => { receipt.console.push({ level: _level, message: message.slice(0, 2000) }); if (message.includes('Error')) console.error(message.slice(0, 500)) })
  await win.loadFile(html)
  // Standard App host geometry; the earlier Workbench-only fixture used a flex root.
  await win.webContents.executeJavaScript('document.getElementById("root").style.display = "block"; undefined')
  receipt.host = { rootDisplay: 'block', source: 'Production base.css .app-shell grid host', fixtureOnly: true }
  if (stylesheetFile) {
    const href = pathToFileURL(stylesheetFile).href
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const links=[...document.querySelectorAll('link[rel=stylesheet]')];if(links.length!==1)throw new Error('Expected the original single production CSS cascade');links[0].onload=()=>resolve(true);links[0].onerror=()=>reject(new Error('The production CSS could not load'));links[0].href=${JSON.stringify(href)}})`)
    receipt.stylesheet = { path: stylesheetFile, sha256: createHash('sha256').update(await fs.readFile(stylesheetFile)).digest('hex') }
  }
  await win.webContents.executeJavaScript('window.executionProofVisible = selector => [...document.querySelectorAll(selector)].find(element => element.checkVisibility() && !element.closest("[inert]")); undefined')
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const read = async code => { receipt.lastEvaluation = code; return win.webContents.executeJavaScript(code) }
  const until = async (code, label) => { const end = performance.now() + 15000; while (performance.now() < end) { if (await read(code)) return; await pause(30) } throw new Error(label ?? code) }
  const paint = async () => { await read('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))'); await pause(140) }
  const viewport = async (width, height) => { win.setContentSize(width, height); await paint() }
  const click = async selector => {
    await read(`executionProofVisible(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`); await paint()
    const hit = await read(`(()=>{const n=executionProofVisible(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,visible:n.checkVisibility(),hit:n.contains(document.elementFromPoint(x,y))}})()`)
    assert(hit?.visible && hit.hit, 'Actual visible hit target: ' + selector)
    const before = await read('executionModesVisual.trustedEvents.length')
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(hit.x), y: Math.round(hit.y), button: 'left', clickCount: 1 })
    await paint(); const events = await read(`executionModesVisual.trustedEvents.slice(${before})`)
    assert(events.some(event => event.type === 'click' && event.trusted), 'Native Renderer click reaches product control')
    receipt.interactions.push({ kind: 'native-renderer-click', selector, events })
  }
  const tools = async open => {
    const current = await read('executionProofVisible("[data-surface-tools-toggle]")?.getAttribute("aria-pressed")')
    if ((current === 'true') !== open) await click('[data-surface-tools-toggle]')
  }
  const key = async keyCode => {
    const before = await read('executionModesVisual.trustedEvents.length')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await paint()
    const events = await read(`executionModesVisual.trustedEvents.slice(${before})`)
    assert(events.some(event => event.type === 'keydown' && event.trusted)); receipt.interactions.push({ kind: 'native-renderer-key', keyCode, events })
  }
  const machine = async hostId => {
    await read(`(()=>{const s=executionProofVisible('[aria-label="Machine for new session"]');s.value=${JSON.stringify(hostId)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await paint()
    receipt.interactions.push({ kind: 'controlled-native-select-change', hostId, boundary: 'Synthetic form setup because hidden macOS Electron cannot drive the OS select popup; the exact directory is chosen by a native Renderer click.' })
  }
  const top = async () => { await read(`executionProofVisible('.launch-surface')?.scrollIntoView({block:'start'})`); await paint() }
  const facts = async () => read('executionModesVisual.facts()')
  const frame = async (name, selector = '.launch-surface') => {
    await paint()
    const layout = await read(`(()=>{const n=executionProofVisible(${JSON.stringify(selector)}),r=n?.getBoundingClientRect(),b=executionProofVisible('.launcher-launch-button')?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,overflow:document.documentElement.scrollWidth>innerWidth,component:r?.toJSON(),launch:b?.toJSON(),selected:[...document.querySelectorAll('.launcher-execution__mode[aria-pressed="true"]')].map(n=>n.innerText)}})()`)
    assert(layout.component?.width >= Math.min(300, layout.width * .4) && !layout.overflow, 'Complete Renderer fits viewport')
    const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = `${phase}-${name}.png`
    await fs.writeFile(path.join(directory, file), bytes); receipt.frames.push({ name, file, sha256: createHash('sha256').update(bytes).digest('hex'), pixels: image.getSize(), layout, surface: 'complete-renderer-viewport' })
    console.log(JSON.stringify({ frame: path.join(directory, file), captureOnly: true }))
  }
  await until('Boolean(window.executionModesVisual?.ready && executionProofVisible(".launcher-execution"))')
  receipt.initial = await facts()
  assert.equal(receipt.initial.startupInvocations, 1, 'The real App invokes its original initialize exactly once before scene setup')
  const refs = await read('executionModesVisual.refs'), localId = refs.local.tabId, localRegion = refs.local.regionId, remoteId = refs.remote.tabId, remoteRegion = refs.remote.regionId
  if (phase === 'configuration-review') {
    const before = await facts()
    await read('executionModesVisual.unknown()')
    await click('.launcher-execution__custom'); await click('.launcher-execution__endpoints > button:nth-child(2)'); await machine('local'); await click('.launcher-execution__setup [data-workspace-id="local-project"]'); await click('.launcher-execution__setup .primary-button')
    await until('executionProofVisible(".launch-surface").textContent.includes("Agent configurations are unconfirmed")')
    const unknown = await read('executionProofVisible(".launch-surface").innerText')
    assert(!unknown.includes('No Agent Executor is configured') && !unknown.includes('No Agent is configured.'))
    assert.equal(await read('executionProofVisible(".launcher-launch-button").disabled'), true)
    assert.equal(await read('executionProofVisible(".launcher-composer [contenteditable]").getAttribute("contenteditable")'), 'true')
    await top(); await frame('host-configuration-unknown')
    await click('[aria-label="Collapse Agents"]')
    assert(await read('executionProofVisible(".launch-surface").textContent.includes("Agent configurations are unconfirmed")'))
    await frame('host-configuration-unknown-collapsed')
    await click('[aria-label="Expand Agents"]')
    await viewport(560, 850); await tools(false); await top(); await frame('host-configuration-unknown-narrow')
    await viewport(1180, 850); await tools(true)
    await read('executionModesVisual.inventory("empty", "local")')
    await until('executionProofVisible(".launch-surface").textContent.includes("No Agent is configured.")')
    assert(!await read('executionProofVisible(".launch-surface").textContent.includes("Agent configurations are unconfirmed")'))
    await top(); await frame('host-configuration-confirmed-empty')
    const after = await facts()
    for (const field of ['drafts','names','options']) assert.deepEqual(after[field], before[field], 'Configuration observations retain all authored input: ' + field)
    assert.deepEqual(after.forbiddenCalls, []); receipt.final = after; receipt.passed = true; return
  }
  if (phase === 'css-review' || phase === 'css-short-mutant') {
    const before = await facts()
    if (await read(`Boolean(executionProofVisible('[aria-label="Expand Agents"]'))`)) await click('[aria-label="Expand Agents"]')
    const shortGeometry = async label => {
      const value = await read(`(()=>{const surface=executionProofVisible('.launch-surface'),region=surface.closest('[data-workbench-region-id]')??surface,editor=executionProofVisible('.launcher-composer'),button=executionProofVisible('.launcher-launch-button');const r=region.getBoundingClientRect(),e=editor.getBoundingClientRect(),b=button.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return{region:r.toJSON(),editor:e.toJSON(),launch:b.toJSON(),viewport:{width:innerWidth,height:innerHeight},launchHit:button.contains(document.elementFromPoint(x,y)),overflow:document.documentElement.scrollWidth>innerWidth,sections:['.launcher-environment','.launcher-execution','.launcher-agents-head','.agent-catalog-wrapper','.launcher-composer','.launcher-tools','.launch-surface__footer'].map(selector=>({selector,boxes:[...surface.querySelectorAll(selector)].map(element=>({text:element.innerText.slice(0,180),rect:element.getBoundingClientRect().toJSON(),computed:{marginTop:getComputedStyle(element).marginTop,marginBottom:getComputedStyle(element).marginBottom,gap:getComputedStyle(element).gap,transform:getComputedStyle(element).transform,animation:getComputedStyle(element).animationName}}))})),modes:[...surface.querySelectorAll('.launcher-execution__mode')].map(n=>({text:n.innerText,bounds:n.getBoundingClientRect().toJSON()}))}})()`)
      receipt.interactions.push({ kind: 'short-launcher-geometry', label, value })
      assert(value.editor.top >= value.region.top && value.editor.bottom <= value.region.bottom && value.launch.top >= value.region.top && value.launch.bottom <= value.region.bottom && value.launchHit && !value.overflow && value.editor.bottom <= value.launch.top, 'Short Launcher keeps the complete Prompt and clickable Launch inside its original Region')
    }
    if (phase === 'css-review') { await top(); await frame('wide-control') }
    await viewport(840, 430); await tools(true); await top()
    await shortGeometry('330x370-with-original-sidebars')
    await frame('compact-short')
    if (phase === 'css-review') {
      await viewport(560, 430); await tools(false); await top(); await shortGeometry('560x370-without-compact-sidebar'); await frame('compact-narrow')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await paint(); await shortGeometry('reduced-motion'); await frame('compact-reduced-motion')
    }
    const after = await facts()
    for (const field of ['tabs','layouts','activeWorkspaceId','drafts','names','options','selection']) assert.deepEqual(after[field], before[field], 'CSS presentation retains original work: ' + field)
    assert.deepEqual(after.forbiddenCalls, []); receipt.final = after; receipt.passed = true; return
  }
  if (phase === 'restore') {
    assert.equal(await read('executionModesVisual.restored'), true)
    assert(receipt.spatialBefore?.graph.tabs.length > 0, 'The real Core owner reloads the original persisted Tab graph without seeding')
    const expectedFile = restartExpectedFile || path.join(directory, 'restart-expected.json')
    const expectedBytes = await fs.readFile(expectedFile)
    receipt.expected = { path: expectedFile, sha256: createHash('sha256').update(expectedBytes).digest('hex') }
    const expected = JSON.parse(expectedBytes)
    const observed = await facts()
    for (const field of ['tabs', 'layouts', 'activeWorkspaceId', 'drafts', 'names', 'options', 'selection']) assert.deepEqual(observed[field], expected[field], 'Same durable work and inputs after a new process: ' + field)
    assert.equal(observed.sessions.length, expected.sessions.length)
    for (let index = 0; index < expected.sessions.length; index++) for (const field of ['id', 'kind', 'providerId', 'executorId', 'hostId', 'workspacePath', 'control', 'toolExecution', 'status', 'processState', 'capabilities']) assert.deepEqual(observed.sessions[index][field], expected.sessions[index][field], 'Original Session authority remains exact: ' + field)
    receipt.observationBoundary = 'The controlled snapshot does not supply a native Timeline/attachment. Derived observation failures are retained; only original identity, binding and authoritative runtime fields are qualified.'
    assert.deepEqual(observed.forbiddenCalls, [])
    receipt.restored = observed; await frame('original-arrangement-after-process-restart')
    await click('[aria-label="Collapse Agents"]')
    const summary = await read('executionProofVisible(".launcher-agent-entry small").innerText')
    assert(summary.includes('local.md') && !summary.includes('agentmux-file:') && !summary.includes(']('), 'The collapsed summary presents the original file reference as readable text')
    const collapsed = await facts()
    for (const field of ['drafts', 'names', 'options', 'tabs', 'layouts', 'selection']) assert.deepEqual(collapsed[field], observed[field], 'The readable summary preserves original owner and authored input: ' + field)
    receipt.interactions.push({ kind: 'collapsed-readable-file-summary', text: summary })
    await frame('collapsed-readable-file-summary'); receipt.passed = true; return
  }
  await top(); await frame('local-wide-dark')
  if (phase === 'first') { receipt.passed = true; return }
  await read('executionModesVisual.theme("light")'); await frame('local-wide-light')
  await read('executionModesVisual.theme("dark")'); await viewport(560, 850); await tools(false); await top(); await frame('local-narrow')
  await viewport(1180, 850); await tools(true)
  await viewport(1180, 850); await click('.launcher-execution__mode:nth-child(3)')
  assert.deepEqual((await facts()).tabs, receipt.initial.tabs, 'Opening setup does not mutate current targets')
  await frame('remote-agent-setup')
  await key('Escape'); assert.equal(await read('Boolean(executionProofVisible(".launcher-execution__setup"))'), false)
  assert.deepEqual((await facts()).tabs, receipt.initial.tabs, 'Cancel preserves original tuple')
  await click('.launcher-execution__mode:nth-child(3)'); await click('.launcher-execution__setup [data-workspace-id="agent-environment"]')
  await until('Boolean(executionProofVisible("[data-executor-id=codex][aria-pressed=true]"))')
  const bound = await facts()
  assert.equal(bound.tabs[localId].regions[localRegion].workspaceId, 'local-project'); assert.equal(bound.tabs[localId].regions[localRegion].agentWorkspaceId, 'agent-environment')
  assert.deepEqual(bound.drafts, receipt.initial.drafts); assert.deepEqual(bound.names, receipt.initial.names); assert.deepEqual(bound.options, receipt.initial.options)
  await top(); await frame('remote-agent-selected')
  await read('executionModesVisual.unknown()'); await viewport(560, 850); await tools(false); await top(); await frame('remote-agent-observation-unknown')
  assert.equal(await read('executionProofVisible(".launcher-launch-button").disabled'), false, 'Discovery failure preserves selected available runtime configuration')
  await viewport(840, 430); await top(); await frame('remote-agent-short')
  await viewport(1180, 850); await tools(true)
  await viewport(1180, 850); await click('.launcher-execution__mode:nth-child(1)')
  assert.equal((await facts()).tabs[localId].regions[localRegion].agentWorkspaceId, undefined)
  await click('.launcher-execution__mode:nth-child(2)'); await click('.launcher-execution__setup [data-workspace-id="remote-project"]')
  await until('executionModesVisual.facts().activeWorkspaceId === "remote-project"')
  const navigated = await facts()
  assert.equal(navigated.tabs[remoteId].regions[remoteRegion].workspaceId, 'remote-project')
  assert.equal(navigated.drafts[remoteRegion], receipt.initial.drafts[remoteRegion]); assert.equal(navigated.drafts[localRegion], receipt.initial.drafts[localRegion])
  assert.deepEqual(navigated.tabs[localId], receipt.initial.tabs[localId])
  await top(); await frame('remote-project-own-work')
  await until('executionModesVisual.io.some(row=>row.kind === "directory" && row.workspaceId === "remote-project")')
  await click('[data-tree-path="remote-project.marker.md"]')
  await until('executionModesVisual.io.some(row=>row.kind === "file" && row.workspaceId === "remote-project" && row.path === "remote-project.marker.md")')
  await frame('remote-project-file-consumer', '.app-shell')
  await click('[data-workbench-tab-id="' + remoteId + '"]')
  await click('[data-space-tool="git"]')
  await until('executionModesVisual.io.some(row=>row.kind === "git-status" && row.workspaceId === "remote-project")')
  assert.equal(await read('executionProofVisible(".workspace-git-tool:not([hidden])")?.dataset.gitWorkspace'), 'remote-project')
  await frame('remote-project-git-consumer')
  await click('[data-space-tool="files-branches"]')
  receipt.interactions.push({ kind: 'project-navigation-consumed-by-App-files-and-Git', io: await read('executionModesVisual.io') })
  await click('.launcher-execution__custom'); await click('.launcher-execution__endpoints > button:nth-child(2)'); await machine('local'); await click('.launcher-execution__setup [data-workspace-id="local-project"]')
  const staged = await facts(); assert.equal(staged.tabs[remoteId].regions[remoteRegion].agentWorkspaceId, undefined)
  await click('.launcher-execution__setup .primary-button')
  assert.equal((await facts()).tabs[remoteId].regions[remoteRegion].agentWorkspaceId, 'local-project')
  await frame('custom-reverse')
  await viewport(560, 850); await tools(false); await top(); await frame('custom-reverse-narrow')
  await viewport(1180, 850); await tools(true)
  await viewport(1180, 850); await read('executionModesVisual.show("empty-project")'); await until('Boolean(executionProofVisible(".launcher-execution"))')
  await click('[aria-label="Agent prompt"]'); await win.webContents.insertText('Keep this first empty-project draft.'); await paint()
  const emptyBefore = await facts()
  await click('.launcher-execution__mode:nth-child(3)'); await click('.launcher-execution__setup [data-workspace-id="agent-environment"]')
  const materialized = await facts(), materializedTab = Object.values(materialized.tabs).find(tab => tab.workspaceId === 'empty-project')
  assert(materializedTab, 'Exact empty project creates one original Launcher')
  assert.equal(materializedTab.regions[materializedTab.layout.activeRegionId].agentWorkspaceId, 'agent-environment')
  assert.equal(materialized.drafts[materializedTab.layout.activeRegionId], 'Keep this first empty-project draft.')
  receipt.interactions.push({ kind: 'empty-project-input-materialized', source: emptyBefore.activeWorkspaceId, tabId: materializedTab.id, regionId: materializedTab.layout.activeRegionId })
  await top(); await frame('empty-project-materialized')
  await read('executionModesVisual.show("local-project")'); await until('Boolean(executionProofVisible(".launcher-execution"))')
  await click('.launcher-execution__mode:nth-child(3)'); await click('.launcher-execution__setup [data-workspace-id="agent-environment"]')
  await until('Boolean(executionProofVisible("[data-executor-id=codex][aria-pressed=true]"))')
  await top(); await frame('final-local-project-remote-agent')
  const beforeLaunch = await facts()
  assert.deepEqual(beforeLaunch.forbiddenCalls, [], 'Mode setup and navigation did not dispatch Agent operations')
  await read('executionModesVisual.allowLaunch()'); await click('.launcher-launch-button')
  await until('executionModesVisual.facts().launchRequests.length === 1')
  const request = (await facts()).launchRequests[0]
  assert.equal(request.hostId, 'execution-host'); assert.equal(request.workspacePath, '/srv/agent-runtime')
  assert.deepEqual(request.toolWorkspace, { id: 'local-project', hostId: 'local', path: '/workspace/projects/agentmux' })
  assert.equal(request.executorRevision, 'revision-execution-host')
  await until('executionModesVisual.facts().tabs[' + JSON.stringify(localId) + '].regions[' + JSON.stringify(localRegion) + '].kind === "launcher"')
  const notApplied = await facts()
  assert.deepEqual(notApplied.tabs[localId], beforeLaunch.tabs[localId], 'Authoritative not-applied reply restores the same Launcher tuple')
  assert.deepEqual(notApplied.drafts, beforeLaunch.drafts, 'Authoritative not-applied reply preserves every authored draft')
  receipt.interactions.push({ kind: 'native-renderer-explicit-launch-not-applied', request, tabId: localId, regionId: localRegion })
  await until('executionModesVisual.facts().persisted?.includes("Keep this first empty-project draft.")')
  await read('executionModesVisual.checkpoint()')
  await win.webContents.session.flushStorageData()
  receipt.spatialAfter = await spatial.readForLayout()
  const final = await facts()
  assert.deepEqual(final.sessions, receipt.initial.sessions); assert.deepEqual(final.forbiddenCalls, [])
  assert.equal(final.drafts[localRegion], receipt.initial.drafts[localRegion]); assert.equal(final.drafts[remoteRegion], receipt.initial.drafts[remoteRegion])
  await fs.writeFile(path.join(directory, 'restart-expected.json'), JSON.stringify(final, null, 2)); receipt.final = final; receipt.passed = true
}).catch(async error => { receipt.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { try { receipt.diagnostic = await win.webContents.executeJavaScript('({ready:Boolean(window.executionModesVisual?.ready),text:document.body.innerText.slice(0,3000),html:document.body.innerHTML.slice(0,3000),facts:window.executionModesVisual?.facts(),catalog:window.executionModesVisual?.catalog()})'); await fs.writeFile(path.join(directory, phase + '-failure.png'), (await win.webContents.capturePage()).toPNG()) } catch (diagnosticError) { receipt.diagnosticError = diagnosticError.message } } process.exitCode = 1 }).finally(async () => {
  unsubscribe?.()
  if (win && !win.isDestroyed()) win.destroy()
  receipt.cleanup = { windowDestroyed: !win || win.isDestroyed() }
  await fs.writeFile(path.join(directory, phase + '.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
