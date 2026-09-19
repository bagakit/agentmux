import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopFixture } from './fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Complete product Main/preload/Renderer, one real private Core/PTY, and the original seed owner.
// No replacement Renderer, Store setter, late seed, writer flush or post-hydrate storage repair.
assert.ok(process.argv.includes('--isolated'), 'This proof requires --isolated')
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const core = await import(pathToFileURL(join(repositoryRoot, 'packages/core/dist/index.js')))
const probeRoot = process.argv.find(value => value.startsWith('--probe-root='))?.slice('--probe-root='.length)
const root = await mkdtemp(probeRoot ? join(probeRoot, 'seed-order-') : '/tmp/amx-seed-order-'), privateHome = join(root, 'home')
const userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime'), workspacePath = join(root, 'workspace')
const workspaceId = 'seed-order-workspace', tabId = 'seed-order-tab', agentRegionId = 'seed-order-agent', fileRegionId = 'seed-order-file'
const groupId = 'seed-order-group', scratchGroupId = 'seed-order-scratch', draft = 'Unsent seed draft stays with the original Session'
const environment = { HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'), AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),
  AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson') }
const previous = new Map(Object.keys(environment).map(name => [name, process.env[name]]))
const children = new Set(), connections = new Set(), deadline = Date.now() + 110_000
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const receipt = { schema: 'agentmux.private-recovery-seed-order.v1', passed: false, phase: 'prepare', cleanup: {} }
let client, session, originalRun, failure
async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50) }
  throw new Error(`Seed order: timed out waiting for ${label}`)
}
async function treeFiles(path, prefix) {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await treeFiles(join(path, entry.name), `${prefix}/${entry.name}`))
    else if (entry.isFile()) files.push(`${prefix}/${entry.name}`)
  }
  return files
}
async function inputs() {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
    'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
    'apps/desktop/scripts/verify-recovery-seed-order.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/fixtures/settings-cli/desktop.mjs',
    ...await treeFiles(join(desktopRoot, 'src'), 'apps/desktop/src'),
    ...await treeFiles(join(desktopRoot, 'out'), 'apps/desktop/out'),
    ...await treeFiles(join(repositoryRoot, 'packages/core/src'), 'packages/core/src'),
    ...await treeFiles(join(repositoryRoot, 'packages/core/dist'), 'packages/core/dist'),
    ...await treeFiles(join(repositoryRoot, 'packages/core/vendor'), 'packages/core/vendor')]
  const values = Object.fromEntries(await Promise.all(files.sort().map(async file => {
    const value = await readFile(join(repositoryRoot, file)); return [file, { sha256: digest(value), bytes: value.length }]
  })))
  assert.ok(Object.keys(values).length > 700, 'Bind the nonempty complete product execution inputs')
  return values
}
async function run() {
  const value = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(value?.state, 'running'); assert.equal(value.pid, originalRun.pid)
  assert.equal(client.agentSession(session.agentSessionId).run.runId, session.run.runId)
  return value
}
async function normalQuit(probe) {
  let replyError
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()` ) }
  catch (error) { replyError = String(error) }
  probe.main.close(); probe.cdp.close()
  await waitFor('ordinary Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null)
  children.delete(probe.child)
  return { pid: probe.child.pid, exitCode: probe.child.exitCode, signal: probe.child.signalCode, inspectorReplyError: replyError ?? null }
}
function assertStored(actual, seed) {
  assert.deepEqual(actual.workbench, seed.state.restoredWorkbench, 'The exact nonempty Tab/Region/Group/split must survive ordinary restart')
  assert.deepEqual(actual.focus, seed.state.agentFocus)
  assert.equal(actual.draft, draft)
}
async function surface(probe) {
  await waitFor('actual hydrated nonempty Composer and sibling Region', () => probe.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
  return probe.cdp.evaluate(`(() => {
    const state = JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state
    const visible = selector => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length)
    return { workbench: state.restoredWorkbench, focus: state.agentFocus,
      draft: state.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],
      composer: document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]').innerText,
      tabs: visible('[data-workbench-tab-id]').map(e=>e.dataset.workbenchTabId).sort(),
      regions: visible('[data-workbench-region-id]').map(e=>e.dataset.workbenchRegionId).sort() }
  })()`)
}
try {
  receipt.inputsBefore = await inputs()
  Object.assign(process.env, environment)
  for (const path of [privateHome, environment.CODEX_HOME, userData, workspacePath, join(root, 'topics')]) await mkdir(path, { recursive: true })
  const worker = join(workspacePath, 'worker.py')
  await writeFile(worker, '#!/usr/bin/python3\nimport os,sys\nif \"--version\" in sys.argv:\n print(\"Private seed worker 1\"); sys.exit(0)\nos.write(1,b"Private seed PTY ready\\r\\n")\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,b"Private seed echo:"+data)\n', { mode: 0o700 })
  const store = new core.AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
  client = await core.connectLocalAgentMux({ store })
  session = await client.createAgent({ createOperationId: randomUUID(), providerId: 'codex', executorId: 'seed-probe',
    commandOverride: worker, workspacePath, injectAgentMuxGuide: false, env: { CODEX_HOME: environment.CODEX_HOME }, cols: 100, rows: 30 })
  originalRun = (await client.listRuns()).find(value => value.runId === session.run.runId)
  assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid > 1)
  receipt.runtime = client.runtimeIdentity(); receipt.originalRun = originalRun; receipt.sessionId = session.agentSessionId
  await writeFile(join(workspacePath, 'sibling.txt'), 'Private sibling Region remains visible\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'Private seed fixture' }],
    executors: { 'seed-probe': { label: 'Private seed PTY', providerId: 'codex', command: worker, args: [], env: { CODEX_HOME: environment.CODEX_HOME }, injectAgentMuxGuide: false } },
    workspaces: [{ id: '__scratch__', name: 'Private scratch', hostId: 'local', path: join(root, 'topics'), kind: 'folder' },
      { id: workspaceId, name: 'Private seed order', hostId: 'local', path: workspacePath, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [{ sessionId: session.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.agentSessionId]: draft }, restoredWorkbench: {
      tabs: { [tabId]: { id: tabId, workspaceId, titleRegionId: agentRegionId,
        layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: agentRegionId }, second: { type: 'leaf', regionId: fileRegionId } }, activeRegionId: agentRegionId },
        regions: { [agentRegionId]: { regionId: agentRegionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: session.agentSessionId },
          [fileRegionId]: { regionId: fileRegionId, kind: 'file', workspaceId, path: join(workspacePath, 'sibling.txt') } } } },
      layouts: { [workspaceId]: { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId },
        __scratch__: { root: { type: 'leaf', groupId: scratchGroupId }, groups: [{ id: scratchGroupId, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: scratchGroupId } }
    } } }
  receipt.seed = seed
  const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor })
  receipt.phase = 'seed-first-hydrate'
  const seeded = await launch('seed', seed)
  assert.deepEqual(seeded.report.renderedWorkbench.tabIds, [tabId], 'Seed must enter the actual first hydrated App; late storage injection cannot qualify')
  assert.deepEqual(seeded.report.renderedWorkbench.regionIds, [agentRegionId, fileRegionId].sort())
  assert.deepEqual(seeded.report.workbench.tabIds, [tabId]); assert.equal(seeded.report.workbench.drafts[session.agentSessionId], draft)
  assert.deepEqual(seeded.report.workbenchStructure.layouts, seed.state.restoredWorkbench.layouts)
  receipt.seedReport = seeded.report
  receipt.processes = []
  for (const label of ['first', 'second']) {
    receipt.phase = `${label}-ordinary`
    const probe = await launch(label)
    const actual = await surface(probe)
    assertStored(actual, seed); assert.equal(actual.composer, draft)
    assert.deepEqual(actual.tabs, [tabId]); assert.deepEqual(actual.regions, [agentRegionId, fileRegionId].sort())
    const snapshot = await probe.cdp.evaluate('window.agentmux.sessions.snapshot()')
    const attached = snapshot.sessions.find(value => value.id === session.agentSessionId)
    assert.equal(attached?.processState, 'running'); assert.equal(attached.control.run.runId, session.run.runId)
    assert.equal((await run()).acceptedInputBytes, originalRun.acceptedInputBytes, 'Seed/read/ordinary restart never submits the draft')
    const exit = await normalQuit(probe)
    receipt.processes.push({ label, actual, exit })
  }
  assert.notEqual(receipt.processes[0].exit.pid, receipt.processes[1].exit.pid)
  receipt.phase = 'same-private-run-input'
  const before = await run()
  const ack = await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'z\r', source: 'user' })
  assert.ok(ack.appliedByteRange); assert.equal(ack.appliedByteRange.endByte - ack.appliedByteRange.startByte, 2)
  const after = await waitFor('same original PTY accepts actual input', async () => { const value = await run(); return value.acceptedInputBytes === before.acceptedInputBytes + 2 ? value : null })
  assert.deepEqual(client.runtimeIdentity(), receipt.runtime)
  receipt.originalRunAfter = after; receipt.inputAck = ack
  receipt.passed = true
} catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message, stack: error.stack }; receipt.passed = false }
finally {
  const errors = [], attempt = async operation => { try { await operation() } catch (error) { errors.push(String(error)) } }
  for (const connection of connections) connection.close()
  await attempt(async () => { if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } } })
  for (const child of children) await attempt(async () => { if (child.pid) await stopProbeProcesses(child.pid, root) })
  await attempt(async () => { await stopProbeProcesses(process.pid + 1_000_000_000, root); receipt.cleanup.remaining = await listProbeProcesses(process.pid + 1_000_000_000, root); assert.deepEqual(receipt.cleanup.remaining, []); await rm(root, { recursive: true }); receipt.cleanup.rootRemoved = true })
  await attempt(async () => { receipt.inputsAfter = await inputs(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore) })
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  if (errors.length) { receipt.cleanup.errors = errors; receipt.passed = false; failure ??= new Error(errors.join('; ')) }
}
await mkdir(join(repositoryRoot, '.tmp'), { recursive: true })
await writeFile(join(repositoryRoot, '.tmp/recovery-seed-order-last.json'), JSON.stringify(receipt, null, 2)+'\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, phase: receipt.phase, failure: receipt.failure ?? null, cleanup: receipt.cleanup })+'\n')
if (failure || !receipt.passed) process.exitCode = 1
