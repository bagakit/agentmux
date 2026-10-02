const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
const geometryDiagnostic = process.env.AGENTMUX_SHARED_FRAME_GEOMETRY_DIAGNOSTIC === '1'
const serviceHintDiagnostic = process.env.AGENTMUX_SHARED_FRAME_SERVICE_HINT_DIAGNOSTIC === '1'
const referenceCounterOnly = process.env.AGENTMUX_SHARED_FRAME_REFERENCE_COUNTER_ONLY === '1'
const preMoveReadDiagnostic = process.env.AGENTMUX_SHARED_FRAME_PRE_MOVE_READ_DIAGNOSTIC === '1'
const styleMoveTraceDiagnostic = process.env.AGENTMUX_SHARED_FRAME_STYLE_MOVE_TRACE_DIAGNOSTIC === '1'
const preMoveStyleReadDiagnostic = process.env.AGENTMUX_SHARED_FRAME_PRE_MOVE_STYLE_READ_DIAGNOSTIC === '1'
const commitIntervalDiagnostic = process.env.AGENTMUX_SHARED_FRAME_COMMIT_INTERVAL_DIAGNOSTIC === '1'
const noDisclosureOpenDiagnostic = process.env.AGENTMUX_SHARED_FRAME_NO_DISCLOSURE_OPEN_DIAGNOSTIC === '1'
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], checks: [], userRunTouched: false,
  boundary: 'Actual complete App, Store, file tree, Tab/Region and Editor owners; controlled public Session/files API. No Browser seed, Native simultaneous display, actual Core/ctxmux/CLI or installed-app claim.' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
