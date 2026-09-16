import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Private source-bound acceptance probe. --first-slice is a provisional diagnostic only;
// the canonical Task gate runs the complete probe without that argument.
// Real Desktop/IPC/Core/ctxmux; synthetic Agent input receiver; native read-only history helpers.
// No mock Bridge, queue reconstruction, transcript rewriting, user Run or user native home.
const repositoryRoot = process.env.AGENTMUX_VERIFY_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const core = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const { listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(join(desktopRoot, 'scripts/probe-process.mjs')))
const { prepareNativeFixture } = await import(pathToFileURL(join(desktopRoot, 'scripts/native-history-fixture.mjs')))
const sdkRoot = join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk')
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'))
const sdkPath = resolve(sdkRoot, sdkPackage.exports['.'].import)
const { CtxmuxClient } = await import(pathToFileURL(sdkPath))
const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const privateRoot = await mkdtemp('/tmp/amx-idle-restore-')
const userData = join(privateRoot, 'user-data'), runtimeDirectory = join(privateRoot, 'runtime')
const workspacePath = join(privateRoot, 'workspace'), tracePath = join(privateRoot, 'executor.ndjson')
const wrapper = join(workspacePath, 'private-executor.sh'), unavailable = join(workspacePath, 'missing-executor')
const store = new core.AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
const keys = ['CODEX_HOME', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_DESKTOP_USER_DATA']
const previousEnvironment = new Map(keys.map(key => [key, process.env[key]]))
const children = new Set(), fixture = {}, receipts = [], ownedRunProcesses = new Map()
const cleanup = { privateProcessesReaped: false, temporaryRootRemoved: false, remaining: null }
const workspaceId = 'idle-private-workspace', groupA = 'idle-group-a', groupB = 'idle-group-b', scratchGroup = 'idle-scratch'
const labels = ['healthy', 'recent', 'expired', 'unknown', 'working', 'missing', 'unavailable', 'badHistory']
const firstSliceOnly = process.argv.includes('--first-slice')
const deadline = Date.now() + 300_000
const sourceFiles = ['packages/core/src/client.ts', 'packages/core/src/agent-session-id.ts', 'packages/core/src/agent-session-identity.ts', 'packages/core/src/agent-semantic-state.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/types.ts', 'packages/core/src/prompt-submission.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/idle-agent-restore-policy.ts',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx']
let phase = 'prepare', client, sdk, nativeFixture, nativeCommand, candidateBefore, sourceBefore, probeBefore, nativeBefore, failure, result, privateEnvironment

async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(80) }
  throw new Error(`${phase}: timed out waiting for ${label}`)
}
function signalExact(pid, name) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Only an exact positive private PID/group may be signalled')
  try { process.kill(-pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function traces() {
  try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function agentCounts() {
  const events = (await traces()).filter(event => event.kind === 'agent' && event.edge === 'start')
  assert.ok(events.length >= labels.length, 'A nonempty actual Agent launcher trace is required')
  for (const event of events) {
    assert.ok(event.agent && event.pid > 1)
    assert.equal(event.home, nativeFixture.home, 'Every synthetic Agent uses the same private native home')
    assert.ok(labels.some(label => fixture[label]?.agentSessionId === event.agent), 'Unexpected Agent launch in the private fixture')
  }
  return Object.fromEntries(labels.map(label => [label, events.filter(event => event.agent === fixture[label].agentSessionId).length]))
}
async function nativeRun(ref) {
  const value = await sdk.status(ref.runId)
  assert.equal(value.id, ref.runId)
  assert.equal(value.spec?.program, wrapper, 'Only exact private synthetic Agent Runs may be observed or controlled')
  assert.equal(value.spec.cwd, workspacePath)
  assert.ok(Number.isFinite(value.applied_input_bytes) && value.applied_input_bytes >= 0, 'Runtime input cursor must be an actual known fact')
  if (value.state.type === 'running' && value.pid > 1) {
    const identity = await processIdentity(value.pid)
    if (identity) ownedRunProcesses.set(value.pid, { ...identity, runId: ref.runId })
  }
  return value
}
async function processIdentity(pid) {
  let stdout
  try { ({ stdout } = await exec('ps', ['-p', String(pid), '-o', 'pgid=,lstart='], { timeout: 5_000 })) }
  catch (error) { if (error.code === 1) return null; throw error }
  const parsed = /^\s*(\d+)\s+(.+)$/.exec(stdout.trim())
  if (!parsed) return null
  const group = Number(parsed[1]); assert.ok(group > 1)
  return { pid, group, born: parsed[2] }
}
async function sourceIdentity() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(repositoryRoot, path)))])))
}
async function currentStored(label) {
  const value = (await store.load()).find(session => session.agentSessionId === fixture[label].agentSessionId)
  assert.ok(value, `Nonempty persisted ${label} Session is required`)
  return value
}
async function terminateOwnedRun(ref) {
  const run = await nativeRun(ref)
  assert.equal(run.state.type, 'running')
  assert.ok(run.pid > 1)
  const { stdout } = await exec('ps', ['-p', String(run.pid), '-o', 'pgid='], { timeout: 5_000 })
  const group = Number(stdout.trim())
  assert.ok(group > 1)
  assert.ok(![...children].some(child => child.pid === group), 'An Agent Run cannot share an Electron group')
  signalExact(group, 'SIGTERM') // External OS termination: deliberately not stopAgent/retirement.
  const ended = await waitFor('exact private Run really ends', async () => {
    const next = await nativeRun(ref); return next.state.type !== 'running' ? next : null
  })
  return { runId: run.id, pid: run.pid, group, state: ended.state }
}
async function compiledIdentity() {
  const coreFiles = (await readdir(join(repositoryRoot, 'packages/core/dist'), { recursive: true })).filter(name => name.endsWith('.js')).sort()
  assert.ok(coreFiles.length > 0, 'Compiled Core identity must bind nonempty actual modules')
  const coreHashes = Object.fromEntries(await Promise.all(coreFiles.map(async name => [name, hash(await readFile(join(repositoryRoot, 'packages/core/dist', name)))])))
  const assetRoot = join(desktopRoot, 'out/renderer/assets')
  const assets = (await readdir(assetRoot)).filter(name => name.endsWith('.js')).sort()
  assert.ok(assets.length > 0, 'All executed Renderer assets must have a nonempty identity')
  return { core: coreHashes, main: hash(await readFile(join(desktopRoot, 'out/main/index.js'))),
    rendererHtml: hash(await readFile(join(desktopRoot, 'out/renderer/index.html'))),
    renderer: Object.fromEntries(await Promise.all(assets.map(async name => [name, hash(await readFile(join(assetRoot, name)))]))),
    sdk: { path: sdkPath, sha256: hash(await readFile(sdkPath)) } }
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let serial = 0
  const pending = new Map(), events = [], scripts = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method) {
      events.push(message)
      if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params)
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.fail(new Error(message.error.message)); else request.done(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.fail(request.closedError) }
    pending.clear()
  })
  function call(method, params = {}) {
    const id = ++serial
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${phase}: CDP timeout ${method}`)) }, 15_000)
      pending.set(id, { done, fail, timer, closedError: new Error(`${phase}: Private CDP closed during ${method}`) }); socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression, frameId) {
    const response = frameId
      ? await call('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression, returnByValue: true })
      : await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  return { call, evaluate, events, scripts, close: () => socket.close() }
}
async function launch(label) {
  const readyFile = join(privateRoot, `ready-${label}.json`)
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...privateEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  child.on('error', error => { child.launchError = error })
  let endpoint, diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-32768); endpoint ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  await waitFor(`${label} readiness`, async () => {
    if (child.launchError) throw child.launchError
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before ready: ${child.exitCode}/${child.signalCode}; ${diagnostics}`)
    try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch { return null }
  })
  const address = new URL(await waitFor(`${label} CDP`, () => endpoint))
  const target = await waitFor(`${label} real Renderer`, async () => {
    const response = await fetch(`http://${address.host}/json/list`, { signal: AbortSignal.timeout(3000) })
    return (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:'))
  })
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable'); await cdp.call('Debugger.enable')
  await waitFor(`${label} app shell`, () => cdp.evaluate("Boolean(document.querySelector('.app-shell'))"))
  await cdp.evaluate("(() => {window.__idleProofUnloads=[]; for(const n of ['beforeunload','pagehide']) window.addEventListener(n,()=>window.__idleProofUnloads.push(n));return true})()")
  return { label, child, cdp }
}
async function crash(probe, frameId) {
  const alive = (await store.load()).filter(session => labels.some(label => session.agentSessionId === fixture[label].agentSessionId))
  assert.equal(alive.length, labels.length)
  const survivors = []
  for (const session of alive) {
    let run
    try { run = await nativeRun(session.run) } catch (error) { if (error.code === 'run_not_found') continue; throw error }
    if (run.state.type !== 'running') continue
    const { stdout } = await exec('ps', ['-p', String(run.pid), '-o', 'pgid='], { timeout: 5_000 })
    const group = Number(stdout.trim()); assert.ok(group > 1); assert.notEqual(group, probe.child.pid)
    survivors.push({ agentSessionId: session.agentSessionId, runId: run.id, pid: run.pid, group })
  }
  assert.ok(survivors.length >= 2, 'Abrupt interruption must preserve multiple live private Agents')
  assert.deepEqual(await probe.cdp.evaluate('window.__idleProofUnloads', frameId), [])
  probe.cdp.close(); signalExact(probe.child.pid, 'SIGKILL')
  await waitFor(`${probe.label} SIGKILL exit`, () => probe.child.signalCode !== null || probe.child.exitCode !== null, 5_000)
  assert.equal(probe.child.signalCode, 'SIGKILL'); children.delete(probe.child)
  return { pid: probe.child.pid, signal: probe.child.signalCode, survivors }
}
async function seedWorkbench(seed) {
  const reportPath = join(privateRoot, 'seed-report.json')
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js')], {
    cwd: desktopRoot, detached: true, stdio: 'ignore', env: { ...process.env, ...privateEnvironment,
      AGENTMUX_DESKTOP_RECOVERY_REPORT: reportPath, AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed),
      AGENTMUX_DESKTOP_READY_FILE: join(privateRoot, 'seed-ready.json'), AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' }
  })
  children.add(child)
  child.on('error', error => { child.launchError = error })
  await waitFor('normal seed process exit', () => { if (child.launchError) throw child.launchError; return child.exitCode !== null || child.signalCode !== null })
  assert.equal(child.exitCode, 0)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.workbench.tabIds.slice().sort(), labels.map(label => `idle-tab-${label}`).sort())
  for (const label of labels) assert.equal(report.workbench.drafts[fixture[label].agentSessionId], `Unsent ${label} private draft`)
  children.delete(child)
}
async function surface(cdp, frameId) {
  return cdp.evaluate(`(() => {const s=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
    return {workbench:s.restoredWorkbench,focus:s.agentFocus,drafts:s.agentComposerDrafts,queues:s.agentSteerQueues??{}}})()`, frameId)
}
function assertSeedShape(value, seed) {
  const tabs = value.workbench.tabs
  assert.deepEqual(Object.keys(tabs).sort(), labels.map(label => `idle-tab-${label}`).sort())
  assert.deepEqual(Object.keys(value.workbench.layouts).sort(), ['__scratch__', workspaceId].sort())
  assert.deepEqual(value.workbench.layouts[workspaceId].root, seed.state.restoredWorkbench.layouts[workspaceId].root)
  assert.deepEqual(value.workbench.layouts[workspaceId].groups.map(group => ({ id: group.id, tabOrder: group.tabOrder })),
    seed.state.restoredWorkbench.layouts[workspaceId].groups.map(group => ({ id: group.id, tabOrder: group.tabOrder })))
  for (const label of labels) {
    const tab = tabs[`idle-tab-${label}`]
    assert.deepEqual(Object.keys(tab.regions).sort(), [`idle-agent-${label}`, `idle-file-${label}`].sort())
    assert.equal(tab.regions[`idle-agent-${label}`].sessionId, fixture[label].agentSessionId)
    assert.equal(tab.layout.root.type, 'split'); assert.equal(tab.layout.root.direction, 'horizontal')
  }
}
async function pointAndClick(cdp, selectorExpression) {
  await cdp.evaluate(`(() => {const e=${selectorExpression};if(!e)throw Error('Missing actual control');e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return true})()`)
  const point = await waitFor('actual control center is visible and receives the pointer', () => cdp.evaluate(`(() => {const e=${selectorExpression};if(!e)throw Error('Missing actual control');const r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))throw Error('Control has no geometry');const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return hit&&(hit===e||e.contains(hit))?{x,y}:null})()`))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
async function selectTab(cdp, label) {
  await pointAndClick(cdp, `document.querySelector('button[data-workbench-tab-id="idle-tab-${label}"]')`)
  await waitFor(`${label} actual visible pane`, () => cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="idle-agent-${label}"] .composer [role="textbox"]');const r=e?.getBoundingClientRect();return Boolean(r?.width>0&&r?.height>0&&e.isContentEditable&&getComputedStyle(e).visibility==='visible')})()`))
}
async function editDraft(cdp, label, text) {
  await waitFor(`${label} visible editable composer`, () => cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="idle-agent-${label}"] .composer [role="textbox"]');const r=e?.getBoundingClientRect();return Boolean(r?.width>0&&r?.height>0&&e.isContentEditable)})()`))
  const prepared = await cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="idle-agent-${label}"] .composer [role="textbox"]');e.focus();getSelection().selectAllChildren(e);return {focused:document.activeElement===e,selected:getSelection().toString(),text:e.innerText}})()`)
  assert.equal(prepared.focused, true, `${label}: the actual visible composer must own input focus`)
  assert.equal(prepared.selected, prepared.text, `${label}: the actual current draft must be selected before replacement`)
  await cdp.call('Input.insertText', { text })
  let observed
  try {
    await waitFor(`${label} exact real draft input`, async () => {
      observed = await cdp.evaluate(`(() => {const e=document.querySelector('[data-workbench-region-id="idle-agent-${label}"] .composer [role="textbox"]');return {text:e?.innerText,focused:document.activeElement===e,editable:e?.isContentEditable}})()`)
      return observed.text === text
    })
  } catch (error) { throw new Error(`${error.message}; actual private composer: ${JSON.stringify({prepared,observed})}`, { cause: error }) }
}
async function sendDraft(cdp, label) {
  await pointAndClick(cdp, `document.querySelector('[data-workbench-region-id="idle-agent-${label}"] button[aria-label="Send"]')`)
}
async function sendQueued(cdp, label, text) {
  await pointAndClick(cdp, `document.querySelector('[data-workbench-region-id="idle-agent-${label}"] button.composer__mailbox')`)
  await pointAndClick(cdp, `[...document.querySelectorAll('[data-workbench-region-id="idle-agent-${label}"] [role="tab"]')].find(e=>e.textContent.startsWith('Outbox'))`)
  const entrySelector = `[...document.querySelectorAll('[data-workbench-region-id="idle-agent-${label}"] .composer-outbox li')].find(e=>e.textContent.includes(${JSON.stringify(text)}))`
  assert.ok(await cdp.evaluate(`Boolean(${entrySelector})`), 'The actual nonempty queued intent must be visible')
  await pointAndClick(cdp, `[...document.querySelectorAll('[data-workbench-region-id="idle-agent-${label}"] .composer-outbox > button')].find(e=>e.textContent.trim()==='Send queued message')`)
}
async function historyPage(cdp, label, count) {
  return waitFor(`actual ${label} native ${count}-item page`, async () => {
    const value = await cdp.evaluate(`(() => {const r=document.querySelector('[data-workbench-region-id="idle-agent-${label}"]');const h=r?.querySelector('.session-history'),v=h?.querySelector('.session-history__viewport'),b=v?.getBoundingClientRect();const failure=[...(h?.querySelectorAll('.session-history__notice')??[])].find(e=>e.querySelector('span')?.textContent.startsWith('History read failed:')&&[...e.querySelectorAll('button')].some(b=>b.textContent.trim()==='Retry'));return{ids:[...(h?.querySelectorAll('[data-history-item-id]')??[])].map(e=>e.dataset.historyItemId),source:h?.querySelector('.session-history__source')?.title,error:failure?.textContent,loading:!!h?.querySelector('.spin'),terminal:!!r?.querySelector('.xterm'),height:v?.scrollHeight,point:b?{x:b.x+b.width/2,y:b.y+b.height/2,height:b.height}:null}})()`)
    if (value.error) throw new Error(value.error)
    return !value.loading && value.ids.length === count ? value : null
  })
}
function sourceLocation(source, index) {
  const lines = source.slice(0, index).split('\n')
  return { lineNumber: lines.length - 1, columnNumber: lines.at(-1).length }
}
async function installCheckpoint(cdp, kind, label, operationId) {
  await waitFor('nonempty actual parsed Renderer scripts', () => [...cdp.scripts.values()].some(script => script.url.includes('/out/renderer/assets/')))
  const candidates = []
  for (const script of cdp.scripts.values()) {
    if (!script.url.includes('/out/renderer/assets/')) continue
    const localAsset = new URL(script.url)
    assert.equal(localAsset.protocol, 'file:')
    assert.ok(localAsset.pathname.startsWith(join(desktopRoot, 'out/renderer/assets') + '/'))
    const scriptSource = await readFile(localAsset, 'utf8')
    const anchor = kind === 'binding' ? 'await api.ui.requestStorageFlush();' : 'applyEvent(event) {'
    const indices = [...scriptSource.matchAll(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(match => match.index)
    if (indices.length) {
      // CDP scriptParsed supplies the SHA-256 of the actual parsed script. Bind that
      // identity before using local text for line/column positions; no large source
      // response is needed, and a stale/replaced compiled file cannot pass.
      assert.equal(script.hash, hash(scriptSource), 'Actual parsed Renderer hash must equal the compiled candidate on disk')
    }
    for (const index of indices) candidates.push({ script, source: scriptSource, index, anchor })
  }
  assert.equal(candidates.length, 1, `${kind}: expected exactly one nonempty actual compiled checkpoint anchor`)
  const candidate = candidates[0]
  assert.ok(candidate.source.split('\n').length > 200, 'Precise checkpoints require the actual readable, unminified compiled Renderer')
  let start = candidate.index + candidate.anchor.length
  if (kind === 'ack') {
    const body = candidate.source.slice(start, start + 600)
    const coreAnchor = 'const core = event.event;'
    assert.equal([...body.matchAll(/const core = event\.event;/g)].length, 1, 'ACK checkpoint must read the actual event before reduction')
    start += body.indexOf(coreAnchor) + coreAnchor.length
  }
  const startLocation = { scriptId: candidate.script.scriptId, ...sourceLocation(candidate.source, start) }
  const endLocation = { scriptId: candidate.script.scriptId, ...sourceLocation(candidate.source, start + 180) }
  const possible = await cdp.call('Debugger.getPossibleBreakpoints', { start: startLocation, end: endLocation, restrictToFunction: true })
  assert.ok(possible.locations.length > 0, 'Checkpoint must have a real following executable statement')
  const location = possible.locations[0]
  const condition = kind === 'binding' ? `session.id===${JSON.stringify(fixture[label].agentSessionId)}`
    : `core.type==='agent-timeline'&&core.agentSessionId===${JSON.stringify(fixture[label].agentSessionId)}&&core.mutation.type==='append'&&core.mutation.item.id===${JSON.stringify('prompt:' + operationId)}`
  const checkpoint = await cdp.call('Debugger.setBreakpoint', { location, condition })
  assert.equal(checkpoint.actualLocation.lineNumber, location.lineNumber)
  return { id: checkpoint.breakpointId, cursor: cdp.events.length, kind,
    source: { url: candidate.script.url, sha256: hash(candidate.source), parsedSha256: candidate.script.hash,
      anchor: candidate.anchor, location: checkpoint.actualLocation } }
}
async function pausedAt(cdp, checkpoint) {
  return waitFor(`${checkpoint.kind} exact conditional checkpoint`, () => {
    const event = cdp.events.slice(checkpoint.cursor).find(item => item.method === 'Debugger.paused' && item.params.hitBreakpoints?.includes(checkpoint.id))
    return event?.params
  })
}
async function beginAndPause(probe, checkpoint, action) {
  // An actual input dispatch may remain pending because the real Renderer is intentionally paused.
  // Do not wait for that dispatch before observing Debugger.paused; retain/reap its promise on crash.
  const actionResult = action().then(() => ({ completed: true }), error => ({ completed: false, error: error.message }))
  const paused = await pausedAt(probe.cdp, checkpoint)
  assert.ok(paused.callFrames.length > 0)
  return { frameId: paused.callFrames[0].callFrameId, actionResult }
}
async function assertNoExtraAgents(expected) { assert.deepEqual(await agentCounts(), expected) }

try {
  candidateBefore = await compiledIdentity()
  sourceBefore = await sourceIdentity(); probeBefore = hash(await readFile(import.meta.filename))
  await mkdir(userData, { recursive: true }); await mkdir(workspacePath, { recursive: true })
  nativeCommand = (await exec('which', [process.env.AGENTMUX_HISTORY_NATIVE_COMMAND ?? 'codex'], { timeout: 10_000 })).stdout.trim()
  assert.ok(nativeCommand.startsWith('/'))
  nativeBefore = hash(await readFile(nativeCommand))
  // Private home is established BEFORE any Core connect/create/repair or native fixture preparation.
  privateEnvironment = { CODEX_HOME: join(privateRoot, 'codex-home'), AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson'), AGENTMUX_DESKTOP_USER_DATA: userData }
  Object.assign(process.env, privateEnvironment)
  nativeFixture = await prepareNativeFixture({ root: privateRoot, nativeCommand })
  assert.equal(nativeFixture.home, process.env.CODEX_HOME)
  const nativeVersion = (await exec(nativeCommand, ['--version'], { timeout: 10_000, env: process.env })).stdout.trim()
  const wrapperSource = `#!/bin/sh\numask 077\nkind=agent\nfor arg in "$@"; do case "$arg" in app-server) kind=helper;; --help|--version|-h|-V) [ "$kind" = helper ] || kind=probe;; esac; done\nprintf '{"kind":"%s","edge":"start","pid":%s,"agent":"%s","home":"%s"}\\n' "$kind" "$$" "$AGENTMUX_AGENT_SESSION_ID" "$CODEX_HOME" >> ${quote(tracePath)}\nif [ "$kind" != agent ]; then\n  ${quote(nativeCommand)} "$@" <&0 &\n  owned_child=$!\n  wait "$owned_child"\n  owned_status=$?\n  printf '{"kind":"%s","edge":"end","pid":%s,"status":%s}\\n' "$kind" "$$" "$owned_status" >> ${quote(tracePath)}\n  exit "$owned_status"\nfi\nprintf '{"url":"%s","token":"%s","agentSessionId":"%s"}\\n' "$AGENTMUX_HOOK_URL" "$AGENTMUX_HOOK_TOKEN" "$AGENTMUX_AGENT_SESSION_ID" > ${quote(join(privateRoot, 'binding-'))}"$AGENTMUX_AGENT_SESSION_ID".json\nstty -echo -icanon\nprintf 'Private synthetic Agent input receiver\\n'\nexec /bin/cat\n`
  await writeFile(wrapper, wrapperSource, { mode: 0o700 })
  await writeFile(join(workspacePath, 'split.txt'), 'Private second Region\n')
  client = await core.connectLocalAgentMux({ store })
  sdk = new CtxmuxClient({ socketPath: core.defaultCtxmuxSocketPath() })
  for (const label of labels) fixture[label] = await client.createAgent({ createOperationId: randomUUID(), providerId: 'codex',
    executorId: label === 'unavailable' ? 'unavailable' : 'fixture', commandOverride: wrapper, env: { CODEX_HOME: nativeFixture.home },
    workspacePath, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  const initialRuns = Object.fromEntries(await Promise.all(labels.map(async label => [label, await nativeRun(fixture[label].run)])))
  for (const label of labels) { assert.equal(initialRuns[label].state.type, 'running'); assert.ok(initialRuns[label].pid > 1) }
  // Genuine repeated native Stop ingress, not a direct timestamp rewrite, proves the epoch stable.
  const binding = JSON.parse(await waitFor('private inherited Hook binding', async () => {
    try { return await readFile(join(privateRoot, `binding-${fixture.healthy.agentSessionId}.json`), 'utf8') } catch { return null }
  }))
  for (let index = 0; index < 2; index++) {
    const response = await fetch(binding.url, { method: 'POST', headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'idle-private-stop-' + index, eventName: 'Stop', payload: {} }), signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 204)
    const status = await waitFor('native done semantic status', async () => { const s = await currentStored('healthy'); return s.semanticStatus?.state === 'done' ? s.semanticStatus : null })
    assert.ok(Number.isFinite(status.stateEnteredAt))
    if (index === 0) fixture.repeatedDoneClock = status.stateEnteredAt
    else assert.equal(status.stateEnteredAt, fixture.repeatedDoneClock)
    await delay(30)
  }
  await client.dispose(); client = null
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private idle fixture' }],
    executors: { fixture: { label: 'Private synthetic Executor', providerId: 'codex', command: wrapper, args: [], env: { CODEX_HOME: nativeFixture.home }, injectAgentMuxGuide: false },
      unavailable: { label: 'Private unavailable CLI', providerId: 'codex', command: unavailable, args: [], env: { CODEX_HOME: nativeFixture.home }, injectAgentMuxGuide: false } },
    workspaces: [{ id: workspaceId, name: 'Private idle fixture', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  const tabs = Object.fromEntries(labels.map(label => { const id = `idle-tab-${label}`, agent = `idle-agent-${label}`, file = `idle-file-${label}`;
    return [id, { id, workspaceId, titleRegionId: agent,
      layout: { root: { type: 'split', direction: 'horizontal', ratio: .7, first: { type: 'leaf', regionId: agent }, second: { type: 'leaf', regionId: file } }, activeRegionId: agent },
      regions: { [agent]: { regionId: agent, kind: 'agent', phase: 'attached', workspaceId, sessionId: fixture[label].agentSessionId },
        [file]: { regionId: file, kind: 'file', workspaceId, path: join(workspacePath, 'split.txt') } } }] }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: fixture.expired.agentSessionId, history: [{ sessionId: fixture.expired.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: Object.fromEntries(labels.map(label => [fixture[label].agentSessionId, `Unsent ${label} private draft`])),
    restoredWorkbench: { tabs, layouts: { [workspaceId]: {
      root: { type: 'split', direction: 'horizontal', ratio: .55, first: { type: 'leaf', groupId: groupA }, second: { type: 'leaf', groupId: groupB } },
      groups: [{ id: groupA, tabOrder: labels.filter(label => label !== 'healthy').map(label => `idle-tab-${label}`), activeTabId: 'idle-tab-expired', recentTabIds: ['idle-tab-expired'] },
        { id: groupB, tabOrder: ['idle-tab-healthy'], activeTabId: 'idle-tab-healthy', recentTabIds: ['idle-tab-healthy'] }], activeGroupId: groupA },
      __scratch__: { root: { type: 'leaf', groupId: scratchGroup }, groups: [{ id: scratchGroup, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: scratchGroup } } } } }
  phase = 'seed-all-healthy'; process.stderr.write('idle_restore_phase=' + phase + '\n'); await seedWorkbench(seed)
  const seededCounts = await agentCounts(); assert.deepEqual(seededCounts, Object.fromEntries(labels.map(label => [label, 1])))
  phase = 'seed-clock-and-ended-runs'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const now = Date.now(), clocks = { healthy: now - 2 * 3600_000, recent: now - 600_000, expired: now - 2 * 3600_000,
    missing: now - 2 * 3600_000, unavailable: now - 2 * 3600_000, badHistory: now - 2 * 3600_000 }
  for (const label of labels) {
    const stored = await currentStored(label)
    const state = label === 'working' ? 'working' : 'done'
    const next = { ...stored, updatedAt: Math.max(stored.updatedAt, now), nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: label === 'expired' ? nativeFixture.threadId : randomUUID() },
      semanticStatus: { state, source: 'native-hook', observedAt: now, ...(clocks[label] === undefined ? {} : { stateEnteredAt: clocks[label] }) } }
    await store.compareAndSwap(stored, next)
    assert.deepEqual((await currentStored(label)).semanticStatus, next.semanticStatus)
  }
  const ended = []
  for (const label of labels.filter(label => label !== 'healthy')) ended.push({ label, ...await terminateOwnedRun(fixture[label].run) })
  const missingRun = await nativeRun(fixture.missing.run)
  assert.notEqual(missingRun.state.type, 'running'); assert.equal(missingRun.attachments, 0)
  await sdk.remove(fixture.missing.run.runId)
  await assert.rejects(() => sdk.status(fixture.missing.run.runId), error => error.code === 'run_not_found')

  phase = 'first-cold-start'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const first = await launch('first')
  await waitFor('only proven recent Session automatically resumes', async () => { const s = await currentStored('recent'); return s.run.runId !== fixture.recent.run.runId ? s : null })
  await delay(650)
  const startupCounts = { ...seededCounts, recent: 2 }; await assertNoExtraAgents(startupCounts)
  const healthy = await nativeRun(fixture.healthy.run); assert.equal(healthy.pid, initialRuns.healthy.pid); assert.equal(healthy.state.type, 'running')
  const firstSurface = await surface(first.cdp); assertSeedShape(firstSurface, seed)
  assert.deepEqual(firstSurface.focus, seed.state.agentFocus); assert.deepEqual(firstSurface.drafts, seed.state.agentComposerDrafts)
  const firstNative = await historyPage(first.cdp, 'expired', 30)
  assert.equal(firstNative.terminal, false); assert.equal(firstNative.source, `codex · ${nativeFixture.threadId}`)
  assert.deepEqual(firstNative.ids, Array.from({ length: 30 }, (_, i) => `synthetic-agent-${i + 32}`))
  let older, wheels = 0
  assert.ok(firstNative.point?.height > 0)
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: firstNative.point.x, y: firstNative.point.y,
    deltaX: 0, deltaY: -Math.max(1200, firstNative.height), modifiers: 0 })
  wheels++
  older = await historyPage(first.cdp, 'expired', 60)
  assert.ok(older, 'Actual wheel must load a distinct native page'); assert.deepEqual(older.ids, Array.from({ length: 60 }, (_, i) => `synthetic-agent-${i + 2}`))
  await editDraft(first.cdp, 'expired', 'Edited expired draft survives interruption')
  const splitControl = await first.cdp.evaluate(`(() => {const region=document.querySelector('[data-workbench-region-id="idle-agent-expired"]');const group=region?.closest('.workbench-region-split');const handle=group?.querySelector(':scope > .workbench-region-resize-handle');if(!handle||!handle.getClientRects().length)throw Error('Missing visible expired Region handle');handle.focus();return {focused:document.activeElement===handle,direction:group.dataset.panelGroupDirection,writingDirection:getComputedStyle(group).direction,value:Number(handle.getAttribute('aria-valuenow'))}})()`)
  assert.deepEqual(splitControl, { focused: true, direction: 'horizontal', writingDirection: 'ltr', value: 70 })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft' })
  await waitFor('actual expired split handle reports sixty percent', () => first.cdp.evaluate(`Number(document.querySelector('[data-workbench-region-id="idle-agent-expired"]').closest('.workbench-region-split').querySelector(':scope > .workbench-region-resize-handle').getAttribute('aria-valuenow'))===60`))
  await pointAndClick(first.cdp, "document.querySelector('[data-workbench-region-id=\"idle-file-expired\"]')")
  let editedProjection
  try {
    await waitFor('exact durable edited split and focus', async () => { const s = await surface(first.cdp); const tab = s.workbench.tabs['idle-tab-expired'];
      editedProjection = { draft: s.drafts[fixture.expired.agentSessionId], layout: tab.layout }
      return editedProjection.draft === 'Edited expired draft survives interruption' && tab.layout.root.ratio === .6 && tab.layout.activeRegionId === 'idle-file-expired' ? s : null })
  } catch (error) {
    throw new Error(`${error.message}; actual private edited projection: ${JSON.stringify(editedProjection)}`, { cause: error })
  }
  for (const label of ['unknown', 'working', 'missing']) { await selectTab(first.cdp, label); await editDraft(first.cdp, label, `Edited ${label} draft stays local`) }
  for (const label of ['badHistory', 'unavailable']) {
    await selectTab(first.cdp, label)
    const notice = await waitFor(`${label} honest isolated history error`, () => first.cdp.evaluate(`(() => {const h=document.querySelector('[data-workbench-region-id="idle-agent-${label}"] .session-history');return [...(h?.querySelectorAll('.session-history__notice')??[])].find(e=>e.querySelector('span')?.textContent.startsWith('History read failed:')&&[...e.querySelectorAll('button')].some(b=>b.textContent.trim()==='Retry'))?.textContent})()`))
    assert.ok(notice.trim().length > 0)
    assert.match(notice, label === 'unavailable' ? /configured native read helper could not start/i : /thread|session|not found|missing/i)
  }
  await selectTab(first.cdp, 'expired'); await assertNoExtraAgents(startupCounts)
  for (const label of labels.filter(label => !['recent', 'missing'].includes(label))) assert.equal((await nativeRun(fixture[label].run)).applied_input_bytes, initialRuns[label].applied_input_bytes)
  const healthyControl = await first.cdp.evaluate(`(async()=>{const s=await window.agentmux.sessions.snapshot();const a=s.sessions.find(v=>v.id===${JSON.stringify(fixture.healthy.agentSessionId)});if(!a)throw Error('Missing healthy Session');return a.control})()`)
  const healthyOperation = randomUUID()
  await first.cdp.evaluate(`window.agentmux.sessions.submitPrompt(${JSON.stringify(healthyControl)},'Healthy input despite isolated history failures',${JSON.stringify(healthyOperation)})`)
  const healthyAfter = await nativeRun(fixture.healthy.run); assert.ok(healthyAfter.applied_input_bytes > healthy.applied_input_bytes); assert.equal(healthyAfter.pid, healthy.pid)
  receipts.push({ phase, counts: startupCounts, healthyPid: healthy.pid, ended, repeatedDoneEpochPreserved: true,
    history: { source: firstNative.source, initialIds: firstNative.ids, olderIds: older.ids, wheels }, healthyInputBytes: [healthy.applied_input_bytes, healthyAfter.applied_input_bytes] })

  if (firstSliceOnly) {
    // Fast environment/UI falsification before precise crash checkpoints. This result is explicitly
    // a provisional slice and cannot be used as the complete T-004 acceptance receipt.
    phase = 'first-slice-explicit-send'; process.stderr.write('idle_restore_phase=' + phase + '\n')
    const prompt = 'One explicit private on-demand execution intent'
    await editDraft(first.cdp, 'expired', prompt)
    await sendDraft(first.cdp, 'expired')
    const submitted = await waitFor('actual first explicit execution accepted', async () => {
      const s = await currentStored('expired'), c = s.terminalPromptSubmission
      return c?.payload.acknowledged && c.submit.acknowledged ? s : null
    })
    assert.notEqual(submitted.run.runId, fixture.expired.run.runId)
    const submittedRun = await nativeRun(submitted.run)
    assert.ok(submittedRun.applied_input_bytes > 0)
    assert.equal(submittedRun.applied_input_bytes, submitted.terminalPromptSubmission.submit.inputByteRange.endByte)
    await assertNoExtraAgents({ ...startupCounts, expired: 2 })
    await waitFor('acknowledged intent has actually resolved', async () => {
      const s = await surface(first.cdp); return !(s.queues[fixture.expired.agentSessionId] ?? []).length ? s : null
    })
    const expected = await surface(first.cdp); assertSeedShape(expected, seed)
    const firstCrash = await crash(first)
    phase = 'first-slice-second-process'; process.stderr.write('idle_restore_phase=' + phase + '\n')
    const second = await launch('second')
    const restored = await waitFor('exact nonempty workbench/draft restored', async () => {
      const s = await surface(second.cdp)
      return JSON.stringify(s.workbench) === JSON.stringify(expected.workbench) &&
        JSON.stringify(s.drafts) === JSON.stringify(expected.drafts) ? s : null
    })
    assert.deepEqual(restored.focus, expected.focus)
    assert.equal((await nativeRun(fixture.healthy.run)).pid, initialRuns.healthy.pid)
    assert.equal((await nativeRun(submitted.run)).applied_input_bytes, submittedRun.applied_input_bytes)
    await assertNoExtraAgents({ ...startupCounts, expired: 2 })
    receipts.push({ phase, scope: 'provisional first slice only', firstCrash, secondPid: second.child.pid,
      exactWorkbenchRestored: true, exactDraftsRestored: true, exactFocusRestored: true,
      execution: { agentSessionId: submitted.agentSessionId, runId: submitted.run.runId,
        operationId: submitted.terminalPromptSubmission.submissionId, acceptedInputBytes: submittedRun.applied_input_bytes },
      omittedAcceptance: ['Binding-before-input crash', 'ACK-before-consumer crash/retry', 'Stale old Run binding'] })
  } else {
  phase = 'binding-before-input-crash'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const prompt = 'One explicit private on-demand execution intent'
  await editDraft(first.cdp, 'expired', prompt)
  const bindingCheckpoint = await installCheckpoint(first.cdp, 'binding', 'expired')
  const bindingPause = await beginAndPause(first, bindingCheckpoint, () => sendDraft(first.cdp, 'expired'))
  const bindingLocals = await first.cdp.evaluate('({operationId:entry.operationId,runId:pending.runId,text:entry.text,agentSessionId:session.id})', bindingPause.frameId)
  assert.ok(bindingLocals.operationId); assert.equal(bindingLocals.text, prompt); assert.equal(bindingLocals.agentSessionId, fixture.expired.agentSessionId)
  const boundState = await surface(first.cdp, bindingPause.frameId); assertSeedShape(boundState, seed)
  const boundEntries = boundState.queues[fixture.expired.agentSessionId]
  assert.equal(boundEntries.length, 1); assert.equal(boundEntries[0].operationId, bindingLocals.operationId); assert.equal(boundEntries[0].runId, bindingLocals.runId)
  const boundSession = await currentStored('expired'); assert.equal(boundSession.run.runId, bindingLocals.runId)
  const beforeInput = await nativeRun(boundSession.run); assert.equal(beforeInput.applied_input_bytes, 0)
  await assertNoExtraAgents({ ...startupCounts, expired: 2 })
  const firstCrash = await crash(first, bindingPause.frameId); await bindingPause.actionResult
  receipts.push({ phase, checkpoint: bindingCheckpoint.source, binding: bindingLocals, inputBytes: beforeInput.applied_input_bytes, crash: firstCrash })

  phase = 'second-process-explicit-send'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const second = await launch('second')
  await waitFor('binding really survives Chromium process death', async () => {
    const value = await surface(second.cdp); const entry = value.queues[fixture.expired.agentSessionId]?.find(item => item.operationId === bindingLocals.operationId)
    return entry?.runId === bindingLocals.runId ? value : null
  })
  const secondState = await surface(second.cdp)
  assert.deepEqual(secondState.workbench, boundState.workbench); assert.deepEqual(secondState.focus, boundState.focus); assert.deepEqual(secondState.drafts, boundState.drafts)
  await delay(500); await assertNoExtraAgents({ ...startupCounts, expired: 2 })
  assert.equal((await nativeRun(boundSession.run)).applied_input_bytes, beforeInput.applied_input_bytes)
  const ackCheckpoint = await installCheckpoint(second.cdp, 'ack', 'expired', bindingLocals.operationId)
  const ackPause = await beginAndPause(second, ackCheckpoint, () => sendQueued(second.cdp, 'expired', prompt))
  const actualEvent = await second.cdp.evaluate('core', ackPause.frameId)
  assert.equal(actualEvent.type, 'agent-timeline'); assert.equal(actualEvent.agentSessionId, fixture.expired.agentSessionId)
  assert.equal(actualEvent.evidence.run.runId, bindingLocals.runId)
  assert.equal(actualEvent.mutation.item.id, 'prompt:' + bindingLocals.operationId); assert.equal(actualEvent.mutation.item.kind, 'user_message')
  const atAckState = await surface(second.cdp, ackPause.frameId)
  const atAckEntry = atAckState.queues[fixture.expired.agentSessionId]?.find(item => item.operationId === bindingLocals.operationId)
  assert.ok(atAckEntry); assert.equal(atAckEntry.runId, bindingLocals.runId)
  const ackSession = await currentStored('expired'), claim = ackSession.terminalPromptSubmission
  assert.ok(claim); assert.equal(claim.submissionId, bindingLocals.operationId); assert.equal(claim.run.runId, bindingLocals.runId)
  assert.equal(claim.payload.acknowledged, true); assert.equal(claim.submit.acknowledged, true)
  assert.ok(claim.payload.inputByteRange.endByte > claim.payload.inputByteRange.startByte)
  assert.ok(claim.submit.inputByteRange.endByte > claim.submit.inputByteRange.startByte)
  const acknowledged = await nativeRun(ackSession.run)
  assert.equal(acknowledged.applied_input_bytes, claim.submit.inputByteRange.endByte); assert.ok(acknowledged.applied_input_bytes > beforeInput.applied_input_bytes)
  const secondCrash = await crash(second, ackPause.frameId); await ackPause.actionResult
  receipts.push({ phase, checkpoint: ackCheckpoint.source, operationId: bindingLocals.operationId, runId: bindingLocals.runId,
    phases: { payload: claim.payload, submit: claim.submit }, acceptedInputBytes: acknowledged.applied_input_bytes, crash: secondCrash,
    boundary: 'Core phase ACK persisted and actual Runtime input accepted; paused before Renderer event consumption; IPC Promise and native model execution not claimed.' })

  phase = 'third-process-ack-convergence'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const third = await launch('third')
  await waitFor('real canonical user message converges acknowledged intent', async () => {
    const value = await surface(third.cdp)
    return !(value.queues[fixture.expired.agentSessionId] ?? []).some(item => item.operationId === bindingLocals.operationId) ? value : null
  })
  const thirdState = await surface(third.cdp); assertSeedShape(thirdState, seed)
  assert.deepEqual(thirdState.workbench, atAckState.workbench); assert.deepEqual(thirdState.drafts, atAckState.drafts)
  const timelines = await third.cdp.evaluate(`window.agentmux.sessions.snapshot()`)
  const exactSession = timelines.sessions.find(item => item.id === fixture.expired.agentSessionId)
  assert.ok(exactSession); assert.equal(exactSession.control.run.runId, bindingLocals.runId)
  const acknowledgedItems = timelines.timelines[fixture.expired.agentSessionId].items
  assert.ok(acknowledgedItems.length > 0, 'Canonical acknowledged history must be nonempty')
  const messages = acknowledgedItems.filter(item => item.id === 'prompt:' + bindingLocals.operationId && item.kind === 'user_message')
  assert.equal(messages.length, 1); assert.equal(messages[0].content, prompt)
  assert.equal((await nativeRun(ackSession.run)).applied_input_bytes, acknowledged.applied_input_bytes)
  // Public Main-to-Core exact Run retry; do not reconstruct a queue already resolved by history.
  await third.cdp.evaluate(`window.agentmux.sessions.submitPrompt(${JSON.stringify(exactSession.control)},${JSON.stringify(prompt)},${JSON.stringify(bindingLocals.operationId)})`)
  assert.equal((await nativeRun(ackSession.run)).applied_input_bytes, acknowledged.applied_input_bytes)
  await assertNoExtraAgents({ ...startupCounts, expired: 2 })
  receipts.push({ phase, exactRunId: bindingLocals.runId, exactOperationId: bindingLocals.operationId,
    coreAckRetryInputBytes: acknowledged.applied_input_bytes, historicalQueueConverged: true })

  // A separate real explicit intent supplies the stale binding counterexample. Four actual Desktop
  // processes are used; no planted queue entry or rewritten history is used to manufacture it.
  phase = 'old-bound-run-becomes-unknown'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  await selectTab(third.cdp, 'missing')
  const stalePrompt = 'Separate explicit intent must never reroute to another Run'
  await editDraft(third.cdp, 'missing', stalePrompt)
  const staleCheckpoint = await installCheckpoint(third.cdp, 'binding', 'missing')
  const stalePause = await beginAndPause(third, staleCheckpoint, () => sendDraft(third.cdp, 'missing'))
  const stale = await third.cdp.evaluate('({operationId:entry.operationId,runId:pending.runId,text:entry.text})', stalePause.frameId)
  assert.ok(stale.operationId && stale.runId); assert.equal(stale.text, stalePrompt)
  const staleState = await surface(third.cdp, stalePause.frameId)
  assert.ok(staleState.queues[fixture.missing.agentSessionId]?.some(item => item.operationId === stale.operationId && item.runId === stale.runId))
  const staleSession = await currentStored('missing'); assert.equal(staleSession.run.runId, stale.runId)
  assert.equal((await nativeRun(staleSession.run)).applied_input_bytes, 0)
  const thirdCrash = await crash(third, stalePause.frameId); await stalePause.actionResult
  const staleEnded = await terminateOwnedRun(staleSession.run)
  client = await core.connectLocalAgentMux({ store })
  const replacement = await client.ensureAgentContinuity({ agentSessionId: staleSession.agentSessionId, expectedRun: staleSession.run,
    workspacePath, commandOverride: wrapper, env: { CODEX_HOME: nativeFixture.home }, injectAgentMuxGuide: false, operationId: randomUUID() })
  assert.equal(replacement.kind, 'resumed'); assert.notEqual(replacement.session.run.runId, stale.runId)
  await client.dispose(); client = null
  const replacementBefore = await nativeRun(replacement.session.run)
  const fourth = await launch('fourth')
  await selectTab(fourth.cdp, 'missing')
  const staleRestored = await waitFor('old binding remains visible and unknown', async () => {
    const state = await surface(fourth.cdp), entry = state.queues[fixture.missing.agentSessionId]?.find(item => item.operationId === stale.operationId)
    return entry?.runId === stale.runId ? { state, entry } : null
  })
  assertSeedShape(staleRestored.state, seed); assert.deepEqual(staleRestored.state.workbench, staleState.workbench)
  assert.deepEqual(staleRestored.state.drafts, staleState.drafts)
  await pointAndClick(fourth.cdp, "document.querySelector('[data-workbench-region-id=\"idle-agent-missing\"] button.composer__mailbox')")
  await pointAndClick(fourth.cdp, "[...document.querySelectorAll('[data-workbench-region-id=\"idle-agent-missing\"] [role=\"tab\"]')].find(e=>e.textContent.startsWith('Outbox'))")
  const stalePresentation = await waitFor('explicit stale binding service notice', () => fourth.cdp.evaluate(`(() => {
    const e=[...document.querySelectorAll('[data-workbench-region-id="idle-agent-missing"] .composer-outbox li')].find(e=>e.textContent.includes(${JSON.stringify(stalePrompt)}));
    return e?{text:e.textContent,send:[...document.querySelectorAll('[data-workbench-region-id="idle-agent-missing"] .composer-outbox > button')].filter(b=>b.textContent.trim()==='Send queued message').length}:null})()`))
  assert.match(stalePresentation.text, /unknown|another Run|changed/i); assert.equal(stalePresentation.send, 0)
  await delay(500); assert.equal((await nativeRun(replacement.session.run)).applied_input_bytes, replacementBefore.applied_input_bytes)
  await assertNoExtraAgents({ ...startupCounts, expired: 2, missing: 3 })
  assert.equal((await nativeRun(fixture.healthy.run)).pid, initialRuns.healthy.pid)
  receipts.push({ phase, originalBinding: stale, oldRunEnded: staleEnded, replacementRunId: replacement.session.run.runId,
    replacementInputBytes: replacementBefore.applied_input_bytes, stalePresentation, crash: thirdCrash })
  }
  phase = 'identity-and-helper-reaping'; process.stderr.write('idle_restore_phase=' + phase + '\n')
  const trace = await traces(), helpers = trace.filter(event => event.kind === 'helper' && event.edge === 'start')
  assert.ok(helpers.length > 0, 'Actual native reader helper costs must be observed separately')
  await waitFor('each actual native history helper exits', async () => {
    const latest = await traces(), starts = latest.filter(event => event.kind === 'helper' && event.edge === 'start')
    return starts.length > 0 && starts.every(event => latest.some(end => end.kind === 'helper' && end.edge === 'end' && end.pid === event.pid)) ? latest : null
  })
  const sourceHashes = await sourceIdentity()
  assert.deepEqual(sourceHashes, sourceBefore)
  assert.equal(hash(await readFile(import.meta.filename)), probeBefore)
  assert.equal(hash(await readFile(nativeCommand)), nativeBefore)
  assert.deepEqual(await compiledIdentity(), candidateBefore, 'Every process must execute the exact same reviewed compiled candidate')
  result = { scope: firstSliceOnly ? 'provisional-first-slice' : 'complete-T004-candidate',
    sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim(), sourceHashes,
    probeDigest: hash(await readFile(import.meta.filename)), compiledCandidate: candidateBefore,
    native: { version: nativeVersion, command: nativeCommand, commandSha256: hash(await readFile(nativeCommand)), privateHome: true,
      fixtureModuleSha256: hash(await readFile(join(desktopRoot, 'scripts/native-history-fixture.mjs'))),
      fixture: nativeFixture.fixture, preparation: nativeFixture.preparation },
    inputDigest: hash(JSON.stringify({ seed, clocks, wrapperSha256: hash(wrapperSource), nativeThreadId: nativeFixture.threadId })),
    fixture: { syntheticAgent: true, sessions: Object.fromEntries(labels.map(label => [label, { id: fixture[label].agentSessionId, originalRunId: fixture[label].run.runId, originalPid: initialRuns[label].pid }])) },
    phases: receipts, launcherTrace: await traces(), helperLaunches: helpers.length,
    limitations: ['Accepted input bytes and two-phase Core ACK belong to private synthetic cat Runs, not native model execution exactly once.',
      'Actual read-only native history is independently materialized synthetic conversation data, not a raw VT/TUI checkpoint.',
      'Electron flushStorageData returning void proves a flush request; abrupt second-process observations prove these particular persisted bindings.',
      'Provider isolation fixture is a configured unavailable CLI, not a missing dynamically registered Provider.',
      'Four private Desktop processes prove binding crash, ACK-before-consumer crash and stale binding independently; packaging/install identity is separate.'] }
} catch (error) { failure = error }
finally {
  const cleanupErrors = []
  const attempt = async action => { try { await action() } catch (error) { cleanupErrors.push(error) } }
  for (const child of children) await attempt(async () => { if (child.pid) signalExact(child.pid, 'SIGKILL') })
  await attempt(async () => { if (client) { await client.dispose(); client = null } })
  await attempt(async () => {
    // cat has exec'd away its private wrapper path. Use exact SDK-owned Agent Runs, never old PID
    // guesses, to reap its current process groups. Native helpers retain the private wrapper parent.
    if (sdk) {
      const summaries = await sdk.list()
      for (const summary of summaries) {
        const run = await sdk.status(summary.id)
        if (run.state.type !== 'running' || run.spec?.program !== wrapper || run.spec.cwd !== workspacePath) continue
        const identity = await processIdentity(run.pid)
        if (identity) { ownedRunProcesses.set(run.pid, { ...identity, runId: run.id }); signalExact(identity.group, 'SIGKILL') }
      }
    }
  })
  // SDK failure must not skip other known owned cats. Birth identity prevents reaping a reused PID.
  for (const original of ownedRunProcesses.values()) await attempt(async () => {
    const actual = await processIdentity(original.pid)
    if (!actual || actual.born !== original.born) return
    assert.equal(actual.group, original.group, 'Private Agent process group changed before cleanup')
    signalExact(actual.group, 'SIGKILL')
  })
  await attempt(async () => {
    const nonexistentGroup = process.pid + 1_000_000_000
    await stopProbeProcesses(nonexistentGroup, privateRoot)
    cleanup.remaining = await listProbeProcesses(nonexistentGroup, privateRoot)
    assert.deepEqual(cleanup.remaining, [])
    const unreaped = []
    for (const original of ownedRunProcesses.values()) {
      const actual = await processIdentity(original.pid)
      if (actual?.born === original.born) unreaped.push(actual)
    }
    assert.deepEqual(unreaped, [], 'Exact tracked Agent processes must also be gone after private cleanup')
    cleanup.privateProcessesReaped = true
    await rm(privateRoot, { recursive: true, force: true }); cleanup.temporaryRootRemoved = true
  })
  if (cleanupErrors.length) { failure ??= cleanupErrors[0]; cleanup.errors = cleanupErrors.map(error => error.message) }
  for (const [key, value] of previousEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
const receipt = { schema: 'agentmux.idle-aware-agent-restore.v1', passed: !failure, privateRoot, phase, ...result,
  partialPhases: result ? undefined : receipts, cleanup, failure: failure ? { name: failure.name, code: failure.code, message: failure.message, stack: failure.stack } : null }
try { await mkdir(join(repositoryRoot, '.tmp'), { recursive: true }); await writeFile(join(repositoryRoot, '.tmp/idle-aware-agent-restore-last.json'), JSON.stringify(receipt, null, 2) + '\n') }
catch (error) { failure ??= error; receipt.passed = false; receipt.failure = { name: failure.name, message: failure.message } }
process.stdout.write(JSON.stringify(receipt) + '\n')
if (failure) { process.stderr.write(failure.stack + '\n'); process.exitCode = 1 }
