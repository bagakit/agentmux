import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// A private built Desktop, real Git, public CLI/RPC and actual UI; no Store/bridge/storage seed.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const digest = value => createHash('sha256').update(value).digest('hex')
const sourceRoots = ['apps', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.base.json', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts', '.npmrc']
const excludedSourceDirectories = new Set(['node_modules', 'dist', 'out', 'coverage', 'target',
  '.git', '.bagakit', '.tmp', '.local', '.cache', '.vite', '.turbo', '.worktrees', '.claude',
  '.codex-output', 'test-results', 'playwright-report', '__pycache__'])
const generatedSourcePaths = ['apps/desktop/release', 'apps/desktop/resources/bin',
  'apps/desktop/resources/icon.png', 'apps/desktop/resources/icon-128.png', 'apps/desktop/resources/icon.icns']
function isSourcePath(path) {
  return sourceRoots.some(rootPath => path === rootPath || path.startsWith(rootPath + '/')) &&
    !path.split('/').some(part => excludedSourceDirectories.has(part)) &&
    !generatedSourcePaths.some(output => path === output || path.startsWith(output + '/')) &&
    !/(?:\.tsbuildinfo|\.log|\.pyc)$/u.test(path) && !path.endsWith('/.DS_Store')
}
async function sourceManifest() {
  const files = {}
  async function visit(path) {
    if (!isSourcePath(path)) return
    const fullPath = join(repositoryRoot, path)
    let stat
    try { stat = await lstat(fullPath) }
    catch (error) { if (error.code === 'ENOENT') { files[path] = { kind: 'missing' }; return }; throw error }
    if (stat.isDirectory()) {
      for (const entry of (await readdir(fullPath)).sort()) await visit(path + '/' + entry)
    } else {
      assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Source input must be a regular file or file symlink: ' + path)
      const bytes = await readFile(fullPath)
      files[path] = { sha256: digest(bytes), bytes: bytes.length, mode: stat.mode & 0o777,
        ...(stat.isSymbolicLink() ? { link: await readlink(fullPath) } : {}) }
    }
  }
  for (const path of [...sourceRoots].sort()) await visit(path)
  assert.ok(Object.keys(files).length > 0)
  assert.ok(files['apps/desktop/scripts/verify-git-workbench.mjs']?.sha256)
  const manifest = { schema: 'agentmux.git-workbench-source.v1', files }
  return { digest: digest(JSON.stringify(manifest)), manifest }
}
if (process.argv[2] === '--print-source-digest') {
  assert.equal(process.argv.length, 3, 'Print mode takes no candidate or other options')
  const printedSource = await sourceManifest()
  await new Promise(done => process.stdout.write(printedSource.digest + '\n', done))
  process.exit(0)
}
assert.deepEqual(process.argv.slice(2, 3), ['--candidate'], 'Pass --candidate EXACT_COMMIT --source-digest FROZEN_SHA256')
const expectedRevision = process.argv[3]
const expectedSourceDigest = process.argv[5]
assert.ok(/^[0-9a-f]{40}$/.test(expectedRevision ?? '') && process.argv.length === 6 &&
  process.argv[4] === '--source-digest' && /^[0-9a-f]{64}$/.test(expectedSourceDigest ?? ''),
  'An exact candidate HEAD and explicit frozen source digest are required')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
