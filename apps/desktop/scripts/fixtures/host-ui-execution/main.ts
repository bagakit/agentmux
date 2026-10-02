import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import type { AppConfig, SessionControl } from '../../../src/shared/contracts'
import { inspectFarmOs, observeProtected, originalSessionId } from './farm-proof.mjs'

const [html, privateRoot, phase, preload, evidence, inputPath] = process.argv.slice(2)
assert.ok(html && privateRoot && phase && preload && evidence && inputPath, 'The complete private Native invocation is required')
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
const config: AppConfig = input.config
const runtimeConfig = { ...config, hosts: config.hosts.filter(host => host.id !== 'host-ui-empty'),
  workspaces: config.workspaces.filter(workspace => workspace.hostId !== 'host-ui-empty') }
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
process.env.AGENTMUX_AGENT_SESSION_STORE = store.path
const runtime = new RuntimeController(store, connectDesktopAgentMuxHost)
const files = new WorkspaceFiles(id => runtime.executionHost(id))
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
const manifestPath = path.join(privateRoot, 'owned-sessions.json')
let owned: any[] = []
try { owned = JSON.parse(await fs.readFile(manifestPath, 'utf8')) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
let win: BrowserWindow
const calls: any[] = []
const result: any = { schema: 'agentmux.host-ui-execution.phase.v1', passed: false, phase,
  electronPid: process.pid, userAppTouched: false, sharedRemoteOwnerLifecycleAction: false }
const remoteClient = () => runtime.rpcClients().find(item => item.hostId === input.remoteHostId)!.client
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const saveOwned = async (session: any, purpose: string) => {
  assert.notEqual(session.id, originalSessionId)
  if (!owned.some(one => one.sessionId === session.id)) owned.push({ sessionId: session.id, kind: session.kind,
    hostId: session.hostId, runId: session.control.run.runId, workspacePath: session.workspacePath, purpose })
  await fs.writeFile(manifestPath, JSON.stringify(owned, null, 2), { mode: 0o600 })
}
const requireOwned = (control: SessionControl) => {
  const id = control.kind === 'agent' ? control.agentSessionId : control.runId
  assert.notEqual(id, originalSessionId, 'Original business Session is read-only')
  assert.ok(owned.some(one => one.sessionId === id && one.hostId === control.hostId && one.runId === control.run.runId),
    'Mutating input and stop require this invocation\'s actual created Session and Run')
}
const workspace = (id: string) => {
  const item = config.workspaces.find(one => one.id === id)
  assert.ok(item && ['host-ui-local', 'host-ui-remote'].includes(item.id), 'Only exact Task-owned filesystem resources are accessible')
  return item
}
ipcMain.handle('host-ui:request', async (_event, operation, ...args) => {
  calls.push({ operation, args: json(args) })
  switch (operation) {
    case 'setup': return { phase, config, secondDraft: input.secondDraft }
    case 'spatial-read': return spatial.read()
    case 'spatial-commit': return spatial.commit(args[0])
    case 'providers': return runtime.providerCatalog()
    case 'detect': return runtime.detect(args[0], args[1], runtimeConfig)
    case 'check-host': return runtime.checkHost(args[0])
    case 'snapshot': return runtime.snapshot(runtimeConfig)
    case 'seed-local': {
      assert.equal(phase, 'seed')
      const session = await runtime.launchTerminal({ hostId: 'local', workspacePath: workspace('host-ui-local').path,
        shellCommand: 'printf "HOST_UI_LOCAL_KEEP_READY\\n"; exec /bin/sh' }, runtimeConfig)
      await saveOwned(session, 'original-healthy-local-fixture')
      await fs.writeFile(path.join(privateRoot, 'local-identity.json'), JSON.stringify(session), { mode: 0o600 })
      return session
    }
    case 'launch-agent': {
      assert.equal(args[0].hostId, input.remoteHostId, 'Agent UI request uses the actually selected SSH Host')
      assert.equal(args[0].workspacePath, workspace('host-ui-remote').path, 'Agent UI request uses the actually selected Workspace')
      assert.notEqual(args[0].agentSessionId, originalSessionId)
      const launched = await runtime.launchAgent(args[0], runtimeConfig)
      const created = launched.created
      const session = launched.session ?? { id: created.agentSessionId, kind: 'agent', hostId: args[0].hostId,
        workspacePath: created.workspacePath, control: { kind: 'agent', hostId: args[0].hostId,
          agentSessionId: created.agentSessionId, run: created.run } }
      await saveOwned(session, 'actual-launcher-geminicc')
      result.agentLaunch = { request: args[0], created: { agentSessionId: created.agentSessionId,
        workspacePath: created.workspacePath, run: created.run, nativeHandle: created.nativeHandle },
        creation: launched.creation, session, projectionFailures: launched.projectionFailures }
      return launched
    }
    case 'launch-terminal': {
      assert.ok(args[0].hostId === 'local' && args[0].workspacePath === workspace('host-ui-local').path ||
        args[0].hostId === input.remoteHostId && args[0].workspacePath === workspace('host-ui-remote').path)
      const session = await runtime.launchTerminal(args[0], runtimeConfig)
      await saveOwned(session, args[0].hostId === 'local' ? 'actual-local-warm-shell' : 'actual-launcher-remote-terminal')
      if (args[0].hostId === input.remoteHostId) result.terminalLaunch = { request: args[0], session }
      return session
    }
    case 'creation': return runtime.agentCreation(args[0], args[1])
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], runtimeConfig)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'resolve': return runtime.resolveSession(args[0], runtimeConfig)
    case 'refresh': return runtime.refresh(args[0], runtimeConfig)
    case 'write': requireOwned(args[0]); return runtime.write(args[0], args[1], args[2])
    case 'paste': requireOwned(args[0]); return runtime.paste(args[0], args[1], args[2])
    case 'stop': requireOwned(args[0]); return runtime.stopSession(args[0])
    case 'submit-prompt': requireOwned(args[0]); return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5])
    case 'submit-message': requireOwned(args[0]); return runtime.submitMessage(args[0], args[1])
    case 'file-readDirectory': return files.readDirectory(workspace(args[0]), args[1])
    case 'file-read': return files.read(workspace(args[0]), args[1])
    case 'file-write': return files.write(workspace(args[0]), args[1])
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private Host UI boundary: ${operation}`)
  }
})

app.whenReady().then(async () => {
  const state = async () => json(await win.webContents.executeJavaScript('window.hostUiState()'))
  const stage = async (step: string) => {
    process.stderr.write(`host-ui:${phase}:${step}\n`)
    await fs.writeFile(path.join(evidence, `${phase}-progress.json`), JSON.stringify({ phase, step, pid: process.pid, at: Date.now() }), { mode: 0o600 })
  }
  const until = async (expression: string | (() => unknown), budget = 20_000) => {
    const deadline = Date.now() + budget
    do { const value = typeof expression === 'string' ? await win.webContents.executeJavaScript(expression) : expression(); if (value) return value; await delay(40) } while (Date.now() < deadline)
    throw new Error(`Native Host UI condition did not settle: ${expression}`)
  }
  const capture = async (name: string) => {
    await until('window.terminals.every(one => !one.element?.isConnected || one.remoteProofMetrics.completedWrites === one.remoteProofMetrics.writeCalls)')
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await delay(160)
    await fs.writeFile(path.join(evidence, `${phase}-${name}.png`), (await win.capturePage()).toPNG(), { mode: 0o600 })
  }
  const region = (id: string) => `[data-workbench-region-id="${id}"]`
  const click = async (selector: string) => {
    const bounds = await win.webContents.executeJavaScript(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) throw Error('Actual button unavailable');
      node.scrollIntoView({block:'nearest'}); const r=node.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if (!r.width || !r.height || !(node===hit || node.contains(hit))) throw Error('Actual button is clipped or covered');
      return {x:r.x+r.width/2,y:r.y+r.height/2,text:node.textContent,label:node.getAttribute('aria-label')};
    })()`)
    result.uiActions ??= []; result.uiActions.push({ kind: 'actual-dom-point', selector, ...bounds })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 })
    await delay(80)
  }
  const select = async (selector: string, value: string) => {
    await win.webContents.executeJavaScript(`(() => {const node=document.querySelector(${JSON.stringify(selector)});
      if (!node || ![...node.options].some(one=>one.value===${JSON.stringify(value)})) throw Error('Exact registered select value is missing');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,${JSON.stringify(value)});
      node.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    result.uiActions ??= []; result.uiActions.push({ kind: 'actual-native-select-change', selector, value })
    await delay(80)
  }
  const enter = async (selector: string, text: string) => {
    await click(selector)
    await win.webContents.debugger.sendCommand('Input.insertText', { text })
  }
  const openTarget = async (id: string) => {
    await click(`${region(id)} [aria-label="Runtime environment"]`)
    await until('Boolean(document.querySelector(".launcher-target select"))')
  }
  const selectRemote = async (id: string) => {
    await openTarget(id)
    await select('[aria-label="Machine for new session"]', input.remoteHostId)
    await click('[data-workspace-id="host-ui-remote"]')
    await until(`window.hostUiState().tabs['host-ui-original-tab'].regions[${JSON.stringify(id)}].workspaceId==='host-ui-remote'`)
  }
  const durable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, drafts: value.drafts,
    names: value.names, options: value.options, activeWorkspaceId: value.activeWorkspaceId })
  const inspectHeader = async (regionId: string, hostId: string, name: string) => {
    const facts = await win.webContents.executeJavaScript(`(() => {
      const root=document.querySelector(${JSON.stringify(region(regionId))});
      const host=root?.querySelector('.agent-region-header__execution');
      const more=root?.querySelector('.agent-region-header__more');
      const close=root?.querySelector(':scope > .workbench-region__close');
      const rect=node=>{if(!node)throw Error('Original Header control missing');const r=node.getBoundingClientRect();
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {x:r.x,y:r.y,width:r.width,height:r.height,hitBelongs:node===hit||node.contains(hit)}};
      return {hostId:host?.dataset.executionHostId,label:host?.textContent,title:host?.title,
        host:rect(host),more:rect(more),close:rect(close)};
    })()`)
    assert.equal(facts.hostId, hostId)
    for (const one of [facts.host, facts.more, facts.close]) assert.ok(one.width > 0 && one.height > 0 && one.hitBelongs,
      'Original Host, More and close controls remain painted and hit-testable')
    result.headerObservations ??= []; result.headerObservations.push({ regionId, name, ...facts })
    await click(`${region(regionId)} .agent-region-header__more`)
    const menu = await until(`document.querySelector('.agent-region-menu[data-owner-region-id="${regionId}"] .agent-region-menu__context')?.innerText`)
    assert.ok(menu.includes(`Host ID: ${hostId}`) && menu.includes(`Directory: ${workspace('host-ui-remote').path}`))
    assert.ok(!/connected|healthy/i.test(menu), 'Configuration does not guess live service health')
    await capture(name)
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`document.activeElement===document.querySelector(${JSON.stringify(region(regionId) + ' .agent-region-header__more')})`)
  }
  let unsubscribeSpatial: (() => void) | undefined
  try {
    await stage('prepare-original-production-hosts')
    result.spatialBefore = await spatial.read()
    await stage('runtime-prepare-start')
    const prepared = await runtime.prepare(runtimeConfig)
    await stage('runtime-prepare-complete')
    runtime.commit(prepared)
    await stage('runtime-commit-complete')
    for (const { hostId, client } of runtime.rpcClients()) {
      await stage(`connect-${hostId}-start`)
      await client.connect()
      await stage(`connect-${hostId}-complete`)
    }
    await stage('create-window-start')
    win = new BrowserWindow({ width: 1560, height: 1120, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    runtime.attach(win.webContents)
    unsubscribeSpatial = spatial.subscribe(value => { if (!win.isDestroyed()) win.webContents.send('host-ui:spatial-change', value) })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer:${message.slice(0, 1800)}\n`) })
    await stage('load-window-start')
    await win.loadFile(html)
    result.windowLoaded = true
    await stage('load-window-complete')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await stage('initialize-renderer-start')
    await until('window.hostUiReady && !window.hostUiState().loading')
    await stage('initialize-renderer-complete')
    result.originalProtectedBefore = await observeProtected(remoteClient())
    const localIdentity = JSON.parse(await fs.readFile(path.join(privateRoot, 'local-identity.json'), 'utf8'))
    result.originalLocal = localIdentity
    await until(`window.hostUiNative('host-ui-local-terminal',${JSON.stringify(localIdentity.id)},${JSON.stringify(localIdentity.control.run.runId)})?.liveReady===true`)
    if (phase === 'seed') {
      await stage('actual-launcher-inputs')
      await until('Boolean(window.hostUiState().warm?.session)')
      result.beforeSelection = await state()
      await enter(`${region('host-ui-launcher-a')} [aria-label="Agent prompt"]`, input.prompt)
      await selectRemote('host-ui-launcher-a')
      await until(`(() => {const button=document.querySelector(${JSON.stringify(region('host-ui-launcher-a') + ' [data-executor-id="host-ui-geminicc"]')});return button&&!button.disabled})()`)
      await click(`${region('host-ui-launcher-a')} [data-executor-id="host-ui-geminicc"]`)
      await click(`${region('host-ui-launcher-a')} [aria-label="Launch options"]`)
      await until('Boolean(document.querySelector("[aria-label=\\"Agent name\\"]"))')
      await enter('[aria-label="Agent name"]', 'Host UI QA agent')
      await enter('[aria-label="Tab name"]', 'Host UI QA workbench')
      await select('[aria-label="Effort"]', 'medium')
      await click('[aria-label="Close launch options"]')
      result.afterSelection = await state()
      assert.equal(result.afterSelection.tabs['host-ui-original-tab'].workspaceId, 'host-ui-local', 'Selecting execution does not move the display Tab')
      assert.equal(result.afterSelection.tabs['host-ui-original-tab'].regions['host-ui-launcher-b'].workspaceId, 'host-ui-local', 'The other Launcher retains its independent target')
      assert.equal(result.afterSelection.drafts['host-ui-launcher-a'], input.prompt)
      assert.equal(result.afterSelection.drafts['host-ui-launcher-b'], input.secondDraft)
      assert.equal(result.afterSelection.warm.session.id, result.beforeSelection.warm.session.id, 'The original warm shell is not stopped or replaced by target selection')
      await openTarget('host-ui-launcher-a'); await capture('target-wide')
      await select('[aria-label="Machine for new session"]', 'host-ui-empty')
      await until('document.querySelector(".launcher-target")?.textContent.includes("No project registered")')
      await capture('no-projects')
      assert.equal((await state()).tabs['host-ui-original-tab'].regions['host-ui-launcher-a'].workspaceId, 'host-ui-remote', 'Browsing an empty Host is not a new execution selection')
      await select('[aria-label="Machine for new session"]', input.remoteHostId)
      win.setContentSize(980, 980); await delay(220); await capture('target-narrow')
      await click('[aria-label="Close runtime environment"]')
      win.setContentSize(1560, 1120); await delay(220)
      await click(`${region('host-ui-launcher-a')} [aria-label="Reference files for the Agent"]`)
      await until('Boolean(document.querySelector("[data-reference-path=\\"host-ui-task.txt\\"]"))')
      await capture('remote-file-references')
      await click('[aria-label="Close project file picker"]')
      await win.webContents.executeJavaScript('window.hostUiFlush()')
      result.saved = durable(await state()); result.spatialSaved = await spatial.read()
      assert.ok(result.spatialSaved.graph.tabs.length > 0, 'Actual Core spatial graph is durably nonempty')
      await fs.writeFile(path.join(privateRoot, 'expected-ui.json'), JSON.stringify(result.saved), { mode: 0o600 })
      await fs.writeFile(path.join(privateRoot, 'expected-spatial.json'), JSON.stringify(result.spatialSaved), { mode: 0o600 })
      await capture('workbench')
    } else {
      await stage('second-process-durable-read')
      const saved = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected-ui.json'), 'utf8'))
      assert.deepEqual(result.spatialBefore, JSON.parse(await fs.readFile(path.join(privateRoot, 'expected-spatial.json'), 'utf8')),
        'Second ordinary Electron reads the same complete Core graph from disk')
      result.restored = durable(await state()); assert.deepEqual(result.restored, saved,
        'Original tabs, regions, target choices, prompts, names, options and layout survive a process restart')
      await capture('restored-workbench')
      await stage('actual-launcher-geminicc-button')
      await click(`${region('host-ui-launcher-a')} .launcher-launch-button`)
      await until(`window.hostUiState().tabs['host-ui-original-tab']?.regions['host-ui-launcher-a']?.kind==='agent'`, 35_000)
      await until(`document.querySelector(${JSON.stringify(region('host-ui-launcher-a') + ' [data-execution-host-id="' + input.remoteHostId + '"]')})`)
      result.creationPaint = await state()
      await capture('agent-creation-stage')
      await until(() => Boolean(result.agentLaunch?.created?.agentSessionId), 35_000)
      assert.ok(result.agentLaunch?.created.agentSessionId)
      const sid = result.agentLaunch.created.agentSessionId
      assert.notEqual(sid, originalSessionId)
      const deadline = Date.now() + 140_000
      let proof: any, status: any
      do {
        status = await remoteClient().statusAgent(sid)
        const handle = status.session.nativeHandle
        proof = await inspectFarmOs({ workspacePath: workspace('host-ui-remote').path,
          agent: { sessionId: sid, pid: status.run.pid, ...(handle ? { transcriptPath: handle.transcriptPath } : {}) },
          prompt: input.prompt, token: input.token })
        if (proof.history?.matchedUserTurns > 0 && proof.history?.matchedAssistantReplies > 0 && proof.history?.ownedFileReads > 0) break
        await delay(750)
      } while (Date.now() < deadline)
      result.nativeAgent = { status: { sessionId: sid, nativeHandle: status.session.nativeHandle,
        workspacePath: status.session.workspacePath, runId: status.run.runId, pid: status.run.pid }, proof }
      assert.ok(proof.history?.matchedUserTurns > 0, 'Actual native user turn contains the exact Launcher initial prompt')
      assert.ok(proof.history?.matchedAssistantReplies > 0 && proof.history?.ownedFileReads > 0,
        'Actual GeminiCC reads this owned task file and answers with its marker')
      assert.equal(proof.history.writeToolCalls, 0); assert.equal(proof.history.toolErrors, 0)
      assert.equal(proof.history.cwdFactsMatch, true)
      await until(`window.hostUiNative('host-ui-launcher-a',${JSON.stringify(sid)},${JSON.stringify(status.run.runId)})?.liveReady===true`)
      result.agentDisplay = await state()
      assert.equal(result.agentDisplay.tabs['host-ui-original-tab'].workspaceId, 'host-ui-local')
      assert.equal(result.agentDisplay.drafts['host-ui-launcher-b'], input.secondDraft)
      await capture('remote-agent-local-region')
      await stage('actual-launcher-plain-terminal-button')
      await selectRemote('host-ui-launcher-b')
      const terminalAction = await until(`(() => {const region=document.querySelector(${JSON.stringify(region('host-ui-launcher-b'))});
        for(const label of ['Open Terminal','Open reusable Terminal in tab']) if(region?.querySelector('[aria-label="'+label+'"]'))return label;
        return null})()`)
      result.terminalUiAction = terminalAction
      await click(`${region('host-ui-launcher-b')} [aria-label="${terminalAction}"]`)
      await until(`window.hostUiState().tabs['host-ui-original-tab']?.regions['host-ui-launcher-b']?.kind==='terminal'`)
      await until(() => Boolean(result.terminalLaunch?.session))
      const terminal = result.terminalLaunch.session
      const run = (await remoteClient().listRuns()).find(one => one.runId === terminal.control.run.runId)!
      assert.equal(run.workspacePath, workspace('host-ui-remote').path)
      result.nativeTerminal = { run: { runId: run.runId, pid: run.pid, workspacePath: run.workspacePath, state: run.state },
        proof: await inspectFarmOs({ workspacePath: workspace('host-ui-remote').path, terminal: { pid: run.pid } }) }
      await until(`window.hostUiNative('host-ui-launcher-b',${JSON.stringify(terminal.id)},${JSON.stringify(run.runId)})?.liveReady===true`)
      await capture('mixed-host-regions-wide')
      await inspectHeader('host-ui-launcher-a', input.remoteHostId, 'agent-host-menu-wide')
      win.setContentSize(980, 980); await delay(220); await capture('mixed-host-regions-narrow')
      await inspectHeader('host-ui-launcher-b', input.remoteHostId, 'terminal-host-menu-narrow')
      win.setContentSize(1560, 1120); await delay(220)
      await win.webContents.executeJavaScript(`window.hostUiFocusAgent(${JSON.stringify(sid)}); true`)
      await delay(300); await capture('remote-focus')
      await win.webContents.executeJavaScript('window.hostUiRevealWorkbench(); true')
      result.finalWorkbench = await state()
    }
    result.originalProtectedAfter = await observeProtected(remoteClient())
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    process.stderr.write(`host_ui_probe_failed=${error.message}\n`)
    if (result.windowLoaded && win && !win.isDestroyed()) await capture('failure-workbench').catch(captureError => { result.failurePaintError = String(captureError) })
  } finally {
    result.calls = calls; result.owned = owned
    if (result.windowLoaded && win && !win.isDestroyed()) result.final = await state().catch(() => null)
    unsubscribeSpatial?.()
    const errors: string[] = []
    await files.dispose().catch(error => errors.push(String(error)))
    await runtime.dispose().catch(error => errors.push(String(error)))
    result.consumerCleanup = { errors, sharedRemoteOwnerStopped: false }
    if (errors.length) result.passed = false
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2), { mode: 0o600 })
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
