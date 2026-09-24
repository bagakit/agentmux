import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { observeRecordedTarget } from './browser-demonstration-probe-diagnostics.mjs'

// Scenario-only hooks into the existing product harness: no launch, Store seed or cleanup owner.
export const demonstrationFixture = '<button id="demo-click">Continue</button><label for="demo-input">Name</label><input id="demo-input" type="text"><button id="demo-duplicate">Repeat</button><button>Repeat</button><a id="demo-navigation" href="#destination">Next section</a><p id="destination">Destination</p><script>globalThis.demoTrusted={click:0,input:0};for(const type of ["click","input"])document.addEventListener(type,event=>{if(event.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=event.target.id}},true)</script>'

export async function native(ctx, selector, value) {
  const { probe, desktopRoot, pageUrl } = ctx
  const result = await probe.main.evaluate(`(async()=>{
    const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron');
    const window=BrowserWindow.getAllWindows()[0],views=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().split('#')[0]===${JSON.stringify(pageUrl)});
    if(views.length!==1)throw new Error('The actual private native Browser owner is not unique');
    const view=views[0],bounds=view.getBounds(),contents=view.webContents;
    if(!window.isVisible()||window.isMinimized()||!view.getVisible()||bounds.width<=0||bounds.height<=0)throw new Error('Native input requires a visible actual Browser');
    app.focus({steal:true});window.focus();contents.focus();
    const before=await contents.executeJavaScript('({...globalThis.demoTrusted})');
    const cssPoint=await contents.executeJavaScript(${JSON.stringify(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)});if(matches.length!==1)throw new Error('Native fixture target must be unique');const target=matches[0],r=target.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(document.elementFromPoint(x,y)!==target)throw new Error('Actual fixture target is covered');return {x,y,targetId:target.id,targetTag:target.tagName,targetConnected:target.isConnected,targetBounds:{x:r.x,y:r.y,width:r.width,height:r.height},document:{visibilityState:document.visibilityState,hasFocus:document.hasFocus(),readyState:document.readyState,activeElement:{id:document.activeElement?.id??null,tag:document.activeElement?.tagName??null}}}})()`)});
    const zoomFactor=contents.getZoomFactor(),point={x:Math.round(cssPoint.x*zoomFactor),y:Math.round(cssPoint.y*zoomFactor)};
    if(point.x<0||point.y<0||point.x>=bounds.width||point.y>=bounds.height)throw new Error('Native fixture target is outside its actual page bounds');
    const types=[],listener=(_event,input)=>types.push(input.type);contents.on('input-event',listener);
    try{
      contents.sendInputEvent({type:'mouseMove',...point});
      for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,...point});
      ${value === undefined ? '' : `for(const keyCode of ${JSON.stringify(value)})contents.sendInputEvent({type:'char',keyCode});`}
      await new Promise(done=>setTimeout(done,100));
      const observedAfter=await contents.executeJavaScript(${JSON.stringify(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)}),target=matches.length===1?matches[0]:null,r=target?.getBoundingClientRect();return {trusted:{...globalThis.demoTrusted},document:{visibilityState:document.visibilityState,hasFocus:document.hasFocus(),readyState:document.readyState,activeElement:{id:document.activeElement?.id??null,tag:document.activeElement?.tagName??null}},target:{count:matches.length,id:target?.id??null,tag:target?.tagName??null,connected:target?.isConnected??null,bounds:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}}})()`)});
      const after=observedAfter.trusted;
      return {before,after,types,windowFocused:window.isFocused(),pageFocused:contents.isFocused(),bounds,cssPoint,point,zoomFactor,
        owner:{windowId:window.id,webContentsId:contents.id,url:contents.getURL(),windowVisible:window.isVisible(),windowMinimized:window.isMinimized(),viewVisible:view.getVisible(),pageLoading:contents.isLoading(),appActive:app.isActive()},documentAfter:observedAfter.document,targetAfter:observedAfter.target};
    }finally{contents.removeListener('input-event',listener)}
  })()`)
  ;(ctx.receipt.nativeInputAttempts ??= []).push({ browserId: ctx.browserId, selector, typing: value !== undefined, ...result })
  assert.equal(result.after.click, result.before.click + 1, 'Real native input must reach the intended page exactly once')
  assert.equal(result.after.lastTarget, result.cssPoint.targetId, 'Real native input must reach the intended fixture target')
  assert.ok(result.types.includes('mouseUp'), 'Native Electron input must be observed by the actual owner')
  if (value !== undefined) {
    assert.ok(result.after.input > result.before.input, 'Native typing must reach the trusted input path')
    assert.ok(result.types.includes('char'))
  }
  return result
}
async function current(ctx) { return ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${JSON.stringify(ctx.browserId)})`) }
function owned(ctx, selector) {
  return `${ctx.selectors(selector)}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${JSON.stringify(ctx.pageUrl)})`
}
async function open(ctx) {
  const { probe, click, selectors } = ctx
  if (!await probe.cdp.evaluate(`Boolean(document.querySelector('[aria-label="Human demonstration draft"]'))`)) {
    await click(probe.cdp, owned(ctx, '[aria-label="More browser tools"]'))
    await click(probe.cdp, selectors('[aria-label="Open human demonstration draft"]'))
  }
}

async function toolbarFacts(ctx, label, actualWindow) {
  const result = await ctx.probe.cdp.evaluate(`(async()=>{
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    const more=(${owned(ctx, '[aria-label="More browser tools"]')})[0];
    if(!more)throw new Error('The original Browser needs its overflow entry');
    const surface=more.closest('.browser-surface'),toolbar=more.closest('.browser-toolbar'),region=more.closest('[data-workbench-region-id]'),close=region?.querySelector('.workbench-region__close');
    if(!surface||!toolbar||!region||!close)throw new Error('Actual toolbar, split and its close control are required');
    const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
    const identity=element=>({tag:element.tagName,label:element.getAttribute('aria-label'),regionId:element.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId??null});
    const samples=element=>{const r=element.getBoundingClientRect();return [[r.x+r.width/2,r.y+r.height/2],[r.x+1,r.y+r.height/2],[r.right-1,r.y+r.height/2],[r.x+r.width/2,r.y+1],[r.x+r.width/2,r.bottom-1]].map(([x,y])=>({point:{x,y},owns:element.contains(document.elementFromPoint(x,y)),stack:document.elementsFromPoint(x,y).slice(0,8).map(identity)}))};
    const visible=element=>element.getClientRects().length&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden';
    const moreSamples=samples(more),closeSamples=samples(close),m=rect(more),c=rect(close);
    return {label:${JSON.stringify(label)},actualWindow:${JSON.stringify(actualWindow)},regionId:region.dataset.workbenchRegionId,region:rect(region),stage:rect(surface.querySelector('[data-native-browser-stage]')),address:rect(toolbar.querySelector('label')),more:m,close:c,moreOwnsPoint:moreSamples[0].owns,moreHitSamples:moreSamples.map(sample=>sample.owns),closeHitSamples:closeSamples.map(sample=>sample.owns),moreSamples,closeSamples,
      buttons:Array.from(toolbar.querySelectorAll('button')).filter(visible).map(element=>({label:element.getAttribute('aria-label'),disabled:element.disabled,bounds:rect(element),samples:samples(element)})),
      browserRegions:Array.from(document.querySelectorAll('[data-workbench-region-id]')).filter(element=>element.querySelector('[aria-label="Browser address"]')).map(element=>({regionId:element.dataset.workbenchRegionId,url:element.querySelector('[aria-label="Browser address"]').value})).sort((a,b)=>a.regionId.localeCompare(b.regionId))};
  })()`)
  assert.ok(result.region.width > 0 && result.region.height > 0 && result.stage.width > 0 && result.stage.height > 0)
  assert.ok(result.more.width > 0 && result.more.height > 0 && result.close.width > 0 && result.close.height > 0)
  assert.equal(result.address.width >= 96, true, 'The address retains its usable input width')
  assert.equal(result.moreOwnsPoint, true, 'More must own its actual split hit point')
  assert.deepEqual(result.moreHitSamples, [true,true,true,true,true], 'More owns its complete split hit edges')
  assert.deepEqual(result.closeHitSamples, [true,true,true,true,true], 'Close split keeps its complete hit edges')
  assert.ok(result.more.x + result.more.width <= result.close.x, 'More must not occupy Close split')
  assert.ok(result.buttons.length >= 3, 'The real toolbar has nonempty necessary actions')
  assert.equal(result.browserRegions.length, 2, 'The two original Browser Regions remain present')
  for (const button of result.buttons) {
    assert.ok(button.bounds.width > 0 && button.bounds.height > 0)
    assert.deepEqual(button.samples.map(sample=>sample.owns), [true,true,true,true,true], `${button.label} keeps its complete hit area`)
    assert.ok(button.samples.every(sample=>sample.stack.length > 0), 'Actual elementsFromPoint must return a nonempty stack')
    assert.ok(button.bounds.x + button.bounds.width <= result.close.x, 'Necessary toolbar actions keep Close split clear')
  }
  return result
}

async function closeDraft(ctx) {
  const close = owned(ctx, '[aria-label="Close browser activity timeline"]')
  if (await ctx.probe.cdp.evaluate(`(${close}).length===1`)) {
    await ctx.click(ctx.probe.cdp, close)
    await ctx.waitFor('original demonstration drawer closed', () => ctx.probe.cdp.evaluate(`(${owned(ctx, '[aria-label="Human demonstration draft"]')}).length===0`))
  }
}

async function verifyCloseSplit(ctx) {
  await closeDraft(ctx)
  const size = await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');return BrowserWindow.getAllWindows()[0].getMinimumSize()})()`)
  const actual = await ctx.resize(ctx.probe, ...size)
  const toolbar = await toolbarFacts(ctx, 'restarted-minimum-before-close', actual)
  const pageOwners = () => ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');return BrowserWindow.getAllWindows()[0].contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&${JSON.stringify(ctx.urls)}.includes(view.webContents.getURL().split('#')[0])).map(view=>({id:view.webContents.id,url:view.webContents.getURL().split('#')[0],visible:view.getVisible(),bounds:view.getBounds()})).sort((a,b)=>a.url.localeCompare(b.url))})()`)
  const before = await pageOwners()
  assert.equal(before.length, 2, 'The restored two Browser owners must be nonempty before explicit Close')
  const original = before.find(page=>page.url===ctx.pageUrl), sibling = before.find(page=>page.url!==ctx.pageUrl)
  assert.ok(original && sibling)
  await ctx.click(ctx.probe.cdp, `${ctx.selectors('.workbench-region__close')}.filter(element=>element.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId===${JSON.stringify(toolbar.regionId)})`)
  const after = await ctx.waitFor('the intended Close split releases only its actual Browser', async()=>{const pages=await pageOwners();return pages.length===1&&pages[0].id===sibling.id?pages:null})
  assert.equal(after[0].url, sibling.url)
  assert.equal(after[0].visible, true)
  assert.ok(after[0].bounds.width > 0 && after[0].bounds.height > 0)
  const durable = await ctx.waitFor('explicit Close retires only its intended durable Region',()=>ctx.probe.cdp.evaluate(`(()=>{const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')??'null')?.state?.restoredWorkbench;if(!state)return null;const regions=Object.values(state.tabs).flatMap(tab=>Object.values(tab.regions)).filter(region=>region.kind==='browser');return regions.length===1&&regions[0].regionId!==${JSON.stringify(toolbar.regionId)}?regions:null})()`))
  const siblingInput = await native({ ...ctx, pageUrl: sibling.url }, '#demo-click')
  ctx.receipt.demonstration.closeSplit = { boundary: 'Explicit private Close after ordinary restart identity/layout comparison; original restoration was already asserted', toolbar, before, after, durable, siblingInput }
  await ctx.capture(ctx.probe, 'restarted-explicit-close-keeps-sibling', 'page', sibling.url)
}

