import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { native } from './browser-demonstration-probe-scenario.mjs'
import { publicFacts } from './browser-outcome-probe-scenario.mjs'

// Scenario only. The canonical owns launch, the HTTP server, socket, ordinary quit/restart and cleanup.
export const localRecoveryDisconnectPath = '/local-recovery-disconnect'
export const localRecoveryFixture = '<button id="recovery-prefix">Prepare item</button><button id="recovery-action">Continue task</button><script>globalThis.demoTrusted={click:0,input:0};globalThis.localRecoveryClicks={prefix:0,action:0};document.addEventListener("click",event=>{if(event.isTrusted){globalThis.demoTrusted.click++;globalThis.demoTrusted.lastTarget=event.target.id}if(event.target.id==="recovery-prefix")globalThis.localRecoveryClicks.prefix++;if(event.target.id==="recovery-action")globalThis.localRecoveryClicks.action++},true)</script>'

/** A real HTTP disconnect, without another server or a synthetic product rejection. */
export function handleLocalRecoveryDisconnect(request, response, receipt) {
  if (!receipt.localRecovery?.disconnectArmed || new URL(request.url, 'http://127.0.0.1').pathname !== localRecoveryDisconnectPath) return false
  ;(receipt.localRecovery.networkRequests ??= []).push({ path: request.url, at: Date.now() })
  response.destroy()
  return true
}

const q = JSON.stringify
const surface = '[aria-label="Editable Browser task asset"]'
const state = ctx => ctx.probe.cdp.evaluate(`window.agentmux.browser.getTaskAssets(${q(ctx.browserId)})`)
const buttons = (ctx, label) => `${ctx.selectors(surface + ' button')}.filter(element=>element.textContent.trim()===${q(label)})`
const browser = ctx => `.browser-surface:has([data-native-browser-stage=${q(ctx.browserId)}])`

async function operation(ctx, id) {
  const document = JSON.parse(await readFile(join(ctx.userData, 'browser-operation-journal.json'), 'utf8'))
  const value = document.operations.find(item => item.id === id)
  assert.ok(value, 'The real durable operation must remain present')
  return value
}

async function installObservation(ctx, kind) {
  return await ctx.probe.main.evaluate(`(()=>{
    const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');
    const views=BrowserWindow.getAllWindows()[0].contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===${q(ctx.pageUrl)});
    if(views.length!==1)throw new Error('The original native Browser owner must be unique');
    if(globalThis.__agentmuxLocalRecoveryObservation)throw new Error('A local recovery observation is already active');
    const contents=views[0].webContents,debuggerOwner=contents.debugger,originalSend=debuggerOwner.sendCommand,originalLoad=contents.loadURL;
    const facts={kind:${q(kind)},webContentsId:contents.id,originalUrl:contents.getURL(),resolutions:[],loads:[],actionSends:[],replaced:0};
    const forward=(method,params,sessionId)=>sessionId===undefined?originalSend.call(debuggerOwner,method,params):originalSend.call(debuggerOwner,method,params,sessionId);
    debuggerOwner.sendCommand=async function(method,params,sessionId){
      if(method==='Runtime.callFunctionOn'&&params?.functionDeclaration?.includes('this.click()'))facts.actionSends.push({method,objectId:params.objectId,at:Date.now()});
      if(${q(kind)}==='locator'&&method==='DOM.resolveNode'&&params?.objectGroup==='agentmux-browser'&&facts.replaced===0){
        const described=await forward('DOM.describeNode',{backendNodeId:params.backendNodeId},sessionId),attributes=described.node?.attributes??[],index=attributes.indexOf('id');
        if(index>=0&&attributes[index+1]==='recovery-action'){
          if(!debuggerOwner.isAttached())throw new Error('The actual product CDP session must be attached');
          const removed=await contents.executeJavaScript('(()=>{const nodes=document.querySelectorAll("#recovery-action");if(nodes.length!==1)throw new Error("The real replacement target must be unique");const next=document.createElement("button");next.id="recovery-action";next.textContent="Continue task";nodes[0].replaceWith(next);return {count:document.querySelectorAll("#recovery-action").length,name:next.textContent}})()');
          facts.replaced++;await forward('HeapProfiler.collectGarbage',{},sessionId);
          const item={method,backendNodeId:params.backendNodeId,attached:true,replacement:removed,garbageCollected:true,originalRequestForwarded:true};facts.resolutions.push(item);
          // Return/reject the real original DOM.resolveNode result unchanged. No injected Error or response.
          try{const value=await forward(method,params,sessionId);item.realRejected=false;item.objectIdPresent=!!value.object?.objectId;return value}
          catch(error){item.realRejected=true;item.nativeError=String(error.message??error).slice(0,512);throw error}
        }
      }
      return await forward(method,params,sessionId);
    };
    contents.loadURL=function(...args){facts.loads.push({url:args[0],at:Date.now()});return originalLoad.apply(contents,args)};
    globalThis.__agentmuxLocalRecoveryObservation={facts,contents,restore(){debuggerOwner.sendCommand=originalSend;contents.loadURL=originalLoad}};
    return {webContentsId:contents.id,url:contents.getURL(),boundary:'Native command/load passthrough observation; only the real fixture DOM is changed'};
  })()`)
}

