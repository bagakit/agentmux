import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// The same real Desktop/Core/private-cat seam as verify-session-history-delivery. No native history
// source is bound or read. Seeded queue times are synthetic historical facts; the owning source test
// separately proves first admission's real clock. Seed-only flushing establishes the old baseline; after actual UI edits,
// the fixture requests no extra flush, unload, app quit, or stopped producer before the first SIGKILL; production write-triggered platform commits remain active.
const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const require = createRequire(import.meta.url)
const exec = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const probeRoot = process.argv.find(value => value.startsWith('--probe-root='))?.slice('--probe-root='.length)
const root = await mkdtemp(probeRoot ? join(probeRoot, 'workbench-crash-') : '/tmp/amx-workbench-crash-')
const userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace'), topicsPath = join(root, 'topics')
const codexHome = join(root, 'codex-home')
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'CODEX_HOME'].map(name => [name, process.env[name]]))
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson'), CODEX_HOME: codexHome }
const children = new Set()
const deadline = Date.now() + 110_000
const tabId = 'crash-tab', agentRegionId = 'crash-agent', fileRegionId = 'crash-file'
const workspaceId = 'crash-workspace', groupId = 'crash-group', scratchGroupId = 'crash-scratch-group'
const oldDraft = 'Old durable draft', newDraft = 'New unsent draft must survive active Agent events and sudden process exit'
const regionCloseProof = process.argv.includes('--close-region')
const holdForWatchdog = process.argv.includes('--hold-for-watchdog')
assert.ok(!holdForWatchdog || (regionCloseProof && probeRoot), 'Watchdog mutation belongs only to the owned close proof')
if (holdForWatchdog) process.on('SIGTERM', () => {}) // Exercise the runner's final SIGKILL, not graceful Node finally.
let client, session, producer, failure, result, ownedRunProcess
const cleanup = { privateProcessesReaped: false, temporaryRootRemoved: false }

async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Workbench crash proof timed out: ${label}`)
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let serial = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.fail(new Error(message.error.message)); else request.done(message.result)
  })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Private CDP closed')) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 15_000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  return { call, close: () => socket.close(), async evaluate(expression) {
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}

async function launch(label) {
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(process.env[name], undefined, 'Ordinary private launches must not inherit seed controls: ' + name)
  const readyFile = join(root, `ready-${label}.json`)
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...fixtureEnvironment, AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  let debuggingUrl, diagnostics = ''
  child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-8192); debuggingUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  await waitFor(`${label} ready`, async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private Electron exited before ready: ${child.exitCode}/${child.signalCode}; ${diagnostics}`)
    try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch { return null }
  })
  const endpoint = new URL(await waitFor(`${label} debugger`, () => debuggingUrl))
  const target = await waitFor(`${label} renderer`, async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  // Only the private fixture gets focus emulation: an occluded native window otherwise pauses
  // requestAnimationFrame and turns hydration/input verification into a visibility timeout.
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  try {
  await waitFor(`${label} restored surfaces`, () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]')${!regionCloseProof || label === 'first' ? ` && document.querySelector('[data-workbench-region-id="${fileRegionId}"]')` : ''})`))
  } catch (error) {
    const observed = await cdp.evaluate(`({text:document.querySelector('main')?.innerText.slice(0,800),
      stored:JSON.parse(localStorage.getItem('agentmux-workbench-v1')),
      regions:[...document.querySelectorAll('[data-workbench-region-id]')].map(n=>n.dataset.workbenchRegionId),errors:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent)})`).catch(cause => ({diagnosticError:cause.message}))
    await mkdir(join(repositoryRoot,'.tmp'),{recursive:true})
    await writeFile(join(repositoryRoot,'.tmp/region-close-launch-failure.json'),JSON.stringify(observed,null,2))
    throw new Error(`${error.message}; observed=${JSON.stringify(observed)}`)
  }
  const origin = await cdp.evaluate('({url:location.href,origin:location.origin})'); return { child, cdp, origin }
}

