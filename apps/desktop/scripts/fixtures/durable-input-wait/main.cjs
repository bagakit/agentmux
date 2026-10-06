const { fixtureEpoch: _reshape_fixtureEpoch } = require("../../../../../test/fixture-epoch.cjs")
const { app, BrowserWindow, clipboard } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url'), { spawn } = require('node:child_process')
const [html, owner, preload, cli, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.on('window-all-closed', () => {})
const proof = { passed: false, cases: [], unhandled: [], userRunTouched: false,
 scope: 'Actual registered Electron Main/RuntimeController/preload/Renderer user composer/public RPC/compiled CLI; original Core/Session/journal owners. Runtime event and Provider Native protocol ports controlled. No vendor Runtime claim.' }
process.on('unhandledRejection', error => proof.unhandled.push({ name: error.name, message: error.message, stack: error.stack }))
let win, release, runtime, client, rpc
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const eventual = async (read, check) => {
 for (let i = 0; i < 150; i++) { const value = await read(); if (check(value)) return value; await pause(20) }
 throw new assert.AssertionError({ message: 'Actual original consumer did not produce its expected receipt', actual: await read(), expected: 'Original receipt' })
}
app.whenReady().then(async () => {
 try {
  const product = await import(pathToFileURL(owner).href), sid = 'private-original-agent', runId = 'private-original-run'
  const control = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId } }
  const store = new product.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sid, providerId: 'codex', executorId: 'private', hostId: 'local',
   workspacePath: privateRoot, run: { runId }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token',
   nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-thread' }, nativeBinding: { source: 'process-witness', run: { runId }, observedAt: _reshape_fixtureEpoch(0, 0, 1) },
   capabilityHash: '0123456789abcdef'.repeat(4), createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1) })
  client = new product.AgentMuxClient({ store }); await client.registry.load('local')
  proof.originalCoreEvents = []
  client.onEvent(event => { if (event.type === 'agent-error' || event.type === 'agent-input') proof.originalCoreEvents.push(event) })
  let connected = true, bytes = 0, prepareCount = 0
  client.connected = true; client.connect = async () => { client.connected = true; connected = true }
  const run = () => ({ runId, lifecycleOperationId: null, program: 'controlled-native-port', args: [], workspacePath: privateRoot,
   pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: bytes, nativeService: null })
  const raw = [], dispatches = []
  proof.runtimePortWrites = raw; proof.nativePortDispatches = dispatches
  Object.assign(client.kernel, { isConnected: () => connected, status: async () => run(), list: async () => [run()],
   input: async (_id, operation) => { raw.push(operation.data); const startByte = bytes; bytes += Buffer.byteLength(operation.data); return { run: run(), appliedByteRange: { startByte, endByte: bytes } } },
   identity: () => ({ daemonInstanceId: 'private-original-runtime', protocolVersion: 1, buildIdentity: 'controlled-port' }) })
  const provider = client.providers.get('codex'), plan = { kind: 'native-rpc', protocolId: 'controlled-native-contract', operation: 'start-or-steer',
   sourceId: 'original-source', actorId: 'original-peer', threadId: 'original-thread' }
  provider.prepareNativePromptInput = async () => { prepareCount++; return { plan, assertCurrent: async signal => signal.throwIfAborted(), close: async () => {},
   dispatch: async (body, id) => { dispatches.push({ body, id }); return { outcome: 'admitted', turnId: 'original-turn' } } } }
  const config = { ...structuredClone(product.DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private owner' }],
   workspaces: [{ id: 'private', kind: 'folder', hostId: 'local', name: 'Private proof', path: privateRoot }],
   executors: { private: { providerId: 'codex', label: 'Original Agent', command: process.execPath, args: [], env: {}, injectAgentMuxGuide: false } } }
  runtime = new product.RuntimeController(store, async () => client)
  let preparedOnce = false
  const executionHost = new product.LocalExecutionHost()
  runtime.prepare = async () => {
   const hosts = preparedOnce ? [] : [{ id: 'local', client, executionHost, config: config.hosts[0] }]
   preparedOnce = true
   return { hosts, removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  }
  win = new BrowserWindow({ show: false, width: 960, height: 720, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } })
  const capture = async (name, afterResize) => {
   for (const [suffix, width] of [['wide', 960], ['narrow', 440]]) {
    win.setContentSize(width, 720); await pause(80)
    if (afterResize) await win.webContents.executeJavaScript(`(() => { ${afterResize} })()`)
    await pause(120)
    proof.visualGeometry ??= []
    proof.visualGeometry.push(await win.webContents.executeJavaScript(`(() => {
     const selectors=['.composer-pending__cards','.composer-pending__card[data-selected="true"] pre','.composer-pending__card[data-selected="true"] .composer-pending__send','.composer-pending__card[data-selected="true"] .composer-pending__retry button','.composer-pending__card[data-selected="true"] [aria-label="复制完整诊断"]','.error-notice__details','.error-notice [aria-label="复制完整诊断"]'];
     return {name:${JSON.stringify(name)},suffix:${JSON.stringify(suffix)},width:innerWidth,height:innerHeight,nodes:selectors.map(selector=>{
      const node=document.querySelector(selector);if(!node)return{selector,exists:false};
      const rect=node.getBoundingClientRect(),x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2,hit=document.elementFromPoint(x,y);
      return {selector,exists:true,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,centerHit:hit!==null&&(hit===node||node.contains(hit))}
     })}
    })()`))
    await fs.writeFile(path.join(evidence, name + '-' + suffix + '.png'), (await win.webContents.capturePage()).toPNG())
   }
   win.setContentSize(960, 720); await pause(40)
  }
  const clickVisible = async selector => {
   // Electron delivers native input only to the focused private fixture.
   // This is its original Window, never a user Agent or application Window.
   win.show(); win.focus(); win.webContents.focus(); await pause(80)
   const point = await win.webContents.executeJavaScript(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)});if(!node)return{exists:false};
    const rect=node.getBoundingClientRect(),x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2,hit=document.elementFromPoint(x,y);
    return {exists:true,x,y,disabled:node.disabled===true,hit:hit!==null&&(hit===node||node.contains(hit)),width:innerWidth,height:innerHeight}
   })()`)
   assert.equal(point.exists, true); assert.equal(point.disabled, false); assert.equal(point.hit, true)
   assert.ok(point.x > 0 && point.x < point.width && point.y > 0 && point.y < point.height)
   proof.visibleActions ??= []; proof.visibleActions.push({ selector, ...point })
   win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
   win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
   win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
   await pause(60)
  }
  proof.rendererConsole = []
  win.webContents.on('console-message', (event, ...args) => proof.rendererConsole.push({ level: event.level, message: event.message, sourceId: event.sourceId, args }))
  release = await product.registerIpc({ window: win, runtime, initialConfig: config,
   configStore: new product.ConfigStore(path.join(privateRoot, 'config.json')), scratchTopics: new product.ScratchTopics(),
   progressLoops: { pauseTarget: async () => {}, subscribe: () => () => {} } })
  await win.loadFile(html)
  await win.webContents.executeJavaScript(`waitProof.setup(${JSON.stringify(config)},${JSON.stringify(await runtime.refresh(control, config))})`)
  const endpoint = { transport: 'unix', path: product.desktopBusinessSocketPath() }
  rpc = await product.connectAgentMuxRpc({ endpoint })
  connected = false; client.connected = false
  const originalBody = 'Original composer body 原文\n{"ready":true,"cancelled":true} stays opaque.'
  await win.webContents.executeJavaScript(`waitProof.draft(${JSON.stringify(sid)},${JSON.stringify(originalBody)})`)
  proof.composerInitialDOM = await win.webContents.executeJavaScript('document.body.innerHTML')
  await eventual(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('textarea, [contenteditable="true"]'))`), Boolean)
  await win.webContents.executeJavaScript(`document.querySelector('textarea, [contenteditable="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`)
  const entries = () => win.webContents.executeJavaScript(`waitProof.entries(${JSON.stringify(sid)})`)
  const queued = await eventual(entries, rows => rows.length === 1 && rows[0].inputReceipt?.status === 'waiting')
  const original = queued[0], key = original.inputReceipt.key
  assert.equal(original.text, originalBody); assert.equal(original.inputReceipt.persistence, 'confirmed'); assert.equal(original.archived, undefined)
  assert.equal(original.promptCondition, null); assert.deepEqual(original.directInputBinding, { expectedRun: { runId }, admissionIntent: { kind: 'manual-actor' } })
  assert.deepEqual(original.directInputControl, control); assert.equal(prepareCount, 0); assert.equal(dispatches.length, 0)
  assert.equal((await client.inspectAgentInput({ key })).status, 'waiting')
  proof.cases.push({ name: 'actual-user-composer-firstsave', operationId: original.operationId, receipt: original.inputReceipt })
  await capture('composer-waiting')
  await eventual(() => win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '停止等待')`), Boolean)
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '停止等待').click()`)
  const stopped = (await eventual(entries, rows => rows[0]?.inputReceipt?.status === 'stopped' && rows[0]?.inputStopReceipt))[0]
  assert.equal(stopped.inputStopReceipt.outcome, 'stopped-before-dispatch'); assert.equal(stopped.text, originalBody)
  assert.deepEqual(stopped.inputStopReceipt.ref, original.inputReceipt.ref)
  proof.cases.push({ name: 'actual-composer-stop-Core-gate', receipt: stopped.inputStopReceipt })
  await capture('composer-stopped')
  connected = true; client.connected = true
  client.publisher.publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  await pause(80); assert.equal(dispatches.length, 0, 'Stopped original generation cannot wake')
  let releaseReply
  const replyHeld = new Promise(resolve => { releaseReply = resolve }), originalRejoin = runtime.rejoinInputWaiting
  const originalSendEvent = win.webContents.send, heldTimeline = []
  runtime.rejoinInputWaiting = async function(...args) { const result = await originalRejoin.apply(this, args); await replyHeld; return result }
  win.webContents.send = function(channel, ...args) {
   if (channel === 'agentmux:session-event' && args[0]?.event?.type === 'agent-timeline') { heldTimeline.push({ channel, args }); return }
   return originalSendEvent.call(this, channel, ...args)
  }
  let sending, admitted
  try {
   sending = win.webContents.executeJavaScript(`waitProof.sendStored(${JSON.stringify(sid)},${JSON.stringify(original.operationId)})`)
   admitted = await eventual(() => client.inspectAgentInput({ key }), value => value?.status === 'admitted')
   const middle = await eventual(entries, rows => rows.some(row => row.operationId === original.operationId && row.archived && row.inputReceipt?.status === 'admitted'))
   const pending = await rpc.call('message.pending.ls', { agentSessionId: sid })
   const confirmed = pending.messages.find(row => row.pendingId === original.operationId)
   assert.ok(confirmed); assert.equal(confirmed.archived, true); assert.equal(confirmed.delivery, 'confirmed'); assert.equal(confirmed.phase, null)
   proof.cases.push({ name: 'actual-public-Pending-admitted-event-before-held-IPC-reply', pending: confirmed, renderer: middle,
    scope: 'original Core admitted event; controlled delayed reply and delayed timeline observation, exact original IPC/RPC consumers' })
  } finally {
   releaseReply(); runtime.rejoinInputWaiting = originalRejoin; win.webContents.send = originalSendEvent
   if (sending) assert.equal(await sending, 'unconfirmed')
   for (const value of heldTimeline) originalSendEvent.call(win.webContents, value.channel, ...value.args)
  }
  assert.equal(admitted.ref.waitGeneration, 2)
  await eventual(entries, rows => rows.every(row => row.operationId !== original.operationId || row.inputReceipt?.status === 'admitted'))
  assert.deepEqual(dispatches.map(value => value.id), [original.operationId]); assert.equal(dispatches[0].body, originalBody)
  proof.cases.push({ name: 'actual-composer-explicit-rejoin-generation-two', receipt: admitted, renderer: await entries() })
  await win.webContents.executeJavaScript(`waitProof.raw(${JSON.stringify(control)})`)
  assert.deepEqual(raw, ['original raw bytes']); proof.cases.push({ name: 'original-Raw-API-preserved', scope: 'controlled Runtime input port', raw })
  connected = false; client.connected = false
  const text = 'Original public body with a distinct ID', messageId = 'public-original-message', operationId = 'public-original-control'
  const waiting = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: sid }, text, execution: 'immediate', messageId, operationId })
  assert.equal(waiting.delivery.state, 'queued'); assert.equal(waiting.inputReceipt.status, 'waiting')
  const inspected = await rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: operationId })
  assert.deepEqual(inspected.input.ref, waiting.inputReceipt.ref); assert.equal(inspected.record, null)
  proof.cases.push({ name: 'public-Desktop-endpoint-firstsave-wait', receipt: waiting })
  const stop = await rpc.call('agent.input.stop', { ref: waiting.inputReceipt.ref, cancelOperationId: 'original-public-stop' })
  assert.equal(stop.outcome, 'stopped-before-dispatch'); proof.cases.push({ name: 'public-stop-original-ref', receipt: stop })
  const env = { ...process.env }; delete env.AGENTMUX_AGENT_CAPABILITY; delete env.AGENTMUX_AGENT_SESSION_ID
  const child = spawn(process.env.AGENTMUX_RECEIPT_NODE, [cli, '--endpoint', 'unix:' + endpoint.path, 'agent', 'send', '--to-session', sid,
   '--text', 'Original compiled CLI body', '--execution', 'immediate', '--operation-id', 'cli-original-control', '--message-id', 'cli-original-message'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ originalPid: child.pid, code, signal, closeConfirmed: true })) })
  assert.equal(exit.code, 0); assert.equal(exit.signal, null)
  const cliResult = JSON.parse(stdout).result
  assert.equal(cliResult.delivery.state, 'queued'); assert.equal(cliResult.inputReceipt.status, 'waiting')
  proof.cases.push({ name: 'compiledCLI-firstsave-typedwaiting', exit, stdout, stderr })
  connected = true; client.connected = true
  client.publisher.publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  const cliAdmitted = await eventual(() => client.inspectAgentInput({ key: cliResult.inputReceipt.key }), value => value?.status === 'admitted')
  assert.deepEqual(dispatches.map(value => value.id), [original.operationId, 'cli-original-message'])
  assert.equal((await client.inspectAgentInput({ key: waiting.inputReceipt.key })).status, 'stopped')
  proof.cases.push({ name: 'original-Core-restored-event-dispatches-CLI-once', receipt: cliAdmitted, dispatches })
  // Original IPC handlers and preload transport are real. Only the owning
  // RuntimeController service failure/response-loss ports are controlled.
  const structuredFailure = () => Object.assign(new product.AgentMuxError('Original bounded failure', 'PRIVATE_WAIT_DIAGNOSTIC',
   JSON.stringify({ phase: 'native-peer', errno: 'EACCES', reasons: ['owner', 'mode', 'pair', 'image'] })), {
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }, logId: 'DgN5g3T2pYk7',
    cause: Object.assign(new Error('Original native cause'), { code: 'EACCES', detail: 'Original native detail' }) })
  for (const [method, runtimeMethod] of [['inspect', 'inspectInput'], ['stop', 'stopInputWaiting'], ['rejoin', 'rejoinInputWaiting']]) {
   const originalMethod = runtime[runtimeMethod]
   try {
    runtime[runtimeMethod] = async () => { throw structuredFailure() }
    const result = await win.webContents.executeJavaScript(`waitProof.failure(${JSON.stringify(method)},${JSON.stringify(control)},${JSON.stringify(waiting.inputReceipt.ref)})`)
    assert.equal(result.fulfilled, false); assert.equal(result.error.code, 'PRIVATE_WAIT_DIAGNOSTIC')
    assert.equal(result.error.detail, structuredFailure().detail); assert.deepEqual(result.error.controlFailure, { disposition: 'not_applied', confirmedInputBytes: 0 })
    assert.equal(result.error.logId, 'DgN5g3T2pYk7'); assert.equal(result.error.cause.code, 'EACCES'); assert.equal(result.error.cause.detail, 'Original native detail')
    proof.cases.push({ name: 'registered-IPC-original-' + method + '-failure-DTO', result })
   } finally { runtime[runtimeMethod] = originalMethod }
  }
  const originalPrepare = provider.prepareNativePromptInput
  try {
   provider.prepareNativePromptInput = async context => { context.onPreparationPhase?.('native-peer'); throw structuredFailure() }
   assert.equal(await win.webContents.executeJavaScript(`waitProof.fresh(${JSON.stringify(sid)},'Original Native environment unconfirmed body')`), true)
   const nativeWaiting = (await eventual(entries, rows => rows.some(row => row.text === 'Original Native environment unconfirmed body' && row.inputReceipt?.control.waiting?.phase === 'native-environment'))).find(row => row.text === 'Original Native environment unconfirmed body')
   assert.equal(nativeWaiting.inputReceipt.control.waiting.observation.phase, 'native-peer')
   assert.equal(nativeWaiting.inputReceipt.control.waiting.observation.failure.logId, 'DgN5g3T2pYk7')
   await win.webContents.executeJavaScript(`document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"]').focus()`)
   await eventual(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] .message-delivery-failure'))`), Boolean)
   await win.webContents.executeJavaScript(`document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] .message-delivery-failure__details').open = true`)
   const rendered = await win.webContents.executeJavaScript(`({full:document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] pre').textContent,
    sendDisabled:document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] .composer-pending__send').disabled})`)
   assert.equal(rendered.sendDisabled, false)
   assert.ok(rendered.full.includes('\n原始错误（完整）\nOriginal bounded failure\n'))
   assert.ok(rendered.full.includes('DgN5g3T2pYk7')); assert.ok(rendered.full.includes('native-peer')); assert.ok(rendered.full.includes('EACCES'))
   for (const reason of ['owner', 'mode', 'pair', 'image']) assert.ok(rendered.full.includes(reason))
   const copied = [], originalClipboardWrite = clipboard.writeText
   try {
    clipboard.writeText = value => { copied.push(value) }
    await clickVisible(`.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] [aria-label="复制完整诊断"]`)
    await eventual(async () => copied, values => values.length === 1)
    assert.equal(copied[0], rendered.full)
   } finally { clipboard.writeText = originalClipboardWrite }
   proof.cases.push({ name: 'actual-native-waiting-DTO-GUI-details-copy-and-explicit-Send-available', receipt: nativeWaiting.inputReceipt, rendered, copied,
    scope: 'actual original Core/IPC/Renderer waiting DTO; controlled Native preparation error port and private Electron clipboard write port, no user clipboard mutation' })
   await capture('composer-native-waiting')
   await capture('composer-native-waiting-head', `const card=document.querySelector('.composer-pending__cards'),original=document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] pre');original.scrollTop=0;card.scrollTop+=original.getBoundingClientRect().top-card.getBoundingClientRect().top-8`)
   await win.webContents.executeJavaScript(`document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] pre').scrollTop = 1e9`)
   await capture('composer-native-waiting-tail', `const card=document.querySelector('.composer-pending__cards');card.scrollTop=card.scrollHeight;const original=document.querySelector('.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] pre');original.scrollTop=original.scrollHeight`)
   await capture('composer-native-waiting-actions', `document.querySelector('.composer-pending__cards').scrollTop=0`)
   win.setContentSize(440, 720); await pause(100)
   await win.webContents.executeJavaScript(`document.querySelector('.composer-pending__cards').scrollTop=0`)
   await clickVisible(`.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] .composer-pending__retry button`)
   const accessibleStop = await eventual(() => client.inspectAgentInput({ key: nativeWaiting.inputReceipt.key }), value => value?.status === 'stopped')
   assert.equal(accessibleStop.control.state, 'stopped-before-dispatch')
   proof.cases.push({ name: 'actual-narrow-native-details-return-to-visible-Stop', receipt: accessibleStop, dispatched: dispatches.filter(value => value.id === nativeWaiting.operationId).length })
   assert.equal(dispatches.filter(value => value.id === nativeWaiting.operationId).length, 0)
   provider.prepareNativePromptInput = originalPrepare
   win.setContentSize(960, 720); await pause(100)
   await win.webContents.executeJavaScript(`document.querySelector('.composer-pending__cards').scrollTop=0`)
   await clickVisible(`.composer-pending__card[data-operation-id="${nativeWaiting.operationId}"] .composer-pending__send`)
   const nativeAdmitted = await eventual(() => client.inspectAgentInput({ key: nativeWaiting.inputReceipt.key }), value => value?.status === 'admitted')
   assert.equal(dispatches.filter(value => value.id === nativeWaiting.operationId).length, 1)
   proof.cases.push({ name: 'actual-explicit-Send-rejoins-original-unconfirmed-Native-wait', receipt: nativeAdmitted })
  } finally { provider.prepareNativePromptInput = originalPrepare }
  const nativeCountBeforeQueue = dispatches.length
  connected = false; client.connected = false
  const originalSubmitPrompt = runtime.submitPrompt, beforeLossSend = win.webContents.send, lostAckEvents = []
  let firstsaveLostId
  try {
   win.webContents.send = function(channel, ...args) {
    if (channel === 'agentmux:session-event' && args[0]?.event?.type === 'agent-input' && args[0].event.receipt.key.submissionId === firstsaveLostId) {
     lostAckEvents.push(structuredClone(args[0])); return
    }
    return beforeLossSend.call(this, channel, ...args)
   }
   runtime.submitPrompt = async function(...args) { firstsaveLostId = args[2]; await originalSubmitPrompt.apply(this, args); throw structuredFailure() }
   assert.equal(await win.webContents.executeJavaScript(`waitProof.fresh(${JSON.stringify(sid)},'Original firstsave lost ACK')`), true)
   const lost = (await eventual(entries, rows => rows.some(row => row.text === 'Original firstsave lost ACK' && row.inputIntakeStarted))).find(row => row.text === 'Original firstsave lost ACK')
   await eventual(() => win.webContents.executeJavaScript(`waitProof.pending(${JSON.stringify(sid)})`), value => value.messages.some(row => row.pendingId === lost.operationId && row.delivery === 'unconfirmed'))
   const saved = await eventual(() => client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: sid, expectedRun: control.run, submissionId: lost.operationId } }), value => value !== null)
   assert.equal(saved.persistence, 'confirmed'); assert.equal(saved.status, 'waiting')
   proof.cases.push({ name: 'actual-Main-firstsave-ACK-loss-remains-unknown', key: saved.key,
    pending: await win.webContents.executeJavaScript(`waitProof.pending(${JSON.stringify(sid)})`), observationLoss: lostAckEvents, scope: 'original Main firstsave ACK and its corresponding event delivery port both controlled lost; later exact inspect is real' })
   await eventual(() => win.webContents.executeJavaScript(`waitProof.ownership(${JSON.stringify(sid)})`), value => value.inFlight !== lost.operationId)
   const guiUnknown = await eventual(() => win.webContents.executeJavaScript(`document.querySelector('.composer-pending__card[data-operation-id="${lost.operationId}"] .composer-pending__state').getAttribute('aria-label')`), value => value === '发送结果待核实')
   assert.equal(guiUnknown, '发送结果待核实')
   proof.cases.push({ name: 'actual-GUI-firstsave-ACK-loss-projects-unknown', key: saved.key, inputIntakeStarted: true, renderedLabel: guiUnknown })
   await capture('composer-firstsave-unknown')
  } finally { runtime.submitPrompt = originalSubmitPrompt; win.webContents.send = beforeLossSend }
  const lost = (await entries()).find(row => row.text === 'Original firstsave lost ACK')
  await win.webContents.executeJavaScript(`waitProof.sendStored(${JSON.stringify(sid)},${JSON.stringify(lost.operationId)})`)
  const readLostEntry = async () => (await entries()).find(row => row.operationId === lost.operationId)
  const known = await eventual(readLostEntry, value => value?.inputReceipt?.status === 'waiting')
  const originalStop = runtime.stopInputWaiting, stopCalls = []
  try {
   runtime.stopInputWaiting = async function(...args) { stopCalls.push(structuredClone(args)); await originalStop.apply(this, args); throw structuredFailure() }
   const result = await win.webContents.executeJavaScript(`waitProof.stop(${JSON.stringify(sid)},${JSON.stringify(lost.operationId)}).then(value => ({value}), error => ({error:{name:error.name,code:error.code}}))`)
   assert.equal(result.error.code, 'PRIVATE_WAIT_DIAGNOSTIC')
   const after = await readLostEntry(); assert.equal(after.inputStopIntent.cancelOperationId, stopCalls[0][2]); assert.equal(after.inputStopReceipt, undefined)
   proof.cases.push({ name: 'actual-Main-stop-ACK-loss-keeps-original-action', ref: after.inputStopIntent, result })
  } finally { runtime.stopInputWaiting = originalStop }
  const originalInspect = runtime.inspectInput
  try {
   runtime.stopInputWaiting = async function(...args) { stopCalls.push(structuredClone(args)); return await originalStop.apply(this, args) }
   runtime.inspectInput = async () => { throw structuredFailure() }
   assert.equal(await win.webContents.executeJavaScript(`waitProof.stop(${JSON.stringify(sid)},${JSON.stringify(lost.operationId)})`), true)
   const after = await readLostEntry(); assert.equal(stopCalls[1][2], stopCalls[0][2]); assert.deepEqual(after.inputStopReceipt.ref, known.inputReceipt.ref)
   assert.equal(after.inputStopReceipt.cancelOperationId, stopCalls[0][2]); assert.equal(after.inputStopReceipt.outcome, 'stopped-before-dispatch')
   proof.cases.push({ name: 'actual-Main-stop-retry-same-action-keeps-ACK-before-failed-inspect', originalCalls: stopCalls, receipt: after.inputStopReceipt })
   await capture('composer-stop-confirmed-inspect-unconfirmed')
  } finally { runtime.stopInputWaiting = originalStop; runtime.inspectInput = originalInspect }
  // A late read/event of this original generation cannot revoke its known gate
  // or actual Native ACK. Feed the original receipt objects through the real
  // Renderer event consumer, not through a copied reducer or timestamp guess.
  await win.webContents.executeJavaScript(`waitProof.retainEntry(${JSON.stringify(sid)},${JSON.stringify({ ...original, inputReceipt: admitted, archived: true })})`)
  const sameGenerationWaiting = proof.originalCoreEvents.find(event => event.type === 'agent-input' && event.receipt.key.kind === 'prompt' &&
   event.receipt.key.submissionId === original.operationId && event.receipt.ref.waitGeneration === admitted.ref.waitGeneration && event.receipt.status === 'waiting').receipt
  await win.webContents.executeJavaScript(`waitProof.project(${JSON.stringify(sameGenerationWaiting)})`)
  const afterLate = (await entries()).find(row => row.operationId === original.operationId)
  assert.equal(afterLate.inputReceipt.status, 'admitted'); assert.equal(afterLate.archived, true)
  proof.cases.push({ name: 'Renderer-original-same-generation-late-wait-cannot-regress-admission', earlier: sameGenerationWaiting, receipt: afterLate.inputReceipt })
  for (const conflict of ['gate', 'plan', 'turn', 'outcome']) {
   const observed = structuredClone(admitted)
   if (conflict === 'gate') observed.control.gateId = 'different-gate'
   else if (conflict === 'plan') observed.admission.admission.native.plan.actorId = 'different-actor'
   else if (conflict === 'turn') observed.admission.admission.native.turnId = 'different-turn'
   else { observed.status = 'not-applied'; observed.admission.admission.native.outcome = 'not-applied'; observed.admission.admission.acknowledged = false; observed.admission.admission.notApplied = true }
   await win.webContents.executeJavaScript(`waitProof.project(${JSON.stringify(observed)})`)
   const kept = (await entries()).find(row => row.operationId === original.operationId)
   assert.deepEqual(kept.inputReceipt, admitted)
   const issue = await win.webContents.executeJavaScript('waitProof.issue()')
   assert.equal(issue.observed.code, 'CONTROL_REQUEST_CONFLICT'); assert.equal(issue.context.kind, 'indeterminate'); assert.deepEqual(issue.context.subject, control)
   proof.cases.push({ name: 'Renderer-same-generation-' + conflict + '-conflict-keeps-original-fact', issue, receipt: kept.inputReceipt,
    scope: 'controlled conflicting observation producer; the original Core is not claimed to produce this contradiction' })
  }
  const additionalDiagnostic = structuredClone(admitted)
  additionalDiagnostic.control.at += 1
  additionalDiagnostic.admission.admission.native.errorCode = -32603
  await win.webContents.executeJavaScript(`waitProof.project(${JSON.stringify(additionalDiagnostic)})`)
  assert.deepEqual((await entries()).find(row => row.operationId === original.operationId).inputReceipt, additionalDiagnostic)
  proof.cases.push({ name: 'Renderer-compatible-same-status-additional-diagnostic-observation', receipt: additionalDiagnostic })
  // A normal queue entry remains on its existing exact/default path. The
  // Provider single-phase plan and Runtime byte receipts are bounded machine
  // ports; no Native/manual tag or turn/steer authority is fabricated here.
  connected = true; client.connected = true
  const originalPromptPlan = provider.planPromptInput
  provider.planPromptInput = body => ({ kind: 'single-phase', data: body + '\r' })
  const machineSemantic = async (state, pending) => {
   const current = await store.readMetadata(sid), at = Date.now()
   await store.compareAndSwapMetadata(current, { ...current, updatedAt: Math.max(current.updatedAt, at), semanticStatus: { state, source: 'native-hook', observedAt: at }, pendingInteraction: pending,
    ...(state === 'done' ? { terminalPromptReadiness: { source: 'native-stop', id: 'controlled-completion-' + at, run: control.run, outputCursorBytes: 0, observedAt: at } } : {}) })
   const session = await client.registry.refresh(sid, control.run)
   client.publisher.publish({ type: 'agent-session', session })
   return await runtime.refresh(control, config)
  }
  try {
   const working = await machineSemantic('working')
   await win.webContents.executeJavaScript(`waitProof.projectSession(${JSON.stringify(working)})`)
   const queueBody = 'Original bare Enter queue only'
   await win.webContents.executeJavaScript(`waitProof.draft(${JSON.stringify(sid)},${JSON.stringify(queueBody)})`)
   await pause(30)
   await win.webContents.executeJavaScript(`document.querySelector('textarea, [contenteditable="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
   const queueEntry = (await eventual(entries, rows => rows.some(row => row.text === queueBody))).find(row => row.text === queueBody)
   assert.equal(queueEntry.directInputBinding, undefined); assert.equal(queueEntry.inputIntakeStarted, undefined)
   assert.equal(queueEntry.promptCondition, null); assert.equal(queueEntry.execution, undefined)
   assert.equal(dispatches.length, nativeCountBeforeQueue); assert.equal(raw.includes(queueBody + '\r'), false)
   await machineSemantic('done')
   const exact = await eventual(() => client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: sid, expectedRun: control.run, submissionId: queueEntry.operationId }), value => value?.admission?.acknowledged === true)
   assert.equal(exact.admission.transport, undefined); assert.equal(exact.admission.intent.admissionIntent, undefined)
   assert.equal(raw.filter(body => body === queueBody + '\r').length, 1); assert.equal(dispatches.length, nativeCountBeforeQueue)
   await eventual(entries, rows => rows.every(row => row.operationId !== queueEntry.operationId))
   proof.cases.push({ name: 'actual-bare-Enter-working-queue-drains-original-exact-on-completion', before: queueEntry, receipt: exact, scope: 'controlled Provider single-phase and Runtime byte ports; actual Core original exact/default admission' })
   const pending = { request: { kind: 'permission', id: 'original-pending-request', agentSessionId: sid, title: 'Display has no input authority',
    options: [{ id: 'deny', label: 'Display label', kind: 'reject-once' }], evidence: { source: 'native-hook', observedAt: Date.now(), run: control.run, hookReceiptId: 'controlled-pending-hook' } } }
   const answering = await machineSemantic('waiting', pending)
   await win.webContents.executeJavaScript(`waitProof.projectSession(${JSON.stringify(answering)})`)
   const pendingBody = 'Original bare Enter while answer pending'
   await win.webContents.executeJavaScript(`waitProof.draft(${JSON.stringify(sid)},${JSON.stringify(pendingBody)})`)
   await pause(30)
   await win.webContents.executeJavaScript(`document.querySelector('textarea, [contenteditable="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
   const pendingEntry = (await eventual(entries, rows => rows.some(row => row.text === pendingBody))).find(row => row.text === pendingBody)
   assert.equal(pendingEntry.directInputBinding, undefined); assert.equal(pendingEntry.inputIntakeStarted, undefined); assert.equal(raw.includes(pendingBody + '\r'), false)
   // Only the original cleared request/completion fact resumes ordinary queued
   // work; this experiment does not claim Native pending-response transport.
   await machineSemantic('done')
   const afterPending = await eventual(() => client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: sid, expectedRun: control.run, submissionId: pendingEntry.operationId }), value => value?.admission?.acknowledged === true)
   assert.equal(afterPending.admission.transport, undefined); assert.equal(dispatches.length, nativeCountBeforeQueue); assert.equal(raw.filter(body => body === pendingBody + '\r').length, 1)
   proof.cases.push({ name: 'actual-pending-clear-preserves-normal-queue-intent-and-drain', before: pendingEntry, receipt: afterPending, scope: 'original typed pending/completion Store event port controlled; Native answering not claimed' })
  } finally { provider.planPromptInput = originalPromptPlan }
  connected = false; client.connected = false
  // Stop/read retain the original Host+Session+Run selector after an actual
  // durable Run replacement. This is a controlled Runtime lifecycle port.
  assert.equal(await win.webContents.executeJavaScript(`waitProof.fresh(${JSON.stringify(sid)},'Original old Run waiting body')`), true)
  const oldRunEntry = (await eventual(entries, rows => rows.some(row => row.text === 'Original old Run waiting body' && row.inputReceipt?.status === 'waiting'))).find(row => row.text === 'Original old Run waiting body')
  connected = true; client.connected = true
  let releaseCleanup, cleanupEntered = false
  const cleanupHeld = new Promise(resolve => { releaseCleanup = resolve })
  provider.prepareNativePromptInput = async context => {
   context.onPreparationPhase?.('native-peer'); cleanupEntered = true; await cleanupHeld
   assert.equal(context.signal.aborted, true)
   throw Object.assign(new product.AgentMuxError('Original observer stopped; helper exit is unconfirmed', 'AGENT_NATIVE_INPUT_UNCONFIRMED',
    JSON.stringify({ primary: { name: 'AbortError', code: 'ABORT_ERR' }, cleanup: { name: 'Error', code: 'PRIVATE_HELPER_EXIT_UNKNOWN', detail: structuredFailure().detail } })),
    { logId: 'DgN5g3T2pYk7', cause: structuredFailure().cause })
  }
  assert.equal(await win.webContents.executeJavaScript(`waitProof.fresh(${JSON.stringify(sid)},'Original stopped cleanup body')`), true)
  const cleanupEntry = (await eventual(entries, rows => rows.some(row => row.text === 'Original stopped cleanup body' && row.inputReceipt))).find(row => row.text === 'Original stopped cleanup body')
  await eventual(async () => cleanupEntered, Boolean)
  assert.equal(await win.webContents.executeJavaScript(`waitProof.stop(${JSON.stringify(sid)},${JSON.stringify(cleanupEntry.operationId)})`), true)
  const cleanupStopped = (await entries()).find(row => row.operationId === cleanupEntry.operationId).inputStopReceipt
  assert.equal(cleanupStopped.outcome, 'stopped-before-dispatch')
  const stored = await store.readMetadata(sid), replacementRun = { runId: 'private-replacement-run' }
  await store.compareAndSwapMetadata(stored, { ...stored, run: replacementRun, nativeBinding: undefined, terminalPromptReadiness: undefined })
  client.kernel.status = async id => ({ ...run(), runId: id })
  const projected = await runtime.refresh({ ...control, run: replacementRun }, config)
  await win.webContents.executeJavaScript(`waitProof.projectSession(${JSON.stringify({ ...projected, control: { ...control, run: replacementRun } })})`)
  assert.equal(await win.webContents.executeJavaScript(`waitProof.stop(${JSON.stringify(sid)},${JSON.stringify(oldRunEntry.operationId)})`), true)
  const afterRunStop = (await entries()).find(row => row.operationId === oldRunEntry.operationId)
  assert.deepEqual(afterRunStop.directInputControl, control); assert.equal(afterRunStop.inputStopReceipt.outcome, 'stopped-before-dispatch')
  assert.equal(dispatches.length, nativeCountBeforeQueue)
  proof.cases.push({ name: 'actual-Main-original-key-stop-after-durable-Run-replacement', oldRef: oldRunEntry.inputReceipt.ref, receipt: afterRunStop.inputStopReceipt, newRunDispatches: 0 })
  releaseCleanup()
  const cleanupEvent = await eventual(async () => proof.originalCoreEvents.find(event => event.type === 'agent-error' && event.code === 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED'), Boolean)
  const cleanupIssue = await eventual(() => win.webContents.executeJavaScript('waitProof.issue()'), issue => issue.error?.includes('Original failure:'))
  assert.equal(cleanupIssue.context.subject, undefined)
  assert.ok(cleanupIssue.error.includes(runId)); assert.ok(cleanupIssue.error.includes('DgN5g3T2pYk7'))
  assert.ok(cleanupIssue.error.includes('PRIVATE_HELPER_EXIT_UNKNOWN')); assert.ok(cleanupIssue.error.includes('ABORT_ERR'));
  assert.ok(cleanupIssue.error.includes('Original native cause')); assert.ok(cleanupIssue.error.includes('Original native detail'))
  assert.equal(cleanupEvent.evidence.run.runId, runId); assert.equal(cleanupEvent.failure.logId, 'DgN5g3T2pYk7')
  assert.deepEqual((await entries()).find(row => row.operationId === cleanupEntry.operationId).inputStopReceipt, cleanupStopped)
  assert.equal(dispatches.length, nativeCountBeforeQueue)
  await win.webContents.executeJavaScript(`document.querySelector('.error-notice__details').open = true`)
  const completeNotice = await win.webContents.executeJavaScript(`document.querySelector('.error-notice__original').textContent`)
  assert.equal(completeNotice, cleanupIssue.error)
  const noticeCopies = [], originalClipboardWrite = clipboard.writeText
  try {
   clipboard.writeText = value => noticeCopies.push(value)
   await win.webContents.executeJavaScript(`document.querySelector('.error-notice [aria-label="复制完整诊断"]').click()`)
   await eventual(async () => noticeCopies, values => values.length === 1)
   assert.equal(noticeCopies[0], completeNotice)
   await eventual(() => win.webContents.executeJavaScript(`document.querySelector('.error-notice [aria-label="复制完整诊断"]').textContent.trim()`), value => value === '已复制')
   clipboard.writeText = () => { throw new Error('Private clipboard write unconfirmed') }
   await win.webContents.executeJavaScript(`document.querySelector('.error-notice [aria-label="复制完整诊断"]').click()`)
   await eventual(() => win.webContents.executeJavaScript(`document.querySelector('.error-notice [aria-label="复制完整诊断"]').textContent.trim()`), value => value === '复制失败，请重试')
   assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.error-notice__original').textContent`), completeNotice)
  } finally { clipboard.writeText = originalClipboardWrite }
  await capture('original-Run-cleanup-diagnostic')
  await win.webContents.executeJavaScript(`const details=document.querySelector('.error-notice__details');details.scrollTop=details.scrollHeight`)
  await capture('original-Run-cleanup-diagnostic-tail', `const details=document.querySelector('.error-notice__details');details.scrollTop=details.scrollHeight`)
  provider.prepareNativePromptInput = originalPrepare
  proof.cases.push({ name: 'actual-original-Core-cleanup-event-after-Stop-and-Run-replacement-Notice-full-copy', event: cleanupEvent,
   notice: cleanupIssue, copied: noticeCopies, stopped: cleanupStopped, newRunDispatches: 0,
   scope: 'actual original Core factory-returned-unconfirmed→closed-control failure event→registered Main/IPC→Store→original Notice→clipboard IPC; Native primary+cleanup DTO and private clipboard write success/failure ports controlled, no user clipboard mutation' })
  assert.deepEqual(proof.unhandled, []); proof.passed = true
 } catch (error) {
  proof.failure = { name: error.name, message: error.message, stack: error.stack, actual: error.actual, expected: error.expected }
  try { proof.failedRenderer = await win?.webContents.executeJavaScript(`({entries:waitProof.entries('private-original-agent'),issue:waitProof.issue()})`) }
  catch (inspectionError) { proof.failedRendererInspection = { name: inspectionError.name, message: inspectionError.message } }
 }
 finally {
  proof.cleanup = []
  for (const [owner, dispose] of [['rpc', () => rpc?.dispose()], ['Renderer', () => win?.webContents.executeJavaScript('waitProof.dispose()')],
   ['ipc-registration', () => release?.()], ['runtime', () => runtime?.dispose()], ['private-window', () => win?.destroy()]]) {
   try { await dispose(); proof.cleanup.push({ owner, ok: true }) } catch (error) { proof.cleanup.push({ owner, ok: false, error: { name: error.name, message: error.message, stack: error.stack } }) }
  }
  if (proof.cleanup.some(value => !value.ok) || proof.unhandled.length) { proof.passed = false; proof.failure ??= { name: 'FixtureOwnerUnconfirmed', message: 'An original private owner failed cleanup or produced an unhandled error.' } }
  try { await fs.writeFile(path.join(evidence, 'product.json'), JSON.stringify(proof, null, 2)) }
  catch (error) { proof.passed = false; process.stderr.write(JSON.stringify({ receiptWriteFailure: error.message, proof }) + '\n') }
  app.exit(proof.passed ? 0 : 1)
 }
})
