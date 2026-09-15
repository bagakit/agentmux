import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// This probe uses the real Desktop, IPC, Core and existing native read endpoint. Its live PTY is an
// explicitly synthetic shell owned by a private Runtime, never the user's Agent. Only its isolated
// canonical fixture record points at the requested read-only native source. No native start/resume
// or turn RPC is issued. Conversation bodies never enter the receipt.
const desktopRoot = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const nativeSessionId = process.env.AGENTMUX_HISTORY_NATIVE_SESSION_ID
if (!nativeSessionId) throw new Error('Set AGENTMUX_HISTORY_NATIVE_SESSION_ID to the exact authorized native Session; the probe will not guess or enumerate history.')
const temporaryRoot = await mkdtemp('/tmp/amx-native-history-')
const userData = join(temporaryRoot, 'user-data')
const runtimeDirectory = join(temporaryRoot, 'runtime')
const workspacePath = join(temporaryRoot, 'workspace')
const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
const probeDigest = hash(await readFile(import.meta.filename))
const children = new Set()
let client
let session
let result
const deadline = Date.now() + 90_000

async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await delay(80)
  }
  throw new Error(`Native history delivery timed out: ${label}`)
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let serial = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.fail(new Error(message.error.message))
    else request.done(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Isolated CDP closed')) }
    pending.clear()
  })
  function call(method, params = {}) {
    const id = ++serial
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timed out: ${method}`)) }, 15_000)
      pending.set(id, { done, fail, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  return { call, close: () => socket.close(), async evaluate(expression) {
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}

async function launch(label) {
  const readyFile = join(temporaryRoot, `ready-${label}.json`)
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
      AGENTMUX_DESKTOP_READY_FILE: readyFile }
  })
  children.add(child)
  let debuggingUrl
  let diagnostics = ''
  child.stderr.on('data', (value) => {
    diagnostics = (diagnostics + value).slice(-32_768)
    debuggingUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
  })
  await waitFor(`${label} ready`, async () => {
    if (child.exitCode !== null) throw new Error(`Isolated Electron exited (${child.exitCode}) before readiness; ${diagnostics}`)
    try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch { return null }
  })
  const endpoint = new URL(await waitFor(`${label} debugger`, () => debuggingUrl))
  const page = await waitFor(`${label} renderer`, async () => {
    const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json()
    return targets.find((target) => target.type === 'page' && target.url.startsWith('file:'))
  })
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  await waitFor(`${label} hydration`, () => cdp.evaluate("Boolean(document.querySelector('.app-shell'))"))
  return { child, cdp, async interrupt() {
    cdp.close()
    // Deliberately interrupt this Electron process only: the same healthy private Run must survive
    // and be reattached by the next process. Final cleanup separately reaps the private daemon.
    if (child.exitCode === null) process.kill(-child.pid, 'SIGTERM')
    await waitFor(`${label} exit`, () => child.exitCode !== null || child.signalCode !== null, 5_000)
    children.delete(child)
    return { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }
  } }
}

const tabId = 'history-probe-tab'
const regionId = 'history-probe-agent'
const fileRegionId = 'history-probe-file'
const groupId = 'history-probe-group'
const workspaceId = 'history-probe-workspace'
const scratchGroupId = 'history-probe-scratch-group'
const draft = 'Unsent draft survives native reading and Electron interruption'
let expectedWorkbench

async function seedWorkbench(seed) {
  // Reuse the production restart probe's flushed, seed-then-exit seam. It exits before an unload
  // writer can overwrite the fixture and does not reap the healthy private Run or its daemon.
  const reportPath = join(temporaryRoot, 'seed-report.json')
  const child = spawn(require('electron'), [join(desktopRoot, 'out/main/index.js')], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
      AGENTMUX_DESKTOP_RECOVERY_REPORT: reportPath, AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed),
      AGENTMUX_DESKTOP_READY_FILE: join(temporaryRoot, 'seed-ready.json'), AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' }
  })
  children.add(child)
  await waitFor('durable seed process exit', () => child.exitCode !== null || child.signalCode !== null)
  assert.equal(child.exitCode, 0, 'Seed must exit successfully after flushing durable storage')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.workbench.tabIds, [tabId])
  assert.equal(report.workbench.drafts[session.agentSessionId], draft)
  children.delete(child)
}

async function readSurface(processProbe) {
  const { cdp } = processProbe
  await waitFor('restored Region and history entry', () => cdp.evaluate(`(() => {
    const region = document.querySelector('[data-workbench-region-id="${regionId}"]')
    return Boolean(region?.querySelector('.terminal-history-action'))
  })()`))
  const before = await cdp.evaluate(`(() => {
    const region = document.querySelector('[data-workbench-region-id="${regionId}"]')
    window.__historyProbeTerminal = region.querySelector('.xterm')
    const state = JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state
    return { tabs: Object.keys(state.restoredWorkbench.tabs), workbench: state.restoredWorkbench,
      focus: state.agentFocus, draft: state.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],
      terminalPresent: Boolean(window.__historyProbeTerminal) }
  })()`)
  assert.equal(before.terminalPresent, true)
  assert.deepEqual(before.tabs, [tabId])
  assert.deepEqual(before.workbench.layouts, expectedWorkbench.layouts)
  assert.deepEqual(before.workbench.tabs[tabId].layout, expectedWorkbench.tabs[tabId].layout)
  assert.deepEqual(Object.keys(before.workbench.tabs[tabId].regions).sort(), [regionId, fileRegionId].sort())
  assert.equal(before.draft, draft)
  assert.equal(before.focus.execution.sessionId, session.agentSessionId)
  assert.deepEqual(before.focus.execution.history.map((item) => item.sessionId), [session.agentSessionId])
  const renderedRegions = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-workbench-region-id]'))
    .filter(el => el.getClientRects().length > 0).map(el => el.dataset.workbenchRegionId).sort()`)
  assert.deepEqual(renderedRegions, [regionId, fileRegionId].sort())
  await cdp.evaluate(`document.querySelector('[data-workbench-region-id="${regionId}"] .terminal-history-action').click()`)
  const snapshot = () => cdp.evaluate(`(() => {
    const history = document.querySelector('[data-workbench-region-id="${regionId}"] .session-history')
    const viewport = history?.querySelector('.session-history__viewport')
    const rect = viewport?.getBoundingClientRect()
    return { ids: [...(history?.querySelectorAll('[data-history-item-id]') ?? [])].map(el => el.dataset.historyItemId),
      source: history?.querySelector('.session-history__source')?.title,
      loading: Boolean(history?.querySelector('.spin')), error: history?.querySelector('.session-history__notice')?.textContent,
      scrollTop: viewport?.scrollTop, scrollHeight: viewport?.scrollHeight,
      bounds: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, height: rect.height } : null,
      terminalSame: window.__historyProbeTerminal === document.querySelector('[data-workbench-region-id="${regionId}"] .xterm') }
  })()`)
  const initial = await waitFor('actual native page rendered', async () => {
    const state = await snapshot()
    if (state.error) throw new Error(state.error)
    return !state.loading && state.ids.length > 0 ? state : null
  })
  assert.equal(initial.source, `codex · ${nativeSessionId}`)
  assert.equal(initial.terminalSame, true)
  const initialIds = new Set(initial.ids)
  let older
  let wheels = 0
  while (wheels < 24 && !older) {
    const state = await snapshot()
    assert.ok(state.bounds?.height > 0, 'History viewport must have real geometry')
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: state.bounds.x, y: state.bounds.y,
      deltaX: 0, deltaY: -Math.max(1200, state.scrollHeight), modifiers: 0 })
    wheels += 1
    await delay(150)
    const next = await snapshot()
    if (next.error) throw new Error(next.error)
    if (!next.loading && next.ids.some((id) => !initialIds.has(id))) older = next
  }
  assert.ok(older, 'A real Chromium wheel must reach a distinct older native page')
  assert.equal(older.terminalSame, true)
  assert.equal(older.source, initial.source)
  assert.ok(older.ids.length > 0)
  await cdp.evaluate(`document.querySelector('.session-history__toolbar button').click()`)
  assert.equal(await cdp.evaluate(`!document.querySelector('.session-history') && window.__historyProbeTerminal === document.querySelector('[data-workbench-region-id="${regionId}"] .xterm')`), true)
  const after = await cdp.evaluate(`(() => { const s = JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
    return { workbench: s.restoredWorkbench, focus: s.agentFocus, draft: s.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}] } })()`)
  assert.deepEqual(after.workbench, before.workbench)
  assert.equal(after.draft, draft)
  return { pid: processProbe.child.pid, workbenchDigest: hash(JSON.stringify(after.workbench)),
    focus: after.focus.execution.sessionId, draftDigest: hash(after.draft),
    nativeSource: initial.source, initialItemIds: initial.ids, olderItemIds: older.ids, wheels,
    sameMountedTerminal: older.terminalSame }
}

