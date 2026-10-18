import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore, AgentMuxControlServer, connectAgentMuxRpc, type AgentMuxClient } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { AgentMuxHostedRuntimeService } from '../../../../../packages/core/dist/hosted-runtime-service.js'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerConversationReadIpc } from '../../../src/main/conversation-read-ipc'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'
import type { AppConfig } from '../../../src/shared/contracts'
import { sceneRows, appendRow, draft } from './scene.mjs'
import { surfaceRows, surfaceCaptured, exerciseSurfaces } from './surfaces.mjs'
import { exerciseIsolation } from './isolation.mjs'

const [html, privateRoot, phase, preload, evidence, nodeExecutable, scene, mobileExercise, mobilePreload, proofMode] = process.argv.slice(2)
app.on('window-all-closed', () => {})
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.stderr.write('Reading fixture modules loaded\n')
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime/state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const config: AppConfig = { version: 9, hosts: [{ id: 'local', label: 'Private reading proof', kind: 'local' }],
  executors: { codex: { label: 'Controlled native writer', providerId: 'codex', command: nodeExecutable,
    args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: path.join(privateRoot, 'native'), ...(scene === 'surfaces' ? { AGENTMUX_FAKE_PERMISSION_REQUEST: '1' } : {}) }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'reading-workspace', hostId: 'local', name: 'Conversation reading', kind: 'folder', path: path.join(privateRoot, 'workspace') }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let core: AgentMuxClient, win: BrowserWindow, server: AgentMuxControlServer, hosted: AgentMuxHostedRuntimeService, conversationIpc: ReturnType<typeof registerConversationReadIpc>
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
const unsubscribeSpatial = spatial.subscribe(state => { if (win && !win.isDestroyed()) win.webContents.send('reading-proof:spatial', state) })
const runtime = new RuntimeController(store, async (host, owner) => { core = await localRuntimeConnector(host, owner); return core })
const calls: { operation: string; elapsedMs: number }[] = [], copies: string[] = []
const mobileToken = randomUUID(), ownerInstanceId = randomUUID(), authenticated: string[] = []
const result: Record<string, any> = { passed: false, phase, scene, pid: process.pid, samples: [],
  boundary: 'Actual private Electron App/Store/SessionPane/Activity; production preload/read IPC/JSON-RPC/Core. A repository CLI owns a real Run and native record; transcript body is controlled Provider-format input. Native DOM Range is set by the fixture. No vendor-model, physical-device, installation or aesthetic claim.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = async <T>(read: () => T | Promise<T>, description: string, budget = 20000): Promise<T> => {
  const deadline = performance.now() + budget
  do { const observed = await read(); if (observed) return observed; await delay(30) } while (performance.now() < deadline)
  throw new Error(`Reading proof did not settle: ${description}`)
}
const ids = () => fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8').then(JSON.parse)
const append = async (rows: unknown[]) => {
  const original = await ids(), stored = await store.readMetadata(original.sessionId)
  assert.equal(stored?.nativeHandle?.kind, 'provider')
  assert.equal(stored.nativeHandle.sessionId, original.nativeSessionId)
  await fs.appendFile(stored.nativeHandle.transcriptPath!, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}
ipcMain.handle('reading-proof:request', async (event, operation, ...args) => {
  assert.equal(event.sender.id, win.webContents.id, 'Only the private proof renderer owns these operations')
  const started = performance.now()
  try {
    switch (operation) {
      case 'setup': return { config, phase, scene, ids: phase === 'restore' ? await ids() : null }
      case 'spatial-read': return await spatial.read()
      case 'spatial-commit': return await spatial.commit(args[0])
      case 'providers': return await runtime.providerCatalog(args[0])
      case 'snapshot': {
        const snapshot = await runtime.snapshot(config)
        result.lastRuntimeSnapshot = snapshot
        return snapshot
      }
      case 'seed': {
        assert.equal(phase, 'seed'); assert.equal(args[0], scene)
        const { session } = await runtime.launchAgent({ hostId: 'local', executorId: 'codex', workspacePath: config.workspaces[0]!.path }, config)
        const stored = await until(async () => { const value = await store.readMetadata(session.id); return value?.nativeHandle?.kind === 'provider' && value.nativeHandle.transcriptPath ? value : null }, 'original native handle')
        const value = { sessionId: session.id, runId: session.control.run.runId, nativeSessionId: stored.nativeHandle!.sessionId }
        await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(value))
        const seeded = scene === 'surfaces' ? surfaceRows() : sceneRows(scene), preparationStarted = performance.now()
        await append(seeded)
        if (scene === 'surfaces') await store.applyTimelineMutation({ type: 'append', agentSessionId: session.id, item: surfaceCaptured(session.id) })
        // Seeded completed turns are input preparation, not live work during scrolling.
        // Keep every original observation; wait for its exact durable final projection.
        const lastTurn = seeded.findLast((row: any) => row.type === 'event_msg' && row.payload?.type === 'task_complete') as
          { ordinal: number; payload: { turn_id: string } } | undefined
        if (lastTurn) {
          assert.ok(Number.isSafeInteger(lastTurn.ordinal) && typeof lastTurn.payload.turn_id === 'string')
          const turnId = lastTurn.payload.turn_id
          const prepared = await until(async () => {
            const current = await store.readMetadata(session.id), commit = current?.activityCommit
            const scope = current?.nativeTurnEnds, end = scope?.turns[turnId]
            if (current?.run.runId !== value.runId || current.nativeHandle?.kind !== 'provider' || current.nativeHandle.sessionId !== value.nativeSessionId ||
              scope?.run.runId !== value.runId || scope.providerId !== 'codex' || scope.nativeHandle.kind !== 'provider' || scope.nativeHandle.sessionId !== value.nativeSessionId || !end ||
              current.semanticStatus?.source !== 'native-transcript' || current.semanticStatus.nativeTurnId !== turnId || current.semanticStatus.state !== 'done' ||
              !commit?.latestCommitted || commit.latest.id !== JSON.stringify(['activity-state', 'native-transcript', value.runId, end.recordId])) return null
            return { semanticStatus: current.semanticStatus, nativeEnd: end, activity: commit.latest }
          }, 'seeded original native turn and activity committed: ' + turnId, 120000)
          const captured = await store.readCapturedHistory(session.id, { recordId: prepared.activity.id, limit: 1 })
          assert.equal(captured.records.length, 1)
          assert.equal(captured.records[0]!.item.id, prepared.activity.id)
          assert.deepEqual(captured.records[0]!.item.activityState, prepared.activity.activityState)
          result.preparation = { kind: 'native-turn-committed', elapsedMs: performance.now() - preparationStarted,
            original: value, turnId, ordinal: lastTurn.ordinal, ...prepared,
            captured: { stream: captured.stream, sequence: captured.records[0]!.sequence, revision: captured.records[0]!.revision },
            boundary: 'Original input preparation completed before App rendering and the first conversation read. The fixture removed no source records; Provider gap diagnostics retain their original meaning.' }
        } else {
          // The surfaces input has no turn-end protocol fact. In particular its
          // real pending PermissionRequest must not be guessed into a done state.
          result.preparation = { kind: 'records-appended-without-turn-end', elapsedMs: performance.now() - preparationStarted,
            original: value, turnId: null, rows: seeded.length, boundary: 'No seeded native terminal turn; no completion or semantic convergence is claimed.' }
        }
        return value
      }
      case 'attach': return await runtime.attachSession(event.sender.id, args[0], args[1] ?? 0, config)
      case 'detach': return await runtime.detachSession(event.sender.id, args[0])
      case 'replay': return await runtime.readSessionReplay(event.sender.id, args[0], args[1])
      case 'resize': return await runtime.resizeSessionAttachment(event.sender.id, args[0], args[1], args[2])
      case 'terminal-protocol': {
        assert.equal(args[2], 'terminal-protocol', 'Reading has no human terminal input intent')
        return await runtime.write(args[0], args[1], args[2])
      }
      case 'resolve': return await runtime.resolveSession(args[0], config)
      case 'refresh': return await runtime.refresh(args[0], config)
      case 'recover': {
        const original = await ids()
        assert.equal(args[0].agentSessionId, original.sessionId)
        assert.equal(args[0].run.runId, original.runId)
        assert.equal(args[3]?.trigger, 'startup'); assert.equal(args[3]?.input, undefined)
        const recovered = await runtime.recoverSession(args[0], config, args[1], args[2], args[3])
        assert.equal(recovered.kind, 'reattachable', 'A healthy original Run reattaches without a replacement')
        return recovered
      }
      case 'historyPage': return await runtime.sessionHistoryPage(args[0], args[1], config)
      case 'timeline': return await runtime.sessionTimeline(args[0])
      case 'historySource': return await runtime.sessionHistorySource(args[0])
      case 'historySources': return await runtime.sessionHistorySources(args[0])
      case 'historyResource': return await runtime.sessionHistoryResource(args[0], args[1], config)
      case 'readHistory': return await core.readAgentSessionHistory({ ...args[1], hostId: args[0].hostId, agentSessionId: args[0].agentSessionId })
      case 'inputMailbox': return await core.readAgentInputMailbox({ ...args[1], agentSessionId: args[0].agentSessionId })
      case 'copy': copies.push(args[0]); return
      case 'flush': await win.webContents.session.flushStorageData(); return
      default: throw new Error(`Unexpected private reading operation: ${operation}${operation === 'unexpected-control' ? '/' + args[0] : ''}`)
    }
  } finally { calls.push({ operation, elapsedMs: performance.now() - started }) }
})

app.whenReady().then(async () => {
  process.stderr.write('Reading fixture Electron ready\n')
  const read = (expression: string) => win.webContents.executeJavaScript(expression)
  const ready = (expression: string) => until(() => read(expression), expression)
  const shot = async (name: string) => {
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(evidence, `${scene}-${phase}-${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const click = async (expression: string) => {
    const action: Record<string, any> = { expression }
    ;(result.clicks ??= []).push(action)
    try {
      await read(`(() => {
        const node=${expression}; if(!node)throw new Error('Missing original click target');
        const panel=node.closest('.composer-mailbox'), events=[];
        const describe=n=>n instanceof Element?{tag:n.tagName,id:n.id,role:n.getAttribute('role'),control:n.getAttribute('aria-controls')}:null;
        const facts=()=>{
          const r=node.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
          const animations=(panel??node).getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)&&(a.pending||a.playState==='running'||a.playState==='paused'));
          const surface=panel?{open:panel.matches(':popover-open'),state:panel.dataset.state,inert:panel.inert,opacity:Number(getComputedStyle(panel).opacity),rect:panel.getBoundingClientRect().toJSON(),maxWidth:panel.style.maxWidth,maxHeight:panel.style.maxHeight}:null;
          return {target:describe(node),rect:r.toJSON(),x,y,hit:node.contains(document.elementFromPoint(x,y)),
            ready:node.isConnected&&node.checkVisibility()&&!node.matches(':disabled')&&!node.closest('[inert]')&&r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&!animations.length&&(!surface||surface.open&&surface.state==='open'&&!surface.inert&&surface.opacity>=.999),
            surface,animations:animations.map(a=>({state:a.playState,pending:a.pending,time:a.currentTime,end:a.effect.getComputedTiming().endTime})),
            tabs:panel?[...panel.querySelectorAll('[role="tab"]')].map(n=>({id:n.id,selected:n.getAttribute('aria-selected'),control:n.getAttribute('aria-controls')})):[]};
        };
        const observe=event=>{const value={type:event.type,trusted:event.isTrusted,target:describe(event.target),contains:node.contains(event.target),pathIncludesTarget:event.composedPath().includes(node),button:event.button,buttons:event.buttons,x:event.clientX,y:event.clientY};events.push(value);readingProof.mark('native-click-input',value)};
        for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,observe,{capture:true,passive:true});
        window.readingClick={facts,finish(){for(const type of ['mousedown','mouseup','click'])document.removeEventListener(type,observe,true);delete window.readingClick;return {events,after:facts()}}};
      })()`)
      const point = () => until(async () => {
        const before = await read('readingClick.facts()')
        if (!before.ready) return null
        await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const after = await read('readingClick.facts()')
        return after.ready && after.hit && ['x', 'y', 'width', 'height'].every(key => after.rect[key] === before.rect[key]) ? after : null
      }, 'Original click target has a stable native hit')
      action.beforeHover = await point()
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.beforeHover.x, y: action.beforeHover.y })
      action.point = await point()
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
        { type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, x: action.point.x, y: action.point.y })
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    } finally {
      action.receipt = await read('window.readingClick?.finish()').catch(error => { action.observationError = String(error); return null })
    }
    assert.ok(action.receipt, 'The original native click observation is retained')
    assert.deepEqual(action.receipt.events.map((event: any) => event.type), ['mousedown', 'mouseup', 'click'])
    assert.ok(action.receipt.events.every((event: any) => event.trusted && event.contains && event.pathIncludesTarget && event.button === 0),
      'One complete trusted native click reaches the exact original target')
  }
  const selectOriginal = () => read(`(() => {
      const feed=document.querySelector('.activity-feed'), bounds=feed.getBoundingClientRect();
      let body,text,range;
      for(const candidateBody of feed.querySelectorAll('.log-turn__body')){
        const bodyRect=candidateBody.getBoundingClientRect();if(bodyRect.bottom<=bounds.top||bodyRect.top>=bounds.bottom)continue;
        const walker=document.createTreeWalker(candidateBody,NodeFilter.SHOW_TEXT);
        while(text=walker.nextNode()){for(let start=0;start<=text.textContent.length-12;start++){
          const candidate=document.createRange();candidate.setStart(text,start);candidate.setEnd(text,start+12);
          const r=candidate.getBoundingClientRect();if(r.top>=bounds.top&&r.bottom<=bounds.bottom){range=candidate;body=candidateBody;break}
        }if(range)break}if(range)break;
      }
      if(!range)throw new Error('No visible original text range');
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      window.readingSelectedNode=text;window.readingSelectedBody=body;window.readingSelectedTop=body.getBoundingClientRect().top;
      return {text:selection.toString(),top:window.readingSelectedTop,source:body.closest('[data-message-source-key]')?.dataset.messageSourceKey}; })()`)
  const sample = async (name: string) => result.samples.push({ name, ...await read('({ui:readingProof.inspect(),reads:readingProof.reads.length,metrics:structuredClone(readingProof.metrics)})') })
  const runMobileOnce = async () => {
    if (scene === 'surfaces' || !mobileExercise || !result.mobileSetup || result.mobileAttempted) return
    result.mobileAttempted = true
    const { runMobile } = await import(pathToFileURL(mobileExercise).href)
    result.mobile = await runMobile({ BrowserWindow, setup: { mobile: result.mobileSetup }, evidence, scene, phase, preload: mobilePreload,
      appendDuringSelection: async () => {
        const row = appendRow(scene, `mobile-${phase}`)
        await append([row])
        return { recordId: row.payload.id }
      } })
  }
  try {
    process.stderr.write('Reading fixture preparing original Runtime\n')
    runtime.commit(await runtime.prepare(config))
    process.stderr.write('Reading fixture original Runtime prepared\n')
    const runtimeIdentityFile = path.join(privateRoot, 'host-runtime-id')
    if (phase === 'seed') await fs.writeFile(runtimeIdentityFile, randomUUID(), { flag: 'wx' })
    const runtimeId = await fs.readFile(runtimeIdentityFile, 'utf8')
    const mobilePortFile = path.join(privateRoot, 'mobile-port')
    const mobilePort = phase === 'seed' ? 0 : Number(await fs.readFile(mobilePortFile, 'utf8'))
    hosted = new AgentMuxHostedRuntimeService(core, null, () => ({ runtimeId, ownerInstanceId, protocolVersion: 2,
      processId: process.pid, availability: 'connected', ctxmux: core.runtimeIdentity() }))
    server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: core }], socketPath: path.join(privateRoot, 'reading.sock'),
      hostedRuntime: () => hosted, operationSource: context => context.principal?.id === 'reading-mobile-device'
        ? { hostId: 'local', deviceId: 'reading-mobile-device', name: 'Private Mobile reading' } : undefined,
      http: { host: '127.0.0.1', port: mobilePort, authorize(request) {
        if (request.headers.get('authorization') !== 'Bearer ' + mobileToken) return null
        authenticated.push('reading-mobile-device')
        return { principal: { kind: 'device', id: 'reading-mobile-device' }, assertCurrent() {
          assert.equal(request.headers.get('authorization'), 'Bearer ' + mobileToken)
        } }
      }, async route(request) {
        const url = new URL(request.url)
        if (request.method !== 'GET' || !url.pathname.startsWith('/mobile/')) return null
        const base = path.join(path.dirname(html), 'mobile'), file = path.resolve(base, decodeURIComponent(url.pathname.slice('/mobile/'.length)))
        if (!file.startsWith(base + path.sep)) return new Response('Unknown private asset', { status: 404 })
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'
        return new Response(await fs.readFile(file), { headers: { 'Content-Type': type } })
      } } })
    await server.start()
    if (phase === 'seed') await fs.writeFile(mobilePortFile, String(server.httpAddress!.port), { flag: 'wx' })
    conversationIpc = registerConversationReadIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener),
      trust: (_channel, event) => assert.equal(event.sender.id, win.webContents.id),
      connect: () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }) })
    win = new BrowserWindow({ width: 1280, height: 940, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    runtime.attach(win.webContents)
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until(() => read('window.readingProof?.inspect().rows.length > 0 && readingProof.reads.length > 0'),
      'original App records after durable input preparation', phase === 'seed' ? 140000 : 20000)
    result.ids = await ids()
    result.mobileSetup = { url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: mobileToken, agentSessionId: result.ids.sessionId, runtimeId }
    result.initialState = await read('readingProof.state()')
    assert.equal(result.initialState.drafts[result.ids.sessionId], draft)
    assert.equal(result.initialState.tabs['reading-tab'].regions['reading-region'].sessionId, result.ids.sessionId)
    if (phase === 'restore') {
      assert.deepEqual(result.initialState, JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8')), 'Original durable workface and unsent draft survive a separate Electron process')
      assert.equal(calls.filter(call => call.operation === 'seed').length, 0, 'Restart never reseeds the original workface')
    }
    await sample('first-readable'); await shot('current')
    if (scene === 'surfaces') result.surfaces = await exerciseSurfaces({ read, click, shot, until, copies,
      resize: async (width: number) => { win.setContentSize(width, win.getContentSize()[1]); await ready(`innerWidth === ${width}`) } })
    else {
    for (let n = 0; n < 8; n++) {
      const point = await read('(() => { const r=document.querySelector(".activity-feed").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -620 })
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await sample(`wheel-${n}`)
    }
    result.afterRapidWheel = await read('readingProof.inspect()')
    result.inflightSelection = { before: await selectOriginal() }
    await read('readingProof.mark("inflight-selection")')
    await read('new Promise(resolve => {let frames=0;function next(){readingProof.mark("selected-frame");if(++frames===18)resolve(true);else requestAnimationFrame(next)}requestAnimationFrame(next)})')
    result.inflightSelection.after = await read('({text:getSelection().toString(),sameNode:readingSelectedNode.isConnected,sameBody:readingSelectedBody.isConnected,top:readingSelectedBody.getBoundingClientRect().top})')
    result.inflightSelection.passed = result.inflightSelection.after.text === result.inflightSelection.before.text && result.inflightSelection.after.sameNode && Math.abs(result.inflightSelection.after.top-result.inflightSelection.before.top)<=2
    await read('getSelection().removeAllRanges();readingProof.mark("inflight-selection-cleared")')
    await read(`new Promise((resolve,reject) => {
      let previous='',stable=0,frames=0;
      function check(){const feed=document.querySelector('.activity-feed');
        const value=JSON.stringify([feed.scrollTop,feed.scrollHeight,readingProof.reads.length]);
        stable=value===previous&&!feed.querySelector('[aria-busy="true"]')?stable+1:0;previous=value;
        if(stable>=12)return resolve(true);if(++frames>600)return reject(new Error('Reading viewport did not settle'));
        requestAnimationFrame(check)}requestAnimationFrame(check);
    })`)
    await sample('settled-earlier')
    await shot('earlier')
    await read('readingProof.holdEarlier()')
    await read(`document.querySelector('.activity-feed__reading-action[title="Read earlier conversation and process records in the original sequence"]').scrollIntoView({block:'nearest'})`)
    const earlierPoint = await read('(() => { const r=document.querySelector(".activity-feed").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...earlierPoint, deltaX: 0, deltaY: -620 })
    await ready('readingProof.heldEarlier()')
    result.delayedPageSelection = { before: await selectOriginal() }
    await read('readingProof.releaseEarlier()')
    result.delayedPageSelection.disposition = await ready('readingProof.releasedEarlier()')
    await read('new Promise(resolve => {let n=0;function next(){readingProof.mark("delayed-page-frame");if(++n===18)resolve(true);else requestAnimationFrame(next)}requestAnimationFrame(next)})')
    result.delayedPageSelection.after = await read('({text:getSelection().toString(),sameNode:readingSelectedNode.isConnected,top:readingSelectedBody.getBoundingClientRect().top})')
    result.delayedPageSelection.passed = result.delayedPageSelection.before.text === result.delayedPageSelection.after.text && result.delayedPageSelection.after.sameNode && Math.abs(result.delayedPageSelection.before.top-result.delayedPageSelection.after.top)<=2
    await read('getSelection().removeAllRanges()')
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    result.selected = await selectOriginal()
    const appended = appendRow(scene, `desktop-${phase}`)
    const appendedMounts = () => read(`readingProof.metrics.heavyMounts.filter(mount=>JSON.parse(mount.source).at(-1)===${JSON.stringify(appended.payload.id)}).length`)
    result.appendCost = { recordId: appended.payload.id, before: await appendedMounts() }
    const beforeAppend = await read('readingProof.nativeCut()')
    assert.ok(beforeAppend, 'The original native frontier is observed before appending')
    await append([appended])
    result.appendDisposition = await ready(`readingProof.appendDisposition(${JSON.stringify(beforeAppend)},${JSON.stringify(appended.payload.id)})`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    result.afterAppend = await read('({text:getSelection().toString(),sameNode:readingSelectedNode.isConnected,sameBody:readingSelectedBody.isConnected,top:readingSelectedBody.getBoundingClientRect().top})')
    result.appendCost.after = await appendedMounts()
    assert.equal(result.afterAppend.text, result.selected.text, 'The original selected text survives appends')
    assert.equal(result.afterAppend.sameNode, true); assert.equal(result.afterAppend.sameBody, true)
    assert.ok(Math.abs(result.afterAppend.top - result.selected.top) <= 2, 'The selected original anchor remains in place')
    await shot('selected'); await sample('selected-append')
    await read(`readingSelectedBody.closest('.log-turn').querySelector('[aria-label="Copy message"]').scrollIntoView({block:'center'})`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await click(`readingSelectedBody.closest('.log-turn').querySelector('[aria-label="Copy message"]')`)
    await until(() => copies.length > 0, 'Copy returns its original full text')
    const original = sceneRows(scene).find(row => row.payload?.id === JSON.parse(result.selected.source).at(-1))
    assert.ok(original, 'The selected copy target is an exact original fixture record')
    assert.equal(copies.at(-1), original.payload.content.map((part: any) => part.text).join('\n'))
    await read('getSelection().removeAllRanges()')
    if (proofMode === 'cost') {
      result.appendCost.disposition = await ready(`readingProof.appendDisposition(${JSON.stringify(beforeAppend)},${JSON.stringify(appended.payload.id)},false)`)
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      result.appendCost.after = await appendedMounts()
    }
    if (await read('!!document.querySelector(".activity-feed__jump")')) {
      await click('document.querySelector(".activity-feed__jump")')
      await ready('document.querySelector("[data-conversation-reading]")?.dataset.conversationReading === "current"')
      await sample('return-current')
    }
    }
    result.readingMetrics = await read('structuredClone(readingProof.metrics)')
    if (scene !== 'surfaces' && proofMode === 'acceptance') result.isolation = await exerciseIsolation({ runtime, core, store, config, privateRoot,
      phase, read, click, until, appendRow, scene, original: result.ids })
    win.setContentSize(820, 760)
    await ready('innerWidth === 820'); await shot('narrow')
    win.setContentSize(1280, 912)
    await ready('innerWidth === 1280')
    await read('readingProof.flush()')
    result.finalState = await read('readingProof.state()')
    assert.deepEqual(result.finalState, result.initialState)
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.finalState))
    result.reads = await read('readingProof.reads')
    assert.ok(result.reads.every((entry: any) => entry.input.agentSessionId === result.ids.sessionId), 'Every reading demand keeps the exact original Session')
    assert.equal(calls.filter(call => call.operation === 'unexpected-control').length, 0)
    await runMobileOnce()
    const running = (await core.listRuns()).filter(run => run.state === 'running').map(run => ({ runId: run.runId, pid: run.pid }))
    result.runs = running.filter(run => run.runId === result.ids.runId)
    result.unrelatedRuns = running.filter(run => run.runId === result.isolation?.unrelated.runId)
    assert.deepEqual(result.runs.map((run: any) => run.runId), [result.ids.runId])
    assert.equal(running.length, 1 + (result.isolation ? 1 : 0), 'Only the exact original and explicitly controlled unrelated Run exist')
    if (scene !== 'surfaces') assert.equal(result.inflightSelection.passed, true, 'The selected original anchor survives any in-flight earlier page')
    if (scene !== 'surfaces') assert.equal(result.delayedPageSelection.passed, true, 'An actual delayed earlier page cannot move the selected original record')
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.details ? { details: error.details } : {}) }
    await runMobileOnce().catch(error => { result.mobileFailure = { name: error.name, message: error.message } })
    if (win && !win.isDestroyed()) {
      result.atFailure = await read('({state:window.readingProof?.state(),ui:window.readingProof?.inspect(),errors:window.readingProof?.errors,body:document.body.innerText.slice(0,5000)})').catch(() => null)
      await shot('failure').catch(() => {})
    }
  } finally {
    if (win && !win.isDestroyed()) {
      result.events = await read('readingProof.events').catch(() => [])
      result.inputHistoryReads = await read('readingProof.inputHistoryReads').catch(() => [])
    }
    await fs.writeFile(path.join(evidence, `${scene}-${phase}.json`), JSON.stringify({ ...result, passed: false, stage: 'cleanup' }, null, 2))
    result.calls = calls; result.copies = copies; result.mobileAuthenticatedRequests = authenticated.length
    // Credentials belong only to this private process; the result retains identity, not access.
    if (result.mobileSetup) delete result.mobileSetup.token
    if (win && !win.isDestroyed()) win.destroy()
    await conversationIpc?.dispose(); await server?.stop()
    await hosted?.dispose(); unsubscribeSpatial()
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(evidence, `${scene}-${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