let connectAgentMuxRpc
const exec = promisify(execFile)
const delay = ms => new Promise(done => setTimeout(done, ms))
const commonDirectory = (await exec('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
const evidenceRoot = resolve(commonDirectory, '..', '.bagakit/feature-tracker/space-zone-git-tools')
await mkdir(evidenceRoot, { recursive: true })
const artifacts = await mkdtemp(join(evidenceRoot, 'native-'))
const root = join(artifacts, 'private')
const userData = join(root, 'user-data'), privateHome = join(root, 'home'), physicalRuntimeDirectory = join(root, 'runtime')
let runtimeDirectory = physicalRuntimeDirectory, runtimeAliasRoot, privateRootAlias
const workspacePath = join(root, 'repository'), codexHome = join(privateHome, 'codex')
const reviewWorktreePath = join(root, 'review-worktree'), reviewBranch = 'feature/readable-history'
const mainStagedPath = 'main-draft-fixture.txt', reviewStagedPath = 'review-draft-fixture.txt'
const mainDraft = 'Unsent main worktree message stays with its original Zone'
const reviewDraft = 'Unsent review worktree message stays separate across tools and Zones'
const workspaceId = 'private-git-workbench', workspaceName = 'Repository'
const children = new Set(), connections = new Set()
let deadline = 0
const receipt = { schema: 'agentmux.git-reading-surfaces.v1', expectedRevision, expectedSourceDigest, sourceRoot: repositoryRoot,
  passed: false, builds: [], screenshots: [], cleanup: {}, aestheticReview: 'not-performed' }
let phase = 'prepare', failure, first, second, frozenSource, frozenTrackedChanges
// This probe is a separate local user client, never the surrounding managed Agent.
const privateEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('AGENTMUX_') && name !== 'ELECTRON_RENDERER_URL' && name !== 'ELECTRON_RUN_AS_NODE'))
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(physicalRuntimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(physicalRuntimeDirectory, 'state/spatial-state.json'),
  AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'), CODEX_HOME: codexHome }
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
async function git(...args) { return (await exec('git', ['-C', workspacePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout }
async function reviewGit(...args) { return (await exec('git', ['-C', reviewWorktreePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout }
async function trackedChanges() {
  const options = { env: gitEnv, maxBuffer: 32 * 1024 * 1024 }
  const paths = (await exec('git', ['-C', repositoryRoot, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], options)).stdout
    .split('\0').filter(path => path && isSourcePath(path))
  const patch = paths.length ? (await exec('git', ['-C', repositoryRoot, 'diff', '--binary', '--no-ext-diff',
    '--no-textconv', '--no-renames', 'HEAD', '--', ...paths], { ...options, encoding: 'buffer' })).stdout : Buffer.alloc(0)
  const added = (await exec('git', ['-C', repositoryRoot, 'ls-files', '--others', '--exclude-standard', '-z'], options)).stdout
    .split('\0').filter(path => path && isSourcePath(path)).sort()
  return { sha256: digest(patch), paths: paths.sort(), added, patch }
}
async function assertFrozenSource(label) {
  const current = await sourceManifest()
  assert.equal(current.digest, expectedSourceDigest, label + ': frozen source inputs changed')
  assert.deepEqual(current.manifest, frozenSource.manifest, label + ': source manifest changed')
  assert.equal((await exec('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { env: gitEnv })).stdout.trim(), expectedRevision,
    label + ': candidate HEAD changed')
  const changes = await trackedChanges()
  assert.equal(changes.sha256, frozenTrackedChanges.sha256, label + ': tracked source diff changed')
  assert.deepEqual(changes.added, frozenTrackedChanges.added, label + ': added source inputs changed')
  ;(receipt.sourceChecks ??= []).push({ label, digest: current.digest, trackedDiffSha256: changes.sha256 })
}
async function buildCandidate(label, args) {
  phase = 'build-' + label
  await assertFrozenSource('before-' + label)
  const startedAt = new Date().toISOString()
  let result, error
  try { result = await exec('pnpm', args, { cwd: repositoryRoot, env: privateEnvironment,
    timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }) }
  catch (failure) { error = failure; result = failure }
  const stdout = result.stdout ?? '', stderr = result.stderr ?? ''
  const stdoutPath = label + '-stdout.log', stderrPath = label + '-stderr.log'
  await writeFile(join(artifacts, stdoutPath), stdout); await writeFile(join(artifacts, stderrPath), stderr)
  receipt.builds.push({ command: ['pnpm', ...args], cwd: repositoryRoot, startedAt, endedAt: new Date().toISOString(),
    sourceDigest: expectedSourceDigest, stdout: { path: stdoutPath, sha256: digest(stdout) },
    stderr: { path: stderrPath, sha256: digest(stderr) }, exitCode: error ? error.code ?? null : 0, signal: error?.signal ?? null })
  if (error) throw error
  await assertFrozenSource('after-' + label)
}
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
  await assertFrozenSource('before-launch-' + label)
  assert.deepEqual(await identity(), receipt.identityBefore, 'Built candidate changed before ' + label)
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
  await waitFor(`${label} trusted UI`, () => visibleRead(cdp, `Boolean(window.agentmux && ${visibleNode('.project-list')})`))
  await activate(cdp)
  const nativeHome = await cdp.evaluate('(async () => (await window.agentmux.sessions.snapshot()).localHome)()')
  assert.equal(nativeHome, privateHome)
  receipt[label] = { pid: child.pid, home, nativeHome, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
  await loadedBundles(cdp, label)
  return { child, main, cdp }
}
async function click(cdp, expression, button = 'left') {
  await activate(cdp)
  const point = await waitFor('exact visible UI control', () => visibleRead(cdp, `(() => { const matches = ${expression}; if (matches.length !== 1) return null; const element = matches[0]; if (element.disabled || !element.getClientRects().length) return null; element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point })
}
const selectors = (selector, root = 'document') => `Array.from(${root}?.querySelectorAll(${JSON.stringify(selector)}) ?? []).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')`
const visibleNode = (selector, root) => `${selectors(selector, root)}[0]`
async function toolSelection(cdp) {
  return await cdp.evaluate(`(() => {const tools=${visibleNode('[aria-label="Space tool selection"]')},view=${visibleNode('[aria-label="Git view"]')};const stored=JSON.parse(localStorage.getItem('agentmux-workbench-v1')??'null')?.state;return {tool:${visibleNode('[aria-pressed="true"]', 'tools')}?.getAttribute('data-space-tool')??null,view:${visibleNode('[aria-selected="true"]', 'view')}?.textContent.trim()??null,contentLabel:${visibleNode('[data-space-tool="files-branches"]', 'tools')}?.getAttribute('aria-label')??null,storedTool:stored?.workspaceTool??null,storedView:stored?.workspaceGitView??null,workface:stored?.workbenchSpaceSelection??null,commitDrafts:stored?.gitCommitDrafts??{}}})()`)
}
async function selectGitView(cdp, label) {
  await click(cdp, `${selectors('[aria-label="Git view"] button')}.filter(element=>element.textContent.trim()===${JSON.stringify(label)})`)
  return await waitFor('selected Git ' + label, async () => {
    const selected = await toolSelection(cdp)
    return selected.tool === 'git' && selected.view === label ? selected : null
  })
}
async function originalWorkface(cdp, opened, body) {
  const { zoneId } = opened.resource
  const { tabId, regionId } = opened.placement
  const location = opened.placement.locations.find(item => item.zoneId === zoneId && item.tabId === tabId && item.regionId === regionId)
  assert.ok(location, 'The actual file-open receipt must name a nonempty original occurrence')
  const selected = await waitFor('original Zone, Tab, Region and file are actually visible', async () => {
    const choice = (await toolSelection(cdp)).workface
    if (choice?.zoneId !== zoneId || choice.tabId !== tabId || choice.regionId !== regionId ||
      choice.workspaceId !== location.displayWorkspaceId || choice.groupId !== location.groupId) return null
    const visible = await visibleRead(cdp, `(() => {const region=${selectors('[data-workbench-region-id]')}.find(element=>element.dataset.workbenchRegionId===${JSON.stringify(regionId)});const editor=${visibleNode('.monaco-editor', 'region')};return Boolean(editor&&${visibleNode('.view-lines', 'editor')}?.innerText.replace(/\u00a0/g,' ').includes(${JSON.stringify(body)}))})()`)
    return visible ? choice : null
  })
  const graph = (await state()).graph
  const tab = graph.tabs.find(item => item.tabId === tabId), region = graph.regions.find(item => item.regionId === regionId)
  assert.equal(tab?.zoneId, zoneId); assert.equal(region?.tabId, tabId)
  assert.equal(region?.file?.workspaceId, opened.resource.workspaceId)
  return { selection: Object.fromEntries(['spaceId', 'zoneId', 'workspaceId', 'groupId', 'tabId', 'regionId']
    .map(key => [key, selected[key] ?? null])), tabLayout: graph.tabLayouts[tabId], file: region.file }
}
async function openZoneFile(cdp, zoneId, spaceId, path, body) {
  const graph = (await state()).graph
  const zones = graph.zones.filter(zone => zone.zoneId === zoneId)
  assert.equal(zones.length, 1)
  const zone = zones[0]
  const config = await cdp.evaluate('window.agentmux.config.get()')
  const workspace = config.workspaces.find(item => item.id === zone.workspaceId)
  assert.ok(workspace && zone.hostId && zone.directoryPath)
  assert.equal(zone.directoryPath, workspace.path)
  assert.equal(graph.bindings.filter(binding => binding.zoneId === zoneId && binding.spaceId === spaceId).length, 1)
  const opened = await control('file.open', { zoneId, spaceId, path, focus: true })
  assert.ok(Array.isArray(opened.issues))
  const inputPreservationOnly = opened.outcome === 'partial' && opened.issues.length > 0 &&
    opened.issues.every(issue => issue?.code === 'INPUT_PRESERVATION_UNCONFIRMED')
  assert.ok(opened.outcome === 'opened' || opened.outcome === 'unchanged' || inputPreservationOnly, JSON.stringify(opened))
  assert.equal(opened.navigation, 'applied'); assert.equal(opened.data.kind, 'text')
  assert.equal(opened.requestedPath, path)
  assert.deepEqual(opened.resource, { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path,
    zoneId, zonePath: zone.directoryPath, path })
  assert.ok(opened.placement.status === 'created' || opened.placement.status === 'reused')
  assert.ok(typeof opened.placement.tabId === 'string' && opened.placement.tabId.length > 0)
  assert.ok(typeof opened.placement.regionId === 'string' && opened.placement.regionId.length > 0)
  assert.ok(opened.placement.locations.some(location => location.spaceId === spaceId && location.zoneId === zoneId &&
    location.tabId === opened.placement.tabId && location.regionId === opened.placement.regionId))
  assert.ok(opened.save)
  assert.equal(typeof opened.save.layoutApplied, 'boolean')
  assert.equal(opened.save.localStorageWritten, true); assert.equal(opened.save.storageFlushRequested, true)
  assert.equal(opened.save.diskDurability, 'confirmed'); assert.equal(opened.save.reason, null)
  return { opened, workface: await originalWorkface(cdp, opened, body) }
}
async function selectZone(cdp, zoneId, file, body) {
  await click(cdp, selectors('button[data-space-tool="files-branches"]'))
  await click(cdp, `${selectors('[aria-label="Zones"] button[data-zone-id]')}.filter(element=>element.getAttribute('data-zone-id')===${JSON.stringify(zoneId)})`)
  const actual = await originalWorkface(cdp, file.opened, body)
  assert.deepEqual(actual, file.workface, 'Zone selection restores the original exact file workface, not a new Tab')
  return actual
}
async function changesTarget(cdp, workspace, zoneId, stagedPath, draft) {
  const dom = await waitFor('Changes displays the exact Zone worktree, staged entry and original draft', async () => {
    const choice = await toolSelection(cdp)
    if (choice.tool !== 'git' || choice.view !== 'Changes' || choice.workface?.zoneId !== zoneId) return null
    const observed = await visibleRead(cdp, `(() => {const tool=${visibleNode('.workspace-git-tool')},panel=${visibleNode('.changes-panel', 'tool')},input=${visibleNode('textarea.commit-box__message', 'panel')};if(!input)return null;return {workspaceId:tool.getAttribute('data-git-workspace'),path:${visibleNode('.workspace-git-path', 'tool')}?.getAttribute('title'),branch:${visibleNode('.changes-repository-context > span', 'panel')}?.textContent,draft:input.value,disabled:input.disabled,staged:${selectors('button[aria-label]', 'panel')}.map(button=>button.getAttribute('aria-label')).includes(${JSON.stringify('Unstage ' + stagedPath)})}})()`)
    return observed?.workspaceId === workspace.id && observed.path === workspace.path && observed.branch === workspace.branch &&
      observed.staged && !observed.disabled && observed.draft === draft ? observed : null
  })
  const native = await cdp.evaluate(`window.agentmux.git.status(${JSON.stringify(workspace.id)})`)
  assert.equal(native.kind, 'git-repository'); assert.equal(native.hostId, workspace.hostId)
  assert.equal(native.repoPath, workspace.path); assert.equal(native.branch, workspace.branch)
  assert.equal(native.changes.filter(change => change.path === stagedPath && change.staged).length, 1)
  return { zoneId, workspace: { id: workspace.id, hostId: workspace.hostId, path: workspace.path }, dom, native }
}
async function typeCommitDraft(cdp, text) {
  await click(cdp, selectors('.workspace-git-tool .changes-panel textarea.commit-box__message'))
  await cdp.call('Input.insertText', { text })
  await waitFor('real commit input writes back without submitting', () => visibleRead(cdp,
    `${visibleNode('.workspace-git-tool .changes-panel textarea.commit-box__message')}?.value===${JSON.stringify(text)}`))
}
async function loadedBundles(cdp, label) {
  const urls = await cdp.evaluate(`Array.from(new Set([...Array.from(document.scripts).map(element=>element.src),...performance.getEntriesByType('resource').map(entry=>entry.name)])).filter(url=>url.startsWith('file:')&&/\\.(?:js|css)(?:[?#]|$)/.test(url))`)
  assert.ok(urls.length > 0, 'A nonempty built Renderer resource set must actually load')
  const files = []
  for (const url of urls) {
    const path = fileURLToPath(url)
    assert.ok(path.startsWith(repositoryRoot + '/'), 'Loaded Renderer must belong to this source root')
    const relative = path.slice(repositoryRoot.length + 1), expected = receipt.identityBefore[relative]
    assert.ok(expected, 'Loaded Renderer must belong to the frozen build: ' + relative)
    const sha256 = digest(await readFile(path))
    assert.equal(sha256, expected, 'Loaded Renderer changed: ' + relative)
    files.push({ path: relative, sha256 })
  }
  ;(receipt.loadedBundles ??= []).push({ label, files })
}
async function monaco(cdp, original, modified, regionId, inline = false) {
  await activate(cdp)
  // Monaco deliberately switches to inline at narrow split widths. Verify its actual rendered
  // presentation, retaining exact separate-side checks whenever both sides are displayed.
  const paneSelector = inline ? `[data-git-workbench-region="${regionId}"] [aria-label="Commit file diff"]`
    : `[data-git-diff-region="${regionId}"]`
  return waitFor('visible readonly Monaco canvas and content', () => visibleRead(cdp, `(() => { const pane = ${visibleNode(paneSelector)}; const canvas=${visibleNode('.monaco-diff-editor', 'pane')};if(!canvas)return null; const rect=canvas.getBoundingClientRect();if(rect.width<80||rect.height<80)return null; const lines=${selectors('.view-lines', 'canvas')};const read = side => lines.find(element=>element.closest('.editor')?.classList.contains(side))?.innerText.replace(/\u00a0/g,' ').trim(); const left=read('original'),right=read('modified');const presentation=canvas.classList.contains('side-by-side')?'side-by-side':'inline';const displayedLines=lines.flatMap(element=>element.innerText.replace(/\u00a0/g,' ').split('\\n').map(line=>line.trim()).filter(Boolean));const valid=presentation==='side-by-side'?left===${JSON.stringify(original)}&&right===${JSON.stringify(modified)}:(${JSON.stringify(original)} === "" || displayedLines.includes(${JSON.stringify(original)})) && (${JSON.stringify(modified)} === "" || displayedLines.includes(${JSON.stringify(modified)}));return valid?{presentation,original:left,modified:right,displayedLines,viewportWidth:rect.width,viewportHeight:rect.height,canvases:${selectors('.monaco-diff-editor', 'pane')}.length}:null })()`))
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
  const startedAtMs = Date.now(), budgetMs = 90_000
  const attempt = { pid: probe.child.pid, startedAtMs, budgetMs, actualBudgetMs: Math.max(0, Math.min(budgetMs, deadline - startedAtMs)) }
  receipt.quitAttempts ??= []
  receipt.quitAttempts.push(attempt)
  let replyFailure
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron').app.quit()` ) }
  catch (error) { replyFailure = error.message }
  attempt.inspectorReplyFailure = replyFailure ?? null
  probe.main.close(); probe.cdp.close()
  try { await waitFor('actual normal Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null, budgetMs) }
  finally { Object.assign(attempt, { elapsedMs: Date.now() - startedAtMs, exitCode: probe.child.exitCode, signal: probe.child.signalCode }) }
  assert.equal(probe.child.exitCode,0); assert.equal(probe.child.signalCode,null)
  return {exitCode:probe.child.exitCode,signal:probe.child.signalCode,elapsedMs:attempt.elapsedMs,budgetMs,inspectorReplyFailure:replyFailure ?? null}
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
  const themeState = await waitFor('committed App and visible Monaco appearance', () => visibleRead(cdp, `(() => {const editors=${selectors('.monaco-editor')};const appearance=document.documentElement.dataset.appearance;return appearance===${JSON.stringify(theme)}&&editors.every(element=>element.classList.contains(${JSON.stringify(theme === 'light' ? 'vs' : 'vs-dark')}))?{appearance,monaco:editors.map(element=>({className:element.className,background:getComputedStyle(element).backgroundColor}))}:null})()`))
  await delay(250)
  focus = await activate(cdp)
  const surfaces = await cdp.evaluate(`${selectors('[data-git-workbench-region]')}.map(element=>{const rect=element.getBoundingClientRect();return {regionId:element.dataset.gitWorkbenchRegion,label:element.getAttribute('aria-label'),width:rect.width,height:rect.height}})`)
  const spatial = await state()
  const targets = surfaces.map(surface => ({ ...surface, resource: spatial.graph.resources['region:' + surface.regionId] }))
  const tools = await toolSelection(cdp)
  receipt.visibility ??= []; receipt.visibility.push({ name, ...focus, tools, surfaces, appearanceOwner: appearance, renderedTheme: themeState })
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(artifacts, name + '.png'); await writeFile(path, Buffer.from(data, 'base64'))
  receipt.screenshots.push({ path, width, theme, tools, targets, sha256: digest(Buffer.from(data, 'base64')) })
}
async function state() { return (await control('space.state', {})).state }
async function identity() {
  const paths = ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/release.json',
    'apps/desktop/src/renderer/src/components/BranchesPanel.tsx',
    'apps/desktop/src/renderer/src/styles/git-workbench.css',
    'apps/desktop/src/renderer/src/styles/source-control.css',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/scripts/verify-git-workbench.mjs',
    'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceFilesTool.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceGitTool.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceZonesPanel.tsx',
    'apps/desktop/src/renderer/src/components/ChangesPanel.tsx',
    'apps/desktop/src/renderer/src/lib/surface-tool-dock.ts',
    'apps/desktop/src/renderer/src/lib/workspace-git-view.ts',
    'apps/desktop/src/renderer/src/lib/workspace-zone-context.ts',
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
  await bundles('apps/desktop/out/renderer', /./u)
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
  return await waitFor('original Git Region visible', () => visibleRead(cdp, `Boolean(${visibleNode(pane(regionId))})`))
}
const pane = regionId => `[data-git-workbench-region="${regionId}"]`
async function press(cdp, key) {
  const virtualKeyCode = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13 }[key]
  const input = { key, code: key, ...(virtualKeyCode ? { windowsVirtualKeyCode: virtualKeyCode } : {}) }
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...input })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...input })
}
async function reference(cdp, regionId, value, scope = pane(regionId)) {
  const selector = scope + ' [aria-label="History reference"]'
  const observe = () => cdp.evaluate(`(() => {const matches=${selectors(selector)},select=matches[0];return {matches:matches.length,value:select?.value,index:select?.selectedIndex,focused:document.activeElement===select,regionId:select?.closest('[data-git-workbench-region]')?.getAttribute('data-git-workbench-region')??null,workspaceId:select?.closest('[data-git-workspace]')?.getAttribute('data-git-workspace')??null,options:select?Array.from(select.options).map(option=>({value:option.value,label:option.textContent.trim(),disabled:option.disabled})):[]}})()`)
  const before = await observe()
  assert.equal(before.matches, 1, 'Select one exact visible History control, never a retained hidden owner')
  assert.equal(before.regionId, regionId)
  const target = before.options.find(option => option.value === value)
  assert.ok(target && !target.disabled, 'The exact requested reference must exist in this original select')
  const key = target.label[0]
  assert.match(key, /^[a-z0-9]$/iu, 'Fixture references must expose a native single-character navigation prefix')
  const code = /[a-z]/iu.test(key) ? 'Key' + key.toUpperCase() : 'Digit' + key
  const windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0)
  const candidates = before.options.filter(option => !option.disabled && option.label[0]?.toLowerCase() === key.toLowerCase())
  assert.ok(candidates.length > 0)
  const originalScope = regionId ? (await state()).graph.resources['region:' + regionId].scope : null
  receipt.referenceInteractions ??= []
  const interaction = { regionId, scope, requested: value, before, originalScope, key, attempts: [], observed: before.value }
  receipt.referenceInteractions.push(interaction)
  if (before.value !== value) {
    await activate(cdp)
    assert.equal(await cdp.evaluate(`(() => { const select=${visibleNode(selector)};select.focus();return document.activeElement===select })()`), true)
    await delay(1_200)
  }
  for (let attempt = 0; interaction.observed !== value && attempt < candidates.length; attempt++) {
    const previous = await observe()
    assert.equal(previous.matches, 1); assert.equal(previous.regionId, regionId)
    assert.equal(previous.workspaceId, before.workspaceId)
    interaction.observed = previous.value
    if (previous.value === value) break
    assert.equal(previous.focused, true)
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key, unmodifiedText: key })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
    const after = await observe()
    interaction.attempts.push({ previous, after })
    interaction.observed = after.value
    assert.equal(after.matches, 1); assert.equal(after.regionId, regionId)
    assert.equal(after.workspaceId, before.workspaceId)
    assert.ok(candidates.some(option => option.value === after.value), 'Native key input must select a member of the actual prefix group')
  }
  await waitFor('actual chosen History reference in the original scope', async () => {
    const selected = await observe()
    interaction.final = selected
    if (selected.matches !== 1 || selected.regionId !== regionId || selected.workspaceId !== before.workspaceId || selected.value !== value) return false
    if (!regionId) return true
    const resource = (await state()).graph.resources['region:' + regionId]
    interaction.durable = resource
    assert.deepEqual(resource.scope, originalScope, 'Reference navigation must keep its exact original repository resource')
    return resource.history?.reference === value
  })
  interaction.history = await settledHistory(cdp, scope)
  assert.equal(interaction.history.range, value, 'The completed real History read must retain the exact requested reference')
  interaction.final = await observe()
  assert.equal(interaction.final.value, value)
  assert.equal(interaction.final.matches, 1); assert.equal(interaction.final.regionId, regionId)
  assert.equal(interaction.final.workspaceId, before.workspaceId)
  if (regionId) {
    interaction.durable = (await state()).graph.resources['region:' + regionId]
    assert.deepEqual(interaction.durable.scope, originalScope)
    assert.equal(interaction.durable.history?.reference, value)
  }
}
async function historyView(cdp, scope) {
  await activate(cdp)
  return await cdp.evaluate(`(() => { const root=${visibleNode(scope)},scroll=${visibleNode('.git-history-scroll', 'root')};if(!scroll)return null;const rows=${selectors('[data-history-oid]', 'scroll')};return {range:${visibleNode('[aria-label="History reference"]', 'root')}?.value,loaded:Number(/^(\\d+) commits/.exec(${visibleNode('.git-history-footer', 'scroll')}?.textContent??'')?.[1]),scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,viewport:scroll.clientHeight,drawn:rows.length,graphNodes:${selectors('.git-history-node', 'scroll')}.length,rows:rows.map(row=>({oid:row.dataset.historyOid,index:Number(row.dataset.historyIndex),selected:row.getAttribute('aria-current')})),edges:${selectors('[data-child-oid]', 'scroll')}.map(edge=>({child:edge.dataset.childOid,parent:edge.dataset.parentOid}))} })()`)
}
async function settledHistory(cdp, scope) {
  let last, stableSince = 0
  return await waitFor('visible completed History window', async () => {
    const view = await historyView(cdp, scope)
    const busy = await cdp.evaluate(`${visibleNode(scope + ' .git-history-panel')}?.getAttribute('aria-busy')`)
    if (!(view?.loaded > 0 && busy === 'false')) { last = undefined; return null }
    const key = JSON.stringify([view.range, view.loaded, view.scrollTop, view.scrollHeight, view.viewport])
    if (key !== last) { last = key; stableSince = Date.now(); return null }
    return Date.now() - stableSince >= 140 ? view : null
  })
}
async function narrowWidth(cdp, regionId) {
  const value = await cdp.evaluate(`(() => { const rect=${visibleNode(pane(regionId))}.getBoundingClientRect();return Math.ceil(innerWidth-rect.width+320) })()`)
  return Math.max(500, value)
}
try {
  receipt.sourceRevision = (await exec('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(receipt.sourceRevision, expectedRevision)
  frozenSource = await sourceManifest()
  assert.equal(frozenSource.digest, expectedSourceDigest, 'Explicit source pin must match before any build or native launch')
  frozenTrackedChanges = await trackedChanges()
  receipt.source = { digest: frozenSource.digest, manifest: 'source-manifest.json',
    trackedDiff: { path: 'source-tracked.diff', sha256: frozenTrackedChanges.sha256, paths: frozenTrackedChanges.paths },
    addedSources: frozenTrackedChanges.added }
  await writeFile(join(artifacts, 'source-manifest.json'), JSON.stringify({ ...frozenSource.manifest,
    head: expectedRevision, sourceDigest: frozenSource.digest, trackedDiffSha256: frozenTrackedChanges.sha256,
    addedSources: frozenTrackedChanges.added }, null, 2) + '\n')
  await writeFile(join(artifacts, 'source-tracked.diff'), frozenTrackedChanges.patch)
  await buildCandidate('client-ui', ['--filter', '@agentmux/client-ui...', 'build'])
  await buildCandidate('desktop', ['--filter', '@agentmux/desktop', 'build'])
  ;({ connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/public-rpc-client.js'))))
  deadline = Date.now() + 360_000
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
  assert.ok(Object.keys(release.files).length > 0, 'Renderer release must bind real output files')
  for (const [path, sha256] of Object.entries(release.files)) {
    assert.ok(path && !path.startsWith('/') && !path.split('/').includes('..'), 'Renderer release paths stay inside its output')
    assert.equal(digest(await readFile(join(desktopRoot, 'out/renderer', path))), sha256, 'Built release file changed: ' + path)
  }
  assert.equal(release.id, digest(JSON.stringify({ identity: release.identity, files: Object.entries(release.files).sort() })))
  receipt.rendererRelease = { id: release.id, identity: release.identity, files: release.files }
  await writeFile(join(artifacts, 'build-identity.json'), JSON.stringify({ sourceDigest: expectedSourceDigest,
    builds: receipt.builds, files: receipt.identityBefore, release }, null, 2) + '\n')
  await assertFrozenSource('before-fixture')
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
  await git('branch', 'topic/pure-branch'); await git('worktree', 'add', reviewWorktreePath, reviewBranch)
  await git('branch', 'topic/root-only', rootOid)
  await writeFile(join(workspacePath, 'changed.ts'), 'dirty worktree body must remain untouched\n')
  await writeFile(join(workspacePath, mainStagedPath), 'Main staged body must never be committed by this probe\n')
  await git('add', '--', mainStagedPath)
  await writeFile(join(reviewWorktreePath, reviewStagedPath), 'Review staged body must never be committed by this probe\n')
  await reviewGit('add', '--', reviewStagedPath)
  receipt.fixture = { rootOid, featureOid, mergeOid, parents, longPath, reviewWorktreePath, mainStagedPath, reviewStagedPath }
  const fixedFiles = ['changed.ts', 'renamed.ts', 'binary.bin', 'main.ts', longPath, mainStagedPath]
  const gitState = async () => ({ head: (await git('rev-parse', 'HEAD')).trim(), status: await git('status', '--porcelain=v1'),
    index: digest(await readFile(join(workspacePath, '.git/index'))),
    files: Object.fromEntries(await Promise.all(fixedFiles.map(async path => [path, digest(await readFile(join(workspacePath, path)))]))) })
  const unchanged = await gitState()
  const reviewIndex = resolve(reviewWorktreePath, (await reviewGit('rev-parse', '--git-path', 'index')).trim())
  assert.ok(reviewIndex.startsWith(root + '/'), 'Only the private review worktree index may be read')
  const reviewGitState = async () => ({ head: (await reviewGit('rev-parse', 'HEAD')).trim(), status: await reviewGit('status', '--porcelain=v1'),
    index: digest(await readFile(reviewIndex)), files: Object.fromEntries(await Promise.all([reviewStagedPath, 'changed.ts', 'renamed.ts']
      .map(async path => [path, digest(await readFile(join(reviewWorktreePath, path)))]))) })
  const reviewUnchanged = await reviewGitState()
  receipt.reviewGitBaseline = reviewUnchanged
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local' }], executors: {},
    workspaces: [{ id: workspaceId, name: workspaceName, hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { agentAutomation: false, toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  first = await launch('first'); phase = 'real-ui'
  await click(first.cdp, selectors(`.project-rail-row[data-workspace-id="${workspaceId}"]`))
  receipt.initialTools = await toolSelection(first.cdp)
  assert.equal(receipt.initialTools.contentLabel, 'Files + Zones')
  await click(first.cdp, selectors('button[data-space-tool="files-branches"]'))
  assert.equal(await first.cdp.evaluate(`${selectors('[aria-label="Git view"], .branch-row')}.length`), 0,
    'Files + Zones must not render the full Git navigation or branch candidate rows')
  await capture(first.cdp, 'files-zones-dark-wide')
  await capture(first.cdp, 'files-zones-light-narrow', 800, 'light')
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  receipt.initialGitView = await waitFor('fresh Git defaults to Changes', async () => {
    const selected = await toolSelection(first.cdp)
    return selected.tool === 'git' && selected.view === 'Changes' ? selected : null
  })
  const initialCatalog = await waitFor('original resource Zone is visible in the durable catalog', async () => {
    const graph = (await state()).graph
    return graph.zones.some(zone => zone.workspaceId === workspaceId && zone.directoryPath === workspacePath) ? graph : null
  })
  const mainZones = initialCatalog.zones.filter(zone => zone.workspaceId === workspaceId && zone.hostId === 'local' && zone.directoryPath === workspacePath)
  const mainSpaces = initialCatalog.spaces.filter(space => space.kind === 'folder' && space.hostId === 'local' && space.directoryPath === workspacePath)
  assert.equal(mainZones.length, 1); assert.equal(mainSpaces.length, 1)
  const mainZone = mainZones[0], mainSpaceId = mainSpaces[0].spaceId
  assert.equal(initialCatalog.bindings.filter(binding => binding.zoneId === mainZone.zoneId && binding.spaceId === mainSpaceId).length, 1)
  const beforeRegistration = await first.cdp.evaluate('window.agentmux.config.get()')
  assert.equal(beforeRegistration.workspaces.filter(workspace => workspace.path === reviewWorktreePath).length, 0,
    'The second real worktree must not already be seeded as a registered Workspace')
  const mainWorkspace = { ...beforeRegistration.workspaces.find(workspace => workspace.id === workspaceId),
    branch: (await git('branch', '--show-current')).trim() }
  const mainFile = await openZoneFile(first.cdp, mainZone.zoneId, mainSpaceId, 'main.ts', 'main parent')
  receipt.zoneBoundaries = { mainZone, mainSpaceId, mainFile,
    mainBeforeDraft: await changesTarget(first.cdp, mainWorkspace, mainZone.zoneId, mainStagedPath, '') }
  await typeCommitDraft(first.cdp, mainDraft)
  receipt.zoneBoundaries.mainDraft = await changesTarget(first.cdp, mainWorkspace, mainZone.zoneId, mainStagedPath, mainDraft)
  await capture(first.cdp, 'git-changes-dark-wide')
  await capture(first.cdp, 'git-changes-light-narrow', 800, 'light')
  await click(first.cdp, selectors('button[data-space-tool="files-branches"]'))
  await click(first.cdp, selectors('[aria-label="Zones"] button[aria-label="Create worktree"]'))
  receipt.createWorktreeNavigation = await waitFor('worktree creation entry reaches the original Git Branches owner', async () => {
    const selected = await toolSelection(first.cdp)
    return selected.tool === 'git' && selected.view === 'Branches' ? selected : null
  })
  await click(first.cdp, `${selectors('.workspace-git-tool .branch-row__open')}.filter(element=>${visibleNode('strong', 'element')}?.textContent===${JSON.stringify(reviewBranch)})`)
  const registered = await waitFor('actual Branches worktree click registers and opens its original resource', async () => {
    const config = await first.cdp.evaluate('window.agentmux.config.get()')
    const matching = config.workspaces.filter(workspace => workspace.hostId === 'local' && workspace.path === reviewWorktreePath)
    if (matching.length !== 1) return null
    const displayed = await visibleRead(first.cdp, `${visibleNode('.workspace-git-tool')}?.getAttribute('data-git-workspace')`)
    return displayed === matching[0].id ? matching[0] : null
  })
  assert.notEqual(registered.id, workspaceId); assert.equal(registered.kind, 'worktree')
  assert.equal(registered.repoPath, workspacePath); assert.equal(registered.branch, reviewBranch)
  const registeredCatalog = await waitFor('registered worktree reaches the same durable Space catalog', async () => {
    const graph = (await state()).graph
    const zones = graph.zones.filter(zone => zone.workspaceId === registered.id && zone.directoryPath === reviewWorktreePath)
    return zones.length === 1 && graph.bindings.some(binding => binding.zoneId === zones[0].zoneId && binding.spaceId === mainSpaceId) ? graph : null
  })
  const reviewZones = registeredCatalog.zones.filter(zone => zone.workspaceId === registered.id && zone.hostId === 'local' && zone.directoryPath === reviewWorktreePath)
  assert.equal(reviewZones.length, 1)
  const reviewZone = reviewZones[0]
  assert.equal(registeredCatalog.bindings.filter(binding => binding.zoneId === reviewZone.zoneId && binding.spaceId === mainSpaceId).length, 1)
  const reviewWorkspace = { ...registered, branch: (await reviewGit('branch', '--show-current')).trim() }
  const reviewFile = await openZoneFile(first.cdp, reviewZone.zoneId, mainSpaceId, 'changed.ts', 'fixed commit body')
  Object.assign(receipt.zoneBoundaries, { registered, reviewZone, reviewFile })
  await click(first.cdp, selectors('button[data-space-tool="files-branches"]'))
  const visibleZones = await visibleRead(first.cdp, `${selectors('[aria-label="Zones"] button[data-zone-id]')}.map(element=>element.getAttribute('data-zone-id')).sort()`)
  const expectedZones = registeredCatalog.bindings.filter(binding => binding.spaceId === mainSpaceId).map(binding => binding.zoneId).sort()
  assert.equal(expectedZones.length, 2)
  assert.deepEqual(visibleZones, expectedZones, 'Files + Zones lists the two real catalog bindings, not the unbound Git branches')
  receipt.zoneBoundaries.visibleZones = visibleZones
  await capture(first.cdp, 'files-zones-two-worktrees-dark-wide')
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  await selectGitView(first.cdp, 'Changes')
  receipt.zoneBoundaries.reviewBeforeDraft = await changesTarget(first.cdp, reviewWorkspace, reviewZone.zoneId, reviewStagedPath, '')
  await typeCommitDraft(first.cdp, reviewDraft)
  receipt.zoneBoundaries.reviewDraft = await changesTarget(first.cdp, reviewWorkspace, reviewZone.zoneId, reviewStagedPath, reviewDraft)
  await capture(first.cdp, 'review-worktree-changes-draft-dark-wide')
  await click(first.cdp, selectors('button[data-space-tool="agents"]'))
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  receipt.zoneBoundaries.reviewAfterToolSwitch = await changesTarget(first.cdp, reviewWorkspace, reviewZone.zoneId, reviewStagedPath, reviewDraft)
  await selectGitView(first.cdp, 'History')
  await settledHistory(first.cdp, '.source-control-history')
  await reference(first.cdp, null, 'refs/heads/main', '.source-control-history')
  receipt.zoneBoundaries.reviewHistory = await settledHistory(first.cdp, '.source-control-history')
  assert.equal(receipt.zoneBoundaries.reviewHistory.range, 'refs/heads/main')
  assert.deepEqual(await originalWorkface(first.cdp, reviewFile.opened, 'fixed commit body'), reviewFile.workface,
    'Selecting another history ref must not change the selected review Zone or original workface')
  await capture(first.cdp, 'review-worktree-history-main-reference-dark-wide')
  await selectGitView(first.cdp, 'Changes')
  receipt.zoneBoundaries.reviewAfterHistoryReference = await changesTarget(first.cdp, reviewWorkspace, reviewZone.zoneId, reviewStagedPath, reviewDraft)
  await capture(first.cdp, 'review-worktree-changes-after-main-reference-light-narrow', 800, 'light')
  receipt.zoneBoundaries.mainWorkfaceRestored = await selectZone(first.cdp, mainZone.zoneId, mainFile, 'main parent')
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  receipt.zoneBoundaries.mainAfterZoneSwitch = await changesTarget(first.cdp, mainWorkspace, mainZone.zoneId, mainStagedPath, mainDraft)
  await capture(first.cdp, 'main-worktree-changes-original-draft-dark-wide')
  receipt.zoneBoundaries.reviewWorkfaceRestored = await selectZone(first.cdp, reviewZone.zoneId, reviewFile, 'fixed commit body')
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  receipt.zoneBoundaries.reviewAfterZoneSwitch = await changesTarget(first.cdp, reviewWorkspace, reviewZone.zoneId, reviewStagedPath, reviewDraft)
  await capture(first.cdp, 'review-worktree-changes-restored-draft-dark-wide')
  await selectZone(first.cdp, mainZone.zoneId, mainFile, 'main parent')
  await click(first.cdp, selectors('button[data-space-tool="git"]'))
  receipt.zoneBoundaries.mainAfterRoundTrip = await changesTarget(first.cdp, mainWorkspace, mainZone.zoneId, mainStagedPath, mainDraft)
  assert.deepEqual(await gitState(), unchanged, 'Zone navigation, reference filtering and draft input never commit or change the main Git baseline')
  assert.deepEqual(await reviewGitState(), reviewUnchanged, 'Both original staged worktree bytes and indexes survive real navigation and input')
  await selectGitView(first.cdp, 'History')
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
  await waitFor('clicked commit is actually visible', () => visibleRead(first.cdp, `${visibleNode(commitPane)}?.getAttribute('aria-label')==='Git commit details'`))
  assert.equal(await first.cdp.evaluate(`${selectors(commitPane + ' .git-history-panel')}.length`), 0)
  receipt.commitOnly = { regionId: gitRegion.regionId, embeddedHistoryPanels: 0, sidebarWindow: sidebarStart,
    boundary: 'DOM/navigation proof. Zero History I/O and render cost require the actual-owner qualification.' }
  receipt.loadedRenderer = await first.cdp.evaluate('Array.from(document.scripts).map(s=>s.src).filter(s=>s.startsWith("file:"))')
  assert.ok(receipt.loadedRenderer.length > 0)
  for (const url of receipt.loadedRenderer) assert.equal(digest(await readFile(fileURLToPath(url))), receipt.identityBefore[fileURLToPath(url).slice(repositoryRoot.length + 1)])
  await waitFor('complete fixed message and all real parents', () => visibleRead(first.cdp, `${visibleNode(commitPane + ' .git-workbench__message')}?.textContent.includes('original branch and history')&&${visibleNode(commitPane + ' .git-workbench__metadata')}?.textContent.includes(${JSON.stringify(parents[1])})`))
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
  await waitFor('chosen second-parent details', () => visibleRead(first.cdp, `${visibleNode(pane(otherParent.presentation.regionId) + ' [aria-label="Comparison parent"]')}?.value===${JSON.stringify(parents[1])}&&Boolean(${visibleNode(pane(otherParent.presentation.regionId) + ' [aria-label="Open diff for main.ts"]')})`))
  await open(mergeOid, parents[0])
  const beforeInline = await state()
  await click(first.cdp, selectors(commitPane + ' [aria-label="Open diff for changed.ts"]'))
  receipt.canvas = await monaco(first.cdp, '', 'fixed commit body', gitRegion.regionId, true)
  const afterInline = await state()
  assert.deepEqual(afterInline.graph.regions.map(r => r.regionId), beforeInline.graph.regions.map(r => r.regionId))
  assert.equal(afterInline.graph.resources['region:' + gitRegion.regionId].file.path, 'changed.ts')
  receipt.inlineRegion = { regionId: gitRegion.regionId, regionsBefore: beforeInline.graph.regions.length,
    regionsAfter: afterInline.graph.regions.length, file: afterInline.graph.resources['region:' + gitRegion.regionId].file }
  const editor = await first.cdp.evaluate(`(() => { const input=${visibleNode(commitPane + ' .editor.modified textarea')};if(!input)return false;input.focus();return true })()`)
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
  await waitFor('repository action reveals one main History and a sidebar summary', () => visibleRead(first.cdp, `${visibleNode(repositoryPane)}?.getAttribute('aria-label')==='Git repository history'&&Boolean(${visibleNode('.git-history-expanded')})&&${selectors('.source-control-history [data-history-oid]')}.length===0`))
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
  const point = await first.cdp.evaluate(`(() => {const scroll=${visibleNode(repositoryPane + ' .git-history-scroll')},rect=scroll.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,delta:scroll.scrollHeight-scroll.clientHeight-Math.max(scroll.clientHeight,192)+24-scroll.scrollTop}})()`)
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
  await waitFor('root commit has no invented parent', () => visibleRead(first.cdp, `${visibleNode(pane(oldTarget.presentation.regionId) + ' .git-workbench__comparison')}?.textContent.includes('Empty tree')`))
  await click(first.cdp, selectors(pane(oldTarget.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('unloaded target stated without unbounded reads', () => visibleRead(first.cdp, `${visibleNode(repositoryPane + ' .git-workbench__locating')}?.textContent.includes('not been loaded')`))
  await delay(350)
  assert.equal((await settledHistory(first.cdp, repositoryPane)).loaded, unloaded.loaded, 'Locate alone must not exhaust unread history')
  for (let page = 0; page < 4; page++) {
    if (await first.cdp.evaluate(`Boolean(${visibleNode(repositoryPane + ' [data-history-oid="' + rootOid + '"]')})`)) break
    const prior = await settledHistory(first.cdp, repositoryPane)
    await click(first.cdp, `${selectors(repositoryPane + ' .git-workbench__locating button')}.filter(e=>e.textContent==='Read next history page')`)
    const next = await waitFor('one explicitly requested locating page', async () => { const v = await historyView(first.cdp, repositoryPane); return v?.loaded > prior.loaded ? v : null })
    assert.ok(next.loaded - prior.loaded <= 100, 'One explicit locate action reads a bounded page')
  }
  await waitFor('older fixed OID revealed in the virtual viewport', () => visibleRead(first.cdp, `(() => {const row=${visibleNode(repositoryPane + ' [data-history-oid="' + rootOid + '"]')},scroll=${visibleNode(repositoryPane + ' .git-history-scroll')};if(!row||!scroll)return false;const rowRect=row.getBoundingClientRect(),scrollRect=scroll.getBoundingClientRect();return rowRect.top>=scrollRect.top&&rowRect.bottom<=scrollRect.bottom})()`))
  receipt.olderLocation = await settledHistory(first.cdp, repositoryPane)
  await capture(first.cdp, 'older-commit-located-dark')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/topic/root-only')
  await settledHistory(first.cdp, repositoryPane)
  const outside = await open(parents[0])
  await click(first.cdp, selectors(pane(outside.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('outside range is distinct from unloaded', () => visibleRead(first.cdp, `${visibleNode(repositoryPane + ' .git-workbench__locating')}?.textContent.includes('outside the current history range')`))
  receipt.outsideLocation = await waitFor('outside target details and actual durable selection agree', async () => {
    const durable = (await state()).graph.resources['region:' + repositoryRegion.regionId]
    const details = await visibleRead(first.cdp, `(() => {const detail=${visibleNode(repositoryPane + ' .git-workbench__details')};return detail&&detail.getAttribute('aria-busy')==='false'?{oids:${selectors('.git-workbench__metadata code', 'detail')}.map(code=>code.textContent),parentOid:${visibleNode('[aria-label="Comparison parent"]', 'detail')}?.value}:null})()`)
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
  await selectGitView(first.cdp, 'Branches')
  receipt.publicRepositoryOpen = await open()
  assert.equal(receipt.publicRepositoryOpen.presentation.regionId, repositoryRegion.regionId)
  assert.equal((await toolSelection(first.cdp)).view, 'Branches', 'Repository navigation preserves the prior Git sidebar choice')
  await waitFor('pure branch remains a Git resource candidate', () => visibleRead(first.cdp,
    `${selectors('.branch-row')}.some(element=>element.textContent.includes('topic/pure-branch'))`))
  await capture(first.cdp, 'git-branches-dark-wide')

  // A new Diff Region requires this explicit separate-open action, after the inline assertion.
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff in separate tab"]'))
  const fixed = await waitFor('explicit independent fixed Diff', async () => {
    const current = await state(); return current.graph.regions.find(r => r.kind === 'git-diff' && current.graph.resources['region:' + r.regionId]?.comparison?.kind === 'commit')
  })
  await monaco(first.cdp, '', 'fixed commit body', fixed.regionId)
  await click(first.cdp, selectors(`button.workbench-tab[data-workbench-tab-id="${fixed.tabId}"]`), 'right')
  await waitFor('move Tab submenu', () => visibleRead(first.cdp, `(() => {const item=${selectors('[role="menuitem"]')}.find(element=>element.textContent.includes('Move Tab to New Group'));if(!item)return false;item.focus();return document.activeElement===item})()`))
  await press(first.cdp, 'ArrowRight')
  receipt.tabMoveMenu = await first.cdp.evaluate(`${selectors('[role="menuitem"]')}.map(element=>element.textContent)`)
  await click(first.cdp, `${selectors('[role="menuitem"]')}.filter(e=>e.textContent==='New Group Right')`)
  const splitState = await waitFor('durable split from actual Tab menu', async () => { const current = await state(); return current.graph.layouts[workspaceId]?.groups.length === 2 ? current : null })
  assert.equal(splitState.graph.layouts[workspaceId].root.type, 'split')
  await selectGitView(first.cdp, 'History')
  receipt.toolsBeforeQuit = await waitFor('tool and Git view reach ordinary durable preferences', async () => {
    const selected = await toolSelection(first.cdp)
    return selected.tool === 'git' && selected.view === 'History' && selected.storedTool === 'git' &&
      selected.storedView === 'history' ? selected : null
  })
  assert.equal(receipt.toolsBeforeQuit.commitDrafts[JSON.stringify([workspaceId, mainWorkspace.hostId, workspacePath])], mainDraft)
  assert.equal(receipt.toolsBeforeQuit.commitDrafts[JSON.stringify([reviewWorkspace.id, reviewWorkspace.hostId, reviewWorktreePath])], reviewDraft)
  await capture(first.cdp, 'git-tools-before-restart-dark-wide', 1600)
  await loadedBundles(first.cdp, 'first-before-quit')
  const originalState = await state(); receipt.originalState = originalState
  assert.deepEqual(await gitState(), unchanged, 'Every UI/public read retained HEAD, index and exact dirty file bytes')
  assert.deepEqual(await reviewGitState(), reviewUnchanged, 'The second staged worktree remains unchanged before the first quit')
  receipt.gitPreservation = { before: unchanged, after: await gitState() }
  receipt.firstExit = await normalQuit(first)
  await git('branch', '-f', 'topic/pure-branch', rootOid)
  await git('update-ref', 'refs/heads/main', rootOid, mergeOid)
  const moved = await gitState(); assert.equal(moved.head, rootOid)
  receipt.intentionalRefMove = { from: mergeOid, to: rootOid, baseline: moved }
  second = await launch('second'); phase = 'real-restart'
  receipt.toolsAfterRestart = await waitFor('original Git tool and view restored before any navigation', async () => {
    const selected = await toolSelection(second.cdp)
    return selected.tool === 'git' && selected.view === 'History' && selected.storedTool === 'git' &&
      selected.storedView === 'history' ? selected : null
  })
  assert.deepEqual(receipt.toolsAfterRestart, receipt.toolsBeforeQuit)
  await capture(second.cdp, 'git-tools-restored-before-navigation-dark-wide', 1600)
  const restored = await waitFor('original Git Region after ordinary restart', async () => {
    const current = await state(); return current.graph.regions.some(r => r.regionId === repositoryRegion.regionId) ? current : null
  })
  assert.deepEqual(restored, originalState)
  await focused(second.cdp, repositoryRegion.regionId)
  await waitFor('same selected fixed commit reread', () => visibleRead(second.cdp, `${visibleNode(repositoryPane + ' .git-workbench__target')}?.textContent.includes(${JSON.stringify(mergeOid.slice(0,12))})`))
  receipt.restoredInlineCanvas = await monaco(second.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  assert.equal(restored.graph.resources['region:' + repositoryRegion.regionId].history.reference, 'refs/heads/main')
  assert.equal(restored.graph.resources['region:' + repositoryRegion.regionId].file.path, 'changed.ts')
  await control('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: fixed.regionId } })
  receipt.restoredCanvas = await monaco(second.cdp, '', 'fixed commit body', fixed.regionId)
  await capture(second.cdp, 'restored-inline-and-explicit-diff-dark', 1600)
  assert.deepEqual(await gitState(), moved, 'Restored reads preserve intentionally moved HEAD and original dirty files')
  receipt.reviewGitAfterRestart = await reviewGitState()
  assert.deepEqual(receipt.reviewGitAfterRestart, reviewUnchanged, 'Ordinary restart keeps the second worktree HEAD, index and staged bytes')
  await loadedBundles(second.cdp, 'second-before-quit')
  receipt.secondExit = await normalQuit(second)
  receipt.identityAfter = await identity(); assert.deepEqual(receipt.identityAfter, receipt.identityBefore)
  await assertFrozenSource('after-native-restart')
  receipt.passed = true
} catch (error) {
  failure = { phase, message: error.message, stack: error.stack }; receipt.failure = failure
  const active = second ?? first
  if (active) { try {
    receipt.failureVisibility = await active.cdp.evaluate('({visibility:document.visibilityState,documentFocused:document.hasFocus()})')
    receipt.failureNative = await active.main.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron'); const w = e.BrowserWindow.getAllWindows()[0]; return {visible:w.isVisible(),focused:w.isFocused()} })()`)
    receipt.failureSpatialState = await state()
    receipt.failureDom = await active.cdp.evaluate('document.body.innerText.slice(-6000)'); receipt.failureLayout=await active.cdp.evaluate(`${selectors('.git-branch-diff,.git-branch-diff > *,.monaco-diff-editor')}.map(element=>({classes:element.className,width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,display:getComputedStyle(element).display,gridRows:getComputedStyle(element).gridTemplateRows}))`); await capture(active.cdp, 'failure')
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
