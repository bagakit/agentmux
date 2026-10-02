import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from '../../probe-process.mjs'

// Ordinary compiled Main/preload/Renderer and public Core/SDK owners. Recovery is
// triggered from its real Region button; private home is isolated before startup.
const repositoryRoot = resolve(import.meta.dirname, '../../../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const p22Qualification = process.env.AGENTMUX_VERIFY_P22_SCENE === '1'
const mainIntegrationScene = process.env.AGENTMUX_VERIFY_P22_MAIN_SCENE === '1'
assert.ok(!mainIntegrationScene || p22Qualification, 'The Main integration scene requires the private p22 scene')
// Reuse the maintained WebSocket transport already supplied by the desktop test
// dependency. Large compiled Renderer script bodies must survive CDP frames.
const WebSocket = createRequire(require.resolve('happy-dom'))('ws')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-resume-recap-")), home = join(root, 'home'), userData = join(root, 'user-data')
const runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), workspaceId = 'private-resume-recap'
const socketPath = join(runtimeDirectory, 'ctxmux.sock'), deadline = Date.now() + 240000
const fixtureEnvironment = { HOME: home, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(home, 'codex') }
const spatialStatePath = join(runtimeDirectory, 'state', 'spatial-state.json')
if (mainIntegrationScene) fixtureEnvironment.AGENTMUX_SPATIAL_STATE_STORE = spatialStatePath
const environmentBefore = new Map(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]))
const cwdEnv = { ...process.env, ...fixtureEnvironment }
for (const key of Object.keys(cwdEnv)) if (key.startsWith('AGENTMUX_') && !Object.hasOwn(fixtureEnvironment, key)) delete cwdEnv[key]
// A hosting Node process can inherit this Electron switch; the probe launches a GUI.
delete cwdEnv.ELECTRON_RUN_AS_NODE
Object.assign(process.env, fixtureEnvironment)
const { CtxmuxClient } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
const { connectLocalAgentMux, AgentMuxFileAgentSessionStore, connectAgentMuxRpc, agentPromptCondition } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const receipt = { schema: 'agentmux.terminal-resume-recap-scene.v1', passed: false, temporaryRoot: root, userRuntimeTouched: false,
  captureOnly: true, aestheticReview: 'not-performed',
  startedAt: Date.now(), limitations: ['Private ordinary compiled GUI processes; no installed-package qualification.',
    'Synthetic private conversations are persisted through the public Core FileStore; no model-generated recap or real Provider conversation is claimed.'], cleanup: {} }
