import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectCdp } from './fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Consume existing ordinary product bundles. This producer never builds, packages or installs.
// The public Provider starts the repository CLI fixture; no DTO Run or guessed native identity.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), ts = require('typescript')
const core = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const output = resolve(repositoryRoot, process.env.AGENTMUX_FOCUS_NAME_WIDTH_RESTART_OUTPUT ?? `.tmp/focus-timeline-name-width-restart-${Date.now()}`)
await mkdir(output, { recursive: true })
const privateRoot = await mkdtemp('/tmp/amx-name-width-'), userData = join(privateRoot, 'user-data')
const privateHome = join(privateRoot, 'home'), runtimeDirectory = join(privateRoot, 'runtime')
const workspacePath = join(privateRoot, 'workspace'), topicsPath = join(privateRoot, 'topics'), codexHome = join(privateRoot, 'codex-home')
const environment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: codexHome }
const inheritedCallerNames = Object.keys(process.env).filter(name => /^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name))
const previous = new Map([...Object.keys(environment), ...inheritedCallerNames].map(name => [name, process.env[name]]))
const digest = bytes => createHash('sha256').update(bytes).digest('hex'), delay = ms => new Promise(done => setTimeout(done, ms))
const children = new Set(), connections = new Set(), deadline = Date.now() + 140_000
const workspaceId = 'width-workspace', groupId = 'width-group', tabId = 'width-tab', agentRegionId = 'width-agent', fileRegionId = 'width-file'
const draft = 'Keep the original width restart draft'
const receipt = { schema: 'agentmux.focus-timeline-name-width-restart.v1', passed: false, processes: [], controls: [], cleanup: {},
  boundary: 'Existing ordinary production Main/preload/Renderer, public Core Provider and real private PTY. Controlled first-hydrate Focus timestamps are visit inputs, not execution duration. Repository CLI fixture, not vendor Writer or user installation. First process receives one initial seed; second receives none. No HOME environment reassignment, package, build or user Runtime.' }
