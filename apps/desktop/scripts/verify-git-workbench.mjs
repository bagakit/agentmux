import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createGitWorkbenchFixture } from './fixtures/git-workbench/repository.mjs'
import { consumeGitWorkbenchReceipt } from './fixtures/git-workbench/receipt.mjs'

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
if (Object.hasOwn(process.env, 'AGENTMUX_GIT_WORKBENCH_RECEIPT')) {
  try {
    assert.ok(process.env.AGENTMUX_GIT_WORKBENCH_RECEIPT, 'Explicit receipt consumption requires a nonempty receipt path')
    const reused = await consumeGitWorkbenchReceipt({ receiptPath: process.env.AGENTMUX_GIT_WORKBENCH_RECEIPT,
      repositoryRoot, expectedRevision, expectedSourceDigest, sourceManifest })
    process.stdout.write(JSON.stringify(reused) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ passed: false, exactEvidenceReused: false, newNativeProofRuns: 0,
      receipt: process.env.AGENTMUX_GIT_WORKBENCH_RECEIPT, failure: error.message, fallback: 'disabled' }) + '\n')
    process.exit(1)
  }
  process.exit(0)
}
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
let connectAgentMuxRpc
const exec = promisify(execFile)
const delay = ms => new Promise(done => setTimeout(done, ms))
const commonDirectory = (await exec('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
const evidenceRoot = resolve(commonDirectory, '..', '.bagakit/feature-tracker/git-history-navigation')
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
const receipt = { schema: 'agentmux.git-reading-surfaces.v2', expectedRevision, expectedSourceDigest, sourceRoot: repositoryRoot,
  passed: false, captureOnly: true, builds: [], screenshots: [], cleanup: {}, aestheticReview: 'not-performed',
  boundary: 'Actual private built Desktop/Main/preload/Renderer, original Store, public CLI/RPC and real Git. Same private profile across two ordinary process exits. No user App/profile, user Run or Provider conversation recovery is exercised.' }
let phase = 'prepare', failure, first, second, frozenSource, frozenTrackedChanges
// This probe is a separate local user client, never the surrounding managed Agent.
const privateEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:AGENTMUX_|CTXMUX_)/u.test(name) && name !== 'ELECTRON_RENDERER_URL' && name !== 'ELECTRON_RUN_AS_NODE'))
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(physicalRuntimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(physicalRuntimeDirectory, 'state/spatial-state.json'),
  AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'), CODEX_HOME: codexHome }
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
async function git(...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {}
  if (!options.input) return (await exec('git', ['-C', workspacePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout
  return await new Promise((done, fail) => {
    const child = execFile('git', ['-C', workspacePath, ...args], { env: gitEnv, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => error ? fail(error) : done(stdout))
    child.stdin.end(options.input)
  })
}
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
  const nativeUserData = await main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.getPath('userData')`)
  assert.equal(nativeUserData, userData, 'Both real processes must use this round\'s private profile')
  receipt[label] = { pid: child.pid, home, nativeHome, nativeUserData, ready, origin: await cdp.evaluate('({href:location.href,origin:location.origin})') }
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
  const attempt = method === 'git.open' ? { method, params, startedAtMs: Date.now() } : null
  if (attempt) (receipt.publicRpcNavigation ??= []).push(attempt)
  /** @type {import('../../../packages/core/dist/public-rpc-client.js').AgentMuxRpcClient} */
  let rpc
  try {
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
    const result = await rpc.call(method, params)
    if (attempt) attempt.result = result
    return result
  } catch (error) {
    if (attempt) attempt.failure = { name: error.name, code: error.code, message: error.message, data: error.data, details: error.details }
    throw error
  } finally {
    if (attempt) attempt.endedAtMs = Date.now()
    await rpc?.dispose()
  }
}
async function cliGit(action, options = []) {
  await activate(first.cdp)
  const operationId = action === 'open' ? randomUUID() : null
  const args = [join(repositoryRoot, 'packages/core/bin/amux'), '--endpoint', 'unix:' + join(runtimeDirectory, 'control.sock'),
    'git', action, '--workspace', workspaceId, '--host', 'local', '--workspace-path', workspacePath, ...options,
    ...(operationId ? ['--operation-id', operationId] : [])]
  const attempt = { action, args, operationId, startedAtMs: Date.now() }
  ;(receipt.publicCliCalls ??= []).push(attempt)
  let result
  try {
    result = await exec(process.execPath, args, { cwd: repositoryRoot, env: { ...privateEnvironment, ...fixtureEnvironment }, timeout: 20_000 })
    attempt.stdout = result.stdout; attempt.stderr = result.stderr; attempt.exitCode = 0
  } catch (error) {
    Object.assign(attempt, { exitCode: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr, failure: error.message })
    throw error
  } finally { attempt.endedAtMs = Date.now() }
  const envelope = JSON.parse(result.stdout)
  assert.equal(envelope.ok, true); assert.equal(envelope.operation, 'git.' + action)
  await activate(first.cdp)
  return { args, operationId, result: envelope.result }
}
async function cliOpen(oid) { return await cliGit('open', oid ? ['--oid', oid] : []) }
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
  const png = Buffer.from(data, 'base64'), dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  assert.deepEqual(dimensions, { width, height: 900 }, 'Capture the entire requested viewport, not a cropped component')
  const path = join(artifacts, name + '.png'); await writeFile(path, png)
  receipt.screenshots.push({ path, width, theme, dimensions, tools, targets, sha256: digest(png) })
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
  await bundles('apps/desktop/out/main')
  await bundles('apps/desktop/out/preload')
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
  const virtualKeyCode = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Home: 36, End: 35, Backspace: 8, Tab: 9 }[key]
  const input = { key, code: key, ...(virtualKeyCode ? { windowsVirtualKeyCode: virtualKeyCode } : {}) }
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...input })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...input })
}
async function typeSearch(cdp, selector, text) {
  await click(cdp, selectors(selector))
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers, windowsVirtualKeyCode: 65 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers, windowsVirtualKeyCode: 65 })
  await press(cdp, 'Backspace')
  if (text) await cdp.call('Input.insertText', { text })
  await waitFor('actual reference query input', () => cdp.evaluate(`${visibleNode(selector)}?.value===${JSON.stringify(text)}`))
}
async function nativeSelectPrefix(cdp, selector, key) {
  await activate(cdp)
  await cdp.evaluate(visibleNode(selector) + '.focus()')
  const code = 'Key' + key.toUpperCase(), windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key, unmodifiedText: key })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}
async function startGitObservation(probe) {
  const sources = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.js')) sources.push({ path, url: pathToFileURL(path).href, source: await readFile(path, 'utf8') })
    }
  }
  await visit(join(desktopRoot, 'out/main'))
  assert.ok(sources.length > 0)
  const methods = ['history', 'commitDetails', 'commitDiff', 'branchDiff', 'stage', 'commit', 'unstage', 'discard', 'push', 'pull', 'fetch']
  const markers = Object.fromEntries(methods.map(method => {
    const expression = new RegExp('return this\\.repository\\(workspaceId, config\\)\\.' + method + '\\(', 'g')
    const matches = sources.flatMap(({ path, url, source }) => [...source.matchAll(expression)].map(match => ({ path, url, offset: match.index })))
    assert.ok(matches.length > 0, 'The original GitService method must actually compile: ' + method)
    return [method, matches]
  }))
  await probe.main.call('Profiler.enable')
  await probe.main.call('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
  probe.gitObservation = { markers, sources: Object.fromEntries(sources.map(({ path, source }) => [path.slice(repositoryRoot.length + 1), digest(source)])) }
  await gitObservation(probe, 'start')
}
async function gitObservation(probe, label) {
  const covered = await probe.main.call('Profiler.takePreciseCoverage')
  const counts = Object.fromEntries(Object.entries(probe.gitObservation.markers).map(([method, markers]) => {
    const count = markers.reduce((total, marker) => {
      const functions = covered.result.filter(script => script.url === marker.path || script.url === marker.url)
        .flatMap(script => script.functions).filter(item => item.functionName === method &&
          item.ranges.some(range => range.startOffset <= marker.offset && range.endOffset > marker.offset))
      assert.ok(functions.length <= 1, 'Only the original GitService function may satisfy a read count')
      return total + (functions[0]?.ranges[0]?.count ?? 0)
    }, 0)
    return [method, count]
  }))
  const result = { label, pid: probe.child.pid, counts, sources: probe.gitObservation.sources,
    conditions: 'Main V8 precise call coverage, original GitService bodies; counts reset at each checkpoint. Observation overhead is present; elapsed search timings are diagnostic only.' }
  ;(receipt.gitOwnerObservations ??= []).push(result)
  return result
}
const referenceSearch = '[aria-label="Search history references"]'
async function pickerView(cdp) {
  return await cdp.evaluate(`(() => {const dialog=${visibleNode('[role="dialog"][aria-label="History references"]')};if(!dialog)return null;const input=${visibleNode(referenceSearch, 'dialog')};return {query:input?.value,focused:document.activeElement===input,count:${visibleNode('.git-history-ref-picker__count', 'dialog')}?.textContent,empty:dialog.textContent.includes('No matching references.'),options:${selectors('[role="option"]', 'dialog')}.map(option=>({value:option.getAttribute('data-value'),kind:${visibleNode('.git-history-ref-picker__kind', 'option')}?.textContent,active:option.getAttribute('data-active')==='true',position:Number(option.getAttribute('aria-posinset')),size:Number(option.getAttribute('aria-setsize'))}))}})()`)
}
async function reference(cdp, regionId, value, scope = '.source-control-history') {
  const selector = scope + ' [aria-label="History reference"]'
  const before = await cdp.evaluate(`(() => {const elements=${selectors(selector)},trigger=elements[0];return {matches:elements.length,value:trigger?.getAttribute('data-value'),workspaceId:trigger?.closest('[data-git-workspace]')?.getAttribute('data-git-workspace')}})()`)
  assert.equal(before.matches, 1, 'Choose one exact visible History owner, never a retained hidden tool')
  const resource = regionId ? (await state()).graph.resources['region:' + regionId] : null
  if (resource) assert.equal(before.workspaceId, resource.workspaceId)
  await click(cdp, selectors(selector))
  await waitFor('reference dialog receives actual keyboard focus', async () => (await pickerView(cdp))?.focused)
  await typeSearch(cdp, referenceSearch, value)
  const filtered = await waitFor('exact full reference appears in the observed choices', async () => {
    const view = await pickerView(cdp)
    return view?.query === value && view.options.some(option => option.value === value) ? view : null
  })
  await press(cdp, 'ArrowDown')
  const active = await pickerView(cdp)
  assert.equal(active.options.find(option => option.active)?.value, value, 'Keyboard selection uses the complete ref name')
  await press(cdp, 'Enter')
  await waitFor('chosen reference and focus return to the original trigger', () => cdp.evaluate(`(() => {const trigger=${visibleNode(selector)};return trigger?.getAttribute('data-value')===${JSON.stringify(value)}&&trigger===document.activeElement&&!document.querySelector('[aria-label="Search history references"]')})()`))
  const completed = await settledHistory(cdp, scope)
  assert.equal(completed.range, value)
  const interaction = { regionId, requested: value, before, filtered, active, history: completed }
  if (resource) {
    interaction.durable = (await state()).graph.resources['region:' + regionId]
    assert.deepEqual(interaction.durable.scope, resource.scope)
    assert.equal(interaction.durable.history?.reference ?? '', value)
  }
  ;(receipt.referenceInteractions ??= []).push(interaction)
  return interaction
}
async function historyView(cdp, scope) {
  await activate(cdp)
  return await cdp.evaluate(`(() => { const root=${visibleNode(scope)},scroll=${visibleNode('.git-history-scroll', 'root')};if(!scroll)return null;const rows=${selectors('[data-history-oid]', 'scroll')};return {range:${visibleNode('[aria-label="History reference"]', 'root')}?.getAttribute('data-value'),loaded:Number(/^(\\d+) commits/.exec(${visibleNode('.git-history-footer', 'scroll')}?.textContent??'')?.[1]),scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,viewport:scroll.clientHeight,drawn:rows.length,graphNodes:${selectors('.git-history-node', 'scroll')}.length,rows:rows.map(row=>({oid:row.dataset.historyOid,index:Number(row.dataset.historyIndex),selected:row.getAttribute('aria-current')})),edges:${selectors('[data-child-oid]', 'scroll')}.map(edge=>({child:edge.dataset.childOid,parent:edge.dataset.parentOid}))} })()`)
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
async function commitView(cdp, regionId, oid) {
  return await waitFor('completed immutable commit details', () => visibleRead(cdp, `(() => {const detail=${visibleNode(pane(regionId) + ' .git-workbench__details')};if(!detail||detail.getAttribute('aria-busy')!=='false')return null;const oids=${selectors('.git-workbench__metadata code', 'detail')}.map(element=>element.textContent);if(!oids.includes(${JSON.stringify(oid)}))return null;return {oids,heading:${visibleNode('.git-workbench__message-heading', 'detail')}?.textContent,body:${visibleNode('.git-workbench__message-body', 'detail')}?.textContent,raw:detail.querySelector('.git-workbench__message')?.textContent,format:${visibleNode('[aria-label="Commit message format"]', 'detail')}?.textContent??null,parent:${visibleNode('[aria-label="Comparison parent"]', 'detail')}?.value??null,author:${visibleNode('.git-workbench__author-initials', 'detail')}?.getAttribute('aria-label'),changes:${selectors('[aria-label="File change summary"] li', 'detail')}.map(element=>element.textContent),files:${selectors('.git-workbench__files button', 'detail')}.map(element=>element.getAttribute('aria-label'))}})()`))
}
async function onlyHistory(cdp, regionId) {
  const result = await visibleRead(cdp, `({panels:${selectors('.git-history-panel')}.length,sidebar:${selectors('.source-control-history .git-history-panel')}.length,main:${selectors(pane(regionId) + ' .git-history-panel')}.length,references:${selectors('[aria-label="History reference"]')}.length,replaced:${selectors('.git-history-expanded')}.length})`)
  assert.deepEqual(result, { panels: 1, sidebar: 1, main: 0, references: 1, replaced: 0 })
  return result
}
function readOnlyObservation(observation) {
  for (const method of ['stage', 'commit', 'unstage', 'discard', 'push', 'pull', 'fetch']) assert.equal(observation.counts[method], 0, method + ' must not run during Git reading')
  return observation
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
  receipt.source.manifestSha256 = digest(await readFile(join(artifacts, 'source-manifest.json')))
  await writeFile(join(artifacts, 'source-tracked.diff'), frozenTrackedChanges.patch)
  await buildCandidate('client-ui', ['--filter', '@agentmux/client-ui...', 'build'])
  await buildCandidate('desktop', ['--filter', '@agentmux/desktop', 'build'])
  ;({ connectAgentMuxRpc } = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/public-rpc-client.js'))))
  deadline = Date.now() + 480_000
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
  receipt.buildIdentity = { path: 'build-identity.json', sha256: digest(await readFile(join(artifacts, 'build-identity.json'))) }
  await assertFrozenSource('before-fixture')
  receipt.fixture = await createGitWorkbenchFixture({ workspacePath, reviewWorktreePath, reviewBranch, mainStagedPath, reviewStagedPath, git, reviewGit })
  const { rootOid, featureOid, mergeOid, parents, longPath, oldTipRef, errorRef } = receipt.fixture
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
  await startGitObservation(first)
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
  await click(first.cdp, selectors('[aria-label="Zones"] button[aria-label="Manage worktrees"]'))
  receipt.worktreeManagementNavigation = await waitFor('worktree management entry reaches the original Git Branches owner', async () => {
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
  receipt.cliRepositoryOpen = await cliOpen()
  const repositoryRegion = (await state()).graph.regions.find(region => region.regionId === receipt.cliRepositoryOpen.result.presentation.regionId)
  assert.ok(repositoryRegion)
  const repositoryPane = pane(repositoryRegion.regionId)
  await waitFor('public repository navigation reveals its exact existing review Region', () => visibleRead(first.cdp,
    visibleNode(repositoryPane) + "?.getAttribute('aria-label')==='Git repository review'"))
  assert.equal((await state()).graph.resources['region:' + repositoryRegion.regionId].selection, null)
  assert.deepEqual(Object.keys(receipt.cliRepositoryOpen.result.read.snapshot).sort(), ['hostId', 'repoPath'])
  const repositoryTools = await toolSelection(first.cdp)
  assert.equal(repositoryTools.tool, 'git'); assert.equal(repositoryTools.view, 'History')
  assert.equal(repositoryTools.workface.zoneId, mainZone.zoneId)
  receipt.uniqueHistory = await onlyHistory(first.cdp, repositoryRegion.regionId)
  await capture(first.cdp, 'repository-no-implicit-selection-dark-wide')

  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + mergeOid + '"] > strong'))
  await waitFor('sidebar click itself reveals the original repository review', () => visibleRead(first.cdp,
    'Boolean(' + visibleNode(repositoryPane + ' .git-workbench__details') + ')'))
  const selectedMerge = await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
  assert.ok(selectedMerge.body.includes(receipt.fixture.mergeBody))
  assert.ok(selectedMerge.oids.includes(parents[1]))
  assert.match(selectedMerge.author, /not a verified photo or identity/u)
  assert.equal((await state()).graph.resources['region:' + repositoryRegion.regionId].selection.commitOid, mergeOid)
  const afterSelection = await settledHistory(first.cdp, sidebar)
  assert.equal(afterSelection.range, sidebarStart.range); assert.equal(afterSelection.loaded, sidebarStart.loaded)
  assert.ok(Math.abs(afterSelection.scrollTop - sidebarStart.scrollTop) <= 1)
  receipt.commitOnly = { regionId: repositoryRegion.regionId, originalWindow: sidebarStart, afterSelection,
    uniqueHistory: await onlyHistory(first.cdp, repositoryRegion.regionId) }
  await capture(first.cdp, 'merge-commit-dark-wide')
  await capture(first.cdp, 'merge-commit-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')

  const publicTarget = { workspaceId, expectedResource: { hostId: 'local', workspacePath } }
  receipt.publicCommit = await control('git.commit', { ...publicTarget, oid: mergeOid, parentOid: parents[0] })
  assert.equal(receipt.publicCommit.snapshot.commitOid, mergeOid)
  assert.equal(selectedMerge.raw, receipt.publicCommit.commit.message)
  receipt.publicDiff = await control('git.diff', { ...publicTarget, input: { kind: 'commit', snapshot: receipt.publicCommit.snapshot, file: { path: 'changed.ts', origPath: null } } })
  assert.equal(receipt.publicDiff.new.text, 'fixed commit body\n')
  receipt.cliCommitRead = await cliGit('commit', ['--oid', mergeOid, '--parent', parents[0]])
  assert.deepEqual(receipt.cliCommitRead.result.snapshot, receipt.publicCommit.snapshot)
  const diffInput = join(root, 'public-fixed-diff.json')
  await writeFile(diffInput, JSON.stringify({ kind: 'commit', snapshot: receipt.publicCommit.snapshot, file: { path: 'changed.ts', origPath: null } }))
  receipt.cliDiffRead = await cliGit('diff', ['--input', diffInput])
  assert.equal(receipt.cliDiffRead.result.new.text, 'fixed commit body\n')
  receipt.cliCommitOpen = await cliOpen(mergeOid)
  const independentRegionId = receipt.cliCommitOpen.result.presentation.regionId
  assert.notEqual(independentRegionId, repositoryRegion.regionId, 'A fixed public commit is not the reusable repository review')
  assert.equal(receipt.cliCommitOpen.result.read.snapshot.commitOid, mergeOid)
  const full = await open(mergeOid)
  assert.equal(full.presentation.regionId, independentRegionId)
  const otherParent = await open(mergeOid, parents[1])
  assert.notEqual(otherParent.presentation.regionId, independentRegionId)
  assert.notEqual(otherParent.presentation.regionId, repositoryRegion.regionId)
  const secondParent = await commitView(first.cdp, otherParent.presentation.regionId, mergeOid)
  assert.equal(secondParent.parent, parents[1])
  assert.ok(secondParent.files.includes('Open diff for main.ts'))
  receipt.parentOpens = { first: full, second: otherParent, secondParent }
  const independentBefore = (await state()).graph.resources['region:' + independentRegionId]

  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + featureOid + '"] > strong'))
  const standard = await commitView(first.cdp, repositoryRegion.regionId, featureOid)
  assert.equal(standard.heading, 'Keep fixed commit messages and file changes readable')
  assert.ok(standard.format.includes('feat') && standard.format.includes('review') && standard.format.includes('Breaking change'))
  assert.ok(standard.body.includes(receipt.fixture.standardBody))
  const standardRead = await control('git.commit', { ...publicTarget, oid: featureOid })
  assert.equal(standard.raw, standardRead.commit.message)
  const expectedChanges = new Map()
  for (const entry of standardRead.entries) expectedChanges.set(entry.change, (expectedChanges.get(entry.change) ?? 0) + 1)
  assert.deepEqual(standard.changes.sort(), [...expectedChanges].map(([change, count]) => count + ' ' + change.replace('-', ' ')).sort())
  assert.deepEqual((await state()).graph.resources['region:' + independentRegionId], independentBefore,
    'Continuous sidebar choices cannot replace an independently fixed commit')
  await click(first.cdp, selectors(repositoryPane + ' .git-workbench__raw-message summary'))
  await waitFor('complete original standard message is visibly readable', () => visibleRead(first.cdp,
    'Boolean(' + visibleNode(repositoryPane + ' .git-workbench__raw-message[open] .git-workbench__message') + ')'))
  receipt.standardCommit = { dom: standard, read: standardRead }
  await capture(first.cdp, 'standard-message-dark-wide')
  await capture(first.cdp, 'standard-message-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  await click(first.cdp, selectors(repositoryPane + ' .git-workbench__raw-message summary'))

  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + mergeOid + '"] > strong'))
  await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
  const parentSelector = repositoryPane + ' [aria-label="Comparison parent"]'
  await nativeSelectPrefix(first.cdp, parentSelector, 'p')
  await waitFor('actual comparison parent input updates the same immutable Region', async () =>
    (await commitView(first.cdp, repositoryRegion.regionId, mergeOid)).parent === parents[1])
  const alternate = await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
  assert.ok(alternate.files.includes('Open diff for main.ts'))
  receipt.parentInput = { before: parents[0], after: alternate }
  await capture(first.cdp, 'merge-second-parent-dark-wide')
  await nativeSelectPrefix(first.cdp, parentSelector, 'f')
  await waitFor('first parent restored through actual input', async () =>
    (await commitView(first.cdp, repositoryRegion.regionId, mergeOid)).parent === parents[0])

  const beforeInline = await state()
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for changed.ts"]'))
  receipt.canvas = await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  const afterInline = await state()
  assert.deepEqual(afterInline.graph.regions.map(region => region.regionId), beforeInline.graph.regions.map(region => region.regionId))
  assert.equal(afterInline.graph.resources['region:' + repositoryRegion.regionId].file.path, 'changed.ts')
  receipt.inlineRegion = { regionId: repositoryRegion.regionId, regionsBefore: beforeInline.graph.regions.length,
    regionsAfter: afterInline.graph.regions.length, file: afterInline.graph.resources['region:' + repositoryRegion.regionId].file }
  const editor = await first.cdp.evaluate('(() => {const input=' + visibleNode(repositoryPane + ' .editor.modified textarea') + ';if(!input)return false;input.focus();return true})()')
  assert.ok(editor)
  await first.cdp.call('Input.insertText', { text: 'UNAUTHORIZED EDIT MUST NOT APPEAR' })
  receipt.readonlyCanvas = await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  await capture(first.cdp, 'inline-diff-dark-wide')
  await capture(first.cdp, 'inline-diff-light-wide', 1280, 'light')
  await capture(first.cdp, 'inline-diff-dark-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId))
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for ' + longPath + '"]'))
  await monaco(first.cdp, '', 'long path fixed body', repositoryRegion.regionId, true)
  await capture(first.cdp, 'inline-diff-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for changed.ts"]'))
  await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)

  await reference(first.cdp, repositoryRegion.regionId, '')
  const allRead = await control('git.history', { ...publicTarget, limit: 50 })
  assert.equal(allRead.kind, 'ready'); assert.ok(allRead.nextCursor)
  assert.ok(!allRead.commits.some(commit => commit.oid === rootOid))
  assert.ok(allRead.snapshot.refs.some(ref => ref.name === oldTipRef && ref.oid === rootOid))
  assert.ok(allRead.snapshot.refs.length > 640)
  readOnlyObservation(await gitObservation(first, 'before-manyrefs-input'))
  await click(first.cdp, selectors(sidebar + ' [aria-label="History reference"]'))
  const manyRefs = await waitFor('nonempty windowed choices for the complete observed reference set', async () => {
    const view = await pickerView(first.cdp)
    return view?.focused && view.options.length > 0 ? view : null
  })
  const pickerGeometry = await first.cdp.evaluate('(() => {const list=' + visibleNode('[aria-label="History reference choices"]') +
    ',row=list.querySelector("[role=option]");return {viewport:list.clientHeight,scrollHeight:list.scrollHeight,rowHeight:row.getBoundingClientRect().height}})()')
  assert.ok(manyRefs.options[0].size >= allRead.snapshot.refs.length)
  assert.ok(manyRefs.options.length <= Math.ceil(pickerGeometry.viewport / pickerGeometry.rowHeight) + 10,
    'Rendered choices follow the viewport plus current virtualizer overscan, not hundreds of references')
  assert.ok(pickerGeometry.scrollHeight > pickerGeometry.viewport)
  await press(first.cdp, 'ArrowUp')
  const lastChoices = await waitFor('keyboard reaches the far end of the virtualized reference list', async () => {
    const view = await pickerView(first.cdp)
    return view?.options.some(option => option.active && option.position === option.size) ? view : null
  })
  assert.ok(lastChoices.options.length <= Math.ceil(pickerGeometry.viewport / pickerGeometry.rowHeight) + 10)
  await press(first.cdp, 'Home')
  await waitFor('keyboard Home returns to the actual All choice without selecting it', async () =>
    (await pickerView(first.cdp))?.options.some(option => option.active && option.value === ''))
  await capture(first.cdp, 'manyrefs-dark-wide')
  await capture(first.cdp, 'manyrefs-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  const queryStarted = Date.now()
  await typeSearch(first.cdp, referenceSearch, 'no-such-observed-reference')
  const empty = await waitFor('zero matches stay distinct from an empty repository', async () => {
    const view = await pickerView(first.cdp)
    return view?.empty && view.options.length === 0 ? view : null
  })
  const queryElapsedMs = Date.now() - queryStarted
  assert.ok((await historyView(first.cdp, sidebar)).loaded > 0)
  await capture(first.cdp, 'empty-reference-search-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  await click(first.cdp, selectors('[aria-label="Clear reference search"]'))
  const cleared = await waitFor('clear returns the original complete observed choices', async () => {
    const view = await pickerView(first.cdp)
    return view?.query === '' && view.focused && view.options.length > 0 ? view : null
  })
  await press(first.cdp, 'Escape')
  assert.equal(await first.cdp.evaluate('document.activeElement===' + visibleNode(sidebar + ' [aria-label="History reference"]')), true)
  const searchOwner = readOnlyObservation(await gitObservation(first, 'manyrefs-search-clear-escape'))
  assert.equal(searchOwner.counts.history, 0); assert.equal(searchOwner.counts.commitDetails, 0)
  receipt.manyRefs = { observed: allRead.snapshot.refs.length, options: manyRefs, lastChoices, pickerGeometry, empty, cleared, queryElapsedMs,
    owner: searchOwner, conditions: { width: receipt.screenshots.at(-1).width, height: 900, input: 'trusted Chromium text and keyboard input', timing: 'Includes input transport, UI observation and precise Main coverage overhead; diagnostic, not a permanent latency limit.' } }
  const oldTip = await reference(first.cdp, repositoryRegion.regionId, oldTipRef)
  const directOwner = readOnlyObservation(await gitObservation(first, 'old-tip-direct-reference'))
  assert.equal(directOwner.counts.history, 1, 'Old tip confirmation reads one bounded page, not the preceding All pages')
  assert.equal(oldTip.history.loaded, 1)
  assert.equal(oldTip.history.rows[0].oid, rootOid)
  const oldTipRead = await control('git.history', { ...publicTarget, ref: oldTipRef, limit: 50 })
  const oldTipCli = await cliGit('history', ['--ref', oldTipRef, '--limit', '50'])
  assert.equal(oldTipRead.commits[0].oid, rootOid); assert.equal(oldTipRead.nextCursor, null)
  assert.equal(oldTipCli.result.commits[0].oid, rootOid); assert.equal(oldTipCli.result.nextCursor, null)
  receipt.oldTipDirect = { interaction: oldTip, owner: directOwner, rpc: oldTipRead, cli: oldTipCli }
  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + rootOid + '"] > strong'))
  const plain = await commitView(first.cdp, repositoryRegion.regionId, rootOid)
  assert.equal(plain.heading, 'Initial repository'); assert.equal(plain.format, null); assert.equal(plain.parent, null)
  assert.ok(plain.body.includes('Literal <b>markup</b> remains text.'))
  assert.equal(await first.cdp.evaluate(selectors(repositoryPane + ' .git-workbench__message-body b').concat('.length')), 0)
  await click(first.cdp, selectors(repositoryPane + ' .git-workbench__raw-message summary'))
  await waitFor('original nonstandard message can actually be opened', () => visibleRead(first.cdp,
    'Boolean(' + visibleNode(repositoryPane + ' .git-workbench__raw-message[open] .git-workbench__message') + ')'))
  receipt.nonstandardCommit = plain
  await capture(first.cdp, 'old-tip-nonstandard-message-dark-wide')
  await capture(first.cdp, 'old-tip-nonstandard-message-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  await click(first.cdp, selectors(repositoryPane + ' .git-workbench__raw-message summary'))

  const remoteMain = await reference(first.cdp, repositoryRegion.regionId, 'refs/remotes/origin/main')
  assert.equal(remoteMain.history.rows[0].oid, featureOid)
  assert.equal(remoteMain.filtered.options[0].kind, 'Remote')
  const localMain = await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/main')
  assert.equal(localMain.history.rows[0].oid, mergeOid)
  assert.equal(localMain.filtered.options[0].kind, 'Local')
  receipt.sameNamedReferences = { local: localMain, remote: remoteMain }
  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + mergeOid + '"] > strong'))
  await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for changed.ts"]'))
  await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  await reference(first.cdp, repositoryRegion.regionId, errorRef)
  const beforeFailure = (await state()).graph.resources['region:' + repositoryRegion.regionId]
  try {
    await git('update-ref', '-d', errorRef, mergeOid)
    await click(first.cdp, selectors(sidebar + ' [aria-label="Refresh history"]'))
    await waitFor('real missing reference produces an explicit history error', () => visibleRead(first.cdp,
      'Boolean(' + visibleNode(sidebar + ' .git-history-error[role="alert"]') + ')'))
    const failed = (await state()).graph.resources['region:' + repositoryRegion.regionId]
    assert.deepEqual(failed, beforeFailure, 'An unavailable reference cannot remove the original fixed commit or file')
    await click(first.cdp, selectors(repositoryPane + ' [aria-label="Reload commit details"]'))
    await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
    await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
    receipt.historyFailure = { cause: 'Deleted only the selected private fixture reference, preserving its original OID and all objects.', before: beforeFailure, after: failed,
      message: await first.cdp.evaluate(visibleNode(sidebar + ' .git-history-error') + '.textContent'),
      independentRegion: (await state()).graph.resources['region:' + independentRegionId] }
    assert.deepEqual(receipt.historyFailure.independentRegion, independentBefore)
    await capture(first.cdp, 'history-unavailable-fixed-review-dark-wide')
    await capture(first.cdp, 'history-unavailable-fixed-review-light-narrow', await narrowWidth(first.cdp, repositoryRegion.regionId), 'light')
  } finally {
    await git('update-ref', errorRef, mergeOid)
  }
  await click(first.cdp, selectors(sidebar + ' [aria-label="Refresh history"]'))
  await settledHistory(first.cdp, sidebar)
  await waitFor('restored reference clears its original error', () => visibleRead(first.cdp,
    selectors(sidebar + ' .git-history-error').concat('.length===0')))
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/main')
  const initial = await settledHistory(first.cdp, sidebar)
  const point = await first.cdp.evaluate('(() => {const scroll=' + visibleNode(sidebar + ' .git-history-scroll') +
    ',rect=scroll.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,delta:scroll.scrollHeight-scroll.clientHeight-Math.max(scroll.clientHeight,192)+24-scroll.scrollTop}})()')
  assert.ok(point.delta > 0)
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: point.delta })
  await waitFor('the sole sidebar tree prefetches before its original edge', async () => (await historyView(first.cdp, sidebar))?.loaded > initial.loaded)
  const appended = await settledHistory(first.cdp, sidebar)
  receipt.autoload = { before: initial.loaded, after: appended.loaded, scrollTop: appended.scrollTop, viewport: appended.viewport,
    originalScrollHeight: initial.scrollHeight, originalPageRemaining: initial.scrollHeight - appended.scrollTop - appended.viewport,
    drawn: appended.drawn, graphNodes: appended.graphNodes }
  assert.ok(receipt.autoload.originalPageRemaining > 0)
  assert.equal(appended.drawn, appended.graphNodes); assert.ok(appended.drawn < appended.loaded)
  const parentMap = new Map((await git('log', '--all', '--format=%H %P')).trim().split('\n').map(line => {
    const [oid, ...commitParents] = line.split(' '); return [oid, commitParents]
  }))
  assert.ok(appended.edges.length > 0)
  for (const edge of appended.edges) assert.ok(parentMap.get(edge.child)?.includes(edge.parent))
  await capture(first.cdp, 'history-window-dark-scrolled')
  readOnlyObservation(await gitObservation(first, 'before-sidebar-hide'))
  await selectGitView(first.cdp, 'Changes')
  await delay(250)
  const hiddenOwner = readOnlyObservation(await gitObservation(first, 'history-hidden-with-fixed-review'))
  assert.equal(hiddenOwner.counts.history, 0, 'The right review cannot read local History while the only tree is hidden')
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="View repository history"]'))
  const returned = await settledHistory(first.cdp, sidebar)
  assert.equal((await toolSelection(first.cdp)).view, 'History')
  assert.equal(returned.loaded, appended.loaded); assert.equal(returned.range, appended.range)
  assert.ok(Math.abs(returned.scrollTop - appended.scrollTop) <= 1)
  receipt.navigationPreservation = { before: appended, after: returned, hiddenOwner,
    uniqueHistory: await onlyHistory(first.cdp, repositoryRegion.regionId) }

  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -returned.scrollTop })
  await waitFor('sole History returned to top', async () => (await historyView(first.cdp, sidebar))?.scrollTop === 0)
  const unloaded = await settledHistory(first.cdp, sidebar)
  assert.ok(unloaded.loaded < 166)
  const oldTarget = await open(rootOid)
  await commitView(first.cdp, oldTarget.presentation.regionId, rootOid)
  await click(first.cdp, selectors(pane(oldTarget.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('unread target remains explicit in the sidebar without unbounded reads', () => visibleRead(first.cdp,
    visibleNode(sidebar + ' .git-workbench__locating') + "?.textContent.includes('not been loaded')"))
  await delay(350)
  assert.equal((await settledHistory(first.cdp, sidebar)).loaded, unloaded.loaded)
  for (let page = 0; page < 4; page++) {
    if (await first.cdp.evaluate('Boolean(' + visibleNode(sidebar + ' [data-history-oid="' + rootOid + '"]') + ')')) break
    const prior = await settledHistory(first.cdp, sidebar)
    await click(first.cdp, selectors(sidebar + ' .git-workbench__locating button') + ".filter(element=>element.textContent==='Read next history page')")
    const next = await waitFor('one explicitly requested bounded locating page', async () => {
      const view = await historyView(first.cdp, sidebar); return view?.loaded > prior.loaded ? view : null
    })
    assert.ok(next.loaded - prior.loaded <= 100)
  }
  await waitFor('original old OID is actually inside the virtual viewport', () => visibleRead(first.cdp,
    '(() => {const row=' + visibleNode(sidebar + ' [data-history-oid="' + rootOid + '"]') + ',scroll=' +
    visibleNode(sidebar + ' .git-history-scroll') + ';if(!row||!scroll)return false;const bounds=row.getBoundingClientRect(),view=scroll.getBoundingClientRect();return bounds.top>=view.top&&bounds.bottom<=view.bottom})()'))
  receipt.olderLocation = await settledHistory(first.cdp, sidebar)
  await capture(first.cdp, 'older-commit-located-dark')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/topic/root-only')
  const outside = await open(parents[0])
  await click(first.cdp, selectors(pane(outside.presentation.regionId) + ' [aria-label="Locate commit in history"]'))
  await waitFor('outside range remains distinct from an unread page', () => visibleRead(first.cdp,
    visibleNode(sidebar + ' .git-workbench__locating') + "?.textContent.includes('outside the current history range')"))
  const outsideDetails = await commitView(first.cdp, repositoryRegion.regionId, parents[0])
  const outsideDurable = (await state()).graph.resources['region:' + repositoryRegion.regionId]
  assert.equal(outsideDurable.selection.commitOid, parents[0]); assert.equal(outsideDurable.selection.parentOid, outside.read.snapshot.parentOid)
  assert.equal(outsideDurable.history.reference, 'refs/heads/topic/root-only'); assert.equal(outsideDurable.history.focusOid, parents[0])
  receipt.outsideLocation = { durable: outsideDurable, details: outsideDetails }
  await capture(first.cdp, 'locate-outside-retained-light', 1280, 'light')
  await reference(first.cdp, repositoryRegion.regionId, 'refs/heads/main')
  await click(first.cdp, selectors(sidebar + ' [data-history-oid="' + mergeOid + '"] > strong'))
  await commitView(first.cdp, repositoryRegion.regionId, mergeOid)
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff for changed.ts"]'))
  await monaco(first.cdp, '', 'fixed commit body', repositoryRegion.regionId, true)
  await selectGitView(first.cdp, 'Branches')
  await waitFor('pure branch remains an actual Git resource candidate', () => visibleRead(first.cdp,
    selectors('.branch-row') + ".some(element=>element.textContent.includes('topic/pure-branch'))"))
  await capture(first.cdp, 'git-branches-dark-wide')
  receipt.publicRepositoryOpen = await open()
  assert.equal(receipt.publicRepositoryOpen.presentation.regionId, repositoryRegion.regionId)
  const projected = await toolSelection(first.cdp)
  assert.equal(projected.tool, 'git'); assert.equal(projected.view, 'History'); assert.equal(projected.workface.zoneId, mainZone.zoneId)
  receipt.publicRepositoryProjection = projected
  await onlyHistory(first.cdp, repositoryRegion.regionId)

  // A new Diff Region requires this explicit separate-open action, after the inline assertion.
  await click(first.cdp, selectors(repositoryPane + ' [aria-label="Open diff in separate tab"]'))
  const fixed = await waitFor('explicit independent fixed Diff', async () => {
    const current = await state(); return current.graph.regions.find(r => r.kind === 'git-diff' && current.graph.resources['region:' + r.regionId]?.comparison?.kind === 'commit')
  })
  await monaco(first.cdp, '', 'fixed commit body', fixed.regionId)
  await click(first.cdp, selectors(`button.workbench-tab[data-workbench-tab-id="${fixed.tabId}"]`), 'right')
  await waitFor('move Tab submenu', () => visibleRead(first.cdp, `(() => {const item=${selectors('[role="menuitem"]')}.find(element=>element.textContent.includes('Move Tab to New Group'));if(!item)return false;item.focus();return document.activeElement===item})()`))
  await press(first.cdp, 'ArrowRight')
  receipt.tabMoveMenu = await first.cdp.evaluate(`${selectors('[role="menuitem"]')}.map(element=>element.getAttribute('aria-label')??element.textContent)`)
  await click(first.cdp, `${selectors('[role="menuitem"]')}.filter(e=>e.getAttribute('aria-label')==='Move Tab to New Group Right')`)
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
  receipt.finalReadOwner = readOnlyObservation(await gitObservation(first, 'before-original-normal-quit'))
  await first.main.call('Profiler.stopPreciseCoverage')
  receipt.firstExit = await normalQuit(first)
  await git('branch', '-f', 'topic/pure-branch', rootOid)
  await git('update-ref', 'refs/heads/main', rootOid, mergeOid)
  const moved = await gitState(); assert.equal(moved.head, rootOid)
  receipt.intentionalRefMove = { from: mergeOid, to: rootOid, baseline: moved }
  second = await launch('second'); phase = 'real-restart'
  assert.notEqual(second.child.pid, first.child.pid, 'Recovery must launch a second real process after the original normal exit')
  assert.equal(receipt.second.nativeUserData, receipt.first.nativeUserData)
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
  receipt.cleanup = { errors, temporaryRootRemoved: errors.length === 0,
    buildOutputs: 'Generated outputs remain with the candidate tree; the harness does not remove unowned out/dist. The coordinator removes an isolated verification tree after consuming its receipts.' }
  receipt.passed &&= errors.length === 0
}
await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
const reviewPath = join(artifacts, 'review.md')
await writeFile(reviewPath, '# Git history navigation — independent full-frame review\n\n' +
  'Behavior result: ' + (receipt.passed ? 'passed' : 'not-qualified') + '\n\n' +
  'Candidate: `' + expectedRevision + '`\n\nSource digest: `' + expectedSourceDigest + '`\n\n' +
  'Aesthetic review: **not performed**. Kierkegaard must open the full PNGs and assess the actual scenes; capture success is not deliverability.\n\n' +
  'Scope: ' + receipt.boundary + '\n\n' +
  receipt.screenshots.map(frame => '- [' + frame.path.slice(artifacts.length + 1) + '](./' + frame.path.slice(artifacts.length + 1) + ') · ' +
    frame.width + ' × ' + frame.dimensions.height + ' · ' + frame.theme + ' · `' + frame.sha256 + '`').join('\n') + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, failure: receipt.failure ?? null, screenshots: receipt.screenshots.length,
  artifacts, review: reviewPath, aestheticReview: receipt.aestheticReview, cleanup: receipt.cleanup }) + '\n')
process.exitCode = receipt.passed ? 0 : 1