async function seedWorkbench(seed) {
  const reportPath = join(root, 'seed-report.json')
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...fixtureEnvironment,
      AGENTMUX_DESKTOP_RECOVERY_REPORT: reportPath, AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed),
      AGENTMUX_DESKTOP_READY_FILE: join(root, 'seed-ready.json'), AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' }
  })
  children.add(child)
  let debuggingUrl, diagnostics = ''
  child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-8192); debuggingUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  const endpoint = new URL(await waitFor('seed debugger', () => debuggingUrl))
  const target = await waitFor('seed renderer', async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  try {
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('seed process exit', () => child.exitCode !== null || child.signalCode !== null)
  } finally { cdp.close() }
  assert.equal(child.exitCode, 0)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.workbench.tabIds, [tabId]); assert.equal(report.workbench.drafts[session.agentSessionId], oldDraft)
  children.delete(child)
}

async function surface(cdp) {
  return cdp.evaluate(`(() => {
    const state = JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state
    const visible = selector => Array.from(document.querySelectorAll(selector)).filter(el => el.getClientRects().length > 0)
    const editor = document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]')
    const panel = document.querySelector('.workbench-region-split > [data-panel]')
    return { workbench: state.restoredWorkbench, focus: state.agentFocus, draft: state.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],
      queued: state.agentSteerQueues[${JSON.stringify(session.agentSessionId)}],
      outbox: visible('.composer-outbox li').map(row => ({ text: row.querySelector('span')?.textContent,
        datetime: row.querySelector('time')?.getAttribute('datetime') ?? null,
        unknownTime: row.textContent.includes('Queued time unknown') })),
      editorText: editor?.innerText, splitPercent: panel ? Number(panel.getAttribute('data-panel-size')) : null,
      tabs: visible('[data-workbench-tab-id]').map(el => el.dataset.workbenchTabId).sort(),
      regions: visible('[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort(),
      activeRegions: visible('.workbench-region--active[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort() }
  })()`)
}

async function key(cdp, key, code) {
  const windowsVirtualKeyCode = key === 'Enter' ? 13 : key === 'ArrowLeft' ? 37 : undefined
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

async function activateButton(cdp, expression) {
  const ready = await cdp.evaluate(`(() => {
    const button = ${expression}
    if (!button || button.disabled || button.getClientRects().length === 0) return false
    button.focus()
    return document.activeElement === button
  })()`)
  assert.equal(ready, true, 'The exact visible queue action must accept keyboard focus: ' + expression)
  await key(cdp, 'Enter', 'Enter')
}

async function assertPrivateRunOutsideElectronGroup(electronPid, runPid) {
  const { stdout } = await exec('ps', ['-p', String(runPid), '-o', 'pgid='])
  const runGroup = Number(stdout.trim())
  assert.ok(runGroup > 0); assert.notEqual(runGroup, electronPid, 'Private Run must not belong to the Electron process group being killed')
  return runGroup
}

async function runProcessIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  let stdout
  try { ({ stdout } = await exec('ps', ['-p', String(pid), '-o', 'pgid=,lstart='], { timeout: 5_000 })) }
  catch (error) { if (error.code === 1) return null; throw error }
  const match = /^\s*(\d+)\s+(.+)$/.exec(stdout.trim())
  assert.ok(match, 'A live private Run must have an exact process birth identity')
  const group = Number(match[1]); assert.ok(group > 1)
  return { pid, group, born: match[2] }
}

async function compiledRendererIdentity() {
  const rendererRoot = join(desktopRoot, 'out/renderer')
  const html = await readFile(join(rendererRoot, 'index.html'), 'utf8')
  const entries = [...html.matchAll(/\bsrc="([^"]+\.js)"/g)].map(match => match[1])
  assert.ok(entries.length > 0, 'The actual Renderer entry must be bound to this execution receipt')
  const assets = await Promise.all((await readdir(join(rendererRoot, 'assets'))).filter(name => name.endsWith('.js')).sort()
    .map(async name => ({ name, sha256: hash(await readFile(join(rendererRoot, 'assets', name))) })))
  assert.ok(assets.length > 0)
  return { htmlDigest: hash(html), entries, assets }
}