let client, session, originalRun, failure, interruption
const abort = signal => {
  interruption ??= new Error(`Private width restart interrupted: ${signal}`)
  for (const connection of connections) connection.close()
  void stopProbeProcesses(process.pid + 1_000_000_000, privateRoot).catch(error => { receipt.cleanup.interruptionError = error.message })
}
const watchdog = setTimeout(() => abort('bounded deadline'), 140_000)
const onSigterm = () => abort('SIGTERM'), onSigint = () => abort('SIGINT')
process.on('SIGTERM', onSigterm); process.on('SIGINT', onSigint)
async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { if (interruption) throw interruption; const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Name width restart timed out: ${label}`)
}
async function files(directory, prefix) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${prefix}/${entry.name}`))
    else if (entry.isFile()) result.push(`${prefix}/${entry.name}`)
  }
  return result
}
async function binding() {
  const names = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json',
    'apps/desktop/scripts/verify-focus-timeline-name-width-restart.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/fixtures/settings-cli/desktop.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs',
    ...await files(join(desktopRoot, 'src'), 'apps/desktop/src'), ...await files(join(desktopRoot, 'out'), 'apps/desktop/out'),
    ...await files(join(repositoryRoot, 'packages/core/src'), 'packages/core/src'), ...await files(join(repositoryRoot, 'packages/core/dist'), 'packages/core/dist'),
    ...await files(join(repositoryRoot, 'packages/core/vendor'), 'packages/core/vendor')]
  assert.ok(names.length > 700, 'Complete actual execution input must be nonempty')
  return Object.fromEntries(await Promise.all(names.sort().map(async name => { const bytes = await readFile(join(repositoryRoot, name)); assert.ok(bytes.length > 0, name); return [name, digest(bytes)] })))
}
async function run() {
  const value = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(value?.state, 'running'); assert.equal(value.pid, originalRun.pid)
  assert.equal(client.agentSession(session.agentSessionId).run.runId, session.run.runId)
  return value
}
async function inspectRegion() {
  const reply = await core.requestAgentMuxControl({ schemaVersion: core.AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'inspect.region', target: { kind: 'region', regionId: agentRegionId } }, join(runtimeDirectory, 'control.sock'))
  assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result.region
}
async function launch(label, seed) {
  for (const name of ['AGENTMUX_DESKTOP_RECOVERY_SEED', 'AGENTMUX_DESKTOP_RECOVERY_REPORT', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) assert.equal(process.env[name], undefined, `Private launch inherited ${name}`)
  const readyFile = join(privateRoot, `ready-${label}.json`), reportFile = join(privateRoot, `${label}-seed-report.json`)
  const child = spawn(require('electron'), ['--inspect-brk=0', join(desktopRoot, 'out/main/index.js'), '--remote-debugging-port=0'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...environment, AGENTMUX_DESKTOP_READY_FILE: readyFile,
      ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed), AGENTMUX_DESKTOP_RECOVERY_REPORT: reportFile } : {}) }
  })
  assert.ok(child.pid > 1); children.add(child)
  let diagnostics = '', mainUrl, rendererUrl, spawnError
  child.once('error', error => { spawnError = error })
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-16384); mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]; rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
  const alive = () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`) }
  const main = await connectCdp(await waitFor(`${label} Main debugger`, () => { alive(); return mainUrl }), connections)
  await main.call('Runtime.enable'); await main.call('Debugger.enable')
  const mainPath = join(desktopRoot, 'out/main/index.js')
  const anchors = (await readFile(mainPath, 'utf8')).split('\n').flatMap((line, i) => line.includes('const SCRATCH_BACKING_PATH = join(app.getPath("home")') ? [i] : [])
  assert.equal(anchors.length, 1, 'Home isolation must precede the one actual compiled home-dependent constant')
  const breakpoint = await main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
  await main.call('Runtime.runIfWaitingForDebugger')
  let paused = await waitFor(`${label} initial pause`, () => main.pauses.shift())
  if (!paused.hitBreakpoints?.includes(breakpoint.breakpointId)) { await main.call('Debugger.resume'); paused = await waitFor(`${label} home boundary`, () => main.pauses.shift()) }
  assert.ok(paused.hitBreakpoints?.includes(breakpoint.breakpointId))
  const isolated = await main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
    expression: `(() => { app.setPath('home', ${JSON.stringify(privateHome)}); return app.getPath('home') })()`, returnByValue: true })
  assert.equal(isolated.exceptionDetails, undefined); assert.equal(isolated.result.value, privateHome)
  await main.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await main.call('Debugger.resume')
  const endpoint = new URL(await waitFor(`${label} Renderer debugger`, () => { alive(); return rendererUrl }))
  const target = await waitFor(`${label} Renderer target`, async () => (await (await fetch(`http://${endpoint.host}/json/list`, { signal: AbortSignal.timeout(5000) })).json()).find(value => value.type === 'page' && value.url.startsWith('file:')))
  const cdp = await connectCdp(target.webSocketDebuggerUrl, connections); await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`${label} ready`, async () => { alive(); try { return JSON.parse(await readFile(readyFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null } })
  await waitFor(`${label} original workface and visible name handle`, () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .xterm')&&document.querySelector('[aria-label="Resize timeline names"]')?.getClientRects().length)`))
  assert.equal(await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), privateHome)
  return { child, main, cdp, seedReport: seed ? JSON.parse(await readFile(reportFile, 'utf8')) : null }
}
async function surface(probe) {
  return probe.cdp.evaluate(`(() => { const saved=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state, scene=document.querySelector('.recent-focus'), name=scene.querySelector('.recent-focus__ruler > .recent-focus__gutter').getBoundingClientRect(), handle=scene.querySelector('[aria-label="Resize timeline names"]');return{workbench:saved.restoredWorkbench,focus:saved.agentFocus,draft:saved.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],width:saved.focusTimelineNameWidth,renderedWidth:name.width,handle:handle.getAttribute('aria-valuenow'),tracks:[...scene.querySelectorAll('[data-focus-timeline-id]')].map(n=>n.dataset.focusTimelineId),projects:[...scene.querySelectorAll('[data-timeline-project]')].map(n=>n.dataset.timelineProject),height:saved.focusTimelineHeight,regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(n=>n.getClientRects().length).map(n=>n.dataset.workbenchRegionId).sort()}})()`)
}
async function actualTerminal(probe) {
  const { cdp } = probe; await cdp.call('Debugger.enable')
  const candidates = []
  for (const asset of (await readdir(join(desktopRoot, 'out/renderer/assets'))).filter(name => name.endsWith('.js'))) {
    const path = join(desktopRoot, 'out/renderer/assets', asset), source = await readFile(path, 'utf8'), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(node.properties.map(p => p.name?.getText(ast).replace(/^['"]|['"]$/g, '')))
        if (['sampledAt', 'viewGrid', 'mouseTrackingMode', 'buffer', 'liveReady'].every(name => names.has(name))) {
          let owner = node.parent; while (owner && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent
          assert.ok(owner); const objects = []
          function find(current) { if (ts.isPropertyAccessExpression(current) && current.name.text === 'active' && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'buffer' && ts.isIdentifier(current.expression.expression)) objects.push(current.expression.expression.text); ts.forEachChild(current, find) }
          find(owner); assert.equal(new Set(objects).size, 1)
          candidates.push({ url: pathToFileURL(path).href, ...ast.getLineAndCharacterOfPosition(node.getStart(ast)), identifier: objects[0] })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  assert.equal(candidates.length, 1, 'Read the single actual production terminal getter, not an empty source scan')
  const target = candidates[0], breakpoint = await cdp.call('Debugger.setBreakpointByUrl', { url: target.url, lineNumber: target.line, columnNumber: target.character })
  let paused; const request = inspectRegion()
  try {
    paused = await waitFor('actual xterm getter pause', () => cdp.pauses.shift(), 10000); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId))
    const value = await cdp.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: target.identifier, returnByValue: false, objectGroup: 'name-width-observation' })
    assert.equal(value.exceptionDetails, undefined); assert.ok(value.result.objectId); return value.result.objectId
  } finally { await cdp.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); if (paused) await cdp.call('Debugger.resume'); await request }
}
async function adjust(probe, width) {
  const point = await probe.cdp.evaluate(`(()=>{const e=document.querySelector('[aria-label="Resize timeline names"]'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const targetX = point.x + width - Number((await surface(probe)).handle)
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: point.y, button: 'left', buttons: 1 })
  await probe.cdp.evaluate('new Promise(requestAnimationFrame)')
  const interim = await surface(probe); assert.equal(interim.renderedWidth, width); assert.equal(interim.width, 112, 'Draft geometry is not a persisted commit')
  await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  return waitFor('width commits on release', async () => { const value = await surface(probe); return value.width === width ? value : null })
}
async function normalQuit(probe) {
  let replyError
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()`) } catch (error) { replyError = error.message }
  probe.cdp.close(); probe.main.close()
  await waitFor('ordinary Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null); children.delete(probe.child)
  return { pid: probe.child.pid, exitCode: probe.child.exitCode, signal: probe.child.signalCode, inspectorReplyError: replyError ?? null }
}
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(repositoryRoot)});`], { cwd: repositoryRoot, encoding: 'utf8' })
  await writeFile(join(output, 'freshness.log'), (freshness.stdout ?? '') + (freshness.stderr ?? ''))
  assert.equal(freshness.status, 0, 'Use fresh ordinary private Core/Demand output; never bypass the canonical guard')
  receipt.inputsBefore = await binding()
  for (const name of inheritedCallerNames) delete process.env[name]
  Object.assign(process.env, environment)
  for (const path of [privateHome, userData, workspacePath, topicsPath, codexHome]) await mkdir(path, { recursive: true, mode: 0o700 })
  const executable = join(privateRoot, 'private-codex.sh'), quote = text => `'${text.replace(/'/g, `'\\''`)}'`
  const fixtureSource = join(repositoryRoot, 'packages/core/test/fixtures/fake-codex-cli.mjs'), ownedFixture = join(privateRoot, 'fake-codex-cli.mjs')
  await copyFile(fixtureSource, ownedFixture); assert.equal(digest(await readFile(ownedFixture)), digest(await readFile(fixtureSource)))
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'Private codex fixture 1\\n'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(ownedFixture)} "$@"\n`, { mode: 0o700 })
  client = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
  session = await client.createAgent({ createOperationId: randomUUID(), providerId: 'codex', executorId: 'width-probe', commandOverride: executable,
    workspacePath, injectAgentMuxGuide: false, env: { CODEX_HOME: codexHome, AGENTMUX_FAKE_READY_MODE: 'before' }, cols: 100, rows: 30 })
  originalRun = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid > 1); receipt.originalRun = originalRun; receipt.runtimeBefore = client.runtimeIdentity()
  await writeFile(join(workspacePath, 'sibling.txt'), 'The original sibling Region remains visible\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private width fixture' }],
    executors: { 'width-probe': { label: 'Private width Agent', providerId: 'codex', command: executable, args: [], env: { CODEX_HOME: codexHome, AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
    workspaces: [{ id: '__scratch__', name: 'Private Topics', hostId: 'local', path: topicsPath, kind: 'folder' }, { id: workspaceId, name: 'Width retained work', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'agents', focusTimelineHeight: 208, focusTimelineNameWidth: 112,
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: Date.now() - 60 * 60000,
      identity: { kind: 'agent', providerId: 'codex', name: 'Private width retained Agent', hostId: 'local', workspacePath, project: { id: workspaceId, name: 'Width retained work' } } }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: draft }, restoredWorkbench: { tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: agentRegionId,
      layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.61, first: { type: 'leaf', regionId: agentRegionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: agentRegionId },
      regions: { [agentRegionId]: { regionId: agentRegionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId }, [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: 'sibling.txt' } } } },
      layouts: { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        __scratch__: { root: { type: 'leaf', groupId: 'width-scratch-group' }, groups: [{ id: 'width-scratch-group', tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: 'width-scratch-group' } } } } }
  const first = await launch('first', seed), before = await surface(first)
  assert.equal(before.width, 112); assert.equal(before.renderedWidth, 112); assert.equal(before.draft, draft); assert.ok(before.tracks.includes(session.agentSessionId)); assert.ok(before.projects.length > 0)
  receipt.seedReport = first.seedReport
  await waitFor('first original Run is input ready', async () => { const value = await inspectRegion(); return value.terminalView?.liveReady && value.terminalView.acceptsInput ? value : null })
  const widthRunBefore = await run()
  const originalTerminal = await actualTerminal(first), edited = await adjust(first, 244), laterTerminal = await actualTerminal(first)
  const same = await first.cdp.call('Runtime.callFunctionOn', { objectId: originalTerminal, arguments: [{ objectId: laterTerminal }], functionDeclaration: 'function(current){return this===current}', returnByValue: true })
  assert.equal(same.exceptionDetails, undefined); assert.equal(same.result.value, true); receipt.sameProcessXtermPreserved = true
  assert.deepEqual(edited.workbench, before.workbench); assert.deepEqual(edited.focus, before.focus); assert.equal(edited.draft, draft); assert.equal(edited.height, before.height)
  const widthRunAfter = await run()
  assert.equal(widthRunAfter.acceptedInputBytes, widthRunBefore.acceptedInputBytes, 'Queries and width adjustment never submit the draft')
  receipt.widthInputBoundary = { beforeByte: widthRunBefore.acceptedInputBytes, afterByte: widthRunAfter.acceptedInputBytes, permitsOriginalAttachProtocol: true }
  receipt.processes.push({ pid: first.child.pid, seedWrites: 1, before, after: edited, exit: await normalQuit(first) })
  const preservedAfterQuit = await run(); const second = await launch('second'), restored = await surface(second)
  const secondProcess = { pid: second.child.pid, seedWrites: 0, before: restored }
  receipt.processes.push(secondProcess)
  receipt.originalRunAfterQuit = preservedAfterQuit
  await writeFile(join(output, 'second-process-restored-checkpoint.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(restored.width, 244); assert.equal(restored.renderedWidth, 244); assert.deepEqual(restored.workbench, edited.workbench); assert.deepEqual(restored.focus, edited.focus); assert.equal(restored.draft, draft); assert.equal(restored.height, before.height); assert.deepEqual(restored.tracks, edited.tracks)
  const inspected = await waitFor('restored same Run is input ready', async () => { const value = await inspectRegion(); return value.terminalView?.liveReady && value.terminalView.acceptsInput ? value : null })
  receipt.restoredRegion = { kind: inspected.kind, agentSessionId: inspected.agentSessionId,
    terminalView: { runId: inspected.terminalView.runId, liveReady: inspected.terminalView.liveReady, acceptsInput: inspected.terminalView.acceptsInput } }
  await writeFile(join(output, 'second-process-ready-checkpoint.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(inspected.kind, 'agent'); assert.equal(inspected.agentSessionId, session.agentSessionId)
  assert.equal(inspected.terminalView.runId, session.run.runId)
  receipt.crossProcessXterm = { firstPid: first.child.pid, secondPid: second.child.pid, newInstanceExpected: true }
  const ackBefore = await run(), ack = await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'w\r', source: 'user' })
  assert.ok(ack.appliedByteRange); assert.equal(ack.appliedByteRange.endByte - ack.appliedByteRange.startByte, 2)
  const after = await waitFor('same original private Run ACK', async () => { const value = await run(); return value.acceptedInputBytes === ackBefore.acceptedInputBytes + 2 ? value : null })
  receipt.runs = [{ before: { runId: originalRun.runId, pid: originalRun.pid }, after: { runId: after.runId, pid: after.pid }, ack: { passed: true, beforeByte: ackBefore.acceptedInputBytes, afterByte: after.acceptedInputBytes, appliedByteRange: ack.appliedByteRange } }]
  secondProcess.exit = await normalQuit(second); assert.notEqual(receipt.processes[0].pid, receipt.processes[1].pid)
  receipt.originalRunAfterQuit = preservedAfterQuit; receipt.widthRestored = true; receipt.workbenchPreserved = true
  const freshVerifier = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json')) })
  try { receipt.runtimeAfter = freshVerifier.runtimeIdentity(); assert.deepEqual(receipt.runtimeAfter, receipt.runtimeBefore) }
  finally { await freshVerifier.dispose() }
  receipt.inputsAfter = await binding(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore); receipt.passed = true
} catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  clearTimeout(watchdog); process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigint)
  const errors = [], attempt = async operation => { try { await operation() } catch (error) { errors.push(error.message) } }
  for (const connection of connections) { await attempt(async () => { await connection.call('Debugger.resume').catch(() => {}); connection.close() }) }
  await attempt(async () => { if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } } })
  for (const child of children) await attempt(async () => { if (child.pid) await stopProbeProcesses(child.pid, privateRoot) })
  await attempt(async () => { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot); receipt.cleanup.remainingOwnedProcesses = await listProbeProcesses(-1, privateRoot); assert.deepEqual(receipt.cleanup.remainingOwnedProcesses, []); await rm(privateRoot, { recursive: true }); receipt.cleanup.ownedPrivateRootsRemoved = true })
  for (const [name, value] of previous) value === undefined ? delete process.env[name] : process.env[name] = value
  if (errors.length) { receipt.cleanup.errors = errors; receipt.passed = false; failure ??= new Error(errors.join('; ')) }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), failure: receipt.failure, cleanup: receipt.cleanup }))
if (failure || !receipt.passed) process.exitCode = 1