export async function reviewDemonstration(ctx) {
  const { probe, click, selectors, waitFor, nativePageScript, capture, resize, receipt, userData } = ctx
  const observed = { physicalDeviceTested: false, inputSource: 'Electron native sendInputEvent into the real visible owner; Main input-event and page isTrusted delivery are asserted, OS focus is observational', native: [] }
  receipt.demonstration = observed
  await open(ctx)
  const initial = await current(ctx)
  assert.equal(initial.draft, null)
  // Renderer .click has isTrusted=false and must not open a recording, even at a trusted origin.
  await probe.cdp.evaluate(`document.querySelector('[aria-label="Start recording demonstration"]').click()`)
  assert.equal((await current(ctx)).draft, null)
  observed.syntheticStartRejected = true
  await click(probe.cdp, selectors('[aria-label="Start recording demonstration"]'))
  let started = await waitFor('actual toolbar-created recording', async () => { const state = await current(ctx); return state.draft?.status === 'recording' ? state : null })
  assert.ok(started.draft.id)
  await nativePageScript(probe, 'document.querySelector("#demo-click").click();null')
  assert.deepEqual((await current(ctx)).draft.steps, [])
  // Agent run takes the mature CDP owner synchronously and stops the explicit recording.
  const beforeAgent = started.draft
  const report = await probe.cdp.evaluate(`window.agentmux.browser.runScript(${JSON.stringify(ctx.browserId)},'return await pageInfo();',{id:'private-demonstration-agent',name:'Private demonstration Agent'})`)
  assert.equal(report.outcome.kind, 'completed')
  const released = (await current(ctx)).draft
  assert.equal(released.id, beforeAgent.id); assert.equal(released.status, 'stopped'); assert.deepEqual(released.steps, [])
  observed.healthyAgentRun = report.runOperation; observed.agentReleasedRecording = released
  await click(probe.cdp, selectors('[aria-label="Start recording demonstration"]'))
  started = await waitFor('new explicit recording after healthy Agent run', async () => { const state = await current(ctx); return state.draft?.status === 'recording' && state.draft.id !== beforeAgent.id ? state : null })
  observed.activeRecording = started.draft
  const diagnostics = ctx.diagnoseTarget ? await observeRecordedTarget(ctx) : null
  let clicked
  try {
    observed.native.push(await native(ctx, '#demo-click'))
    clicked = await waitFor('actual native click draft with verified AX target', async () => { const state = await current(ctx); return state.draft.steps.length ? state : null })
  } finally { await diagnostics?.stop() }
  observed.firstNativeDraft = clicked.draft
  assert.deepEqual(clicked.draft.steps[0].target, { role: 'button', name: 'Continue', ordinal: 1, count: 1 })
  const beforeSynthetic = clicked.draft.steps.length
  await nativePageScript(probe, 'document.querySelector("#demo-click").click();document.querySelector("#demo-input").dispatchEvent(new Event("input",{bubbles:true}));null')
  await new Promise(done => setTimeout(done, 70))
  assert.equal((await current(ctx)).draft.steps.length, beforeSynthetic)
  observed.native.push(await native(ctx, '#demo-input', 'one-use-native-secret'))
  const filled = await waitFor('actual native fill parameter without a recorded value', async () => { const state = await current(ctx); return state.draft.steps.some(step => step.method === 'fillInput') ? state : null })
  const fill = filled.draft.steps.find(step => step.method === 'fillInput')
  assert.ok(fill.inputKey); assert.deepEqual(fill.args, []); assert.equal(fill.target.name, 'Name')
  observed.native.push(await native(ctx, '#demo-duplicate'))
  const blocked = await waitFor('actual ambiguous target remains blocked', async () => { const state = await current(ctx); return state.draft.steps.at(-1)?.target === undefined && state.draft.steps.at(-1)?.method === 'click' ? state : null })
  assert.match(blocked.draft.steps.at(-1).blockedReason, /could not be verified/)
  observed.native.push(await native(ctx, '#demo-navigation'))
  const navigated = await waitFor('actual page navigation retains uncertain provenance', async () => { const state = await current(ctx); return state.draft.steps.at(-1)?.method === 'gotoUrl' ? state : null })
  assert.equal(navigated.draft.steps.at(-1).source, 'navigation')
  assert.equal(navigated.draft.steps.at(-1).url, ctx.pageUrl)
  assert.match(navigated.draft.steps.at(-1).blockedReason, /Navigation|URL|destination/)
  for (const [size, width, height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await resize(probe, width, height)
    await capture(probe, `${size}-demonstration-recorded-steps`)
  }
  await resize(probe,1440,900)
  await probe.cdp.evaluate(`document.querySelector('[aria-label="Stop recording demonstration"]').click()`)
  assert.equal((await current(ctx)).draft.status, 'recording', 'Synthetic stop cannot impersonate the person')
  await click(probe.cdp, selectors('[aria-label="Stop recording demonstration"]'))
  const stopped = await waitFor('real toolbar stops the actual recorder', async () => { const state = await current(ctx); return state.draft.status === 'stopped' ? state : null })
  const disk = await readFile(join(userData, 'browser-demonstration-drafts.json'), 'utf8')
  assert.equal(disk.includes('one-use-native-secret'), false)
  observed.native.push(await native(ctx, '#demo-click'))
  assert.deepEqual((await current(ctx)).draft, stopped.draft, 'Stopped recording must not capture later native input')
  await click(probe.cdp, owned(ctx, '[aria-label="Back"]'))
  await waitFor('original Browser URL restored by its real toolbar', () => probe.cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Browser address"]')).some(input=>input.value===${JSON.stringify(ctx.pageUrl)})`))
  observed.stopped = stopped.draft
  observed.syntheticStartRejected = true; observed.syntheticStopRejected = true; observed.valueNotRetained = true
  receipt.demonstration = observed
}

export async function startInterruptedDemonstration(ctx) {
  // The first scenario leaves the draft open. Close it through its original action so
  // the real minimum split must consume More before the next explicit recording.
  await closeDraft(ctx)
  ctx.receipt.demonstration.splitToolbar = []
  for (const [label,width,height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    const actual = await ctx.resize(ctx.probe,width,height)
    ctx.receipt.demonstration.splitToolbar.push(await toolbarFacts(ctx,label,actual))
    await ctx.capture(ctx.probe, `${label}-split-toolbar-before-more`, 'page')
  }
  const size = await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');return BrowserWindow.getAllWindows()[0].getMinimumSize()})()`)
  assert.equal(size.length, 2)
  assert.ok(size[0] > 0 && size[1] > 0, 'The real supported minimum window geometry is required')
  const actual = await ctx.resize(ctx.probe, ...size)
  ctx.receipt.demonstration.minimumSplit = await toolbarFacts(ctx, 'minimum', actual)
  const minimum = ctx.receipt.demonstration.minimumSplit
  await ctx.capture(ctx.probe, 'minimum-split-before-more', 'page')
  assert.ok(minimum.region.width > 0 && minimum.more.width > 0 && minimum.close.width > 0)
  assert.equal(minimum.moreOwnsPoint, true, 'More must own its actual minimum-split hit point')
  assert.deepEqual(minimum.moreHitSamples,[true,true,true,true,true],'More owns its complete minimum split hit edges')
  assert.deepEqual(minimum.closeHitSamples,[true,true,true,true,true],'Close split keeps its complete hit edges')
  assert.ok(minimum.more.x + minimum.more.width <= minimum.close.x, 'More must not occupy Close split')
  await ctx.probe.cdp.evaluate(`(${owned(ctx, '[aria-label="Browser address"]')})[0].focus();null`)
  for (let index = 0; index < 2; index++) for (const type of ['keyDown','keyUp']) await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  ctx.receipt.demonstration.minimumKeyboardFocus = await ctx.probe.cdp.evaluate(`(()=>{const more=(${owned(ctx, '[aria-label="More browser tools"]')})[0],style=getComputedStyle(more);return {isMore:document.activeElement===more,focusVisible:more.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth}})()`)
  assert.equal(ctx.receipt.demonstration.minimumKeyboardFocus.isMore, true, 'The minimum toolbar reaches More through its real keyboard order')
  assert.equal(ctx.receipt.demonstration.minimumKeyboardFocus.focusVisible, true)
  assert.notEqual(ctx.receipt.demonstration.minimumKeyboardFocus.outlineStyle, 'none')
  assert.ok(Number.parseFloat(ctx.receipt.demonstration.minimumKeyboardFocus.outlineWidth) > 0)
  await open(ctx)
  const afterMore = await toolbarFacts(ctx, 'minimum-after-more', actual)
  assert.deepEqual(afterMore.browserRegions, minimum.browserRegions, 'The actual More click preserves both original Browser Regions')
  ctx.receipt.demonstration.minimumAfterMore = afterMore
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Start recording demonstration"]'))
  const state = await ctx.waitFor('actual active recording at ordinary quit', async () => { const state = await current(ctx); return state.draft?.status === 'recording' ? state : null })
  assert.deepEqual(state.draft.steps, [], 'Minimum split starts a real fresh recording, without seeding old demonstrated steps')
  ctx.receipt.demonstration.activeAtQuit = state.draft
  await ctx.capture(ctx.probe, 'minimum-split-demonstration-active', 'page')
  ctx.receipt.demonstration.minimumActiveLayout=ctx.receipt.visual.lastCaptureObservation.observation
  const controls=await ctx.probe.cdp.evaluate(`(()=>{const rail=(${owned(ctx,'[aria-label="Stop recording demonstration"]')})[0]?.closest('.browser-trace-rail');if(!rail)throw new Error('The actual recording trace is required');const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}},hits=element=>{const r=element.getBoundingClientRect();return [[r.x+r.width/2,r.y+r.height/2],[r.x+1,r.y+r.height/2],[r.right-1,r.y+r.height/2],[r.x+r.width/2,r.y+1],[r.x+r.width/2,r.bottom-1]].map(([x,y])=>element.contains(document.elementFromPoint(x,y)))};const stop=rail.querySelector('[aria-label="Stop recording demonstration"]'),close=rail.querySelector('[aria-label="Close browser activity timeline"]');if(!stop||!close)throw new Error('Real Stop and Close trace must remain reachable');const before={stop:rect(stop),stopHits:hits(stop),close:rect(close)};close.scrollIntoView({block:'nearest'});return {...before,closeAfterScroll:rect(close),closeHits:hits(close),railClientWidth:rail.clientWidth,railScrollWidth:rail.scrollWidth}})()`)
  ctx.receipt.demonstration.minimumTraceControls=controls
  assert.deepEqual(controls.stopHits,[true,true,true,true,true],'Stop recording keeps its complete minimum trace hit edges')
  assert.deepEqual(controls.closeHits,[true,true,true,true,true],'Close trace remains reachable through its existing scroll')
  assert.ok(controls.railScrollWidth<=controls.railClientWidth,'Minimum trace must not overflow horizontally')
  const input=await native(ctx,'#demo-click')
  assert.equal(input.after.click,input.before.click+1,'Minimum-split page receives one actual trusted click')
  const recorded=await ctx.waitFor('minimum-split actual native click recorded',async()=>{const value=await current(ctx);return value.draft?.id===state.draft.id&&value.draft.steps.length===1?value.draft:null})
  assert.equal(recorded.steps[0].method,'click')
  assert.equal(recorded.steps[0].target?.name,'Continue','The actual minimum-page target must retain its semantic identity')
  ctx.receipt.demonstration.minimumInput=input
  ctx.receipt.demonstration.activeAtQuit=recorded
  await ctx.capture(ctx.probe,'minimum-split-demonstration-native-input','demonstration')
  await ctx.resize(ctx.probe,1440,900)
}

export async function recoverDemonstration(ctx) {
  const { receipt, probe, waitFor } = ctx
  const expected = receipt.demonstration.activeAtQuit
  const restored = await waitFor('actual interrupted recording after ordinary restart', async () => { const state = await current(ctx); return state.draft?.id === expected.id && state.draft.status === 'interrupted' ? state : null })
  assert.deepEqual(restored.draft.steps, expected.steps)
  assert.match(restored.draft.warning, /restart/)
  const document = JSON.parse(await readFile(join(ctx.userData, 'browser-demonstration-drafts.json'), 'utf8'))
  assert.deepEqual(document.drafts.find(draft => draft.id === receipt.demonstration.stopped.id), receipt.demonstration.stopped)
  const nativeState = await probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');const views=BrowserWindow.getAllWindows()[0].contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===${JSON.stringify(ctx.pageUrl)});if(views.length!==1)throw new Error('Restored Browser owner must be unique');return {attached:views[0].webContents.debugger.isAttached(),visible:views[0].getVisible()}})()`)
  assert.equal(nativeState.attached, false); assert.equal(nativeState.visible, true)
  await native(ctx, '#demo-click')
  assert.deepEqual((await current(ctx)).draft, restored.draft, 'Restart must not automatically resume capture')
  await closeDraft(ctx)
  await open(ctx)
  assert.ok(await probe.cdp.evaluate(`document.querySelector('[aria-label="Human demonstration draft"]').textContent.includes('Interrupted')`))
  const recoveredSteps = await probe.cdp.evaluate(`(()=>{const draft=(${owned(ctx, '[aria-label="Human demonstration draft"]')})[0];return {label:draft?.getAttribute('aria-label'),steps:draft?.querySelectorAll('[data-sequence]').length??0,text:draft?.textContent??''}})()`)
  assert.ok(recoveredSteps.steps > 0, 'Ordinary restart reaches the nonempty interrupted demonstration through More')
  receipt.demonstration.restoredMore = recoveredSteps
  receipt.demonstration.restored = restored.draft
  receipt.demonstration.nativeStateAfterRestart = nativeState
  receipt.demonstration.noAutomaticRecording = true
  await verifyCloseSplit(ctx)
  receipt.demonstration.complete = true
}
