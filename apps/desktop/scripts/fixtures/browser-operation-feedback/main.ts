import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, webContents, screen } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store.js'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal.js'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session.js'
import { captureBrowserPageSnapshot } from '../../../src/main/browser-page-snapshot.js'
import { discoverBrowserFrameDocuments } from '../../../src/main/browser-frame-documents.js'
import { parseBrowserSnapshotQuery } from '../../../src/main/browser-snapshot-query.js'
import { runMotionProbe } from './motion.js'
import { withFeedbackFramePaint, feedbackPaintPreparation } from './frame-state.mjs'

const probeRoot = process.env.AGENTMUX_FEEDBACK_PROBE_ROOT!, out = process.env.AGENTMUX_FEEDBACK_OUT!
const phase = process.env.AGENTMUX_FEEDBACK_PHASE!, phaseFile = process.env.AGENTMUX_FEEDBACK_PHASE_FILE!
const retainedFile = process.env.AGENTMUX_FEEDBACK_RETAINED!, url = process.env.AGENTMUX_FEEDBACK_URL!
const nativeScope = process.env.AGENTMUX_FEEDBACK_NATIVE_SCOPE ?? 'full'
assert.ok(['full', 'motion'].includes(nativeScope), 'An explicit supported Native scope is required')
assert.ok(probeRoot.startsWith('/tmp/amx-feedback-native-'), 'Only an owned private root is allowed')
app.setPath('userData', join(probeRoot, 'userdata'))
app.commandLine.appendSwitch('site-per-process')
app.commandLine.appendSwitch('no-proxy-server')
// Chromium's real preference override stays with this private process, not a detached CDP session.
// https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7587.5/ui/gfx/switches.cc
if (phase === 'second') app.commandLine.appendSwitch('force-prefers-reduced-motion')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const receipt: any = { schema: 'agentmux.browser-feedback-private-process.v1', phase, pid: process.pid, versions: process.versions,
  author: '/root/browser_surfaces', actualExecutor: process.env.AGENTMUX_FEEDBACK_ACTUAL_EXECUTOR ?? '/root', passed: false, cases: [], visual: { captureOnly: true, aestheticReview: 'not-performed', nativePages: [], osWindows: [] },
  desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested' }
let manager: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined, window: BrowserWindow | undefined
const id = 'private-original-feedback-page'
const operator = { id: 'private-native-operator', name: 'Private operator' }
const actualChildSessions = new Map<string, any>()
// Read-only serialization of the actual closed shadow in its owning world. No geometry is assigned.
let stateExpression = `(()=>{const s=globalThis.__agentMuxBrowserOperationFeedback;if(!s)return null;const read=selector=>{const el=s.shadow?.querySelector(selector);if(!el)return null;const c=getComputedStyle(el),r=el.getBoundingClientRect();const animations=el.getAnimations().map(a=>({currentTime:a.currentTime,playState:a.playState,duration:a.effect?.getComputedTiming().duration,keyframes:a.effect?.getKeyframes().map(k=>({offset:k.computedOffset,transform:k.transform}))}));return {text:el.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},pointerEvents:c.pointerEvents,animationName:c.animationName,transitionDuration:c.transitionDuration,opacity:c.opacity,fill:c.fill,animations}};return {revision:s.revision,operationId:s.operationId,navigationId:s.navigationId,token:s.token,phase:s.phase,kind:s.kind,clearReason:s.clearReason,point:s.point,history:s.history,expiresAt:s.expiresAt,hostConnected:!!s.host?.isConnected,hostPointerEvents:s.host?getComputedStyle(s.host).pointerEvents:null,pointer:read('.pointer'),arrow:read('.pointer svg'),executor:read('.executor'),glow:read('.glow'),label:read('.label'),viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},now:Date.now(),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches}})()`
const pageState = (contents: Electron.WebContents) => contents.executeJavaScriptInIsolatedWorld(1209, [{ code: stateExpression }])
async function waitFor(label: string, read: () => Promise<any>, budget = 6000) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(20) }
  throw new Error(`Actual private probe timed out: ${label}`)
}
async function nativePage(contents: Electron.WebContents, label: string) {
  const startedAt = Date.now()
  // Electron's presentation observer sees the actual compositor, even when a parallel window occludes this private page.
  let capture: Electron.NativeImage | undefined, presentation: any, image: Electron.NativeImage | undefined
  const frames: any[] = []
  contents.beginFrameSubscription(false, (frame, dirtyRect) => {
    image = frame; presentation = { at: Date.now(), dirtyRect, size: frame.getSize() }; frames.push(presentation)
  })
  try {
    capture = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    // Keep the newest real frame, not the first cached frame delivered when subscription begins.
    await pause(120)
    if (!image) await waitFor('actual native presentation', async () => image, 350)
  } finally { contents.endFrameSubscription() }
  const bytes = image!.toPNG(), path = join(out, `${phase}-${label}-native.png`)
  assert.ok(bytes.length > 8); await writeFile(path, bytes)
  const row = { phase, label, path, sha256: digest(bytes), size: image!.getSize(), webContentsId: contents.id, source: 'original-webcontents-native-page',
    captureMethod: 'actual-beginFrameSubscription-full-presentation', capturePageRequest: { stayHidden: true, stayAwake: true, actualBytes: capture!.toPNG().length },
    presentation, observedPresentationFrames: frames, startedAt, returnedAt: Date.now() }
  receipt.visual.nativePages.push(row); return row
}
async function osWindow(label: string) {
  try {
  const call = async (args: string[]) => {
    let stdout: string
    try { ({ stdout } = await exec('/usr/local/bin/orca', ['computer', ...args, '--json'], { timeout: 15000, maxBuffer: 12 * 1024 * 1024 })) }
    catch (error: any) {
      const rawPath = join(out, `${phase}-${label}-os-failure.json`)
      await writeFile(rawPath, JSON.stringify({ args, pid: process.pid, code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr, message: error.message }))
      receipt.visual.osFailures ??= []; receipt.visual.osFailures.push({ label, path: rawPath, code: error.code, message: error.message })
      throw error
    }
    const value = JSON.parse(stdout); assert.equal(value.ok, true, stdout); return value
  }
  const listed = await call(['list-windows', '--app', `pid:${process.pid}`])
  assert.equal(listed.result.app.pid, process.pid); assert.equal(listed.result.windows.length, 1)
  const selected = listed.result.windows[0]; assert.equal(selected.app.pid, process.pid); assert.ok(selected.id > 0)
  assert.equal(selected.isMinimized, false); assert.equal(selected.isOffscreen, false)
  const captured = await call(['get-app-state', '--app', `pid:${process.pid}`, '--window-id', String(selected.id)])
  assert.equal(captured.result.snapshot.app.pid, process.pid); assert.equal(captured.result.snapshot.window.id, selected.id)
  assert.equal(captured.result.screenshotStatus.state, 'captured')
  const shot = captured.result.screenshot, bytes = shot.path ? await readFile(shot.path) : Buffer.from(shot.data, 'base64')
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const path = join(out, `${phase}-${label}-os.png`), metadata = join(out, `${phase}-${label}-os.json`)
  await writeFile(path, bytes)
  await writeFile(metadata, JSON.stringify({ listed, captured: { ...captured, result: { ...captured.result, screenshot: { ...shot, data: undefined } } } }))
  const metadataBytes = await readFile(metadata)
  receipt.visual.osWindows.push({ phase, label, path, metadata, metadataSha256: digest(metadataBytes), metadataBytes: metadataBytes.length, pid: process.pid, windowId: selected.id, sha256: digest(bytes), source: 'actual-exact-pid-os-window' })
  } catch (error: any) {
    // An unavailable OS observation service cannot prevent the original healthy Browser from completing its remaining cases.
    receipt.visual.osObservationIncomplete = true
    receipt.visual.osObservationNotice = 'OS capture failed. Original native page and further product checks continue; this receipt remains RED.'
  }
}
async function inspectTarget(contents: Electron.WebContents, target: any, evidence: any, requireCue = true) {
  const session = BrowserCdpSession.attach(contents)
  try {
    await session.sendCommand('Page.enable')
    const navigationId = (await manager!.create(id, url)).navigationId
    assert.equal(navigationId, target.issuedNavigationId, 'The original issued node belongs to the current navigation')
    const discovery = await discoverBrowserFrameDocuments(session.sendCommand, session.frames)
    const document = discovery.documents.find(d => d.frameId === target.frameId)
    assert.ok(document, 'Reacquire the actual document sender, never reuse an old CDP session ID')
    const send = document.sendCommand
    const world: any = await send('Page.createIsolatedWorld', { frameId: document.frameId, worldName: 'agentmux-browser-operation-feedback' })
    const state: any = await send('Runtime.evaluate', { contextId: world.executionContextId, expression: stateExpression, returnByValue: true })
    assert.equal(state.exceptionDetails, undefined)
    const resolved: any = await send('DOM.resolveNode', { backendNodeId: target.backendNodeId, executionContextId: world.executionContextId })
    const rect: any = await send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
      functionDeclaration: 'function(){const r=this.getBoundingClientRect();return {left:Math.max(0,r.left),top:Math.max(0,r.top),right:Math.min(innerWidth,r.right),bottom:Math.min(innerHeight,r.bottom),innerWidth,innerHeight}}', returnByValue: true })
    await send('Runtime.releaseObject', { objectId: resolved.object.objectId })
    const hud = state.result?.value, geometry = rect.result?.value
    // Same-process frames share a sender, but never share their default execution context.
    const defaultContexts = new Map<string, number>()
    const stopContexts = session.observe((method, parameters: any) => {
      if (method === 'Runtime.executionContextCreated' && parameters.context?.auxData?.isDefault === true)
        defaultContexts.set(parameters.context.auxData.frameId, parameters.context.id)
    })
    try { await send('Runtime.enable') } finally { stopContexts() }
    const actualContextId = defaultContexts.get(document.frameId!)
    assert.ok(actualContextId, 'Actual Runtime default context belongs to the discovered target frame')
    const pageFacts: any = await send('Runtime.evaluate', { contextId: actualContextId,
      expression: '({events:globalThis.fixtureEvents,hidden:document.hidden,visibility:document.visibilityState,scrollX,scrollY,width:innerWidth,height:innerHeight,at:Date.now()})', returnByValue: true })
    assert.equal(pageFacts.exceptionDetails, undefined)
    evidence.target = { hud, geometry, document: { frameId: document.frameId, loaderId: document.loaderId, sessionId: document.sessionId },
      actualDocumentFacts: { ...pageFacts.result?.value, defaultContextId: actualContextId, actualFrameId: document.frameId }, feedbackContextId: world.executionContextId, observedAt: Date.now() }
    const mainFrameId = discovery.documents.find(d => d.depth === 0)!.frameId
    const leafScope = document.frameId === mainFrameId
    const snapshot = await captureBrowserPageSnapshot({ send: leafScope ? send : session.sendCommand,
      frames: leafScope ? new Map() : session.frames, ...(leafScope ? { query: parseBrowserSnapshotQuery({ within: 'html' }) } : {}),
      url: contents.getURL(), title: contents.getTitle(), navigationId })
    assert.ok(snapshot.nodes.length > 0, 'Actual source capture returns real controls')
    const node = snapshot.nodes.find(n => n.backendNodeId === target.backendNodeId && n.frameId === target.frameId && (!target.name || n.name === target.name))
    assert.ok(node, 'The actual capture still contains the issued original target')
    const afterAx: any = await send('Runtime.evaluate', { contextId: world.executionContextId, expression: stateExpression, returnByValue: true })
    evidence.target.node = { ...node, ...(document.sessionId ? { sessionId: document.sessionId } : {}) }; evidence.target.mainFrameId = mainFrameId
    evidence.target.axHudBefore = hud; evidence.target.axHudAfter = afterAx.result?.value
    evidence.target.actualSourceSnapshotNodes = snapshot.nodes.length
    if (requireCue) assert.ok(hud?.hostConnected && afterAx.result?.value?.hostConnected, 'AX decoration exclusion is observed while the real HUD exists, not after an empty expiry')
    const decorativeRefs = requireCue ? snapshot.nodes.filter(n => n.name === hud?.label?.text) : null
    if (requireCue) assert.equal(decorativeRefs!.length, 0, 'Display-only HUD must not produce actionable AX refs')
    evidence.target.decorativeRefs = decorativeRefs
    evidence.target.axDecorationProof = requireCue ? 'actual-present-HUD-excluded' : 'not-tested-absent-HUD-history-observation'
    return { node: { ...node, ...(document.sessionId ? { sessionId: document.sessionId } : {}) }, hud: afterAx.result.value, geometry, mainFrameId,
      document: { frameId: document.frameId, loaderId: document.loaderId, sessionId: document.sessionId },
      axHudBefore: hud, axHudAfter: afterAx.result.value,
      scopeFacts: snapshot.scopeFacts,
      actualDocumentFacts: { ...pageFacts.result?.value, defaultContextId: actualContextId, actualFrameId: document.frameId }, feedbackContextId: world.executionContextId, requireCue, actualSourceSnapshotNodes: snapshot.nodes.length, missingFrames: snapshot.missingFrames ?? [], decorativeRefs }
  } finally { session.detach() }
}
async function clearedChild(contents: Electron.WebContents, original: any, label: string, originalManagerOwnsDebugger = false) {
  const session = originalManagerOwnsDebugger ? { sendCommand: contents.debugger.sendCommand.bind(contents.debugger), frames: new Map(actualChildSessions), detach: () => {} } : BrowserCdpSession.attach(contents)
  try {
    await session.sendCommand('Page.enable')
    const discovery = await discoverBrowserFrameDocuments(session.sendCommand, session.frames)
    const actual = discovery.documents.find(d => d.frameId === original.target.node.frameId)
    assert.ok(actual, 'The actual original child document must still exist for this clear counterexample')
    const world: any = await actual.sendCommand('Page.createIsolatedWorld', { frameId: actual.frameId, worldName: 'agentmux-browser-operation-feedback' })
    let response: any
    const readings: any[] = []
    const beforeExpiry = Math.max(1, Math.min(600, original.target.hud.expiresAt - Date.now() - 5))
    await waitFor('actual previous child clear before its real expiry', async () => {
      response = await actual.sendCommand('Runtime.evaluate', { contextId: world.executionContextId, expression: stateExpression, returnByValue: true })
      readings.push(response.result?.value)
      const value = response.result?.value
      return value && !value.hostConnected && !value.point && value.phase === 'clear'
    }, beforeExpiry)
    assert.equal(response.exceptionDetails, undefined)
    const hud = response.result?.value
    const evidence = { label, originalChildFrameId: original.target.node.frameId, actualFrame: { frameId: actual.frameId, loaderId: actual.loaderId, sessionId: actual.sessionId },
      originalManagerOwnsDebugger, readings, oldOperationId: original.actualReport.runOperation.id, oldExpiresAt: original.target.hud.expiresAt, observed: hud }
    receipt.cases.push(evidence)
    assert.ok(hud && !hud.hostConnected && !hud.point && hud.phase === 'clear', 'Read the actual previous child, not the top document')
    assert.ok(hud.now < original.target.hud.expiresAt, 'Child clear must be observed before its old expiry; timeout is inconclusive')

  } finally { session.detach() }
}
async function nativeChildClick(contents: Electron.WebContents, original: any) {
  const session = BrowserCdpSession.attach(contents)
  let point: any, current: any, beforeInputHud: any, beforeCounter: any
  try {
    await session.sendCommand('Page.enable')
    const documents = await discoverBrowserFrameDocuments(session.sendCommand, session.frames)
    current = documents.documents.find(d => d.frameId === original.target.node.frameId)
    assert.ok(current && current.depth === 1, 'The real direct child ancestry is required for this private native input')
    const feedbackWorld: any = await current.sendCommand('Page.createIsolatedWorld', { frameId: current.frameId, worldName: 'agentmux-browser-operation-feedback' })
    const actualHud: any = await current.sendCommand('Runtime.evaluate', { contextId: feedbackWorld.executionContextId, expression: stateExpression, returnByValue: true })
    beforeInputHud = actualHud.result?.value
    assert.ok(beforeInputHud?.hostConnected && beforeInputHud?.pointer && beforeInputHud.phase === 'completed', 'Native click crosses a currently present display-only HUD')
    const counter: any = await current.sendCommand('Runtime.evaluate', { expression: 'Number(localStorage.getItem("proofClicks"))', returnByValue: true })
    beforeCounter = counter.result.value
    const owner: any = await session.sendCommand('DOM.getFrameOwner', { frameId: current.frameId })
    const resolvedOwner: any = await session.sendCommand('DOM.resolveNode', { backendNodeId: owner.backendNodeId })
    const box: any = await session.sendCommand('Runtime.callFunctionOn', { objectId: resolvedOwner.object.objectId, functionDeclaration: 'function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,clientLeft:this.clientLeft,clientTop:this.clientTop,clientWidth:this.clientWidth,clientHeight:this.clientHeight,scrollX,scrollY}}', returnByValue: true })
    await session.sendCommand('Runtime.releaseObject', { objectId: resolvedOwner.object.objectId })
    const rect = box.result.value
    point = { x: rect.left + rect.clientLeft + original.target.hud.point.x * rect.clientWidth / original.target.geometry.innerWidth, y: rect.top + rect.clientTop + original.target.hud.point.y * rect.clientHeight / original.target.geometry.innerHeight, ownerViewportRect: rect, localPoint: original.target.hud.point }
    receipt.nativeChildInput = { frameId: current.frameId, actualSessionId: current.sessionId, beforeInputHud, beforeCounter, pointFromRealFrameOwner: point }
  } finally { session.detach() }
  const zoom = contents.getZoomFactor()
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(point.x*zoom), y: Math.round(point.y*zoom) })
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(point.x*zoom), y: Math.round(point.y*zoom) })
  await pause(25)
  await clearedChild(contents, original, 'oopif-cue-cleared-by-attempted-main-widget-input')
  const fresh = BrowserCdpSession.attach(contents)
  try {
    await fresh.sendCommand('Page.enable')
    const docs = await discoverBrowserFrameDocuments(fresh.sendCommand, fresh.frames)
    const actual = docs.documents.find(d => d.frameId === original.target.node.frameId)!
    assert.ok(actual)
    const events: any = await actual.sendCommand('Runtime.evaluate', { expression: 'globalThis.fixtureEvents', returnByValue: true })
    receipt.nativeChildInput.nativeEvents = events.result?.value
    const counter: any = await actual.sendCommand('Runtime.evaluate', { expression: 'Number(localStorage.getItem("proofClicks"))', returnByValue: true })
    receipt.nativeChildInput.afterCounter = counter.result.value
    const trustedClick = events.result?.value?.some((event: any) => event.type === 'click' && event.target === 'target' && event.trusted)
    const passed = trustedClick && counter.result.value === beforeCounter + 1
    receipt.nativeChildInput.passed = passed
    receipt.cases.push({ label: 'oopif-native-input-reaches-original-child', passed, beforeInputHud, beforeCounter, afterCounter: counter.result.value, frameId: actual.frameId, actualSessionId: actual.sessionId, pointFromRealFrameOwner: point, nativeEvents: events.result.value,
      boundary: passed ? 'Actual native child input was read back.' : 'Not proven: Electron 43.7.7 sendInputEvent forwards to the main RenderWidgetHost. Real OS OOPIF input awaits reachable OS window service.',
      source: 'https://raw.githubusercontent.com/electron/electron/v43.7.7/shell/browser/api/electron_api_web_contents.cc#L3684-L3700' })
    if (!passed) receipt.nativeOopifInputIncomplete = true
    else receipt.cases.push({ ...receipt.cases.find((c: any) => c.label === 'oopif-cue-cleared-by-attempted-main-widget-input'), label: 'oopif-completed-cue-cleared-by-native-human-click', passed: true, verifiedBy: 'trusted original child click and actual counter increment' })
  } finally { fresh.detach() }
}
async function action(contents: Electron.WebContents, label: string, method: 'click' | 'hover' | 'fillInput', name: string, prefix = '') {
  const beforeFocus = webContents.getFocusedWebContents()?.id ?? null
  const beforeActive = await contents.executeJavaScript('document.activeElement?.id || document.activeElement?.tagName')
  const startedAt = Date.now()
  const code = `${prefix}const s=await snapshot();const n=s.nodes.find(n=>n.name===${JSON.stringify(name)});if(!n)throw new Error('No real target');await ${method}(n.ref${method === 'fillInput' ? ',"Native fixture note"' : ''});return {node:n,navigationId:s.navigationId}`
  const row: any = { label, method, startedAt,
    nativeBounds: manager!.nativeOwner(id)!.view.getBounds(), zoom: contents.getZoomFactor(), nativeFocusBefore: beforeFocus,
    singleAction: true, heldAction: false, repeatedAction: false }
  receipt.cases.push(row)
  // Observe the actual Source-resolved handle, not a ref from an earlier run or a guessed frame.
  const contexts = new Map<number, any>(), objects = new Map<string, any>()
  let operationId: string | undefined, issuedTarget: any
  const realSend = contents.debugger.sendCommand.bind(contents.debugger)
  const originalSend = contents.debugger.sendCommand
  contents.debugger.sendCommand = ((command: string, parameters: any = {}, sessionId?: string) => {
    const work = realSend(command, parameters, sessionId)
    void work.then((response: any) => {
      if (command === 'Page.createIsolatedWorld' && parameters.worldName === 'agentmux-browser-operation-feedback')
        contexts.set(response.executionContextId, { frameId: parameters.frameId, sessionId })
      if (command === 'DOM.resolveNode' && parameters.backendNodeId && contexts.has(parameters.executionContextId) && response.object?.objectId)
        objects.set(response.object.objectId, { ...contexts.get(parameters.executionContextId), backendNodeId: parameters.backendNodeId })
      const payload = parameters.arguments?.[0]?.value
      if (command === 'Runtime.callFunctionOn' && payload?.kind === 'target' && payload.phase === 'running' && payload.operationId === operationId && objects.has(parameters.objectId))
        issuedTarget = { ...objects.get(parameters.objectId), issuedNavigationId: payload.navigationId, operationId }
    }).catch(() => {}) // The original caller retains its actual rejection; this passive observer changes no result.
    return work
  }) as any
  let completeObservation!: (value: any) => void
  const observed = new Promise<any>(resolve => { completeObservation = resolve })
  const afterOriginalOwnerReleased = () => {
    contents.debugger.sendCommand = originalSend
    void (async () => {
      assert.ok(issuedTarget, 'Actual production feedback consumed a Source-resolved frame/backend handle')
      row.observer = { originalManagerOwnerReleasedAt: Date.now(), sourceResolvedHandle: issuedTarget,
        owner: 'fresh-private-readonly-session-after-original-manager-detach' }
      row.target = await inspectTarget(contents, issuedTarget, row)
      row.observedAt = Date.now(); row.native = await nativePage(contents, label)
      return { target: row.target, native: row.native }
    })().then(value => completeObservation({ value }), error => completeObservation({ error }))
  }
  contents.debugger.once('detach', afterOriginalOwnerReleased)
  let report: any, observation: any
  try {
    report = await manager!.runScript(id, code, operator, undefined, undefined, op => { operationId = op.id; row.operationStarted = { id: op.id, startedAt: op.startedAt, observedAt: Date.now() } })
    row.actualReport = report; row.returnedAt = Date.now(); row.durationMs = row.returnedAt - startedAt
    observation = await observed
  } finally { contents.debugger.removeListener('detach', afterOriginalOwnerReleased); contents.debugger.sendCommand = originalSend }
  assert.equal(report.outcome.kind, 'completed')
  if (observation.error) {
    row.passed = false; row.failure = { message: observation.error.message, stack: observation.error.stack }
    row.originalPageEvents = await contents.executeJavaScript('globalThis.fixtureEvents')
    row.native = await nativePage(contents, label + '-failed-observation')
    receipt.internalNativeFailures ??= []; receipt.internalNativeFailures.push({ label, message: observation.error.message })
    return row
  }
  const result = report.result as any, target = observation.value.target
  assert.equal(issuedTarget.backendNodeId, result.node.backendNodeId)
  assert.equal(issuedTarget.frameId, result.node.frameId)
  assert.equal(issuedTarget.issuedNavigationId, result.navigationId)
  assert.equal(issuedTarget.operationId, report.runOperation.id)
  assert.equal(target.node.name, result.node.name)
  row.top = await pageState(contents)
  const hud = target.hud
  assert.ok(hud?.hostConnected && hud.pointer && hud.phase === 'completed', 'Ordinary single action has a visible completed cue')
  assert.equal(hud.operationId, report.runOperation.id); assert.equal(hud.navigationId, (await manager!.create(id, url)).navigationId)
  assert.equal(hud.hostPointerEvents, 'none'); assert.equal(hud.pointer.pointerEvents, 'none')
  assert.equal(hud.glow, null, 'Normal completion does not retain execution glow')
  assert.ok(hud.expiresAt > hud.now && hud.expiresAt - hud.now <= 900, 'Real completion expiry is short and bounded')
  assert.ok(!hud.label.text.includes('Native fixture note'), 'Input values never become decoration labels')
  assert.ok(Math.abs(hud.point.x - (target.geometry.left + target.geometry.right) / 2) <= 1)
  assert.ok(Math.abs(hud.point.y - (target.geometry.top + target.geometry.bottom) / 2) <= 1)
  assert.equal(webContents.getFocusedWebContents()?.id ?? null, beforeFocus, 'Agent feedback does not steal native focus')
  assert.equal(await contents.executeJavaScript('document.activeElement?.id || document.activeElement?.tagName'), beforeActive)
  return row
}
function notTested(label: string, reason: string, prerequisite?: any) {
  const row = { label, passed: false, executed: false, status: 'not-tested', reason, prerequisite: prerequisite?.label }
  receipt.cases.push(row); return row
}
async function availableCase(label: string, work: () => Promise<any>) {
  try { return await work() }
  catch (error: any) {
    const row = receipt.cases.findLast((item: any) => item.label === label) ?? { label }
    if (!receipt.cases.includes(row)) receipt.cases.push(row)
    Object.assign(row, { passed: false, executed: true, status: 'failed', failure: { message: error.message, stack: error.stack } })
    receipt.internalNativeFailures ??= []; receipt.internalNativeFailures.push({ label, message: error.message })
    return row
  }
}
const presentCue = (row: any) => row?.passed !== false && row?.target?.hud?.hostConnected && row?.target?.hud?.phase === 'completed' && row.target.hud.expiresAt > Date.now()
async function main() {
try {
  await app.whenReady()
  app.setAccessibilitySupportEnabled(true)
  receipt.privateAccessibilityCondition = { requested: true, actual: app.isAccessibilitySupportEnabled(), productDefaultCertified: false }; await mkdir(out, { recursive: true })
  window = new BrowserWindow({ width: 960, height: 780, title: `Private feedback proof ${phase} ${process.pid}`, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,<body style="background:%23e9eeeb;font:13px system-ui;padding:12px">Private original Browser proof</body>')
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(probeRoot, 'profiles.json')))
  await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(probeRoot, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('External applications are not part of this probe') } },
    new BrowserOperationJournal(new BrowserOperationFileStore(join(probeRoot, 'journal.json'))))
  const retained = phase === 'second' ? JSON.parse(await readFile(retainedFile, 'utf8')) : null
  const created = await manager.create(id, retained?.url ?? url)
  manager.setBounds(id, { x: 16, y: 52, width: 720, height: 660 })
  const contents = manager.nativeOwner(id)!.view.webContents
  contents.debugger.on('message', (_event, method, parameters: any) => {
    if (method === 'Target.attachedToTarget' && parameters.targetInfo?.type === 'iframe') {
      const currentSession = parameters.sessionId
      actualChildSessions.set(currentSession, (command: string, args: any) => contents.debugger.sendCommand(command, args, currentSession))
    }
    if (method === 'Target.detachedFromTarget') actualChildSessions.delete(parameters.sessionId)
  })
  contents.debugger.on('detach', () => actualChildSessions.clear())
  // This private observation must keep presenting while other owners use their windows.
  // The installed product's default policy is not certified by this thin fixture.
  receipt.observationCondition = { privateFixtureOnly: true, productionDefaultBackgroundThrottling: contents.getBackgroundThrottling(),
    requestedBackgroundThrottling: false, reason: 'Original private page presentation under parallel-window occlusion; no product policy change.' }
  contents.setBackgroundThrottling(false)
  receipt.observationCondition.actualBackgroundThrottling = contents.getBackgroundThrottling()
  receipt.pageLoadEvents = []
  contents.on('did-fail-load', (_event, code, description, validatedURL, mainFrame) => receipt.pageLoadEvents.push({ kind: 'failed', code, description, validatedURL, mainFrame }))
  contents.on('did-finish-load', () => receipt.pageLoadEvents.push({ kind: 'finished', url: contents.getURL() }))
  await waitFor('original page and both original frame owners loaded', async () => {
    receipt.bootstrapObservation = { url: contents.getURL(), loading: contents.isLoading(), snapshot: await manager!.create(id, url) }
    if (receipt.bootstrapObservation.loading) return false
    const actual = await contents.executeJavaScript('({readyState:document.readyState,visibility:document.visibilityState,frames:document.querySelectorAll("iframe").length,target:document.querySelector("#target")?.textContent,title:document.title,body:document.body?.textContent.slice(0,400)})')
    receipt.bootstrapObservation.actual = actual
    return !receipt.bootstrapObservation.loading && actual.frames === 2 && actual.target === 'Continue'
  })
  await pause(180)
  window.showInactive() // Never activate a private probe or take the user's keyboard focus.
  receipt.originalNativeVisibility = { windowVisible: window.isVisible(), windowFocused: window.isFocused(), windowMinimized: window.isMinimized(),
    bounds: manager.nativeOwner(id)!.view.getBounds(), webContentsFocused: contents.isFocused(), domVisibility: await contents.executeJavaScript('document.visibilityState') }
  receipt.original = { browserId: id, profileId: created.profileId, contentsId: contents.id, url: contents.getURL(), processId: contents.getOSProcessId(),
    frameProcesses: contents.mainFrame.framesInSubtree.map(f => ({ processId: f.processId, osProcessId: f.osProcessId, routingId: f.routingId, detached: f.detached })) }
  if (nativeScope === 'motion') {
    const display = screen.getDisplayMatching(window.getBounds())
    const outputSpace = display.colorSpace.includes('P3') ? 'display-p3' : /BT709|SRGB/.test(display.colorSpace) ? 'srgb' : null
    receipt.framePaintObservation = { displayId: display.id, displayColorSpace: display.colorSpace, outputSpace,
      conversion: 'actual-computed-CSS-through-offscreen-Chromium-Canvas', originalPngColorProfile: 'not-assumed' }
    const paintSource = await readFile(join(probeRoot, 'projection/apps/desktop/src/main/browser-operation-feedback.ts'))
    receipt.framePaintObservation.sourceSha256 = digest(paintSource)
    receipt.framePaintObservation.preparationStartedAt = Date.now()
    const prepared = await contents.executeJavaScriptInIsolatedWorld(1209, [{ code: feedbackPaintPreparation(paintSource.toString('utf8'), outputSpace) }])
    receipt.framePaintObservation.preparationFinishedAt = Date.now()
    receipt.framePaintObservation.prepared = prepared
    stateExpression = withFeedbackFramePaint(stateExpression, prepared)
    await runMotionProbe({ manager, contents, id, operator, phase, out, url, retainedFile, receipt, created, retained,
      stateExpression, pageState, action, inspectTarget, nativePage, osWindow })
  } else if (phase === 'second') {
    assert.equal(created.profileId, retained.profileId); assert.equal(contents.getURL(), retained.url)
    const profileState = await contents.executeJavaScript('localStorage.getItem("proofClicks")')
    assert.equal(profileState, retained.profileClicks)
    const hud = await pageState(contents)
    assert.ok(!hud?.hostConnected && !hud?.point)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    receipt.restored = { browserId: id, profileId: created.profileId, url: contents.getURL(), profileClicks: profileState, oldHudPresent: false,
      localBrowserInputRestored: true, desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested' }
    await nativePage(contents, 'restored-original-page'); await osWindow('restored-original-page')
    const quiet = await action(contents, 'reduced-motion-static', 'hover', 'Continue')
    assert.equal(quiet.target.hud.reducedMotion, true, 'The real renderer observes the reduced-motion preference')
    assert.equal(quiet.target.hud.pointer.animationName, 'none')
  } else {
    // Establish a real editable human focus; BODY cannot be refocused like an input.
    const baselineRect = await contents.executeJavaScript('(()=>{const r=document.querySelector("#field").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    const baselineZoom = contents.getZoomFactor()
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(baselineRect.x*baselineZoom), y: Math.round(baselineRect.y*baselineZoom) })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(baselineRect.x*baselineZoom), y: Math.round(baselineRect.y*baselineZoom) })
    await waitFor('actual native editable baseline focus', async () => await contents.executeJavaScript('document.activeElement?.id==="field"'))
    receipt.editableFocusBaseline = { activeElement: await contents.executeJavaScript('document.activeElement.id'),
      nativeEvents: await contents.executeJavaScript('fixtureEvents'), nativePoint: baselineRect, zoom: baselineZoom }
    assert.ok(receipt.editableFocusBaseline.nativeEvents.some((event: any) => event.type === 'click' && event.target === 'field' && event.trusted))
    manager.returnControl(id)
    await manager.create('private-unrelated-page', url)
    const unrelated = window.contentView.children.map((v: any) => v.webContents).find((wc: any) => wc?.id !== contents.id && wc?.id !== window!.webContents.id)!
    await waitFor('unrelated original page loaded', async () => !unrelated.isLoading())
    let unrelatedCdpCalls = 0, unrelatedHudCalls = 0
    const originalWorldWrite = unrelated.executeJavaScriptInIsolatedWorld.bind(unrelated)
    unrelated.executeJavaScriptInIsolatedWorld = ((world: number, ...args: any[]) => { if (world === 1209) unrelatedHudCalls++; return originalWorldWrite(world, ...args) }) as any
    const realCommand = unrelated.debugger.sendCommand.bind(unrelated.debugger)
    unrelated.debugger.sendCommand = ((...args: any[]) => { unrelatedCdpCalls++; return realCommand(...args) }) as any
    await nativePage(contents, 'initial-original-page')
    const readonly = await manager.runScript(id, 'return await snapshot()', operator)
    assert.equal(readonly.outcome.kind, 'completed'); assert.ok(!((await pageState(contents)) as any)?.hostConnected)
    receipt.cases.push({ label: 'read-only-no-feedback', actualReport: readonly, hud: await pageState(contents) })
    await action(contents, 'normal-click', 'click', 'Continue')
    await action(contents, 'normal-hover', 'hover', 'Continue')
    await action(contents, 'normal-fill', 'fillInput', 'Page note')
    await osWindow('normal-original-page')
    let workSettled = false
    const readRealJob = async () => {
      if (!contents.debugger.isAttached()) return undefined
      try {
        const result: any = await contents.debugger.sendCommand('Runtime.evaluate', { expression: 'globalThis.fixtureWork', returnByValue: true, awaitPromise: false })
        assert.equal(result.exceptionDetails, undefined); return result.result.value
      } catch (error: any) {
        receipt.asyncWorkReadFailures ??= []; receipt.asyncWorkReadFailures.push({ at: Date.now(), message: error.message, originalDebuggerAttached: contents.debugger.isAttached() })
        return undefined // A missing initial observation remains unknown; the original operation keeps running.
      }
    }
    const asyncWork = manager.runScript(id, 'return await js("globalThis.performFixtureWork()")', operator).then(report => {
      workSettled = true; receipt.asyncWorkReport = report; return report
    })
    const working = await waitFor('actual unfinished page work and running glow', async () => {
      const job = await readRealJob()
      const hud = await pageState(contents)
      receipt.asyncWorkObservation = { job, hud, at: Date.now() }
      receipt.asyncWorkObservations ??= []; receipt.asyncWorkObservations.push(receipt.asyncWorkObservation)
      return job?.phase === 'working' && hud?.phase === 'running' && hud?.glow ? { job, hud } : null
    })
    const busyImage = await nativePage(contents, 'actual-async-page-work')
    const afterImage: any = { at: Date.now(), workSettled }
    afterImage.job = await readRealJob(); afterImage.jobReadReturnedAt = Date.now()
    afterImage.hud = await pageState(contents); afterImage.hudReadReturnedAt = Date.now()
    receipt.asyncWorkCapture = { beforeImage: working, native: busyImage, afterImage }
    const workReport = await asyncWork
    receipt.asyncWorkCapture.actualReport = workReport
    assert.equal(workReport.outcome.kind, 'completed')
    const workResult = workReport.result as { startedAt: number; finishedAt: number }
    assert.ok(workResult && Number.isFinite(workResult.startedAt) && Number.isFinite(workResult.finishedAt), 'The actual finite fixture job reports its own times')
    assert.equal(afterImage.workSettled, false, 'The actual page RPC was unfinished at native capture return')
    assert.ok(workResult.startedAt <= busyImage.startedAt && busyImage.presentation.at <= busyImage.returnedAt && busyImage.returnedAt < workResult.finishedAt, 'Actual page job completion is later than the entire original native capture; a late DOM read cannot relabel that frame')
    if (afterImage.job.phase === 'working') assert.ok(afterImage.hud?.glow && afterImage.hud.phase === 'running')
    else assert.ok(afterImage.jobReadReturnedAt >= workResult.finishedAt && afterImage.job.finishedAt === workResult.finishedAt, 'Late completed read is preserved with its actual time, never rewritten as working')
    receipt.cases.push({ label: 'actual-async-page-work', actualReport: workReport, beforeImage: working, afterImage, native: busyImage,
      heldAction: false, boundary: 'A separate genuine unfinished page job proves running feedback; it does not replace ordinary single click/hover cues.' })
    manager.setBounds(id, { x: 16, y: 52, width: 234.5, height: 616 })
    await nativePage(contents, 'narrow-layout-baseline')
    const narrow = await action(contents, 'narrow-hover', 'hover', 'Continue')
    narrow.requestedWidth = 234.5
    assert.ok(narrow.nativeBounds.width <= 240 && narrow.nativeBounds.width > 0)
    await osWindow('narrow-original-page')
    notTested('short-click', 'Known fixed-candidate defect is preserved; no repeat to chase GREEN. Single click followed by own late scroll cleared its cue.',
      { label: 'attempt-1791062921596/first-receipt.json#short-click' })
    receipt.priorShortFailure = { path: '.tmp/browser-operation-feedback-native/attempt-1791062921596/first-receipt.json',
      sha256: '84b6f9267fe94f9a599b7020ca6a1b33a8d486ade4b123b42f9f108dcee4791a', eventPath: 'cases[label=short-click].originalPageEvents' }
    manager.setBounds(id, { x: 16, y: 52, width: 720, height: 660 })
    await nativePage(contents, 'restored-layout-baseline')
    const same = await action(contents, 'same-process-frame', 'hover', 'First embedded action')
    assert.equal(same.target.node.sessionId, undefined, 'Same-process child uses the actual root CDP sender')
    assert.notEqual(same.target.node.frameId, same.target.mainFrameId, 'Same-process child is not silently replaced by the main document')
    const oop = await action(contents, 'out-of-process-frame', 'click', 'Second embedded action')
    assert.ok(oop.target.node.sessionId, 'OOPIF target uses an actual current CDP child sender')
    const processIds = new Set(receipt.original.frameProcesses.map((f: any) => f.osProcessId))
    assert.ok(processIds.size > 1, 'A real second renderer process exists')
    if (presentCue(oop)) await availableCase('oopif-cleared-by-new-operation', async () => {
    const nextOperation = action(contents, 'new-operation-after-oopif', 'hover', 'Continue')
    await waitFor('original manager new-operation debugger owner', async () => contents.debugger.isAttached() && actualChildSessions.size > 0)
    await clearedChild(contents, oop, 'oopif-cleared-by-new-operation', true)
    await nextOperation
    }); else notTested('oopif-cleared-by-new-operation', 'Original OOPIF completion cue was absent; natural expiry cannot prove clear.', oop)
    const nativeChild = await action(contents, 'oopif-before-native-human-click', 'hover', 'Second embedded action')
    if (presentCue(nativeChild)) await availableCase('oopif-native-input-reaches-original-child', () => nativeChildClick(contents, nativeChild))
    else notTested('oopif-native-input-reaches-original-child', 'Original OOPIF cue was absent before native input.', nativeChild)
    const mainTakeoverChild = await action(contents, 'oopif-before-main-human-click', 'hover', 'Second embedded action')
    if (presentCue(mainTakeoverChild)) await availableCase('oopif-cleared-by-main-native-human-input', async () => {
    const mainRect = await contents.executeJavaScript('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    const mainZoom = contents.getZoomFactor()
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(mainRect.x*mainZoom), y: Math.round(mainRect.y*mainZoom) })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(mainRect.x*mainZoom), y: Math.round(mainRect.y*mainZoom) })
    await pause(25)
    await clearedChild(contents, mainTakeoverChild, 'oopif-cleared-by-main-native-human-input')
    assert.ok((await contents.executeJavaScript('fixtureEvents')).some((event: any) => event.type === 'click' && event.target === 'target' && event.trusted))
    }); else notTested('oopif-cleared-by-main-native-human-input', 'Original OOPIF cue was absent before main native input.', mainTakeoverChild)
    const hiddenChild = await action(contents, 'oopif-before-hide', 'hover', 'Second embedded action')
    if (presentCue(hiddenChild)) await availableCase('oopif-cleared-by-hide', async () => { manager!.setBounds(id, null); await pause(25); await clearedChild(contents, hiddenChild, 'oopif-cleared-by-hide') })
    else notTested('oopif-cleared-by-hide', 'Original OOPIF cue was absent before hide.', hiddenChild)
    manager.setBounds(id, { x: 16, y: 52, width: 720, height: 660 })
    const edge = await action(contents, 'bottom-right-target', 'hover', 'Edge action')
    if (edge.passed !== false) await availableCase('bottom-right-label-within-viewport', async () => {
      const labelRect = edge.target.hud.label.rect
      assert.ok(labelRect.x >= 0 && labelRect.y >= 0 && labelRect.x + labelRect.width <= edge.target.geometry.innerWidth && labelRect.y + labelRect.height <= edge.target.geometry.innerHeight, 'The complete label remains in the actual viewport at the bottom-right target')
      receipt.cases.push({ label: 'bottom-right-label-within-viewport', passed: true, actualRect: labelRect, viewport: edge.target.geometry })
    }); else notTested('bottom-right-label-within-viewport', 'No completed target label was present to inspect.', edge)
    await pause(960)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    receipt.cases.push({ label: 'bounded-completion-expired', top: await pageState(contents), actualTime: Date.now() })
    const waiting = manager.runScript(id, 'const s=await snapshot();await hover(s.nodes.find(n=>n.name==="Continue").ref);await waitForElement("A later generic control",1800)', operator)
    await waitFor('actual production waiting phase', async () => (await manager!.create(id, url)).activity?.operation?.phase === 'waiting')
    await pause(40)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    const rect = await contents.executeJavaScript('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    const z = contents.getZoomFactor(), beforeClick = await contents.executeJavaScript('Number(localStorage.getItem("proofClicks"))')
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(rect.x*z), y: Math.round(rect.y*z) })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(rect.x*z), y: Math.round(rect.y*z) })
    const takeover = await waiting
    assert.equal(takeover.outcome.kind, 'stopped')
    const events = await contents.executeJavaScript('fixtureEvents')
    assert.ok(events.some((event: any) => event.type === 'click' && event.target === 'target' && event.trusted), 'Native input reaches the original page as a trusted click')
    assert.equal(await contents.executeJavaScript('Number(localStorage.getItem("proofClicks"))'), beforeClick + 1)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    receipt.cases.push({ label: 'waiting-native-human-takeover', actualReport: takeover, nativeEvents: events, top: await pageState(contents) })
    const fieldRect = await contents.executeJavaScript('(()=>{const r=document.querySelector("#field").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(fieldRect.x*z), y: Math.round(fieldRect.y*z) })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(fieldRect.x*z), y: Math.round(fieldRect.y*z) })
    await waitFor('original editable field receives native focus', async () => await contents.executeJavaScript('document.activeElement?.id==="field"'))
    const fieldBeforeTyping = await contents.executeJavaScript('document.querySelector("#field").value')
    contents.sendInputEvent({ type: 'char', keyCode: 'N' })
    const nativeInput = await waitFor('native typing read back from original page', async () => {
      const state = await contents.executeJavaScript('({value:document.querySelector("#field").value,events:fixtureEvents,focused:document.activeElement?.id})')
      return state.value !== fieldBeforeTyping && state.value.length === fieldBeforeTyping.length + 1 && state.events.some((event: any) => event.type === 'input' && event.target === 'field' && event.trusted) ? state : null
    })
    receipt.cases.push({ label: 'native-human-input-original-field', beforeValue: fieldBeforeTyping, actualNativeInput: nativeInput })
    await nativePage(contents, 'human-original-page'); await osWindow('human-original-page')
    manager.returnControl(id)
    await action(contents, 'before-hide', 'hover', 'Continue'); manager.setBounds(id, null)
    await pause(40)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    manager.setBounds(id, { x: 16, y: 52, width: 720, height: 660 })
    await action(contents, 'before-navigation', 'hover', 'Continue'); await manager.navigate(id, url + '?new-document=1')
    await waitFor('new original document', async () => !contents.isLoading())
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    assert.equal(unrelatedCdpCalls, 0, 'No product feedback/CDP work is sent to the unrelated Browser')
    assert.equal(unrelatedHudCalls, 0, 'No HUD world write is sent to the unrelated Browser')
    assert.equal(await unrelated.executeJavaScript('document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length'), 0)
    receipt.cases.push({ label: 'unrelated-browser-zero-work', webContentsId: unrelated.id, productCdpCalls: unrelatedCdpCalls, productHudCalls: unrelatedHudCalls, hudHosts: 0 })
    const afterGoto = await action(contents, 'same-operation-goto-new-document-click', 'click', 'Continue', `await gotoUrl(${JSON.stringify(url + '?same-operation-goto=1')});`)
    if (afterGoto.passed !== false) assert.equal(afterGoto.target.hud.navigationId, (await manager.create(id, url)).navigationId)
    const snapshot = await manager.create(id, url)
    receipt.retained = { browserId: snapshot.id, profileId: snapshot.profileId, url: contents.getURL(), profileClicks: await contents.executeJavaScript('localStorage.getItem("proofClicks")') }
    await writeFile(retainedFile, JSON.stringify(receipt.retained))
  }
  assert.ok(receipt.cases.length > 0, 'Actual process exercised a nonempty case set')
  for (const completedCase of receipt.cases) completedCase.passed ??= true
  receipt.phaseCompleted = true
  receipt.casesCompleted = receipt.cases.every((item: any) => item.executed !== false)
  receipt.caseResults = { executed: receipt.cases.filter((item: any) => item.executed !== false).length,
    notTested: receipt.cases.filter((item: any) => item.executed === false).map((item: any) => item.label),
    failed: receipt.cases.filter((item: any) => item.passed === false && item.executed !== false).map((item: any) => item.label) }
  receipt.casesPassed = receipt.cases.every((item: any) => item.passed === true) && !receipt.nativeOopifInputIncomplete && !receipt.internalNativeFailures?.length
  receipt.passed = receipt.casesPassed && !receipt.visual.osObservationIncomplete
} catch (error: any) {
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  await writeFile(phaseFile, JSON.stringify(receipt))
  manager?.dispose(); await profiles?.dispose()
  if (receipt.phaseCompleted) app.quit()
  else { process.stderr.write(`file_editing_probe_failed=${receipt.failure?.message}\n`); app.exit(1) }
}

}
void main().catch(async error => { receipt.failure = { message: error.message, stack: error.stack }; await writeFile(phaseFile, JSON.stringify(receipt)); app.exit(1) })