try {
  process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
  await mkdir(userData, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  const executable = join(workspacePath, 'synthetic-pty.sh')
  await writeFile(executable, '#!/bin/sh\nprintf "Isolated native-history probe PTY\\n"\nexec /bin/cat\n', { mode: 0o700 })
  const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  client = await connectLocalAgentMux({ store })
  session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'probe', providerId: 'codex',
    commandOverride: executable, workspacePath, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  await client.dispose()
  client = null
  const stored = (await store.load()).find((value) => value.agentSessionId === session.agentSessionId)
  assert.ok(stored)
  await store.compareAndSwap(stored, { ...stored, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeSessionId } })
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private probe' }],
    executors: { probe: { label: 'Synthetic PTY', providerId: 'codex', command: executable, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: workspaceId, name: 'History probe', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(workspacePath, 'split.txt'), 'Other Region remains visible\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: draft }, restoredWorkbench: {
      tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: regionId,
        layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: regionId },
        regions: { [regionId]: { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId },
          [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: join(workspacePath, 'split.txt') } } } },
      layouts: {
        [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        // Scratch is a mandatory configured workspace. Seed its empty canonical layout too, so
        // startup reconciliation cannot trail the first localStorage baseline by the writer delay.
        __scratch__: { root: { type: 'leaf', groupId: scratchGroupId }, groups: [{ id: scratchGroupId, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: scratchGroupId }
      }
    } } }
  expectedWorkbench = seed.state.restoredWorkbench
  await seedWorkbench(seed)
  const firstProcess = await launch('first')
  const first = await readSurface(firstProcess)
  first.cleanup = await firstProcess.interrupt()
  const secondProcess = await launch('second')
  const second = await readSurface(secondProcess)
  second.cleanup = await secondProcess.interrupt()
  assert.notEqual(first.pid, second.pid)
  assert.equal(first.workbenchDigest, second.workbenchDigest)
  assert.equal(first.draftDigest, second.draftDigest)
  client = await connectLocalAgentMux({ store })
  assert.equal(client.agentSession(session.agentSessionId).run.runId, session.run.runId)
  const run = (await client.listRuns()).find((value) => value.runId === session.run.runId)
  assert.equal(run?.state, 'running')
  await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(),
    expectedByte: run.acceptedInputBytes, data: 'isolated-input-survived\r' })
  await waitFor('private live PTY accepts input after both interruptions', async () => {
    const next = (await client.listRuns()).find((value) => value.runId === session.run.runId)
    return next?.acceptedInputBytes > run.acceptedInputBytes
  })
  const git = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: resolve(desktopRoot, '../..') })
  result = { schema: 'agentmux.native-history-delivery.v1', sourceCommit: git.stdout.trim(), probeDigest,
    inputDigest: hash(JSON.stringify({ nativeSessionId, seed })),
    coreDigest: hash(await readFile(resolve(desktopRoot, '../../packages/core/dist/index.js'))),
    desktopMainDigest: hash(await readFile(join(desktopRoot, 'out/main/index.js'))),
    nativeSource: { providerId: 'codex', nativeSessionId }, fixture: { syntheticPty: true, agentSessionId: session.agentSessionId, runId: session.run.runId },
    first, second, sameRunStillRunning: true, privateInputAccepted: true,
    limitations: ['No discarded terminal bytes or unknown TUI mode recovery is claimed.', 'The user Agent was read only; live input proof belongs to the private synthetic PTY.', 'Installation identity is a separate packaging receipt.'] }
} finally {
  try {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    if (!client && session) client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
    if (client) {
      try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() }
    }
    await stopProbeProcesses(process.pid + 1_000_000_000, temporaryRoot)
    assert.deepEqual(await listProbeProcesses(process.pid + 1_000_000_000, temporaryRoot), [])
    await rm(temporaryRoot, { recursive: true, force: true })
  } finally {
    if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  }
}
process.stdout.write(`${JSON.stringify({ ...result, cleanup: { privateProcessesReaped: true, temporaryRootRemoved: true } })}\n`)
