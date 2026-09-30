import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectCdp, click, activate, key } from './fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Ordinary production Main/preload/Renderer. The original name-width restart
// launcher supplies the same pre-home isolation, first-hydrate seed and normal quit.
// No bundler, dependency install, package, HOME reassignment or user Runtime.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const core = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const output = resolve(repositoryRoot, process.env.AGENTMUX_FOCUS_CLOSED_GUI_OUTPUT ?? `.tmp/focus-closed-session-history-gui-${Date.now()}`)
await mkdir(output, { recursive: true })
const digest = value => createHash('sha256').update(value).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const candidate = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.trim()
const privateRoot = await mkdtemp('/tmp/amx-closed-history-'), userData = join(privateRoot, 'user-data'), privateHome = join(privateRoot, 'home')
const runtimeDirectory = join(privateRoot, 'runtime'), codexHome = join(privateRoot, 'codex-home'), topicsPath = join(privateRoot, 'topics')
const environment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: codexHome }
const inherited = Object.keys(process.env).filter(name => /^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name))
const previous = new Map([...Object.keys(environment), ...inherited].map(name => [name, process.env[name]]))
const children = new Set(), connections = new Set(), deadline = Date.now() + 200_000
const agents = new Map(), originalRuns = new Map(), nativeIds = new Map(), capturedIds = new Map()
const BODY = 'The original user input survives ordinary Agent close', DRAFT = 'Keep the original unsent closed-history draft'
const receipt = { schema: 'agentmux.focus-closed-session-history-gui.v1', candidate, sourceRoot: repositoryRoot,
  passed: false, processes: [], healthyRuns: [], images: [], cleanup: {},
  boundary: 'Existing ordinary complete Main/preload/Renderer and public private Runtime/Run/PTY. Two private Electron processes, first seed once and second seed zero. Built-in Claude native Reader uses controlled user-role records with real public Hook nativeHandle; original captured input is produced by createAgent. This is not an upstream Vendor Writer, installation or full Focus qualification. Legitimate user Stop & Close is separate from the zero-control readonly history phase.' }
