import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

// Three real Node processes, public Core/native PTY and actual Store persistence.
// A private filesystem localStorage adapter isolates the host transport; no Electron/paint claim.
const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const require = createRequire(join(base, 'packages/core/package.json'))
const { build } = await import(require.resolve('esbuild'))
const desktopRequire = createRequire(join(base, 'apps/desktop/package.json'))
const happyDomPath = desktopRequire.resolve('happy-dom')
const out = join(base, '.tmp/unclaimed-terminal-restart-proof')
await mkdir(out, { recursive: true })
const root = await mkdtemp('/tmp/amx-unclaimed-restart-')
await mkdir(join(root, 'home'), { mode: 0o700 })
const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'home'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
for (const name of ['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_HOOK_TOKEN', 'AGENTMUX_HOOK_URL']) delete env[name]
const critical = [fileURLToPath(import.meta.url), join(base, 'apps/desktop/scripts/probe-process.mjs'),
  ...['main/runtime-controller.ts', 'shared/contracts.ts', 'renderer/src/store.ts', 'renderer/src/lib/session-state.ts',
    'renderer/src/lib/api.ts'].map(p => join(base, 'apps/desktop/src', p)),
  join(base, 'packages/core/dist/client.js'), join(base, 'packages/core/dist/ctxmux-run-adapter.js'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json')]
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex')
const capture = async () => Object.fromEntries(await Promise.all(critical.map(async p => [p, await hash(p)])))
const before = await capture(), children = [], records = [], cleanupErrors = []
let compiledBefore = null, compiledAfter = null
let failure
const worker = join(root, 'worker.mjs')
const source = `
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Window } from ${JSON.stringify(happyDomPath)}
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { RuntimeController } from ${JSON.stringify(join(base, 'apps/desktop/src/main/runtime-controller.ts'))}
import { createWorkbenchTab } from ${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts'))}
const [mode, root] = process.argv.slice(2)
const window = new Window({ url: 'http://private.test' })
const storagePath = join(root, 'workbench.json')
Object.defineProperty(window, 'localStorage', { value: {
 getItem: key => existsSync(storagePath) ? (JSON.parse(readFileSync(storagePath, 'utf8'))[key] ?? null) : null,
 setItem: (key, value) => { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; values[key] = value; writeFileSync(storagePath, JSON.stringify(values)) },
 removeItem: key => { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; delete values[key]; writeFileSync(storagePath, JSON.stringify(values)) }
} })
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage })
const { api } = await import(${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/lib/api.ts'))})
const { useAppStore } = await import(${JSON.stringify(join(base, 'apps/desktop/src/renderer/src/store.ts'))})
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const core = await connectLocalAgentMux({ store })
const runtime = new RuntimeController(store)
runtime.commit({ hosts: [{ id: 'local', client: core, executionHost: { kind: 'local', dispose: async () => {} } }],
 removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
 workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: root, kind: 'folder' }],
 appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const listeners = new Set(), stops = []
const sender = Object.assign(new EventEmitter(), { id: mode === 'first' ? 1 : mode === 'second' ? 2 : 3, isDestroyed: () => false,
 send: (_channel, event) => { for (const listener of listeners) listener(event) } })
const detach = runtime.attach(sender)
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...await runtime.snapshot(config), localHome: join(root, 'home') })
api.providers.list = async () => runtime.providerCatalog()
api.sessions.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
api.sessions.stop = async control => { stops.push(control); await runtime.stopSession(control) }
api.sessions.refresh = control => runtime.refresh(control, config)
api.ui.requestStorageFlush = async () => {}
const wait = async (predicate, label) => { const end = Date.now() + 10000; do {
 const value = await predicate(); if (value) return value; await new Promise(done => setTimeout(done, 25))
 } while (Date.now() < end); throw new Error('Private deadline: ' + label) }
const status = async id => { const runs = await core.listRuns(); assert.ok(runs.length > 0); const run = runs.find(value => value.runId === id); assert.ok(run); return run }
let disposeUi
try {
 let id, previous
 if (mode === 'first') {
  const created = await core.createTerminal({ workspacePath: root, command: '/usr/bin/python3', args: ['-u', join(root, 'pty.py')] })
  id = created.runId
 } else { previous = JSON.parse(readFileSync(join(root, 'first.json'), 'utf8')); id = previous.id }
 disposeUi = await useAppStore.getState().initialize()
 const currentState = useAppStore.getState()
 const session = currentState.sessions.find(value => value.id === id)
 assert.ok(session); assert.equal(session.kind, 'terminal'); assert.equal(session.processState, 'running')
 assert.deepEqual(stops, [])
 if (mode === 'first') {
  const tab = createWorkbenchTab('original-terminal-view', { regionId: 'original-terminal-region', kind: 'terminal', phase: 'attached', workspaceId: 'private', sessionId: id })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { private: createWorkspaceLayout('original-group', [tab.id]) },
   unclaimedTerminalSessionIds: [id], agentComposerDrafts: { unrelated: 'private-original-draft' } })
 } else {
  assert.deepEqual(currentState.tabs, previous.tabs); assert.deepEqual(currentState.layouts, previous.layouts)
  assert.deepEqual(currentState.agentComposerDrafts, previous.drafts); assert.deepEqual(currentState.unclaimedTerminalSessionIds, [id])
 }
 await core.attachTerminal(id)
 const initial = await status(id)
 await wait(async () => (await status(id)).latestOutputBytes > 0, 'nonempty PTY')
 await runtime.write(session.control, mode === 'first' ? 'a' : mode === 'second' ? 'b' : 'c', 'user')
 const current = await wait(async () => { const value = await status(id); return value.acceptedInputBytes > initial.acceptedInputBytes && value.latestOutputBytes > initial.latestOutputBytes ? value : null }, 'actual input and output')
 const state = useAppStore.getState()
 await wait(() => {
  if (!existsSync(storagePath)) return false
  const values = JSON.parse(readFileSync(storagePath, 'utf8')), saved = JSON.parse(values['agentmux-workbench-v1'] ?? 'null')
  return saved?.state?.unclaimedTerminalSessionIds?.includes(id) && Object.keys(saved.state.restoredWorkbench?.tabs ?? {}).length === 1
 }, 'actual Store durable marker and workbench writer')
 assert.deepEqual(stops, []); assert.equal(current.state, 'running')
 const parentPid = Number(execFileSync('/bin/ps', ['-p', String(current.pid), '-o', 'ppid='], { encoding: 'utf8' }).trim())
 assert.ok(Number.isSafeInteger(parentPid) && parentPid > 1)
 const result = { mode, clientPid: process.pid, id, childPid: current.pid,
  childBirth: execFileSync('/bin/ps', ['-p', String(current.pid), '-o', 'uid=,pid=,ppid=,lstart='], { encoding: 'utf8' }).trim(),
  nativePid: parentPid,
  nativeBirth: execFileSync('/bin/ps', ['-p', String(parentPid), '-o', 'uid=,pid=,lstart='], { encoding: 'utf8' }).trim(),
  daemon: core.runtimeIdentity().instanceId, accepted: current.acceptedInputBytes, output: current.latestOutputBytes,
  tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, unclaimed: state.unclaimedTerminalSessionIds, stops }
 if (mode === 'first') writeFileSync(join(root, 'first.json'), JSON.stringify(result))
 if (mode === 'third') {
  await runtime.write(session.control, 'q', 'user')
  await wait(async () => (await status(id)).state === 'exited', 'private child natural exit')
  result.privateChildNaturallyExited = true
 }
 process.stdout.write(JSON.stringify(result) + '\\n')
} finally { await disposeUi?.(); detach(); await runtime.dispose(); await window.happyDOM.close() }

`
try {
  await writeFile(join(root, 'pty.py'), "import os,tty\ntty.setraw(0)\nos.write(1,b'PRIVATE-READY')\nwhile True:\n b=os.read(0,1)\n if b==b'q':break\n os.write(1,b'PRIVATE-ACK:'+b)\n")
  const entry = join(root, 'entry.mjs'); await writeFile(entry, source)
  await build({ absWorkingDir: base, entryPoints: [entry], outfile: worker, bundle: true, packages: 'external', external: [happyDomPath],
    platform: 'node', format: 'esm', plugins: [{ name: 'local-workspace-source', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\/layout$/ }, args => ({ path: join(base, 'packages/layout', JSON.parse(require('node:fs').readFileSync(join(base, 'packages/layout/package.json'), 'utf8')).exports['.'].import) }))
      // This Node host does not provide Electron's optional OS resource sampling.
      // Runtime lifecycle, public Core and persistence remain their actual implementations.
      bundler.onResolve({ filter: /^electron$/ }, () => ({ path: 'private-resource-observation', namespace: 'private-node-host' }))
      bundler.onLoad({ filter: /.*/, namespace: 'private-node-host' }, () => ({ contents: 'export const app = { getAppMetrics: () => [] }', loader: 'js' }))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, logLevel: 'silent' })
  compiledBefore = { sha256: await hash(worker), bytes: (await readFile(worker)).length }
  // Resolve external dependencies from the project without copying/installing them.
  await import('node:fs/promises').then(({ symlink }) => symlink(join(base, 'apps/desktop/node_modules'), join(root, 'node_modules')))
  const run = async mode => {
    const child = spawn(process.execPath, [worker, mode, root], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value; assert.ok(stdout.length < 1024 * 1024) })
    child.stderr.on('data', value => { stderr += value; if (stderr.length > 65536) stderr = stderr.slice(-65536) })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25000)
    try {
      const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
      assert.equal(result.code, 0, stderr); assert.equal(result.signal, null)
      const record = { ...JSON.parse(stdout.trim().split('\n').at(-1)), exit: result }; records.push(record); return record
    } finally { clearTimeout(deadline) }
  }
  const first = await run('first'), second = await run('second'), third = await run('third')
  assert.equal(new Set(records.map(record => record.clientPid)).size, 3)
  for (const next of [second, third]) {
    assert.equal(first.id, next.id); assert.equal(first.childPid, next.childPid); assert.equal(first.daemon, next.daemon)
    assert.equal(first.childBirth, next.childBirth)
    assert.equal(first.nativePid, next.nativePid); assert.equal(first.nativeBirth, next.nativeBirth)
    assert.deepEqual(first.tabs, next.tabs); assert.deepEqual(first.layouts, next.layouts); assert.deepEqual(first.drafts, next.drafts)
    assert.deepEqual(next.unclaimed, [first.id]); assert.deepEqual(next.stops, [])
  }
  assert.equal(second.accepted, first.accepted + 1); assert.ok(second.output > first.output)
  assert.equal(third.accepted, second.accepted + 1); assert.ok(third.output > second.output)
  assert.equal(third.privateChildNaturallyExited, true)
} catch (error) { failure = error.stack ?? String(error) }
finally {
  // Cleanup remains independent of assertion/process errors, restricted to the unique private root.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  for (const pid of await listProbeProcesses(-1, root)) {
    try {
      await signalOwnedProbeProcess(pid, root, 'SIGTERM')
    } catch (error) { cleanupErrors.push(String(error)) }
  }
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && (await listProbeProcesses(-1, root)).length) await new Promise(done => setTimeout(done, 25))
  let remaining = await listProbeProcesses(-1, root)
  for (const pid of remaining) { try { await signalOwnedProbeProcess(pid, root, 'SIGKILL') } catch (error) { cleanupErrors.push(String(error)) } }
  await new Promise(done => setTimeout(done, 50)); remaining = await listProbeProcesses(-1, root)
  compiledAfter = compiledBefore ? { sha256: await hash(worker), bytes: (await readFile(worker)).length } : null
  if (JSON.stringify(compiledBefore) !== JSON.stringify(compiledAfter)) failure ??= 'Compiled worker changed during proof'
  const after = await capture(); if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Selected inputs changed during proof'
  if (!remaining.length && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
  const receipt = { passed: !failure && !remaining.length && !cleanupErrors.length, records,
    inputsBefore: before, inputsAfter: after, compiledBefore, compiledAfter, failure: failure ?? null,
    cleanup: { remaining, errors: cleanupErrors, rootRemoved: !remaining.length && !cleanupErrors.length },
    scope: 'Actual public Core/FileStore/native PTY, RuntimeController, Store filesystem-host storage; first and two ordinary Node restarts, not Electron/OS input/user Run.' }
  await writeFile(join(out, 'restart-last.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, processes: records.length, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
