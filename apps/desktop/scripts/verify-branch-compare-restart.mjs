import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// A real private Desktop/Core/Git fixture. No Store setter, bridge replacement or manual storage
// flush manufactures the result. Synthetic cat proves actual Runtime bytes, not native model work.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { requestAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxFileAgentSessionStore, connectLocalAgentMux } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-branch-restart-')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), runtimeDirectory = join(root, 'runtime')
const workspacePath = join(root, `workspace-${'r'.repeat(130)}`), codexHome = join(privateHome, 'codex')
const workspaceId = 'private-branch-comparison', workspaceName = 'Private branch comparison'
const longPath = `long-${'x'.repeat(220)}.txt`
const children = new Set(), connections = new Set()
const deadline = Date.now() + 240_000
const receipt = { schema: 'agentmux.branch-compare-restart.v1', completeGate: false, executedSlices: [], cleanup: {} }
let phase = 'prepare', failure, first, second, client, session, runIdentity
const initialEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'CODEX_HOME'].map(name => [name, process.env[name]]))
const dirtyContent = 'Unsaved Monaco body must survive branch comparison and normal restart\n'
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson'), CODEX_HOME: codexHome }
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
async function git(...args) { return (await exec('git', ['-C', workspacePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout }
async function waitFor(label, read, budget = 25_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(70) }
  throw new Error(`Branch comparison timed out: ${label}`)
}
async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = []
  const cdp = { pauses, close: () => socket.close() }
  connections.add(cdp)
  let serial = 0
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Private CDP handshake timed out')), 12_000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Debugger.paused') pauses.push(message.params)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.fail(new Error(message.error.message)) : request.done(message.result)
  })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Private CDP closed')) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 12_000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  Object.assign(cdp, { call, async evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  } })
  return cdp
}
async function identity() {
  const rendererRoot = join(desktopRoot, 'out/renderer')
  const rendererFiles = (await readdir(join(rendererRoot, 'assets'))).filter(name => name.endsWith('.js')).sort()
  assert.ok(rendererFiles.length > 0, 'Compiled Renderer collection must be nonempty')
  const coreFiles = (await readdir(join(repositoryRoot, 'packages/core/dist'))).filter(name => name.endsWith('.js')).sort()
  assert.ok(coreFiles.length > 0, 'Compiled Core collection must be nonempty')
  const files = ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html',
    ...rendererFiles.map(name => `apps/desktop/out/renderer/assets/${name}`), ...coreFiles.map(name => `packages/core/dist/${name}`),
    'apps/desktop/src/main/git-service.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/shared/git-contracts.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BranchComparisonPanel.tsx',
    'apps/desktop/src/renderer/src/components/GitBranchDiffPane.tsx', 'apps/desktop/src/renderer/src/components/GitDiffCanvas.tsx',
    'apps/desktop/src/renderer/src/lib/control.ts', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'packages/core/src/control.ts', 'packages/core/src/control-host.ts',
    'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/verify-branch-compare-restart.mjs']
  return Object.fromEntries(await Promise.all(files.map(async name => { const bytes = await readFile(join(repositoryRoot, name)); assert.ok(bytes.length > 0, name); return [name, digest(bytes)] })))
}
async function commandIdentity() {
  const gitPath=(await exec('/usr/bin/which',['git'])).stdout.trim();assert.ok(gitPath)
  return Object.fromEntries(await Promise.all([gitPath,require('electron')].map(async path=>{const bytes=await readFile(path);assert.ok(bytes.length>0);return [path,digest(bytes)]})))
}
async function launch(label) {
  phase = `launch-${label}`
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(process.env[name], undefined, `Ordinary launch inherited ${name}`)
  const readyFile = join(root, `ready-${label}.json`)
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...fixtureEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.on('error', error => { spawnError = error })
  assert.ok(child.pid > 1)
  child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes).slice(-16_384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
  })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main inspector`, () => { alive(); return mainUrl }))
  await main.call('Runtime.enable')
  // Imports must finish before querying Electron. Pause before the first home-dependent constant;
  // require() during Node's --inspect-brk bootstrap can run an uninitialized module loader.
  await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js')
  const lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1, 'The compiled home boundary must exist exactly once')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor(`${label} initial Main pause`, () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) {
    await main.call('Debugger.resume')
    paused = await waitFor(`${label} home boundary`, () => main.pauses.shift())
  }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId), 'Only the exact pre-home pause permits fixture isolation')
  const isolated = await main.call('Debugger.evaluateOnCallFrame', {
    callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home', ${JSON.stringify(privateHome)}); return app.getPath('home') })()`, returnByValue: true
  })
  assert.equal(isolated.exceptionDetails, undefined, 'Public Electron home isolation must succeed')
  const home = isolated.result.value
  assert.equal(home, privateHome, 'Home must be private before the home-dependent constant is evaluated')
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
  await main.call('Debugger.resume')
  const ready = await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.call('Runtime.enable')
  await waitFor(`${label} trusted UI`, () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  return { child, main, cdp }
}
async function click(cdp, expression, button = 'left') {
  const point = await waitFor('exact visible UI control', () => cdp.evaluate(`(() => { const matches = ${expression}; if (matches.length !== 1) return null; const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null; element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const selectors = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function select(cdp, label, value) {
  const result = await cdp.evaluate(`(() => { const e = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); if (!e || !Array.from(e.options).some(o => o.value === ${JSON.stringify(value)})) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`)
  assert.equal(result, true, `Actual selection ${label}/${value}`)
}
async function state(cdp) { return cdp.evaluate(`(() => { const raw = localStorage.getItem('agentmux-workbench-v1'); if (!raw) return null; const s = JSON.parse(raw).state; return {workbench:s.restoredWorkbench,documents:s.documents,dirtyDocuments:s.dirtyDocuments,activeWorkspaceId:s.activeWorkspaceId} })()`) }
async function agentIds(cdp) { return cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).sessions.filter(s => s.kind === "agent").map(s => s.id).sort())()') }
async function compare(cdp, mode, expectedTargetOid = receipt.fixture.targetOid) {
  await select(cdp, 'Base branch A', 'base-A'); await select(cdp, 'Target branch B', 'target-B'); await select(cdp, 'Comparison mode', mode)
  await click(cdp, selectors('.branch-comparison button[type="submit"]'))
  const from = mode === 'merge-base' ? receipt.fixture.ancestor : receipt.fixture.baseOid
  const rows = await waitFor(`${mode} real changed-file rows`, () => cdp.evaluate(`(() => { const summary = document.querySelector('.branch-comparison__summary'); const submit = document.querySelector('.branch-comparison button[type="submit"]'); const rows = Array.from(document.querySelectorAll('.branch-comparison__file')).map(e => e.title); return summary?.querySelector('span[title]')?.title === ${JSON.stringify(`${from} → ${expectedTargetOid}`)} && submit && !submit.disabled && submit.innerText === 'Refresh comparison' && rows.length ? {summary:summary.innerText,rows} : null })()`))
  assert.ok(rows.rows.includes('shared.txt')); assert.ok(rows.rows.includes(longPath)); assert.ok(rows.rows.includes('old.txt → renamed.txt'))
  await click(cdp, `${selectors('.branch-comparison__file')}.filter(e => e.title === 'shared.txt')`)
  return await waitFor(`${mode} durable actual result`, async () => {
    const s = await state(cdp); if (!s) return null
    const surfaces = Object.values(s.workbench.tabs).flatMap(tab => Object.values(tab.regions).map(surface => ({tab,surface})))
    return surfaces.find(({surface}) => surface.kind === 'git-diff' && surface.comparison.snapshot.mode === mode && surface.comparison.snapshot.targetOid === expectedTargetOid && surface.comparison.file.path === 'shared.txt')
  })
}
async function monaco(cdp, original, modified, regionId) {
  // Monaco deliberately switches to inline at narrow split widths. Verify its actual rendered
  // presentation, retaining exact separate-side checks whenever both sides are displayed.
  return waitFor('actual readonly Monaco content', () => cdp.evaluate(`(() => { const pane = ${regionId ? `document.querySelector('[data-git-diff-region="${regionId}"]')` : `Array.from(document.querySelectorAll('.git-branch-diff')).find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`}; if (!pane || getComputedStyle(pane).visibility === 'hidden') return null; const canvas=pane.querySelector('.monaco-diff-editor');if(!canvas)return null; const read = side => canvas.querySelector('.editor.'+side+' .view-lines')?.innerText.replace(/\u00a0/g,' ').trim(); const left=read('original'),right=read('modified');const presentation=canvas.classList.contains('side-by-side')?'side-by-side':'inline';const displayedLines=Array.from(canvas.querySelectorAll('.view-lines')).flatMap(e=>e.innerText.replace(/\u00a0/g,' ').split('\\n').map(line=>line.trim()).filter(Boolean));const valid=presentation==='side-by-side'?left===${JSON.stringify(original)}&&right===${JSON.stringify(modified)}:displayedLines.includes(${JSON.stringify(original)})&&displayedLines.includes(${JSON.stringify(modified)});return valid?{presentation,original:left,modified:right,displayedLines,viewportWidth:canvas.getBoundingClientRect().width,canvases:pane.querySelectorAll('.monaco-diff-editor').length}:null })()`))
}
async function control(operation, target) { return requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation,target}, join(runtimeDirectory,'control.sock')) }
async function inspectView(opened) {
  const { tab, surface } = opened
  assert.ok(tab.id.length <= 512 && surface.regionId.length <= 512)
  const inspected = await control('inspect.tab', {kind:'tab',tabId:tab.id})
  assert.ok(inspected.result.tab.regions.length > 0)
  assert.equal(inspected.result.tab.regions.find(region => region.regionId === surface.regionId)?.kind, 'view')
  const region = await control('inspect.region',{kind:'region',regionId:surface.regionId}); assert.equal(region.result.region.kind,'view')
  await control('focus',{kind:'region',regionId:surface.regionId})
  return {tabId:tab.id,regionId:surface.regionId,inspection:inspected.result}
}
async function normalQuit(probe) {
  phase = 'normal-quit'
  let replyFailure
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()` ) }
  catch (error) { replyFailure = error.message }
  probe.main.close(); probe.cdp.close()
  await waitFor('actual normal Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode,0); assert.equal(probe.child.signalCode,null)
  return {exitCode:0,signal:null,inspectorReplyFailure:replyFailure ?? null}
}
async function gitFacts() { const status=await git('status','--porcelain=v1'); return {head:(await git('rev-parse','HEAD')).trim(),index:digest(await readFile(join(workspacePath,'.git/index'))),status,dirtyFile:await readFile(join(workspacePath,'shared.txt'),'utf8')} }
async function key(cdp, key, code, modifiers = 0) {
  const windowsVirtualKeyCode = { ArrowLeft:37, ArrowRight:39, Enter:13, a:65, Meta:91 }[key]
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode})
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode})
}
function focusedAt(s, opened) {
  const layout=s?.workbench?.layouts[workspaceId], tab=s?.workbench?.tabs[opened.tab.id]
  return layout && layout.groups.find(group=>group.id===layout.activeGroupId)?.activeTabId===opened.tab.id && tab?.layout.activeRegionId===opened.surface.regionId
}
async function settleFocused(cdp,opened) {
  return waitFor('actual persisted focused view',async()=>{const s=await state(cdp);return focusedAt(s,opened)?s:null})
}
async function dirtyFile(cdp) {
  phase='real-dirty-monaco-input'
  await click(cdp,`${selectors('.tree-row__label')}.filter(e=>e.textContent==='shared.txt')`)
  await waitFor('actual file Monaco model',()=>cdp.evaluate(`window.__agentmuxFileEditingProbe?.value() === 'dirty disk stays unchanged\\n'`))
  // Clicking the real text viewport focuses Monaco's input owner. Current Monaco uses native
  // EditContext in this Chromium; assuming a textarea would select an input that does not exist.
  await click(cdp,selectors('.pane-body__region[data-active="true"] .editor-pane:not(.git-branch-diff) .monaco-editor .view-lines'))
  await key(cdp,'a','KeyA',4)
  await cdp.call('Input.insertText',{text:dirtyContent})
  const saved=await waitFor('actual dirty document persisted',async()=>{
    const s=await state(cdp);if(!s)return null
    const record=Object.entries(s.documents).find(([id,document])=>document.path==='shared.txt'&&document.content===dirtyContent&&s.dirtyDocuments[id])
    const opened=Object.values(s.workbench.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='file'&&x.surface.workspaceId===workspaceId&&x.surface.path==='shared.txt')
    return record&&opened?{record,opened}:null
  })
  assert.equal(await cdp.evaluate('window.__agentmuxFileEditingProbe.value()'),dirtyContent)
  assert.equal(await readFile(join(workspacePath,'shared.txt'),'utf8'),'dirty disk stays unchanged\n')
  return saved
}
async function splitAndGroup(cdp,opened) {
  phase='actual-split-group-geometry'
  await control('focus',{kind:'region',regionId:opened.surface.regionId})
  const group=await cdp.evaluate(`document.querySelector('[data-workbench-region-id="${opened.surface.regionId}"]').closest('[data-pane-group-id]').dataset.paneGroupId`)
  assert.ok(group)
  await click(cdp,selectors(`[data-pane-group-id="${group}"] [aria-label="Split current tab to the right"]`))
  // A blank launcher is deliberately transient outside a Topic. Fill the actual newly split
  // Region with the already healthy fixture Session using the existing public Control operation.
  const live=await control('inspect.tab',{kind:'tab',tabId:opened.tab.id})
  assert.equal(live.result.tab.regions.length,2)
  const launcher=live.result.tab.regions.find(region=>region.kind==='launcher');assert.ok(launcher)
  const openedAgent=await requestAgentMuxControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:randomUUID(),operation:'agent.open',content:{kind:'agent-session',agentSessionId:session.agentSessionId},destination:{regionId:launcher.regionId},focus:true},join(runtimeDirectory,'control.sock'))
  assert.equal(openedAgent.result.outcome,'opened');assert.ok(openedAgent.result.to);assert.equal(openedAgent.result.agent.agentSessionId,session.agentSessionId)
  const mixed=await control('inspect.tab',{kind:'tab',tabId:opened.tab.id});assert.deepEqual(mixed.result.tab.regions.map(region=>region.kind),['view','agent'])
  receipt.mixedViewAgent=mixed.result.tab
  await waitFor('real split topology',async()=>{const s=await state(cdp);const tab=s?.workbench.tabs[opened.tab.id];return tab?.layout.root.type==='split'&&Object.keys(tab.regions).length===2?tab:null})
  await control('focus',{kind:'region',regionId:opened.surface.regionId})
  const focused=await cdp.evaluate(`(() => { const handle=document.querySelector('[data-workbench-region-id="${opened.surface.regionId}"]').closest('.workbench-region-split').querySelector('.workbench-region-resize-handle');handle.focus();return document.activeElement===handle })()`)
  assert.equal(focused,true);await key(cdp,'ArrowLeft','ArrowLeft')
  await waitFor('actual split ratio committed',async()=>{const s=await state(cdp);return Math.abs(s.workbench.tabs[opened.tab.id].layout.root.ratio-0.4)<0.001})
  await click(cdp,selectors(`[data-workbench-tab-id="${opened.tab.id}"]`),'right')
  const trigger=await waitFor('actual group submenu',()=>cdp.evaluate(`(() => { const items=${selectors('[role="menuitem"]')}.filter(e=>e.textContent.includes('Move Tab to New Group'));if(items.length!==1)return null;items[0].focus();return document.activeElement===items[0] })()`))
  assert.equal(trigger,true);await key(cdp,'ArrowRight','ArrowRight')
  await click(cdp,`${selectors('[role="menuitem"]')}.filter(e=>e.textContent==='New Group Right')`)
  const grouped=await waitFor('actual second group persisted',async()=>{const s=await state(cdp);return s.workbench.layouts[workspaceId].groups.length===2?s:null})
  assert.equal(grouped.workbench.layouts[workspaceId].root.type,'split')
  await control('focus',{kind:'region',regionId:opened.surface.regionId});await settleFocused(cdp,opened)
  return geometry(cdp,opened)
}
async function geometry(cdp,opened) {
    return cdp.evaluate(`(() => { const node=document.querySelector('[data-workbench-region-id="${opened.surface.regionId}"]');const r=node.getBoundingClientRect();const split=node.closest('.workbench-region-split');const groups=Array.from(document.querySelectorAll('[data-pane-group-id]')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>e.dataset.paneGroupId).sort();return {width:r.width,height:r.height,regionPanels:Array.from(split.querySelectorAll(':scope > [data-panel]')).map(e=>Number(e.dataset.panelSize)),groups,activeRegions:Array.from(document.querySelectorAll('.workbench-region--active')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>e.dataset.workbenchRegionId).sort()} })()`)
}
async function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid)&&pid>1)
  let stdout;try{({stdout}=await exec('ps',['-p',String(pid),'-o','pgid=,lstart='],{timeout:5_000}))}catch(error){if(error.code===1)return null;throw error}
  const match=/^\s*(\d+)\s+(.+)$/.exec(stdout.trim());assert.ok(match)
  return {pid,group:Number(match[1]),born:match[2]}
}
async function sameHealthyRun(cdp,acceptedBytes) {
  const snapshot=await cdp.evaluate('window.agentmux.sessions.snapshot()')
  const attached=snapshot.sessions.find(s=>s.id===session.agentSessionId)
  assert.equal(attached?.processState,'running');assert.equal(attached.control.run.runId,session.run.runId)
  const run=(await client.listRuns()).find(r=>r.runId===session.run.runId)
  assert.equal(run?.state,'running');assert.equal(run.pid,runIdentity.pid);assert.equal(run.acceptedInputBytes,acceptedBytes)
  return run
}
async function assertRestoredViews(cdp,openedViews) {
  const results=[]
  for(const opened of openedViews) {
    const result=await inspectView(opened)
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-git-diff-region="${opened.surface.regionId}"]'))`),true)
    results.push(result)
  }
  assert.equal(results.length,openedViews.length);assert.ok(results.length>=3)
  return results
}