function installPrivateCommitIntervalTrace() {
  const identities = new WeakMap(), remembered = new WeakSet(), restores = []
  let nextIdentity = 0
  const identity = node => { if (!node) return null; if (!identities.has(node)) identities.set(node, ++nextIdentity); return identities.get(node) }
  const describe = node => {
    if (!(node instanceof Node)) return { literal: typeof node === 'string' ? node.slice(0, 120) : String(node) }
    const value = { key: identity(node), type: node.nodeType, tag: node.nodeName, connected: node.isConnected, parentKey: identity(node.parentNode) }
    if (node instanceof Element) { value.id = node.id; value.class = node.className; value.attributes = [...node.attributes].map(attribute => [attribute.name, attribute.value]); if (node.hasAttribute('popover')) value.popoverOpen = node.matches(':popover-open') }
    return value
  }
  const chain = node => { const values = []; for (let current = node; current && values.length < 24; current = current.parentNode) values.push(describe(current)); return values }
  const state = { notAcceptance: true, addedStyleQueries: 0, addedGeometryReads: 0, eventCount: 0, droppedEvents: 0, methodCounts: {}, events: [] }
  const panel = () => document.getElementById('pmo-teams-topic-floating-panel')
  const relevant = node => node instanceof Node && (remembered.has(node) || !!panel()?.contains(node) || node.contains(panel()))
  const owners = () => {
    const outer = panel(), root = outer?.querySelector('.workspace-workbench'), bodies = [...root?.children ?? []].filter(node => node.classList.contains('workbench-layout-body') || node.classList.contains('workbench-reference-body'))
    const slots = bodies.flatMap(body => [...body.querySelectorAll('.workbench-tab-slot')].map(slot => { remembered.add(slot); return { ...describe(slot), bodyKey: identity(body), parentChain: chain(slot.parentNode) } }))
    for (const node of [outer, root, ...bodies].filter(Boolean)) remembered.add(node)
    const duplicateSlotIds = [...new Set(slots.map(slot => slot.id))].filter(id => id && slots.filter(slot => slot.id === id).length > 1)
    return { panel: describe(outer), root: describe(root), rootParentChain: chain(root?.parentNode), bodies: bodies.map(describe), slots, duplicateSlotIds, openPopovers: [...document.querySelectorAll('[popover]:popover-open')].map(describe) }
  }
  const note = (event, details) => { state.eventCount++; if (state.events.length < 1600) state.events.push({ sequence: state.eventCount, time: performance.now(), event, ...details, owners: owners() }); else state.droppedEvents++ }
  const wrap = (prototype, name, selector) => {
    const original = prototype[name]
    if (typeof original !== 'function') return
    prototype[name] = function(...args) {
      const capture = selector ? selector(this, args) : relevant(this) || args.some(relevant)
      if (capture) { state.methodCounts[name] = (state.methodCounts[name] ?? 0) + 1; note(name + '-before', { receiver: describe(this), receiverParentChain: chain(this.parentNode), arguments: args.map(describe) }) }
      try { const returned = Reflect.apply(original, this, args); if (capture) note(name + '-after', { receiver: describe(this), receiverParentChain: chain(this.parentNode), arguments: args.map(describe) }); return returned }
      catch (error) { if (capture) note(name + '-error', { message: error.message }); throw error }
    }
    restores.push(() => { prototype[name] = original })
  }
  for (const name of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']) wrap(Node.prototype, name)
  for (const name of ['append', 'prepend', 'remove', 'replaceChildren', 'before', 'after', 'replaceWith', 'moveBefore']) wrap(Element.prototype, name)
  const structuralAttribute = name => ['id', 'class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-workbench-layout-state', 'data-workbench-tab-id', 'data-workbench-group-id'].includes(name)
  for (const name of ['setAttribute', 'removeAttribute', 'toggleAttribute']) wrap(Element.prototype, name, (node, args) => structuralAttribute(args[0]) && relevant(node))
  for (const name of ['showPopover', 'hidePopover', 'togglePopover']) wrap(HTMLElement.prototype, name, node => relevant(node))
  const onToggle = event => { if (relevant(event.target)) note(event.type, { target: describe(event.target), oldState: event.oldState, newState: event.newState }) }
  document.addEventListener('beforetoggle', onToggle, true); document.addEventListener('toggle', onToggle, true)
  const observer = new MutationObserver(records => { for (const record of records) if (relevant(record.target) || [...record.addedNodes, ...record.removedNodes].some(relevant)) note('mutation-observer', { mutationType: record.type, target: describe(record.target), attributeName: record.attributeName, oldValue: record.oldValue, added: [...record.addedNodes].map(describe), removed: [...record.removedNodes].map(describe) }) })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['id', 'class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-workbench-layout-state'] })
  window.privateCommitIntervalTrace = state; window.privateStyleMoveIdentity = identity
  window.restorePrivateCommitIntervalTrace = () => { for (const restore of restores.reverse()) restore(); observer.disconnect(); document.removeEventListener('beforetoggle', onToggle, true); document.removeEventListener('toggle', onToggle, true) }
  note('installed-at-original-bad-reference-boundary', {})
}
let nativeCommitTrace = null
async function startNativeCommitTrace() {
  const events = [], metadata = { notAcceptance: true, droppedEvents: 0, protocolSource: 'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json' }
  let complete
  const completion = new Promise(resolve => { complete = resolve })
  const listener = (_event, method, params) => {
    if (method === 'Tracing.dataCollected') for (const event of params.value ?? []) { if (events.length < 100000) events.push(event); else metadata.droppedEvents++ }
    if (method === 'Tracing.tracingComplete') { metadata.completion = params; complete() }
  }
  win.webContents.debugger.on('message', listener)
  nativeCommitTrace = { events, metadata, listener, completion, started: false }
  const { categories } = await win.webContents.debugger.sendCommand('Tracing.getCategories')
  metadata.availableInvalidationCategories = categories.filter(category => /invalidation|devtools.timeline/.test(category))
  const requested = ['devtools.timeline', 'blink.user_timing', 'disabled-by-default-devtools.timeline.invalidationTracking']
  metadata.includedCategories = requested.filter(category => categories.includes(category))
  await win.webContents.debugger.sendCommand('Tracing.start', { traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 4096, includedCategories: metadata.includedCategories } })
  nativeCommitTrace.started = true
  await win.webContents.debugger.sendCommand('Tracing.recordClockSyncMarker', { syncId: phase + '-original-bad-reference-start' })
}
async function finishNativeCommitTrace() {
  if (!nativeCommitTrace) return
  const trace = nativeCommitTrace
  try { if (trace.started) { await win.webContents.debugger.sendCommand('Tracing.end'); await bounded(trace.completion, 'original Chromium invalidation trace completion', 5000) } }
  catch (error) { trace.metadata.error = error.message }
  finally { win.webContents.debugger.removeListener('message', trace.listener) }
  const file = phase + '-native-commit-invalidation-trace.json', bytes = JSON.stringify({ ...trace.metadata, traceEvents: trace.events }, null, 2)
  await fs.writeFile(path.join(evidence, file), bytes)
  result.nativeCommitInvalidationTrace = { file, sha256: createHash('sha256').update(bytes).digest('hex'), eventCount: trace.events.length, ...trace.metadata }
  nativeCommitTrace = null
}
function installPrivatePreMoveStyleReadDiagnostic() {
  const nativeMove = Element.prototype.moveBefore, identities = new WeakMap()
  let nextIdentity = 0
  const identity = node => { if (!node) return null; if (!identities.has(node)) identities.set(node, ++nextIdentity); return identities.get(node) }
  const describe = node => node instanceof Element ? { key: identity(node), tag: node.tagName, id: node.id, class: node.className, connected: node.isConnected, parentKey: identity(node.parentElement), attributes: [...node.attributes].map(attribute => [attribute.name, attribute.value]) } : null
  const state = { notAcceptance: true, extraBodyObservationsMayAffectOutcome: true, geometryReads: 0, attemptedMoves: 0, connectedMoves: 0, actualMoves: 0, moveErrors: 0, genericStyleQueries: 0, genericPropertyReads: 0, extraBodyStyleQueries: 0, extraBodyPropertyReads: 0, droppedMoves: 0, moves: [] }
  const style = (node, kind) => {
    if (!node) return null
    const properties = kind === 'generic' ? ['display', 'visibility', 'position'] : ['display', 'visibility', 'position', 'pointer-events', 'clip-path', 'inset']
    const computed = getComputedStyle(node), values = {}
    if (kind === 'generic') state.genericStyleQueries++; else state.extraBodyStyleQueries++
    for (const property of properties) { values[property] = computed.getPropertyValue(property); if (kind === 'generic') state.genericPropertyReads++; else state.extraBodyPropertyReads++ }
    return { node: describe(node), computed: values }
  }
  const bodies = () => {
    const root = document.getElementById('pmo-teams-topic-floating-panel')?.querySelector('.workspace-workbench')
    return { root: describe(root), rootParent: describe(root?.parentElement), bodies: [...root?.children ?? []].filter(node => node.classList.contains('workbench-layout-body') || node.classList.contains('workbench-reference-body')) }
  }
  Element.prototype.moveBefore = function(node, before) {
    state.attemptedMoves++
    const sourceParent = node?.parentElement, owners = bodies(), connected = this.isConnected && node?.isConnected
    const record = { sequence: state.attemptedMoves, time: performance.now(), connected, parentChanges: sourceParent !== this, node: describe(node), sourceParent: describe(sourceParent), destination: describe(this), rootBefore: owners.root, rootParentBefore: owners.rootParent, bodyAttributesBeforeReads: owners.bodies.map(describe) }
    if (connected) {
      state.connectedMoves++
      record.genericBefore = [style(node, 'generic'), style(sourceParent, 'generic'), style(this, 'generic'), style(document.documentElement, 'generic')]
      record.bodyBefore = owners.bodies.map(body => style(body, 'body'))
    }
    try {
      const returned = nativeMove.call(this, node, before)
      state.actualMoves++; record.completed = true
      if (connected) record.bodyAfter = owners.bodies.map(body => style(body, 'body'))
      const after = bodies(); record.rootAfter = after.root; record.rootParentAfter = after.rootParent; record.nodeAfter = describe(node)
      return returned
    } catch (error) { state.moveErrors++; record.error = error.message; throw error }
    finally { if (state.moves.length < 256) state.moves.push(record); else state.droppedMoves++ }
  }
  window.privatePreMoveStyleReadDiagnostic = state
  window.restorePrivatePreMoveStyleReadDiagnostic = () => { Element.prototype.moveBefore = nativeMove }
}
function installPrivateStyleMoveTrace() {
  const identities = new WeakMap(), nativeSet = Element.prototype.setAttribute, nativeRemove = Element.prototype.removeAttribute, nativeMove = Element.prototype.moveBefore
  let nextIdentity = 0
  const identity = node => { if (!node) return null; if (!identities.has(node)) identities.set(node, ++nextIdentity); return identities.get(node) }
  const describe = node => node instanceof Element ? { key: identity(node), tag: node.tagName, id: node.id, class: node.className, connected: node.isConnected, parentKey: identity(node.parentElement), attributes: [...node.attributes].map(attribute => [attribute.name, attribute.value]) } : null
  const chain = node => { const values = []; for (let current = node; current && values.length < 24; current = current.parentElement) values.push(describe(current)); return values }
  const state = { notAcceptance: true, layoutReadsBeforeMove: 0, attemptedMoves: 0, actualMoves: 0, moveErrors: 0, eventCount: 0, droppedEvents: 0, events: [] }
  const owners = () => { const panel = document.getElementById('pmo-teams-topic-floating-panel'), root = panel?.querySelector('.workspace-workbench'); return { panel: describe(panel), root: describe(root), rootParentChain: chain(root?.parentElement), bodies: [...root?.children ?? []].filter(node => node.classList.contains('workbench-layout-body') || node.classList.contains('workbench-reference-body')).map(describe) } }
  const note = (event, details) => { state.eventCount++; if (state.events.length < 256) state.events.push({ sequence: state.eventCount, time: performance.now(), event, ...details, owners: owners() }); else state.droppedEvents++ }
  const relevantBody = element => (element.classList.contains('workbench-layout-body') || element.classList.contains('workbench-reference-body')) && !!element.closest('#pmo-teams-topic-floating-panel')
  const relevantAttribute = name => ['data-workbench-layout-state', 'aria-hidden', 'inert'].includes(name)
  Element.prototype.setAttribute = function(name, value) {
    const relevant = relevantAttribute(name) && relevantBody(this)
    if (relevant) note('set-attribute-before', { body: describe(this), name, nextValue: String(value) })
    const returned = nativeSet.call(this, name, value)
    if (relevant) note('set-attribute-after', { body: describe(this), name })
    return returned
  }
  Element.prototype.removeAttribute = function(name) {
    const relevant = relevantAttribute(name) && relevantBody(this)
    if (relevant) note('remove-attribute-before', { body: describe(this), name })
    const returned = nativeRemove.call(this, name)
    if (relevant) note('remove-attribute-after', { body: describe(this), name })
    return returned
  }
  Element.prototype.moveBefore = function(node, before) {
    state.attemptedMoves++
    const relevant = !!this.closest('#pmo-teams-topic-floating-panel') || !!node?.closest('#pmo-teams-topic-floating-panel')
    if (relevant) note('move-before', { node: describe(node), destination: describe(this), sourceChain: chain(node?.parentElement), destinationChain: chain(this) })
    try { const returned = nativeMove.call(this, node, before); state.actualMoves++; if (relevant) note('move-after', { node: describe(node), destination: describe(this), sourceChain: chain(node?.parentElement), destinationChain: chain(this) }); return returned }
    catch (error) { state.moveErrors++; if (relevant) note('move-error', { message: error.message }); throw error }
  }
  const onToggle = event => { if (event.target instanceof Element && event.target.closest('#pmo-teams-topic-floating-panel')) note(event.type, { target: describe(event.target), oldState: event.oldState, newState: event.newState }) }
  document.addEventListener('beforetoggle', onToggle, true); document.addEventListener('toggle', onToggle, true)
  window.privateStyleMoveTrace = state; window.privateStyleMoveIdentity = identity
  window.restorePrivateStyleMoveTrace = () => { Element.prototype.setAttribute = nativeSet; Element.prototype.removeAttribute = nativeRemove; Element.prototype.moveBefore = nativeMove; document.removeEventListener('beforetoggle', onToggle, true); document.removeEventListener('toggle', onToggle, true) }
  note('installed', {})
}
let styleMoveCssCollected = false
async function collectStyleMoveCss(stage) {
  if (styleMoveCssCollected || !win || win.isDestroyed()) return
  styleMoveCssCollected = true
  const headers = [], listener = (_event, method, params) => { if (method === 'CSS.styleSheetAdded') headers.push(params.header) }
  win.webContents.debugger.on('message', listener)
  const output = { stage, notAcceptance: true, collectionAfterOriginalCounter: true, bodies: [] }
  try {
    await win.webContents.debugger.sendCommand('DOM.enable'); await win.webContents.debugger.sendCommand('CSS.enable')
    const documentNode = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 1 })
    for (const body of ['workbench-layout-body', 'workbench-reference-body']) {
      const selector = '#pmo-teams-topic-floating-panel .workspace-workbench > .' + body
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector })
      if (!nodeId) { output.bodies.push({ body, unavailable: true }); continue }
      const raw = await win.webContents.executeJavaScript(`(()=>{const body=document.querySelector(${JSON.stringify(selector)}),describe=e=>{if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect();return{key:window.privateStyleMoveIdentity(e),parentKey:window.privateStyleMoveIdentity(e.parentElement),tag:e.tagName,class:e.className,attributes:[...e.attributes].map(a=>[a.name,a.value]),rect:{x:r.x,y:r.y,width:r.width,height:r.height,clientRects:e.getClientRects().length},computed:Object.fromEntries(['position','display','visibility','pointer-events','clip-path','width','height','contain','content-visibility','transform'].map(k=>[k,s.getPropertyValue(k)]))}};const parentChain=[];for(let e=body;e&&parentChain.length<24;e=e.parentElement)parentChain.push(describe(e));return{own:describe(body),matchesParked:body.matches('.'+${JSON.stringify(body)}+'[data-workbench-layout-state="parked"]'),sameOriginalSplitBody:window.originalFloatingSplit?.closest('.workbench-layout-body')===body,parentChain}})()`)
      const [attributes, matched, computed, box] = await Promise.all([
        win.webContents.debugger.sendCommand('DOM.getAttributes', { nodeId }),
        win.webContents.debugger.sendCommand('CSS.getMatchedStylesForNode', { nodeId }),
        win.webContents.debugger.sendCommand('CSS.getComputedStyleForNode', { nodeId }),
        win.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId }).catch(error => ({ error: error.message }))
      ])
      output.bodies.push({ body, nodeId, raw, attributes, matched, computed, box })
    }
  } catch (error) { output.error = error.message }
  finally { win.webContents.debugger.removeListener('message', listener) }
  output.styleSheetHeaders = headers
  const file = phase + '-post-counter-style-diagnostics.json', bytes = JSON.stringify(output, null, 2)
  await fs.writeFile(path.join(evidence, file), bytes)
  result.styleMoveCssDiagnostics = { stage, file, sha256: createHash('sha256').update(bytes).digest('hex'), notAcceptance: true }
}
const bounded = async (work, label, budget = 12000) => {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Private frame timeout: ' + label)), budget) })]) }
  finally { clearTimeout(timer) }
}
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write('Renderer: ' + message + '\n') })
    result.step = 'actual-App-ordinary-initialize'
    await bounded(win.loadFile(html, { query: { phase } }), result.step)
    const read = expression => { try { new Function(expression) } catch (error) { throw new Error('Private proof expression syntax: ' + error.message + ' in ' + expression) }; return bounded(win.webContents.executeJavaScript(expression), 'Renderer observation') }
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read('Boolean(' + expression + ')')) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Private frame did not settle: ' + expression)
    }
    const facts = () => read('window.sharedFrameProof.facts()')
    await until('window.sharedFrameProof?.ready && !!document.querySelector("[data-pmo-teams-topic-launcher] button")')
    if (preMoveReadDiagnostic) {
      result.notAcceptance=true
      await read(`(()=>{const original=Element.prototype.moveBefore,state={notAcceptance:true,reads:0,attempts:0,actualMoves:0,errors:0,moves:[]};window.privatePreMoveReadDiagnostic=state;Element.prototype.moveBefore=function(node,before){const rect=this.getBoundingClientRect();state.reads++;state.attempts++;const record={destinationClass:this.className,destinationId:this.id,nodeClass:node?.className,nodeId:node?.id,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};try{const value=original.call(this,node,before);state.actualMoves++;record.completed=true;return value}catch(error){state.errors++;record.error=error.message;throw error}finally{if(state.moves.length<256)state.moves.push(record)}};window.restorePrivatePreMoveReadDiagnostic=()=>{Element.prototype.moveBefore=original}})()`)
    }
    if (styleMoveTraceDiagnostic) { result.notAcceptance=true; await read('('+installPrivateStyleMoveTrace.toString()+')()') }
    if (preMoveStyleReadDiagnostic) { result.notAcceptance=true; await read('('+installPrivatePreMoveStyleReadDiagnostic.toString()+')()') }
    if (serviceHintDiagnostic) {
      result.serviceHintDiagnostic={probe:true,changesProductSource:false,changesOnly:'Private original .service-disclosure__details popover auto-to-hint, including newly mounted owners',notAcceptance:true}
      await read(`(()=>{window.privateServiceHintTargets=[];const apply=()=>{for(const e of document.querySelectorAll('.service-disclosure__details[popover="auto"]')){window.privateServiceHintTargets.push({id:e.id,previous:e.getAttribute('popover'),scope:e.getAttribute('aria-label')});e.setAttribute('popover','hint')}};apply();window.privateServiceHintDiagnosticObserver=new MutationObserver(apply);window.privateServiceHintDiagnosticObserver.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['popover']})})()`)
    }
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => bounded(win.webContents.debugger.sendCommand(method, params), 'Actual Chromium input')
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const panel = 'document.getElementById("pmo-teams-topic-floating-panel")'
    await read(`(()=>{window.sharedFrameKeyEvents=[];const describe=e=>e instanceof Element?{tag:e.tagName,id:e.id,class:e.className,role:e.getAttribute('role'),popover:e.getAttribute('popover'),overlay:e.getAttribute('data-overlay-layer'),inert:!!e.closest('[inert]')}:null;const note=(stage,event)=>{if(event.key!=='Escape')return;const target=event.target,owner=target instanceof Element?target.closest('[data-overlay-layer]:not([data-overlay-layer="window-chrome"]), [popover], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]'):null;window.sharedFrameKeyEvents.push({stage,key:event.key,isComposing:event.isComposing,keyCode:event.keyCode,defaultPrevented:event.defaultPrevented,cancelBubble:event.cancelBubble,target:describe(target),active:describe(document.activeElement),foreignOwner:describe(owner),openPopovers:[...document.querySelectorAll('[popover]:popover-open')].map(describe),path:event.composedPath().filter(e=>e instanceof Element).map(describe)});};document.addEventListener('keydown',event=>{note('document-capture',event);if(event.key==='Escape'){event.target?.addEventListener?.('keydown',event=>note('target-bubble',event),{once:true,passive:true});queueMicrotask(()=>note('capture-microtask',event));}},{capture:true,passive:true});${panel}.addEventListener('keydown',event=>note('panel-bubble',event),{passive:true});document.addEventListener('keydown',event=>note('document-bubble',event),{passive:true});})()`)
    const entry = 'document.querySelector("[data-pmo-teams-topic-launcher] button")'
    const selector = (scope, query) => '[...' + scope + '.querySelectorAll(' + JSON.stringify(query) + ')].find(e=>!e.closest("[hidden],[inert]"))'
    const button = (scope, label) => '[...' + scope + '.querySelectorAll("button")].find(e=>!e.closest("[hidden],[inert]")&&e.textContent.trim()===' + JSON.stringify(label) + ')'
    const click = async expression => {
      await until('(()=>{const e=' + expression + ';if(!e?.isConnected)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0})()')
      const observePoint = () => read('(()=>{const e=' + expression + ';if(!e)throw new Error(' + JSON.stringify('Missing actual control: ' + expression) + ');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(h===e||e.contains(h)))throw new Error(' + JSON.stringify('Actual control is covered: ' + expression + ' hit=') + '+h?.outerHTML);let pmLastClick=null,pmObservationError=null;try{const editor=e.closest(".tiptap"),view=editor?.pmViewDesc?.view??editor?.editor?.view;if(view?.input?.lastClick)pmLastClick={...view.input.lastClick}}catch(error){pmObservationError=error.message};return{x,y,time:Date.now(),pmLastClick,pmObservationError,hit:{tag:h.tagName,id:h.id,class:h.className},target:{tag:e.tagName,id:e.id,class:e.className}}})()')
      let point = await observePoint()
      const previousEditorClick = point.pmLastClick
      // The driver asks for a single click. ProseMirror independently counts
      // nearby clicks within500ms, even when Chromium event.detail is1.
      // Separate this intended gesture; preserve real multi-click behavior.
      if (previousEditorClick && point.time - previousEditorClick.time < 501 &&
        (point.x-previousEditorClick.x)**2+(point.y-previousEditorClick.y)**2 < 100) {
        const waitMs = 501 - (point.time-previousEditorClick.time)
        await pause(waitMs)
        point = await observePoint()
        assert.ok(point.pmLastClick && point.time-point.pmLastClick.time > 500, 'The intended original Editor single-click is outside its previous multi-click window')
        ;(result.singleClickCadence ??= []).push({expression,waitMs,previousEditorClick,actualPreClick:point})
      }
      ;(result.pointerActions ??= []).push({expression,point})
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, x:point.x, y:point.y, button: 'left', clickCount: 1 })
    }
    const key = async (key, code = key, windowsVirtualKeyCode) => {
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key, code, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) })
    }
    const capture = async name => {
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      // Capture the settled original finite button transitions; keep motion and
      // selection owned by product CSS. Never wait on perpetual avatar motion.
      const functionalSelection = await read(`(async()=>{const controls=[...document.querySelectorAll('.mote-details .source-control-switch button')].filter(e=>!e.closest('[hidden],[inert]')&&e.getClientRects().length),transitions=controls.flatMap(e=>e.getAnimations()).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity),started=performance.now(),observed=transitions.map(a=>({property:a.transitionProperty??null,currentTime:a.currentTime,duration:a.effect?.getTiming().duration}));await Promise.all(transitions.map(a=>a.finished.catch(()=>undefined)));return{observed,elapsedMs:performance.now()-started,lists:[...new Set(controls.map(e=>e.parentElement))].map(list=>({topic:list.closest('[data-mote-details]')?.dataset.moteDetails,tabpanel:list.parentElement.querySelector('[role=tabpanel]')?.getAttribute('aria-label'),controls:[...list.querySelectorAll('button')].map(e=>({text:e.textContent,selected:e.getAttribute('aria-selected'),class:e.className,color:getComputedStyle(e).color}))}))}})()`)
      const file = phase + '-' + name + '.png', png = (await bounded(win.webContents.capturePage(), 'Renderer capture')).toPNG()
      await fs.writeFile(path.join(evidence, file), png)
      const presentationGeometry=await read(`(()=>{const p=${panel},rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,clientRects:e.getClientRects().length}},visible=e=>!e.closest('[hidden],[inert]')&&e.getClientRects().length>0;return{viewport:{width:innerWidth,height:innerHeight},floating:p.matches(':popover-open')?{frame:rect(p),files:rect(p.querySelector('.mote-workface__files')),workbench:rect(p.querySelector('.workspace-workbench')),groups:[...p.querySelectorAll('.pane-group')].filter(visible).map(g=>({id:g.dataset.paneGroupId,bounds:rect(g),editor:rect(g.querySelector('.composer__editor')),text:g.innerText.slice(-160)}))}:null,space:{rail:rect(document.querySelector('.project-rail-shell')),tools:rect(document.querySelector('.surface-tool-dock')),main:rect(document.querySelector('.workspace-main-surface'))}}})()` )
      result.frames.push({ name, file, sha256: createHash('sha256').update(png).digest('hex'), source: serviceHintDiagnostic ? 'actual-private-Renderer-service-popover-hint-probe-not-acceptance' : 'actual-complete-App-private-Renderer', presentationGeometry, functionalSelection, facts: await facts() })
    }
    const disclosureGeometry = () => read(`(()=>{const root=${panel};return[...root.querySelectorAll('.service-disclosure__details')].map(e=>{const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}},close=e.querySelector('.service-disclosure__close'),r=close?.getBoundingClientRect(),hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{id:e.id,open:e.matches(':popover-open'),maxHeight:getComputedStyle(e).maxHeight,details:rect(e),close:rect(close),closeHit:hit?.className,closeReachable:!!close&&(hit===close||close.contains(hit)),workspace:rect(e.closest('.workspace-workbench')),region:rect(e.closest('[data-workbench-region-id]')),text:e.innerText}})})()`)
    const spaceGeometry = () => read(`(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{viewport:innerWidth,rail:rect(document.querySelector('.project-rail-shell')),tools:rect(document.querySelector('.surface-tool-dock')),main:rect(document.querySelector('.workspace-main-surface')),groups:[...document.querySelectorAll('.workspace-workbench-slot[data-visible="true"] .pane-group')].map(e=>({bounds:rect(e),composer:rect(e.querySelector('.composer__editor')),text:e.innerText.slice(-180)})),header:document.querySelector('.surface-tool-dock .workspace-tool-context')?.innerText}})()`)
    const resizeTools = async deltaX => {
      const point = await read('(()=>{const e=document.querySelector(".surface-tool-dock .surface-tool-width-handle"),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(h===e||e.contains(h)))throw new Error("Original tool resize handle is covered");return{x,y}})()')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await input('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + deltaX, y: point.y, button: 'left', buttons: 1 })
      await input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + deltaX, y: point.y, button: 'left', clickCount: 1 })
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const revealNarrowNoteIssue = async () => {
      const scroller = selector(panel, '.mote-details__content')
      const point = await read('(()=>{const e=' + scroller + ',r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      await input('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 320 })
      await until('(()=>{const e=' + selector(panel, '.mote-details__issue') + ',p=' + scroller + ';if(!e||!p)return false;const r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom})()')
      result.narrowNoteIssue = await read('(()=>{const p=' + scroller + ',e=' + selector(panel, '.mote-details__issue') + ',r=e.getBoundingClientRect(),b=p.getBoundingClientRect(),button=e.querySelector("button"),q=button.getBoundingClientRect(),hit=document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);return{scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,issueText:e.innerText,fullyVisible:r.top>=b.top&&r.bottom<=b.bottom,retryReachable:hit===button||button.contains(hit)}})()')
      assert.equal(result.narrowNoteIssue.fullyVisible, true); assert.equal(result.narrowNoteIssue.retryReachable, true)
    }
    const visible = async (topic, tab) => {
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.moteTargetTopic===' + JSON.stringify(topic) + ' && (' + panel + '.dataset.moteTargetTab??null)===' + JSON.stringify(tab))
      const current = await facts(); assert.equal(current.floating.targetTopicId, topic); assert.equal(current.floating.targetTabId, tab)
      return current
    }
    const size = async (width, height = 760) => { win.setContentSize(width, height); await until('innerWidth===' + width); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
    const chooseMote = async (id, tab) => { await click(selector(panel, '[data-mote-topic-id="' + id + '"]')); return visible(id, tab) }
    const chooseSection = async (scope, label) => {
      await click(button(scope, label))
      await until(selector(scope, '[role="tabpanel"][aria-label="Mote ' + label.toLowerCase() + '"]'))
    }
    const primary = 'launcher:leader', target = 'mote-primary-tab', custom = 'launcher:reviewer'
    const reference = { displayWorkspaceId: '__scratch__', groupId: 'original-mote-second', tabId: target, regionId: 'mote-primary-region' }
    const forbidden = current => {
      const baseline = current.initialization.afterOrdinaryInitialize.calls
      assert.deepEqual(current.calls.slice(0, baseline.length), baseline, 'Exact ordinary-initialize call prefix is retained')
      return [...current.calls.filter(call => ['stop', 'launchAgent', 'write', 'submitPrompt', 'fileWrite'].includes(call.operation)),
        ...current.calls.slice(baseline.length).filter(call => call.operation === 'launchTerminal')]
    }
    const protectedFacts = current => ({ project: current.tabs['original-project-tab'], drafts: current.drafts,
      outbox: current.outbox, runs: current.runs, viewModes: current.viewModes, execution: current.focus.execution })
    const root = 'document'
    const exactPrimaryEditor = '[data-workbench-group-id="original-mote-second"][data-workbench-tab-id="mote-primary-tab"] .composer__editor .tiptap'
    const editor = selector(panel, exactPrimaryEditor + ', [data-workbench-retained-reference="mote-primary-tab"] .composer__editor .tiptap')
    const caret = (expression = editor, original = 'window.originalHealthyEditor') => read(`(()=>{const e=${expression},s=getSelection();let offset=null;if(e&&s?.anchorNode&&e.contains(s.anchorNode)){const r=document.createRange();r.selectNodeContents(e);r.setEnd(s.anchorNode,s.anchorOffset);offset=r.toString().length}return{same:e===${original},connected:!!e?.isConnected,text:e?.textContent,focused:document.activeElement===e,inert:!!e?.closest('[inert]'),hidden:!!e?.closest('[hidden]'),collapsed:s?.isCollapsed,offset}})()`)
    result.initial = await facts()
    assert.equal(result.initial.initialization.initializeCalls, 1)
    result.ordinaryStartupCalls = result.initial.initialization.afterOrdinaryInitialize.calls
    const deniedWarm = result.ordinaryStartupCalls.filter(call=>call.operation==='launchTerminal')
    assert.equal(deniedWarm.length, phase === 'seed' ? 1 : 0, 'Original cold empty Launcher has one denied automatic warm; restored workfaces need no new Run')
    assert.ok(deniedWarm.every(call=>call.denied===true), 'The controlled API rejects this optional startup request and creates no Session/Run')
    assert.deepEqual(forbidden(result.initial), [])
    result.checks.push({name:'Original-initialize-exact-call-baseline-one-denied-optional-warm-no-created-Run-no-later-launch',passed:true,calls:result.ordinaryStartupCalls})
    if (phase === 'seed') {
      assert.equal(result.initial.initialization.seedApplied, true)
      await visible(primary, target)
      await until(editor + '?.textContent==="Original unsent draft · mote-primary"')
      assert.deepEqual((await facts()).floating.reference, reference)
      await capture('wide-floating-public-workbench')
      await size(640, 680); await capture('narrow-floating-public-workbench')
      const narrowRailModeButton = selector(panel, '[aria-label="Show Mote avatars only"]')
      const beforeNarrowRail = await facts()
      await click(narrowRailModeButton); await until(panel + '.dataset.moteNavigation==="avatars"')
      await click(editor); await key('ArrowLeft', 'ArrowLeft', 37)
      const narrowAvatarCaret = await caret(editor, editor)
      assert.equal(narrowAvatarCaret.focused,true); assert.equal(narrowAvatarCaret.inert,false)
      await capture('narrow-floating-original-avatars-control-readable-workface')
      const afterNarrowRail = await facts()
      for (const key of ['tabs','layouts','drafts','runs']) assert.deepEqual(afterNarrowRail[key],beforeNarrowRail[key])
      assert.deepEqual(afterNarrowRail.floating.reference,beforeNarrowRail.floating.reference)
      await click(narrowRailModeButton); await until(panel + '.dataset.moteNavigation==="cards"'); await size(1100)
      result.step = 'actual-hover-preview-pin-reuses-original-primary'
      await read('window.hoverOriginalEditor=' + editor)
      await click(selector(panel, '[aria-label="Close Mote"]')); await until('!' + panel + '.matches(":popover-open")')
      const entryPoint = await read('(()=>{const r=' + entry + '.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...entryPoint })
      await until('window.sharedFrameProof.facts().floatingState.preview===true && ' + panel + '.matches(":popover-open")')
      assert.equal(await read(editor + '===window.hoverOriginalEditor'), true)
      assert.equal(await read('!!' + editor + '?.closest("[inert]")'), false)
      await click(entry); await visible(primary, target)
      assert.equal((await facts()).floatingState.preview, false)
      assert.equal(await read(editor + '===window.hoverOriginalEditor'), true)
      result.checks.push({ name: 'Chromium-hover-preview-pin-preserves-original-primary-editor', passed: true })
      result.step = 'actual-focused-Space-same-Mote-Composer-passive-hover-caret'
      await click(selector(panel, '[aria-label="Open Mote Space"]')); await until('!' + panel + '.matches(":popover-open")')
      await read('window.sharedFrameProof.prepareSpace()')
      const spaceEditor = selector(root, '.workspace-workbench-slot[data-visible="true"] ' + exactPrimaryEditor)
      await until(spaceEditor + '?.textContent==="Original unsent draft · mote-primary"')
      await read('window.spaceHoverOriginalEditor=' + spaceEditor)
      await read(`(()=>{window.sharedFrameFocusEvents=[];const describe=e=>e?{tag:e.tagName,class:e.className,sameOriginal:e===window.spaceHoverOriginalEditor||e===window.primarySpaceHoverOriginalEditor,inert:!!e.closest?.('[inert]')}:null;for(const type of ['focusin','focusout'])document.addEventListener(type,event=>{window.sharedFrameFocusEvents.push({type,target:describe(event.target),related:describe(event.relatedTarget),active:describe(document.activeElement),floating:window.sharedFrameProof.facts().floatingState});},{capture:true,passive:true});})()`)
      await click(spaceEditor); await key('ArrowLeft', 'ArrowLeft', 37)
      const beforeSpaceHover = await caret(spaceEditor, 'window.spaceHoverOriginalEditor')
      assert.equal(beforeSpaceHover.focused, true); assert.equal(beforeSpaceHover.inert, false); assert.equal(beforeSpaceHover.collapsed, true)
      const spaceEntryPoint = await read('(()=>{const r=' + entry + '.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...spaceEntryPoint })
      await until('window.sharedFrameProof.facts().floatingState.preview===true && ' + panel + '.matches(":popover-open")')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal((await facts()).floatingState.open, false, 'Hover remains passive; it never pins')
      const afterSpaceHover = await caret('window.spaceHoverOriginalEditor', 'window.spaceHoverOriginalEditor')
      result.focusedSpaceHover = { reference, before: beforeSpaceHover, after: afterSpaceHover, floatingReader: await caret(editor, 'window.spaceHoverOriginalEditor'), samePhysicalSpaceSlot: await read(spaceEditor + '===window.spaceHoverOriginalEditor'), focusEvents: await read('window.sharedFrameFocusEvents') }
      assert.deepEqual(afterSpaceHover, beforeSpaceHover, 'Actual Space same-entity Composer preserves focus and exact caret through passive hover')
      assert.equal(result.focusedSpaceHover.samePhysicalSpaceSlot, true, 'The original secondary occurrence remains in its same Space slot')
      await capture('wide-focused-Space-same-Mote-passive-hover')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1098, y: 2 })
      await until('window.sharedFrameProof.facts().floatingState.preview===false && !' + panel + '.matches(":popover-open")')
      result.step = 'actual-focused-Space-primary-Mote-Composer-passive-hover-caret'
      const firstReference = { ...reference, groupId: 'original-mote-first' }
      const firstSpaceEditor = selector(root, '.workspace-workbench-slot[data-visible="true"] [data-workbench-group-id="original-mote-first"][data-workbench-tab-id="mote-primary-tab"] .composer__editor .tiptap')
      await read('window.sharedFrameProof.setFloating({reference:' + JSON.stringify(firstReference) + '})')
      await until(firstSpaceEditor + '?.textContent==="Original unsent draft · mote-primary"')
      await read('window.primarySpaceHoverOriginalEditor=' + firstSpaceEditor)
      await click(firstSpaceEditor); await key('ArrowLeft', 'ArrowLeft', 37)
      const beforePrimaryHover = await caret('window.primarySpaceHoverOriginalEditor', 'window.primarySpaceHoverOriginalEditor')
      assert.equal(beforePrimaryHover.focused, true); assert.equal(beforePrimaryHover.inert, false); assert.equal(beforePrimaryHover.collapsed, true)
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...spaceEntryPoint })
      await until('window.sharedFrameProof.facts().floatingState.preview===true && ' + panel + '.matches(":popover-open")')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const afterPrimaryHover = await caret('window.primarySpaceHoverOriginalEditor', 'window.primarySpaceHoverOriginalEditor')
      result.focusedPrimarySpaceHover = { reference: firstReference, before: beforePrimaryHover, after: afterPrimaryHover, placement: await read('({insideFloating:' + panel + '.contains(window.primarySpaceHoverOriginalEditor),group:window.primarySpaceHoverOriginalEditor.closest("[data-workbench-group-id]")?.dataset.workbenchGroupId,activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className})'), focusEvents: await read('window.sharedFrameFocusEvents') }
      assert.equal((await facts()).floatingState.open, false, 'Primary hover remains passive')
      assert.deepEqual(afterPrimaryHover, beforePrimaryHover, 'Actual original primary input retains focus and exact caret when passive preview changes its presentation')
      await capture('wide-focused-primary-Space-Mote-passive-hover')
      await click(entry); await visible(primary, target)
      await read('new Promise(resolve=>queueMicrotask(()=>requestAnimationFrame(resolve)))')
      const afterPin = await caret('window.primarySpaceHoverOriginalEditor', 'window.primarySpaceHoverOriginalEditor')
      assert.deepEqual(afterPin, beforePrimaryHover, 'Mouse pin follows the original entry preventDefault owner and preserves the already-focused input/caret')
      result.checks.push({ name: 'Actual-Space-primary-and-secondary-Mote-focused-inputs-passive-hover-and-mouse-pin-exact-caret', passed: true, beforeSpaceHover, afterSpaceHover, beforePrimaryHover, afterPrimaryHover, afterPin })
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      result.step = 'floating-original-Files-and-functional-groups'
      await click(selector(panel, '[aria-label="Mote files"]'))
      await until(selector(panel, '[data-mote-details="' + primary + '"]'))
      await capture('wide-floating-profile-and-common-files')
      await size(600, 680); await capture('narrow-floating-profile-and-common-files')
      const beforeNarrowProfileControls = await facts()
      await click(narrowRailModeButton); await until(panel + '.dataset.moteNavigation==="avatars"')
      await capture('narrow-floating-profile-original-avatars-control')
      await click(selector(panel, '[aria-label="Mote files"]')); await until('!'+selector(panel,'[data-mote-details="'+primary+'"]'))
      await click(editor); await key('ArrowLeft','ArrowLeft',37)
      await capture('narrow-floating-original-Files-close-and-avatars-workface')
      assert.equal((await caret(editor,editor)).focused,true)
      const afterNarrowProfileControls = await facts()
      for (const key of ['tabs','layouts','drafts','runs']) assert.deepEqual(afterNarrowProfileControls[key],beforeNarrowProfileControls[key])
      assert.deepEqual(afterNarrowProfileControls.floating.reference,beforeNarrowProfileControls.floating.reference)
      result.checks.push({name:'Actual-original-narrow-avatars-control-and-Files-close-keep-exact-reference-original-layout-draft-Run-and-live-input',passed:true,narrowAvatarCaret})
      await click(selector(panel, '[aria-label="Mote files"]')); await until(selector(panel,'[data-mote-details="'+primary+'"]'))
      await click(narrowRailModeButton); await until(panel + '.dataset.moteNavigation==="cards"'); await size(1100)
      await chooseSection(panel, 'Persona'); await capture('wide-floating-persona')
      await size(600, 680); await capture('narrow-floating-persona'); await size(1100)
      const first = (await facts()).layouts.__scratch__.groups.find(group => group.id === 'original-mote-first')
      await click(button(panel, 'Edit'))
      await until('window.sharedFrameProof.facts().floating.targetTabId!=="mote-primary-tab"')
      const persona = await facts(), personaTab = persona.tabs[persona.floating.targetTabId]
      assert.equal(personaTab.workspaceId, '__scratch__'); assert.ok(Object.values(personaTab.regions).some(region => region.kind === 'file' && region.path.endsWith('/SOUL.md')))
      assert.equal(persona.floating.reference.groupId, 'original-mote-second'); assert.deepEqual(persona.layouts.__scratch__.groups.find(group => group.id === 'original-mote-first'), first)
      assert.deepEqual(protectedFacts(persona), protectedFacts(result.initial)); result.checks.push({ name: 'Persona-edit-original-File-owner-exact-second-occurrence', passed: true })
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      await click(selector(panel, '[aria-label="Mote files"]')); await until(selector(panel, '[data-mote-details="' + primary + '"]'))
      await chooseSection(panel, 'Ideas')
      await until(selector(panel, '.mote-details__note'))
      await click(selector(panel, '.mote-details__note'))
      await until(selector(panel, '.mote-details__preview') + '?.textContent.includes("A useful next step")')
      await capture('wide-floating-ideas-original-note')
      await size(600, 680); await capture('narrow-floating-ideas-original-note'); await size(1100)
      result.step = 'original-note-read-failure-keeps-file-and-healthy-workface'
      const beforeReadFailure = await facts()
      await read('window.sharedFrameProof.setNoteReadFailure(true)')
      await chooseSection(panel, 'Persona'); await chooseSection(panel, 'Ideas')
      await until(selector(panel, '.mote-details__note'))
      await click(selector(panel, '.mote-details__note'))
      await until(selector(panel, '.mote-details__issue') + '?.textContent.includes("Original note is temporarily unavailable")')
      const failedRead = await facts()
      assert.deepEqual(failedRead.tabs, beforeReadFailure.tabs); assert.deepEqual(failedRead.runs, beforeReadFailure.runs)
      assert.deepEqual(failedRead.files, beforeReadFailure.files); assert.deepEqual(failedRead.drafts, beforeReadFailure.drafts)
      assert.equal(await read(panel + '.matches(":popover-open")'), true)
      await capture('wide-floating-original-note-read-unavailable')
      await size(600, 680); await capture('narrow-floating-original-note-read-unavailable')
      await revealNarrowNoteIssue(); await capture('narrow-floating-original-note-read-unavailable-scrolled')
      await size(1100)
      await read('window.sharedFrameProof.setNoteReadFailure(false)')
      await click(button(panel, 'Retry'))
      await until(selector(panel, '.mote-details__preview') + '?.textContent.includes("A useful next step") && !' + selector(panel, '.mote-details__issue'))
      result.checks.push({ name: 'Original-note-read-unavailable-and-retry-keeps-files-drafts-tabs-runs-and-Mote-parent', passed: true })
      result.step = 'Ideas-opens-original-durable-note'
      await click(button(panel, 'Open file'))
      await until('window.sharedFrameProof.facts().floating.targetTabId!=="mote-primary-tab"')
      const note = await facts(); assert.equal(note.floating.reference.groupId, 'original-mote-second')
      assert.ok(Object.values(note.tabs[note.floating.targetTabId].regions).some(region => region.kind === 'file' && region.path.endsWith('/next-step.md')))
      result.checks.push({ name: 'Ideas-preview-and-open-original-durable-note', passed: true })
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      result.step = 'bad-saved-tuple-retains-healthy-original-input-and-internal-disclosure'
      if (commitIntervalDiagnostic) {
        result.notAcceptance = true
        await startNativeCommitTrace()
        await read('(' + installPrivateCommitIntervalTrace.toString() + ')()')
      }
      await read('window.originalHealthyEditor=' + editor + ';window.originalFloatingFrame=' + selector(panel,'.workspace-workbench') + ';window.originalFloatingSplit=window.originalFloatingFrame.querySelector(".workbench-layout-body > .pane-split, .workbench-layout-body > .pane-group");window.originalFloatingGroup=window.originalHealthyEditor.closest(".pane-group");window.originalFloatingTabSlot=window.originalHealthyEditor.closest(".workbench-tab-slot")')
      await click(editor); await key('ArrowLeft', 'ArrowLeft', 37)
      const beforeCaret = await caret(); assert.equal(beforeCaret.focused, true); assert.equal(beforeCaret.inert, false); assert.equal(beforeCaret.collapsed, true)
      const beforeUnknownAddressFacts = await facts()
      await read('window.sharedFrameProof.showAmbiguousReference()')
      await until(selector(panel, '[data-workbench-retained-reference="' + target + '"]'))
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.deepEqual(await caret(), beforeCaret, 'Ambiguous tuple keeps the same live editor, focus and exact caret')
      assert.equal(await read(selector(panel, '.workspace-workbench') + '===window.originalFloatingFrame'), true, 'Ambiguous tuple keeps the same original frame DOM')
      result.unknownReferenceBody = await read('(()=>{const s=window.originalFloatingSplit,e=window.originalHealthyEditor,b=s?.closest(".workbench-layout-body"),g=e.closest(".pane-group"),style=getComputedStyle(b),r=s.getBoundingClientRect(),br=b.getBoundingClientRect(),er=e.getBoundingClientRect(),gr=g.getBoundingClientRect(),editorHit=document.elementFromPoint(er.x+er.width/2,er.y+er.height/2);return{sameSplit:window.originalFloatingFrame.querySelector(".workbench-layout-body > .pane-split, .workbench-layout-body > .pane-group")===s,splitConnected:!!s?.isConnected,splitHidden:!!s?.closest("[hidden]"),splitInert:!!s?.closest("[inert]"),parked:b.dataset.workbenchLayoutState??null,ariaHidden:b.getAttribute("aria-hidden"),bodyPosition:style.position,bodyVisibility:style.visibility,bodyPointerEvents:style.pointerEvents,bodyClipPath:style.clipPath,bodyRect:{x:br.x,y:br.y,width:br.width,height:br.height,clientRects:b.getClientRects().length},splitRect:{width:r.width,height:r.height,clientRects:s.getClientRects().length},samePhysicalGroup:g===window.originalFloatingGroup,sameTabSlot:e.closest(".workbench-tab-slot")===window.originalFloatingTabSlot,groupId:g.dataset.paneGroupId,editorContained:er.x>=gr.x-1&&er.y>=gr.y-1&&er.right<=gr.right+1&&er.bottom<=gr.bottom+1,editorHidden:!!e.closest("[hidden]"),editorInert:!!e.closest("[inert]"),editorParked:!!e.closest("[data-workbench-layout-state=parked]"),editorAriaHidden:!!e.closest("[aria-hidden=true]"),editorConnected:e.isConnected,editorHittable:editorHit===e||e.contains(editorHit),entityBodyCount:window.originalFloatingFrame.querySelectorAll(".workbench-reference-body").length}})()')
      assert.equal(result.unknownReferenceBody.sameSplit, true); assert.equal(result.unknownReferenceBody.splitConnected, true)
      assert.equal(result.unknownReferenceBody.splitHidden, false); assert.equal(result.unknownReferenceBody.splitInert, false)
      assert.equal(result.unknownReferenceBody.parked, null); assert.equal(result.unknownReferenceBody.ariaHidden, null)
      assert.equal(result.unknownReferenceBody.bodyPosition, 'static'); assert.equal(result.unknownReferenceBody.bodyVisibility, 'visible')
      assert.equal(result.unknownReferenceBody.bodyPointerEvents, 'auto'); assert.equal(result.unknownReferenceBody.bodyClipPath, 'none')
      for (const rect of [result.unknownReferenceBody.bodyRect,result.unknownReferenceBody.splitRect]) assert.ok(rect.width>0&&rect.height>0&&rect.clientRects>0,'The original confirmed layout stays visible in its original Group')
      assert.equal(result.unknownReferenceBody.samePhysicalGroup, true); assert.equal(result.unknownReferenceBody.sameTabSlot, true)
      assert.equal(result.unknownReferenceBody.groupId, reference.groupId); assert.equal(result.unknownReferenceBody.editorContained, true)
      assert.equal(result.unknownReferenceBody.editorHidden, false); assert.equal(result.unknownReferenceBody.editorInert, false)
      assert.equal(result.unknownReferenceBody.editorParked, false); assert.equal(result.unknownReferenceBody.editorAriaHidden, false)
      assert.equal(result.unknownReferenceBody.editorHittable, true); assert.equal(result.unknownReferenceBody.entityBodyCount, 0)
      const unknownAddressFacts = await facts()
      assert.deepEqual(unknownAddressFacts.focus,beforeUnknownAddressFacts.focus,'An unconfirmed occurrence does not write a guessed Agent focus address')
      assert.deepEqual(unknownAddressFacts.layouts,beforeUnknownAddressFacts.layouts,'An unconfirmed occurrence does not rewrite the original layout or active Group')
      assert.deepEqual(unknownAddressFacts.selection,beforeUnknownAddressFacts.selection)
      await read('window.originalRetainedNoticeTrigger=' + selector(panel,'.service-disclosure__trigger') + ';window.originalRetainedNoticeDisclosure=window.originalRetainedNoticeTrigger?.closest(".service-disclosure");window.originalRetainedNoticeDetails=document.getElementById(window.originalRetainedNoticeTrigger?.getAttribute("aria-controls"))')
      if (noDisclosureOpenDiagnostic) result.disclosureAblation = { notAcceptance: true, omittedOnly: 'Original ambiguous-reference inner hint disclosure open/close interaction', sameOriginalKnownUnknownConfirmation: true }
      else {
      await click(selector(panel, '.service-disclosure__trigger'))
      await until(selector(panel, '.service-disclosure__details') + '?.matches(":popover-open")')
      await read('new Promise(resolve=>queueMicrotask(()=>requestAnimationFrame(resolve)))')
      assert.equal(await read('document.activeElement===' + selector(panel, '.service-disclosure__trigger')), true, 'A later explicit control focus is never stolen by caret repair')
      result.ambiguousDisclosure = await disclosureGeometry()
      await capture('wide-ambiguous-reference-service-details')
      await click(selector(panel, '.service-disclosure__details .service-disclosure__close'))
      }
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      assert.equal(await read(selector(panel, '.workspace-workbench') + '===window.originalFloatingFrame'), true, 'Confirmed tuple keeps the original frame through unknown cutover')
      await click(editor); await key('ArrowLeft', 'ArrowLeft', 37)
      result.confirmedReferenceFrame = await read('(()=>{const w=window.originalFloatingFrame,e=window.originalHealthyEditor,r=w.getBoundingClientRect(),b=e.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);const s=window.originalFloatingSplit,q=s?.getBoundingClientRect();return{sameSplit:s===w.querySelector(".workbench-layout-body > .pane-split, .workbench-layout-body > .pane-group"),split:{connected:!!s?.isConnected,hidden:!!s?.closest("[hidden]"),inert:!!s?.closest("[inert]"),width:q?.width,height:q?.height,clientRects:s?.getClientRects().length},sameFrame:w===' + selector(panel,'.workspace-workbench') + ',sameEditor:e===' + editor + ',frame:{width:r.width,height:r.height,clientRects:w.getClientRects().length},editor:{width:b.width,height:b.height,connected:e.isConnected,inert:!!e.closest("[inert]"),hittable:hit===e||e.contains(hit)},reference:window.sharedFrameProof.facts().floating.reference}})()')
      assert.equal(result.confirmedReferenceFrame.editor.hittable, true); assert.equal(result.confirmedReferenceFrame.editor.inert, false)
      assert.equal(result.confirmedReferenceFrame.sameSplit, true); assert.equal(result.confirmedReferenceFrame.split.hidden, false)
      assert.equal(result.confirmedReferenceFrame.split.inert, false); assert.ok(result.confirmedReferenceFrame.split.width>0 && result.confirmedReferenceFrame.split.height>0 && result.confirmedReferenceFrame.split.clientRects>0)
      result.confirmedBodyPresentation = await read('(()=>{const b=window.originalFloatingSplit.closest(".workbench-layout-body"),s=getComputedStyle(b);return{parked:b.dataset.workbenchLayoutState??null,ariaHidden:b.getAttribute("aria-hidden"),inert:b.inert,hidden:b.hidden,position:s.position,visibility:s.visibility,clipPath:s.clipPath,pointerEvents:s.pointerEvents}})()')
      assert.deepEqual(result.confirmedBodyPresentation,{parked:null,ariaHidden:null,inert:false,hidden:false,position:'static',visibility:'visible',clipPath:'none',pointerEvents:'auto'})
      result.inactiveReferenceBody = await read('({count:window.originalFloatingFrame.querySelectorAll(".workbench-reference-body").length,openDetails:!!window.originalFloatingFrame.querySelector("[popover]:popover-open")})')
      assert.deepEqual(result.inactiveReferenceBody,{count:0,openDetails:false},'Confirmed original Group workface has no duplicate Entity page or open inner disclosure')
      result.retainedNoticeKnown = await read('(()=>{const e=window.originalRetainedNoticeTrigger,d=window.originalRetainedNoticeDisclosure,p=window.originalRetainedNoticeDetails;return{sameTrigger:window.originalFloatingFrame.contains(e)&&e.closest(".service-disclosure")===d,sameDetails:document.getElementById(e.getAttribute("aria-controls"))===p,connected:e.isConnected,hidden:!!e.closest("[hidden]"),detailsOpen:p.matches(":popover-open")}})()')
      assert.deepEqual(result.retainedNoticeKnown,{sameTrigger:true,sameDetails:true,connected:true,hidden:true,detailsOpen:false},'Confirmation keeps the same original notice control hidden without keeping its details open')
      if (noDisclosureOpenDiagnostic) {
        result.notAcceptance = true
        result.acceptanceScope = 'diagnostic-no-disclosure-open'
        result.ablationGroupContainment = await read('(()=>{const e=window.originalHealthyEditor,g=e.closest("[data-pane-group-id]"),r=e.getBoundingClientRect(),b=g?.getBoundingClientRect();return{groupId:g?.dataset.paneGroupId,reference:window.sharedFrameProof.facts().floating.reference,editor:{x:r.x,y:r.y,width:r.width,height:r.height},group:b?{x:b.x,y:b.y,width:b.width,height:b.height}:null,contained:!!b&&r.width>0&&r.height>0&&r.x>=b.x&&r.y>=b.y&&r.right<=b.right&&r.bottom<=b.bottom}})()')
        assert.equal(result.ablationGroupContainment.groupId, reference.groupId)
        assert.equal(result.ablationGroupContainment.contained, true)
        result.finalCaret = await caret()
        assert.equal(result.finalCaret.focused, true)
        assert.equal(result.finalCaret.inert, false)
        assert.equal(result.finalCaret.connected, true)
        await capture('diagnostic-no-disclosure-open-first-confirmation')
        result.final = await facts(); assert.deepEqual(protectedFacts(result.final), protectedFacts(result.initial))
        assert.deepEqual(forbidden(result.final.calls), [])
        result.passed = true
        return
      }
      if (geometryDiagnostic) throw new Error('Bounded geometry diagnostic reached confirmed-reference cutover with visible original editor; diagnostic is not full acceptance')
      const beforeBadCaret = await caret()
      const beforeBad = await facts()
      await read('window.sharedFrameProof.showBadReference()'); await visible(primary, target)
      await until(selector(panel, '[data-workbench-retained-reference="' + target + '"]'))
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.deepEqual(await caret(), beforeBadCaret, 'Bad saved tuple keeps same live editor, focus and caret')
      assert.equal(await read(selector(panel, '.workspace-workbench') + '===window.originalFloatingFrame'), true, 'Bad saved tuple keeps original frame DOM')
      assert.equal(await read(editor + '===window.originalHealthyEditor'), true)
      assert.equal(await read(editor + '?.textContent'), 'Original unsent draft · mote-primary')
      const bad = await facts(); assert.deepEqual(bad.tabs, beforeBad.tabs); assert.deepEqual(protectedFacts(bad), protectedFacts(beforeBad))
      const rawBadReference=bad.floating.reference
      result.retainedNoticeBad = await read('(()=>{const e=window.originalRetainedNoticeTrigger,d=window.originalRetainedNoticeDisclosure,p=window.originalRetainedNoticeDetails,actual=[...window.originalFloatingFrame.querySelectorAll(".service-disclosure__trigger")].filter(e=>!e.closest("[hidden],[inert]"));return{sameTrigger:actual.length===1&&actual[0]===e,sameDisclosure:e.closest(".service-disclosure")===d,sameDetails:document.getElementById(e.getAttribute("aria-controls"))===p,connected:e.isConnected,hidden:!!e.closest("[hidden]"),inert:!!e.closest("[inert]"),detailsOpen:p.matches(":popover-open")}})()')
      assert.deepEqual(result.retainedNoticeBad,{sameTrigger:true,sameDisclosure:true,sameDetails:true,connected:true,hidden:false,inert:false,detailsOpen:false},'A later bad tuple restores the same original notice control, not a replacement or a hidden duplicate')
      assert.deepEqual(rawBadReference,{...reference,groupId:'saved-unconfirmed-group'})
      await click(selector(panel, '.service-disclosure__trigger'))
      await until(selector(panel, '.service-disclosure__details') + '?.matches(":popover-open")')
      assert.equal(await read(panel + '.matches(":popover-open")'), true)
      result.badReferenceDisclosure = await disclosureGeometry(); await capture('wide-bad-reference-service-details')
      await click(selector(panel, '.service-disclosure__details .service-disclosure__close'))
      await until('!' + selector(panel, '.service-disclosure__details') + '.matches(":popover-open")')
      assert.equal(await read(panel + '.matches(":popover-open")'), true)
      assert.deepEqual((await facts()).floating.reference,rawBadReference,'Inner close and automatic same-input focus retain the raw bad tuple')
      await click(selector(panel, '.service-disclosure__trigger')); await until(selector(panel, '.service-disclosure__details') + '.matches(":popover-open")')
      await key('Escape', 'Escape', 27); await until('!' + selector(panel, '.service-disclosure__details') + '.matches(":popover-open")')
      assert.equal(await read(panel + '.matches(":popover-open")'), true)
      await read(`(()=>{
        const e=window.originalHealthyEditor, ids=new WeakMap();let serial=0
        const describe=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++serial);return{id:ids.get(n),type:n.nodeType,name:n.nodeName,text:n.textContent?.slice(0,250),connected:n.isConnected,insideOriginal:e.contains(n),parent:n.parentElement?{tag:n.parentElement.tagName,id:n.parentElement.id,class:n.parentElement.className}:null}}
        const offset=(n,v)=>{if(!e.contains(n))return null;const r=document.createRange();r.selectNodeContents(e);r.setEnd(n,v);return r.toString().length}
        const snapshot=()=>{const s=getSelection();let pmLastClick=null,pmObservationError=null;try{const view=e.pmViewDesc?.view??e.editor?.view;if(view?.input?.lastClick)pmLastClick={...view.input.lastClick}}catch(error){pmObservationError=error.message}return{time:Date.now(),pmLastClick,pmObservationError,activeElement:describe(document.activeElement),sameActiveInput:document.activeElement===e,originalConnected:e.isConnected,text:e.textContent,selection:s?{collapsed:s.isCollapsed,type:s.type,rangeCount:s.rangeCount,anchor:describe(s.anchorNode),anchorOffset:s.anchorOffset,anchorTextOffset:offset(s.anchorNode,s.anchorOffset),focus:describe(s.focusNode),focusOffset:s.focusOffset,focusTextOffset:offset(s.focusNode,s.focusOffset),text:s.toString(),ranges:Array.from({length:s.rangeCount},(_,i)=>{const r=s.getRangeAt(i);return{collapsed:r.collapsed,start:describe(r.startContainer),startOffset:r.startOffset,end:describe(r.endContainer),endOffset:r.endOffset,text:r.toString()}})}:null}}
        const state={diagnosticObservation:true,changedSelection:false,before:snapshot(),events:[],dropped:0},subscriptions=[]
        for(const type of ['pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click'])for(const capture of [true,false]){const record=event=>{if(state.events.length>=32){state.dropped++;return}state.events.push({type:event.type,stage:capture?'capture':'bubble',trusted:event.isTrusted,detail:event.detail,button:event.button,buttons:event.buttons,x:event.clientX,y:event.clientY,pointerType:event.pointerType??null,defaultPrevented:event.defaultPrevented,target:describe(event.target),path:event.composedPath().filter(n=>n instanceof Element).slice(0,8).map(describe),reading:snapshot()})};document.addEventListener(type,record,capture);subscriptions.push([type,record,capture])}
        window.privateCaretPointerObservation=state;window.finishPrivateCaretPointerObservation=()=>{state.after=snapshot();for(const[type,record,capture]of subscriptions)document.removeEventListener(type,record,capture);return state}
      })()`)
      await click(editor)
      result.caretPointerObservation = await read('window.finishPrivateCaretPointerObservation()')
      const insertionCaret = await caret(), insertedText=' · still usable'
      result.beforeInsertionCaret = insertionCaret
      assert.equal(result.caretPointerObservation.after.pmLastClick?.type,'singleClick','The original Editor owner receives the intended real single-click gesture')
      assert.equal(insertionCaret.collapsed,true); assert.ok(insertionCaret.offset>0)
      await input('Input.insertText', { text: insertedText })
      await until(editor + '?.textContent.includes("still usable")')
      result.actualKeyboardInsertion={before:insertionCaret,after:await caret(),insertedText}
      assert.equal(result.actualKeyboardInsertion.after.text,insertionCaret.text.slice(0,insertionCaret.offset)+insertedText+insertionCaret.text.slice(insertionCaret.offset), 'Actual Chromium inserts at the retained exact caret, not the start or a guessed endpoint')
      assert.equal(result.actualKeyboardInsertion.after.offset,insertionCaret.offset+insertedText.length)
      const healthyBad = await facts(); assert.deepEqual(healthyBad.tabs, beforeBad.tabs); assert.deepEqual(healthyBad.runs, beforeBad.runs)
      assert.deepEqual(healthyBad.focus,beforeBad.focus,'Input pointer/focus/typing with a raw bad tuple never guesses an Agent focus address')
      assert.deepEqual(healthyBad.layouts,beforeBad.layouts,'Healthy input does not choose another Group or change its durable layout')
      assert.deepEqual(healthyBad.selection,beforeBad.selection)
      assert.deepEqual(healthyBad.floating.reference,rawBadReference,'Original input click/type and inner Escape do not erase its raw saved tuple')
      result.checks.push({ name: 'Bad-and-ambiguous-tuples-same-non-inert-editor-caret-healthy-input-explicit-control-focus-and-disclosure-only', passed: true, beforeCaret, beforeBadCaret })
      result.step='explicit-original-Group-Tab-recovers-the-retained-bad-reference'
      await click(selector(panel,'[data-pane-group-id="original-mote-second"] button[data-workbench-tab-id="mote-primary-tab"]'))
      await until('JSON.stringify(window.sharedFrameProof.facts().floating.reference)==='+JSON.stringify(JSON.stringify(reference)))
      await click(editor)
      const explicitRecovery=await facts(); assert.deepEqual(explicitRecovery.tabs,healthyBad.tabs); assert.deepEqual(explicitRecovery.runs,healthyBad.runs); assert.deepEqual(explicitRecovery.drafts,healthyBad.drafts)
      assert.equal(await read('window.originalFloatingFrame.querySelector(".workbench-layout-body > .pane-split, .workbench-layout-body > .pane-group")===window.originalFloatingSplit'),true)
      result.explicitRecoveryPresentation=await read('(()=>{const e=window.originalHealthyEditor,g=e.closest(".pane-group"),b=window.originalFloatingSplit.closest(".workbench-layout-body"),rect=n=>{if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{x:r.x,y:r.y,width:r.width,height:r.height,clientRects:n.getClientRects().length,cssWidth:s.width,cssHeight:s.height,position:s.position,visibility:s.visibility,clipPath:s.clipPath,hidden:!!n.closest("[hidden]"),inert:!!n.closest("[inert]"),ariaHidden:!!n.closest("[aria-hidden=true]")}};return{groupId:g?.dataset.paneGroupId,editor:rect(e),group:rect(g),slot:rect(e.closest(".workbench-tab-slot")),host:rect(e.closest(".retained-workbench-view")),body:rect(b),layoutState:b.dataset.workbenchLayoutState??null,selection:window.sharedFrameProof.facts().floating.reference}})()')
      const recoveredEditor=result.explicitRecoveryPresentation.editor,recoveredGroup=result.explicitRecoveryPresentation.group
      assert.equal(result.explicitRecoveryPresentation.groupId,reference.groupId)
      assert.equal(result.explicitRecoveryPresentation.layoutState,null)
      assert.equal(result.explicitRecoveryPresentation.body.position,'static');assert.equal(result.explicitRecoveryPresentation.body.visibility,'visible');assert.equal(result.explicitRecoveryPresentation.body.clipPath,'none')
      assert.equal(result.explicitRecoveryPresentation.body.inert,false);assert.equal(result.explicitRecoveryPresentation.body.ariaHidden,false)
      assert.equal(recoveredEditor.hidden,false);assert.equal(recoveredEditor.inert,false);assert.equal(recoveredEditor.ariaHidden,false)
      assert.ok(recoveredEditor.x>=recoveredGroup.x-1&&recoveredEditor.y>=recoveredGroup.y-1&&recoveredEditor.x+recoveredEditor.width<=recoveredGroup.x+recoveredGroup.width+1&&recoveredEditor.y+recoveredEditor.height<=recoveredGroup.y+recoveredGroup.height+1,'The restored original input must paint inside its exact selected physical Group')
      result.checks.push({name:'Raw-bad-reference-kept-by-same-input-focus-click-type-inner-Escape-and-explicit-original-Group-Tab-recovers-fulltuple',passed:true,rawBadReference,recoveredReference:explicitRecovery.floating.reference})
      if (referenceCounterOnly) {
        result.final=await facts(); assert.deepEqual(forbidden(result.final), [])
        result.acceptanceScope=commitIntervalDiagnostic?'diagnostic-commit-interval':preMoveStyleReadDiagnostic?'diagnostic-pre-move-style-read':styleMoveTraceDiagnostic?'diagnostic-style-move-trace':preMoveReadDiagnostic?'diagnostic-pre-move-layout-read':'bounded-native-reference-counter'; result.finalCaret=await caret()
        assert.equal(result.finalCaret.focused,true); assert.equal(result.finalCaret.hidden,false); assert.equal(result.finalCaret.inert,false)
        await capture(commitIntervalDiagnostic?'diagnostic-commit-interval-same-split-and-original-input':preMoveStyleReadDiagnostic?'diagnostic-pre-move-style-read-same-split-and-original-input':styleMoveTraceDiagnostic?'diagnostic-style-move-trace-same-split-and-original-input':preMoveReadDiagnostic?'diagnostic-pre-move-read-same-split-and-original-input':'bounded-native-same-split-reference-disclosure-and-original-input')
        result.passed=true; return
      }
      if (serviceHintDiagnostic) {
        result.serviceHintDiagnostic.counterCompleted=true
        result.serviceHintDiagnostic.overriddenTargets=await read('window.privateServiceHintTargets')
        result.serviceHintDiagnostic.finalCaret=await caret()
        result.serviceHintDiagnostic.final=await facts()
        await capture('bounded-private-service-hint-inner-close-Escape-and-original-input')
        throw new Error('Bounded private service hint diagnostic completed; not production/full-journey acceptance')
      }
      await key('Escape', 'Escape', 27)
      result.editorEscapeEvents = await read('window.sharedFrameKeyEvents')
      assert.equal(await read(panel + '.matches(":popover-open")'), true, 'The original Editor consumes its own Escape without closing its parent')
      assert.equal(result.editorEscapeEvents.findLast(event => event.stage === 'panel-bubble').defaultPrevented, true)
      const afterEditorEscape = await facts()
      assert.deepEqual(afterEditorEscape.tabs, healthyBad.tabs); assert.deepEqual(afterEditorEscape.drafts, healthyBad.drafts)
      result.checks.push({ name: 'Original-Editor-consumed-Escape-is-respected-by-Mote-parent', passed: true })
      const modeButton = selector(panel, '[aria-label="Show Mote avatars only"]')
      await click(modeButton); await until(panel + '.dataset.moteNavigation==="avatars"')
      assert.equal(await read(editor + '===window.originalHealthyEditor && !window.originalHealthyEditor.closest("[inert]")'), true)
      await capture('wide-original-Mote-avatars-rail-retains-shared-workface')
      await click(modeButton); await until(panel + '.dataset.moteNavigation==="cards"')
      await read('new Promise(resolve=>queueMicrotask(()=>requestAnimationFrame(resolve)))')
      assert.equal(await read('document.activeElement===' + modeButton), true, 'A later explicit Mote chrome button owns focus')
      await key('Escape', 'Escape', 27)
      result.outerEscapeEvents = await read('window.sharedFrameKeyEvents')
      await until('!' + panel + '.matches(":popover-open")')
      result.checks.push({ name: 'Outer-Escape-from-original-Mote-chrome-still-closes-parent', passed: true })
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      result.step = 'actual-Open-in-Space-with-shared-file-host'
      await click(selector(panel, '[aria-label="Open Mote Space"]')); await until('!' + panel + '.matches(":popover-open")')
      await read('window.sharedFrameProof.prepareSpace()')
      await until('document.querySelector(".surface-tool-dock [data-mote-details]")')
      await capture('wide-Space-profile-shared-files-tabs-regions')
      await chooseSection(root, 'Persona'); await capture('wide-Space-persona')
      await chooseSection(root, 'Ideas'); await until('document.querySelector(".mote-details__note")')
      await click('document.querySelector(".mote-details__note")'); await until('document.querySelector(".mote-details__preview")?.textContent.includes("A useful next step")')
      await capture('wide-Space-ideas')
      await click(button(root, 'New note')); await until('document.querySelector(".tree-inline-input")===document.activeElement')
      await input('Input.insertText', { text: 'frame-proof.md' }); await key('Enter', 'Enter', 13)
      await until('window.sharedFrameProof.facts().calls.some(call=>call.operation==="createFile"&&call.path.endsWith("/frame-proof.md"))')
      await until('Object.values(window.sharedFrameProof.facts().tabs).some(tab=>Object.values(tab.regions).some(region=>region.kind==="file"&&region.path.endsWith("/frame-proof.md")))')
      result.checks.push({ name: 'Ideas-New-note-real-public-FileExplorer-createPath-and-File-owner', passed: true })
      await size(600, 680); await capture('narrow-Space-shared-files-and-ideas')
      result.narrowSpaceDefault = await spaceGeometry()
      assert.equal(await read('!!document.querySelector(".project-rail-shell")'), false, 'Narrow default presents tools and keeps wide tree preference')
      assert.ok(result.narrowSpaceDefault.main.width >= 319, 'Narrow default leaves original work surface a reading area before manual adjustments')
      const beforeNarrowControls = await facts()
      await click(selector(root, '.surface-tool-dock [data-project-rail-toggle]'))
      await until('!!document.querySelector(".project-rail-shell") && !document.querySelector(".surface-tool-dock")')
      result.narrowSpaceTreeSelected = await spaceGeometry()
      await capture('narrow-Space-original-tree-toggle-main')
      await click(selector(root, '.project-rail-shell [data-surface-tools-toggle]'))
      await until('!document.querySelector(".project-rail-shell") && !!document.querySelector(".surface-tool-dock")')
      result.narrowSpaceToolsReturned = await spaceGeometry()
      await capture('narrow-Space-original-tools-toggle-main-and-tools')
      const priorToolWidth = (await facts()).toolDockWidth
      await resizeTools(-64)
      result.narrowSpaceToolsResized = await spaceGeometry()
      assert.ok((await facts()).toolDockWidth < priorToolWidth, 'Original public tools drag resize updates its existing width owner')
      await chooseSection(root, 'Profile'); await capture('narrow-Space-original-controls-profile')
      await chooseSection(root, 'Persona'); await capture('narrow-Space-original-controls-persona')
      await chooseSection(root, 'Ideas'); await capture('narrow-Space-original-controls-ideas')
      const afterNarrowControls = await facts()
      assert.deepEqual(afterNarrowControls.tabs, beforeNarrowControls.tabs); assert.deepEqual(afterNarrowControls.drafts, beforeNarrowControls.drafts)
      assert.deepEqual(afterNarrowControls.runs, beforeNarrowControls.runs)
      assert.equal(afterNarrowControls.projectRailOpen, beforeNarrowControls.projectRailOpen, 'Compact switching retains durable wide tree preference')
      assert.equal(afterNarrowControls.toolsOpen, beforeNarrowControls.toolsOpen, 'Compact switching retains durable wide tools preference')
      await click(selector(root, '[aria-label="Hide Space tools"]'))
      await until('!document.querySelector(".project-rail-shell") && !document.querySelector(".surface-tool-dock")')
      result.narrowSpaceSidebarsClosed = await spaceGeometry()
      assert.ok(result.narrowSpaceSidebarsClosed.main.width >= 599, 'The original tools-close control releases the complete narrow workface')
      const narrowSpaceEditor = selector(root, '.workspace-workbench-slot[data-visible="true"] [data-pane-group-id="original-mote-second"] [data-workbench-tab-id="mote-primary-tab"] .composer__editor .tiptap')
      await click(narrowSpaceEditor)
      result.narrowSpaceReadingInput = await read('(()=>{const e=' + narrowSpaceEditor + ',r=e.getBoundingClientRect(),s=getSelection();return{same:e===window.spaceHoverOriginalEditor,connected:e.isConnected,focused:document.activeElement===e,text:e.textContent,hidden:!!e.closest("[hidden]"),inert:!!e.closest("[inert]"),width:r.width,collapsed:s.isCollapsed}})()')
      assert.equal(result.narrowSpaceReadingInput.same,true); assert.equal(result.narrowSpaceReadingInput.focused,true)
      assert.equal(result.narrowSpaceReadingInput.hidden,false); assert.equal(result.narrowSpaceReadingInput.inert,false)
      assert.ok(result.narrowSpaceReadingInput.width>=250); assert.equal(result.narrowSpaceReadingInput.collapsed,true)
      await capture('narrow-Space-original-tools-close-full-workface-and-original-input')
      const afterToolsClose = await facts()
      assert.deepEqual(afterToolsClose.tabs,afterNarrowControls.tabs);assert.deepEqual(afterToolsClose.drafts,afterNarrowControls.drafts);assert.deepEqual(afterToolsClose.runs,afterNarrowControls.runs)
      await click(selector(root, '[aria-label="Show Space tools"]'))
      await until('!document.querySelector(".project-rail-shell") && !!document.querySelector(".surface-tool-dock")')
      result.checks.push({ name: 'Actual-common-Space-narrow-default-readable-tree-tools-toggle-drag-and-all-Mote-functional-groups-preserve-original-data-and-wide-preferences', passed: true })
      await size(1100); await resizeTools(priorToolWidth - (await facts()).toolDockWidth)
      await until('!!document.querySelector(".project-rail-shell") && !!document.querySelector(".surface-tool-dock")')
      result.wideSpacePreferencesRestored = await spaceGeometry()
      result.step = 'Mote-overlay-shares-original-Agent-with-Focus-and-Survey-public-callers'
      const beforeOther = await facts()
      await click(selector(root, '.surface-navigation__focus'))
      await until('window.sharedFrameProof.facts().mainSurface==="agents" && document.querySelector(".global-session-workspace .workspace-workbench")')
      await until('document.querySelector(".global-session-workspace .composer__editor .tiptap")?.textContent==="Original unsent draft · project-worker"')
      await read('window.originalProjectEditor=document.querySelector(".global-session-workspace .composer__editor .tiptap")')
      await click(entry); await visible(primary, target)
      assert.equal(await read('window.originalProjectEditor.isConnected && !window.originalProjectEditor.closest("[inert]")'), true)
      await capture('wide-Mote-with-original-Focus-Agent')
      await click(selector(panel, '[aria-label="Close Mote"]')); await until('!' + panel + '.matches(":popover-open")')
      await read('window.sharedFrameProof.prepareOriginalSurvey()')
      await click(selector(root, '[aria-label="Survey: browse and manage pages"]'))
      await until('window.sharedFrameProof.facts().mainSurface==="survey" && document.querySelector(".global-survey-surface .workspace-workbench")')
      await until('window.originalProjectEditor.isConnected && !!window.originalProjectEditor.closest(".global-survey-surface") && !window.originalProjectEditor.closest("[inert]")')
      await click(entry); await visible(primary, target)
      assert.equal(await read('window.originalProjectEditor.textContent'), 'Original unsent draft · project-worker')
      await capture('wide-Mote-with-original-Survey-Agent-no-Browser-seed')
      await click(selector(panel, '[aria-label="Close Mote"]')); await until('!' + panel + '.matches(":popover-open")')
      const afterOther = await facts(); assert.deepEqual(afterOther.tabs, beforeOther.tabs); assert.deepEqual(afterOther.runs, beforeOther.runs)
      assert.deepEqual(afterOther.drafts, beforeOther.drafts)
      result.checks.push({ name: 'Actual-Focus-and-Survey-consume-original-shared-project-Agent-with-Mote-overlay', passed: true })
      await click(selector(root, '[aria-label="Space: show terminal and file workbench"]'))
      assert.deepEqual((await facts()).tabs['original-project-tab'], { ...result.initial.tabs['original-project-tab'],
        layout: { ...result.initial.tabs['original-project-tab'].layout, activeRegionId: 'original-worker-region' } },
        'Explicit return to Space follows the selected original execution Session and preserves its entire Tab topology')
      await read('window.sharedFrameProof.prepareSpace()')
      result.step = 'ordinary-Topic-uses-same-public-frame'
      await click(selector(root, '[data-space-nav="topic:launcher:ordinary"]'))
      await until('(()=>{const s=window.sharedFrameProof.facts(),l=s.layouts[s.activeWorkspaceId],g=l?.groups.find(g=>g.id===l.activeGroupId);return s.activeWorkspaceId==="__scratch__"&&g?.activeTabId==="ordinary-topic-tab"&&s.tabs[g.activeTabId]?.topicId==="launcher:ordinary"})()')
      assert.equal(await read('!!document.querySelector(".surface-tool-dock [data-mote-details]")'), false)
      assert.equal(await read('!!document.querySelector(".surface-tool-dock .workspace-tool-explorer")'), true)
      await capture('wide-ordinary-Topic-public-files-and-workbench')
      result.step = 'true-empty-Mote-chooses-original-visible-Group-before-file-action'
      await click(entry); await visible(primary, target)
      await chooseMote(custom, 'custom-mote-tab')
      await click(selector(panel, 'button[data-workbench-tab-id="custom-mote-tab"] .workbench-tab__close'))
      await until('[...document.querySelectorAll(".confirmation-dialog button")].some(e=>e.textContent==="Keep Session & Close")')
      await click('[...document.querySelectorAll(".confirmation-dialog button")].find(e=>e.textContent==="Keep Session & Close")')
      await visible(custom, null)
      const empty = await facts(); assert.equal(empty.tabs['custom-mote-tab'], undefined)
      await click(button(panel, 'Edit persona'))
      await until(selector(panel, '[aria-label="File opening location"]'))
      assert.deepEqual((await facts()).tabs, empty.tabs); assert.deepEqual((await facts()).runs, empty.runs)
      await capture('wide-empty-Mote-explicit-file-location')
      await size(640, 680); await capture('narrow-empty-Mote-explicit-file-location')
      result.emptyFunctionalGroups = []
      for (const section of ['Profile', 'Persona', 'Ideas']) {
        await click(button(panel, section))
        await until(selector(panel, '[role="tabpanel"][aria-label="Mote ' + section.toLowerCase() + '"]'))
        const geometry = await read(`(()=>{const root=${panel},host=root.querySelector('.mote-workface__files'),tool=host.querySelector('.workspace-tool-explorer'),details=host.querySelector('.mote-details'),content=details.querySelector('[role=tabpanel]'),rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}},controls=[...details.querySelectorAll('[role=tab]')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:e.textContent,selected:e.getAttribute('aria-selected'),bounds:rect(e),hittable:hit===e||e.contains(hit)}}),r=content.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{section:content.getAttribute('aria-label'),host:rect(host),tool:rect(tool),details:rect(details),content:rect(content),contentHit:hit===content||content.contains(hit),scrollHeight:content.scrollHeight,clientHeight:content.clientHeight,scrollTop:content.scrollTop,hidden:!!content.closest('[hidden],[inert]'),controls,topActions:[...content.querySelectorAll('.mote-details__section-actions button')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:e.textContent.trim(),bounds:rect(e),hittable:hit===e||e.contains(hit)}})}})()`)
        assert.equal(geometry.section, 'Mote ' + section.toLowerCase()); assert.equal(geometry.hidden, false)
        assert.ok(geometry.tool.height > 0 && geometry.content.height > 0 && geometry.contentHit, 'Empty Mote retains usable original shared tool content')
        assert.ok(geometry.controls.every(control=>control.bounds.width>0&&control.bounds.height>0&&control.hittable), 'Every original empty-Mote functional-group control is natively reachable')
        assert.deepEqual(geometry.controls.filter(control=>control.selected==='true').map(control=>control.text),[section])
        if (section !== 'Profile') {
          assert.equal(geometry.scrollTop, 0, 'An explicit functional-group change starts its original content at the top')
          assert.deepEqual(geometry.topActions.map(action=>action.text),[section === 'Persona' ? 'Edit' : 'New note'])
          assert.ok(geometry.topActions.every(action=>action.bounds.width>0&&action.bounds.height>0&&action.hittable), 'Empty original self-setting and ideas actions are visibly reachable at their new group start')
        }
        if (section === 'Profile' && geometry.scrollHeight > geometry.clientHeight) {
          await input('Input.dispatchMouseEvent', { type:'mouseWheel', x:geometry.content.x+geometry.content.width/2, y:geometry.content.y+geometry.content.height/2, deltaX:0, deltaY:120 })
          await until(selector(panel, '.mote-details__content') + '.scrollTop>0')
          geometry.scrolled = await read(selector(panel, '.mote-details__content') + '.scrollTop')
          assert.ok(geometry.scrolled > 0, 'The original empty Profile content remains scrollable')
        }
        result.emptyFunctionalGroups.push(geometry)
        if (section !== 'Profile') await capture('narrow-empty-Mote-original-' + section.toLowerCase() + '-functional-group')
      }
      const afterEmptyFunctionalGroups = await facts()
      for (const key of ['tabs','drafts','runs']) assert.deepEqual(afterEmptyFunctionalGroups[key],empty[key])
      assert.equal(afterEmptyFunctionalGroups.floating.targetTabId,null, 'Empty object functions do not create a discussion or infer placement')
      await size(1100)
      await read('(()=>{const e=' + selector(panel, '[aria-label="File opening location"]') + ';e.value=JSON.stringify(["__scratch__","original-mote-second"]);e.dispatchEvent(new Event("change",{bubbles:true}))})()')
      await click(button(panel, 'Edit persona'))
      await until('window.sharedFrameProof.facts().floating.targetTabId!==null')
      const emptyOpened = await facts(); assert.equal(emptyOpened.floating.reference.groupId, 'original-mote-second')
      assert.ok(Object.values(emptyOpened.tabs[emptyOpened.floating.targetTabId].regions).some(region=>region.kind==='file'&&region.path.endsWith('/SOUL.md')))
      result.checks.push({ name: 'Empty-Mote-direct-SOUL-no-discussion-explicit-real-Group-original-File-owner', passed: true })
      await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
      result.final = await facts()
    } else {
      result.step = 'second-real-PID-restores-original-Tab-Region-draft-and-complete-reference'
      const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
      const current = await visible(primary, target)
      assert.equal(current.initialization.seedApplied, false)
      assert.ok(current.initialization.initialSpatial?.graph.tabs.some(tab=>tab.tabId==='original-project-tab'), 'Original App restores the durable original Core spatial-port graph')
      assert.equal(current.initialization.initializeCalls, 1, 'Original App invokes its unmodified initialize once')
      assert.deepEqual(current.initialization.initialFloating.reference, reference)
      for (const name of ['tabs', 'layouts', 'drafts', 'outbox', 'viewModes', 'activeWorkspaceId', 'mainSurface']) {
        const actual = name === 'tabs' ? JSON.parse(JSON.stringify(current.tabs)) : current[name]
        assert.deepEqual(actual, prior[name], 'Real restart retains original durable ' + name)
      }
      assert.deepEqual(current.runs, prior.runs); assert.deepEqual(current.focus.execution, prior.focus.execution)
      await until(editor + '?.textContent.includes("still usable")')
      assert.deepEqual(current.floating.reference, reference)
      await capture('wide-second-process-restored-full-reference-and-draft')
      result.checks.push({ name: 'Real-PID-restart-ordinary-durable-restore-not-manual-seed', passed: true })
      result.final = await facts()
    }
    assert.deepEqual(forbidden(result.final), [])
    const expectedProjectTab = phase === 'seed' ? { ...result.initial.tabs['original-project-tab'],
      layout: { ...result.initial.tabs['original-project-tab'].layout, activeRegionId: 'original-worker-region' } } : result.initial.tabs['original-project-tab']
    assert.deepEqual(result.final.tabs['original-project-tab'], expectedProjectTab,
      'The original project Tab is unchanged except for the exact Region selected by explicit return-to-Space navigation')
    assert.equal(result.final.tabs['original-project-tab'].layout.root.ratio, 0.63)
    assert.deepEqual(result.final.focus.execution, phase === 'seed' ? { ...result.initial.focus.execution,
      reference: { displayWorkspaceId: 'private-project', groupId: 'original-project-group', tabId: 'original-project-tab', regionId: 'original-worker-region' } } : result.initial.focus.execution,
      'The original execution Session/history remains; the actual Focus caller records its exact original public reference')
    result.step = 'actual-durable-writer-and-private-profile-flush'
    await until('(()=>{const s=JSON.parse(localStorage.getItem("agentmux-workbench-v1"))?.state,c=window.sharedFrameProof.facts(),p=window.sharedFrameProof.persistence();return !!p.workbench?.tabs["original-project-tab"] && JSON.stringify(Object.keys(p.workbench.tabs).sort())===JSON.stringify(Object.keys(c.tabs).sort()) && JSON.stringify(p.workbench.layouts)===JSON.stringify(c.layouts) && JSON.stringify(s.agentComposerDrafts)===JSON.stringify(c.drafts) && JSON.stringify(s.agentFocus)===JSON.stringify(c.focus) && JSON.stringify(JSON.parse(localStorage.getItem("agentmux.leader-topic-floating.v1")))===JSON.stringify(c.floating)})()')
    win.webContents.session.flushStorageData()
    result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
    result.coreSpatialDurable = await read('window.sharedFrameProof.persistence().spatial')
    assert.equal(result.final.initialization.initializeCalls, 1, 'Original unmodified App initialization owns this process')
    assert.ok(result.final.calls.some(call=>call.operation==='spatialRead') && result.final.calls.some(call=>call.operation==='spatialSubscribe'), 'Actual App connects original public spatial-port owner')
    assert.ok(result.coreSpatialDurable?.revision > 0 && result.coreSpatialDurable.graph.tabs.some(tab=>tab.tabId==='original-project-tab'))
    assert.equal(result.durable.state.restoredWorkbench, undefined, 'The UI preference store does not retain a second entity snapshot after Core ACK')
    result.checks.push({name:'Original-App-unique-initialize-and-DesktopSpatialPersistence-durable-public-port-revision-flush-no-second-entity-snapshot',passed:true,revision:result.coreSpatialDurable.revision,initialRevision:result.final.initialization.initialSpatial?.revision??0})
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if ((styleMoveTraceDiagnostic || commitIntervalDiagnostic) && win && !win.isDestroyed()) {
      const file=phase+'-first-failure-before-css-diagnostics.png',png=(await win.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(evidence,file),png);result.frames.push({name:'first-failure-before-css-diagnostics',file,sha256:createHash('sha256').update(png).digest('hex'),source:'actual-original-counter-failure-before-post-failure-CSS-diagnostics'})
      if (commitIntervalDiagnostic) await bounded(finishNativeCommitTrace(), 'original Chromium trace finalization', 7000).catch(error=>{result.nativeCommitTraceCollectionFailure={message:error.message}})
      await bounded(collectStyleMoveCss('after-first-original-failure'), 'post-failure matched style diagnostics', 7000).catch(error=>{result.styleMoveCssCollectionFailure={message:error.message}})
    }
    if (win && !win.isDestroyed()) {
      const file = phase + '-first-failure-before-service-diagnostics.png', png = (await win.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(evidence, file), png)
      result.frames.push({name:'first-failure-before-service-diagnostics',file,sha256:createHash('sha256').update(png).digest('hex'),source:'actual-first-counter-failure-before-post-failure-service-candidate-observation'})
      result.failureReadingSelection = await bounded(win.webContents.executeJavaScript(`(()=>{const e=window.originalHealthyEditor,selection=getSelection(),describe=n=>n?{type:n.nodeType,name:n.nodeName,text:n.textContent?.slice(0,250),parent:n.parentElement?{tag:n.parentElement.tagName,id:n.parentElement.id,class:n.parentElement.className}:null,insideOriginal:!!e?.contains(n)}:null,offset=(n,v)=>{if(!e?.contains(n))return null;const r=document.createRange();r.selectNodeContents(e);r.setEnd(n,v);return r.toString().length};return{activeElement:describe(document.activeElement),sameActiveInput:document.activeElement===e,originalConnected:!!e?.isConnected,text:e?.textContent,selection:selection?{collapsed:selection.isCollapsed,type:selection.type,rangeCount:selection.rangeCount,anchor:describe(selection.anchorNode),anchorOffset:selection.anchorOffset,anchorTextOffset:offset(selection.anchorNode,selection.anchorOffset),focus:describe(selection.focusNode),focusOffset:selection.focusOffset,focusTextOffset:offset(selection.focusNode,selection.focusOffset),ranges:Array.from({length:selection.rangeCount},(_,i)=>{const r=selection.getRangeAt(i);return{collapsed:r.collapsed,start:describe(r.startContainer),startOffset:r.startOffset,end:describe(r.endContainer),endOffset:r.endOffset,text:r.toString()}})}:null}})()`), 'post-failure original input selection', 2000).catch(error=>({error:error.message}))
      result.serviceTriggerCandidates = await bounded(win.webContents.executeJavaScript(`(()=>{
        const p=document.getElementById('pmo-teams-topic-floating-panel'), candidates=[...p.querySelectorAll('.service-disclosure__trigger')]
        const selected=candidates.find(e=>!e.closest('[hidden],[inert]'))
        const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right})
        const describe=e=>{if(!e)return null;const style=getComputedStyle(e),r=e.getBoundingClientRect();return{tag:e.tagName,id:e.id,class:e.className,attributes:Object.fromEntries([...e.attributes].map(a=>[a.name,a.value])),connected:e.isConnected,hidden:e.hasAttribute('hidden'),inert:e.hasAttribute('inert'),ariaHidden:e.getAttribute('aria-hidden'),popover:e.getAttribute('popover'),popoverOpen:e.hasAttribute('popover')?e.matches(':popover-open'):null,rect:rect(r),clientRects:[...e.getClientRects()].map(rect),computed:{display:style.display,visibility:style.visibility,position:style.position,contentVisibility:style.contentVisibility,pointerEvents:style.pointerEvents,clipPath:style.clipPath}}}
        return{originalSelector:'first .service-disclosure__trigger without [hidden]/[inert] ancestor',selectedIndex:candidates.indexOf(selected),panel:describe(p),candidates:candidates.map((e,index)=>{const ancestry=[];for(let parent=e;parent&&ancestry.length<24;parent=parent.parentElement)ancestry.push(describe(parent));const popovers=ancestry.filter(node=>node.popover!==null),r=e.getBoundingClientRect(),hit=r.width>0&&r.height>0?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{index,selectedByOriginalSelector:e===selected,identity:describe(e),text:e.textContent,ariaLabel:e.getAttribute('aria-label'),controls:e.getAttribute('aria-controls'),nearestNotice:describe(e.closest('.service-disclosure')),nearestHome:describe(e.closest('.service-disclosure-home')),nearestGroup:describe(e.closest('[data-pane-group-id]')),nearestWorkspace:describe(e.closest('.workspace-workbench')),hiddenAncestor:!!e.closest('[hidden]'),inertAncestor:!!e.closest('[inert]'),ariaHiddenAncestor:!!e.closest('[aria-hidden=true]'),closedPopoverAncestor:popovers.some(node=>node.popoverOpen===false),popovers,hit:hit?{tag:hit.tagName,id:hit.id,class:hit.className}:null,hittable:hit===e||e.contains(hit),ancestry}})}
      })()`), 'post-failure service trigger candidates', 3000).catch(error=>({error:error.message}))
    }
    if (win && !win.isDestroyed()) result.observation = await bounded(win.webContents.executeJavaScript('({setup:window.sharedFrameSetup,body:document.body.innerText,facts:window.sharedFrameProof?.facts(),focusEvents:window.sharedFrameFocusEvents,keyEvents:window.sharedFrameKeyEvents})'), 'failure facts', 2000).catch(error=>({error:error.message}))
    if (win && !win.isDestroyed()) result.popoverGeometry = await bounded(win.webContents.executeJavaScript(`(()=>{return[...document.querySelectorAll('.service-disclosure__details')].map(e=>{const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}},close=e.querySelector('.service-disclosure__close'),r=close?.getBoundingClientRect(),hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{id:e.id,open:e.matches(':popover-open'),maxHeight:getComputedStyle(e).maxHeight,details:rect(e),close:rect(close),closeHit:hit?.className,closeReachable:!!close&&(hit===close||close.contains(hit)),workspace:rect(e.closest('.workspace-workbench')),text:e.innerText}})})()`), 'actual popover geometry', 2000).catch(error=>({error:error.message}))
    if (win && !win.isDestroyed()) result.geometry = await bounded(win.webContents.executeJavaScript(`(()=>{const editors=[...document.querySelectorAll('.composer__editor .tiptap')];return editors.map(e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),chain=[];for(let p=e;p&&chain.length<32;p=p.parentElement){const b=p.getBoundingClientRect(),s=getComputedStyle(p);chain.push({tag:p.tagName,class:p.className,inert:p.hasAttribute('inert'),hidden:p.hidden,width:b.width,height:b.height,x:b.x,y:b.y,display:s.display,visibility:s.visibility,overflow:s.overflow,pointerEvents:s.pointerEvents,clipPath:s.clipPath,position:s.position,cssWidth:s.width,cssHeight:s.height,flex:s.flex,contentVisibility:s.contentVisibility,contain:s.contain,clientRects:p.getClientRects().length,inlineStyle:p.getAttribute('style'),popover:p.getAttribute('popover'),popoverOpen:p.hasAttribute('popover')?p.matches(':popover-open'):null,attrs:[...p.attributes].filter(a=>a.name.startsWith('data-')||a.name==='hidden'||a.name==='aria-hidden').map(a=>[a.name,a.value])})}return{text:e.textContent,hit:h?.className,chain}})})()`), 'actual failure geometry', 2000).catch(error=>({error:error.message}))
    if (win && !win.isDestroyed()) {
      const file = phase + '-failure.png', png = (await win.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(evidence, file), png)
      result.frames.push({ name: 'failure', file, sha256: createHash('sha256').update(png).digest('hex'), source: 'actual-failure-state' })
    }
    if (geometryDiagnostic && win && !win.isDestroyed()) {
      try {
        const snapshot=await bounded(win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot',{computedStyles:['display','visibility','content-visibility','contain','width','height','position','flex'],includeDOMRects:true,includePaintOrder:true}), 'original CDP DOMSnapshot', 3000)
        const file=phase+'-original-dom-snapshot.json',bytes=JSON.stringify(snapshot)
        await fs.writeFile(path.join(evidence,file),bytes)
        result.originalDomSnapshot={file,sha256:createHash('sha256').update(bytes).digest('hex'),source:'actual-original-Chromium-layout-before-any-diagnostic-probe'}
      } catch(error) { result.originalDomSnapshot={error:error.message} }
      result.geometryDiagnostic = await bounded(win.webContents.executeJavaScript(`(()=>{const panel=document.getElementById('pmo-teams-topic-floating-panel'),w=panel?.querySelector('.workspace-workbench'),describe=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e),root=e.getRootNode();return{tag:e.tagName,class:e.className,connected:e.isConnected,rootIsDocument:root===document,rootType:root.nodeName,ownerDocumentIsDocument:e.ownerDocument===document,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clientRects:e.getClientRects().length,hidden:e.hidden,popover:e.getAttribute('popover'),popoverOpen:e.hasAttribute('popover')?e.matches(':popover-open'):null,inlineStyle:e.getAttribute('style'),computed:{display:s.display,width:s.width,height:s.height,position:s.position,flex:s.flex,contain:s.contain,contentVisibility:s.contentVisibility,visibility:s.visibility},attrs:[...e.attributes].map(a=>[a.name,a.value])}};const chain=[];for(let e=w;e;e=e.parentElement)chain.push(describe(e));return{original:true,chain,openPopovers:[...document.querySelectorAll('[popover]:popover-open')].map(describe),workbenchOuterHTML:w?.outerHTML.slice(0,16000)}})()`), 'original zero-area DOM diagnostic', 3000).catch(error=>({error:error.message}))
      const probe = async (name, expression) => {
        const before = await bounded(win.webContents.executeJavaScript('window.sharedFrameProof.facts()'), 'pre-probe facts', 2000)
        const observation = await bounded(win.webContents.executeJavaScript(expression), 'private diagnostic style probe', 3000).catch(error=>({error:error.message}))
        const file=phase+'-diagnostic-'+name+'.png',png=(await win.webContents.capturePage()).toPNG()
        await fs.writeFile(path.join(evidence,file),png)
        result.frames.push({name:'diagnostic-'+name,file,sha256:createHash('sha256').update(png).digest('hex'),source:'actual-private-Renderer-diagnostic-style-probe-not-acceptance'})
        const after=await bounded(win.webContents.executeJavaScript('window.sharedFrameProof.facts()'), 'post-probe facts', 2000)
        return {name,observation,originalTabsKept:JSON.stringify(before.tabs)===JSON.stringify(after.tabs),originalDraftsKept:JSON.stringify(before.drafts)===JSON.stringify(after.drafts),originalRunsKept:JSON.stringify(before.runs)===JSON.stringify(after.runs)}
      }
      result.diagnosticStyleProbes=[]
      if (result.geometryDiagnostic?.chain?.[0]?.rect.width===0) {
        result.diagnosticStyleProbes.push(await probe('explicit-original-parent-size', `new Promise(resolve=>{const w=document.getElementById('pmo-teams-topic-floating-panel').querySelector('.workspace-workbench'),p=w.parentElement,r=p.getBoundingClientRect(),saved=w.getAttribute('style'),describe=()=>{const b=w.getBoundingClientRect();return{width:b.width,height:b.height,clientRects:w.getClientRects().length,inlineStyle:w.getAttribute('style')}};w.style.setProperty('width',r.width+'px','important');w.style.setProperty('height',r.height+'px','important');w.style.setProperty('flex','1 1 auto','important');void w.offsetWidth;requestAnimationFrame(()=>requestAnimationFrame(()=>{const during=describe();if(saved===null)w.removeAttribute('style');else w.setAttribute('style',saved);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({probe:true,during,restored:describe()}))) }))})`))
        result.diagnosticStyleProbes.push(await probe('original-display-layout-recalculation', `new Promise(resolve=>{const w=document.getElementById('pmo-teams-topic-floating-panel').querySelector('.workspace-workbench'),saved=w.getAttribute('style'),describe=()=>{const b=w.getBoundingClientRect();return{width:b.width,height:b.height,clientRects:w.getClientRects().length,inlineStyle:w.getAttribute('style')}};w.style.setProperty('display','none','important');void w.offsetWidth;if(saved===null)w.removeAttribute('style');else w.setAttribute('style',saved);void w.offsetWidth;requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({probe:true,restored:describe()})))})`))
        result.diagnosticStyleProbes.push(await probe('same-parent-original-node-append', `new Promise(resolve=>{const w=document.getElementById('pmo-teams-topic-floating-panel').querySelector('.workspace-workbench'),p=w.parentElement,describe=()=>{const b=w.getBoundingClientRect();return{width:b.width,height:b.height,clientRects:w.getClientRects().length,parentSame:w.parentElement===p,connected:w.isConnected}};const before=describe();p.append(w);void w.offsetWidth;requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({probe:true,before,after:describe(),sameNode:document.getElementById('pmo-teams-topic-floating-panel').querySelector('.workspace-workbench')===w})))})`))
        result.diagnosticStyleProbes.push(await probe('outer-native-popover-hide-show', `new Promise(resolve=>{const p=document.getElementById('pmo-teams-topic-floating-panel'),w=p.querySelector('.workspace-workbench'),describe=()=>{const b=w.getBoundingClientRect();return{width:b.width,height:b.height,clientRects:w.getClientRects().length,panelOpen:p.matches(':popover-open'),connected:w.isConnected}};const before=describe();p.hidePopover();void p.offsetWidth;p.showPopover();void w.offsetWidth;requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({probe:true,before,after:describe(),sameNode:p.querySelector('.workspace-workbench')===w,floating:window.sharedFrameProof.facts().floatingState})))})`))
      }
      result.passed=false
    }
  } finally {
    if (commitIntervalDiagnostic && win && !win.isDestroyed()) try {
      await bounded(finishNativeCommitTrace(), 'original Chromium trace finalization', 7000)
      if (result.passed) await bounded(collectStyleMoveCss('after-original-counter-completion'), 'post-completion style diagnostics', 7000)
      const trace = await bounded(win.webContents.executeJavaScript('(()=>{window.restorePrivateCommitIntervalTrace?.();return window.privateCommitIntervalTrace})()'), 'private commit interval trace restore', 2000)
      const file = phase + '-commit-interval-trace.json', bytes = JSON.stringify(trace, null, 2)
      await fs.writeFile(path.join(evidence, file), bytes)
      const { events, ...counters } = trace
      result.commitIntervalTrace = { ...counters, file, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch(error) { result.passed=false;result.diagnosticCleanupFailure={message:error.message} }
    if (preMoveStyleReadDiagnostic && win && !win.isDestroyed()) try {
      const trace = await bounded(win.webContents.executeJavaScript('(()=>{window.restorePrivatePreMoveStyleReadDiagnostic?.();return window.privatePreMoveStyleReadDiagnostic})()'), 'private style-read diagnostic restore', 2000)
      const file = phase + '-pre-move-style-read.json', bytes = JSON.stringify(trace, null, 2)
      await fs.writeFile(path.join(evidence, file), bytes)
      const { moves, ...counters } = trace
      result.preMoveStyleReadDiagnostic = { ...counters, file, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch(error) { result.passed=false;result.diagnosticCleanupFailure={message:error.message} }
    if (styleMoveTraceDiagnostic && win && !win.isDestroyed()) try {
      if (result.passed) await bounded(collectStyleMoveCss('after-original-counter-completion'), 'post-completion style diagnostics', 7000)
      const trace=await bounded(win.webContents.executeJavaScript('(()=>{window.restorePrivateStyleMoveTrace?.();return window.privateStyleMoveTrace})()'), 'private style/move trace restore', 2000)
      const file=phase+'-style-move-trace.json',bytes=JSON.stringify(trace,null,2);await fs.writeFile(path.join(evidence,file),bytes)
      result.styleMoveTrace={file,sha256:createHash('sha256').update(bytes).digest('hex'),attemptedMoves:trace.attemptedMoves,actualMoves:trace.actualMoves,moveErrors:trace.moveErrors,eventCount:trace.eventCount,droppedEvents:trace.droppedEvents,layoutReadsBeforeMove:trace.layoutReadsBeforeMove,notAcceptance:true}
    } catch(error) { result.passed=false;result.diagnosticCleanupFailure={message:error.message} }
    if (preMoveReadDiagnostic && win && !win.isDestroyed()) try {
      result.preMoveReadDiagnostic=await bounded(win.webContents.executeJavaScript('(()=>{window.restorePrivatePreMoveReadDiagnostic?.();return window.privatePreMoveReadDiagnostic})()'), 'private pre-move diagnostic restore and counts', 2000)
    } catch(error) { result.passed=false;result.diagnosticCleanupFailure={message:error.message} }
    if (win && !win.isDestroyed()) try { await bounded(win.webContents.executeJavaScript('window.privateServiceHintDiagnosticObserver?.disconnect();window.finishPrivateCaretPointerObservation?.();window.sharedFrameProof?.dispose()'), 'Renderer cleanup', 5000) }
    catch (error) { result.passed = false; result.cleanupFailure = { message: error.message } }
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