try {
  const rendererIdentity = await compiledRendererIdentity()
  // Provider Hook installation occurs even for a synthetic command. Parent Core setup and every
  // Electron child must share this private home rather than touching the user's native CLI config.
  Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
    AGENTMUX_MESSAGE_QUEUE_PATH: fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH, CODEX_HOME: codexHome })
  await mkdir(userData, { recursive: true }); await mkdir(workspacePath, { recursive: true })
  await mkdir(topicsPath, { recursive: true })
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  const executable = join(workspacePath, 'private-cat.sh'), bindingPath = join(root, 'private-hook-binding.json')
  // Generated identifiers/URL/token contain only the Core-defined safe ASCII alphabet. Never print
  // the binding or put it in argv; it belongs to this one temporary private Run only.
  // Record birth identity before exec removes the wrapper path from argv. The outer watchdog can
  // reap this exact detached cat even when it kills Node before Node's finally can run.
  await writeFile(executable, `#!/bin/sh\numask 077\nLC_ALL=C /bin/ps -p "$$" -o pid=,pgid=,lstart= > '${join(root, 'owned-run-process.txt')}'\nprintf '{"url":"%s","token":"%s","agentSessionId":"%s"}\\n' "$AGENTMUX_HOOK_URL" "$AGENTMUX_HOOK_TOKEN" "$AGENTMUX_AGENT_SESSION_ID" > '${bindingPath}'\nprintf 'Private crash proof PTY\\n'\nexec /bin/cat\n`, { mode: 0o700 })
  const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  client = await connectLocalAgentMux({ store })
  session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'probe', providerId: 'codex', commandOverride: executable,
    workspacePath, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  const originalRun = (await client.listRuns()).find(run => run.runId === session.run.runId)
  assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid)
  assert.ok(Number.isFinite(originalRun.acceptedInputBytes) && originalRun.acceptedInputBytes >= 0,
    'Zero-replay proof requires an actual known Runtime input cursor')
  ownedRunProcess = await runProcessIdentity(originalRun.pid); assert.ok(ownedRunProcess)
  if (holdForWatchdog) {
    await client.dispose(); client = null
    console.error('region_restart_private_run_ready')
    await waitFor('outer watchdog must terminate this private mutation', () => false, 105_000)
  }
  await client.dispose(); client = null
  await waitFor('private inherited Hook binding', async () => { try { const value = JSON.parse(await readFile(bindingPath, 'utf8')); return value.agentSessionId === session.agentSessionId ? value : null } catch { return null } })
  await writeFile(join(workspacePath, 'split.txt'), 'Other Region stays present\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private crash fixture' }],
    executors: { probe: { label: 'Private cat', providerId: 'codex', command: executable, args: [], env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false } },
    workspaces: [{ id: '__scratch__', name: 'Private Topics', hostId: 'local', path: topicsPath, kind: 'folder' },
      { id: workspaceId, name: 'Crash fixture', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: oldDraft },
    agentSteerQueues: { [session.agentSessionId]: [
      { operationId: 'private-queue-first', runId: session.run.runId, text: 'Private first pending intent', status: 'queued', enqueuedAt: 1_790_832_000_000 },
      { operationId: 'private-queue-unknown', runId: session.run.runId, text: 'Private unknown-time pending intent', status: 'queued' },
      { operationId: 'private-queue-last', runId: session.run.runId, text: 'Private last pending intent', status: 'queued', enqueuedAt: 1_790_832_090_000 }
    ] }, restoredWorkbench: {
      tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: agentRegionId,
        layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId: agentRegionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: agentRegionId },
        regions: { [agentRegionId]: { regionId: agentRegionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId },
          [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: 'split.txt' } } } },
      layouts: { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        __scratch__: { root: { type: 'leaf', groupId: scratchGroupId }, groups: [{ id: scratchGroupId, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: scratchGroupId } }
    } } }
  await seedWorkbench(seed)
  const first = await launch('first')
  await delay(600) // Establish the pre-edit hydrated baseline, never flush a post-edit value.
  const before = await surface(first.cdp)
  assert.deepEqual(before.tabs, [tabId]); assert.deepEqual(before.regions, [agentRegionId, fileRegionId].sort())
  assert.equal(before.draft, oldDraft); assert.equal(before.splitPercent, 70)
  assert.deepEqual(before.queued.map(entry => entry.operationId), ['private-queue-first', 'private-queue-unknown', 'private-queue-last'])
  assert.deepEqual(before.queued.map(entry => entry.errorCode), Array(3).fill('AGENT_EXECUTION_NOT_REQUESTED'))
  await first.cdp.evaluate(`(() => {
    window.__crashProof = { hooks: [], writes: [], unloads: [] }
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(name, value) {
      if (this === localStorage && name === 'agentmux-workbench-v1') window.__crashProof.writes.push({ at: Date.now(), bytes: value.length })
      return original.call(this, name, value)
    }
    window.agentmux.sessions.onEvent(event => {
      if (event.event.type === 'agent-status' && event.event.agentSessionId === ${JSON.stringify(session.agentSessionId)} && event.event.evidence.source === 'native-hook')
        window.__crashProof.hooks.push({ at: Date.now(), observedAt: event.event.evidence.observedAt })
    })
    for (const name of ['beforeunload', 'pagehide']) window.addEventListener(name, () => window.__crashProof.unloads.push(name))
    return true
  })()`)
  const producerPath = join(root, 'status-producer.mjs')
  await writeFile(producerPath, `import {readFile} from 'node:fs/promises';\nconst binding=JSON.parse(await readFile(${JSON.stringify(bindingPath)},'utf8'));\nlet receipts=0;\nfor(;;){const start=Date.now();try {const r=await fetch(binding.url,{method:'POST',headers:{authorization:'Bearer '+binding.token,'content-type':'application/json'},body:JSON.stringify({receiptId:'private-crash-'+(++receipts),eventName:'UserPromptSubmit',payload:{}}),signal:AbortSignal.timeout(1000)});process.stdout.write(JSON.stringify({at:Date.now(),status:r.status,receipts})+'\\n');}catch{process.stdout.write(JSON.stringify({at:Date.now(),status:'unavailable',receipts})+'\\n');}await new Promise(r=>setTimeout(r,Math.max(0,100-(Date.now()-start))));}\n`, { mode: 0o600 })
  producer = spawn(process.execPath, [producerPath], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } })
  children.add(producer)
  const acknowledgements = []
  let producerTail = ''
  producer.stdout.on('data', data => { producerTail += data; const lines = producerTail.split('\n'); producerTail = lines.pop(); for (const line of lines) if (line) acknowledgements.push(JSON.parse(line)) })
  await waitFor('real native-hook status reaches Renderer', () => first.cdp.evaluate('window.__crashProof.hooks.length >= 2'))
  // Keyboard activation exercises actual native popover and React buttons without changing Agent
  // MRU focus through an unrelated pointer event. It does not grant permission to send old intent.
  await activateButton(first.cdp, `document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer__mailbox')`)
  await waitFor('actual mailbox visible', () => first.cdp.evaluate("document.querySelector('.composer-mailbox').getClientRects().length > 0 && document.querySelector('.composer-mailbox').dataset.state === 'open'"))
  await activateButton(first.cdp, "document.querySelector('.composer-mailbox [role=tab][id$=\"-outbox-tab\"]')")
  // Native key dispatch returns before React has necessarily projected the selected tab.
  // Wait for the actual seeded rows, then assert exact content/timestamps below. Empty never passes.
  await waitFor('selected outbox projects all seeded rows', async () => (await surface(first.cdp)).outbox.length === 3)
  const beforeMove = await surface(first.cdp)
  assert.deepEqual(beforeMove.outbox, [
    { text: 'Private first pending intent', datetime: new Date(1_790_832_000_000).toISOString(), unknownTime: false },
    { text: 'Private unknown-time pending intent', datetime: null, unknownTime: true },
    { text: 'Private last pending intent', datetime: new Date(1_790_832_090_000).toISOString(), unknownTime: false }
  ])
  const moveLastUp = "Array.from(document.querySelectorAll('.composer-outbox li')).find(row => row.querySelector('span')?.textContent === 'Private last pending intent')?.querySelectorAll('button')[0]"
  await activateButton(first.cdp, moveLastUp)
  await activateButton(first.cdp, moveLastUp)
  const expectedQueue = [before.queued[2], before.queued[0], before.queued[1]]
  await waitFor('actual outbox reordered', async () => (await surface(first.cdp)).outbox.map(row => row.text).join('|') === expectedQueue.map(entry => entry.text).join('|'))
  await activateButton(first.cdp, "document.querySelector('.composer-mailbox button[aria-label=\"Close mailbox\"]')")
  await waitFor('mailbox closed', () => first.cdp.evaluate("document.querySelector('.composer-mailbox').getClientRects().length === 0"))
  // Focus the already-active Agent editor without a pointer event that would change its MRU time.
  await first.cdp.evaluate(`(() => { const e = document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]'); e.focus(); const s = getSelection(); s.selectAllChildren(e); return true })()`)
  await first.cdp.call('Input.insertText', { text: newDraft })
  await waitFor('actual composer changed', async () => (await surface(first.cdp)).editorText === newDraft)
  // Existing react-resizable-panels defaults a native ArrowLeft to -10 percentage points.
  await first.cdp.evaluate("document.querySelector('.workbench-region-resize-handle').focus()")
  await key(first.cdp, 'ArrowLeft', 'ArrowLeft')
  await waitFor('actual split changed', async () => (await surface(first.cdp)).splitPercent === 60)
  const point = await first.cdp.evaluate(`(() => { const r = document.querySelector('[data-workbench-region-id="${fileRegionId}"]').getBoundingClientRect(); return { x: r.x+20, y: r.y+20 } })()`)
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await first.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await waitFor('actual file Region focus changed', async () => { const s = await surface(first.cdp); return s.activeRegions.length === 1 && s.activeRegions[0] === fileRegionId })
  let lastEditAt = Date.now()
  const expectedWorkbench = structuredClone(before.workbench)
  expectedWorkbench.tabs[tabId].layout.root.ratio = 0.6
  expectedWorkbench.tabs[tabId].layout.activeRegionId = fileRegionId
  if (regionCloseProof) {
    // Close the existing file Region through its actual X. Dirty cancellation/confirmation is
    // separately exercised by the mounted Workbench owner; Editor loading is not a Header gate.
    const closePoint = await first.cdp.evaluate(`(() => {
      const button=document.querySelector('[data-workbench-region-id="${fileRegionId}"] .workbench-region__close'), r=button.getBoundingClientRect();
      if(r.width<=0 || r.height<=0)throw new Error('Actual file Region X has no hit area');
      const point={x:r.x+r.width/2,y:r.y+r.height/2};
      if(document.elementFromPoint(point.x,point.y)?.closest('.workbench-region__close')!==button)throw new Error('Actual file Region X is covered');
      return point
    })()`)
    for (const type of ['mousePressed','mouseReleased']) await first.cdp.call('Input.dispatchMouseEvent', { type, ...closePoint, button:'left', clickCount:1 })
    await waitFor('only exact file Region closed', async () => JSON.stringify((await surface(first.cdp)).regions) === JSON.stringify([agentRegionId]))
    const expectedTab=expectedWorkbench.tabs[tabId]
    expectedTab.layout={root:{type:'leaf',regionId:agentRegionId},activeRegionId:agentRegionId}
    delete expectedTab.regions[fileRegionId]
    lastEditAt=Date.now()
  }
  await assertPrivateRunOutsideElectronGroup(first.child.pid, originalRun.pid)
  await delay(Math.max(0, lastEditAt + 2_000 - Date.now()))
  const immediatelyBeforeCrash = await surface(first.cdp)
  const observer = await first.cdp.evaluate('window.__crashProof')
  const crashAt = Date.now()
  const hooks = observer.hooks.filter(event => event.at >= lastEditAt)
  assert.ok(hooks.length >= 12, 'The producer must keep emitting real accepted Renderer events during the fixed two-second window')
  const gaps = [hooks[0].at-lastEditAt, ...hooks.slice(1).map((event, i) => event.at-hooks[i].at), crashAt-hooks.at(-1).at]
  assert.ok(Math.max(...gaps) < 400, 'No quiet debounce interval may occur before the abrupt crash')
  assert.equal(producer.exitCode, null); assert.equal(producer.signalCode, null)
  assert.equal(acknowledgements.at(-1)?.status, 204); assert.ok(crashAt-acknowledgements.at(-1).at < 400)
  assert.deepEqual(observer.unloads, [])
  assert.equal(immediatelyBeforeCrash.editorText, newDraft); assert.equal(immediatelyBeforeCrash.splitPercent, regionCloseProof ? null : 60)
  assert.deepEqual(immediatelyBeforeCrash.queued, expectedQueue, 'Actual queue order and its recorded or unknown times must be written before the abrupt crash')
  // The sole surviving Region stays active in durable layout; its ring has no competing choice.
  assert.deepEqual(immediatelyBeforeCrash.activeRegions, regionCloseProof ? [] : [fileRegionId])
  first.cdp.close()
  process.kill(-first.child.pid, 'SIGKILL') // Exact detached private Electron group; the Run is outside it.
  await waitFor('first abrupt exit', () => first.child.signalCode !== null || first.child.exitCode !== null, 5_000)
  assert.equal(first.child.signalCode, 'SIGKILL'); children.delete(first.child)
  process.kill(-producer.pid, 'SIGTERM')
  await waitFor('producer exit after crash', () => producer.signalCode !== null || producer.exitCode !== null, 3_000)
  children.delete(producer)
  const second = await launch('second')
  assert.deepEqual(second.origin, first.origin, 'Both real processes must use the exact same browser storage origin')
  const restored = await surface(second.cdp)
  result = { schema: 'agentmux.workbench-persistence-crash.v1', sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim(),
    regionClose: regionCloseProof,
    probeDigest: hash(await readFile(import.meta.filename)), desktopMainDigest: hash(await readFile(join(desktopRoot, 'out/main/index.js'))),
    rendererIdentity,
    storeSourceDigest: hash(await readFile(join(desktopRoot, 'src/renderer/src/store.ts'))), writerSourceDigest: hash(await readFile(join(desktopRoot, 'src/renderer/src/lib/persisted-ui-writer.ts'))),
    fixture: { userData, origin: first.origin, ordinaryLaunchSeedControlsAbsent: true, syntheticPty: true, agentSessionId: session.agentSessionId, runId: session.run.runId, runPid: originalRun.pid },
    first: { pid: first.child.pid, signal: first.child.signalCode, producerPid: producer.pid, activeWindowMs: crashAt-lastEditAt,
      rendererHookEvents: hooks.length, maxEventGapMs: Math.max(...gaps), successfulHookPosts: acknowledgements.filter(item => item.status === 204).length,
      unloadEvents: observer.unloads, actualLocalStorageWrites: observer.writes, draftWasWrittenBeforeCrash: immediatelyBeforeCrash.draft === newDraft,
      newLayoutWasWrittenBeforeCrash: JSON.stringify(immediatelyBeforeCrash.workbench) === JSON.stringify(expectedWorkbench),
      movedQueueWasWrittenBeforeCrash: JSON.stringify(immediatelyBeforeCrash.queued) === JSON.stringify(expectedQueue) },
    second: { pid: second.child.pid, workbenchDigest: hash(JSON.stringify(restored.workbench)), draftDigest: hash(restored.draft ?? ''),
      exactDraftRestored: restored.draft === newDraft, exactWorkbenchRestored: JSON.stringify(restored.workbench) === JSON.stringify(expectedWorkbench),
      exactAgentFocusRestored: JSON.stringify(restored.focus) === JSON.stringify(before.focus), visibleRegions: restored.regions, activeRegions: restored.activeRegions,
      exactMovedQueueRestored: JSON.stringify(restored.queued) === JSON.stringify(expectedQueue), queuedDigest: hash(JSON.stringify(restored.queued)) },
    limitations: ['Private synthetic Agent/PTY and ordinary UserPromptSubmit hook ingress only; no user history, native CLI or production app touched.',
      'No fixture/manual post-edit storage flush, unload, quit or quiet-event interval before SIGKILL; actual production write-triggered platform requests remain active.',
      'Historical queue admission times are synthetic seeded facts; actual first-admission clock behavior is separately bound by the owning source test.',
      'Renderer status counts observe public IPC arrival; actual Store consumption and projection bounds are verified by the owning behavioral suite.',
      'Source hashes are reference observations; compiled Main/Renderer identities and the separate build receipt bind executed code.',
      'Same Run process survival and input acceptance are checked separately from durable UI state.'] }
  assert.notEqual(first.child.pid, second.child.pid)
  assert.deepEqual(restored.workbench, expectedWorkbench, 'The exact edited workbench must survive sudden process termination while Agent events are active')
  assert.equal(restored.draft, newDraft, 'The unsent edited draft must survive without an unload flush')
  assert.deepEqual(restored.queued, expectedQueue, 'Moved pending order, immutable admission time and historical execution pause must survive the second process')
  assert.deepEqual(restored.focus, before.focus); assert.deepEqual(restored.regions, regionCloseProof ? [agentRegionId] : [agentRegionId, fileRegionId].sort()); assert.deepEqual(restored.activeRegions, regionCloseProof ? [] : [fileRegionId])
  const sessions = await second.cdp.evaluate('window.agentmux.sessions.snapshot()')
  const attached = sessions.sessions.find(value => value.id === session.agentSessionId)
  assert.equal(attached?.processState, 'running'); assert.equal(attached.control.run.runId, session.run.runId)
  second.cdp.close(); process.kill(-second.child.pid, 'SIGKILL')
  await waitFor('second private exit', () => second.child.signalCode !== null || second.child.exitCode !== null, 5_000); children.delete(second.child)
  client = await connectLocalAgentMux({ store })
  const run = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(run?.state, 'running'); assert.equal(run.pid, originalRun.pid)
  assert.equal(run.acceptedInputBytes, originalRun.acceptedInputBytes, 'Reading, moving and restarting pending intent must not write any input to this private Run')
  result.pendingQueueAutomaticallyReplayed = false
  await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: run.acceptedInputBytes, data: 'private-input-after-crash\r' })
  await waitFor('same private Run accepts input', async () => (await client.listRuns()).find(value => value.runId === session.run.runId)?.acceptedInputBytes > run.acceptedInputBytes)
  result.sameRunStillRunning = true; result.sameRunPid = true; result.privateInputAccepted = true
} catch (error) {
  failure = error
} finally {
  if (holdForWatchdog) await writeFile(join(root, 'inner-finally-reached'), 'Node finally ran\n')
  const cleanupErrors = []
  const attempt = async action => { try { await action() } catch (error) { cleanupErrors.push(error) } }
  for (const child of children) await attempt(async () => {
    if (!child.pid) return
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1)
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  })
  await attempt(async () => {
    if (!client && session) client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
    if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } }
  })
  // A Core/transport cleanup failure cannot skip the detached cat whose argv no longer
  // contains its private wrapper path. Birth identity prevents acting on a reused PID.
  await attempt(async () => {
    if (!ownedRunProcess) return
    const actual = await runProcessIdentity(ownedRunProcess.pid)
    if (!actual || actual.born !== ownedRunProcess.born) return
    assert.equal(actual.group, ownedRunProcess.group)
    try { process.kill(-actual.group, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  })
  await attempt(async () => {
    await stopProbeProcesses(process.pid + 1_000_000_000, root)
    assert.deepEqual(await listProbeProcesses(process.pid + 1_000_000_000, root), [])
    const remainingRun = ownedRunProcess && await runProcessIdentity(ownedRunProcess.pid)
    assert.ok(!remainingRun || remainingRun.born !== ownedRunProcess.born, 'The exact private Agent process must also be reaped')
    cleanup.privateProcessesReaped = true
    await rm(root, { recursive: true, force: true })
    cleanup.temporaryRootRemoved = true
  })
  if (cleanupErrors.length) { failure ??= cleanupErrors[0]; cleanup.errors = cleanupErrors.map(error => error.message) }
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
}
const receipt = { schema: 'agentmux.workbench-persistence-crash.v1', ...result, passed: !failure,
  failure: failure ? { name: failure.name, message: failure.message } : null, cleanup }
// Task gate captures command output without preserving it on a failed command. Keep the same receipt
// in the ignored diagnostic directory so an early failure remains inspectable after private cleanup.
try {
  await mkdir(join(repositoryRoot, '.tmp'), { recursive: true })
  await writeFile(join(repositoryRoot, '.tmp/workbench-persistence-last-crash.json'), `${JSON.stringify(receipt)}\n`)
} catch (error) {
  failure ??= error
  receipt.passed = false
  receipt.failure = { name: failure.name, message: failure.message }
}
process.stdout.write(`${JSON.stringify(receipt)}\n`)
if (failure) { process.stderr.write(`${failure.stack}\n`); process.exitCode = 1 }