try {
  await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700}),mkdir(runtimeDirectory,{recursive:true})])
  receipt.identityBefore = await identity(); receipt.sourceCommit = (await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
  receipt.commandsBefore=await commandIdentity()
  receipt.gitVersion = (await exec('git',['--version'])).stdout.trim()
  await git('init','--initial-branch=current-work'); await git('config','user.name','Private fixture'); await git('config','user.email','private@example.invalid')
  await writeFile(join(workspacePath,'shared.txt'),'ancestor\n'); await writeFile(join(workspacePath,'old.txt'),'rename retained body\n'); await writeFile(join(workspacePath,longPath),'long ancestor\n'); await writeFile(join(workspacePath,'binary.bin'),Buffer.from([0,1,2,3]))
  await git('add','.'); await git('commit','-m','Private ancestor'); const ancestor = (await git('rev-parse','HEAD')).trim()
  await git('checkout','-b','base-A'); await writeFile(join(workspacePath,'shared.txt'),'base A\n'); await git('add','.'); await git('commit','-m','Private A'); const baseOid=(await git('rev-parse','HEAD')).trim()
  await git('checkout','-b','target-B',ancestor); await writeFile(join(workspacePath,'shared.txt'),'target B\n'); await writeFile(join(workspacePath,longPath),'long target B\n'); await writeFile(join(workspacePath,'binary.bin'),Buffer.from([0,4,5,6])); await git('mv','old.txt','renamed.txt'); await git('add','.'); await git('commit','-m','Private B'); const targetOid=(await git('rev-parse','HEAD')).trim()
  await git('checkout','-b','next-B'); await writeFile(join(workspacePath,'shared.txt'),'target B next\n'); await git('add','.'); await git('commit','-m','Private next B'); const nextOid=(await git('rev-parse','HEAD')).trim()
  await git('checkout','current-work'); await writeFile(join(workspacePath,'shared.txt'),'current HEAD\n'); await git('add','.'); await git('commit','-m','Private current'); await writeFile(join(workspacePath,'shared.txt'),'dirty disk stays unchanged\n')
  receipt.fixture={ancestor,baseOid,targetOid,nextOid,longPath}; receipt.gitBeforeAgentSetup=await gitFacts()
  const executable=join(root,'private-cat.sh')
  await writeFile(executable,'#!/bin/sh\numask 077\nstty -echo -icanon\nprintf "Private branch isolation cat ready\\n"\nexec /bin/cat\n',{mode:0o700})
  Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),AGENTMUX_MESSAGE_QUEUE_PATH:fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
  client=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
  session=await client.createAgent({createOperationId:randomUUID(),executorId:'probe',providerId:'codex',commandOverride:executable,workspacePath,env:{CODEX_HOME:codexHome},injectAgentMuxGuide:false,cols:100,rows:30})
  const originalRun=(await client.listRuns()).find(run=>run.runId===session.run.runId);assert.equal(originalRun?.state,'running');assert.ok(Number.isFinite(originalRun.acceptedInputBytes));runIdentity=await processIdentity(originalRun.pid);assert.ok(runIdentity?.group>1)
  receipt.privateAgent={agentSessionId:session.agentSessionId,run:session.run,pid:originalRun.pid,inputBytes:originalRun.acceptedInputBytes,processIdentity:runIdentity,synthetic:true,executableSha256:digest(await readFile(executable))}
  await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{probe:{label:'Private cat',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:codexHome},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:workspaceName,hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
  // Managed Hook setup is fixture preparation. Compare must preserve the repository as it stands
  // after that public Core operation, including its owned configuration files.
  receipt.gitBefore=await gitFacts()
  first=await launch('first'); phase='actual-ui'
  await click(first.cdp,selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  const dirty=await dirtyFile(first.cdp)
  await click(first.cdp,selectors('[aria-label="Compare two local branches"]'))
  const beforeAgents=await agentIds(first.cdp)
  assert.deepEqual(beforeAgents,[session.agentSessionId]);await sameHealthyRun(first.cdp,originalRun.acceptedInputBytes)
  const merge=await compare(first.cdp,'merge-base'); assert.equal(merge.surface.comparison.snapshot.comparisonBaseOid,ancestor); assert.equal(merge.surface.comparison.snapshot.targetOid,targetOid)
  const mergeCanvas=await monaco(first.cdp,'ancestor','target B'); const mergeControl=await inspectView(merge)
  const point=await compare(first.cdp,'two-point'); assert.equal(point.surface.comparison.snapshot.comparisonBaseOid,baseOid)
  const pointCanvas=await monaco(first.cdp,'base A','target B'); const pointControl=await inspectView(point)
  await click(first.cdp,`${selectors('.branch-comparison__file')}.filter(e => e.title === 'old.txt → renamed.txt')`)
  const renamed=await waitFor('rename descriptor with original path',async()=>{const s=await state(first.cdp);return Object.values(s.workbench.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='git-diff'&&x.surface.comparison.file.path==='renamed.txt'&&x.surface.comparison.file.origPath==='old.txt')})
  const renameCanvas=await monaco(first.cdp,'rename retained body','rename retained body',renamed.surface.regionId);const renameControl=await inspectView(renamed)
  await click(first.cdp,`${selectors('.branch-comparison__file')}.filter(e => e.title === ${JSON.stringify(longPath)})`)
  const long=await waitFor('long path descriptor',async()=>{const s=await state(first.cdp);return Object.values(s.workbench.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='git-diff'&&x.surface.comparison.file.path===longPath)})
  assert.ok(JSON.stringify(long.surface.comparison).length>512); const longControl=await inspectView(long)
  const firstGeometry=await splitAndGroup(first.cdp,point)
  await control('focus',{kind:'region',regionId:point.surface.regionId}); await monaco(first.cdp,'base A','target B',point.surface.regionId)
  const persisted=await settleFocused(first.cdp,point); assert.ok(Object.keys(persisted.workbench.tabs).length>=4)
  assert.deepEqual(await agentIds(first.cdp),beforeAgents); assert.deepEqual(await gitFacts(),receipt.gitBefore)
  await sameHealthyRun(first.cdp,originalRun.acceptedInputBytes)
  receipt.firstUi={mergeCanvas,pointCanvas,renameCanvas,mergeControl,pointControl,renameControl,longControl,firstGeometry,dirty,persisted,agentIds:beforeAgents,publicExistingAgentAttach:{agentSessionId:session.agentSessionId,run:session.run,newAgentRuns:0,acceptedInputBytes:originalRun.acceptedInputBytes}}; receipt.executedSlices.push('actual-ui-monaco-two-modes-control-long-path','actual-dirty-input-region-split-group-geometry')
  receipt.firstExit=await normalQuit(first)
  if(!process.argv.includes('--first-slice')&&!process.argv.includes('--workbench-slice')) {
    phase='move-private-ref'; await git('branch','-f','target-B',nextOid); assert.deepEqual(await gitFacts(),receipt.gitBefore)
    second=await launch('second'); phase='restart-fixed-snapshot'
    const restored=await waitFor('durable workbench restored',()=>state(second.cdp)); assert.deepEqual(restored.workbench,persisted.workbench)
    assert.equal(restored.activeWorkspaceId,persisted.activeWorkspaceId)
    const restoredViews=await assertRestoredViews(second.cdp,[merge,point,long,renamed])
    const restoredRename=await monaco(second.cdp,'rename retained body','rename retained body',renamed.surface.regionId)
    await control('focus',{kind:'region',regionId:dirty.opened.surface.regionId})
    await waitFor('same dirty Monaco editor restored',()=>second.cdp.evaluate(`window.__agentmuxFileEditingProbe?.value() === ${JSON.stringify(dirtyContent)}`))
    assert.deepEqual(restored.documents,persisted.documents);assert.deepEqual(restored.dirtyDocuments,persisted.dirtyDocuments)
    await control('focus',{kind:'region',regionId:point.surface.regionId}); const oldCanvas=await monaco(second.cdp,'base A','target B',point.surface.regionId)
    const secondGeometry=await geometry(second.cdp,point);assert.deepEqual(secondGeometry.regionPanels,firstGeometry.regionPanels);assert.deepEqual(secondGeometry.groups,firstGeometry.groups);assert.ok(Math.abs(secondGeometry.width-firstGeometry.width)<2);assert.ok(Math.abs(secondGeometry.height-firstGeometry.height)<2)
    const restoredMixed=await control('inspect.tab',{kind:'tab',tabId:point.tab.id})
    assert.deepEqual(restoredMixed.result.tab.regions.map(region=>({regionId:region.regionId,kind:region.kind})),receipt.mixedViewAgent.regions.map(region=>({regionId:region.regionId,kind:region.kind})))
    const restoredAgent=restoredMixed.result.tab.regions.find(region=>region.kind==='agent');assert.equal(restoredAgent.agentSessionId,session.agentSessionId)
    const agentRegionVisible=await second.cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="${restoredAgent.regionId}"]');const r=e?.getBoundingClientRect();return Boolean(r?.width>0&&r?.height>0&&getComputedStyle(e).visibility!=='hidden')})()`);assert.equal(agentRegionVisible,true)
    await sameHealthyRun(second.cdp,originalRun.acceptedInputBytes)
    receipt.secondRestored={restored,restoredViews,restoredRename,oldCanvas,secondGeometry,restoredMixed:restoredMixed.result,agentRegionVisible}
    await click(second.cdp,selectors('[aria-label="Compare two local branches"]'))
    const refreshed=await compare(second.cdp,'two-point',nextOid); assert.equal(refreshed.surface.comparison.snapshot.targetOid,nextOid); assert.notEqual(refreshed.tab.id,point.tab.id)
    const newCanvas=await monaco(second.cdp,'base A','target B next',refreshed.surface.regionId)
    phase='local-blob-failure-isolation'
    await control('focus',{kind:'region',regionId:point.surface.regionId});await monaco(second.cdp,'base A','target B',point.surface.regionId)
    const blob=(await git('rev-parse',`${targetOid}:shared.txt`)).trim();assert.match(blob,/^[a-f0-9]{40}$/)
    const blobPath=join(workspacePath,'.git/objects',blob.slice(0,2),blob.slice(2));const blobBytes=await readFile(blobPath);assert.ok(blobBytes.length>0)
    await rm(blobPath)
    await click(second.cdp,selectors(`[data-git-diff-region="${point.surface.regionId}"] [title="Reread these fixed commits"]`))
    const error=await waitFor('real native object failure visible',()=>second.cdp.evaluate(`document.querySelector('[data-git-diff-region="${point.surface.regionId}"] .branches-inline-error[role="alert"]')?.textContent`));assert.ok(error.trim().length>0)
    const retainedCanvas=await monaco(second.cdp,'base A','target B',point.surface.regionId)
    const failedState=await state(second.cdp);assert.deepEqual(failedState.workbench.tabs[point.tab.id],persisted.workbench.tabs[point.tab.id])
    await sameHealthyRun(second.cdp,originalRun.acceptedInputBytes)
    const marker=`private-healthy-after-git-failure-${randomUUID()}`
    const ack=await client.writeAgent({agentSessionId:session.agentSessionId,expectedRun:session.run,data:`${marker}\r`,source:"user"});assert.equal(ack.runId,session.run.runId);assert.equal(ack.appliedByteRange.startByte,originalRun.acceptedInputBytes);assert.ok(ack.appliedByteRange.endByte>ack.appliedByteRange.startByte)
    const output=await waitFor('actual healthy cat output after Git failure',async()=>{const reply=await client.readRunReplay(session.run);const text=reply.replay.map(event=>event.data).join('');return text.includes(marker)?{run:reply.run,marker,outputDigest:digest(text),events:reply.replay.length,gap:reply.gap}:null});assert.ok(output.events>0);assert.equal(output.run.pid,originalRun.pid)
    receipt.failureIsolation={blob,blobDigest:digest(blobBytes),error,retainedCanvas,ack,output}
    await control('focus',{kind:'region',regionId:long.surface.regionId});const goodCanvas=await monaco(second.cdp,'long ancestor','long target B',long.surface.regionId)
    await control('focus',{kind:'region',regionId:refreshed.surface.regionId});await monaco(second.cdp,'base A','target B next',refreshed.surface.regionId)
    await click(second.cdp,`${selectors('.branch-comparison__file')}.filter(e=>e.title==='binary.bin')`)
    const binary=await waitFor('actual binary fixed descriptor',async()=>{const s=await state(second.cdp);return Object.values(s.workbench.tabs).flatMap(tab=>Object.values(tab.regions).map(surface=>({tab,surface}))).find(x=>x.surface.kind==='git-diff'&&x.surface.comparison.file.path==='binary.bin')})
    const binaryReason=await waitFor('honest binary-or-large display',()=>second.cdp.evaluate(`(() => {const p=document.querySelector('[data-git-diff-region="${binary.surface.regionId}"] .pane-state > span');return p?.textContent==='Binary file or too large for textual diff.'?p.textContent:null})()`));assert.equal(await second.cdp.evaluate(`document.querySelector('[data-git-diff-region="${binary.surface.regionId}"]').querySelectorAll('.monaco-diff-editor').length`),0)
    assert.deepEqual(await agentIds(second.cdp),beforeAgents); assert.deepEqual(await gitFacts(),receipt.gitBefore)
    await sameHealthyRun(second.cdp,ack.acceptedThroughByte)
    receipt.secondUi={restored,restoredViews,restoredRename,oldCanvas,newCanvas,secondGeometry,refreshed:refreshed.surface.comparison,localFailure:{blob,blobDigest:digest(blobBytes),error,retainedCanvas,goodCanvas,ack,output,binaryReason}}; receipt.secondExit=await normalQuit(second)
    receipt.executedSlices.push('normal-second-process-fixed-old-oid-explicit-refresh-new-oid','real-blob-failure-binary-healthy-Agent-ACK-output-isolation')
    receipt.completeGate=true
  }
  receipt.identityAfter=await identity(); assert.deepEqual(receipt.identityAfter,receipt.identityBefore)
  receipt.commandsAfter=await commandIdentity();assert.deepEqual(receipt.commandsAfter,receipt.commandsBefore)
  assert.equal(digest(await readFile(executable)),receipt.privateAgent.executableSha256)
} catch(error) {
  failure={phase,message:error.message,stack:error.stack};receipt.failure=failure
  const active=second??first
  if(active&&active.child.exitCode===null&&active.child.signalCode===null) {
    try { receipt.failureState=await state(active.cdp);receipt.failureDom=await active.cdp.evaluate('document.body.innerText.slice(-6000)') } catch(diagnosticError) {receipt.diagnosticError=diagnosticError.message}
  }
}
finally {
  const cleanupErrors=[]
  // Stop live Main owners before scanning an exited sibling's group: a live Main can otherwise
  // restart a helper that the path scan just killed. Failed quit still reaches every hard cleanup.
  for(const probe of [second,first]) {if(probe&&probe.child.exitCode===null&&probe.child.signalCode===null) {try {await normalQuit(probe)} catch(error) {cleanupErrors.push(error.message)}}}
  try { await client?.dispose() } catch(error) { cleanupErrors.push(error.message) }
  for(const connection of connections) { try { connection.close() } catch(error) { cleanupErrors.push(error.message) } }
  for(const child of children) { if(child.pid===undefined) continue; try { assert.ok(child.pid>1); await stopProbeProcesses(child.pid,root) } catch(error) { cleanupErrors.push(error.message) } }
  try { if(runIdentity) {const actual=await processIdentity(runIdentity.pid);if(actual&&actual.born===runIdentity.born) {assert.equal(actual.group,runIdentity.group);await stopProbeProcesses(actual.group,root)}} } catch(error) { cleanupErrors.push(error.message) }
  const sentinel=process.pid+1_000_000_000
  try { await stopProbeProcesses(sentinel,root) } catch(error) { cleanupErrors.push(error.message) }
  let remaining
  try { remaining=await listProbeProcesses(sentinel,root); assert.deepEqual(remaining,[]) } catch(error) { cleanupErrors.push(error.message) }
  receipt.cleanup={remaining:remaining??null,errors:cleanupErrors,privateProcessesReaped:cleanupErrors.length===0&&remaining?.length===0,temporaryRootRemoved:false}
  if(receipt.cleanup.privateProcessesReaped) { try { await rm(root,{recursive:true,force:true}); receipt.cleanup.temporaryRootRemoved=true } catch(error) { cleanupErrors.push(error.message) } }
  if(cleanupErrors.length&&!failure) failure={phase:'cleanup',message:cleanupErrors.join('; ')}
  for(const [name,value] of initialEnvironment) {if(value===undefined)delete process.env[name];else process.env[name]=value}
}
receipt.passed=!failure; receipt.failure??=failure??null
receipt.remainingAcceptance=receipt.completeGate?[]:['normal two-process restore, fixed OIDs, local object failure, binary and healthy-Agent isolation']
await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
await writeFile(join(repositoryRoot,'.tmp/branch-compare-restart-last.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,completeGate:receipt.completeGate,phase:failure?.phase??'complete',executedSlices:receipt.executedSlices,cleanup:receipt.cleanup,failure:receipt.failure})+'\n')
process.exitCode=receipt.passed?0:1
