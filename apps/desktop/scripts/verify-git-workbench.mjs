import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// A private built Desktop, real Git and public RPC; no Store mutation, replacement bridge or storage seed.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/public-rpc-client.js')))
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-git-workbench-"))
const artifacts = join(repositoryRoot, '.tmp/git-workbench-last')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), runtimeDirectory = join(root, 'runtime')
const workspacePath = join(root, 'repository'), codexHome = join(privateHome, 'codex')
const workspaceId = 'private-git-workbench', workspaceName = 'Repository'
const children = new Set(), connections = new Set()
const deadline = Date.now() + 240_000
const receipt = { schema: 'agentmux.git-workbench.v1', passed: false, screenshots: [], cleanup: {} }
let phase = 'prepare', failure, first, second
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(runtimeDirectory, 'state/spatial-state.json'), CODEX_HOME: codexHome }
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
    env: { ...process.env, ...fixtureEnvironment, ELECTRON_RUN_AS_NODE: undefined, AGENTMUX_DESKTOP_READY_FILE: readyFile }
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
  await waitFor(`${label} trusted UI`, () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".project-list"))'))
  await activate(cdp)
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  return { child, main, cdp }
}
async function click(cdp, expression, button = 'left') {
  await activate(cdp)
  const point = await waitFor('exact visible UI control', () => cdp.evaluate(`(() => { const matches = ${expression}; if (matches.length !== 1) return null; const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null; element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const selectors = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function monaco(cdp, original, modified, regionId) {
  // Monaco deliberately switches to inline at narrow split widths. Verify its actual rendered
  // presentation, retaining exact separate-side checks whenever both sides are displayed.
  return waitFor('visible readonly Monaco canvas and content', () => cdp.evaluate(`(() => { const pane = ${regionId ? `document.querySelector('[data-git-diff-region="${regionId}"]')` : `Array.from(document.querySelectorAll('.git-branch-diff')).find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`}; if (!pane || getComputedStyle(pane).visibility === 'hidden') return null; const canvas=pane.querySelector('.monaco-diff-editor');if(!canvas)return null; const rect=canvas.getBoundingClientRect();if(rect.width<80||rect.height<80)return null; const read = side => canvas.querySelector('.editor.'+side+' .view-lines')?.innerText.replace(/\u00a0/g,' ').trim(); const left=read('original'),right=read('modified');const presentation=canvas.classList.contains('side-by-side')?'side-by-side':'inline';const displayedLines=Array.from(canvas.querySelectorAll('.view-lines')).flatMap(e=>e.innerText.replace(/\u00a0/g,' ').split('\\n').map(line=>line.trim()).filter(Boolean));const valid=presentation==='side-by-side'?left===${JSON.stringify(original)}&&right===${JSON.stringify(modified)}:(${JSON.stringify(original)} === "" || displayedLines.includes(${JSON.stringify(original)})) && (${JSON.stringify(modified)} === "" || displayedLines.includes(${JSON.stringify(modified)}));return valid?{presentation,original:left,modified:right,displayedLines,viewportWidth:rect.width,viewportHeight:rect.height,canvases:pane.querySelectorAll('.monaco-diff-editor').length}:null })()`))
}
async function control(method, params) {
  /** @type {import('../../../packages/core/dist/public-rpc-client.js').AgentMuxRpcClient} */
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  try { return await rpc.call(method, params) }
  finally { await rpc.dispose() }
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
  await cdp.nativeMain.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); e.app.focus({steal: true}); return w.isVisible() })()`)
  await cdp.call('Page.bringToFront')
  await waitFor('actual visible and focused document', () => cdp.evaluate('document.visibilityState === "visible" && document.hasFocus()'))
  const native = await cdp.nativeMain.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; return {visible:w.isVisible(),focused:w.isFocused()} })()`)
  assert.deepEqual(native, {visible:true,focused:true})
  return {...native, ...await cdp.evaluate('({visibility:document.visibilityState,documentFocused:document.hasFocus()})')}
}
async function capture(cdp, name, width = 1280, theme = 'dark') {
  const focus = await activate(cdp)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`document.documentElement.dataset.appearance = ${JSON.stringify(theme)}`)
  await delay(250)
  receipt.visibility ??= []; receipt.visibility.push({ name, ...focus })
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(artifacts, name + '.png'); await writeFile(path, Buffer.from(data, 'base64'))
  receipt.screenshots.push({ path, width, theme, sha256: digest(Buffer.from(data, 'base64')) })
}
async function state() { return (await control('space.state', {})).state }
async function identity() {
  const paths = ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/release.json',
    'apps/desktop/src/renderer/src/components/BranchesPanel.tsx',
    'apps/desktop/src/renderer/src/components/GitBranchDiffPane.tsx',
    'apps/desktop/src/renderer/src/styles/git-workbench.css',
    'apps/desktop/src/renderer/src/styles/source-control.css',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GitWorkbenchPane.tsx',
    'apps/desktop/src/renderer/src/components/GitHistoryPanel.tsx', 'apps/desktop/src/renderer/src/hooks/useGitHistory.ts',
    'packages/git/src/git-repository.ts', 'packages/git/dist/git-repository.js', 'packages/git/package.json',
    'packages/git/src/types.ts', 'packages/git/dist/types.d.ts', 'packages/core/package.json',
    'packages/core/dist/public-rpc-service.js', 'packages/core/dist/public-rpc-git.js',
    'packages/core/dist/agentmux-cli-commands.js', 'packages/core/src/hosted-value.ts', 'packages/core/dist/hosted-value.js',
    'apps/desktop/src/main/git-public-control.ts',
    'apps/desktop/out/renderer/index.html']
  async function bundles(directory) {
    for (const entry of await readdir(join(repositoryRoot, directory), {withFileTypes:true})) {
      const path = directory + '/' + entry.name
      if (entry.isDirectory()) await bundles(path)
      else if (/\.(?:js|css|json)$/.test(entry.name)) paths.push(path)
    }
  }
  await bundles('apps/desktop/out/renderer/assets')
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(repositoryRoot, path)))])))
}
async function open(oid, parentOid) {
  return await control('git.open', { workspaceId, expectedResource: { hostId: 'local', workspacePath }, oid, ...(parentOid ? { parentOid } : {}) })
}
async function focused(cdp, regionId) {
  await activate(cdp)
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId } })
  return await waitFor('original Git Region visible', () => cdp.evaluate(`(() => { const e = document.querySelector('[data-git-workbench-region="${regionId}"]'); return e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' })()`))
}
async function type(cdp, selector, value) {
  const selected = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); return true })()`)
  assert.equal(selected, true); await cdp.call('Input.insertText', { text: value })
}
try {
  receipt.sourceRevision = (await exec('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(workspacePath, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(runtimeDirectory, { recursive: true }), mkdir(artifacts, { recursive: true })])
  receipt.identityBefore = await identity()
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Private Author'); await git('config', 'user.email', 'private@example.invalid')
  await writeFile(join(workspacePath, 'old.ts'), 'retained original body\n'); await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 1, 2]))
  await git('add', '.'); await git('commit', '-m', 'Initial repository'); const rootOid = (await git('rev-parse', 'HEAD')).trim()
  for (let i = 0; i < 162; i++) await git('commit', '--allow-empty', '-m', `History ${String(i).padStart(2, '0')} · keep chronological context`)
  await git('checkout', '-b', 'feature/readable-history')
  await git('mv', 'old.ts', 'renamed.ts'); await writeFile(join(workspacePath, 'changed.ts'), 'fixed commit body\n'); await writeFile(join(workspacePath, 'binary.bin'), Buffer.from([0, 3, 4]))
  await git('add', '.'); await git('commit', '-m', 'Read complete commit files'); const featureOid = (await git('rev-parse', 'HEAD')).trim()
  await git('checkout', 'main'); await writeFile(join(workspacePath, 'main.ts'), 'main parent\n'); await git('add', '.'); await git('commit', '-m', 'Main parent')
  await git('merge', '--no-ff', 'feature/readable-history', '-m', 'Read commit context in a dedicated workbench\n\nFull message with a clear subject.\nThe original branch and history stay available while files open as fixed version diffs.')
  const mergeOid = (await git('rev-parse', 'HEAD')).trim(), parents = (await git('show', '-s', '--format=%P', 'HEAD')).trim().split(' ')
  await git('branch', 'topic/pure-branch'); await git('worktree', 'add', join(root, 'review-worktree'), 'feature/readable-history')
  await writeFile(join(workspacePath, 'changed.ts'), 'dirty worktree body must remain untouched\n')
  receipt.fixture = { rootOid, featureOid, mergeOid, parents }
  const unchanged = { head: (await git('rev-parse', 'HEAD')).trim(), status: await git('status', '--porcelain=v1'), index: digest(await readFile(join(workspacePath, '.git/index'))) }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local' }], executors: {},
    workspaces: [{ id: workspaceId, name: workspaceName, hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { agentAutomation: false, toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  first = await launch('first'); phase = 'real-ui'
  await click(first.cdp, selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  await click(first.cdp, `${selectors('[role="tab"]')}.filter(e => e.textContent === 'Branches')`)
  await waitFor('actual branch facts', () => first.cdp.evaluate('document.querySelectorAll(".branch-row__open").length === 3'))
  await capture(first.cdp, 'branches-dark-wide')
  await type(first.cdp, '[aria-label="Find branch or worktree path"]', 'readable')
  await waitFor('branch filter consumes original snapshot', () => first.cdp.evaluate('document.querySelectorAll(".branch-row__open").length === 1'))
  await capture(first.cdp, 'branches-light-filter', 900, 'light')
  await click(first.cdp, selectors('[aria-label="Clear branch search and filter"]'))
  await type(first.cdp, '[aria-label="Find branch or worktree path"]', 'no-match-at-all')
  await waitFor('actual empty branch search', () => first.cdp.evaluate('Boolean(document.querySelector(".branches-empty"))'))
  await capture(first.cdp, 'branches-dark-empty', 800)
  await click(first.cdp, selectors('[aria-label="Clear branch search and filter"]'))
  await click(first.cdp, `${selectors('[role="tab"]')}.filter(e => e.textContent === 'History')`)
  await waitFor('actual history rows', () => first.cdp.evaluate('document.querySelectorAll(".source-control-history .git-history-commit").length >= 50'))
  await click(first.cdp, `${selectors('.source-control-history [data-history-oid]')}.filter(e => e.dataset.historyOid === ${JSON.stringify(mergeOid)})`)
  const gitRegion = await waitFor('durable Git selection from clicked history', async () => {
    const current = await state(); return current.graph.regions.find(region => region.kind === 'git' && current.graph.resources['region:' + region.regionId]?.selection?.commitOid === mergeOid)
  })
  // The row action itself must reveal the new Region; an explicit space.focus would mask a navigation bug.
  await waitFor('clicked Git Region actually visible', () => first.cdp.evaluate(`(() => { const e = document.querySelector('[data-git-workbench-region="${gitRegion.regionId}"]'); return e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' })()`))
  await activate(first.cdp)
  await waitFor('visible workbench history loaded', () => first.cdp.evaluate('document.querySelectorAll(".git-workbench__history [data-history-oid]").length >= 50'))
  receipt.loadedRenderer = await first.cdp.evaluate('Array.from(document.scripts).map(script=>script.src).filter(src=>src.startsWith("file:"))')
  assert.ok(receipt.loadedRenderer.length > 0)
  for (const url of receipt.loadedRenderer) assert.equal(digest(await readFile(fileURLToPath(url))), receipt.identityBefore[fileURLToPath(url).slice(repositoryRoot.length+1)])
  await waitFor('full merge message and all parents', () => first.cdp.evaluate(`document.querySelector('.git-workbench__message')?.textContent.includes('original branch and history') && document.querySelector('.git-workbench__metadata')?.textContent.includes(${JSON.stringify(parents[1])})`))
  await capture(first.cdp, 'commit-dark-wide')
  await capture(first.cdp, 'commit-light-wide', 1280, 'light')
  await capture(first.cdp, 'commit-dark-narrow', 850)
  const publicTarget = {workspaceId, expectedResource:{hostId:'local',workspacePath}}
  receipt.publicCommit = await control('git.commit', {...publicTarget,oid:mergeOid,parentOid:parents[0]})
  assert.equal(receipt.publicCommit.snapshot.commitOid, mergeOid)
  assert.ok(receipt.publicCommit.commit.message.includes('original branch and history'))
  receipt.publicDiff = await control('git.diff', {...publicTarget,input:{kind:'commit',snapshot:receipt.publicCommit.snapshot,file:{path:'changed.ts',origPath:null}}})
  assert.equal(receipt.publicDiff.new.text, 'fixed commit body\n')
  const full = await open(mergeOid); assert.equal(full.presentation.regionId, gitRegion.regionId)
  const changed = await open(mergeOid, parents[1]); assert.equal(changed.presentation.regionId, gitRegion.regionId)
  await waitFor('chosen second parent real files', () => first.cdp.evaluate(`document.querySelector('select[aria-label="Comparison parent"]')?.value === ${JSON.stringify(parents[1])} && Boolean(document.querySelector('[aria-label="Open diff for main.ts"]'))`))
  await open(mergeOid, parents[0]); await waitFor('first parent files', () => first.cdp.evaluate('Boolean(document.querySelector(' + JSON.stringify('[aria-label="Open diff for changed.ts"]') + '))'))
  // Root commit has no synthetic parent and compares against the empty tree.
  await open(rootOid); await waitFor('root commit empty tree', () => first.cdp.evaluate('document.querySelector(".git-workbench__comparison")?.textContent.includes("Empty tree")'))
  await open(mergeOid, parents[0]); await waitFor('fixed file ready', () => first.cdp.evaluate('Boolean(document.querySelector(' + JSON.stringify('[aria-label="Open diff for changed.ts"]') + '))'))
  await click(first.cdp, selectors('[aria-label="Open diff for changed.ts"]'))
  const fixed = await waitFor('actual fixed commit Diff and Monaco', async () => {
    const current = await state(); return current.graph.regions.find(region => region.kind === 'git-diff' && current.graph.resources['region:' + region.regionId]?.comparison?.kind === 'commit')
  })
  receipt.canvas = await monaco(first.cdp, '', 'fixed commit body', fixed.regionId)
  const editor = await first.cdp.evaluate(`(() => { const e = document.querySelector('[data-git-diff-region="${fixed.regionId}"] .editor.modified textarea'); if (!e) return false; e.focus(); return true })()`)
  assert.ok(editor, 'Actual Monaco modified input is present')
  await first.cdp.call('Input.insertText', {text:'UNAUTHORIZED EDIT MUST NOT APPEAR'})
  receipt.readonlyCanvas = await monaco(first.cdp, '', 'fixed commit body', fixed.regionId)
  await capture(first.cdp, 'diff-dark-narrow', 850)
  await focused(first.cdp, gitRegion.regionId)
  // Enter the original scroll owner through an actual wheel event before the final viewport edge.
  const before = await first.cdp.evaluate('document.querySelector(".git-workbench__history .git-history-commits").children.length')
  const point = await first.cdp.evaluate('(() => { const e = document.querySelector(".git-workbench__history .git-history-scroll"); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: e.clientHeight, originalScrollHeight:e.scrollHeight, delta: e.scrollHeight - e.clientHeight - Math.max(e.clientHeight, 192) + 24 - e.scrollTop } })()')
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: point.delta })
  receipt.autoload = await waitFor('automatic prefetch before end', () => first.cdp.evaluate(`(() => { const e = document.querySelector('.git-workbench__history .git-history-scroll'); const count = e?.querySelectorAll('[data-history-oid]').length; return count > ${before} ? { before: ${before}, after: count, scrollTop: e.scrollTop, viewport: e.clientHeight, remaining: e.scrollHeight-e.scrollTop-e.clientHeight } : null })()`))
  receipt.autoload.originalScrollHeight = point.originalScrollHeight
  receipt.autoload.originalPageRemaining = point.originalScrollHeight - receipt.autoload.scrollTop - receipt.autoload.viewport
  assert.ok(receipt.autoload.originalPageRemaining > 0, 'Prefetch must happen before the ORIGINAL page edge, regardless of appended height')
  await capture(first.cdp, 'commit-dark-scrolled')
  // Use the real Tab menu to retain a nontrivial split layout across the two ordinary processes.
  await click(first.cdp, selectors(`[data-workbench-tab-id="${fixed.tabId}"]`), 'right')
  await waitFor('move Tab submenu', () => first.cdp.evaluate(`(() => { const e = Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent.includes('Move Tab to New Group')); if (!e) return false; e.focus(); return document.activeElement === e })()`))
  await first.cdp.call('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowRight',code:'ArrowRight'})
  await first.cdp.call('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight'})
  await click(first.cdp, `${selectors('[role="menuitem"]')}.filter(e => e.textContent === 'New Group Right')`)
  const splitState = await waitFor('durable split from real Tab menu', async () => { const current = await state(); return current.graph.layouts[workspaceId]?.groups.length === 2 ? current : null })
  assert.equal(splitState.graph.layouts[workspaceId].root.type, 'split')
  const originalState = await state(); receipt.originalState = originalState
  const gitState = async () => ({ head:(await git('rev-parse','HEAD')).trim(), status:await git('status','--porcelain=v1'), index:digest(await readFile(join(workspacePath,'.git/index'))) })
  assert.deepEqual(await gitState(), unchanged, 'Every UI and public read retained HEAD, index and dirty worktree')
  receipt.firstExit = await normalQuit(first)
  await git('branch', '-f', 'topic/pure-branch', rootOid)
  await git('update-ref', 'refs/heads/main', rootOid, mergeOid)
  const moved = await gitState(); assert.equal(moved.head, rootOid)
  receipt.intentionalRefMove = {from:mergeOid,to:rootOid,baseline:moved}
  second = await launch('second'); phase = 'real-restart'
  const restored = await waitFor('original Git Region after process restart', async () => {
    const current = await state(); return current.graph.regions.some(region => region.regionId === gitRegion.regionId) ? current : null
  })
  assert.deepEqual(restored, originalState)
  await focused(second.cdp, gitRegion.regionId)
  await waitFor('same fixed commit reread', () => second.cdp.evaluate(`document.querySelector('.git-workbench__target')?.textContent.includes(${JSON.stringify(mergeOid.slice(0, 12))})`))
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: fixed.regionId } })
  receipt.restoredCanvas = await monaco(second.cdp, '', 'fixed commit body', fixed.regionId)
  await capture(second.cdp, 'restored-diff-dark-wide', 1600)
  assert.deepEqual(await gitState(), moved, 'Restored fixed reads retain the intentionally moved HEAD and original dirty worktree')
  receipt.secondExit = await normalQuit(second)
  receipt.identityAfter = await identity(); assert.deepEqual(receipt.identityAfter, receipt.identityBefore)
  receipt.passed = true
} catch (error) {
  failure = { phase, message: error.message, stack: error.stack }; receipt.failure = failure
  const active = second ?? first
  if (active) { try { receipt.failureDom = await active.cdp.evaluate('document.body.innerText.slice(-6000)'); receipt.failureLayout=await active.cdp.evaluate(`Array.from(document.querySelectorAll('.git-branch-diff,.git-branch-diff > *,.monaco-diff-editor')).map(e=>({classes:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,display:getComputedStyle(e).display,gridRows:getComputedStyle(e).gridTemplateRows}))`); await capture(active.cdp, 'failure') } catch {} }
} finally {
  const errors = []
  for (const probe of [second, first]) if (probe && probe.child.exitCode === null && probe.child.signalCode === null) { try { await normalQuit(probe) } catch (error) { errors.push(error.message) } }
  for (const connection of connections) try { connection.close() } catch {}
  for (const child of children) if (child.pid > 1) { try { await stopProbeProcesses(child.pid, root) } catch (error) { errors.push(error.message) } }
  const sentinel = process.pid + 1_000_000_000
  try { await stopProbeProcesses(sentinel, root); assert.deepEqual(await listProbeProcesses(sentinel, root), []) } catch (error) { errors.push(error.message) }
  if (!errors.length) await rm(root, { recursive: true, force: true })
  receipt.cleanup = { errors, temporaryRootRemoved: errors.length === 0 }
  receipt.passed &&= errors.length === 0
}
await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, failure: receipt.failure ?? null, screenshots: receipt.screenshots.length, artifacts, cleanup: receipt.cleanup }) + '\n')
process.exitCode = receipt.passed ? 0 : 1