async function finishObservation(ctx) {
  return await ctx.probe.main.evaluate(`(()=>{const owner=globalThis.__agentmuxLocalRecoveryObservation;if(!owner)throw new Error('The original observation is missing');try{return {...owner.facts,currentUrl:owner.contents.getURL(),destroyed:owner.contents.isDestroyed()}}finally{owner.restore();delete globalThis.__agentmuxLocalRecoveryObservation}})()`)
}

async function recordedDiagnostic(ctx, actual) {
  const step = actual.steps.find(item => item.method === (ctx.receipt.localRecovery.kind === 'locator' ? 'click' : 'gotoUrl'))
  assert.ok(step, 'The real failing page call must be present in the original operation')
  const read = await ctx.probe.cdp.evaluate(`window.agentmux.browser.getStepEvidence(${q(actual.id)},${step.sequence})`)
  assert.equal(read.status, 'available'); assert.ok(read.items.length > 0)
  const item = read.items[0]
  assert.equal(item.content.kind, 'diagnostic')
  assert.equal(item.reference.operationId, actual.id); assert.equal(item.reference.sequence, step.sequence)
  assert.equal(item.reference.browserId, ctx.browserId)
  const expected = ctx.receipt.localRecovery.kind === 'locator' ? 'action-completed' : 'handoff'
  assert.ok(item.content.message.includes(`: ${expected}.`), 'The default diagnostic must show the final recovery status')
  assert.ok(item.content.message.includes('Goal: ')); assert.ok(item.content.message.includes('/2 attempts'))
  assert.ok(item.content.message.includes('/5000 ms')); assert.ok(item.content.message.includes('/65536 bytes'))
  if (expected === 'action-completed') {
    assert.ok(item.content.message.includes('button "Continue task" (1/1)'))
    assert.ok(item.content.message.includes('locator-changed; effects: not-dispatched'))
    assert.ok(item.content.message.includes('Outcome evidence: not-met'))
  } else {
    assert.ok(item.content.message.includes('navigation-failed; effects: unknown'))
    assert.ok(item.content.nextAction.includes('Agent remains usable'))
  }
  return { step, item, read }
}

