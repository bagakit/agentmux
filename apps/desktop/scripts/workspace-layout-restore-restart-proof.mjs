import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// This worker runs only below the existing complete private Desktop build.
// The sole test overlay there makes its windows nonactivating; Runtime,
// Renderer initialization, spatial persistence and public CLI are production.
const buildPath = process.env.AGENTMUX_DISPLAY_LAYOUT_SET_BUILD_RECEIPT
assert.ok(buildPath, 'Use verify-workbench-persistence-restart --display-layout-set')
const build = JSON.parse(await readFile(buildPath, 'utf8'))
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
assert.equal(build.privateRoot, repositoryRoot)
assert.equal(process.env.HOME, build.privateHome.path)
assert.equal(homedir(), build.privateHome.path)
const receiptPath = process.argv.find(a => a.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
assert.ok(receiptPath && !receiptPath.startsWith(repositoryRoot + '/'), 'Keep raw evidence outside the disposable build')
const evidence = dirname(receiptPath), exec = promisify(execFile), require = createRequire(import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await writeFile(join(dirname(buildPath), 'worker-home.json'), JSON.stringify({ pid: process.pid,
  privateRoot: repositoryRoot, sourceCommit: build.sourceCommit, home: process.env.HOME, nodeHome: homedir(),
  beforeCoreImports: true, workerSHA256: sha(await readFile(import.meta.filename)) }, null, 2) + '\n')
const root = await realpath(await mkdtemp(join(repositoryRoot, 'layout-state-')))
const userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime')
const fixtureEnvironment = { HOME: build.privateHome.path, AGENTMUX_DESKTOP_USER_DATA: userData,
  AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_SPATIAL_STATE_STORE: join(runtimeDirectory, 'state', 'spatial-state.json'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), CODEX_HOME: join(root, 'codex'),
  AGENTMUX_CONNECTOR_DIRECTORY: join(root, 'connectors'), AGENTMUX_MOTE_CONFIGURATION_PATH: join(root, 'motes.json') }
// No inherited Agent authority or user namespace may reach the private Core.
for (const name of Object.keys(process.env)) if (/^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name)) delete process.env[name]
Object.assign(process.env, fixtureEnvironment)
delete process.env.ELECTRON_RUN_AS_NODE
const { AgentMuxFileAgentSessionStore, connectLocalAgentMux } = await import('../../../packages/core/dist/index.js')
const { AgentMuxSpatialStateStore } = await import('../../../packages/core/dist/spatial-state.js')
const { createWorkspaceLayout } = await import('../../../packages/core/dist/spatial-layout.js')
const { mintObjectId } = await import('../../../packages/core/dist/object-id.js')
const id = Object.fromEntries(['resource','display','emptyWorkspace','tab','unboundTab','agentRegion','fileRegion','unboundRegion','group','emptyGroup','scratchGroup'].map(k => [k, mintObjectId()]))
const endpoint = 'unix:' + join(runtimeDirectory, 'control.sock')
const cliEntry = join(repositoryRoot, 'packages/core/bin/amux')
const children = new Set(), publicCalls = [], processEvents = [], cleanup = {}
const deadline = Date.now() + 115_000
let client, session, originalRun, originalBirth, failure, expectedLayouts, first, second, result = {}
const delay = ms => new Promise(done => setTimeout(done, ms))
const save = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n')
async function waitFor(label, read, budget = 20_000) {
  const until = Math.min(deadline, Date.now() + budget)
  do { const value = await read(); if (value) return value; await delay(60) } while (Date.now() < until)
  throw new Error('Private display-layout proof timed out: ' + label)
}
async function birth(pid) {
  let stdout
  try { ({ stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='])) }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return null; throw error }
  const fields = stdout.trim().split(/\s+/)
  return fields.length >= 7 ? { pid: Number(fields[0]), group: Number(fields[1]), born: fields.slice(2).join(' ') } : null
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(); let serial = 0
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data), p = pending.get(value.id)
    if (!p) return
    pending.delete(value.id); clearTimeout(p.timer)
    value.error ? p.fail(new Error(value.error.message)) : p.done(value.result)
  })
  const call = (method, params = {}) => new Promise((done, fail) => {
    const n = ++serial, timer = setTimeout(() => { pending.delete(n); fail(new Error('Private CDP timeout: ' + method)) }, 10_000)
    pending.set(n, { done, fail, timer }); socket.send(JSON.stringify({ id: n, method, params }))
  })
  return { call, close: () => socket.close(), async evaluate(expression) {
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}
async function cli(label, args, json = true) {
  const command = [cliEntry, '--endpoint', endpoint, ...args]
  let reply
  try { reply = await exec(process.execPath, command, { cwd: repositoryRoot, env: { ...process.env }, timeout: 12_000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { await save(label + '-failure.json', { command, code: error.code, stdout: error.stdout, stderr: error.stderr }); throw error }
  const value = json ? JSON.parse(reply.stdout) : reply.stdout
  await save(label + '.json', { command, endpoint, exitCode: 0, stderr: reply.stderr, result: value })
  publicCalls.push({ label, command, endpoint, exitCode: 0, raw: join(evidence, label + '.json') })
  if (json) { assert.equal(value.ok, true); return value.result }
  return value
}
async function launch(label, seed) {
  const ready = join(root, label + '-ready.json'), report = join(root, 'seed-report.json')
  const env = { ...process.env, ...fixtureEnvironment,
    ...(seed ? { AGENTMUX_DESKTOP_READY_FILE: ready, AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed), AGENTMUX_DESKTOP_RECOVERY_REPORT: report, AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1' } : {}) }
  if (!seed) for (const key of ['AGENTMUX_DESKTOP_READY_FILE','AGENTMUX_DESKTOP_RECOVERY_SEED','AGENTMUX_DESKTOP_RECOVERY_REPORT','AGENTMUX_DESKTOP_EXIT_AFTER_READY']) assert.equal(env[key], undefined)
  const mainSHA256 = sha(await readFile(join(desktopRoot,'out/main/index.js')))
  assert.equal(mainSHA256,build.compiled['apps/desktop/out/main/index.js'])
  const child = spawn(require('electron'), [desktopRoot, '--remote-debugging-port=0'], { cwd: desktopRoot, detached: true, env, stdio: ['ignore','ignore','pipe'] })
  children.add(child)
  const event = { label, pid: child.pid, startedAt: Date.now(), seedOnly: Boolean(seed), mainSHA256 }; processEvents.push(event)
  const closed = new Promise(done => child.once('close', (exitCode, signal) => { Object.assign(event, { exitCode, signal, closedAt: Date.now() }); done() }))
  child.probeClosed = closed
  child.once('exit', (exitCode, signal) => {
    Object.assign(event, { originalExitCode: exitCode, originalExitSignal: signal, exitedAt: Date.now() })
    // The independent semantic Host can retain inherited stderr after this
    // Electron exits. End only our pipe observation, then still await close.
    child.stderr.destroy()
  })
  let stderr = '', debuggerUrl
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-32768); debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] })
  child.probeBirth = await birth(child.pid)
  event.birth = child.probeBirth
  const alive = () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private App exited before ready: ' + stderr) }
  if (seed) {
    await waitFor(label + ' Main readiness', async () => { try { return JSON.parse(await readFile(ready, 'utf8')) } catch { alive(); return null } })
    await waitFor('seed process close', () => child.exitCode !== null || child.signalCode !== null)
    await closed; assert.equal(child.exitCode, 0); children.delete(child)
    const value = JSON.parse(await readFile(report, 'utf8')); await save('seed-report.json', value); return value
  }
  const debug = new URL(await waitFor(label + ' CDP', () => { alive(); return debuggerUrl }))
  const page = await waitFor(label + ' Renderer', async () => { alive(); return (await (await fetch('http://' + debug.host + '/json/list', { signal: AbortSignal.timeout(3000) })).json()).find(t => t.type === 'page' && t.url.startsWith('file:')) })
  const view = await cdp(page.webSocketDebuggerUrl); await view.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(label + ' original Agent/File Regions', () => view.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${id.agentRegion}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${id.fileRegion}"]'))`))
  return { child, view, closed, birth: child.probeBirth }
}
async function stopOwnedApp(child) {
  if (child.exitCode === null && child.signalCode === null) {
    assert.ok(child.probeBirth, 'Unknown private Electron birth is not signalling authority')
    assert.equal(child.probeBirth.group, child.pid)
    assert.deepEqual(await birth(child.pid), child.probeBirth, 'Only the original private Electron birth/group may be signalled')
    process.kill(-child.pid, 'SIGKILL')
  }
  await child.probeClosed
  children.delete(child)
}
async function stopApp(app) {
  app.view.close(); await stopOwnedApp(app.child); assert.equal(app.child.signalCode, 'SIGKILL')
}
function assertWorkbench(value) {
  const w = value.workbench
  assert.equal(w.loading, false)
  assert.deepEqual(w.layouts, expectedLayouts, 'Restoring configured resources must preserve the exact saved display layout set')
  assert.deepEqual(w.tabs.map(t => t.id).sort(), [id.tab, id.unboundTab].sort())
  const tab = w.tabs.find(t => t.id === id.tab), region = tab.regions.find(r => r.regionId === id.agentRegion)
  assert.equal(tab.workspaceId, id.resource); assert.equal(region.sessionId, session.agentSessionId)
  assert.equal(region.processState, 'running'); assert.equal(region.control.kind, 'agent')
  assert.equal(region.control.hostId, session.hostId); assert.equal(region.control.agentSessionId, session.agentSessionId)
  assert.deepEqual(region.control.run, session.run)
  assert.equal(w.activeWorkspaceId, id.display)
  return w
}
try {
  await mkdir(userData, { recursive: true }); await mkdir(fixtureEnvironment.CODEX_HOME, { recursive: true })
  const resourcePath = join(root, 'resource'), displayPath = join(root, 'display'), emptyPath = join(root, 'empty'), topicsPath = join(root, 'topics')
  for (const path of [resourcePath, displayPath, emptyPath, topicsPath]) await mkdir(path)
  await writeFile(join(resourcePath, 'split.txt'), 'Original private file Region\n')
  const executable = join(resourcePath, 'private-cat.sh'); await writeFile(executable, '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 })
  const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  client = await connectLocalAgentMux({ store })
  session = await client.createAgent({ createOperationId: mintObjectId(), executorId: 'probe', providerId: 'codex', commandOverride: executable, workspacePath: resourcePath, env: { CODEX_HOME: fixtureEnvironment.CODEX_HOME }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  originalRun = (await client.listRuns()).find(r => r.runId === session.run.runId)
  assert.equal(originalRun.state, 'running'); originalBirth = await birth(originalRun.pid); assert.ok(originalBirth); assert.equal(originalBirth.group, originalRun.pid)
  await save('original-run.json', { agentSessionId:session.agentSessionId,hostId:session.hostId,run:session.run,originalRun,originalBirth })
  // Actual Native input/output establishes health, not a synthetic status flag.
  await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: mintObjectId(), expectedByte: originalRun.acceptedInputBytes, data: 'private-layout-before\r' })
  await waitFor('original Run real output', async () => (await client.readRunReplay(session.run)).replay.some(c => Buffer.from(c.dataBytes).includes(Buffer.from('private-layout-before'))))
  originalRun = (await client.listRuns()).find(r => r.runId === session.run.runId)
  await client.dispose(); client = null
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }], executors: { probe: { label: 'Private cat', providerId: 'codex', command: executable, args: [], env: { CODEX_HOME: fixtureEnvironment.CODEX_HOME }, injectAgentMuxGuide: false } },
    workspaces: [{ id: '__scratch__', name: 'Private topics', hostId: 'local', path: topicsPath, kind: 'folder' }, ...[[id.resource, resourcePath], [id.display, displayPath], [id.emptyWorkspace, emptyPath]].map(([key,path]) => ({ id: key, name: 'Private ' + key, hostId: 'local', path, kind: 'folder' }))], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  expectedLayouts = { [id.display]: createWorkspaceLayout(id.group, [id.tab]), [id.emptyWorkspace]: createWorkspaceLayout(id.emptyGroup), __scratch__: createWorkspaceLayout(id.scratchGroup) }
  const workbench = { layouts: expectedLayouts, tabs: {
    [id.tab]: { id: id.tab, workspaceId: id.resource, titleRegionId: id.agentRegion, layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId: id.agentRegion }, second: { type: 'leaf', regionId: id.fileRegion } }, activeRegionId: id.agentRegion }, regions: {
      [id.agentRegion]: { regionId: id.agentRegion, kind: 'agent', phase: 'attached', workspaceId: id.resource, sessionId: session.agentSessionId }, [id.fileRegion]: { regionId: id.fileRegion, kind: 'file', workspaceId: id.resource, path: 'split.txt' } } },
    [id.unboundTab]: { id: id.unboundTab, workspaceId: id.resource, titleRegionId: id.unboundRegion, layout: { root: { type: 'leaf', regionId: id.unboundRegion }, activeRegionId: id.unboundRegion }, regions: { [id.unboundRegion]: { kind: 'launcher', regionId: id.unboundRegion, workspaceId: id.resource } } }
  } }
  const adapterPath = join(root, 'seed-adapter.mjs'), tool = createRequire(require.resolve('vite/package.json'))
  const adapterBuild = await tool('esbuild').build({ entryPoints: [join(desktopRoot, 'src/renderer/src/lib/desktop-spatial-state.ts')], outfile: adapterPath, bundle: true, platform: 'node', format: 'esm', metafile: true,
    banner: { js: "import {createRequire as privateCreateRequire} from 'node:module';const require=privateCreateRequire(import.meta.url);" },
    alias: { '@agentmux/layout': join(repositoryRoot, 'packages/layout/src/index.ts') }, logLevel: 'silent' })
  assert.ok(Object.keys(adapterBuild.metafile.inputs).length > 0)
  assert.ok(Object.keys(adapterBuild.metafile.inputs).every(p => !/runtime-controller|public-rpc-service|electron/.test(p)))
  const { desktopSpatialGraph } = await import(pathToFileURL(adapterPath))
  const baselineSession = { id: session.agentSessionId, kind: 'agent', hostId: session.hostId, workspacePath: session.workspacePath, providerId: session.providerId, executorId: session.executorId,
    control: { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId, run: session.run } }
  const graph = desktopSpatialGraph({ config, sessions: [baselineSession], ...workbench, spaceZoneBindings: {}, spatialRequests: {} }, [])
  const spatial = new AgentMuxSpatialStateStore(); const seeded = await spatial.commit({ expectedRevision: 0, graph })
  assert.deepEqual(seeded.graph.layouts, expectedLayouts); assert.equal(Object.hasOwn(graph.layouts, id.resource), false)
  await save('seeded-spatial.json', seeded)
  await launch('seed', { version: 1, state: { activeWorkspaceId: id.display, mainSurface: 'workbench', agentFocus: { execution: { sessionId: session.agentSessionId, reference: { displayWorkspaceId: id.display, groupId: id.group, tabId: id.tab, regionId: id.agentRegion }, history: [{ sessionId: session.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } } } })
  first = await launch('first')
  // Read versioned skill/help through this exact private CLI before its capability.
  for (const [label,args] of [['space-skill',['space','--skill']], ['app-skill',['app','--skill']], ['space-inspect-help',['space','inspect','--help']], ['app-inspect-help',['app','inspect','--help']]]) await cli(label,args,false)
  const before = (await cli('first-app-inspect', ['app','inspect'])).observation; assertWorkbench(before)
  const beforeSpace = await cli('first-space-inspect', ['space','inspect','--region',id.agentRegion])
  const beforeGraph = await spatial.read(); assert.deepEqual(beforeGraph.graph.layouts, expectedLayouts)
  await stopApp(first)
  second = await launch('second')
  const after = (await cli('second-app-inspect', ['app','inspect'])).observation; assertWorkbench(after)
  const afterSpace = await cli('second-space-inspect', ['space','inspect','--region',id.agentRegion])
  for (const value of [beforeSpace, afterSpace]) {
    const region = value.catalog.regions.find(r => r.regionId === id.agentRegion)
    assert.equal(region.agentSessionId, session.agentSessionId); assert.equal(region.runId, session.run.runId)
    assert.ok(value.catalog.locations.some(l => l.tabId === id.tab && l.displayWorkspaceId === id.display && l.groupId === id.group))
  }
  const afterGraph = await spatial.read(); assert.deepEqual(afterGraph.graph.layouts, expectedLayouts)
  assert.deepEqual(afterGraph.graph.tabs.map(t => t.tabId).sort(), [id.tab,id.unboundTab].sort())
  assert.deepEqual(await birth(originalRun.pid), originalBirth)
  assert.notEqual(first.child.pid, second.child.pid)
  const snapshot = await second.view.evaluate('window.agentmux.sessions.snapshot()')
  assert.deepEqual(snapshot.sessions.filter(s => s.kind === 'agent').map(s => s.id), [session.agentSessionId])
  // After the strict restore baseline only: actual private Sidebar click reaches
  // unchanged selectWorkspace, proving explicit creation still works.
  const rect = await second.view.evaluate(`(()=>{const el=document.querySelector('button.project-rail-row[data-workspace-id="${id.resource}"]');if(!el)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
  assert.ok(rect, 'Actual Sidebar resource row is available for explicit open negative control')
  await second.view.call('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...rect })
  await second.view.call('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...rect })
  await waitFor('explicit selection creates its original empty shell', async () => {
    const value = await second.view.evaluate('JSON.parse(localStorage.getItem("agentmux-workbench-v1")).state')
    return value.activeWorkspaceId === id.resource
  })
  const explicit = (await cli('explicit-resource-open', ['app','inspect'])).observation
  assert.equal(explicit.workbench.activeWorkspaceId, id.resource)
  const created = explicit.workbench.layouts[id.resource]; assert.ok(created); assert.equal(created.groups.length,1); assert.deepEqual(created.groups[0].tabOrder,[])
  for (const [key,value] of Object.entries(expectedLayouts)) assert.deepEqual(explicit.workbench.layouts[key],value)
  assert.equal(explicit.workbench.tabs.length,2)
  await stopApp(second)
  client = await connectLocalAgentMux({ store })
  const nativeAfter = (await client.listRuns()).find(r => r.runId === session.run.runId)
  assert.equal(nativeAfter.state,'running'); assert.equal(nativeAfter.pid,originalRun.pid); assert.equal(nativeAfter.acceptedInputBytes,originalRun.acceptedInputBytes)
  assert.deepEqual(await birth(originalRun.pid),originalBirth)
  result = { passed:true, displayLayoutSet:{passed:true}, sourceCommit:build.sourceCommit, ids:id,
    buildReceipt:buildPath, restoreSourceSHA256:build.sources['apps/desktop/src/renderer/src/lib/workbench-persistence.ts'],
    firstPid:first.child.pid, secondPid:second.child.pid, expectedLayouts, before, after, beforeSpace, afterSpace,
    graphBefore:beforeGraph, graphAfter:afterGraph, originalRun, nativeAfter, originalBirth,
    explicitOpen:{actualSidebarClick:true, resourceWorkspaceId:id.resource, createdLayout:created, originalLayoutsUnchanged:true},
    publicCLI:{entry:cliEntry,endpoint,calls:publicCalls}, namespace:fixtureEnvironment,
    scope:'Actual complete private Desktop/Main/Renderer/Core/ctxmux two-process restart; synthetic cat Agent process, not Provider-native semantic-resume proof. No live user namespace. Null first-start separately belongs to owning unit coverage. No screenshot/aesthetic claim.' }
} catch(error) { failure=error }
finally {
  const errors=[]
  let unknownAppOwner = false
  for (const child of children) try { await stopOwnedApp(child) } catch(error) {unknownAppOwner=true;errors.push(error.message)}
  try {
    if(session) { client ??= await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))}); await client.stopAgent(session.agentSessionId,session.run) }
  } catch(error) {errors.push(error.message)}
  finally {if(client)await client.dispose().catch(error=>errors.push(error.message))}
  try {
    const actual=originalBirth&&await birth(originalBirth.pid)
    if(actual&&actual.born===originalBirth.born) {assert.equal(actual.group,originalBirth.group);assert.equal(actual.group,originalBirth.pid);process.kill(-actual.group,'SIGKILL')}
    if(unknownAppOwner){cleanup.privateRootRetainedForUnknownApp=true;throw new Error('Private Electron cleanup ownership is unknown; retain its tree without further signals')}
    await stopProbeProcesses(-1,root)
    assert.deepEqual(await listProbeProcesses(-1,root),[])
    if(originalBirth)await waitFor('exact private cat reaped',async()=>JSON.stringify(await birth(originalBirth.pid))!==JSON.stringify(originalBirth),3000)
    cleanup.privateProcessesReaped=true
    await rm(root,{recursive:true});cleanup.temporaryRootRemoved=true
  } catch(error) {errors.push(error.message)}
  if(errors.length){cleanup.errors=errors;failure??=new Error(errors.join('; '))}
}
const receipt={schema:'agentmux.display-layout-set-restart.v1',...result,passed:!failure,processEvents,publicCalls,cleanup,
  attempt:{ids:id,agentSessionId:session?.agentSessionId,hostId:session?.hostId,run:session?.run,originalRun,originalBirth,namespace:fixtureEnvironment},
  failure:failure?{name:failure.name,message:failure.message,stack:failure.stack}:null}
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,receiptPath,firstPid:first?.child.pid,secondPid:second?.child.pid,cleanup,failure:receipt.failure})+'\n')
if(failure)process.exitCode=1
