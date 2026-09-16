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
// source is bound or read. Seed-only flushing establishes the old baseline; after actual UI edits,
// there is no unload, storage flush, app quit, or stopped producer before the first SIGKILL.
const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const require = createRequire(import.meta.url)
const exec = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-workbench-crash-')
const userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace')
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(name => [name, process.env[name]]))
const fixtureEnvironment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson') }
const children = new Set()
const deadline = Date.now() + 110_000
const tabId = 'crash-tab', agentRegionId = 'crash-agent', fileRegionId = 'crash-file'
const workspaceId = 'crash-workspace', groupId = 'crash-group', scratchGroupId = 'crash-scratch-group'
const oldDraft = 'Old durable draft', newDraft = 'New unsent draft must survive active Agent events and sudden process exit'
let client, session, producer, failure, result
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
  await waitFor(`${label} restored surfaces`, () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
  return { child, cdp }
}

async function seedWorkbench(seed) {
  const reportPath = join(root, 'seed-report.json')
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js')], {
    cwd: desktopRoot, detached: true, stdio: 'ignore', env: { ...process.env, ...fixtureEnvironment,
      AGENTMUX_DESKTOP_RECOVERY_REPORT: reportPath, AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed),
      AGENTMUX_DESKTOP_READY_FILE: join(root, 'seed-ready.json'), AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' }
  })
  children.add(child)
  await waitFor('seed process exit', () => child.exitCode !== null || child.signalCode !== null)
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
      editorText: editor?.innerText, splitPercent: panel ? Number(panel.getAttribute('data-panel-size')) : null,
      tabs: visible('[data-workbench-tab-id]').map(el => el.dataset.workbenchTabId).sort(),
      regions: visible('[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort(),
      activeRegions: visible('.workbench-region--active[data-workbench-region-id]').map(el => el.dataset.workbenchRegionId).sort() }
  })()`)
}

async function key(cdp, key, code) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
}

async function assertPrivateRunOutsideElectronGroup(electronPid, runPid) {
  const { stdout } = await exec('ps', ['-p', String(runPid), '-o', 'pgid='])
  const runGroup = Number(stdout.trim())
  assert.ok(runGroup > 0); assert.notEqual(runGroup, electronPid, 'Private Run must not belong to the Electron process group being killed')
  return runGroup
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
  Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_MESSAGE_QUEUE_PATH: fixtureEnvironment.AGENTMUX_MESSAGE_QUEUE_PATH })
  await mkdir(userData, { recursive: true }); await mkdir(workspacePath, { recursive: true })
  const executable = join(workspacePath, 'private-cat.sh'), bindingPath = join(root, 'private-hook-binding.json')
  // Generated identifiers/URL/token contain only the Core-defined safe ASCII alphabet. Never print
  // the binding or put it in argv; it belongs to this one temporary private Run only.
  await writeFile(executable, `#!/bin/sh\numask 077\nprintf '{"url":"%s","token":"%s","agentSessionId":"%s"}\\n' "$AGENTMUX_HOOK_URL" "$AGENTMUX_HOOK_TOKEN" "$AGENTMUX_AGENT_SESSION_ID" > '${bindingPath}'\nprintf 'Private crash proof PTY\\n'\nexec /bin/cat\n`, { mode: 0o700 })
  const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  client = await connectLocalAgentMux({ store })
  session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'probe', providerId: 'codex', commandOverride: executable,
    workspacePath, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  const originalRun = (await client.listRuns()).find(run => run.runId === session.run.runId)
  assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid)
  await client.dispose(); client = null
  await waitFor('private inherited Hook binding', async () => { try { const value = JSON.parse(await readFile(bindingPath, 'utf8')); return value.agentSessionId === session.agentSessionId ? value : null } catch { return null } })
  await writeFile(join(workspacePath, 'split.txt'), 'Other Region stays present\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private crash fixture' }],
    executors: { probe: { label: 'Private cat', providerId: 'codex', command: executable, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: workspaceId, name: 'Crash fixture', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: oldDraft }, restoredWorkbench: {
      tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: agentRegionId,
        layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId: agentRegionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: agentRegionId },
        regions: { [agentRegionId]: { regionId: agentRegionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId },
          [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: join(workspacePath, 'split.txt') } } } },
      layouts: { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        __scratch__: { root: { type: 'leaf', groupId: scratchGroupId }, groups: [{ id: scratchGroupId, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: scratchGroupId } }
    } } }
  await seedWorkbench(seed)
  const first = await launch('first')
  await delay(600) // Establish the pre-edit hydrated baseline, never flush a post-edit value.
  const before = await surface(first.cdp)
  assert.deepEqual(before.tabs, [tabId]); assert.deepEqual(before.regions, [agentRegionId, fileRegionId].sort())
  assert.equal(before.draft, oldDraft); assert.equal(before.splitPercent, 70)
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
  const lastEditAt = Date.now()
  const expectedWorkbench = structuredClone(before.workbench)
  expectedWorkbench.tabs[tabId].layout.root.ratio = 0.6
  expectedWorkbench.tabs[tabId].layout.activeRegionId = fileRegionId
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
  assert.equal(immediatelyBeforeCrash.editorText, newDraft); assert.equal(immediatelyBeforeCrash.splitPercent, 60)
  assert.deepEqual(immediatelyBeforeCrash.activeRegions, [fileRegionId])
  first.cdp.close()
  process.kill(-first.child.pid, 'SIGKILL') // Exact detached private Electron group; the Run is outside it.
  await waitFor('first abrupt exit', () => first.child.signalCode !== null || first.child.exitCode !== null, 5_000)
  assert.equal(first.child.signalCode, 'SIGKILL'); children.delete(first.child)
  process.kill(-producer.pid, 'SIGTERM')
  await waitFor('producer exit after crash', () => producer.signalCode !== null || producer.exitCode !== null, 3_000)
  children.delete(producer)
  const second = await launch('second')
  const restored = await surface(second.cdp)
  result = { schema: 'agentmux.workbench-persistence-crash.v1', sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim(),
    probeDigest: hash(await readFile(import.meta.filename)), desktopMainDigest: hash(await readFile(join(desktopRoot, 'out/main/index.js'))),
    rendererIdentity,
    storeSourceDigest: hash(await readFile(join(desktopRoot, 'src/renderer/src/store.ts'))), writerSourceDigest: hash(await readFile(join(desktopRoot, 'src/renderer/src/lib/persisted-ui-writer.ts'))),
    fixture: { syntheticPty: true, agentSessionId: session.agentSessionId, runId: session.run.runId, runPid: originalRun.pid },
    first: { pid: first.child.pid, signal: first.child.signalCode, producerPid: producer.pid, activeWindowMs: crashAt-lastEditAt,
      rendererHookEvents: hooks.length, maxEventGapMs: Math.max(...gaps), successfulHookPosts: acknowledgements.filter(item => item.status === 204).length,
      unloadEvents: observer.unloads, actualLocalStorageWrites: observer.writes, draftWasWrittenBeforeCrash: immediatelyBeforeCrash.draft === newDraft,
      newLayoutWasWrittenBeforeCrash: JSON.stringify(immediatelyBeforeCrash.workbench) === JSON.stringify(expectedWorkbench) },
    second: { pid: second.child.pid, workbenchDigest: hash(JSON.stringify(restored.workbench)), draftDigest: hash(restored.draft ?? ''),
      exactDraftRestored: restored.draft === newDraft, exactWorkbenchRestored: JSON.stringify(restored.workbench) === JSON.stringify(expectedWorkbench),
      exactAgentFocusRestored: JSON.stringify(restored.focus) === JSON.stringify(before.focus), visibleRegions: restored.regions, activeRegions: restored.activeRegions },
    limitations: ['Private synthetic Agent/PTY and ordinary UserPromptSubmit hook ingress only; no user history, native CLI or production app touched.',
      'No post-edit flushStorageData, unload, quit or quiet-event interval before SIGKILL.',
      'Renderer status counts observe public IPC arrival; actual Store consumption and projection bounds are verified by the owning behavioral suite.',
      'Source hashes are reference observations; compiled Main/Renderer identities and the separate build receipt bind executed code.',
      'Same Run process survival and input acceptance are checked separately from durable UI state.'] }
  assert.notEqual(first.child.pid, second.child.pid)
  assert.deepEqual(restored.workbench, expectedWorkbench, 'The exact edited workbench must survive sudden process termination while Agent events are active')
  assert.equal(restored.draft, newDraft, 'The unsent edited draft must survive without an unload flush')
  assert.deepEqual(restored.focus, before.focus); assert.deepEqual(restored.regions, [agentRegionId, fileRegionId].sort()); assert.deepEqual(restored.activeRegions, [fileRegionId])
  const sessions = await second.cdp.evaluate('window.agentmux.sessions.snapshot()')
  const attached = sessions.sessions.find(value => value.id === session.agentSessionId)
  assert.equal(attached?.processState, 'running'); assert.equal(attached.control.run.runId, session.run.runId)
  second.cdp.close(); process.kill(-second.child.pid, 'SIGKILL')
  await waitFor('second private exit', () => second.child.signalCode !== null || second.child.exitCode !== null, 5_000); children.delete(second.child)
  client = await connectLocalAgentMux({ store })
  const run = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(run?.state, 'running'); assert.equal(run.pid, originalRun.pid)
  await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: run.acceptedInputBytes, data: 'private-input-after-crash\r' })
  await waitFor('same private Run accepts input', async () => (await client.listRuns()).find(value => value.runId === session.run.runId)?.acceptedInputBytes > run.acceptedInputBytes)
  result.sameRunStillRunning = true; result.sameRunPid = true; result.privateInputAccepted = true
} catch (error) {
  failure = error
} finally {
  try {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    if (!client && session) client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
    if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } }
    await stopProbeProcesses(process.pid + 1_000_000_000, root)
    assert.deepEqual(await listProbeProcesses(process.pid + 1_000_000_000, root), [])
    cleanup.privateProcessesReaped = true
    await rm(root, { recursive: true, force: true })
    cleanup.temporaryRootRemoved = true
  } catch (error) { failure ??= error }
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