const sourcePaths = [
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
  'apps/desktop/src/renderer/src/lib/focus-history-sources.ts', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-identity.ts', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-view-close.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/styles/focus.css'
]
let client, failure, interruption
const save = async name => writeFile(join(output, name ?? 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
const abort = signal => { interruption ??= new Error(`Private closed-history proof interrupted: ${signal}`); for (const cdp of connections) cdp.close(); void stopProbeProcesses(process.pid + 1_000_000_000, privateRoot).catch(error => { receipt.cleanup.interruptionError = error.message }) }
const watchdog = setTimeout(() => abort('bounded deadline'), 200_000), onSigterm = () => abort('SIGTERM'), onSigint = () => abort('SIGINT')
process.on('SIGTERM', onSigterm); process.on('SIGINT', onSigint)
async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { if (interruption) throw interruption; const value = await read(); if (value) return value; await delay(40) }
  throw new Error(`Private closed-history proof timed out: ${label}`)
}
async function files(directory, prefix) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${prefix}/${entry.name}`))
    else if (entry.isFile()) result.push(`${prefix}/${entry.name}`)
  }
  return result
}
async function binding() {
  const paths = [...await files(join(desktopRoot, 'src'), 'apps/desktop/src'), ...await files(join(desktopRoot, 'out'), 'apps/desktop/out'),
    ...await files(join(repositoryRoot, 'packages/core/src'), 'packages/core/src'), ...await files(join(repositoryRoot, 'packages/core/dist'), 'packages/core/dist'),
    ...await files(join(repositoryRoot, 'packages/core/vendor'), 'packages/core/vendor'), ...await files(join(repositoryRoot, 'packages/demand/src'), 'packages/demand/src'),
    ...await files(join(repositoryRoot, 'packages/demand/dist'), 'packages/demand/dist'), 'package.json', 'pnpm-lock.yaml', 'apps/desktop/package.json',
    'apps/desktop/scripts/verify-focus-closed-session-history-gui.mjs', 'apps/desktop/scripts/fixtures/settings-cli/desktop.mjs',
    'apps/desktop/scripts/verify-focus-timeline-name-width-restart.mjs', 'apps/desktop/scripts/probe-process.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs']
  assert.ok(paths.length > 700, 'Real ordinary execution input cannot be an empty source scan')
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => { const bytes = await readFile(join(repositoryRoot, path)); assert.ok(bytes.length > 0, path); return [path, digest(bytes)] })))
}
async function compiledGuard() {
  const path = process.env.AGENTMUX_FOCUS_CLOSED_COMPILE_RECEIPT
  assert.ok(path, 'An exact successful ordinary complete-Main build receipt is required before starting private GUI')
  const bytes = await readFile(resolve(repositoryRoot, path)), build = JSON.parse(bytes)
  assert.equal(build.schema, 'agentmux.focus-complete-main-ordinary-build.v1'); assert.equal(build.passed, true)
  assert.equal(build.candidate, candidate, 'Use the fixed full-Main build candidate, not moving old output')
  assert.ok(build.commands.length >= 3); assert.ok(build.commands.every(command => command.exitCode === 0))
  for (const path of sourcePaths) {
    assert.equal(build.inputsBefore[path], receipt.inputsBefore[path], `Ordinary build Source before: ${path}`)
    assert.equal(build.inputsAfter[path], receipt.inputsBefore[path], `Ordinary build Source after: ${path}`)
  }
  const release = JSON.parse(await readFile(join(desktopRoot, 'out/renderer/release.json'), 'utf8'))
  assert.deepEqual(release, build.rendererRelease, 'Use the actual Renderer release from the bound ordinary build')
  assert.ok(Object.keys(release.files).length > 0)
  for (const [path, hash] of Object.entries(release.files)) assert.equal(digest(await readFile(join(desktopRoot, 'out/renderer', path))), hash)
  receipt.compile = { path: resolve(repositoryRoot, path), sha256: digest(bytes), candidate, rendererReleaseId: release.id,
    commands: build.commands.map(({ command, exitCode }) => ({ command, exitCode })) }
}
async function counts(probe) {
  const value = await probe.main.call('Runtime.callFunctionOn', { objectId: probe.runtimeId,
    functionDeclaration: 'function(){return {...this.__focusClosedCounts}}', returnByValue: true })
  assert.equal(value.exceptionDetails, undefined); return value.result.value
}
// Same maintained name-width ordinary launcher. Only add call-through counters on
// this private RuntimeController to distinguish legitimate close from readonly UI.
async function launch(label, seed) {
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) assert.equal(process.env[name], undefined, `Private launch inherited ${name}`)
  const readyFile = join(privateRoot, `${label}-ready.json`), reportFile = join(privateRoot, `${label}-seed-report.json`)
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...environment, AGENTMUX_DESKTOP_READY_FILE: readyFile,
      ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed), AGENTMUX_DESKTOP_RECOVERY_REPORT: reportFile } : {}) }
  })
  assert.ok(child.pid > 1); children.add(child)
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.once('error', error => { spawnError = error }); child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-16384); mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]; rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main inspector`, () => { alive(); return mainUrl }), connections)
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
  const homeLines = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(homeLines.length, 1, 'The maintained actual pre-home boundary must be unique and nonempty')
  const home = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: homeLines[0] })
  const runtimeLines = lines.flatMap((line, index) => line.includes('const progressLoops = new ContinuousProgressLoopManager(') ? [index] : [])
  assert.equal(runtimeLines.length, 1, 'The original constructed RuntimeController must be observed, not replaced')
  const runtime = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: runtimeLines[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor(`${label} initial pause`, () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(home.breakpointId)) { await main.call('Debugger.resume'); paused = await waitFor(`${label} home boundary`, () => main.pauses.shift()) }
  assert.ok(paused.hitBreakpoints?.includes(home.breakpointId))
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(()=>{app.setPath('home',${JSON.stringify(privateHome)});return app.getPath('home')})()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, privateHome)
  await main.call('Debugger.removeBreakpoint', { breakpointId: home.breakpointId }); await main.call('Debugger.resume')
  paused = await waitFor(`${label} actual Runtime observer`, () => main.pauses.shift()); assert.ok(paused.hitBreakpoints?.includes(runtime.breakpointId))
  const value = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: `(()=>{const methods={launchAgent:'create',resumeSession:'resume',stopSession:'stop',sessionHistoryPage:'page',sessionHistorySources:'catalogue',sessionTimeline:'timeline'};runtime.__focusClosedCounts={create:0,resume:0,stop:0,page:0,catalogue:0,timeline:0};for(const [method,key] of Object.entries(methods)){const original=runtime[method];if(typeof original!=='function')throw new Error('Missing actual public Runtime method '+method);runtime[method]=function(...args){this.__focusClosedCounts[key]++;return original.apply(this,args)}}return runtime})()`, returnByValue: false, objectGroup: 'focus-closed-private-observation' })
  assert.equal(value.exceptionDetails, undefined); assert.ok(value.result.objectId)
  await main.call('Debugger.removeBreakpoint', { breakpointId: runtime.breakpointId }); await main.call('Debugger.resume')
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} actual Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`, { signal: AbortSignal.timeout(5000) })).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl, connections); await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${label} actual ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null } })
  await waitFor(`${label} actual App workface`, () => cdp.evaluate('Boolean(window.agentmux&&document.querySelector(".app-shell"))'))
  assert.equal(await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), privateHome)
  return { child, main, cdp, runtimeId: value.result.objectId, seedReport: seed ? JSON.parse(await readFile(reportFile, 'utf8')) : null }
}
async function normalQuit(probe) {
  let replyError
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()`) } catch (error) { replyError = error.message }
  probe.cdp.close(); probe.main.close(); await waitFor('Ordinary private Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null); children.delete(probe.child)
  return { pid: probe.child.pid, exitCode: probe.child.exitCode, signal: probe.child.signalCode, inspectorReplyError: replyError ?? null }
}
async function focus(target) {
  const response = await core.requestAgentMuxControl({ schemaVersion: core.AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'focus', target, inputPolicy: 'preserve' }, join(runtimeDirectory, 'control.sock'))
  assert.equal(response.ok, true, JSON.stringify(response)); assert.ok(['applied', 'unchanged'].includes(response.result.navigation.state)); return response.result
}
async function close(probe, name, action) {
  await click(probe.cdp, `[data-workbench-tab-id="${name}"] .workbench-tab__close`)
  await waitFor(`${name} close confirmation`, () => probe.cdp.evaluate('Boolean(document.querySelector("[role=dialog]"))'))
  await activate(probe.cdp, `[...document.querySelectorAll('[role="dialog"] button')].filter(node=>node.textContent===${JSON.stringify(action)})`)
  await waitFor(`${name} actual Tab removed`, () => probe.cdp.evaluate(`!JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.restoredWorkbench.tabs[${JSON.stringify(name)}]`))
}
async function descriptor(name) { return (await client.sessionHistorySources()).find(item => item.agentSessionId === agents.get(name).agentSessionId) }
async function surface(probe) {
  return probe.cdp.evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return{workbench:saved.restoredWorkbench,focus:saved.agentFocus,drafts:saved.agentComposerDrafts,tracks:[...document.querySelectorAll('[data-focus-timeline-id]')].map(node=>node.dataset.focusTimelineId),projects:[...document.querySelectorAll('[data-timeline-project]')].filter(node=>!node.hidden).map(node=>({key:node.dataset.timelineProject,name:node.querySelector('strong')?.textContent})),nativeVisibleRegions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(node=>node.getClientRects().length).map(node=>node.dataset.workbenchRegionId).sort()}})()`)
}
async function inputs(probe) { return probe.cdp.evaluate(`({records:[...document.querySelectorAll('[data-input-message-id]')].map(node=>({id:node.dataset.inputMessageId,source:node.dataset.inputSource,author:node.dataset.messageAuthor,body:node.textContent})),markers:[...document.querySelectorAll('.recent-focus__message[data-message-id]')].map(node=>node.dataset.messageId),markerTracks:[...document.querySelectorAll('.recent-focus__track[data-focus-timeline-id]')].map(track=>({id:track.dataset.focusTimelineId,ids:[...track.querySelectorAll('.recent-focus__message[data-message-id]')].map(node=>node.dataset.messageId)})),previewMessageId:document.querySelector('[data-input-preview-id]')?.dataset.inputPreviewId,contextId:document.querySelector('[aria-label="Input records Context"]')?.value,sourceSessionId:document.querySelector('.recent-focus__source-details p')?.textContent.match(/^Session: (\\S+)/m)?.[1],body:document.querySelector('[data-input-preview-id]')?.textContent,caption:document.querySelector('.recent-focus__message-caption')?.textContent,sourceDetails:document.querySelector('.recent-focus__source-details')?.textContent})`) }
async function choose(probe, name) {
  if (!await probe.cdp.evaluate('Boolean(document.querySelector("[aria-label=\\"Input records Context\\"]"))')) await click(probe.cdp, '[aria-label="View input records"]')
  const id = agents.get(name).agentSessionId
  await waitFor(`${name} actual source option`, () => probe.cdp.evaluate(`[...document.querySelector('[aria-label="Input records Context"]').options].some(option=>option.value===${JSON.stringify(id)})`))
  await probe.cdp.evaluate(`(()=>{const select=document.querySelector('[aria-label="Input records Context"]');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const expected = [`native:claude:${nativeIds.get(name)}:one`, `native:claude:${nativeIds.get(name)}:two`, `native:claude:${nativeIds.get(name)}:outside`, capturedIds.get(name)]
  const value = await waitFor(`${name} actual four original IDs`, async () => { const value = await inputs(probe); return JSON.stringify(value.records.map(item=>item.id))===JSON.stringify(expected) ? value : null })
  assert.equal(value.records.filter(item=>item.body.includes(BODY)).length, 3)
  assert.deepEqual(value.markerTracks.filter(track=>track.id===id).flatMap(track=>track.ids), [expected[0], expected[3]])
  const selector = `[data-input-message-id="${expected[1]}"]`
  let lastPressReady, lastInputs, pressReady
  const readPressReady = () => probe.cdp.evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(selector)}),panel=row?.closest('.recent-focus__message-preview');if(!row||!panel)return{rowPresent:!!row,panelPresent:!!panel};const r=row.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y),animations=panel.getAnimations().map(animation=>({playState:animation.playState,currentTime:animation.currentTime}));return{rowPresent:true,panelPresent:true,expectedMessageId:row.dataset.inputMessageId,rect:{x:r.x,y:r.y,width:r.width,height:r.height},center:{x,y},centerHit:row.contains(hit),hitTag:hit?.tagName,hitClass:hit?.className,disabled:row.disabled,opacity:Number(getComputedStyle(panel).opacity),animations,selectorSessionId:document.querySelector('[aria-label="Input records Context"]')?.value}})()`)
  try {
    await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
    pressReady = await waitFor('Actual exact input row is settled and center-hittable', async () => { lastPressReady = await readPressReady(); return lastPressReady.rowPresent&&lastPressReady.panelPresent&&lastPressReady.expectedMessageId===expected[1]&&lastPressReady.selectorSessionId===id&&lastPressReady.opacity===1&&!lastPressReady.disabled&&lastPressReady.rect.width>0&&lastPressReady.rect.height>0&&lastPressReady.centerHit&&!lastPressReady.animations.some(animation=>animation.playState==='running') ? lastPressReady : null })
    await click(probe.cdp, selector)
    await waitFor('Actual exact-source unknown-time native body remains readable', async () => { lastInputs = await inputs(probe); return lastInputs.previewMessageId===expected[1]&&lastInputs.contextId===id&&lastInputs.sourceSessionId===id&&lastInputs.body?.includes(BODY)&&lastInputs.caption?.includes('Record time unknown') ? lastInputs : null })
  } catch (error) {
    try { lastPressReady = await readPressReady(); lastInputs = await inputs(probe) } catch (diagnosticError) { receipt.chooseDiagnosticError = diagnosticError.message }
    receipt.chooseFailure = { name, expectedMessageId: expected[1], expectedSessionId: id, pressReady: pressReady ?? null, lastPressReady, lastInputs, error: error.message }
    await save('exact-choose-failure.json')
    throw error
  }
  ;(receipt.chooseChecks ??= []).push({ name, expectedMessageId: expected[1], expectedSessionId: id, pressReady, actual: lastInputs })
  return inputs(probe)
}
async function pinnedGeometry(probe) {
  return probe.cdp.evaluate(`(()=>{const panel=document.querySelector('.recent-focus__message-preview[data-interactive="true"]'),close=panel?.querySelector('[aria-label="Close message"]'),body=panel?.querySelector('[data-input-preview-id]');if(!panel||!close||!body)throw new Error('Actual pinned reader/body/Close must exist');const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}};const p=panel.getBoundingClientRect(),clip={left:Math.max(0,p.left+panel.clientLeft),right:Math.min(innerWidth,p.left+panel.clientLeft+panel.clientWidth),top:Math.max(0,p.top+panel.clientTop),bottom:Math.min(innerHeight,p.top+panel.clientTop+panel.clientHeight)};const lines=[],walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(!text.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(text);for(const r of range.getClientRects())if(r.width>0&&r.height>0)lines.push({x:r.x,y:r.y,width:r.width,height:r.height,clipped:r.left<clip.left-.5||r.right>clip.right+.5||r.top<clip.top-.5||r.bottom>clip.bottom+.5,hit:body.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})}return{width:innerWidth,panel:rect(panel),close:rect(close),body:rect(body),bodyLines:lines,clip,scrollTop:panel.scrollTop,bodyText:body.textContent,sourceDetails:panel.querySelector('.recent-focus__source-details')?.textContent,opacity:Number(getComputedStyle(panel).opacity),runningAnimations:panel.getAnimations().filter(animation=>animation.playState==='running').length}})()`)
}
async function screenshot(probe, name, width) {
  await probe.cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
  await waitFor('Actual pinned reader animation settled',async()=>{const value=await pinnedGeometry(probe);return value.opacity===1&&value.runningAnimations===0?value:null})
  const wheel=[]
  for(let index=0;index<4;index++){
    const value=await pinnedGeometry(probe)
    assert.ok(value.bodyLines.length>0,'Actual body text ranges must be nonempty')
    if(value.bodyLines.every(line=>!line.clipped&&line.hit))break
    const x=value.panel.x+value.panel.width/2,y=value.panel.y+value.panel.height/2
    await probe.cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:60})
    await probe.cdp.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    wheel.push({beforeTop:value.scrollTop,afterTop:(await pinnedGeometry(probe)).scrollTop,x,y,deltaY:60})
  }
  const actual=await pinnedGeometry(probe)
  assert.equal(actual.width,width);assert.ok(actual.close.hit,'Pinned history reader must remain visibly closable');assert.ok(actual.bodyText.includes(BODY))
  assert.ok(actual.bodyLines.length>0);assert.ok(actual.bodyLines.every(line=>!line.clipped&&line.hit),'Full real body text must be readable after bounded actual panel wheel')
  const png=await probe.cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(png.data,'base64')
  await writeFile(join(output,name),bytes);receipt.images.push({path:name,sha256:digest(bytes),width,actual,wheel});await save()
}
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(repositoryRoot)});`], { cwd: repositoryRoot, encoding: 'utf8' })
  await writeFile(join(output, 'freshness.log'), (freshness.stdout ?? '') + (freshness.stderr ?? '')); assert.equal(freshness.status, 0, 'Canonical fresh ordinary Core/Demand guard must pass')
  receipt.inputsBefore = await binding(); receipt.source = Object.fromEntries(sourcePaths.map(path=>[path,receipt.inputsBefore[path]])); await compiledGuard()
  for (const name of inherited) delete process.env[name]
  Object.assign(process.env, environment)
  for (const path of [privateHome,userData,codexHome,topicsPath,join(privateRoot,'alpha'),join(privateRoot,'beta')]) await mkdir(path,{recursive:true,mode:0o700})
  await writeFile(join(privateRoot,'alpha/sibling.txt'),'The original sibling file Region remains visible\n')
  const originalCli = await readFile(join(repositoryRoot,'packages/core/test/fixtures/fake-codex-cli.mjs'),'utf8'), claudeCli = join(privateRoot,'claude-cli.mjs'), codexCli = join(privateRoot,'codex-cli.mjs')
  const anchor='payload: { session_id: `native-${agentSessionId}`';assert.ok(originalCli.includes(anchor))
  await writeFile(claudeCli,originalCli.replace('const request = async (body) => {','const request = async (body) => { body = { ...body, payload: { ...body.payload, hook_event_name: body.eventName } };').replace('await handshake\n',"if (providerId === 'codex') await handshake\n").replaceAll(anchor,'payload: { transcript_path: process.env.AGENTMUX_PRIVATE_TRANSCRIPT, session_id: `native-${agentSessionId}`'))
  await copyFile(join(repositoryRoot,'packages/core/test/fixtures/fake-codex-cli.mjs'),codexCli)
  const executable = new Map(),quote=text=>`'${text.replaceAll("'","'\\''")}'`
  for(const [provider,cli] of [['codex',codexCli],['claude',claudeCli]]){const path=join(privateRoot,`${provider}.sh`);await writeFile(path,`#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'Private ${provider} fixture 1\\n'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o700});executable.set(provider,path)}
  client=await core.connectLocalAgentMux({store:new core.AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))});receipt.runtimeBefore=client.runtimeIdentity();const now=Date.now()
  for(const name of ['keep','peer-one','peer-two','closed','unfocused']){
    const providerId=['closed','unfocused'].includes(name)?'claude':'codex',workspacePath=join(privateRoot,name==='closed'?'beta':'alpha'),transcriptPath=join(privateRoot,`${name}.jsonl`)
    const agent=await client.createAgent({createOperationId:randomUUID(),providerId,executorId:providerId==='claude'?'closed-reader':'closed-healthy',commandOverride:executable.get(providerId),workspacePath,injectAgentMuxGuide:false,env:{CODEX_HOME:codexHome,AGENTMUX_FAKE_READY_MODE:'before',AGENTMUX_PRIVATE_TRANSCRIPT:transcriptPath},cols:100,rows:30,...(providerId==='claude'?{prompt:BODY}:{})});agents.set(name,agent)
    const run=(await client.listRuns()).find(run=>run.runId===agent.run.runId);assert.equal(run?.state,'running');assert.ok(run.pid>1);originalRuns.set(name,run)
    if(providerId==='claude'){
      const handle=await waitFor('Real public Hook nativeHandle',async()=>{const value=(await client.sessionHistorySources()).find(source=>source.agentSessionId===agent.agentSessionId)?.history?.nativeHandle;return value?.kind==='provider'?value:null});nativeIds.set(name,handle.sessionId)
      await writeFile(transcriptPath,[{id:'one',body:BODY,at:now-3_600_000},{id:'two',body:BODY},{id:'outside',body:'Outside the original window',at:now-8*3_600_000}].map(item=>JSON.stringify({sessionId:handle.sessionId,uuid:item.id,type:'user',message:{role:'user',content:item.body},...('at'in item?{timestamp:new Date(item.at).toISOString()}:{})})).join('\n')+'\n')
      const page=await client.sessionHistoryPage(agent.agentSessionId,{limit:30});assert.deepEqual(page.items.map(item=>item.kind),['user-message','user-message','user-message']);assert.equal(page.source.nativeSessionId,handle.sessionId)
      const submitted=(await client.sessionTimeline(agent.agentSessionId)).items.filter(item=>item.kind==='user_message'&&item.source==='user');assert.equal(submitted.length,1);assert.equal(submitted[0].content,BODY);capturedIds.set(name,`captured:${submitted[0].id}`)
    }
  }
  const config={version:9,hosts:[{id:'local',kind:'local',label:'Private closed-history'}],executors:{'closed-reader':{label:'Private Claude reader',providerId:'claude',command:executable.get('claude'),args:[],env:{AGENTMUX_FAKE_READY_MODE:'before'},injectAgentMuxGuide:false},'closed-healthy':{label:'Private healthy Agent',providerId:'codex',command:executable.get('codex'),args:[],env:{CODEX_HOME:codexHome,AGENTMUX_FAKE_READY_MODE:'before'},injectAgentMuxGuide:false}},workspaces:[{id:'__scratch__',hostId:'local',kind:'folder',name:'Private Topics',path:topicsPath},...['alpha','beta'].map(id=>({id,hostId:'local',kind:'folder',name:id==='alpha'?'Alpha':'Beta',path:join(privateRoot,id)}))],appearance:{terminalTheme:'graphite'},notifications:{mode:'off'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify(config))
  const tab=name=>{const workspaceId=name==='closed'?'beta':'alpha',regionId=`${name}-agent`,regions={[regionId]:{kind:'agent',phase:'attached',regionId,workspaceId,sessionId:agents.get(name).agentSessionId}};let root={type:'leaf',regionId};if(name==='peer-one'){regions['sibling-file']={kind:'file',regionId:'sibling-file',workspaceId,path:'sibling.txt'};root={type:'split',direction:'horizontal',ratio:.61,first:root,second:{type:'leaf',regionId:'sibling-file'}}}return{id:name,workspaceId,titleRegionId:regionId,layout:{root,activeRegionId:regionId},regions}}
  const seed={version:1,state:{activeWorkspaceId:'beta',mainSurface:'workbench',focusTimelineHeight:260,focusTimelineNameWidth:112,agentComposerDrafts:Object.fromEntries(['keep','peer-one','peer-two'].map(name=>[agents.get(name).agentSessionId,DRAFT])),agentFocus:{execution:{sessionId:agents.get('closed').agentSessionId,history:[{sessionId:agents.get('closed').agentSessionId,focusedAt:now-90*60_000,identity:{kind:'agent',providerId:'claude',name:'Archived Beta input',hostId:'local',workspacePath:join(privateRoot,'beta'),project:{id:'beta',name:'Beta'}}}]},pmo:{sessionId:null}},restoredWorkbench:{tabs:Object.fromEntries([...agents.keys()].map(name=>[name,tab(name)])),layouts:Object.fromEntries(['alpha','beta','__scratch__'].map(id=>{const groupId=`${id}-group`,tabOrder=id==='alpha'?['keep','unfocused','peer-one','peer-two']:id==='beta'?['closed']:[];return[id,{root:{type:'leaf',groupId},groups:[{id:groupId,tabOrder,activeTabId:tabOrder[0]??null,recentTabIds:tabOrder.slice(0,1)}],activeGroupId:groupId}]}))}}}
  const first=await launch('first',seed);receipt.processes.push({pid:first.child.pid,seedCount:1,seedReport:first.seedReport});await save('first-ready-checkpoint.json')
  await close(first,'closed','Stop & Close');assert.equal((await descriptor('closed')).state,'retired');receipt.defaultCloseRetired=true
  await focus({kind:'space',tabId:'keep',displayWorkspaceId:'alpha',groupId:'alpha-group'})
  await close(first,'unfocused','Stop & Close');assert.equal((await descriptor('unfocused')).state,'retired')
  assert.ok(!(await surface(first)).focus.execution.history.some(item=>item.sessionId===agents.get('unfocused').agentSessionId));receipt.neverFocusedArchivedSource=true
  await close(first,'keep','Keep Session & Close');const keep=(await client.listRuns()).find(run=>run.runId===agents.get('keep').run.runId);assert.equal(keep.pid,originalRuns.get('keep').pid);receipt.keepSessionPreserved=true
  receipt.legitimateCloseControls=await counts(first);assert.equal(receipt.legitimateCloseControls.stop,2)
  await focus({kind:'surface',surface:'focus'});await waitFor('Actual Focus timeline',()=>first.cdp.evaluate('Boolean(document.querySelector(".recent-focus"))'))
  const readonlyBefore=await counts(first);await choose(first,'closed');assert.ok((await surface(first)).projects.some(project=>project.name==='Beta'));await screenshot(first,'first-wide-closed.png',1200)
  await choose(first,'unfocused');assert.ok((await surface(first)).projects.some(project=>project.name==='Project not recorded'));await screenshot(first,'first-narrow-unfocused.png',640)
  await click(first.cdp,'[aria-label="Close message"]');await click(first.cdp,'[aria-label="Previous focus window"]');await waitFor('Out-of-window archived messages disappear',()=>first.cdp.evaluate('document.querySelectorAll(".recent-focus__message[data-message-id]").length===0'))
  await click(first.cdp,'[aria-label="Return to current focus window"]');await choose(first,'unfocused')
  const readonlyAfter=await counts(first);receipt.historyControlDelta=Object.fromEntries(['create','resume','stop'].map(key=>[key,readonlyAfter[key]-readonlyBefore[key]]));assert.deepEqual(receipt.historyControlDelta,{create:0,resume:0,stop:0})
  const saved=await surface(first);assert.equal(saved.drafts[agents.get('keep').agentSessionId],DRAFT);receipt.postCloseWorkface=saved
  receipt.processes[0].readonly={before:readonlyBefore,after:readonlyAfter};receipt.processes[0].exit=await normalQuit(first)
  const second=await launch('second');receipt.processes.push({pid:second.child.pid,seedCount:0});const restored=await surface(second);receipt.restoredWorkface=restored;await save('second-restored-checkpoint.json')
  assert.notEqual(first.child.pid,second.child.pid);assert.deepEqual(restored.workbench,saved.workbench);assert.deepEqual(restored.focus,saved.focus);assert.deepEqual(restored.drafts,saved.drafts)
  const secondBefore=await counts(second);await choose(second,'closed');await screenshot(second,'second-wide-closed.png',1200);await choose(second,'unfocused');await screenshot(second,'second-narrow-unfocused.png',640)
  const secondAfter=await counts(second);assert.deepEqual(Object.fromEntries(['create','resume','stop'].map(key=>[key,secondAfter[key]-secondBefore[key]])),{create:0,resume:0,stop:0});receipt.processes[1].readonly={before:secondBefore,after:secondAfter}
  for(const name of ['keep','peer-one','peer-two']){const agent=agents.get(name),before=(await client.listRuns()).find(run=>run.runId===agent.run.runId);assert.equal(before?.state,'running');assert.equal(before.pid,originalRuns.get(name).pid);const ack=await client.writeAgent({agentSessionId:agent.agentSessionId,expectedRun:agent.run,data:'w\r',source:'user'});assert.ok(ack.appliedByteRange);assert.equal(ack.appliedByteRange.endByte-ack.appliedByteRange.startByte,2);const after=await waitFor('Original private Run input ACK',async()=>{const run=(await client.listRuns()).find(run=>run.runId===agent.run.runId);return run?.acceptedInputBytes===before.acceptedInputBytes+2?run:null});assert.equal(after.pid,before.pid);receipt.healthyRuns.push({name,sameId:after.runId===originalRuns.get(name).runId,samePid:after.pid===originalRuns.get(name).pid,ack:true,before:{runId:originalRuns.get(name).runId,pid:originalRuns.get(name).pid},after:{runId:after.runId,pid:after.pid},appliedByteRange:ack.appliedByteRange,beforeByte:before.acceptedInputBytes,afterByte:after.acceptedInputBytes})}
  receipt.processes[1].exit=await normalQuit(second);receipt.restoredBodyAndLayout=true;receipt.runtimeAfter=client.runtimeIdentity();assert.deepEqual(receipt.runtimeAfter,receipt.runtimeBefore)
  receipt.inputsAfter=await binding();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore);receipt.passed=true
}catch(error){failure=error;receipt.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  clearTimeout(watchdog);process.off('SIGTERM',onSigterm);process.off('SIGINT',onSigint)
  const errors=[],attempt=async operation=>{try{await operation()}catch(error){errors.push(error.message)}}
  for(const connection of connections)await attempt(async()=>{await connection.call('Debugger.resume').catch(()=>{});connection.close()})
  if(client){
    let sources=[]
    await attempt(async()=>{sources=await client.sessionHistorySources()})
    receipt.cleanup.sessionStops=[]
    for(const agent of client.agentSessions()){
      const source=sources.find(item=>item.agentSessionId===agent.agentSessionId)
      if(source?.state==='retired'){receipt.cleanup.sessionStops.push({agentSessionId:agent.agentSessionId,state:source.state,action:'retired-no-stop'});continue}
      await attempt(async()=>{await client.stopAgent(agent.agentSessionId,agent.run);receipt.cleanup.sessionStops.push({agentSessionId:agent.agentSessionId,state:source?.state??'unknown',action:'stopped-private-agent'})})
    }
    await attempt(async()=>{await client.dispose()})
  }
  for(const child of children)await attempt(async()=>{if(child.pid)await stopProbeProcesses(child.pid,privateRoot)})
  await attempt(async()=>{await stopProbeProcesses(process.pid+1_000_000_000,privateRoot);receipt.cleanup.remainingOwnedProcesses=await listProbeProcesses(-1,privateRoot);assert.deepEqual(receipt.cleanup.remainingOwnedProcesses,[]);await rm(privateRoot,{recursive:true});receipt.cleanup.privateRootRemoved=true})
  for(const [key,value]of previous)value===undefined?delete process.env[key]:process.env[key]=value
  if(errors.length){receipt.cleanup.errors=errors;receipt.passed=false;failure??=new Error(errors.join('; '))}
  await save()
}
console.log(JSON.stringify({passed:receipt.passed,receipt:join(output,'receipt.json'),failure:receipt.failure,cleanup:receipt.cleanup}))
if(failure||!receipt.passed)process.exitCode=1