async function currentNativeOwner(ctx) {
  const stage = await ctx.probe.cdp.evaluate(`(()=>{const roots=document.querySelectorAll(${q(browser(ctx) + ' [data-native-browser-stage]')});if(roots.length!==1)throw new Error('The original run must identify one visible Browser stage');const r=roots[0].getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
  assert.ok(stage.width > 0 && stage.height > 0)
  const owner = await ctx.probe.main.evaluate(`(()=>{
    const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');
    const win=BrowserWindow.getAllWindows()[0],zoom=win.webContents.getZoomFactor(),s=${q(stage)};
    const expected={x:s.x*zoom,y:s.y*zoom,width:s.width*zoom,height:s.height*zoom};
    const owners=win.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()).map(view=>({webContentsId:view.webContents.id,url:view.webContents.getURL(),bounds:view.getBounds(),visible:view.getVisible()})).filter(owner=>{const r=owner.bounds;return r.width>0&&r.height>0&&Math.abs(r.x-expected.x)<=2&&Math.abs(r.y-expected.y)<=2&&Math.abs(r.width-expected.width)<=2&&Math.abs(r.height-expected.height)<=2});
    if(owners.length!==1)throw new Error('The original run stage must have exactly one real Native owner');
    return {...owners[0],stage:expected,zoom};
  })()`)
  assert.equal(owner.visible, true)
  ;(ctx.receipt.localRecovery.nativeOwners ??= []).push(owner)
  return owner
}

export async function showDiagnostic(ctx, actual, diagnostic, label) {
  const owned = selector => ctx.selectors(browser(ctx) + ' ' + selector)
  const timeline = `${browser(ctx)} .browser-rsi-timeline[data-operation-id=${q(actual.id)}]`
  if (!await ctx.probe.cdp.evaluate(`(${owned('[aria-label="Browser operation history"]')}).length===1`)) {
    await ctx.click(ctx.probe.cdp, owned('.browser-operation-status__trigger'))
    const menuId = await ctx.waitFor('the original Browser activity trigger owns its actual portal', () => ctx.probe.cdp.evaluate(`(()=>{
      const triggers=${owned('.browser-operation-status__trigger')};if(triggers.length!==1)return null;
      const trigger=triggers[0],id=trigger.getAttribute('aria-controls');if(!trigger.id||!id)return null;
      const menus=Array.from(document.querySelectorAll('[id]')).filter(menu=>menu.id===id&&menu.getAttribute('aria-labelledby')===trigger.id);
      return menus.length===1?id:null;
    })()`))
    await ctx.click(ctx.probe.cdp, ctx.selectors(`[id=${q(menuId)}] [aria-label="Open browser activity timeline"]`))
  }
  const timestamp = new Date(actual.startedAt).toISOString()
  await ctx.click(ctx.probe.cdp, `${owned('.browser-rsi-history__item')}.filter(element=>element.querySelector('time')?.dateTime===${q(timestamp)})`)
  await ctx.waitFor('original native failure selected in the existing activity timeline', () => ctx.probe.cdp.evaluate(`Boolean(document.querySelector(${q(timeline)}))`))
  await ctx.click(ctx.probe.cdp, ctx.selectors(`${timeline} [data-sequence="${diagnostic.step.sequence}"] .browser-rsi-timeline__step-button`))
  const ui = await ctx.waitFor('final recovery goal and budget readable in the real evidence UI', async () => {
    const sample = await ctx.probe.cdp.evaluate(`(()=>{
    const root=document.querySelector(${q(browser(ctx) + ' .browser-step-evidence')}),paragraphs=Array.from(root?.querySelectorAll('p')??[]),message=paragraphs.find(item=>item.textContent===${q(diagnostic.item.content.message)}),nextAction=paragraphs.find(item=>item.textContent===${q(diagnostic.item.content.nextAction)});
    const bounds=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const facts=element=>{if(!element)return {present:false,clientRects:0,visibility:null,display:null,bounds:null,intersection:null};const style=getComputedStyle(element);return {present:true,clientRects:element.getClientRects().length,visibility:style.visibility,display:style.display,bounds:bounds(element),intersection:null}};
    const timeline=document.querySelector(${q(browser(ctx) + ' .browser-rsi-timeline')}),selected=timeline?.querySelector('.browser-rsi-timeline__step.is-selected'),rail=message?.closest('.browser-trace-rail')??root?.closest('.browser-trace-rail');
    const sample={readable:false,reason:null,coordinateSpace:'renderer-css-px',observedOperationId:timeline?.dataset.operationId??null,selectedSequence:selected?.dataset.sequence??null,evidencePresent:!!root,evidenceLabel:root?.getAttribute('aria-label')??null,viewport:{x:0,y:0,width:innerWidth,height:innerHeight},message:facts(message),nextAction:facts(nextAction),rail:{present:!!rail,bounds:bounds(rail)},scrollApplied:false};
    const reject=reason=>{sample.reason=reason;return sample};
    if(!message)return reject('message-missing');
    if(!sample.message.clientRects)return reject('message-no-client-rects');
    if(sample.message.visibility==='hidden')return reject('message-hidden');
    if(!nextAction)return reject('next-action-missing');
    if(!sample.nextAction.clientRects)return reject('next-action-no-client-rects');
    if(sample.nextAction.visibility==='hidden')return reject('next-action-hidden');
    message.scrollIntoView({block:'nearest'});
    sample.scrollApplied=true;sample.message.bounds=bounds(message);sample.nextAction.bounds=bounds(nextAction);sample.rail.bounds=bounds(rail);
    const rect=message.getBoundingClientRect();if(!rail)return reject('rail-missing');
    const r=rail.getBoundingClientRect(),left=Math.max(rect.x,r.x,0),top=Math.max(rect.y,r.y,0),right=Math.min(rect.right,r.right,innerWidth),bottom=Math.min(rect.bottom,r.bottom,innerHeight);
    sample.message.intersection={x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
    const nextRect=nextAction.getBoundingClientRect(),nextLeft=Math.max(nextRect.x,r.x,0),nextTop=Math.max(nextRect.y,r.y,0),nextRight=Math.min(nextRect.right,r.right,innerWidth),nextBottom=Math.min(nextRect.bottom,r.bottom,innerHeight);
    sample.nextAction.intersection={x:nextLeft,y:nextTop,width:Math.max(0,nextRight-nextLeft),height:Math.max(0,nextBottom-nextTop)};
    if(right<=left||bottom<=top)return reject('message-no-intersection');
    if(nextRight<=nextLeft||nextBottom<=nextTop)return reject('next-action-no-intersection');
    sample.readable=true;sample.reason='readable';sample.ui={intersection:{x:left,y:top,width:right-left,height:bottom-top},text:message.textContent,nextAction:nextAction.textContent,nextActionIntersection:{x:nextLeft,y:nextTop,width:nextRight-nextLeft,height:nextBottom-nextTop},nextActionBounds:{x:nextRect.x,y:nextRect.y,width:nextRect.width,height:nextRect.height},bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},operationId:timeline?.dataset.operationId};return sample;
  })()`)
    // Keep only the last real DOM reply, including failure branches. The canonical's
    // catch/finally retains this same receipt; do not re-read after quit or hide failure.
    ctx.receipt.localRecovery.diagnosticUiSample = { label, browserId: ctx.browserId, operationId: actual.id, sequence: diagnostic.step.sequence, ...sample }
    return sample.readable ? sample.ui : null
  })
  assert.equal(ui.operationId, actual.id); assert.equal(ui.nextAction, diagnostic.item.content.nextAction)
  assert.ok(ui.bounds.width > 0 && ui.bounds.height > 0)
  ;(ctx.receipt.localRecovery.ui ??= []).push({ label, ...ui })
  // URL can differ after a failed navigation or ordinary restart. Resolve the actual
  // original run's stage/Native geometry first; never guess its owner from the old URL.
  const owner = await currentNativeOwner(ctx)
  await ctx.capture(ctx.probe, `${label}-local-recovery-${ctx.receipt.localRecovery.kind}-diagnostic`, 'operations', owner.url.split('#')[0])
}

export async function reviewLocalRecovery(ctx) {
  const kind = ctx.localRecoveryKind
  assert.ok(kind === 'locator' || kind === 'navigation', 'The canonical must choose one generic failure shape')
  ctx.setPhase(`local-recovery-${kind}-actual-main-failure`)
  const observed = ctx.receipt.localRecovery = { kind, networkRequests: [] }
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="More browser tools"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Start recording demonstration"]'))
  await ctx.waitFor('recovery demonstration recording owner ready', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(value=>value.draft?.status==='recording')`))
  await native(ctx, '#recovery-action')
  await ctx.waitFor('the single native recovery gesture is durably recorded', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(value=>value.draft?.status==='recording'&&value.draft.steps.length===1&&value.draft.steps[0].target?.name==='Continue task')`))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Stop recording demonstration"]'))
  await ctx.waitFor('real stopped native demonstration', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(value=>value.draft?.status==='stopped'&&value.draft.steps.length===1)`))
  await ctx.click(ctx.probe.cdp, buttons(ctx, 'Edit demonstration'))
  const imported = await ctx.waitFor('actual recorded recovery task imported', async () => (await state(ctx)).assets.at(-1) ?? null)
  assert.deepEqual(imported.draft.steps.map(step => step.kind), ['click'])
  assert.deepEqual(imported.draft.steps[0].target, { role: 'button', name: 'Continue task', ordinal: 1, count: 1 })
  const destination = new URL(localRecoveryDisconnectPath, ctx.pageUrl).toString()
  // Explicit authored fixture input through the public draft/version API. Never seed an owner Store or result.
  const checkpoint = { id: `recovery-checkpoint-${kind}`, kind: 'checkpoint', url: ctx.pageUrl, label: 'Review task result', reviewed: true }
  const current = kind === 'locator' ? { ...imported.draft.steps[0], reviewed: true } :
    { id: imported.draft.steps[0].id, kind: 'navigate', url: destination, label: 'Open reviewed destination', reviewed: true }
  const content = { ...imported.draft, name: `Reviewed ${kind} recovery`, steps: [current, checkpoint],
    completion: { criteria: [{ kind: 'human-checkpoint', checkpointId: checkpoint.id }] } }
  const saved = await ctx.probe.cdp.evaluate(`window.agentmux.browser.saveTaskAssetVersion(${q(ctx.browserId)},${q(imported.id)},${imported.revision},${q(content)})`)
  assert.equal(saved.versions.length, 1); assert.deepEqual(saved.versions[0].steps, content.steps)
  observed.asset = saved
  const previous = await ctx.runBrowser(ctx.browserId, 'const s=await snapshot();const xs=s.nodes.filter(n=>n.role==="button"&&n.name==="Prepare item");if(xs.length!==1)throw new Error("Expected one reviewed prefix");await click(xs[0].ref);return "prefix completed";')
  assert.equal(previous.outcome.kind, 'completed'); observed.priorOperationId = previous.runOperation.id
  observed.before = await ctx.nativePageScript(ctx.probe, '({...globalThis.localRecoveryClicks})')
  assert.deepEqual(observed.before, { prefix: 1, action: 1 })
  observed.installed = await installObservation(ctx, kind)
  observed.disconnectArmed = kind === 'navigation'
  try {
    await ctx.waitFor('saved native recovery version visible in the real editor', () => ctx.probe.cdp.evaluate(`document.querySelector('[data-task-asset-id="${saved.id}"] [aria-label="Task asset version"]')?.value==='1'`))
    await ctx.click(ctx.probe.cdp, buttons(ctx, 'Run version'))
    observed.run = await ctx.waitFor('actual local recovery task settled', async () => (await state(ctx)).runs.find(run => run.assetId === saved.id && run.status === (kind === 'locator' ? 'waiting-human' : 'failed')) ?? null)
  } finally { observed.observation = await finishObservation(ctx) }
  assert.equal(observed.observation.destroyed, false)
  assert.equal(observed.run.operationIds.length, 1)
  const versions = saved.versions.filter(version => version.version === observed.run.version)
  assert.equal(versions.length, 1, 'The actual run must select one saved version')
  const version = versions[0]
  assert.equal(observed.run.assetId, saved.id)
  assert.equal(observed.run.browserId, saved.browserId)
  assert.deepEqual(version.steps.map(step => step.kind), [kind === 'locator' ? 'click' : 'navigate', 'checkpoint'])
  assert.equal(observed.run.status, kind === 'locator' ? 'waiting-human' : 'failed')
  if (kind === 'locator') {
    assert.equal(observed.run.nextStep, version.steps.length, 'The saved checkpoint has already consumed its step')
    const consumed = version.steps[observed.run.nextStep - 1]
    assert.equal(consumed.kind, 'checkpoint')
    assert.equal(observed.run.pendingCheckpointId, consumed.id, 'Pending checkpoint must bind the consumed saved step')
  } else {
    assert.equal(observed.run.nextStep, 0, 'Failed navigation must retain its original cursor')
    assert.equal(observed.run.pendingCheckpointId, undefined, 'Failed navigation cannot consume its checkpoint')
  }
  const actual = await operation(ctx, observed.run.operationIds[0])
  assert.deepEqual(actual.outcome.registration.assetRun, { runId: observed.run.id, assetId: saved.id, version: 1 })
  observed.operationId = actual.id
  if (kind === 'locator') {
    assert.equal(observed.observation.replaced, 1)
    assert.equal(observed.observation.resolutions.length, 1)
    assert.equal(observed.observation.resolutions[0].realRejected, true, 'Chromium itself must reject the actual original stale backend node')
    assert.equal(observed.observation.actionSends.length, 1, 'Only the repaired current click may be sent')
    assert.deepEqual(await ctx.nativePageScript(ctx.probe, '({...globalThis.localRecoveryClicks})'), { prefix: 1, action: 2 })
    assert.equal(actual.outcome.evaluation.status, 'not-met')
  } else {
    assert.deepEqual(observed.observation.loads.map(item => item.url), [destination], 'The Main navigation owner must issue only one loadURL')
    assert.ok(observed.networkRequests.length > 0, 'The original navigation must reach the real disconnected HTTP producer')
    assert.deepEqual(observed.observation.actionSends, [])
  }
  const diagnostic = await recordedDiagnostic(ctx, actual)
  observed.diagnostic = diagnostic.item; observed.sequence = diagnostic.step.sequence
  if (!actual.outcome.evaluation) await ctx.probe.cdp.evaluate(`window.agentmux.browser.verifyOutcome(${q(ctx.browserId)},${q(actual.id)})`)
  observed.beforeRestart = await operation(ctx, actual.id)
  observed.public = await publicFacts(ctx, observed.beforeRestart)
  assert.equal((await operation(ctx, observed.priorOperationId)).phase, 'completed')
  for (const [label, width, height] of [['normal', 1440, 900], ['narrow', 1000, 720], ['short', 1000, 660]]) {
    await ctx.resize(ctx.probe, width, height)
    await showDiagnostic(ctx, observed.beforeRestart, diagnostic, label)
  }
  await ctx.resize(ctx.probe, 1440, 900)
  observed.stateBeforeRestart = await state(ctx)
}

