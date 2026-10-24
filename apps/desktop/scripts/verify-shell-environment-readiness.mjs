import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { stopProbeProcesses } from './probe-process.mjs'
import assertCoreDistBuiltFromCurrentSource from '../../../vitest.dist-freshness.ts'

assert.equal(process.platform, 'darwin')
await assertCoreDistBuiltFromCurrentSource()
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json')), exec = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const sourcePaths = ['packages/core/src/login-shell-environment.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts',
  'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/capsule-run-manager.ts',
  'apps/host/src/index.ts', 'apps/host/src/host.ts', 'apps/desktop/src/main/index.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/scripts/verify-shell-environment-readiness.mjs']
const digests = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const sources = await digests(sourcePaths)
const artifacts = await digests(['packages/core/dist/client.js', 'packages/core/dist/login-shell-environment.js',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`,
  'packages/core/node_modules/@ctxmux/sdk/dist/index.js',
  'packages/core/dist/agent-session-recovery/lifecycle.js', 'packages/core/dist/agent-session-recovery/continuity-attempt.js',
  'packages/core/dist/headless-runtime.js', 'packages/core/dist/capsule-run-manager.js',
  'apps/desktop/out/main/index.js', 'apps/desktop/out/main/agentmux-host.js',
  'apps/host/resources/bin/agentmux-workspace-move', 'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html', 'apps/desktop/out/renderer/release.json'])
const mutation = process.argv.find(value => value.startsWith('--mutation='))?.split('=')[1]
const output = join(root, '.local/state/shell-environment-readiness')
await mkdir(output, { recursive: true })
const delay = ms => new Promise(done => setTimeout(done, ms))
async function until(label, read, budget = 45000) {
  const end = Date.now() + budget
  let cause
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value } catch (error) { cause = error }
    await delay(50)
  }
  throw new Error('Private fixture observation unavailable: ' + label, { cause })
}
async function cdpConnect(url) {
  const socket = new WebSocket(url), requests = new Map(); let id = 0
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data), request = requests.get(value.id)
    if (!request) return
    requests.delete(value.id); clearTimeout(request.timer)
    value.error ? request.fail(new Error(value.error.message)) : request.done(value.result)
  })
  return { close: () => socket.close(), call: (method, params = {}) => new Promise((done, fail) => {
    const key = ++id, timer = setTimeout(() => { requests.delete(key); fail(new Error('Private CDP observation failed: ' + method)) }, 10000)
    requests.set(key, { done, fail, timer }); socket.send(JSON.stringify({ id: key, method, params }))
  }), async evaluate(expression) {
    const value = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}
async function scenario() {
  const fixture = await realpath(await mkdtemp('/private/tmp/amx-env-'))
  const home = join(fixture, 'home'), state = join(fixture, 'state'), runtime = join(fixture, 'r')
  const userData = join(fixture, 'user'), workspace = join(fixture, 'work'), main = join(fixture, 'out/main')
  const release = join(fixture, 'release'), entered = join(fixture, 'entered'), bin = join(home, 'bin')
  const children = [], connections = [], consumers = [], evaluated = [], facts = [], hostPids = new Set()
  let daemon, current, sdk, terminal
  const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')))
  const hosted = await import(pathToFileURL(join(root, 'packages/core/dist/hosted.js')))
  const { CtxmuxClient } = await import(pathToFileURL(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')))
  const label = 'com.agentmux.host.' + sha(join(runtime, 'control.sock')).slice(0, 24)
  const target = `gui/${process.getuid()}/${label}`
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', PATH: resolve(process.execPath, '..') + ':/usr/bin:/bin', FIXTURE_SHELL_VALUE: 'inherited',
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_DESKTOP_USER_DATA: userData,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'),
    AGENTMUX_DISABLE_CRASH_REPORTER: '1', AGENTMUX_WORKSPACE_MOVE_HELPER: join(root, 'apps/host/resources/bin/agentmux-workspace-move') }
  delete environment.ELECTRON_RUN_AS_NODE
  async function connect() {
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
    consumers.push(rpc)
    const client = await hosted.connectHostedAgentMux({ rpc }); consumers.push(client)
    await client.connectRuntime()
    hostPids.add(client.runtimeOwnerIdentity().processId)
    return { rpc, client }
  }
  async function launch() {
    const child = spawn(require('electron'), ['--inspect=0', join(fixture, 'bootstrap.cjs'), '--remote-debugging-port=0'],
      { cwd: desktop, env: environment, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let diagnostics = '', mainUrl, rendererUrl
    child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-16000)
      mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]
      rendererUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1] })
    child.on('error', error => { diagnostics += error.stack })
    const inspector = await cdpConnect(await until('Main inspector', () => {
      assert.equal(child.exitCode, null, diagnostics); return mainUrl
    })); connections.push(inspector)
    return { child, inspector, diagnostics: () => diagnostics, rendererUrl: () => rendererUrl }
  }
  async function page(probe) {
    const endpoint = new URL(await until('Renderer inspector', probe.rendererUrl))
    const row = await until('real Renderer page', async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json())
      .find(value => value.type === 'page' && value.url.startsWith('file:')))
    const cdp = await cdpConnect(row.webSocketDebuggerUrl); connections.push(cdp)
    await until('real Renderer preload and workface', () => cdp.evaluate('Boolean(window.agentmux && document.querySelector(".window-status-bar"))'))
    return cdp
  }
  const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktop, 'package.json'))})('electron')`
  async function click(cdp, selector) {
    const point = await until('visible private control', () => cdp.evaluate(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getClientRects().length);
      if (elements.length !== 1) return null; const r = elements[0].getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`))
    await cdp.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point})
    await cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point})
  }
  const hostsExited = () => [...hostPids].every(pid => {
    try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
  })
  async function quit(probe) {
    await probe.inspector.evaluate(`${electron}.app.quit()`).catch(() => {})
    probe.inspector.close()
    await until('private Desktop exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
    assert.equal(probe.child.exitCode, 0, probe.diagnostics())
    await exec('/bin/launchctl', ['bootout', target])
    await until('original private Host process exit', hostsExited, 10000)
  }
  const replay = async (client, runId) => Buffer.concat((await client.readRunReplay({ runId }, 0, 'raw')).replay.map(value => Buffer.from(value.dataBytes))).toString()
  const identity = observation => ({ layouts: observation.workbench.layouts, tabs: observation.workbench.tabs.map(tab => ({ ...tab, regions: tab.regions.map(({ control: _control, processState: _state, ...region }) => region) })),
    focus: observation.workbench.focus, activeWorkspaceId: observation.workbench.activeWorkspaceId, mainSurface: observation.workbench.mainSurface })
  try {
    for (const path of [home, state, join(state,'ctxmux'), runtime, userData, workspace, main, bin]) await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}')
    await symlink(join(desktop, 'node_modules'), join(fixture, 'node_modules'), 'dir')
    await mkdir(join(fixture, 'resources'), {mode:0o700})
    await symlink(join(desktop, 'resources/icon.png'), join(fixture, 'resources/icon.png'))
    await symlink(join(root, 'apps/host/resources/bin'), join(fixture, 'resources/bin'), 'dir')
    await symlink(join(fixture, 'resources'), join(fixture, 'out/resources'), 'dir')
    await symlink(join(desktop, 'out/main/chunks'), join(main, 'chunks'), 'dir')
    await symlink(join(desktop, 'out/preload'), join(fixture, 'out/preload'), 'dir')
    await symlink(join(desktop, 'out/renderer'), join(fixture, 'out/renderer'), 'dir')
    await writeFile(release, '')
    await writeFile(join(home, '.zshrc'), `: > '${entered}'\nwhile [ ! -f '${release}' ]; do /bin/sleep 0.05; done\nexport PATH='${bin}:${resolve(process.execPath, '..')}:/usr/bin:/bin'\nexport FIXTURE_SHELL_VALUE=interactive-complete\nexport AGENTMUX_RUNTIME_DIRECTORY='${fixture}/wrong-runtime'\nexport AGENTMUX_STATE_DIRECTORY='${fixture}/wrong-state'\nexport AGENTMUX_AGENT_CAPABILITY=shell-injected\nexport CTXMUX_SOCKET='${fixture}/wrong.sock'\n`)
    await writeFile(join(bin, 'private-export-runner'), '#!/bin/sh\nprintf "export:%s\\n" "$FIXTURE_SHELL_VALUE"\n/bin/cat\n', { mode: 0o755 })
    const loader = `import{registerHooks}from'node:module';import{createHash}from'node:crypto';import{appendFileSync,existsSync}from'node:fs';
      registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/packages/core/dist/client.js')&&!url.endsWith('/packages/core/dist/login-shell-environment.js'))return result;
      let source=String(result.source),original=source;const mutant=existsSync(${JSON.stringify(join(fixture, 'enable-mutation'))})?${JSON.stringify(mutation ?? '')}:'';
      if(mutant==='execution-wait'&&url.endsWith('/client.js')){const anchor='async prepareTerminal(input) {\\n        input = structuredClone(input);\\n        await this.prepareExecutionEnvironment();';if(!source.includes(anchor))throw Error('Missing actual preparation mutation target');source=source.replace(anchor,'async prepareTerminal(input) {\\n        input = structuredClone(input);');}
      if(mutant==='authority'&&url.endsWith('/login-shell-environment.js')){const anchor="if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_') || ['HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(key))";if(!source.includes(anchor))throw Error('Missing actual authority mutation target');source=source.replace(anchor,'if (false)');}
      const digest=value=>createHash('sha256').update(value).digest('hex');appendFileSync(${JSON.stringify(join(fixture, 'evaluated.jsonl'))},JSON.stringify({url,mutation:mutant,originalSHA256:digest(original),evaluatedSHA256:digest(source)})+'\\n');return{...result,source};}});`
    await writeFile(join(fixture, 'loader.mjs'), loader)
    let source = await readFile(join(desktop, 'out/main/index.js'), 'utf8')
    if (mutation === 'window-await') { const anchor = '  async function buildWindow(appReadyAtMs = Date.now()) {'
      const preparation = '  prepareProcessEnvironmentFromLoginShell().then((result2) => {'
      assert.ok(source.includes(anchor) && source.includes(preparation));
      source = source.replace(preparation, '  const environmentReady = prepareProcessEnvironmentFromLoginShell().then((result2) => {')
        .replace(anchor, anchor + '\n    await environmentReady;') }
    evaluated.push({ path: 'apps/desktop/out/main/index.js', originalSHA256: artifacts['apps/desktop/out/main/index.js'], evaluatedSHA256: sha(source) })
    await writeFile(join(main, 'index.js'), source)
    let entry = await readFile(join(desktop, 'out/main/agentmux-host.js'), 'utf8')
    if (mutation === 'host-await') { const anchor = 'const configured = configuredHostClients(configurationPath);'
      assert.ok(entry.includes(anchor)); entry = entry.replace(anchor, 'await environmentReady;\n' + anchor) }
    evaluated.push({ path: 'apps/desktop/out/main/agentmux-host.js', originalSHA256: artifacts['apps/desktop/out/main/agentmux-host.js'], evaluatedSHA256: sha(entry) })
    await writeFile(join(main, 'host-real.mjs'), entry)
    await writeFile(join(main, 'agentmux-host.js'), `process.env.HOME=${JSON.stringify(home)};process.env.ZDOTDIR=${JSON.stringify(home)};process.env.SHELL='/bin/zsh';await import(${JSON.stringify(pathToFileURL(join(fixture, 'loader.mjs')).href)});await import('./host-real.mjs');`)
    await writeFile(join(fixture, 'bootstrap.cjs'), `const{app}=require('electron');app.setPath('home',${JSON.stringify(home)});app.setAppPath(${JSON.stringify(desktop)});console.error('private-bootstrap');app.once('ready',()=>console.error('private-app-ready'));import('./loader.mjs').then(()=>{console.error('private-loader-ready');return import('./out/main/index.js')}).then(()=>console.error('private-main-imported')).catch(error=>{console.error(error);app.exit(1)});`)
    await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9,
      hosts: [{ id: 'local', kind: 'local', label: 'Private local' }], executors: {},
      workspaces: [{ id: 'environment-fixture', name: 'Private environment', hostId: 'local', path: workspace, kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' }, browser: { agentAutomation: false, toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
    daemon = spawn(join(root, `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`),
      ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }); children.push(daemon)
    let daemonErrors = ''
    daemon.stderr.on('data', bytes => { daemonErrors += bytes })
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Private Native readiness unconfirmed: ' + daemonErrors)), 10000)
      daemon.stdio[3].once('data', () => { clearTimeout(timer); done() })
      daemon.once('exit', code => { clearTimeout(timer); fail(new Error('Private Native exited ' + code + ': ' + daemonErrors)) })
      daemon.once('error', error => { clearTimeout(timer); fail(error) })
    })
    sdk = new CtxmuxClient({ socketPath: join(runtime, 'ctxmux.sock') })
    current = await launch(); const firstPage = await page(current)
    const first = await until('initial semantic Host', () => connect().catch(() => null))
    const observation = await until('initial durable workface', async () => {
      const value = (await first.rpc.call('app.inspect', {})).observation
      return !value.workbench.loading ? value : null
    })
    assert.equal(observation.workbench.loading, false)
    await click(firstPage, '.project-rail-row[data-workspace-id="environment-fixture"]')
    await click(firstPage, 'button[title="New tab"]')
    const launcher = await until('real workspace launcher', async () => (await first.rpc.call('app.inspect', {})).observation.workbench.tabs
      .filter(tab => tab.workspaceId === 'environment-fixture').flatMap(tab => tab.regions).find(region => region.kind === 'launcher'))
    const opened = await first.rpc.call('terminal.open', { shellCommand: '/bin/cat', destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: launcher.regionId } } })
    terminal = opened.region
    assert.ok(terminal.runId)
    const before = await until('durable original Region', async () => {
      const result = await first.rpc.call('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: terminal.regionId } })
      return result.save.diskDurability === 'confirmed' ? (await first.rpc.call('app.inspect', {})).observation : null
    })
    const originalRun = await sdk.status(terminal.runId), originalNative = first.client.runtimeIdentity()
    const prepared = await first.client.prepareTerminal({ workspacePath: workspace, command: '/bin/cat', createOperationId: 'original-creation-receipt' })
    const originalReceiptRun = await first.client.createPreparedTerminal(prepared)
    const originalOwner = first.client.runtimeOwnerIdentity()
    await quit(current); firstPage.close(); current = undefined
    await rm(release); await rm(entered, { force: true }); await writeFile(join(fixture, 'enable-mutation'), '')
    current = await launch()
    await until('held interactive profile', async () => readFile(entered).then(() => true))
    // This is an exact window fact while its profile barrier is closed, not a guessed time-to-ready.
    await until('same Main app ready', () => current.inspector.evaluate(`${electron}.app.isReady()`))
    await delay(500)
    const windowCount = await current.inspector.evaluate(`${electron}.BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()).length`)
    assert.equal(windowCount, 1, 'Original window must exist while shell exports are pending')
    const secondPage = await page(current)
    let second
    await until('semantic socket directory observation', async () => {
      try { second = await connect(); return true } catch { return false }
    }, 10000).catch(() => {})
    assert.ok(second, 'Original semantic Host must serve while shell exports are pending')
    const after = await until('restored durable original workface', async () => {
      const value = (await second.rpc.call('app.inspect', {})).observation
      return !value.workbench.loading && value.workbench.tabs.some(tab => tab.regions.some(region => region.regionId === terminal.regionId)) ? value : null
    })
    assert.deepEqual(identity(after), identity(before), 'Original durable workface and focus must precede shell exports')
    await until('same live terminal control in actual workface', async () => (await second.rpc.call('app.inspect', {})).observation.workbench.tabs
      .flatMap(tab => tab.regions).some(region => region.regionId === terminal.regionId && region.control?.run?.runId === terminal.runId && region.processState === 'running'), 10000)
    assert.deepEqual(second.client.runtimeIdentity(), originalNative)
    assert.notEqual(second.client.runtimeOwnerIdentity().ownerInstanceId, originalOwner.ownerInstanceId)
    const retained = await second.client.inspectPreparedTerminal(prepared, { runId: originalReceiptRun.runId })
    assert.equal(retained.runId, originalReceiptRun.runId, 'Original creation inspection is not a new-execution dependency')
    const attachment = await second.client.attachTerminal(terminal.runId, 0, 'raw')
    await second.client.writeTerminal({ runId: terminal.runId }, { ownerInstanceId: originalNative.instanceId,
      operationId: 'healthy-input-during-environment-preparation', expectedByte: attachment.run.acceptedInputBytes, data: 'original-still-usable\n' })
    await until('healthy original output', async () => (await replay(second.client, terminal.runId)).includes('original-still-usable'))
    assert.equal((await sdk.status(terminal.runId)).pid, originalRun.pid)
    assert.equal((await sdk.status(terminal.runId)).state.type, 'running')
    const count = (await second.client.listRuns()).length
    let finished = false
    const pending = second.client.prepareTerminal({ workspacePath: workspace, command: 'private-export-runner',
      env: { FIXTURE_SHELL_VALUE: 'explicit-wins' }, createOperationId: 'new-execution-original-operation' }).then(value => { finished = true; return value })
    await delay(200)
    assert.equal(finished, false, 'New execution must wait before freezing complete exports')
    assert.equal((await second.client.listRuns()).length, count)
    await writeFile(release, '')
    const newPreparation = await pending
    assert.equal(newPreparation.createOperationId, 'new-execution-original-operation')
    const frozen = JSON.parse(newPreparation.launch).request
    assert.equal(frozen.env.AGENTMUX_RUNTIME_DIRECTORY, runtime, 'Original namespace must survive shell exports')
    assert.equal(frozen.env.AGENTMUX_STATE_DIRECTORY, state, 'Original namespace must survive shell exports')
    assert.equal(frozen.env.AGENTMUX_AGENT_CAPABILITY, undefined, 'Original namespace must survive shell exports')
    const run = await second.client.createPreparedTerminal(newPreparation)
    await until('new execution full interactive export', async () => (await replay(second.client, run.runId)).includes('export:explicit-wins'))
    const implicit = await second.client.createTerminal({ workspacePath: workspace, command: 'private-export-runner', createOperationId: 'complete-interactive-export' })
    await until('non-PATH interactive export', async () => (await replay(second.client, implicit.runId)).includes('export:interactive-complete'))
    await until('late successful warning clears', async () => (await secondPage.evaluate('(async()=>await window.agentmux.sessions.snapshot())()')).environmentWarning === undefined)
    facts.push({ originalRunId: terminal.runId, originalRunPid: originalRun.pid, originalNative,
      firstHost: originalOwner, secondHost: second.client.runtimeOwnerIdentity(), durableIdentityEqual: true,
      originalCreationReadWhilePending: true, healthyInputWhilePending: true, newExecutionHeldUntilFullExports: true,
      explicitEnvironmentWins: true, implicitInteractiveExportObserved: true, namespaceRetained: true })
    for (const ref of [run, implicit, originalReceiptRun, { runId: terminal.runId }]) await second.client.stopTerminal({ runId: ref.runId })
    terminal = undefined
    await quit(current); current = undefined
    evaluated.push(...(await readFile(join(fixture, 'evaluated.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
    return { facts, evaluated }
  } catch (error) {
    evaluated.push(...await readFile(join(fixture, 'evaluated.jsonl'), 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => []))
    console.error(JSON.stringify({ stage: 'scenario-assertion', mutation: mutation ?? null, name: error.name, message: error.message, evaluated, diagnostics: current?.diagnostics(), mainState: await current?.inspector.evaluate(`({ready:${electron}.app.isReady(),windows:${electron}.BrowserWindow.getAllWindows().length})`).catch(() => null), crashLog: await readFile(join(userData, 'crash-log.ndjson'), 'utf8').catch(() => '') }))
    throw error
  } finally {
    // Release only this fixture's probe; shutdown cannot require killing a healthy user Run.
    await writeFile(release, '').catch(() => {})
    for (const client of consumers.reverse()) await client.dispose().catch(() => {})
    for (const connection of connections) connection.close()
    await exec('/bin/launchctl', ['bootout', target]).catch(() => {})
    await until('private Host cleanup', hostsExited, 10000)
    await sdk?.close?.()
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    }
    await stopProbeProcesses(process.pid + 1_000_000_000, fixture)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
const receipt = { schema: 'agentmux.shell-environment-readiness.v1', passed: false, sources, artifacts,
  command: 'node apps/desktop/scripts/verify-shell-environment-readiness.mjs' + (process.argv.includes('--mutations') ? ' --mutations' : ''),
  scope: 'Private actual compiled Main/Host entries bound to current source, built production preload/Renderer, public RPC/Hosted SDK and independent official Native. Real Host and Desktop restart, retained durable workface/Run, controlled interactive profile barrier, complete exports and exact namespace. No user App, profiles, service or Run.', runs: [] }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
try {
const result = await scenario()
receipt.runs.push({ mutation: null, passed: true, ...result })
if (process.argv.includes('--mutations')) {
  const targets = { 'window-await': 'Original window must exist while shell exports are pending',
    'host-await': 'Original semantic Host must serve while shell exports are pending',
    'execution-wait': 'New execution must wait before freezing complete exports', authority: 'Original namespace must survive shell exports' }
  for (const [name, expected] of Object.entries(targets)) {
    const failed = await exec(process.execPath, [import.meta.filename, '--mutation=' + name], { timeout: 120000, maxBuffer: 256 * 1024 })
      .then(() => null, error => error)
    assert.ok(failed && failed.code === 1 && !failed.killed, 'The actual source mutation must finish with its failing assertion: ' + name)
    const rows = String(failed.stderr).split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const row = rows.find(value => value.stage === 'scenario-assertion')
    assert.equal(row?.name, 'AssertionError', failed.stderr)
    assert.ok(row.message.startsWith(expected), failed.stderr)
    assert.ok(row.evaluated.some(value => value.originalSHA256 !== value.evaluatedSHA256), 'Actual changed owner must evaluate')
    receipt.runs.push({ mutation: name, rejected: true, assertion: row.message, evaluated: row.evaluated })
    console.log(JSON.stringify({ mutation: name, rejected: true, assertion: row.message }))
  }
}
assert.deepEqual(await digests(sourcePaths), sources, 'Qualified source must remain unchanged')
assert.deepEqual(await digests(Object.keys(artifacts)), artifacts, 'Executed compiled artifacts must remain unchanged')
receipt.passed = true
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: '.local/state/shell-environment-readiness/receipt.json' }))

} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  throw error
}
