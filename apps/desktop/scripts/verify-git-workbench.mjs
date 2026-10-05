import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// A private built Desktop, real Git, public CLI/RPC and actual UI; no Store/bridge/storage seed.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
assert.deepEqual(process.argv.slice(2, 3), ['--candidate'], 'Pass --candidate EXACT_COMMIT after the coherent candidate build')
const expectedRevision = process.argv[3]
assert.ok(/^[0-9a-f]{40}$/.test(expectedRevision ?? '') && process.argv.length === 4, 'One exact candidate commit is required')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/public-rpc-client.js')))
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const commonDirectory = (await exec('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
const evidenceRoot = resolve(commonDirectory, '..', '.bagakit/feature-tracker/git-reading-surfaces')
await mkdir(evidenceRoot, { recursive: true })
const artifacts = await mkdtemp(join(evidenceRoot, 'native-'))
const root = join(artifacts, 'private')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), physicalRuntimeDirectory = join(root, 'runtime')
let runtimeDirectory = physicalRuntimeDirectory, runtimeAliasRoot, privateRootAlias
const workspacePath = join(root, 'repository'), codexHome = join(privateHome, 'codex')
const workspaceId = 'private-git-workbench', workspaceName = 'Repository'
const children = new Set(), connections = new Set()
const deadline = Date.now() + 240_000
const receipt = { schema: 'agentmux.git-reading-surfaces.v1', expectedRevision, sourceRoot: repositoryRoot,
  passed: false, screenshots: [], cleanup: {}, aestheticReview: 'not-performed' }
let phase = 'prepare', failure, first, second
// This probe is a separate local user client, never the surrounding managed Agent.
const privateEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_')))
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(physicalRuntimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(physicalRuntimeDirectory, 'state/spatial-state.json'),
  AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'), CODEX_HOME: codexHome }
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
async function git(...args) { return (await exec('git', ['-C', workspacePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout }
async function waitFor(label, read, budget = 25_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(70) }
  throw new Error(`Git workbench timed out: ${label}`)
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
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + '\nExpression: ' + expression)
    return result.result.value
  } })
  return cdp
}
async function launch(label) {
  phase = `launch-${label}`
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(process.env[name], undefined, `Ordinary launch inherited ${name}`)
  const readyFile = join(root, `ready-${label}.json`)
  const bootstrap = join(root, 'private-home.cjs')
  await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('home', ${JSON.stringify(privateHome)}); app.setAppPath(${JSON.stringify(desktopRoot)}); import(${JSON.stringify(pathToFileURL(join(desktopRoot, 'out/main/index.js')).href)}).catch(error => { console.error(error); app.exit(1) });\n`)
  const child = spawn(require('electron'), [bootstrap, '--inspect=0', '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...privateEnvironment, ...fixtureEnvironment, ELECTRON_RUN_AS_NODE: undefined, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.on('error', error => { spawnError = error })
  assert.ok(child.pid > 1)
  child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes).slice(-16_384); receipt.mainDiagnostics = diagnostics
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
    rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
  })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main inspector`, () => { alive(); return mainUrl }))
  await main.call('Runtime.enable')
  const home = privateHome
  let ready
  try { ready = await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }) }
  catch (error) {
    receipt.startup = await main.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); return {ready:e.app.isReady(),singleInstance:e.app.hasSingleInstanceLock(),userData:e.app.getPath('userData'),windows:e.BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible()}))} })()`)
    throw error
  }
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.call('Runtime.enable')
  cdp.nativeMain = main
  await waitFor(`${label} trusted UI`, () => visibleRead(cdp, 'Boolean(window.agentmux && document.querySelector(".project-list"))'))
  await activate(cdp)
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  return { child, main, cdp }
}
async function click(cdp, expression, button = 'left') {
  await activate(cdp)
  const point = await waitFor('exact visible UI control', () => visibleRead(cdp, `(() => { const matches = ${expression}; if (matches.length !== 1) return null; const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null; element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const selectors = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function monaco(cdp, original, modified, regionId, inline = false) {
  await activate(cdp)
  // Monaco deliberately switches to inline at narrow split widths. Verify its actual rendered
  // presentation, retaining exact separate-side checks whenever both sides are displayed.
  const paneSelector = inline ? `[data-git-workbench-region="${regionId}"] [aria-label="Commit file diff"]`
    : `[data-git-diff-region="${regionId}"]`
  return waitFor('visible readonly Monaco canvas and content', () => visibleRead(cdp, `(() => { const pane = document.querySelector(${JSON.stringify(paneSelector)}); if (!pane || !pane.getClientRects().length || getComputedStyle(pane).visibility === 'hidden') return null; const canvas=pane.querySelector('.monaco-diff-editor');if(!canvas)return null; const rect=canvas.getBoundingClientRect();if(rect.width<80||rect.height<80)return null; const read = side => canvas.querySelector('.editor.'+side+' .view-lines')?.innerText.replace(/\u00a0/g,' ').trim(); const left=read('original'),right=read('modified');const presentation=canvas.classList.contains('side-by-side')?'side-by-side':'inline';const displayedLines=Array.from(canvas.querySelectorAll('.view-lines')).flatMap(e=>e.innerText.replace(/\u00a0/g,' ').split('\\n').map(line=>line.trim()).filter(Boolean));const valid=presentation==='side-by-side'?left===${JSON.stringify(original)}&&right===${JSON.stringify(modified)}:(${JSON.stringify(original)} === "" || displayedLines.includes(${JSON.stringify(original)})) && (${JSON.stringify(modified)} === "" || displayedLines.includes(${JSON.stringify(modified)}));return valid?{presentation,original:left,modified:right,displayedLines,viewportWidth:rect.width,viewportHeight:rect.height,canvases:pane.querySelectorAll('.monaco-diff-editor').length}:null })()`))
}
async function control(method, params) {
  /** @type {import('../../../packages/core/dist/public-rpc-client.js').AgentMuxRpcClient} */
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  try { return await rpc.call(method, params) }
  finally { await rpc.dispose() }
}
async function cliOpen(oid) {
  await activate(first.cdp)
  const args = [join(repositoryRoot, 'packages/core/bin/amux'), '--endpoint', 'unix:' + join(runtimeDirectory, 'control.sock'),
    'git', 'open', '--workspace', workspaceId, '--host', 'local', '--workspace-path', workspacePath,
    ...(oid ? ['--oid', oid] : [])]
  const result = await exec(process.execPath, args, { cwd: repositoryRoot, env: { ...privateEnvironment, ...fixtureEnvironment }, timeout: 20_000 })
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.ok, true); assert.equal(envelope.operation, 'git.open')
  await activate(first.cdp)
  return { args, result: envelope.result }
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

async function activate(cdp) {
  let requestedAt = 0, observed
  try {
    // Keep OS window focus as a diagnostic; a visible, focused document can
    // consume actual input without owning the system-wide foreground window.
    return await waitFor('actual visible native window and visible focused document', async () => {
      const [native, document] = await Promise.all([
        cdp.nativeMain.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; return {visible:w.isVisible(),focused:w.isFocused()} })()`),
        cdp.evaluate('({visibility:document.visibilityState,documentFocused:document.hasFocus()})')
      ])
      observed = {...native, ...document}
      if (native.visible && document.visibility === 'visible' && document.documentFocused) return observed
      // Request activation only when necessary: reactivating a readable window
      // can dismiss its open native/portal menus between real input events.
      if (Date.now() - requestedAt >= 250) {
        await cdp.nativeMain.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; w.show(); e.app.focus({steal: true}); w.focus() })()`)
        await cdp.call('Page.bringToFront')
        requestedAt = Date.now()
      }
      return null
    }, 10_000)
  } catch (error) {
    receipt.activationFailure = observed
    throw error
  }
}
async function visibleRead(cdp, expression) {
  await activate(cdp)
  return await cdp.evaluate(expression)
}
async function capture(cdp, name, width = 1280, theme = 'dark') {
  let focus = await activate(cdp)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  // Settings' actual CAS owner updates both App chrome and useMonacoTheme consumers.
  const appearance = await cdp.evaluate(`(async () => { const expected=await window.agentmux.config.get();const changed=(expected.appearance.appAppearance??'dark')!==${JSON.stringify(theme)};const committed=changed?await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:${JSON.stringify(theme)}}},expected):expected;return {changed,appAppearance:committed.appearance.appAppearance??'dark',authoredAppAppearance:committed.appearance.appAppearance??null} })()`)
  assert.equal(appearance.appAppearance, theme)
  const themeState = await waitFor('committed App and visible Monaco appearance', () => visibleRead(cdp, `(() => {const editors=Array.from(document.querySelectorAll('.monaco-editor')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');const appearance=document.documentElement.dataset.appearance;return appearance===${JSON.stringify(theme)}&&editors.every(e=>e.classList.contains(${JSON.stringify(theme === 'light' ? 'vs' : 'vs-dark')}))?{appearance,monaco:editors.map(e=>({className:e.className,background:getComputedStyle(e).backgroundColor}))}:null})()`))
  await delay(250)
  focus = await activate(cdp)
  const surfaces = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-git-workbench-region]')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>{const r=e.getBoundingClientRect();return {regionId:e.dataset.gitWorkbenchRegion,label:e.getAttribute('aria-label'),width:r.width,height:r.height}})`)
  const spatial = await state()
  const targets = surfaces.map(surface => ({ ...surface, resource: spatial.graph.resources['region:' + surface.regionId] }))
  receipt.visibility ??= []; receipt.visibility.push({ name, ...focus, surfaces, appearanceOwner: appearance, renderedTheme: themeState })
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(artifacts, name + '.png'); await writeFile(path, Buffer.from(data, 'base64'))
  receipt.screenshots.push({ path, width, theme, targets, sha256: digest(Buffer.from(data, 'base64')) })
}
async function state() { return (await control('space.state', {})).state }
async function identity() {
  const paths = ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/release.json',
    'apps/desktop/src/renderer/src/components/BranchesPanel.tsx',
    'apps/desktop/src/renderer/src/styles/git-workbench.css',
    'apps/desktop/src/renderer/src/styles/source-control.css',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/src/renderer/src/components/ProjectFilesTool.tsx',
    'apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'apps/desktop/src/renderer/src/lib/control.ts',
    'packages/git/src/git-repository.ts', 'packages/git/dist/git-repository.js', 'packages/git/package.json',
    'packages/git/src/types.ts', 'packages/git/dist/types.d.ts', 'packages/core/package.json',
    'packages/core/dist/public-rpc-service.js', 'packages/core/dist/public-rpc-git.js',
    'packages/core/dist/agentmux-cli-commands.js', 'packages/core/src/hosted-value.ts', 'packages/core/dist/hosted-value.js',
    'apps/desktop/src/main/git-public-control.ts',
    'apps/desktop/out/renderer/index.html']
  async function bundles(directory, pattern = /\.(?:js|css|json)$/) {
    for (const entry of await readdir(join(repositoryRoot, directory), {withFileTypes:true})) {
      const path = directory + '/' + entry.name
      if (entry.isDirectory()) await bundles(path, pattern)
      else if (pattern.test(entry.name)) paths.push(path)
    }
  }
  await bundles('apps/desktop/out/renderer/assets')
  await bundles('apps/desktop/src/renderer/src/features/git', /\.(?:ts|tsx)$/)
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(repositoryRoot, path)))])))
}
async function open(oid, parentOid) {
  await activate(first.cdp)
  const result = await control('git.open', { workspaceId, expectedResource: { hostId: 'local', workspacePath }, ...(oid ? { oid } : {}), ...(parentOid ? { parentOid } : {}) })
  await activate(first.cdp)
  return result
}
async function focused(cdp, regionId) {
  await activate(cdp)
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId } })
  return await waitFor('original Git Region visible', () => visibleRead(cdp, `(() => { const e = document.querySelector('[data-git-workbench-region="${regionId}"]'); return e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' })()`))
}
const pane = regionId => `[data-git-workbench-region="${regionId}"]`
async function press(cdp, key) {
  const virtualKeyCode = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13 }[key]
  const input = { key, code: key, ...(virtualKeyCode ? { windowsVirtualKeyCode: virtualKeyCode } : {}) }
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...input })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...input })
}
async function reference(cdp, regionId, value) {
  const selector = pane(regionId) + ' [aria-label="History reference"]'
  const indexes = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const target=Array.from(e.options).findIndex(o=>o.value===${JSON.stringify(value)});return {current:e.selectedIndex,target,label:e.options[target]?.textContent} })()`)
  assert.ok(indexes.target >= 0)
  // macOS's native popup and arrow navigation do not consume Renderer CDP keys.
  // Its actual focused select DOES consume real character typeahead and emits
  // the native change event. The isolated Electron preflight qualifies this path.
  assert.equal(await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});e.focus();return document.activeElement===e })()`), true)
  await delay(1_200) // Reset the native select's preceding typeahead prefix.
  for (const key of indexes.label) {
    const code = /[a-z]/iu.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/u.test(key) ? 'Digit' + key :
      ({ '/': 'Slash', '-': 'Minus', ' ': 'Space', '.': 'Period', '_': 'Minus' })[key]
    const windowsVirtualKeyCode = /[a-z0-9]/iu.test(key) ? key.toUpperCase().charCodeAt(0) :
      ({ '/': 191, '-': 189, ' ': 32, '.': 190, '_': 189 })[key]
    assert.ok(code && windowsVirtualKeyCode, 'Fixture reference has a qualified real typeahead key')
    for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode, text: key, unmodifiedText: key
    })
  }
  receipt.referenceInteractions ??= []
  receipt.referenceInteractions.push({ regionId, requested: value, before: indexes.current,
    observed: await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`) })
  await waitFor('actual chosen History reference', () => visibleRead(cdp, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`))
}
async function historyView(cdp, scope) {
  await activate(cdp)
  return await cdp.evaluate(`(() => { const root=document.querySelector(${JSON.stringify(scope)}),e=root?.querySelector('.git-history-scroll');if(!e||!e.getClientRects().length)return null;const rows=Array.from(e.querySelectorAll('[data-history-oid]'));return {range:root.querySelector('[aria-label="History reference"]')?.value,loaded:Number(/^(\\d+) commits/.exec(e.querySelector('.git-history-footer')?.textContent??'')?.[1]),scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,viewport:e.clientHeight,drawn:rows.length,graphNodes:e.querySelectorAll('.git-history-node').length,rows:rows.map(r=>({oid:r.dataset.historyOid,index:Number(r.dataset.historyIndex),selected:r.getAttribute('aria-current')})),edges:Array.from(e.querySelectorAll('[data-child-oid]')).map(p=>({child:p.dataset.childOid,parent:p.dataset.parentOid}))} })()`)
}
async function settledHistory(cdp, scope) {
  let last, stableSince = 0
  return await waitFor('visible completed History window', async () => {
    const view = await historyView(cdp, scope)
    const busy = await cdp.evaluate(`document.querySelector(${JSON.stringify(scope)})?.querySelector('.git-history-panel')?.getAttribute('aria-busy')`)
    if (!(view?.loaded > 0 && busy === 'false')) { last = undefined; return null }
    const key = JSON.stringify([view.range, view.loaded, view.scrollTop, view.scrollHeight, view.viewport])
    if (key !== last) { last = key; stableSince = Date.now(); return null }
    return Date.now() - stableSince >= 140 ? view : null
  })
}
async function narrowWidth(cdp, regionId) {
  const value = await cdp.evaluate(`(() => { const r=document.querySelector(${JSON.stringify(pane(regionId))}).getBoundingClientRect();return Math.ceil(innerWidth-r.width+320) })()`)
  return Math.max(500, value)
}
try {
  receipt.sourceRevision = (await exec('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(receipt.sourceRevision, expectedRevision)
  assert.equal((await exec('git', ['-C', repositoryRoot, 'status', '--porcelain=v1'])).stdout.trim(), '', 'Build and capture one committed, clean candidate')
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(workspacePath, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(physicalRuntimeDirectory, { recursive: true }), mkdir(artifacts, { recursive: true })])
  // macOS AF_UNIX addresses cannot hold the long evidence path. Only the addressing
  // alias lives in fixtureRoot/tmp; all Runtime files still belong to this round's private root.
  runtimeAliasRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-gr-"))
  privateRootAlias = join(runtimeAliasRoot, 'p')
  await symlink(root, privateRootAlias)
  // The actual socket parent remains a real directory, satisfying Core's owner check.
  runtimeDirectory = join(privateRootAlias, 'runtime')
  fixtureEnvironment.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
  receipt.runtimeAddress = { alias: runtimeDirectory, privateRootAlias, physical: physicalRuntimeDirectory }
  receipt.environment = { inheritedAgentMuxContextRemoved: true, agentSessionStore: fixtureEnvironment.AGENTMUX_AGENT_SESSION_STORE }
  receipt.identityBefore = await identity()
  const release = JSON.parse(await readFile(join(desktopRoot, 'out/renderer/release.json'), 'utf8'))
  const { sourceUpdateIdentity } = await import(pathToFileURL(join(desktopRoot, 'scripts/update-identity.mjs')))
  assert.deepEqual(release.identity, await sourceUpdateIdentity(repositoryRoot), 'Native shell/release inputs match the candidate')
  receipt.rendererRelease = { id: release.id, identity: release.identity }
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Private Author'); await git('config', 'user.email', 'private@example.invalid')
  await writeFile(join(workspacePath, 'old.ts'), 'retained original body\n'); await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 1, 2]))
  await git('add', '.'); await git('commit', '-m', 'Initial repository'); const rootOid = (await git('rev-parse', 'HEAD')).trim()
  for (let i = 0; i < 162; i++) await git('commit', '--allow-empty', '-m', `History ${String(i).padStart(2, '0')} · keep chronological context`)
  await git('checkout', '-b', 'feature/readable-history')
  await git('mv', 'old.ts', 'renamed.ts'); await writeFile(join(workspacePath, 'changed.ts'), 'fixed commit body\n'); await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 3, 4]))
  const longPath = 'nested/long-directory-for-fixed-commit-review/精确版本与只读审阅-long-file-name.ts'
  await mkdir(join(workspacePath, 'nested/long-directory-for-fixed-commit-review'), { recursive: true })
  await writeFile(join(workspacePath, longPath), 'long path fixed body\n')
  await git('add', '.'); await git('commit', '-m', 'Read complete commit files'); const featureOid = (await git('rev-parse', 'HEAD')).trim()
  await git('checkout', 'main'); await writeFile(join(workspacePath, 'main.ts'), 'main parent\n'); await git('add', '.'); await git('commit', '-m', 'Main parent')
  await git('merge', '--no-ff', 'feature/readable-history', '-m', 'Read commit context · 长标题保留准确对象与阅读位置 without opening a second History or another editor for every file\n\nFull message with a clear subject.\nThe original branch and history stay available while files open as fixed version diffs.')
  const mergeOid = (await git('rev-parse', 'HEAD')).trim(), parents = (await git('show', '-s', '--format=%P', 'HEAD')).trim().split(' ')
  await git('branch', 'topic/pure-branch'); await git('worktree', 'add', join(root, 'review-worktree'), 'feature/readable-history')
  await git('branch', 'topic/root-only', rootOid)
  await writeFile(join(workspacePath, 'changed.ts'), 'dirty worktree body must remain untouched\n')
  receipt.fixture = { rootOid, featureOid, mergeOid, parents, longPath }
  const fixedFiles = ['changed.ts', 'renamed.ts', 'binary.bin', 'main.ts', longPath]
  const gitState = async () => ({ head: (await git('rev-parse', 'HEAD')).trim(), status: await git('status', '--porcelain=v1'),
    index: digest(await readFile(join(workspacePath, '.git/index'))),
    files: Object.fromEntries(await Promise.all(fixedFiles.map(async path => [path, digest(await readFile(join(workspacePath, path)))]))) })
  const unchanged = await gitState()
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local' }], executors: {},
    workspaces: [{ id: workspaceId, name: workspaceName, hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { agentAutomation: false, toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  first = await launch('first'); phase = 'real-ui'
  await click(first.cdp, selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  await click(first.cdp, `${selectors('[role="tab"]')}.filter(e => e.textContent === 'History')`)
  const sidebar = '.source-control-history'
  const sidebarStart = await settledHistory(first.cdp, sidebar)
  await click(first.cdp, selectors(`${sidebar} [data-history-oid="${mergeOid}"] > strong`))
  const gitRegion = await waitFor('durable clicked fixed commit', async () => {
    const current = await state()
    return current.graph.regions.find(r => r.kind === 'git' && !current.graph.resources['region:' + r.regionId]?.history &&
      current.graph.resources['region:' + r.regionId]?.selection?.commitOid === mergeOid)
  })
  const commitPane = pane(gitRegion.regionId)
  // Assert the clicked action itself reveals the Region. space.focus here would mask a navigation bug.
  await waitFor('clicked commit is actually visible', () => visibleRead(first.cdp, `(() => { const e=document.querySelector(${JSON.stringify(commitPane)});return e?.getAttribute('aria-label')==='Git commit details'&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden' })()`))
  assert.equal(await first.cdp.evaluate(`document.querySelector(${JSON.stringify(commitPane)}).querySelectorAll('.git-history-panel').length`), 0)
  receipt.commitOnly = { regionId: gitRegion.regionId, embeddedHistoryPanels: 0, sidebarWindow: sidebarStart,
    boundary: 'DOM/navigation proof. Zero History I/O and render cost require the actual-owner qualification.' }
  receipt.loadedRenderer = await first.cdp.evaluate('Array.from(document.scripts).map(s=>s.src).filter(s=>s.startsWith("file:"))')
  assert.ok(receipt.loadedRenderer.length > 0)
  for (const url of receipt.loadedRenderer) assert.equal(digest(await readFile(fileURLToPath(url))), receipt.identityBefore[fileURLToPath(url).slice(repositoryRoot.length + 1)])
  await waitFor('complete fixed message and all real parents', () => visibleRead(first.cdp, `document.querySelector(${JSON.stringify(commitPane + ' .git-workbench__message')})?.textContent.includes('original branch and history')&&document.querySelector(${JSON.stringify(commitPane + ' .git-workbench__metadata')})?.textContent.includes(${JSON.stringify(parents[1])})`))
  await capture(first.cdp, 'commit-only-dark-wide')
  await capture(first.cdp, 'commit-only-light-narrow', await narrowWidth(first.cdp, gitRegion.regionId), 'light')

  const publicTarget = { workspaceId, expectedResource: { hostId: 'local', workspacePath } }
  receipt.publicCommit = await control('git.commit', { ...publicTarget, oid: mergeOid, parentOid: parents[0] })
  assert.equal(receipt.publicCommit.snapshot.commitOid, mergeOid)
  assert.ok(receipt.publicCommit.commit.message.includes('original branch and history'))
  receipt.publicDiff = await control('git.diff', { ...publicTarget, input: { kind: 'commit', snapshot: receipt.publicCommit.snapshot, file: { path: 'changed.ts', origPath: null } } })
  assert.equal(receipt.publicDiff.new.text, 'fixed commit body\n')
  receipt.cliCommitOpen = await cliOpen(mergeOid)
  assert.equal(receipt.cliCommitOpen.result.presentation.regionId, gitRegion.regionId)
  assert.equal(receipt.cliCommitOpen.result.read.snapshot.commitOid, mergeOid)
  const full = await open(mergeOid); assert.equal(full.presentation.regionId, gitRegion.regionId)
  const otherParent = await open(mergeOid, parents[1]); assert.notEqual(otherParent.presentation.regionId, gitRegion.regionId)
  receipt.parentOpens = { first: full, second: otherParent }
  await waitFor('chosen second-parent details', () => visibleRead(first.cdp, `document.querySelector(${JSON.stringify(pane(otherParent.presentation.regionId) + ' [aria-label="Comparison parent"]')})?.value===${JSON.stringify(parents[1])}&&Boolean(document.querySelector(${JSON.stringify(pane(otherParent.presentation.regionId) + ' [aria-label="Open diff for main.ts"]')}))`))
  await open(mergeOid, parents[0])
  const beforeInline = await state()
  await click(first.cdp, selectors(commitPane + ' [aria-label="Open diff for changed.ts"]'))
  receipt.canvas = await monaco(first.cdp, '', 'fixed commit body', gitRegion.regionId, true)
  const afterInline = await state()
  assert.deepEqual(afterInline.graph.regions.map(r => r.regionId), beforeInline.graph.regions.map(r => r.regionId))
  assert.equal(afterInline.graph.resources['region:' + gitRegion.regionId].file.path, 'changed.ts')
  receipt.inlineRegion = { regionId: gitRegion.regionId, regionsBefore: beforeInline.graph.regions.length,
    regionsAfter: afterInline.graph.regions.length, file: afterInline.graph.resources['region:' + gitRegion.regionId].file }
  const editor = await first.cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(commitPane + ' .editor.modified textarea')});if(!e)return false;e.focus();return true })()`)
  assert.ok(editor, 'Actual inline Monaco modified input exists')
  await first.cdp.call('Input.insertText', { text: 'UNAUTHORIZED EDIT MUST NOT APPEAR' })
  receipt.readonlyCanvas = await monaco(first.cdp, '', 'fixed commit body', gitRegion.regionId, true)
  await capture(first.cdp, 'inline-diff-dark-wide')
  await click(first.cdp, selectors(commitPane + ` [aria-label="Open diff for ${longPath}"]`))
  await monaco(first.cdp, '', 'long path fixed body', gitRegion.regionId, true)
  assert.equal((await state()).graph.regions.length, beforeInline.graph.regions.length)
  await capture(first.cdp, 'inline-diff-light-narrow', await narrowWidth(first.cdp, gitRegion.regionId), 'light')
  await click(first.cdp, selectors(commitPane + ' [aria-label="Open diff for changed.ts"]'))
  await monaco(first.cdp, '', 'fixed commit body', gitRegion.regionId, true)

  // Only the explicit repository action opens History; it does not select the first row.
  await click(first.cdp, selectors(commitPane + ' [aria-label="View repository history"]'))
  const repositoryRegion = await waitFor('explicit repository Region', async () => {
    const current = await state()
    return current.graph.regions.find(r => r.kind === 'git' && current.graph.resources['region:' + r.regionId]?.history)
  })
  const repositoryPane = pane(repositoryRegion.regionId)
  await waitFor('repository action reveals one main History and a sidebar summary', () => visibleRead(first.cdp, `(() => {const e=document.querySelector(${JSON.stringify(repositoryPane)});return e?.getAttribute('aria-label')==='Git repository history'&&e.getClientRects().length&&Boolean(document.querySelector('.git-history-expanded'))&&document.querySelectorAll('.source-control-history [data-history-oid]').length===0})()`))
  assert.equal((await state()).graph.resources['region:' + repositoryRegion.regionId].selection, null)
  const transferred = await settledHistory(first.cdp, repositoryPane)
  // A taller receiving viewport may legitimately prefetch one more page of the SAME window.
  assert.ok(transferred.loaded >= sidebarStart.loaded); assert.equal(transferred.range, sidebarStart.range)
  receipt.cliRepositoryOpen = await cliOpen()
  assert.equal(receipt.cliRepositoryOpen.result.presentation.regionId, repositoryRegion.regionId)
  assert.deepEqual(Object.keys(receipt.cliRepositoryOpen.result.read.snapshot).sort(), ['hostId', 'repoPath'])
  await capture(first.cdp, 'repository-history-dark-wide')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/main')
  const initial = await settledHistory(first.cdp, repositoryPane)
  const point = await first.cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(repositoryPane + ' .git-history-scroll')}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,delta:e.scrollHeight-e.clientHeight-Math.max(e.clientHeight,192)+24-e.scrollTop}})()`)
  assert.ok(point.delta > 0, 'Stable initial window permits a real forward wheel before the original edge')
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: point.delta })
  await waitFor('automatic prefetch before end', async () => { const v = await historyView(first.cdp, repositoryPane); return v?.loaded > initial.loaded ? v : null })
  const appended = await settledHistory(first.cdp, repositoryPane)
  receipt.autoload = { before: initial.loaded, after: appended.loaded, scrollTop: appended.scrollTop, viewport: appended.viewport,
    originalScrollHeight: initial.scrollHeight, originalPageRemaining: initial.scrollHeight - appended.scrollTop - appended.viewport,
    drawn: appended.drawn, graphNodes: appended.graphNodes }
  assert.ok(receipt.autoload.originalPageRemaining > 0, 'Prefetch occurs before the ORIGINAL page edge')
  assert.equal(appended.drawn, appended.graphNodes); assert.ok(appended.drawn < appended.loaded, 'Actual rows and SVG nodes are windowed')
  const parentMap = new Map((await git('log', '--all', '--format=%H %P')).trim().split('\n').map(line => { const [oid, ...parents] = line.split(' '); return [oid, parents] }))
  for (const edge of appended.edges) assert.ok(parentMap.get(edge.child)?.includes(edge.parent), 'Drawn edge names a real parent')
  await capture(first.cdp, 'history-window-dark-scrolled')
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Move history to sidebar"]'))
  const returned = await settledHistory(first.cdp, sidebar)
  receipt.handoff = { initial: transferred, expanded: appended, sidebar: returned }
  assert.ok(returned.loaded >= appended.loaded); assert.equal(returned.range, appended.range); assert.ok(Math.abs(returned.scrollTop - appended.scrollTop) <= 1)
  await click(first.cdp, selectors(sidebar + ' [aria-label="Open repository history"]'))
  const reexpanded = await settledHistory(first.cdp, repositoryPane)
  receipt.handoff.reexpanded = reexpanded
  assert.ok(reexpanded.loaded >= returned.loaded); assert.equal(reexpanded.range, returned.range); assert.ok(Math.abs(reexpanded.scrollTop - returned.scrollTop) <= 1)

  // Leave the ordinary prefetch threshold before checking Locate's explicit-page behavior.
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -reexpanded.scrollTop })
  await waitFor('History returned to top', async () => (await historyView(first.cdp, repositoryPane))?.scrollTop === 0)
  const unloaded = await settledHistory(first.cdp, repositoryPane)
  assert.ok(unloaded.loaded < 166, 'The fixture still contains an unread older target')
  const oldTarget = await open(rootOid)
  await waitFor('root commit has no invented parent', () => visibleRead(first.cdp, `document.querySelector(${JSON.stringify(pane(oldTarget.presentation.regionId) + ' .git-workbench__comparison')})?.textContent.includes('Empty tree')`))
  await click(first.cdp, selectors(pane(oldTarget.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('unloaded target stated without unbounded reads', () => visibleRead(first.cdp, `document.querySelector(${JSON.stringify(repositoryPane + ' .git-workbench__locating')})?.textContent.includes('not been loaded')`))
  await delay(350)
  assert.equal((await settledHistory(first.cdp, repositoryPane)).loaded, unloaded.loaded, 'Locate alone must not exhaust unread history')
  for (let page = 0; page < 4; page++) {
    if (await first.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(repositoryPane + ' [data-history-oid="' + rootOid + '"]')}))`)) break
    const prior = await settledHistory(first.cdp, repositoryPane)
    await click(first.cdp, `${selectors(repositoryPane + ' .git-workbench__locating button')}.filter(e=>e.textContent==='Read next history page')`)
    const next = await waitFor('one explicitly requested locating page', async () => { const v = await historyView(first.cdp, repositoryPane); return v?.loaded > prior.loaded ? v : null })
    assert.ok(next.loaded - prior.loaded <= 100, 'One explicit locate action reads a bounded page')
  }
  await waitFor('older fixed OID revealed in the virtual viewport', () => visibleRead(first.cdp, `(() => {const row=document.querySelector(${JSON.stringify(repositoryPane + ' [data-history-oid="' + rootOid + '"]')}),scroll=document.querySelector(${JSON.stringify(repositoryPane + ' .git-history-scroll')});if(!row||!scroll)return false;const r=row.getBoundingClientRect(),s=scroll.getBoundingClientRect();return r.top>=s.top&&r.bottom<=s.bottom})()`))
  receipt.olderLocation = await settledHistory(first.cdp, repositoryPane)
  await capture(first.cdp, 'older-commit-located-dark')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/topic/root-only')
  await settledHistory(first.cdp, repositoryPane)
  const outside = await open(parents[0])
  await click(first.cdp, selectors(pane(outside.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('outside range is distinct from unloaded', () => visibleRead(first.cdp, `document.querySelector(${JSON.stringify(repositoryPane + ' .git-workbench__locating')})?.textContent.includes('outside the current history range')`))
  receipt.outsideLocation = await waitFor('outside target details and actual durable selection agree', async () => {
    const durable = (await state()).graph.resources['region:' + repositoryRegion.regionId]
    const details = await visibleRead(first.cdp, `(() => {const e=document.querySelector(${JSON.stringify(repositoryPane + ' .git-workbench__details')});return e&&e.getAttribute('aria-busy')==='false'?{oids:Array.from(e.querySelectorAll('.git-workbench__metadata code')).map(c=>c.textContent),parentOid:e.querySelector('[aria-label="Comparison parent"]')?.value}:null})()`)
    return durable?.selection?.commitOid === parents[0] && durable.selection.parentOid === outside.read.snapshot.parentOid &&
      durable.history?.reference === 'refs/heads/topic/root-only' && durable.history.focusOid === parents[0] &&
      details?.oids.includes(parents[0]) && details.parentOid === outside.read.snapshot.parentOid ? { durable, details } : null
  })
  assert.equal((await historyView(first.cdp, repositoryPane)).range, 'refs/heads/topic/root-only')
  assert.equal((await state()).graph.resources['region:' + repositoryRegion.regionId].selection.commitOid, parents[0])
  await capture(first.cdp, 'locate-outside-retained-light', 1280, 'light')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/main')
  await settledHistory(first.cdp, repositoryPane)
  await click(first.cdp, selectors(repositoryPane + ` [data-history-oid="${mergeOid}"] > strong`))
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for changed.ts"]'))
  await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  await click(first.cdp, `${selectors('[role="tab"]')}.filter(e=>e.textContent==='Branches')`)
  receipt.publicRepositoryOpen = await open()
  assert.equal(receipt.publicRepositoryOpen.presentation.regionId, repositoryRegion.regionId)
  assert.equal(await first.cdp.evaluate(`Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).some(e=>e.textContent==='Branches')`), true, 'Repository navigation preserves the prior sidebar choice')

  // A new Diff Region requires this explicit separate-open action, after the inline assertion.
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff in separate tab"]'))
  const fixed = await waitFor('explicit independent fixed Diff', async () => {
    const current = await state(); return current.graph.regions.find(r => r.kind === 'git-diff' && current.graph.resources['region:' + r.regionId]?.comparison?.kind === 'commit')
  })
  await monaco(first.cdp, '', 'fixed commit body', fixed.regionId)
  await click(first.cdp, selectors(`button.workbench-tab[data-workbench-tab-id="${fixed.tabId}"]`), 'right')
  await waitFor('move Tab submenu', () => visibleRead(first.cdp, `(() => {const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.includes('Move Tab to New Group'));if(!e)return false;e.focus();return document.activeElement===e})()`))
  await press(first.cdp, 'ArrowRight')
  receipt.tabMoveMenu = await first.cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).filter(e=>e.getClientRects().length).map(e=>e.textContent)`)
  await click(first.cdp, `${selectors('[role="menuitem"]')}.filter(e=>e.textContent==='New Group Right')`)
  const splitState = await waitFor('durable split from actual Tab menu', async () => { const current = await state(); return current.graph.layouts[workspaceId]?.groups.length === 2 ? current : null })
  assert.equal(splitState.graph.layouts[workspaceId].root.type, 'split')
  const originalState = await state(); receipt.originalState = originalState
  assert.deepEqual(await gitState(), unchanged, 'Every UI/public read retained HEAD, index and exact dirty file bytes')
  receipt.gitPreservation = { before: unchanged, after: await gitState() }
  receipt.firstExit = await normalQuit(first)
  await git('branch', '-f', 'topic/pure-branch', rootOid)
  await git('update-ref', 'refs/heads/main', rootOid, mergeOid)
  const moved = await gitState(); assert.equal(moved.head, rootOid)
  receipt.intentionalRefMove = { from: mergeOid, to: rootOid, baseline: moved }
  second = await launch('second'); phase = 'real-restart'
  const restored = await waitFor('original Git Region after ordinary restart', async () => {
    const current = await state(); return current.graph.regions.some(r => r.regionId === repositoryRegion.regionId) ? current : null
  })
  assert.deepEqual(restored, originalState)
  await focused(second.cdp, repositoryRegion.regionId)
  await waitFor('same selected fixed commit reread', () => visibleRead(second.cdp, `document.querySelector(${JSON.stringify(repositoryPane + ' .git-workbench__target')})?.textContent.includes(${JSON.stringify(mergeOid.slice(0,12))})`))
  receipt.restoredInlineCanvas = await monaco(second.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  assert.equal(restored.graph.resources['region:' + repositoryRegion.regionId].history.reference, 'refs/heads/main')
  assert.equal(restored.graph.resources['region:' + repositoryRegion.regionId].file.path, 'changed.ts')
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: fixed.regionId } })
  receipt.restoredCanvas = await monaco(second.cdp, '', 'fixed commit body', fixed.regionId)
  await capture(second.cdp, 'restored-inline-and-explicit-diff-dark', 1600)
  assert.deepEqual(await gitState(), moved, 'Restored reads preserve intentionally moved HEAD and original dirty files')
  receipt.secondExit = await normalQuit(second)
  receipt.identityAfter = await identity(); assert.deepEqual(receipt.identityAfter, receipt.identityBefore)
  receipt.passed = true
} catch (error) {
  failure = { phase, message: error.message, stack: error.stack }; receipt.failure = failure
  const active = second ?? first
  if (active) { try {
    receipt.failureVisibility = await active.cdp.evaluate('({visibility:document.visibilityState,documentFocused:document.hasFocus()})')
    receipt.failureNative = await active.main.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; return {visible:w.isVisible(),focused:w.isFocused()} })()`)
    receipt.failureSpatialState = await state()
    receipt.failureDom = await active.cdp.evaluate('document.body.innerText.slice(-6000)'); receipt.failureLayout=await active.cdp.evaluate(`Array.from(document.querySelectorAll('.git-branch-diff,.git-branch-diff > *,.monaco-diff-editor')).map(e=>({classes:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,display:getComputedStyle(e).display,gridRows:getComputedStyle(e).gridTemplateRows}))`); await capture(active.cdp, 'failure')
  } catch {} }
} finally {
  const errors = []
  for (const probe of [second, first]) if (probe && probe.child.exitCode === null && probe.child.signalCode === null) { try { await normalQuit(probe) } catch (error) { errors.push(error.message) } }
  for (const connection of connections) try { connection.close() } catch {}
  for (const child of children) if (child.pid > 1) { try { await stopProbeProcesses(child.pid, root) } catch (error) { errors.push(error.message) } }
  const sentinel = process.pid + 1_000_000_000
  try { await stopProbeProcesses(sentinel, root); assert.deepEqual(await listProbeProcesses(sentinel, root), []) } catch (error) { errors.push(error.message) }
  if (runtimeAliasRoot) {
    try {
      await stopProbeProcesses(sentinel, runtimeAliasRoot)
      assert.deepEqual(await listProbeProcesses(sentinel, runtimeAliasRoot), [])
      assert.equal(await readlink(privateRootAlias), root, 'Only remove this round\'s verified private-root alias')
      await rm(privateRootAlias)
      await rmdir(runtimeAliasRoot)
    } catch (error) { errors.push(error.message) }
  }
  if (!errors.length) await rm(root, { recursive: true, force: true })
  receipt.cleanup = { errors, temporaryRootRemoved: errors.length === 0 }
  receipt.passed &&= errors.length === 0
}
await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, failure: receipt.failure ?? null, screenshots: receipt.screenshots.length, artifacts, cleanup: receipt.cleanup }) + '\n')
process.exitCode = receipt.passed ? 0 : 1