/** Consumes durable original facts after the canonical's normal application quit/restart. Never runs the task. */
export async function recoverLocalRecovery(ctx) {
  ctx.setPhase(`local-recovery-${ctx.receipt.localRecovery.kind}-ordinary-restart`)
  const observed = ctx.receipt.localRecovery
  const restored = await ctx.waitFor('original reviewed task and cursor restored without execution', async () => {
    const value = await state(ctx)
    return value.runs.some(run => run.id === observed.run.id) ? value : null
  })
  assert.deepEqual(restored, observed.stateBeforeRestart)
  const actual = await operation(ctx, observed.operationId)
  assert.deepEqual(actual, observed.beforeRestart)
  assert.equal((await operation(ctx, observed.priorOperationId)).phase, 'completed')
  const diagnostic = await recordedDiagnostic(ctx, actual)
  assert.deepEqual(diagnostic.item, observed.diagnostic)
  observed.restoredPublic = await publicFacts(ctx, actual)
  await showDiagnostic(ctx, actual, diagnostic, 'ordinary-restart')
  assert.deepEqual(await state(ctx), restored, 'Reading retained diagnostics cannot advance or replay a task')
  const snapshot = await ctx.probe.cdp.evaluate(`window.agentmux.browser.create(${q(ctx.browserId)})`)
  assert.equal(snapshot.id, ctx.browserId)
  observed.restoredBrowser = snapshot
  if (observed.kind === 'locator') assert.deepEqual(await ctx.nativePageScript(ctx.probe, '({...globalThis.localRecoveryClicks})'), { prefix: 0, action: 0 }, 'Ordinary restore cannot replay the prefix or recovered click')
  observed.complete = true
}