const children = new Set(), owners = new Map(), connections = new Set(), probes = []
let phase = 'prepare', failure, daemon, sdk, creator, active, agent, terminal
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function own(pid) { assert.ok(pid > 1); const birth = await identity(pid); assert.ok(birth); owners.set(pid, birth) }
async function waitFor(label, read, budget = 25000, cleanup = false) {
  const end = cleanup ? Date.now() + budget : Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Terminal recap gate timed out: ${label}`)
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = [], scripts = new Map(); let serial = 0
  const cdp = { pauses, scripts, close: () => socket.close() }; connections.add(cdp)
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Private CDP handshake timed out')), 12000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); if (message.method === 'Debugger.scriptParsed' && message.params.url) scripts.set(message.params.url, message.params.scriptId); if (message.method === 'Debugger.paused') pauses.push(message.params)
    const request = pending.get(message.id); if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.fail(new Error(message.error.message)) : request.done(message.result)
  })
  socket.addEventListener('close', event => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error(`Private CDP closed: ${event.code} ${event.reason}`)) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 12000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  Object.assign(cdp, { call, async evaluate(expression) {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
    return reply.result.value
  } }); return cdp
}
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
async function control(method, fields = {}) { return rpc.call(method, fields) }
async function observe() { return (await control('app.inspect')).observation }
function durableWorkbench(observation) {
  const { activeWorkspaceId, mainSurface, focus, layouts, tabs } = observation.workbench
  return { activeWorkspaceId, mainSurface, focus, layouts, tabs: tabs.map(tab => ({
    id: tab.id, workspaceId: tab.workspaceId, titleRegionId: tab.titleRegionId, layout: tab.layout,
    regions: tab.regions.map(region => region.kind === 'browser'
      ? { kind: region.kind, regionId: region.regionId, workspaceId: region.workspaceId, browserId: region.browserId, url: region.url }
      : region)
  })) }
}
function persistedPresentation(state) {
  if (mainIntegrationScene) return { workbenchSpaceSelection: state.workbenchSpaceSelection,
    retainedSpatialFocus: state.retainedSpatialFocus, agentComposerDrafts: state.agentComposerDrafts }
  return { restoredWorkbench: state.restoredWorkbench, workbenchSpaceSelection: state.workbenchSpaceSelection,
    retainedSpatialFocus: state.retainedSpatialFocus, agentComposerDrafts: state.agentComposerDrafts }
}
async function launch(label) {
  phase = `launch-${label}`
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, env: cwdEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.add(child); let spawnError, diagnostics = '', mainUrl, rendererUrl, main
  child.on('error', error => { spawnError = error }); child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes.toString()).slice(-16384)
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    if (diagnostics.includes('Waiting for the debugger to disconnect')) main?.close()
  })
  await own(child.pid)
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private GUI exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  main = await cdpConnect(await waitFor('Main inspector', () => { alive(); return mainUrl }))
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
  const anchors = lines.flatMap((line, index) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [index] : [])
  assert.equal(anchors.length, 1)
  await main.call('Runtime.runIfWaitingForDebugger')
  const paused = await waitFor('initial Main pause', () => main.pauses.shift())
  const frame = paused.callFrames[0]
  const mainUrls=[mainPath,pathToFileURL(mainPath).href]
  assert.ok(main.scripts.size>0,'Initial debugger script observations must be nonempty')
  const parsedMainId = mainUrls.map(url=>main.scripts.get(url)).find(Boolean)
  const beforeHomeRead = !parsedMainId || frame.location.scriptId === parsedMainId && frame.location.lineNumber < anchors[0] ||
    paused.reason === 'Break on start' && frame.location.lineNumber === 0
  // ESM dependencies can be parsed before the first instruction executes.
  // Also observe the exact home-read barrier below before allowing that fact.
  receipt.startupIsolation ??= []
  const isolation = {label,reason:paused.reason,parsedMain:Boolean(parsedMainId),parsedMainId,frame:frame.location,
    pausedScript:[...main.scripts].find(([,id])=>id===frame.location.scriptId)?.[0],
    firstHomeReadLine:anchors[0],beforeHomeRead}
  receipt.startupIsolation.push(isolation)
  assert.ok(beforeHomeRead,'Private home must be isolated before Main executes its first home-dependent fact')
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { const app=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app; app.setPath('userData',${JSON.stringify(userData)}); app.setPath('home',${JSON.stringify(home)}); return app.getPath('home') })()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, home)
  const exactMainUrl = `^(?:file://)?${mainPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  const homeBreakpoint = await main.call('Debugger.setBreakpointByUrl', {urlRegex:exactMainUrl,lineNumber:anchors[0]})
  await main.call('Debugger.resume')
  const probe = { child, main, label, diagnostics: () => diagnostics }; probes.push(probe); active = probe
  const homePause = await waitFor('first real Main home-read barrier', async () => {
    alive()
    while (main.pauses.length) {
      const pause = main.pauses.shift()
      if (pause.hitBreakpoints?.includes(homeBreakpoint.breakpointId)) return pause
      await main.call('Debugger.resume')
    }
    return null
  })
  const homeAtBarrier = await main.call('Debugger.evaluateOnCallFrame', {callFrameId:homePause.callFrames[0].callFrameId,
    expression:`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.getPath('home')`,returnByValue:true})
  assert.equal(homeAtBarrier.exceptionDetails,undefined);assert.equal(homeAtBarrier.result.value,home)
  isolation.homeReadBarrier={location:homePause.callFrames[0].location,actualHome:homeAtBarrier.result.value}
  if (mainIntegrationScene) {
    // Observe the real Core file read before startup. The original I/O promises,
    // values and failures are returned unchanged; this never seeds spatial data.
    const spatialObserver = `(() => {
      const fs = process.getBuiltinModule('fs/promises');
      const record = globalThis.__privateP22SpatialTrace = { path: ${JSON.stringify(spatialStatePath)}, sequence: 0, reads: [], writes: [] };
      const readFile = fs.readFile, rename = fs.rename;
      fs.readFile = function(path) {
        const result = readFile.apply(this, arguments);
        if (path === record.path && record.reads.length < 8) {
          const read = { sequence: ++record.sequence }; record.reads.push(read);
          void result.then(value => { read.raw = typeof value === 'string' ? value : value.toString('utf8'); },
            error => { read.error = { code: error.code, message: error.message }; });
        }
        return result;
      };
      fs.rename = function(from, to) {
        const result = rename.apply(this, arguments);
        if (to === record.path && record.writes.length < 8) record.writes.push({ sequence: ++record.sequence });
        return result;
      };
      process.getBuiltinModule('module').syncBuiltinESMExports();
      return true;
    })()`
    const registration = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: homePause.callFrames[0].callFrameId,
      expression: spatialObserver, returnByValue: true })
    assert.equal(registration.exceptionDetails, undefined); assert.equal(registration.result.value, true)
    probe.spatialObserverSha256 = hash(Buffer.from(spatialObserver))
  }
  if (p22Qualification) {
    const trace = `(() => {
      const record = window.__privateP22StorageTrace = { sequence: 0, reads: [], writes: [] };
      const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function(name) {
        const value = getItem.apply(this, arguments);
        if (name === 'agentmux-workbench-v1' && this === window.localStorage) {
          const sequence = ++record.sequence;
          if (record.reads.length < 8) record.reads.push({ sequence, raw: value });
        }
        return value;
      };
      Storage.prototype.setItem = function(name, value) {
        const result = setItem.apply(this, arguments);
        if (name === 'agentmux-workbench-v1' && this === window.localStorage && record.writes.length < 8) record.writes.push({ sequence: ++record.sequence });
        return result;
      };
    })()`
    const observerPath=join(root,'observe-workbench.cjs')
    const observer=`require('electron').contextBridge.executeInMainWorld({func:${trace.slice(0,-2)}});\n`
    await writeFile(observerPath,observer)
    // Session frame preloads run before the product preload and its real Store.
    // This read observer adds no navigation, data seed or loadFile interposition.
    const registration = await main.call('Debugger.evaluateOnCallFrame', {callFrameId:homePause.callFrames[0].callFrameId,
      expression:`(() => {
        const {app,session,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron');
        app.whenReady().then(()=>{
          if(BrowserWindow.getAllWindows().length!==0)throw Error('Observer registration must precede the first product window');
          if(app.getPath('userData')!==${JSON.stringify(userData)})throw Error('Observer Session must use the private userData');
          const id=session.defaultSession.registerPreloadScript({type:'frame',filePath:${JSON.stringify(observerPath)}});
          globalThis.__privateP22PreloadRegistration={scriptIdentifier:id,observerPath:${JSON.stringify(observerPath)},registeredBeforeFirstWindow:true};
        });
        return true;
      })()`,returnByValue:true})
    assert.equal(registration.exceptionDetails,undefined);assert.equal(registration.result.value,true)
    probe.traceSha256=hash(Buffer.from(trace))
    probe.observerSha256=hash(Buffer.from(observer))
  }
  await main.call('Debugger.removeBreakpoint',{breakpointId:homeBreakpoint.breakpointId})
  await main.call('Debugger.resume')
  const endpoint = new URL(await waitFor('Renderer debugger', async () => {
    alive()
    // Electron pauses its bootstrap and then the application entry for inspect-brk.
    // Home was already isolated before either entry; release each real start pause.
    while(main.pauses.length){main.pauses.shift();await main.call('Debugger.resume')}
    return rendererUrl
  }))
  const page = await waitFor('real loaded Renderer', async () => { alive(); return (await (await fetch(`http://${endpoint.host}/json/list`,{signal:AbortSignal.timeout(5000)})).json()).find(row => row.type === 'page' && row.url.startsWith('file:')) })
  probe.cdp ??= await cdpConnect(page.webSocketDebuggerUrl); await probe.cdp.call('Runtime.enable'); await probe.cdp.call('Debugger.enable')
  await waitFor('public IPC and loaded Store', () => probe.cdp.evaluate('Boolean(window.agentmux && document.querySelector(".window-status-bar"))'))
  await waitFor('actual client readiness', async () => { try { const value = await observe(); return !value.workbench.loading ? value : null } catch (error) { alive(); receipt.readinessError = { message: error.message, code: error.code }; if (error instanceof TypeError) throw error; return null } })
  assert.equal(await probe.cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), home)
  const loadedMainUrl=mainUrls.find(url=>main.scripts.has(url));assert.ok(loadedMainUrl,'Actual compiled Main must have loaded')
  const loadedMain=await main.call('Debugger.getScriptSource',{scriptId:main.scripts.get(loadedMainUrl)})
  assert.ok(loadedMain.scriptSource.includes(await readFile(mainPath,'utf8')),'Actual loaded Main must contain exact compiled bytes')
  if (p22Qualification) {
    probe.preLoadTrace=await main.evaluate('globalThis.__privateP22PreloadRegistration')
    assert.equal(probe.preLoadTrace?.registeredBeforeFirstWindow,true)
    assert.ok(probe.preLoadTrace.scriptIdentifier)
    probe.preLoadTrace.scriptSha256=probe.traceSha256
    probe.preLoadTrace.observerSha256=probe.observerSha256
    probe.firstHydration = await probe.cdp.evaluate('window.__privateP22StorageTrace')
    assert.ok(probe.firstHydration?.reads.length > 0, 'The real startup must read durable workbench storage')
    if (label === 'after') {
      const first = probe.firstHydration.reads[0]
      assert.ok(first.raw, 'The second process must read its nonempty saved workbench before fixture actions')
      assert.ok(probe.firstHydration.writes.every(write => write.sequence > first.sequence), 'No write may precede the first durable read')
      const persisted = JSON.parse(first.raw)
      if (!mainIntegrationScene) {
        assert.ok(Object.keys(persisted.state.restoredWorkbench.tabs).length > 0, 'The original durable Tabs cannot be empty')
        assert.ok(Object.keys(persisted.state.restoredWorkbench.layouts).length > 0, 'The original durable Tab Groups cannot be empty')
      }
      assert.ok(Object.keys(persisted.state.agentComposerDrafts).length > 0, 'The original durable draft cannot be empty')
      receipt.firstHydration = { ...probe.preLoadTrace, ...probe.firstHydration, persisted }
      assert.deepEqual(persistedPresentation(persisted.state), receipt.persistedBefore.presentation, 'First hydrate must consume the first process durable workbench, including focus and draft')
    }
  }
  if (mainIntegrationScene) {
    probe.spatialHydration = await main.evaluate('globalThis.__privateP22SpatialTrace')
    assert.equal(probe.spatialHydration.path, spatialStatePath)
    assert.ok(probe.spatialHydration.reads.length > 0, 'Ordinary startup must read the private Core spatial document')
    if (label === 'after') {
      const first = probe.spatialHydration.reads[0]
      assert.ok(first.raw, 'The second process must first read the nonempty spatial document saved by the first process')
      assert.ok(probe.spatialHydration.writes.every(write => write.sequence > first.sequence), 'No spatial write may precede the first Core read')
      const state = JSON.parse(first.raw)
      assert.deepEqual(state, receipt.spatialBefore.state, 'First Core read must consume the first process exact durable spatial state')
      const current = await probe.cdp.evaluate('window.agentmux.spatial.read()')
      assert.deepEqual(current.graph, state.graph, 'The public spatial API must retain the first Core graph')
      receipt.firstSpatialHydration = { observerSha256: probe.spatialObserverSha256, ...probe.spatialHydration,
        state, publicState: current, rawSha256: hash(Buffer.from(first.raw)) }
    }
  }
  return probe
}
async function quit(probe, cleanup = false) {
  assert.equal(await identity(probe.child.pid), owners.get(probe.child.pid)); let responseError = null
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()`) }
  catch (error) { responseError = error.message }
  probe.main.close(); probe.cdp?.close()
  await waitFor('ordinary GUI exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null, 25000, cleanup)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null)
  probe.exit = { code: 0, signal: null, responseError }
  return probe.exit
}
async function click(selector) {
  const point = await waitFor('exact visible control', () => active.cdp.evaluate(`(() => { const es=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&getComputedStyle(e).visibility==='visible'&&hit&&e.contains(hit)});if(es.length!==1)return null;const r=es[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await active.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function healthyInput(regionId, runId, label, outputNeedle = label.replace(/[\r\n]+$/, '')) {
  const snapshot = await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')
  const session = snapshot.sessions.find(session => session.control.run.runId === runId)
  assert.equal(session?.processState, 'running'); const before = await sdk.status(runId)
  await active.cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(session.control)},${JSON.stringify(label)},'user')`)
  const after = await waitFor('original Run input ACK', async () => { const row = await sdk.status(runId); return row.applied_input_bytes === before.applied_input_bytes + Buffer.byteLength(label) ? row : null })
  assert.equal(after.pid, before.pid); assert.equal(after.state.type, 'running')
  // PTY output can convert the input LF to CRLF. Match the nonempty payload;
  // the input receipt above still checks every transmitted byte, including LF.
  const needle = Buffer.from(outputNeedle); assert.ok(needle.length > 0)
  const replay = await waitFor('original PTY output ACK', async () => { const attachment = await sdk.attach(runId, 0); try { const bytes = Buffer.concat(attachment.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))); return bytes.includes(needle) ? bytes : null } finally { attachment.close() } })
  return { regionId, runId, pid: after.pid, inputBefore: before.applied_input_bytes, inputAfter: after.applied_input_bytes, outputBytes: after.latest_output_bytes, outputReplayBase64: replay.toString('base64') }
}
async function inputs() {
  const manifestPath = process.env.AGENTMUX_VERIFY_SOURCE_MANIFEST
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null, paths = []
  if (manifest) { assert.equal(manifest.sourceRoot, repositoryRoot); assert.ok(Object.keys(manifest.files).length > 5000); paths.push(...Object.keys(manifest.files)) }
  else for (const directory of ['apps/desktop/src','packages/core/src','packages/layout/src','packages/demand/src']) await visit(join(repositoryRoot, directory))
  async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path) } }
  await visit(join(desktopRoot, 'out')); await visit(join(repositoryRoot, 'packages/core/dist')); await visit(join(repositoryRoot, 'packages/demand/dist'))
  paths.push('pnpm-lock.yaml','pnpm-workspace.yaml','apps/desktop/scripts/verify-terminal-resume-recap.mjs','apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs',
    'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd','packages/core/vendor/ctxmux/darwin-arm64/manifest.json',
    'packages/core/node_modules/@ctxmux/sdk/dist/index.js','apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js',require('electron'))
  const result = Object.fromEntries(await Promise.all([...new Set(paths)].map(async path => { const full = resolve(repositoryRoot,path), bytes = await readFile(full); assert.ok(bytes.length > 0 || manifest?.files[path] === hash(bytes)); return [full, hash(bytes)] })))
  if (manifest) for (const [path, expected] of Object.entries(manifest.files)) assert.equal(result[resolve(repositoryRoot,path)], expected, path)
  receipt.source = manifest ? { originCommit: manifest.originCommit, fileCount: Object.keys(manifest.files).length, manifestSha256: hash(await readFile(manifestPath)) } : { kind: 'current Source directories' }
  return result
}
async function screenshot(label) {
  const path=join(resolve(process.env.AGENTMUX_VERIFY_RECEIPT,'..'),label+'.png')
  await mkdir(resolve(path,'..'),{recursive:true})
  await active.cdp.call('Page.enable')
  const {data}=await active.cdp.call('Page.captureScreenshot',{format:'png'})
  await writeFile(path,Buffer.from(data,'base64'))
  const viewport=await active.cdp.evaluate('({width:innerWidth,height:innerHeight,devicePixelRatio})')
  return {path,sha256:hash(Buffer.from(data,'base64')),viewport}
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
let saved, empty, savedRegion, healthyRegion
async function size(width,height){await active.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').BrowserWindow.getAllWindows()[0].setSize(${width},${height})`);await delay(250)}
async function loadedRenderer(){
 const prefix=pathToFileURL(join(desktopRoot,'out/renderer/')).href
 const result={}
 for(const[url,scriptId]of active.cdp.scripts)if(url.startsWith(prefix)&&url.endsWith('.js')){
  const file=await readFile(fileURLToPath(url)), actual=await active.cdp.call('Debugger.getScriptSource',{scriptId})
  assert.equal(hash(Buffer.from(actual.scriptSource)),hash(file),`Loaded bytes differ: ${url}`);result[url]=hash(file)
 }
 assert.ok(Object.keys(result).length>0,'Actual loaded Renderer modules must be nonempty')
 return result
}
async function recap(regionId,needle){
 return waitFor('actual visible sourced recap',()=>active.cdp.evaluate(`(()=>{const rs=Array.from(document.querySelectorAll('[data-workbench-region-id="'+${JSON.stringify(regionId)}+'"]')).filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);if(rs.length!==1)return null;const e=rs[0].querySelector('.session-recap'),stage=rs[0].querySelector('.full-page-loading');if(!e||!stage||!e.textContent.includes(${JSON.stringify(needle)}))return null;const r=e.getBoundingClientRect();return {text:e.textContent,state:e.dataset.recapState,title:stage.querySelector('h1')?.textContent,width:r.width,height:r.height}})()`))
}
try {
 await Promise.all([mkdir(home,{recursive:true}),mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(runtimeDirectory,{recursive:true}),mkdir(join(home,'codex'),{recursive:true})])
 assert.ok(process.env.AGENTMUX_VERIFY_RECEIPT,'Explicit owning receipt path required')
 receipt.inputsBefore=await inputs()
 const stateDirectory=join(runtimeDirectory,'state','ctxmux');await mkdir(stateDirectory,{recursive:true,mode:0o700})
 let daemonDiagnostic=''
 daemon=spawn(join(repositoryRoot,'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),['--socket',socketPath,'--state-dir',stateDirectory],{detached:true,stdio:['ignore','ignore','pipe']});children.add(daemon);daemon.stderr.on('data',bytes=>{daemonDiagnostic=(daemonDiagnostic+bytes.toString()).slice(-16384)});await own(daemon.pid)
 sdk=new CtxmuxClient({socketPath});receipt.runtime=await waitFor('private native Runtime',async()=>{if(daemon.exitCode!==null||daemon.signalCode!==null)throw new Error(daemonDiagnostic);try{return await sdk.runtimeInfo()}catch{return null}})
 if(p22Qualification)assert.equal(receipt.runtime.protocolGeneration,22)
 const executable=join(root,'private-agent.sh'),writer=join(root,'private-writer.sh')
 await writeFile(executable,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nstty -echo -icanon\nprintf 'Private Agent ready\\r\\n'\nexec /bin/cat\n",{mode:0o700})
 await writeFile(writer,`#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.159.2'; exit 0; fi\nfor arg in "$@"; do if [ "$arg" = resume ]; then sleep 3; break; fi; done\nexec ${quote(process.execPath)} ${quote(join(repositoryRoot,'packages/core/test/fixtures/fake-codex-cli.mjs'))} "$@"\n`,{mode:0o700})
 const store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))
 creator=await connectLocalAgentMux({store})
 const create=async(executorId,commandOverride)=>{const value=await creator.createAgent({createOperationId:randomUUID(),executorId,providerId:'codex',commandOverride,workspacePath,env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false,cols:90,rows:25});await own((await sdk.status(value.run.runId)).pid);return value}
 agent=await create('private-agent',executable);saved=await create('private-writer',writer);empty=await create('private-agent',executable)
 await waitFor('native synthetic handle',async()=>{const value=(await store.load()).find(s=>s.agentSessionId===saved.agentSessionId);return value?.nativeHandle?.sessionId?value:null})
 const body='已完成终端输入确认和恢复检查。下一步核对 Session 的上下文摘录、原工作区布局和持续读写。 Resume keeps the same conversation; this excerpt is a captured private fixture, with no model request. '
 receipt.fixtureRecap=body.repeat(6)
 await store.applyTimelineMutation({type:'append',agentSessionId:saved.agentSessionId,item:{id:'private-recap-assistant',agentSessionId:saved.agentSessionId,kind:'assistant_message',status:'complete',source:'native-hook',createdAt:Date.now(),updatedAt:Date.now(),title:'Private captured reply',content:receipt.fixtureRecap}})
 // The normal recovery sample comes from the fake CLI's own clean exit, not
 // stopAgent (which retires the Session) or a native signal (a real crash fact).
 phase='seed-clean-retained-session'
 const readiness=await waitFor('private fake composer readiness',()=>{
  const value=creator.agentSession(saved.agentSessionId).terminalPromptReadiness
  return value?.readyThroughByte!==undefined?value:null
 })
 const beforeExit=await sdk.status(saved.run.runId);assert.equal(beforeExit.state.type,'running')
 const condition=agentPromptCondition(creator.agentSession(saved.agentSessionId))
 assert.equal(condition.expectedRun.runId,saved.run.runId)
 await creator.submitAgentPrompt({...condition,agentSessionId:saved.agentSessionId,operationId:randomUUID(),prompt:'exit'})
 const cleanExit=await waitFor('same private fake Run naturally exited zero',async()=>{
  const value=await sdk.status(saved.run.runId);return value.state.type==='exited'?value:null
 })
 assert.deepEqual(cleanExit.state,{type:'exited',code:0,signal:null})
 const publicExit=await creator.statusAgent(saved.agentSessionId)
 assert.equal(publicExit.run.state,'exited');assert.equal(publicExit.run.exitCode,0)
 const retained=(await store.load()).find(value=>value.agentSessionId===saved.agentSessionId)
 assert.ok(retained,'A clean child exit must keep its original Agent Session')
 assert.equal(retained.run.runId,saved.run.runId);assert.ok(retained.nativeHandle?.sessionId)
 const operation=await sdk.prepareStop(empty.run.runId);await sdk.stop(operation)
 const forcedExit=await waitFor('separate private failure sample ended',async()=>{
  const value=await sdk.status(empty.run.runId);return value.state.type!=='running'?value:null
 })
 receipt.seed={normal:{method:'public Core submitAgentPrompt to private fake CLI: exit',
  agentSessionId:saved.agentSessionId,runId:saved.run.runId,pid:beforeExit.pid,
  readiness,runState:cleanExit.state,publicRun:publicExit.run,retainedAgentSessionId:retained.agentSessionId,
  retainedRunId:retained.run.runId,nativeHandleKind:retained.nativeHandle.kind},
  failure:{method:'public SDK prepareStop/stop',agentSessionId:empty.agentSessionId,runId:empty.run.runId,state:forcedExit.state}}

 await creator.dispose();creator=null
 // Fixture entry state: retained conversations with no completed idle eligibility. Never user state.
 for(const target of [saved,empty]){const current=(await store.load()).find(s=>s.agentSessionId===target.agentSessionId);assert.ok(current);const now=Date.now();await store.compareAndSwap(current,{...current,updatedAt:now,semanticStatus:{state:'working',source:'native-hook',observedAt:now,stateEnteredAt:now}})}
 await writeFile(join(userData,'agentmux.config.json'),JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private local'}],executors:{'private-agent':{label:'Private Agent',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false},'private-writer':{label:'Private writer',providerId:'codex',command:writer,args:[],env:{CODEX_HOME:fixtureEnvironment.CODEX_HOME},injectAgentMuxGuide:false}},workspaces:[{id:workspaceId,name:'Resume recap',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{agentAutomation:false,toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}},notifications:{mode:'off'}}))
 await launch('before');await click(`.project-rail-row[data-workspace-id="${workspaceId}"]`);await click('button[title="New tab"]')
 const launcher=await waitFor('workspace launcher',async()=>{const value=await observe();return value.workbench.tabs.filter(tab=>tab.workspaceId===workspaceId).flatMap(tab=>tab.regions).find(region=>region.kind==='launcher')})
 const opened=await control('agent.open',{content:{kind:'agent-session',agentSessionId:agent.agentSessionId},destination:{regionId:launcher.regionId},focus:true});assert.equal(opened.outcome,'opened');healthyRegion=opened.to
 await control('agent.view',{agentSessionId:agent.agentSessionId,mode:'terminal'})
 const restored=await control('agent.open',{content:{kind:'agent-session',agentSessionId:saved.agentSessionId},destination:{regionId:healthyRegion.regionId,split:'right'},focus:true});assert.equal(restored.outcome,'opened');savedRegion=restored.to
 await control('agent.view',{agentSessionId:saved.agentSessionId,mode:'terminal'})
 await size(1320,820);receipt.ready=await recap(savedRegion.regionId,'下一步核对');assert.equal(receipt.ready.title,'Ready to restore');assert.ok(receipt.ready.text.includes('Captured conversation'));receipt.screenshotNormal=await screenshot('normal-ready')
 if(!p22Qualification){await size(920,520);receipt.narrow=await recap(savedRegion.regionId,'下一步核对');receipt.screenshotNarrow=await screenshot('narrow-long-recap')}
 assert.ok(savedRegion.spaceId,'The real private Space must exist')
 const newTab=await control('agent.open',{content:{kind:'agent-session',agentSessionId:empty.agentSessionId},destination:{spaceId:savedRegion.spaceId,newTab:true},focus:true});assert.equal(newTab.outcome,'opened')
 await control('agent.view',{agentSessionId:empty.agentSessionId,mode:'terminal'})
 receipt.empty=await waitFor('honest unavailable recap',()=>active.cdp.evaluate(`(()=>{const e=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(newTab.to.regionId)}+'"] .session-recap');return e&&e.dataset.recapState!=='loading'?{text:e.textContent,state:e.dataset.recapState}:null})()`));assert.notEqual(receipt.empty.state,'ready');if(!p22Qualification)receipt.screenshotEmpty=await screenshot('unavailable-recap')
 await control('app.focus',{target:{kind:'space',regionId:savedRegion.regionId},inputPolicy:'preserve'});await size(1320,820)
 // A real draft is entered through the product's controlled input and survives quit/relaunch.
 const draft='UNSENT RECAP RECOVERY DRAFT'
 const composerSelector=`[data-workbench-region-id="${savedRegion.regionId}"] .composer__editor [contenteditable="true"]`
 await click(composerSelector);await active.cdp.call('Input.insertText',{text:draft})
 receipt.draftBefore=await waitFor('actual ProseMirror draft input',()=>active.cdp.evaluate(`document.querySelector(${JSON.stringify(composerSelector)})?.textContent===${JSON.stringify(draft)}?${JSON.stringify(draft)}:null`));assert.equal(receipt.draftBefore,draft)
 receipt.inputBefore=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_BEFORE')
 receipt.before=await observe();receipt.loadedBefore=await loadedRenderer();const healthyBefore=await sdk.status(agent.run.runId)
 if(p22Qualification){
  receipt.persistedBefore=await waitFor('first process actually persisted nonempty draft and original workbench',async()=>{
   const raw=await active.cdp.evaluate('localStorage.getItem("agentmux-workbench-v1")');if(!raw)return null
   // AgentSessionComposer owns an attached Agent draft by Session ID; launcher
   // drafts use Region IDs. Bind this real controlled editor to its actual owner.
   const state=JSON.parse(raw).state;if(state.agentComposerDrafts?.[saved.agentSessionId]!==draft)return null
   if (mainIntegrationScene) {
    const spatial = await active.cdp.evaluate('window.agentmux.spatial.read()')
    if (!spatial?.graph.regions.some(region => region.regionId === savedRegion.regionId && region.agentSessionId === saved.agentSessionId)) return null
    assert.ok(spatial.graph.regions.some(region => region.regionId === healthyRegion.regionId && region.agentSessionId === agent.agentSessionId))
    assert.ok(spatial.graph.tabs.length > 0)
    assert.ok(Object.values(spatial.graph.layouts).some(layout => layout.groups.length > 0 && layout.groups.some(group => group.tabOrder.length > 0)))
    receipt.spatialBefore = { path: spatialStatePath, state: spatial }
   } else {
    const tabs=Object.values(state.restoredWorkbench?.tabs??{}),layouts=Object.values(state.restoredWorkbench?.layouts??{})
    assert.ok(tabs.length>0&&layouts.length>0)
    assert.ok(tabs.some(tab=>Object.keys(tab.regions).length===2))
    assert.ok(layouts.some(layout=>layout.groups.length>0&&layout.groups.some(group=>group.tabOrder.length>0)))
   }
   return {rawSha256:hash(Buffer.from(raw)),draftOwner:{agentSessionId:saved.agentSessionId,regionId:savedRegion.regionId},presentation:persistedPresentation(state)}
  })
 }
 receipt.firstQuit=await quit(active)
 if (mainIntegrationScene) {
  const raw = await readFile(spatialStatePath, 'utf8'), state = JSON.parse(raw)
  assert.deepEqual(state.graph, receipt.spatialBefore.state.graph, 'Ordinary quit must retain the first process Core graph')
  receipt.spatialBefore = { ...receipt.spatialBefore, state, rawSha256: hash(Buffer.from(raw)) }
 }
 await launch('after');receipt.after=await observe();assert.notEqual(receipt.before.main.pid,receipt.after.main.pid);assert.deepEqual(durableWorkbench(receipt.after),durableWorkbench(receipt.before))
 receipt.recappedAfter=await recap(savedRegion.regionId,'下一步核对');assert.equal(receipt.recappedAfter.text,receipt.ready.text)
 receipt.draftAfter=await waitFor('durable ProseMirror draft',()=>active.cdp.evaluate(`document.querySelector(${JSON.stringify(composerSelector)})?.textContent===${JSON.stringify(draft)}?${JSON.stringify(draft)}:null`));assert.equal(receipt.draftAfter,draft)
 receipt.inputAfter=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_AFTER');const healthyAfter=await sdk.status(agent.run.runId);assert.equal(healthyAfter.pid,healthyBefore.pid);assert.equal(healthyAfter.state.type,'running');receipt.healthyRun={id:healthyAfter.id,pid:healthyAfter.pid,state:healthyAfter.state};receipt.screenshotRestart=await screenshot('after-process-restart')
 receipt.loadedAfter=await loadedRenderer();assert.deepEqual(receipt.loadedAfter,receipt.loadedBefore)
 phase='actual-resume';const resumeSelector=`[data-workbench-region-id="${savedRegion.regionId}"] .full-page-loading__actions button`
 await click(resumeSelector);receipt.resuming=await waitFor('actual Resume remains alongside recap',()=>active.cdp.evaluate(`(()=>{const r=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(savedRegion.regionId)}+'"]'),b=r.querySelector('.full-page-loading__actions button'),e=r.querySelector('.session-recap');return b?.textContent.includes('Resuming')&&e?.textContent.includes('下一步核对')?{button:b.textContent,disabled:b.disabled,recap:e.textContent}:null})()`));if(!p22Qualification)receipt.screenshotResuming=await screenshot('actual-resuming')
 receipt.resumed=await waitFor('same Session genuinely resumed',async()=>{const snapshot=await active.cdp.evaluate('(async()=>await window.agentmux.sessions.snapshot())()');const s=snapshot.sessions.find(s=>s.id===saved.agentSessionId);return s?.processState==='running'&&s.control.run.runId!==saved.run.runId?{sessionId:s.id,runId:s.control.run.runId}:null});await own((await sdk.status(receipt.resumed.runId)).pid)
 receipt.inputAfterResume=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_AFTER_RESUME')
 if(p22Qualification){
  // Presentation-only replay of a previously captured private Native event. This
  // is not a claim that this GUI's daemon produced that historical Gap.
  const gapPath=join(repositoryRoot,'.tmp/ctxmux-p22-qualification/core-gap-runtime.json')
  const gapBytes=await readFile(gapPath),counterexample=JSON.parse(gapBytes)
  assert.equal(counterexample.passed,true);assert.equal(counterexample.userRuntimeTouched,false);assert.equal(counterexample.protocol,22)
  assert.equal(counterexample.gap.code,'OUTPUT_GAP')
  const channelSource=await readFile(join(desktopRoot,'src/shared/contracts.ts'),'utf8')
  const channels=Array.from(channelSource.matchAll(/export const SESSION_EVENT_CHANNEL = '([^']+)'/g))
  assert.equal(channels.length,1,'Use the actual existing production event channel')
  const event={type:'core',hostId:'local',event:counterexample.gap}
  await active.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').BrowserWindow.getAllWindows()[0].webContents.send(${JSON.stringify(channels[0][1])},${JSON.stringify(event)})`)
  await waitFor('captured Gap through actual preload/Store diagnostic',()=>active.cdp.evaluate('document.querySelector(".error-notice")?.textContent.includes("OUTPUT_GAP")'))
  await click('.error-notice__details summary')
  receipt.gapProjection=await active.cdp.evaluate('({text:document.querySelector(".error-notice")?.innerText,detailsOpen:document.querySelector(".error-notice__details")?.open})')
  assert.equal(receipt.gapProjection.detailsOpen,true);assert.ok(receipt.gapProjection.text.includes('Origin: daemon'))
  assert.ok(receipt.gapProjection.text.includes('decoded output missed by this observation: unknown'))
  receipt.gapProjection.record={path:gapPath,sha256:hash(gapBytes),kind:'previously-captured-private-Core-Native-event',liveGapInThisGUI:false}
  receipt.screenshotGap=await screenshot('captured-gap-details')
  receipt.inputAfterGapProjection=await healthyInput(healthyRegion.regionId,agent.run.runId,'PRIVATE_RECAP_HEALTHY_AFTER_GAP_PROJECTION')
  assert.equal(receipt.inputAfterGapProjection.pid,receipt.inputBefore.pid)
  receipt.limitations.push('The additional Gap details frame replays a captured private Native event through ordinary Main/preload/Store IPC; it does not claim this GUI Runtime emitted that event or owns its Run.')
 }
 assert.deepEqual(await sdk.runtimeInfo(),receipt.runtime);assert.equal(await identity(daemon.pid),owners.get(daemon.pid));receipt.inputsAfter=await inputs();assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)
 receipt.secondQuit=await quit(active);receipt.passed=true
} catch(error) {
  failure={phase,message:error.message,stack:error.stack};receipt.passed=false
  if(active?.cdp)try{receipt.failureObservation=await observe();receipt.failureDom=await active.cdp.evaluate(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{tag:e.tagName,class:e.className,width:r.width,height:r.height,display:s.display,visibility:s.visibility,position:s.position,flex:s.flex,overflow:s.overflow,clipPath:s.clipPath,inert:e.inert}};
    return {text:document.body.innerText.slice(0,12000),keyTrace:window.__privateP22StorageTrace??null,
      regions:Array.from(document.querySelectorAll('[data-workbench-region-id]')).map(e=>{const parents=[];for(let p=e;p&&parents.length<12;p=p.parentElement)parents.push(rect(p));return{id:e.dataset.workbenchRegionId,parents}}),
      recaps:Array.from(document.querySelectorAll('.session-recap')).map(e=>({regionId:e.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId,...rect(e),state:e.dataset.recapState,title:e.closest('.full-page-loading')?.querySelector('h1')?.textContent})),
      buttons:Array.from(document.querySelectorAll('button')).filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,title:e.title,aria:e.getAttribute('aria-label')}))}
  })()`);receipt.failureScreenshot=await screenshot('failure')}catch(diagnosticError){receipt.diagnosticError=diagnosticError.message}
}
finally {
  const errors=[]
  try{await rpc.dispose()}catch(error){errors.push(error.message)}
  if(creator)try{await creator.dispose()}catch(error){errors.push(error.message)}
  if(active&&active.child.exitCode===null&&active.child.signalCode===null)try{await quit(active,true)}catch(error){errors.push(error.message)}
  for(const cdp of connections)try{cdp.close()}catch(error){errors.push(error.message)}
  // Only after the continuity observations: terminate this private invocation's
  // owned daemon/children. Cleanup is not a stop/resume step in the experiment.
  for(const child of children)if(child.pid>1)try{if(await identity(child.pid)===owners.get(child.pid))await stopProbeProcesses(child.pid,root)}catch(error){errors.push(error.message)}
  for(const[pid,birth]of owners)try{if(await identity(pid)===birth)process.kill(pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')errors.push(error.message)}
  let remaining=[];try{await waitFor('owned private cleanup',async()=>{const paths=await listProbeProcesses(-1,root),pids=await Promise.all([...owners].map(async([pid,birth])=>await identity(pid)===birth?pid:null));remaining=[...new Set([...paths,...pids.filter(Boolean)])];return remaining.length===0?[]:null},5000,true)}catch(error){errors.push(error.message)}
  receipt.cleanup={errors,remaining,rootRemoved:false};if(!errors.length&&!remaining.length){await rm(root,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
  for(const[key,value]of environmentBefore)value===undefined?delete process.env[key]:process.env[key]=value
  if(errors.length||remaining.length){receipt.passed=false;failure??={phase:'cleanup',message:errors.join('; ')||remaining.join(',')}}
}
receipt.guis=probes.map(probe=>({label:probe.label,pid:probe.child.pid,exitCode:probe.child.exitCode,signalCode:probe.child.signalCode,ordinaryQuit:probe.exit??null,diagnostics:probe.diagnostics()}));receipt.finishedAt=Date.now();receipt.failure=failure??null
const output=process.env.AGENTMUX_VERIFY_RECEIPT??join(repositoryRoot,'.tmp/terminal-resume-recap/scene.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,failure:receipt.failure,cleanup:receipt.cleanup})+'\n');process.exitCode=receipt.passed?0:1
